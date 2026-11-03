import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {TaskRunService,TaskRunSubmissionService,ObjectConversationService,WorkLineageService,initializeTeloaDatabase,WorkAccess,TaskRunRuntimeLinkService} from '@teloa/backend'
import {setupRoleWork,roleFixture,identity} from '../../backend/tests/role-work-test-fixture.ts'
import {dshTaskRunPorts} from '../src/task-run-dsh.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
import {LoopWorkAdapter,loopText} from './fixtures/native-loop-work-admission.ts'
import {AgentPresetRegistry} from '@deepseek-ai/dsh-agent-preset-registry'
import {official} from '../../../tests/native-auto-review-fixture.mjs'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {TaskRunDriver} from '../src/task-run-driver.ts'
import {LocalJobRegistry} from '@deepseek-ai/dsh-jobs-local'
import {taskRunRuntimeId} from '../src/task-run-background.ts'
import {createTaskRunHandler,taskRunOwnerEndpoint} from '../src/task-runs.ts'

test('隔离PG持久回执与真实Loop合用：恢复固定Run/session/native输入且只入队一次',{timeout:40000},async t=>{
 const database=await setupRoleWork();t.after(database.close)
 await initializeTeloaDatabase(database.pool)
 const {owner,role,taskId}=await roleFixture(database.pool,'employee'),{ctx,sessionPackage,persistencePackage}=await patchedSessionFixture(t),adapter=new LoopWorkAdapter()
 const root=await mkdtemp(join(tmpdir(),'teloa-submission-persistence-'))
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 await ctx.plugin(persistencePackage,{root,compression:'none'})
 await ctx.plugin(LocalJobRegistry)
 const {Loader}=await official('cordis-plugin-loader')
 class TestLoader extends Loader{write(){}}
 await ctx.plugin(TestLoader);await ctx.plugin(AgentPresetRegistry,{default:'submission-test'})
 await ctx.agentPresets.register({id:'submission-test',plugins:[]})
 const {agent}=await ctx.agents.create({sessionId:sessionPackage.SessionId('submission-'+randomUUID()),meta:{agentPreset:'submission-test'},agentOptions:{provider:'loop-test',model:'one'},setup:scope=>ctx.agentPresets.mount(scope,'submission-test').then(()=>{})})
 ctx.llm.registerAdapter(['loop-test'],adapter)
 ctx.provide('sessionController',{resolveAgent:async(id:typeof agent.id)=>({agent:ctx.agents.get(id)})} as never)
 ctx.provide('attachments',{admitPromptContent:async(content:unknown)=>structuredClone(content)} as never)
 const db=await database.pool.connect();try{await db.query('begin');await new WorkLineageService(database.pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
 await database.pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId:agent.id,status:'ready'})
 const link=await new ObjectConversationService(database.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId:agent.id,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(database.pool,identity,inspect),prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId:agent.id,expectedLinkVersion:link.version},undefined,undefined,undefined,async()=> 'submission-test',async()=>({primary:{provider:'loop-test',model:'one'}}))
 const run=(await runs.claim(owner,{runId:prepared.id})).run,target=await runs.executionScope(owner,{runId:run.id}),signal=AbortSignal.timeout(20000)
 const native=createNativeWorkInput(ctx,new WorkAccess());t.after(native.close);let deny=true,late:(()=>void)|undefined
 const linkService=new TaskRunRuntimeLinkService(database.pool)
 const linksFor=(owner:string)=>({put:(input:unknown)=>linkService.put(owner,input),list:(input:unknown)=>linkService.list(owner,input)})
 const service=new TaskRunSubmissionService(database.pool)
 const journal=(owner:string,generation:string)=>({begin:(run:typeof prepared)=>service.begin(owner,run,generation),finish:(ticket:Parameters<typeof service.finish>[1],result:'accepted'|'not-published')=>service.finish(owner,ticket,result),recoverable:(run:typeof prepared)=>service.recoverable(owner,run),unpublishedOwnerIds:(runId:string)=>service.unpublishedOwnerIds(owner,runId)})
 const makePorts=(generation:string)=>{
  const ports=dshTaskRunPorts(ctx,owner,async sessionId=>({ownerId:owner,sessionId,status:'ready'}),undefined,undefined,undefined,undefined,undefined,undefined,linksFor(owner),undefined,undefined,{withNewInput:async(...args:Parameters<typeof native.withNewInput>)=>{if(deny){late=args[3];throw Error('确定的发布前准入拒绝')}return native.withNewInput(...args)}},undefined,generation)
  ports.submissions=journal(owner,generation);return ports
 }
 const firstGeneration=randomUUID(),secondGeneration=randomUUID()
 let ports=makePorts(firstGeneration)
 await assert.rejects(ports.send(run,signal,target),/发布前准入拒绝/)
 assert.equal(await service.recoverable(owner,run),true);assert.throws(()=>late!());assert.equal(adapter.requests.length,0)
 ports=makePorts(secondGeneration);deny=false;adapter.scripts.push(loopText)
 await ports.send(await runs.get(owner,{runId:run.id}),signal,target);await agent.whenIdle()
 assert.equal(adapter.requests.length,1)
 assert.equal(agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&Reflect.get(event.data.source,'rpcId')===run.nativeRequestId).length,1)
 assert.deepEqual((await database.pool.query('select state from teloa_task_run_submissions where owner_id=$1 and run_id=$2 order by attempt',[owner,run.id])).rows.map(row=>row.state),['not-published','accepted'])
 assert.deepEqual(await runs.get(owner,{runId:run.id}),run,'native完成另行由正式reconcile落库，提交账本不能伪造终态')
 assert.equal(await service.recoverable(owner,run),false)
 assert.equal((await linkService.list(owner,{runId:run.id})).length,2,'两代实际owner审计保留，不能靠删除旧关联修复')
 assert.deepEqual(await ports.backgroundState!(run),{outstanding:false,interrupted:false},'可信未发布旧owner不污染真实新世代完成判据')
 const completed=await new TaskRunDriver(runs,ports).reconcile(owner,{runId:run.id},signal)
 assert.equal(completed.state,'ended');assert.equal(completed.evidence?.state,'ended')
 if(completed.evidence?.state==='ended')assert.equal(completed.evidence.reason,'completed','原生 completed 不能被改成 interrupted')
 await assert.rejects(ports.send(run,signal,target));assert.equal(adapter.requests.length,1)

 // 模拟宿主在持久 dispatching 后失去结果、但同一世代仍可提供真实停发栅栏。
 // 不以空日志认定未发布：明确本人选择后落独立 unknown，原 Run 与预算均保留。
 const next=await roleFixture(database.pool,'employee'),secondConversationId=randomUUID()
 const {agent:second}=await ctx.agents.create({sessionId:sessionPackage.SessionId('unknown-'+randomUUID()),meta:{agentPreset:'submission-test'},agentOptions:{provider:'loop-test',model:'one'},setup:scope=>ctx.agentPresets.mount(scope,'submission-test').then(()=>{})})
 const transaction=await database.pool.connect();try{await transaction.query('begin');await new WorkLineageService(database.pool,identity).bindTask(transaction,next.owner,{taskId:next.taskId,source:{kind:'owner-task',taskId:next.taskId}});await transaction.query('commit')}finally{transaction.release()}
 await database.pool.query("update teloa_roles set state='active' where id=$1",[next.role.id])
 const inspectSecond=async()=>({id:secondConversationId,ownerId:next.owner,sessionId:second.id,status:'ready'})
 const secondLink=await new ObjectConversationService(database.pool,inspectSecond,identity.now).change(next.owner,{requestId:randomUUID(),kind:'task',objectId:next.taskId,expectedObjectVersion:1,sessionId:second.id,expectedLinkVersion:0,action:'link'})
 const secondRuns=new TaskRunService(database.pool,identity,inspectSecond),secondPrepared=await secondRuns.prepare(next.owner,{requestId:randomUUID(),taskId:next.taskId,expectedTaskVersion:1,roleId:next.role.id,expectedRoleVersion:next.role.version,sessionId:second.id,expectedLinkVersion:secondLink.version},undefined,undefined,undefined,async()=> 'submission-test',async()=>({primary:{provider:'loop-test',model:'one'}}))
 const secondRun=(await secondRuns.claim(next.owner,{runId:secondPrepared.id})).run
 const unknownPorts=(generation:string,loseReceipt=false)=>{
  const result=dshTaskRunPorts(ctx,next.owner,async sessionId=>({ownerId:next.owner,sessionId,status:'ready'}),undefined,undefined,undefined,undefined,undefined,undefined,linksFor(next.owner),undefined,undefined,{withNewInput:async()=>{throw Error('本轮准入拒绝')}},undefined,generation)
  result.submissions={...journal(next.owner,generation),...(loseReceipt?{finish:async()=>{throw Error('持久回执不可达')}}:{})}
  return result
 }
 const secondTarget=await secondRuns.executionScope(next.owner,{runId:secondRun.id}),previousPorts=unknownPorts(randomUUID())
 await assert.rejects(previousPorts.send(secondRun,signal,secondTarget),/准入拒绝/)
 const secondPorts=unknownPorts(taskRunRuntimeId,true)
 await assert.rejects(secondPorts.send(secondRun,signal,secondTarget),/准入拒绝/)
 assert.equal((await linkService.list(next.owner,{runId:secondRun.id})).length,2)
 secondPorts.disposeSubmission=(run,input,signal)=>secondPorts.withSubmissionFence!(run,signal,fence=>service.disposeUnknown(next.owner,input,secondRuns,fence))
 const handler=createTaskRunHandler(next.owner,async()=>secondRuns,secondPorts),command={runId:secondRun.id,requestId:randomUUID(),acknowledgeUnknown:true}
 const disposed=await handler(taskRunOwnerEndpoint,command,signal)
 assert.ok(!Array.isArray(disposed)&&'state'in disposed);assert.equal(disposed.state,'submission_unknown')
 assert.equal(disposed.id,secondRun.id);assert.equal(disposed.evidence,null);assert.equal(disposed.submissionDisposition?.runtimeId,taskRunRuntimeId)
 assert.equal((await database.pool.query('select state from teloa_task_run_submissions where owner_id=$1 and run_id=$2 order by attempt desc',[next.owner,secondRun.id])).rows[0].state,'dispatching')
 assert.deepEqual(await handler(taskRunOwnerEndpoint,command,signal),disposed)
 assert.equal(adapter.requests.length,1,'处置本身不能调用模型')
})
