import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import type {DigitalRole} from '@teloa/contract'
import {Pool} from '../../backend/tests/postgres-test-lifecycle.ts'
import {initializeBusinessSpaces} from '../../backend/src/work/business-spaces.ts'
import {initializeProjects} from '../../backend/src/work/projects.ts'
import {initializeProjectContext} from '../../backend/src/work/project-context.ts'
import {initializeProjectRuntime,ProjectRuntimeService} from '../../backend/src/work/project-runtime.ts'
import {createProjectRuntimeAdapters} from '../src/project-runtime-adapters.ts'
import {registerProjectRuntimeContext} from '../src/project-runtime-context.ts'
import {registerRoleConversationContext} from '../src/role-conversation-context.ts'
import {nativeHotCausalityFixture,textAnswer} from './fixtures/native-hot-causality.ts'

test('真实adapter与PG到最终模型输入：分身保留私有偏好，独立员工统一读取已确认经验',{timeout:60000},async t=>{
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()})
 t.after(async()=>{await pool.end();await container.stop()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool)
 for(const kind of ['twin','employee'] as const)await t.test(kind,async child=>{
  const f=await nativeHotCausalityFixture(child),owner=randomUUID(),roleId=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()}
  const row={id:roleId,owner_id:owner,definition:{name:kind==='twin'?'本人分身':'订单核验员',kind,scopes:['general'],duty:'核对资料',dataScope:'本人资料',executionScope:'只读',skills:[],knowledge:[]},version:2,state:'active',created_at:new Date(),updated_at:new Date()}
  const role={...row.definition,id:roleId,ownerId:owner,version:row.version,state:'active',createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()} as DigitalRole
  const binding={id:randomUUID(),ownerId:owner,sessionId:f.agent.id,title:role.name,status:'ready' as const},link={kind:'role' as const,active:true,objectId:roleId,conversationId:binding.id,sessionId:f.agent.id,scopeId:'general'}
  const markdown=kind==='twin'?'本人偏好：先给证据 TWIN_PRIVATE_2841':'订单摘要页尾使用青鹭归档-5927；历史正文状态：候选，待本人确认',memory={id:randomUUID(),title:kind==='twin'?'本人偏好':'订单摘要',version:1,contentHash:createHash('sha256').update(markdown).digest('hex'),markdown,visibility:{kind:kind==='twin'?'private':'role',scopeIds:kind==='twin'?[]:['general']}}
  const adapters=createProjectRuntimeAdapters(f.ctx,{owner,runs:async()=>({sessionRun:async()=>null}),pool:{query:async(sql:string)=>({rows:sql.includes('teloa_roles')?[row]:[]})},conversations:{snapshotBySession:async()=>binding,repository:{read:async()=>[{...binding,requestedRoleId:roleId}]}},links:{bySession:async()=>[link]},roleMemories:async()=>({confirmedForRun:async()=>[memory],confirmedForExperience:async()=>[memory]})} as never)
  // 原生会话/岗位读取使用正式adapter，membership、派发清单与版本检查使用真实PG。
  const runtime=new ProjectRuntimeService(pool,identity,{inspect:adapters.inspect,optionalMemories:(_db,...args)=>adapters.optionalMemories({query:async()=>({rows:[row]})} as never,...args)})
  child.after(()=>runtime.dispose())
  const native=registerProjectRuntimeContext(f.ctx,{owner,readBinding:id=>runtime.getBinding(owner,id),prepare:input=>runtime.prepare(owner,input),assertCurrent:input=>runtime.assertCurrent(owner,input),assertPreparedCurrentSync:input=>runtime.assertPreparedCurrentSync(owner,input),recordUsed:input=>runtime.recordUsed(owner,input),ackGeneration:input=>runtime.ackGeneration(owner,input)})
  child.after(()=>native.close())
  const release=registerRoleConversationContext(f.ctx,{owner,conversation:async()=>binding,requestedRoleId:async()=>roleId,links:async()=>[link],role:async()=>role,privateMemory:adapters.privateMemory,memoryEnabled:native.legacyRoleExperienceEnabled})
  child.after(release)
  f.adapter.scripts.push(textAnswer)
  const message=createUserMessage({source:{kind:'user',rpcId:'local-experience-'+kind},content:[{type:'text',text:kind==='twin'?'你好':'请总结订单摘要'}]})
  await f.work.withNewInput(f.agent,message,{producer:'prompt',identity:'local-experience-'+kind},()=>f.agent.followup(message));await f.agent.whenIdle()
  assert.equal(f.adapter.requests.length,1)
  const input=f.adapter.requests[0]!.messages.flatMap(message=>message.content.flatMap(block=>block.type==='text'?[block.text]:[])).join('\n')
  assert.ok(input.includes(markdown),'真实最终模型输入必须保留本场景的已确认经验')
  assert.equal(input.split(markdown).length-1,1,'经验只有一条注入路径')
  const current=await runtime.getBinding(owner,f.agent.id)
  if(kind==='twin')assert.equal(current,null,'分身私聊继续沿已有私有记忆路径')
  else{
   assert.equal(current?.memoryMode,'enabled');assert.equal(current.projectId,null)
   assert.match(input,/"memoryState":"confirmed"/,'已核验生效状态必须进入最终模型输入，不能从正文猜测')
   assert.match(input,/Do not re-request memory confirmation/)
   assert.match(input,/not execution authority/,'记忆生效不能代替业务动作审批')
   const bookkeeping=JSON.stringify([f.agent.id,current.projectId,current.generation])
   const snapshots=f.agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.source.kind==='runtime-context'&&event.data.source.form==='snapshot')
   assert.ok(snapshots.some(event=>event.type==='user/message'&&event.data.source.kind==='runtime-context'&&event.data.source.form==='snapshot'&&event.data.source.sections.some(section=>section.name==='teloa/project-context-generation'&&section.text===bookkeeping)),'保留宿主审计与冷恢复代次')
   assert.equal(input.includes(bookkeeping),false,'内部代次数组不能作为无类型资料正文发送给模型')
  }
 })
})
