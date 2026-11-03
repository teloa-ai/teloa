import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {Pool} from '../../backend/tests/postgres-test-lifecycle.ts'
import {initializeBusinessSpaces} from '../../backend/src/work/business-spaces.ts'
import {initializeProjects} from '../../backend/src/work/projects.ts'
import {initializeProjectContext} from '../../backend/src/work/project-context.ts'
import {initializeProjectRuntime,ProjectRuntimeService} from '../../backend/src/work/project-runtime.ts'
import {registerProjectRuntimeContext} from '../src/project-runtime-context.ts'
import {nativeHotCausalityFixture,textAnswer,toolAnswer} from './fixtures/native-hot-causality.ts'

test('真实Loop与PG：仅岗位版本变化保留本人订单输入，换代仍清除旧岗位与工具；撤回后不能复活历史',{timeout:60000},async t=>{
 const container=await new PostgreSqlContainer('postgres:17-alpine').withLabels({'teloa.test':'j02-history'}).start(),pool=new Pool({connectionString:container.getConnectionUri(),connectionTimeoutMillis:5000})
 t.after(async()=>{await pool.end();await container.stop()})
 await initializeBusinessSpaces(pool);await initializeProjects(pool);await initializeProjectContext(pool);await initializeProjectRuntime(pool)
 const f=await nativeHotCausalityFixture(t),owner=randomUUID(),roleId=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()}
 let roleVersion=1,roleInputBoundary='original-authority',footer='J02-初版已复核',available=true
 const markdown='订单资料 OLD-MATERIAL',entry={kind:'role' as const,id:randomUUID(),title:'订单',version:1,hash:createHash('sha256').update(markdown).digest('hex'),markdown,scopeIds:['general']}
 const ports={inspect:async(_owner:string,sessionId:string)=>({sessionId,title:'订单复核',scope:'general',scopes:['general'],submitted:true,running:false,kind:'employee' as const,roleId,roleKind:'employee' as const,roleVersion,roleInputBoundary}),optionalMemories:async()=>available?[entry]:[]}
 let runtime=new ProjectRuntimeService(pool,identity,ports);t.after(()=>runtime.dispose())
 f.ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{const result=await next();return {...result,contexts:[...result.contexts,{name:'teloa/role-identity',text:footer}]}})
 const native=registerProjectRuntimeContext(f.ctx,{owner,readBinding:id=>runtime.getBinding(owner,id),prepare:input=>runtime.prepare(owner,input),assertCurrent:input=>runtime.assertCurrent(owner,input),assertPreparedCurrentSync:input=>runtime.assertPreparedCurrentSync(owner,input),recordUsed:input=>runtime.recordUsed(owner,input),ackGeneration:input=>runtime.ackGeneration(owner,input)})
 t.after(native.close)
 const send=async(text:string)=>{const rpcId=randomUUID(),message=createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text}]});await f.work.withNewInput(f.agent,message,{producer:'prompt',identity:rpcId},()=>f.agent.followup(message));await f.agent.whenIdle()}
 f.adapter.scripts.push(toolAnswer,textAnswer,textAnswer,textAnswer,textAnswer)
 await send('订单 J2-A：4件，27.25元；J2-B：2件，9.50元。')
 const before=f.agent.session.snapshotEvents(),initial=await runtime.getBinding(owner,f.agent.id)
 assert.equal(f.counters.tools,1)
 roleVersion++;footer='J02-新版已复核'
 // 模拟真实派发前检查先推进持久代次，随后宿主冷建；不能只靠一次 prepare 的内存标志。
 await runtime.prepare(owner,{sessionId:f.agent.id,messageId:'context-check',query:'',purpose:'check'})
 runtime.dispose();runtime=new ProjectRuntimeService(pool,identity,ports)
 await send('新增 J2-C：3件，18.75元。合并本会话订单，遵循当前岗位要求。')
 const updated=f.adapter.requests.at(-1)!,text=JSON.stringify(updated.messages)
 assert.match(text,/27\.25/,'岗位更新不能删除本人原始订单')
 assert.match(text,/9\.50/);assert.match(text,/18\.75/);assert.match(text,/J02-新版已复核/)
 assert.doesNotMatch(text,/J02-初版已复核|hot-result/,'旧岗位上下文和工具衍生结果仍应重建')
 assert.ok((await runtime.getBinding(owner,f.agent.id))!.generation>initial!.generation)
 assert.deepEqual(f.agent.session.snapshotEvents().slice(0,before.length),before)
 assert.equal(f.counters.tools,1,'重建不得重跑已执行工具')
 available=false;roleVersion++;footer='J02-撤回后职责'
 await send('来源已撤回，开始独立工作 NEW-OWNER-INPUT。')
 assert.doesNotMatch(JSON.stringify(f.adapter.requests.at(-1)!.messages),/27\.25|9\.50|18\.75|OLD-MATERIAL/,'来源撤回与版本变化同时发生仍完整隔离')
 roleVersion++;footer='J02-再次更新职责'
 await send('继续这次独立工作 NEXT-OWNER-INPUT。')
 const final=JSON.stringify(f.adapter.requests.at(-1)!.messages)
 assert.match(final,/NEW-OWNER-INPUT/);assert.match(final,/NEXT-OWNER-INPUT/)
 assert.doesNotMatch(final,/27\.25|9\.50|18\.75|OLD-MATERIAL/,'后续岗位更新不能复活之前隔离掉的用户输入')
 roleVersion++;await runtime.prepare(owner,{sessionId:f.agent.id,messageId:'context-check',query:'',purpose:'check'})
 f.adapter.scripts.push(textAnswer)
 await send('继续')
 assert.match(JSON.stringify(f.adapter.requests.at(-1)!.messages),/NEW-OWNER-INPUT/,'未撤回的岗位更新后短续问保留明确的本人目标')
 roleVersion++;roleInputBoundary='restricted-authority';f.adapter.scripts.push(textAnswer)
 await send('岗位已缩小数据范围，仅核对本条新输入 AUTHORITY-CHANGED。')
 assert.doesNotMatch(JSON.stringify(f.adapter.requests.at(-1)!.messages),/NEW-OWNER-INPUT|NEXT-OWNER-INPUT/,'真实岗位权限或关联资源变化仍完整清除此前输入')
 // 硬换代后尚未派发新输入，再改岗位不能借新的floor把旧目标带回来。
 available=true;f.adapter.scripts.push(textAnswer);await send('重新核对当前订单资料。')
 available=false;await runtime.prepare(owner,{sessionId:f.agent.id,messageId:'context-check',query:'',purpose:'check'})
 roleVersion++;await runtime.prepare(owner,{sessionId:f.agent.id,messageId:'context-check',query:'',purpose:'check'})
 const requests=f.adapter.requests.length
 await assert.rejects(send('继续'),{code:'teloa/invalid-input',details:{reason:'employee-context-goal-required'}})
 assert.equal(f.adapter.requests.length,requests)
})
