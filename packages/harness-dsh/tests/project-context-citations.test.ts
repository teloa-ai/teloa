import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {Pool} from '../../backend/tests/postgres-test-lifecycle.ts'
import {initializeBusinessSpaces} from '../../backend/src/work/business-spaces.ts'
import {initializeProjects,ProjectService} from '../../backend/src/work/projects.ts'
import {initializeProjectContext,ProjectContextService} from '../../backend/src/work/project-context.ts'
import {initializeProjectRuntime,ProjectRuntimeService} from '../../backend/src/work/project-runtime.ts'
import {createProjectRuntimeHandler} from '../src/project-runtime.ts'
import {registerProjectRuntimeContext} from '../src/project-runtime-context.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {nativeHotCausalityFixture,textAnswer} from './fixtures/native-hot-causality.ts'

function assertCitationInput(f:Awaited<ReturnType<typeof nativeHotCausalityFixture>>,expectedKinds:string[]){
 const snapshot=readSessionEvents(f.agent.session).find(event=>event.type==='user/message'&&event.data.source.kind==='runtime-context'&&event.data.source.form==='snapshot'&&event.data.source.sections.some(section=>section.name==='teloa/project-context'))
 assert.ok(snapshot?.type==='user/message'&&snapshot.data.source.kind==='runtime-context'&&snapshot.data.source.form==='snapshot')
 const text=snapshot.data.source.sections.find(section=>section.name==='teloa/project-context')!.text
 const input=f.adapter.requests[0]!.messages.flatMap(message=>message.content.flatMap(block=>block.type==='text'?[block.text]:[])).join('\n')
 assert.ok(input.includes(text),'路径约定必须到达实际adapter输入，而不只存在于准备结果')
 const rows=JSON.parse(text.slice(text.lastIndexOf('\n')+1)) as Array<{source:{kind:string;id:string;hash:string};markdown:string;citationPath?:string}>
 assert.deepEqual(rows.map(row=>row.source.kind).sort(),[...expectedKinds].sort())
 for(const row of rows){
  assert.equal(createHash('sha256').update(row.markdown).digest('hex'),row.source.hash,'新增引用元数据不能改变原正文hash')
  if(['project','brief','rule','memory'].includes(row.source.kind))assert.equal(row.citationPath,row.source.kind+'/'+row.source.id)
  else assert.equal(row.citationPath,undefined,'未支持种类不能获配看似可点击的路径')
 }
 assert.match(text,/exact citationPath value/)
 assert.match(text,/Without citationPath, use a plain-text title/)
 assert.match(text,/Never use the field name, UUID, hash, or an invented path as a link target/)
}

test('真实Loop快照与PG：项目引用沿原轮次固定版本，撤回与伪造不能读取正文',{timeout:60000},async t=>{
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()})
 t.after(async()=>{await pool.end();await container.stop()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool)
 const f=await nativeHotCausalityFixture(t),owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},context=new ProjectContextService(pool,identity)
 const project=await new ProjectService(pool,identity).create(owner,{requestId:randomUUID(),fields:{scope:'general',title:'固定来源',goal:'核对订单',dueDate:null,state:'planning',links:[],references:[]}})
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:0,change:{kind:'save-entry',entryId:null,entryKind:'memory',topic:'单价',markdown:'单价原版：25元。'}})
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:1,change:{kind:'save-entry',entryId:null,entryKind:'rule',topic:'核对规则',markdown:'逐项列出数量与单价。'}})
 const entries=(await context.get(owner,{projectId:project.id})).entries,memory=entries.find(e=>e.kind==='memory')!,rule=entries.find(e=>e.kind==='rule')!
 let scope='general',available=true
 const runtime=new ProjectRuntimeService(pool,identity,{inspect:async(actor,sessionId)=>{assert.equal(actor,owner);assert.equal(sessionId,f.agent.id);return {sessionId,title:'固定来源',scope,submitted:false,running:false,kind:'ordinary'}},memoryAvailable:async()=>available})
 t.after(()=>runtime.dispose())
 await runtime.bind(owner,{requestId:randomUUID(),sessionId:f.agent.id,projectId:project.id,expectedVersion:0,memoryMode:'enabled'})
 const native=registerProjectRuntimeContext(f.ctx,{owner,readBinding:id=>runtime.getBinding(owner,id),prepare:input=>runtime.prepare(owner,input),assertCurrent:input=>runtime.assertCurrent(owner,input),assertPreparedCurrentSync:input=>runtime.assertPreparedCurrentSync(owner,input),recordUsed:input=>runtime.recordUsed(owner,input),ackGeneration:input=>runtime.ackGeneration(owner,input)})
 t.after(()=>native.close())
 const snapshot=async()=>({events:readSessionEvents(f.agent.session),inheritedEventCount:f.agent.session.inheritedEventCount})
 // 第三个参数是正式宿主的冷/热日志读口；旧版本应在实际 handler 上失败，而非导入失败。
 const factory=createProjectRuntimeHandler as unknown as (owner:string,get:()=>Promise<{runtime:ProjectRuntimeService;memory:never}>,readSnapshot:typeof snapshot)=>ReturnType<typeof createProjectRuntimeHandler>
 const handler=factory(owner,async()=>({runtime,memory:{} as never}),snapshot)
 const read=(turn:number,kind='memory',id=memory.id)=>handler('project-runtime/source',{sessionId:f.agent.id,turn,kind,id}) as Promise<{title:string;version:number;currentVersion:number;markdown:string}>
 const send=async(text:string)=>{const rpcId=randomUUID(),message=createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text}]});f.adapter.scripts.push(textAnswer);await f.work.withNewInput(f.agent,message,{producer:'prompt',identity:rpcId},()=>f.agent.followup(message));await f.agent.whenIdle()}
 await send('请按单价核对订单')
 await t.test('正式adapter输入含宿主生成的项目/规则/记忆引用路径',()=>assertCitationInput(f,['project','rule','memory']))
 assert.equal((await read(1)).markdown,'单价原版：25元。')
 assert.equal((await read(1,'rule',rule.id)).markdown,'逐项列出数量与单价。')
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:2,change:{kind:'save-entry',entryId:memory.id,entryKind:'memory',topic:'单价',markdown:'单价新版：30元。'}})
 await send('请再按单价核对订单')
 assert.deepEqual([await read(1),await read(2)].map(r=>[r.title,r.version,r.markdown]),[['单价',1,'单价原版：25元。'],['单价',2,'单价新版：30元。']],'不能用同ID最新版本倒推原回答')
 assert.equal((await read(1)).currentVersion,2,'旧回复固定版本与当前来源版本分开呈现')
 await send('请介绍下一步工作')
 assert.equal((await read(3)).markdown,'单价新版：30元。','同代次模型历史仍携带的固定来源可引用，不因当前可选召回未命中而丢失')
 const original=await snapshot(),forgedId=randomUUID(),corruptLog={...original,events:original.events.map(event=>event.type==='user/message'&&event.data.source.kind==='runtime-context'&&event.data.source.form==='snapshot'?{...event,data:{...event.data,source:{...event.data.source,sections:event.data.source.sections.map(section=>({...section,text:section.name==='teloa/project-context'?section.text.replaceAll(memory.id,forgedId):section.text}))}}}:event)}
 const forged=factory(owner,async()=>({runtime,memory:{} as never}),async()=>corruptLog)
 await assert.rejects(forged('project-runtime/source',{sessionId:f.agent.id,turn:1,kind:'memory',id:forgedId}),'即使日志中有同正文的新ID，没有原派发清单也不能读取')
 const aborted=new AbortController();aborted.abort();await assert.rejects(handler('project-runtime/source',{sessionId:f.agent.id,turn:1,kind:'memory',id:memory.id},aborted.signal))
 await assert.rejects(read(999));await assert.rejects(read(1,'role',memory.id));await assert.rejects(read(1,'rule',memory.id));await assert.rejects(read(1,'memory',randomUUID()))
 await assert.rejects(handler('project-runtime/source',{sessionId:'other-session',turn:1,kind:'memory',id:memory.id}))
 await assert.rejects(factory('other-owner',async()=>({runtime,memory:{} as never}),snapshot)('project-runtime/source',{sessionId:f.agent.id,turn:1,kind:'memory',id:memory.id}))
 scope='other-scope';await assert.rejects(read(1));scope='general'
 available=false;await assert.rejects(read(1));available=true
 const noDispatch=(await pool.query("select id from teloa_project_context_uses where session_id=$1 and stage='dispatched'",[f.agent.id])).rows
 await pool.query("update teloa_project_context_uses set stage='failed' where session_id=$1",[f.agent.id]);await assert.rejects(read(2))
 await pool.query("update teloa_project_context_uses set stage='dispatched' where id=any($1::uuid[])",[noDispatch.map((r:{id:string})=>r.id)])
 const inherited=factory(owner,async()=>({runtime,memory:{} as never}),async()=>({...await snapshot(),inheritedEventCount:f.agent.session.seq}))
 await assert.rejects(inherited('project-runtime/source',{sessionId:f.agent.id,turn:1,kind:'memory',id:memory.id}),'复制父会话日志不授予子会话来源')
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:3,change:{kind:'withdraw-entry',entryId:memory.id}})
 await assert.rejects(read(1));await assert.rejects(read(2));assert.equal((await read(1,'rule',rule.id)).markdown,'逐项列出数量与单价。')
})

test('真实Loop与PG：项目/简报及历史别名只解析原轮次唯一派发来源',{timeout:60000},async t=>{
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()})
 t.after(async()=>{await pool.end();await container.stop()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool)
 const f=await nativeHotCausalityFixture(t),owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},context=new ProjectContextService(pool,identity),projects=new ProjectService(pool,identity)
 const fields={scope:'general',title:'原项目',goal:'原项目目标',dueDate:null,state:'planning' as const,links:[],references:[]},project=await projects.create(owner,{requestId:randomUUID(),fields})
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:0,change:{kind:'save-brief',brief:'原简报正文'}})
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:1,change:{kind:'save-entry',entryId:null,entryKind:'memory',topic:'单价',markdown:'原单价记忆'}})
 const memory=(await context.get(owner,{projectId:project.id})).entries[0]!
 let scope='general'
 const roleExperience={kind:'role' as const,id:randomUUID(),title:'单价岗位经验',version:1,markdown:'单价需按原件逐项核对',hash:createHash('sha256').update('单价需按原件逐项核对').digest('hex'),scopeIds:['general']}
 const runtime=new ProjectRuntimeService(pool,identity,{inspect:async(actor,sessionId)=>{assert.equal(actor,owner);assert.equal(sessionId,f.agent.id);return {sessionId,title:'引用',scope,submitted:false,running:false,kind:'ordinary'}},optionalMemories:async()=>[roleExperience]});t.after(()=>runtime.dispose())
 await runtime.bind(owner,{requestId:randomUUID(),sessionId:f.agent.id,projectId:project.id,expectedVersion:0,memoryMode:'enabled'})
 const native=registerProjectRuntimeContext(f.ctx,{owner,readBinding:id=>runtime.getBinding(owner,id),prepare:input=>runtime.prepare(owner,input),assertCurrent:input=>runtime.assertCurrent(owner,input),assertPreparedCurrentSync:input=>runtime.assertPreparedCurrentSync(owner,input),recordUsed:input=>runtime.recordUsed(owner,input),ackGeneration:input=>runtime.ackGeneration(owner,input)});t.after(()=>native.close())
 const snapshot=async()=>({events:readSessionEvents(f.agent.session),inheritedEventCount:f.agent.session.inheritedEventCount}),handler=createProjectRuntimeHandler(owner,async()=>({runtime,memory:{} as never}),snapshot)
 const send=async()=>{const rpcId=randomUUID(),message=createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text:'请按单价核对目标和简报'}]});f.adapter.scripts.push(textAnswer);await f.work.withNewInput(f.agent,message,{producer:'prompt',identity:rpcId},()=>f.agent.followup(message));await f.agent.whenIdle()}
 const read=(turn:number,selector:object)=>handler('project-runtime/source',{sessionId:f.agent.id,turn,...selector}) as Promise<{kind:string;id:string;version:number;currentVersion:number;markdown:string}>
 await send()
 await t.test('正式adapter输入含简报路径，未支持岗位经验仅保留可读标题',()=>assertCitationInput(f,['project','brief','memory','role']))
 await t.test('canonical brief/project 读取原正文',async()=>{assert.equal((await read(1,{kind:'brief',id:project.id})).markdown,'原简报正文');assert.equal((await read(1,{kind:'project',id:project.id})).markdown,'原项目目标')})
 await t.test('英文种类冒号、中文标题、精确正文hash绑定原来源',async()=>{for(const reference of ['memory:'+memory.id,'记忆:单价',memory.hash!]){const value=await read(1,{reference});assert.equal(value.id,memory.id);assert.equal(value.markdown,'原单价记忆')}assert.equal((await read(1,{reference:'简报:项目简报'})).markdown,'原简报正文')})
 await t.test('快照正文与hash均不能绕过原派发清单',async()=>{
  const original=await snapshot()
  for(const changeHash of [false,true]){
   const events=original.events.map(event=>event.type==='user/message'&&event.data.source.kind==='runtime-context'&&event.data.source.form==='snapshot'?{...event,data:{...event.data,source:{...event.data.source,sections:event.data.source.sections.map(section=>{
    if(section.name!=='teloa/project-context')return section
    const split=section.text.lastIndexOf('\n'),rows=JSON.parse(section.text.slice(split+1)) as Array<{source:{kind:string;hash:string};markdown:string}>
    for(const row of rows)if(row.source.kind==='brief'){row.markdown='未派发的伪造正文';if(changeHash)row.source.hash=createHash('sha256').update(row.markdown).digest('hex')}
    return {...section,text:section.text.slice(0,split+1)+JSON.stringify(rows)}
   })}}}:event)
   const forged=createProjectRuntimeHandler(owner,async()=>({runtime,memory:{} as never}),async()=>({...original,events}))
   await assert.rejects(forged('project-runtime/source',{sessionId:f.agent.id,turn:1,kind:'brief',id:project.id}),{code:'teloa/source-unavailable'},changeHash?'同时改正文及hash仍无派发依据':'正文必须匹配原hash')
  }
 })
 await projects.edit(owner,{projectId:project.id,expectedVersion:1,fields:{...fields,goal:'新项目目标'}})
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:2,change:{kind:'save-brief',brief:'新项目目标'}})
 await send()
 await t.test('新旧轮次分开，旧正文不以当前正文替换',async()=>{assert.equal((await read(1,{kind:'brief',id:project.id})).markdown,'原简报正文');assert.equal((await read(1,{kind:'project',id:project.id})).markdown,'原项目目标');assert.equal((await read(2,{kind:'brief',id:project.id})).markdown,'新项目目标');assert.equal((await read(2,{kind:'project',id:project.id})).markdown,'新项目目标')})
 await t.test('占位符/歧义/伪造与失权不授予读取',async()=>{
  const ambiguousHash=createHash('sha256').update('新项目目标').digest('hex')
  for(const reference of ['citationPath',project.id,'memory:'+randomUUID(),'记忆:不存在',ambiguousHash])await assert.rejects(read(2,{reference}))
  await assert.rejects(read(1,{kind:'brief',id:randomUUID()}));await assert.rejects(read(1,{kind:'brief',id:project.id,markdown:'伪造',version:1,hash:'a'.repeat(64)}))
  scope='other';await assert.rejects(read(1,{reference:'简报:项目简报'}));scope='general'
 })
 await context.mutate(owner,{requestId:randomUUID(),projectId:project.id,expectedVersion:3,change:{kind:'save-brief',brief:''}})
 await t.test('简报清空后旧链接拒绝，项目目标仍可读',async()=>{await assert.rejects(read(1,{kind:'brief',id:project.id}));assert.equal((await read(1,{kind:'project',id:project.id})).markdown,'原项目目标')})
})
