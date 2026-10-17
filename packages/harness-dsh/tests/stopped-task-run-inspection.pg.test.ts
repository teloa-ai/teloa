import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {SessionId,SessionSeq,type SessionHeader,type SessionEvent} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import {setupRoleWork,roleFixture,identity} from '../../backend/tests/role-work-test-fixture.ts'
import {initializeTeloaDatabase} from '../../backend/src/work/initialize-database.ts'
import {TaskRunService,type TaskRun} from '../../backend/src/work/task-runs.ts'
import {WorkLineageService} from '../../backend/src/work/work-lineage.ts'
import {ObjectConversationService} from '../../backend/src/work/object-conversations.ts'
import {initializeTaskRunStopRecovery,StoppedUnacceptedTaskRunService} from '../../backend/src/work/task-run-stop-recovery.ts'
import {createStoppedUnacceptedTaskRunInspector,type StoppedTaskRunInspectionOptions} from '../src/stopped-task-run-inspection.ts'
import type {SessionPersistence} from '@deepseek-ai/dsh-session-persistence'
import {RoleService} from '../../backend/src/work/roles.ts'
import {TaskService} from '../../backend/src/work/tasks.ts'
import {CollaborationService} from '../../backend/src/work/collaboration.ts'
import {GroupAgentGrantService} from '../../backend/src/work/group-agent-grants.ts'
import {GroupTaskService} from '../../backend/src/work/group-tasks.ts'
import {GroupRoutingDecisionService} from '../../backend/src/work/group-routing-decisions.ts'
import {GroupRoutingOutboxService} from '../../backend/src/work/group-routing-outbox.ts'
import {readRunGroupContext} from '../../backend/src/work/task-run-group-context.ts'
import {WorkControlService} from '../../backend/src/work/work-control.ts'
import {RoleLifecycleService} from '../../backend/src/work/role-lifecycle.ts'
import {testRoleResponsibility} from '../../backend/tests/role-test-fixture.ts'

/** JSONL 实现专有的当前日志定位不在官方 SessionPersistence 接口中，运行时核对后再交给只读检查器。 */
const hasCurrentLog=(persistence:SessionPersistence):persistence is SessionPersistence&StoppedTaskRunInspectionOptions['persistence']=>typeof Reflect.get(persistence,'resolveCurrentLog')==='function'

test('真实PG+官方readonly存储：完整初始化证明可撤回，受理/清空队列/继承/截断/读取失败均拒绝',{timeout:60000},async t=>{
 const f=await setupRoleWork(),directory=await mkdtemp(join(process.cwd(),'.tmp-stopped-native-')),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await f.close();await rm(directory,{recursive:true,force:true})})
 await initializeTeloaDatabase(f.pool);await initializeTaskRunStopRecovery(f.pool)
 await ctx.plugin(JsonlSessionPersistence,{root:directory,compression:'none'})
 const persistence=ctx.sessionPersistence;assert.ok(hasCurrentLog(persistence),'JSONL 持久化须提供当前日志定位。')
 assert.equal(ctx.get('agents' as never),undefined);assert.equal(ctx.get('agentLoop' as never),undefined)
 const native=createStoppedUnacceptedTaskRunInspector({persistence,expectedCwd:directory,readCompleteLog:async(path,signal)=>readFile(path,{signal})})
 const fixture=async()=>{
  const {owner,role,taskId}=await roleFixture(f.pool,'employee'),sessionId='stop-'+randomUUID(),conversationId=randomUUID(),db=await f.pool.connect()
  try{await db.query('begin');await new WorkLineageService(f.pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
  await f.pool.query("update teloa_roles set state='active' where id=$1",[role.id])
  const inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'}),link=await new ObjectConversationService(f.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
  const runs=new TaskRunService(f.pool,identity,inspect),run=await runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:link.version},undefined,undefined,undefined,async()=> 'teloa-standard')
  await runs.claim(owner,{runId:run.id});const stopped=await runs.requestStop(owner,{runId:run.id}),runtimeId=randomUUID()
  await f.pool.query("insert into teloa_task_run_runtime_links(owner_id,run_id,kind,native_id,session_id,payload) values($1,$2,'job',$3,$4,$5)",[owner,stopped.id,'owner:'+runtimeId+':'+sessionId,sessionId,JSON.stringify({record:'owner',runtimeId,requestId:stopped.nativeRequestId})])
  const command={requestId:randomUUID(),runId:run.id},ports={ownerAuthority:{authorize:async()=>({assertCurrent(){}})},acquireHostStopped:async()=>({assertCurrent(){}}),inspectNative:native}
  return {owner,runs,run:stopped,command,ports,service:new StoppedUnacceptedTaskRunService(f.pool,runs,identity,ports)}
 }
 const store=async(run:TaskRun,events:SessionEvent[]=[],meta:Partial<SessionHeader>={})=>{
  const handle=await persistence.create({id:SessionId(run.sessionId),version:4,createdAt:Date.now(),cwd:directory,isSeeded:false,agentPreset:'teloa-standard',...meta})
  try{await handle.append(events);await handle.flush()}finally{await handle.close()}
  const path=await persistence.resolveCurrentLog(SessionId(run.sessionId));assert.ok(path);return path
 }
 const good=await fixture(),signal=new AbortController().signal
 const initialization:SessionEvent[]=[
  {type:'permission/preset',seq:SessionSeq(0),time:Date.now(),data:{preset:'workspace-write'}},
  {type:'sandbox/mode',seq:SessionSeq(1),time:Date.now(),data:{mode:'workspace-write'}},
  {type:'approval/policy',seq:SessionSeq(2),time:Date.now(),data:{policy:'ask'}},
 ]
 const path=await store(good.run,initialization)
 const logBefore=await readFile(path),runBefore=await good.runs.get(good.owner,{runId:good.run.id})
 const result=await good.service.withdraw(good.owner,good.command,signal)
 assert.equal(result.run.state,'withdrawn');assert.equal(result.run.evidence,null);assert.equal(result.run.stopRequestedAt,runBefore.stopRequestedAt)
 assert.equal(result.receipt.native.mode,'official-session-initial-inbox-no-commands');assert.equal(result.receipt.native.logCut,2)
 assert.deepEqual(await readFile(path),logBefore,'读取与撤回不能改写原生文件')
 assert.equal(result.receipt.task.after.state,'paused')
 for(const mode of ['queued','queue-cleared','user','turn','tool','unknown','metadata-extra','cwd','parent','read-failure','truncated','decode-error'] as const){
  const current=await fixture(),message=createUserMessage({source:{kind:'user',rpcId:current.run.nativeRequestId},content:[{type:'text',text:'已经受理的原输入'}]})
  const queue:SessionEvent={type:'agent/inbox/spliced',seq:SessionSeq(0),time:Date.now(),data:{target:'next-turn',start:0,removedCount:0,inserted:[message]}}
  let events:SessionEvent[]=[]
  if(mode==='queued'||mode==='queue-cleared')events=[queue]
  if(mode==='queue-cleared')events.push({...queue,seq:SessionSeq(1),data:{target:'next-turn',start:0,removedCount:1,inserted:[]}})
  if(mode==='user')events=[{type:'user/message',seq:SessionSeq(0),time:Date.now(),surfaceOp:'append',data:message}]
  if(mode==='turn')events=[{type:'turn/start',seq:SessionSeq(0),time:Date.now(),data:{turn:0}}]
  if(mode==='tool'||mode==='unknown')events=[{type:mode==='tool'?'tool/call':'unexpected/record',seq:SessionSeq(0),time:Date.now(),data:{}} as unknown as SessionEvent]
  if(mode==='metadata-extra')events=[{...initialization[0]!,data:{preset:'workspace-write',unexpected:'hidden-input'}} as unknown as SessionEvent]
  const file=await store(current.run,events,mode==='cwd'?{cwd:join(directory,'other')}:mode==='parent'?{parentSession:SessionId('foreign-parent'),delegationDepth:1}:{})
  if(mode==='truncated')await writeFile(file,Buffer.concat([await readFile(file),Buffer.from('{"type":"agent/inbox/spliced"')]))
  let selected=current.service
  if(mode==='read-failure'||mode==='decode-error'){
   const failing=createStoppedUnacceptedTaskRunInspector({persistence,expectedCwd:directory,readCompleteLog:async()=>{throw Error(mode==='decode-error'?'truncated second compressed frame':'physical read failed')}})
   selected=new StoppedUnacceptedTaskRunService(f.pool,current.runs,identity,{...current.ports,inspectNative:failing})
  }
  await assert.rejects(selected.withdraw(current.owner,current.command,signal),mode)
  assert.equal((await current.runs.get(current.owner,{runId:current.run.id})).state,'submitting',mode)
  assert.equal((await f.pool.query('select count(*)::int n from teloa_task_run_stop_recoveries where owner_id=$1',[current.owner])).rows[0].n,0)
 }
 const changed=await fixture();await store(changed.run)
 await f.pool.query("update teloa_tasks set version=version+1,content_version=content_version+1,definition=jsonb_set(definition,'{goal}',to_jsonb('本人后续修改的目标'::text)) where id=$1",[changed.run.taskId])
 const later=(await f.pool.query('select * from teloa_tasks where id=$1',[changed.run.taskId])).rows[0],withdrawn=await changed.service.withdraw(changed.owner,changed.command,signal)
 assert.equal(withdrawn.run.state,'withdrawn');assert.equal(withdrawn.receipt.task.changed,false)
 assert.deepEqual((await f.pool.query('select * from teloa_tasks where id=$1',[changed.run.taskId])).rows[0],later,'不得覆盖本人后续任务版本')
 assert.equal(ctx.get('agents' as never),undefined);assert.equal(ctx.get('agentLoop' as never),undefined)
})

test('真实群提交停止恢复：原消息与派工及已结束轮核实后撤回，暂停角色不改冻结版本',{timeout:60000},async t=>{
 const f=await setupRoleWork(),directory=await mkdtemp(join(process.cwd(),'.tmp-stopped-group-native-')),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await f.close();await rm(directory,{recursive:true,force:true})})
 await initializeTeloaDatabase(f.pool);await initializeTaskRunStopRecovery(f.pool)
 await ctx.plugin(JsonlSessionPersistence,{root:directory,compression:'none'})
 const persistence=ctx.sessionPersistence;assert.ok(hasCurrentLog(persistence))
 const native=createStoppedUnacceptedTaskRunInspector({persistence,expectedCwd:directory,readCompleteLog:(path,signal)=>readFile(path,{signal})})
 const owner=randomUUID(),roles=new RoleService(f.pool,identity),groups=new CollaborationService(f.pool,identity)
 const initialRole=await roles.create(owner,{requestId:randomUUID(),fields:{name:'简报员工',kind:'employee',scopes:['general'],duty:'核对本人材料',dataScope:'群内固定资料',executionScope:'只读草稿',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'teloa-standard'}}}),lifecycle=new RoleLifecycleService(f.pool,identity)
 const firstPause=await lifecycle.change(owner,{roleId:initialRole.id,expectedVersion:initialRole.version,action:'pause',reason:'准备固定角色版本'})
 const role=(await lifecycle.change(owner,{roleId:initialRole.id,expectedVersion:firstPause.appliedVersion,action:'resume',reason:'本人明确开始本轮群任务'})).role
 assert.equal(role.version,3)
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'原团队',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[role.id]}})
 await new GroupAgentGrantService(f.pool,identity.now).change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:1,expectedRoleVersion:role.version,action:'save',resources:[],canPost:true,canAutoRun:true})
 const message=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:1,text:'仅用本人已提供的事实写一条未发送简报。',references:[],mentions:[{roleId:role.id,expectedVersion:role.version}]})
 const decisions=new GroupRoutingDecisionService(f.pool,identity),outbox=new GroupRoutingOutboxService(f.pool,identity)
 const decision={kind:'direct' as const,intent:'work' as const,respond:[role.id],reactions:[],hops:0,candidateIds:[role.id],truncatedCandidates:false,stopMessageId:null,workTarget:null,assignments:[{roleId:role.id,instructionRange:{start:0,end:message.text.length}}],at:identity.now()}
 const items=await decisions.withTopicLock(owner,group.id,message.id,async db=>{await decisions.record(db,owner,{groupId:group.id,messageId:message.id,decision});return outbox.recordRecipients(db,owner,{groupId:group.id,messageId:message.id,decision,decisionVersion:1})}),item=items[0];assert.ok(item)
 const created=await new GroupTaskService(f.pool,identity,new TaskService(f.pool,identity)).create(owner,await outbox.taskInput(owner,{itemId:item.id}))
 const sessionId='stop-group-'+randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
 const link=await new ObjectConversationService(f.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:created.task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(f.pool,identity,inspect,{allowedTools:[],groupContext:(db,actor,task,currentRole)=>readRunGroupContext(db,actor,task,currentRole,undefined,f.pool)})
 const prepared=await runs.prepare(owner,{requestId:item.requestId,taskId:created.task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:link.version},undefined,undefined,undefined,async()=> 'teloa-standard')
 assert.ok(prepared.groupContext);await runs.claim(owner,{runId:prepared.id});const stopped=await runs.requestStop(owner,{runId:prepared.id}),runtimeId=randomUUID(),signal=new AbortController().signal
 await f.pool.query("insert into teloa_task_run_runtime_links(owner_id,run_id,kind,native_id,session_id,payload) values($1,$2,'job',$3,$4,$5)",[owner,stopped.id,'owner:'+runtimeId+':'+sessionId,sessionId,JSON.stringify({record:'owner',runtimeId,requestId:stopped.nativeRequestId})])
 const claimed=await outbox.claim(owner,{itemId:item.id,expectedLeaseGeneration:0});assert.ok(claimed)
 await outbox.settle(owner,{itemId:item.id,leaseGeneration:claimed.leaseGeneration,taskId:created.task.id,runId:stopped.id,state:'unknown',reason:'teloa/execution-pending'})
 const handle=await persistence.create({id:SessionId(sessionId),version:4,createdAt:Date.now(),cwd:directory,isSeeded:false,agentPreset:'teloa-standard'})
 try{await handle.append([{type:'permission/preset',seq:SessionSeq(0),time:Date.now(),data:{preset:'workspace-write'}},{type:'sandbox/mode',seq:SessionSeq(1),time:Date.now(),data:{mode:'workspace-write'}},{type:'approval/policy',seq:SessionSeq(2),time:Date.now(),data:{policy:'never'}}]);await handle.flush()}finally{await handle.close()}
 const path=await persistence.resolveCurrentLog(SessionId(sessionId));assert.ok(path);const logBefore=await readFile(path)
 const command={requestId:randomUUID(),runId:stopped.id};let hostAlive=false
 const service=new StoppedUnacceptedTaskRunService(f.pool,runs,identity,{ownerAuthority:{authorize:async()=>({assertCurrent(){}})},acquireHostStopped:async()=>({assertCurrent(){if(hostAlive)throw Error('宿主仍然存活')}}),inspectNative:native})
 const unchanged=await f.pool.query('select * from teloa_task_runs where id=$1',[stopped.id])
 await assert.rejects(service.withdraw(owner,command,signal),'活动 round 不得撤回')
 const controls=new WorkControlService(f.pool,identity,{ownerAuthority:{authorize:async()=>({assertCurrent(){}})},inspectRun:async()=>({settled:true,unknownOperationIds:[]})}),round=await controls.get(owner,{controlId:stopped.lineage!.roundControlId})
 const stopping=await controls.change(owner,{requestId:randomUUID(),controlId:round.id,expectedVersion:round.version,action:'stop',scope:'round',roundControlId:null})
 const ended=await controls.reconcile(owner,{controlId:round.id,generation:stopping.generation});assert.equal(ended.state,'stopped')
 const paused=await new RoleLifecycleService(f.pool,identity).change(owner,{roleId:role.id,expectedVersion:role.version,action:'pause',reason:'本轮停止后暂停员工'})
 assert.equal(paused.role.version,stopped.roleVersion!+1)
 for(const unsafe of ['host','source','message','outbox','progress'] as const){
  hostAlive=unsafe==='host'
  if(unsafe==='source')await f.pool.query("update teloa_group_task_sources set snapshot_digest=repeat('0',64) where task_id=$1",[stopped.taskId])
  if(unsafe==='message')await f.pool.query("update teloa_group_messages set text=text||'改动' where id=$1",[message.id])
  if(unsafe==='outbox')await f.pool.query("update teloa_group_routing_outbox set state='leased' where id=$1",[item.id])
  if(unsafe==='progress')await f.pool.query("update teloa_work_control_progress set unknown_operation_ids='{pending}' where owner_id=$1 and control_id=$2",[owner,round.id])
  await assert.rejects(service.withdraw(owner,command,signal),unsafe)
  assert.deepEqual((await f.pool.query('select * from teloa_task_runs where id=$1',[stopped.id])).rows,unchanged.rows,unsafe)
  if(unsafe==='source')await f.pool.query('update teloa_group_task_sources set snapshot_digest=$2 where task_id=$1',[stopped.taskId,(await import('../../backend/src/work/group-task-source-digest.ts')).groupTaskSourceDigest(created.source)])
  if(unsafe==='message')await f.pool.query('update teloa_group_messages set text=$2 where id=$1',[message.id,message.text])
  if(unsafe==='outbox')await f.pool.query("update teloa_group_routing_outbox set state='unknown' where id=$1",[item.id])
  if(unsafe==='progress')await f.pool.query("update teloa_work_control_progress set unknown_operation_ids='{}' where owner_id=$1 and control_id=$2",[owner,round.id])
 }
 hostAlive=false
 const result=await service.withdraw(owner,command,signal)
 assert.equal(result.run.state,'withdrawn');assert.equal(result.run.evidence,null);assert.equal(result.run.roleVersion,role.version);assert.deepEqual(result.run.groupContext,stopped.groupContext)
 assert.equal(result.receipt.task.changed,true);assert.equal(result.receipt.task.after.state,'paused')
 assert.deepEqual((await f.pool.query('select * from teloa_task_runs where id=$1',[stopped.id])).rows[0],{...unchanged.rows[0],state:'withdrawn'})
 assert.deepEqual(await readFile(path),logBefore);assert.deepEqual(await service.withdraw(owner,command,signal),result)
 assert.deepEqual(await controls.get(owner,{controlId:round.id}),ended,'原停止控制不复活')
 assert.equal((await roles.list(owner,{})).find(r=>r.id===role.id)?.version,4)
 assert.equal((await outbox.list(owner,{groupId:group.id,messageIds:[message.id]}))[0]?.state,'unknown','维护不擅自改派或伪造派工回执')
 assert.equal(ctx.get('agents' as never),undefined);assert.equal(ctx.get('agentLoop' as never),undefined)
})
