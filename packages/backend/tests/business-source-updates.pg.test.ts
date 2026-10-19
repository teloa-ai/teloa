import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import * as api from '../src/index.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import {WorkEventService} from '../src/work/work-events.ts'
import {businessWorkSourceReader} from '../src/work/business-work-event-source.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {workRequestChildId} from '../src/work/conversation-work-task-protection.ts'
import {drainBusinessTaskSourceUpdates} from '../../harness-dsh/src/business-source-update-driver.ts'

let pool:Pool,container:StartedPostgreSqlContainer
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const unavailable=async():Promise<never>=>{throw Error('不得访问市场或远端')}
const ownerAuthority={authorize:async()=>({assertCurrent(){}})}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').withPullPolicy({shouldPull:()=>false}).start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await api.initializeTeloaDatabase(pool);await api.initializeBusinessSpaces(pool);await api.initializeBusinessDefinitions(pool);await api.initializeBusinessConfigurations(pool);await api.initializeBusinessRuntime(pool);await api.initializeBusinessData(pool);await api.initializeBusinessWarehouse(pool);await api.initializeBusinessSnapshotReferences(pool);await api.initializeBusinessSync(pool);await api.initializeBusinessRecords(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await stopTestContainer(container)})

const type='soc-source-alert',mappingId='soc-alert-sync'
/**
 * 真实链：配置草案（源告警对象类型 + 只读 MCP 映射）→ 本人确认员工委托 → 原已确认 Plan 类型级订阅 → 同步 → 逐对象事件 → 领取 → 任务（原生业务来源）→ Run。
 * 模型端口不装配；来源用固定夹具代替只读 MCP。
 */
async function fixture(){
 const drafts=new api.BusinessConfigurationDraftService(pool,identity),store=new api.BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const runtime=new api.BusinessRuntimeService(pool,identity),spaces=new api.BusinessSpaceService(pool,identity)
 const apply=new api.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime,spaces}),preview=new api.BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 const actor={ownerId:randomUUID(),scopeIds:[] as string[]}
 let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'源告警逐条跟进'})
 const scope=draft.scope
 const definition={format:'teloa.business-object-type/v1',id:type,version:'1.0.0',domain:scope,title:'源告警',unit:'条',lead:'源告警',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'alert_id',label:'告警身份',type:'text',required:true,from:'告警身份'},{name:'state',label:'状态',type:'text',required:true,from:'状态'}]}
 const mapping={format:'teloa.business-source-mapping/v1',id:mappingId,version:'1.0.0',domain:scope,title:'源告警同步',objectType:type,source:{kind:'mcp-tool',serverName:'soc-readonly',tool:'list',arguments:{},itemsPath:'$.items[*]'},mapping:[{path:'$.alert_id',field:'alert_id'},{path:'$.state',field:'state'}],primaryKey:['alert_id'],deletionSemantics:'compare',schedule:{kind:'every',seconds:60},acknowledgeShortInterval:false}
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition},{kind:'source-mapping',definition:mapping}],upsertPages:[{id:'home',title:'告警',kind:'records',objectType:type,fields:['alert_id','state'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'home'}})
 await apply.apply(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:(await preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt})
 actor.scopeIds=(await new api.BusinessScopeService(pool).list(actor.ownerId)).map(row=>row.scope)
 const warehouse=new api.BusinessWarehouseService(pool,identity)
 const state={items:[{alert_id:'wazuh/alerts/1',state:'new'},{alert_id:'malcolm/idx/2',state:'new'}] as Array<Record<string,string>>}
 const source={key:'fixture/soc-alerts',fetch:async()=>({capturedAt:identity.now(),items:state.items})}
 let events:WorkEventService
 const sync=new api.BusinessSyncService(pool,identity,definitions,warehouse,async()=>source,{sync:(db,owner,ref,version)=>events.appendBusinessSource(db,owner,ref,version),object:(db,owner,ref,version)=>events.appendBusinessSource(db,owner,ref,version)})
 const records=new api.BusinessRecordService(pool,identity,{definitions,warehouse,references:new api.BusinessSnapshotReferenceService(pool,identity)})
 const readSource=businessWorkSourceReader({records,sync})
 events=new WorkEventService(pool,identity,{material:unavailable,business:readSource})
 const owner=actor.ownerId,roles=new api.RoleService(pool,identity)
 let role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'源告警调查员',kind:'employee',scopes:[scope],duty:'核对本条源告警',dataScope:'本条固定快照',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'worker'}}})
 const lifecycle=new api.RoleLifecycleService(pool,identity);role=(await lifecycle.change(owner,{roleId:role.id,expectedVersion:role.version,action:'pause',reason:'本人核准工具'})).role
 const grant=await new api.RoleToolGrantService(pool,identity.now,async()=>{}).change(owner,{roleId:role.id,expectedRoleVersion:role.version,action:'save',rules:[{name:'get_goal',allowed:[{}]}]})
 role=(await lifecycle.change(owner,{roleId:role.id,expectedVersion:grant.roleVersion,action:'resume',reason:'已核工具'})).role
 await new api.RoleDelegationService(pool,identity,ownerAuthority).change(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,expectedVersion:null,action:'save',fields:{scope,allowedTools:['get_goal'],knowledgeIds:[],memoryViewId:null,groupIds:[],safeRecovery:false}})
 const plans=new api.PlanService(pool,identity,undefined,ownerAuthority,undefined,readSource)
 const createPlan=async(observedScope=scope)=>{
  const original=await plans.create(owner,{requestId:randomUUID(),fields:{title:'源告警逐条跟进',goal:'核对该条源告警并给出调查结论',scope,roleId:role.id,expectedRoleVersion:role.version,dataScope:'本条源告警固定快照',delivery:'调查结论',notificationPolicy:'attention',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}},source:{kind:'manual'}})
  const configuration={completion:{kind:'manual'},triggers:[{kind:'local-event',eventKind:'business-object-version',sourceRef:{kind:'business-object-type',scope:observedScope,type},coalesce:'latest'}],budget:{maxGoalRounds:32,maxTokens:20000,maxElapsedMs:600000,maxConcurrent:4,maxRetries:3,stagnationRounds:3,money:null},overlap:'independent',missed:'coalesce',safeRecovery:false}
  const configured=await plans.configureWorkConfirmed(owner,{requestId:randomUUID(),planId:original.id,expectedVersion:original.version,expectedConfigVersion:original.configVersion,configuration})
  return plans.changeConfirmed(owner,{requestId:randomUUID(),planId:original.id,expectedVersion:configured.version,action:'enable'})
 }
 const plan=await createPlan()
 const occurrences=new api.PlanOccurrenceService(pool,identity,undefined,(db,who,id)=>events.verifiedSourceInTransaction(db,who,id))
 const updates=new api.BusinessTaskSourceUpdateService(pool,identity)
 const businessTasks=new api.BusinessTaskService(pool,identity,new api.TaskService(pool,identity),{definitions,loads:{} as never,works:{read:unavailable,assertModelsReady:unavailable} as never})
 const syncOnce=()=>sync.run(actor,{scope,mappingId,trigger:'manual'})
 /** 常驻泵的领取与派发：逐条领取 pending 事件；返回新派发的任务。 */
 const claimAll=async()=>{const out:Awaited<ReturnType<typeof occurrences.dispatchTask>>[]=[];for(const row of await events.pending(owner)){const claim=await events.claim(owner,{planId:row.planId,definitionVersion:row.definitionVersion,eventId:row.event.id,controlGeneration:row.controlGeneration});if(claim)out.push(await occurrences.dispatchTask(owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:identity.now()}))}return out}
 const taskCount=async()=>(await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[owner])).rows[0].n as number
 const sourceOf=async(taskId:string)=>(await pool.query('select object_id,object_version from teloa_business_task_sources where owner_id=$1 and task_id=$2',[owner,taskId])).rows[0] as {object_id:string;object_version:number}
 const updateRows=async()=>(await pool.query('select id,task_id,state,reason,object_version,task_version,run_id from teloa_business_task_source_updates where owner_id=$1 order by created_at',[owner])).rows as Array<{id:string;task_id:string;state:string;reason:string|null;object_version:number;task_version:number|null;run_id:string|null}>
 /** 真实 TaskRunService：planContext 走计划领取复核，businessContext 走原生业务来源 + 账本 updates（与宿主装配同一口径）。 */
 const runner=async(taskId:string)=>{
  const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
  await new api.ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
  const runs=new api.TaskRunService(pool,identity,inspect,{allowedTools:['get_goal'],planContext:(db,who,id)=>occurrences.executionContext(db,who,id),businessContext:async(db,who,task)=>{const context=await businessTasks.executionContextInTransaction(db,{ownerId:who,scopeIds:[task.scope]},{taskId:task.id});if(!context)return undefined;const carried=await api.readBusinessTaskSourceUpdatesForRun(db,who,task.id,task.version);return {taskId:context.source.taskId,sourceId:context.source.sourceId,object:context.object,...(carried.length?{updates:carried}:{})}}})
  return {runs,sessionId,prepare:(version:number)=>runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1})}
 }
 return {owner,actor,scope,state,sync,syncOnce,events,records,plans,plan,createPlan,role,occurrences,updates,claimAll,taskCount,sourceOf,updateRows,runner}
}

test('两条源告警各自独立任务并固定原生业务来源；重复拉取相同内容不产生事件、不重开任务；目标不含告警正文',async()=>{
 const f=await fixture()
 const first=await f.syncOnce();assert.equal(first.status,'ok');assert.equal(first.upserted,2)
 assert.equal((await pool.query('select count(*)::int n from teloa_work_events where owner_id=$1',[f.owner])).rows[0].n,3,'两条对象事件 + 一条同步批次事件并存')
 assert.equal((await f.events.pending(f.owner)).length,2,'类型级订阅只排入两条对象事件；批次事件没有订阅者')
 const dispatched=await f.claimAll();assert.equal(dispatched.length,2);assert.equal(await f.taskCount(),2)
 const objects=new Set<string>()
 for(const item of dispatched){const source=await f.sourceOf(item.task.id);assert.ok(source,'任务带原生业务来源');assert.equal(source.object_version,1);objects.add(source.object_id);assert.equal(item.task.title,'源告警逐条跟进');assert.equal(item.task.goal,'核对该条源告警并给出调查结论','目标来自计划，不拼告警正文')}
 assert.equal(objects.size,2,'两条告警各自独立任务')
 const again=await f.syncOnce();assert.equal(again.upserted,0)
 assert.equal((await f.events.pending(f.owner)).length,0,'普通重叠拉取不是实质变化，不制造事件');assert.equal(await f.taskCount(),2)
 assert.deepEqual(await f.updateRows(),[])
})

test('同对象新版本：原 Run 未收口时记 pending 不新建任务；收口后同一任务续办新 Run，输入里原对象与 updates 分开冻结、原来源不改写',async()=>{
 const f=await fixture();await f.syncOnce();const dispatched=await f.claimAll()
 const target=dispatched[0]!,targetSource=await f.sourceOf(target.task.id)
 const r=await f.runner(target.task.id),run1=await r.prepare(1)
 const context1=JSON.parse(run1.inputText).businessContext
 assert.equal(context1.object.version,1);assert.equal(context1.updates,undefined)
 await r.runs.claim(f.owner,{runId:run1.id});await r.runs.record(f.owner,{runId:run1.id,sessionId:r.sessionId,nativeRequestId:run1.nativeRequestId,evidence:{state:'accepted'}})
 f.state.items=f.state.items.map(item=>item.alert_id===targetSource.object_id?{...item,state:'escalated'}:item)
 const changed=await f.syncOnce();assert.equal(changed.upserted,1)
 const pending=await f.events.pending(f.owner);assert.equal(pending.length,1)
 assert.equal(await f.events.claim(f.owner,{planId:pending[0]!.planId,definitionVersion:pending[0]!.definitionVersion,eventId:pending[0]!.event.id,controlGeneration:pending[0]!.controlGeneration}),null,'同对象后续版本不再领取为新任务')
 assert.equal(await f.taskCount(),2,'没有新任务冒充续办')
 const rows=await f.updateRows();assert.equal(rows.length,1);assert.deepEqual([rows[0]!.task_id,rows[0]!.state,rows[0]!.object_version],[target.task.id,'pending',2])
 assert.equal((await f.events.pending(f.owner)).length,0,'事件已定案到账本，不再待领取')
 assert.equal((await f.updates.continueTask(f.owner,rows[0]!.id)).state,'pending','原 Run 活动中只排队')
 await r.runs.executionAdmission(f.owner,run1.id)
 await r.runs.record(f.owner,{runId:run1.id,sessionId:r.sessionId,nativeRequestId:run1.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}})
 const settledVersion=(await pool.query('select version from teloa_tasks where owner_id=$1 and id=$2',[f.owner,target.task.id])).rows[0].version as number
 const continued=await f.updates.continueTask(f.owner,rows[0]!.id)
 assert.deepEqual([continued.state,continued.taskVersion,continued.taskId],['continued',settledVersion+1,target.task.id])
 assert.deepEqual((await pool.query('select version,state from teloa_tasks where owner_id=$1 and id=$2',[f.owner,target.task.id])).rows[0],{version:settledVersion+1,state:'ready'})
 const run2=await r.prepare(continued.taskVersion!),context2=JSON.parse(run2.inputText).businessContext
 assert.equal(context2.object.version,1,'原固定对象不被替换');assert.equal(context2.updates.length,1);assert.equal(context2.updates[0].version,2);assert.equal(context2.updates[0].fields.find((field:{label:string})=>field.label==='状态').value,'escalated')
 assert.equal(JSON.parse(run2.inputText).planContext.event.event.sourceVersion,'1','计划原事件原件不变')
 assert.deepEqual(await f.sourceOf(target.task.id),targetSource,'原来源行不改写')
 assert.equal((await f.updates.settle(f.owner,{id:rows[0]!.id,state:'continued',runId:run2.id,reason:null})).runId,run2.id)
 assert.equal((await f.updates.settle(f.owner,{id:rows[0]!.id,state:'accepted',runId:run2.id,reason:null})).state,'accepted')
 await assert.rejects(pool.query('delete from teloa_business_task_source_updates where owner_id=$1',[f.owner]),/immutable/)
 assert.equal(await f.taskCount(),2)
})

test('驱动路径：派生子请求身份经真实 TaskRunService 准备且幂等回到同一 Run；未受理不冒充 accepted；withdrawn 记 needs-user 保留原 Task/Run；暂停任务与停止的本轮控制不升版本；绑定 run_id 不可换',async()=>{
 const f=await fixture();await f.syncOnce();const dispatched=await f.claimAll()
 const target=dispatched[0]!,targetSource=await f.sourceOf(target.task.id),r=await f.runner(target.task.id),run1=await r.prepare(1)
 await r.runs.claim(f.owner,{runId:run1.id});await r.runs.record(f.owner,{runId:run1.id,sessionId:r.sessionId,nativeRequestId:run1.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}})
 const settledVersion=(await pool.query('select version from teloa_tasks where owner_id=$1 and id=$2',[f.owner,target.task.id])).rows[0].version as number
 f.state.items=f.state.items.map(item=>item.alert_id===targetSource.object_id?{...item,state:'escalated'}:item);await f.syncOnce()
 for(const row of await f.events.pending(f.owner))await f.events.claim(f.owner,{planId:row.planId,definitionVersion:row.definitionVersion,eventId:row.event.id,controlGeneration:row.controlGeneration})
 let [update]=await f.updateRows();assert.equal(update!.state,'pending')
 // 本人暂停任务：只排队，不改 ready、不升版本。
 await pool.query("update teloa_tasks set state='paused' where owner_id=$1 and id=$2",[f.owner,target.task.id])
 assert.equal((await f.updates.continueTask(f.owner,update!.id)).state,'pending')
 assert.deepEqual((await pool.query('select version,state from teloa_tasks where owner_id=$1 and id=$2',[f.owner,target.task.id])).rows[0],{version:settledVersion,state:'paused'})
 await pool.query("update teloa_tasks set state='waiting' where owner_id=$1 and id=$2",[f.owner,target.task.id])
 // 本任务的本轮工作控制已停止：needs-user，不升版本。
 const lineage=(await pool.query('select round_control_id from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[f.owner,target.task.id])).rows[0]
 assert.ok(lineage?.round_control_id,'计划领取的任务应有本轮工作控制')
 await pool.query("update teloa_work_controls set state='ended' where owner_id=$1 and id=$2",[f.owner,lineage.round_control_id])
 const stopped=await f.updates.continueTask(f.owner,update!.id);assert.deepEqual([stopped.state,stopped.reason],['needs-user','teloa/control-inactive'])
 assert.equal((await pool.query('select version from teloa_tasks where owner_id=$1 and id=$2',[f.owner,target.task.id])).rows[0].version,settledVersion)
 await pool.query("update teloa_work_controls set state='active' where owner_id=$1 and id=$2",[f.owner,lineage.round_control_id])
 // 同对象再来一版：新账本行按正常驱动路径续办。
 f.state.items=f.state.items.map(item=>item.alert_id===targetSource.object_id?{...item,state:'contained'}:item);await f.syncOnce()
 for(const row of await f.events.pending(f.owner))await f.events.claim(f.owner,{planId:row.planId,definitionVersion:row.definitionVersion,eventId:row.event.id,controlGeneration:row.controlGeneration})
 const rows=await f.updateRows();assert.equal(rows.length,2);update=rows[1]!;assert.deepEqual([update.state,update.object_version],['pending',3])
 const prepared:string[]=[],signal=AbortSignal.timeout(20000)
 const ports={
  updates:f.updates,
  // 真实 TaskRunService 准备：岗位/委托准入与一键准备同一服务路径；requestId 必须是账本派生的子请求身份。
  prepare:async(owner:string,input:{requestId:string;taskId:string;expectedTaskVersion:number})=>{prepared.push(input.requestId);const run=await r.runs.prepare(owner,{requestId:input.requestId,taskId:input.taskId,expectedTaskVersion:input.expectedTaskVersion,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:r.sessionId,expectedLinkVersion:1});return {runId:run.id}},
  // 不装配原生会话：start 只回报当前状态，不伪造受理。
  start:async(owner:string,runId:string)=>({state:(await r.runs.get(owner,{runId})).state}),
  readRun:async(owner:string,runId:string)=>{const run=await r.runs.get(owner,{runId});return {state:run.state,nativeRequestId:run.nativeRequestId}},
  reconcile:async(owner:string,runId:string)=>({state:(await r.runs.get(owner,{runId})).state}),
  report:()=>{},
 }
 await drainBusinessTaskSourceUpdates(f.owner,ports,signal)
 const expectedRequestId=workRequestChildId(update.id,'business-source-update-run')
 assert.deepEqual(prepared,[expectedRequestId]);assert.equal(api.businessTaskSourceUpdateRunRequestId(f.owner,update.id),expectedRequestId)
 let [,continued]=await f.updateRows()
 assert.deepEqual([continued!.state,continued!.task_version,continued!.reason],['continued',settledVersion+1,'teloa/execution-pending'],'只准备未受理：不记 accepted')
 const run2=(await pool.query('select request_id,state,task_version from teloa_task_runs where owner_id=$1 and id=$2',[f.owner,continued!.run_id])).rows[0]
 assert.deepEqual(run2,{request_id:expectedRequestId,state:'prepared',task_version:settledVersion+1},'续办 Run 以派生身份经真实准备落库')
 await drainBusinessTaskSourceUpdates(f.owner,ports,signal)
 assert.equal(prepared.length,1,'第二轮按已绑定 Run 身份核对，不再准备新 Run')
 await assert.rejects(pool.query('update teloa_business_task_source_updates set run_id=$3 where owner_id=$1 and id=$2',[f.owner,continued!.id,randomUUID()]),/immutable/,'已绑定 run_id 不可换')
 await assert.rejects(pool.query('update teloa_business_task_source_updates set object_version=99 where owner_id=$1 and id=$2',[f.owner,continued!.id]),/immutable/)
 // 原生未受理即撤回：保守 needs-user，保留原 Task 与 Run，不重建。
 await r.runs.withdraw(f.owner,{runId:continued!.run_id})
 await drainBusinessTaskSourceUpdates(f.owner,ports,signal)
 ;[,continued]=await f.updateRows()
 assert.deepEqual([continued!.state,continued!.reason,continued!.run_id],['needs-user','teloa/run-not-accepted',run2&&continued!.run_id])
 assert.equal(prepared.length,1);assert.equal(await f.taskCount(),2)
 assert.deepEqual(await f.sourceOf(target.task.id),targetSource,'原固定来源不改写')
})

test('只读消费者的裸构造 PlanOccurrenceService：live 缺宿主端口明确失败；stored 原件完整复核通过并保留固定事件身份；对象后续变化不改变原件结论',async()=>{
 const f=await fixture();await f.syncOnce();const dispatched=await f.claimAll();const target=dispatched[0]!,targetSource=await f.sourceOf(target.task.id)
 const bare=new api.PlanOccurrenceService(pool,identity),db=await pool.connect()
 try{
  await db.query('begin')
  await assert.rejects(bare.executionContext(db,f.owner,target.task.id),{code:'teloa/source-unavailable'},'没有宿主 verifyEvent 的 live 复核不能静默通过')
  const stored=await bare.executionContext(db,f.owner,target.task.id,undefined,false,'stored')
  assert.ok(stored?.event);assert.equal(stored.event.event.sourceVersion,'1');assert.equal(stored.occurrenceId,target.occurrence.id);assert.equal(stored.event.event.id,target.occurrence.event?.event.id)
  await db.query('rollback')
  // 对象实质变化后：原件仍完整，stored 复核照常通过；live 复核（真实宿主读口）按原口径判中间实质变更。
  f.state.items=f.state.items.map(item=>item.alert_id===targetSource.object_id?{...item,state:'escalated'}:item);await f.syncOnce()
  await db.query('begin')
  assert.equal((await bare.executionContext(db,f.owner,target.task.id,undefined,false,'stored'))?.event?.event.sourceVersion,'1')
  await assert.rejects(f.occurrences.executionContext(db,f.owner,target.task.id),{code:'teloa/version-conflict'})
  await db.query('rollback')
 }finally{db.release()}
 assert.equal(await f.taskCount(),2)
})

test('宿主重启暂停后本人原生恢复：原领取与事件不变，暂停期不执行，恢复收据对应当前世代后未运行任务可首次准备；单改世代无收据、暂停前在途无票据的 Run 仍拒绝',async()=>{
 const f=await fixture();await f.syncOnce();const dispatched=await f.claimAll();assert.equal(dispatched.length,2)
 const target=dispatched[0]!,definition=f.plan.workDefinition!,controlId=definition.definitionControlId
 const controls=new api.WorkControlService(pool,identity,{hostGeneration:()=>2,ownerAuthority:{authorize:async()=>({assertCurrent(){}})},inspectRun:async()=>({settled:true,unknownOperationIds:[]})})
 const claimGeneration=async()=>Number((await pool.query('select snapshot->\'event\'->>\'controlGeneration\' as g from teloa_plan_occurrences where id=$1',[target.occurrence.id])).rows[0].g)
 const verify=async()=>{const db=await pool.connect();try{await db.query('begin');return await f.occurrences.executionContext(db,f.owner,target.task.id)}finally{await db.query('rollback');db.release()}}
 assert.equal(await claimGeneration(),1);assert.ok(await verify(),'初始世代一致可复核')
 // 宿主重启：定义控制进入 pausing 并收口为 paused（世代 2）；暂停期间不能准备，领取与事件原件不变。
 const restarted=await controls.disarmForRestart(f.owner,{hostGeneration:2})
 for(const control of restarted)await controls.reconcile(f.owner,{controlId:control.id,generation:control.generation})
 const paused=await controls.get(f.owner,{controlId});assert.equal(paused.state,'paused');assert.equal(paused.generation,2)
 await assert.rejects(verify(),{code:'teloa/version-conflict'},'暂停中不执行')
 // 单改世代、无本人恢复收据：仍拒绝（只在临时库模拟坏状态，核对后还原）。
 await pool.query("update teloa_work_controls set state='active',generation=generation+1 where owner_id=$1 and id=$2",[f.owner,controlId])
 await assert.rejects(verify(),{code:'teloa/version-conflict'},'没有真实 resume 收据不放行')
 await pool.query("update teloa_work_controls set state='paused',generation=generation-1 where owner_id=$1 and id=$2",[f.owner,controlId])
 // 本人原生恢复（无候选 Run）：产生当前世代 3 的已确认收据。
 const recovery=new api.WorkRecoveryService(pool,identity,controls,{hostGeneration:()=>2,ownerAuthority:{authorize:async()=>({assertCurrent(){}})},inspectCheckpoint:async()=>{throw Error('无候选 Run，不应读取检查点')},authorizeResume:async()=>({assertCurrent(){}})})
 const current=await controls.get(f.owner,{controlId})
 const resumed=await recovery.resume(f.owner,{requestId:randomUUID(),controlId,expectedVersion:current.version,candidateRunIds:[]})
 assert.equal(resumed.state,'active');assert.equal(resumed.generation,3)
 assert.equal((await pool.query("select count(*)::int n from teloa_work_recovery_requests where owner_id=$1 and control_id=$2 and (result->>'generation')::int=3",[f.owner,controlId])).rows[0].n,1,'持久 resume 收据')
 assert.equal(await claimGeneration(),1,'旧事件/领取的 controlGeneration 不改写');assert.equal(await f.taskCount(),2,'不重建任务')
 assert.deepEqual((await pool.query('select version,state from teloa_tasks where owner_id=$1 and id=$2',[f.owner,target.task.id])).rows[0],{version:1,state:'ready'})
 const context=await verify();assert.ok(context?.event,'恢复后原领取可复核');assert.equal(context.event.controlGeneration,1)
 // 恢复后首次准备：真实 TaskRunService，Run 的谱系仍指向原定义控制，当前控制世代为 3。
 const r=await f.runner(target.task.id),run=await r.prepare(1)
 assert.equal(run.state,'prepared');assert.equal(JSON.parse(run.inputText).lineage.definitionControlId,controlId)
 assert.equal((await controls.get(f.owner,{controlId})).generation,3)
 assert.ok(await verify(),'恢复后创建的 Run 不影响同一领取继续复核')
 // 暂停前在途且无恢复票据的 Run：把该 Run 的创建时间挪到收据之前模拟，复核必须拒绝（不借收据重放）。
 await pool.query("update teloa_task_runs set created_at=created_at-interval '1 day' where owner_id=$1 and id=$2",[f.owner,run.id])
 await assert.rejects(verify(),{code:'teloa/version-conflict'},'在途无票据的旧 Run 需要本人恢复票据')
 await pool.query("update teloa_task_runs set created_at=created_at+interval '1 day' where owner_id=$1 and id=$2",[f.owner,run.id])
 assert.ok(await verify())
  // 已准备的旧 Run 必须随本次本人恢复明确列入候选，不能拿其他世代的票据代替。
  const active=await controls.get(f.owner,{controlId})
  const pausing=await controls.change(f.owner,{requestId:randomUUID(),controlId,expectedVersion:active.version,action:'pause',scope:'definition',roundControlId:null})
  await controls.reconcile(f.owner,{controlId,generation:pausing.generation})
  const recoveryWithRun=new api.WorkRecoveryService(pool,identity,controls,{hostGeneration:()=>2,ownerAuthority:{authorize:async()=>({assertCurrent(){}})},inspectCheckpoint:async()=>({reason:'unaccepted',checkpointSha256:'a'.repeat(64),hasPendingInput:true,unknownOperationIds:[]}),authorizeResume:async()=>({assertCurrent(){}})})
  const pausedAgain=await controls.get(f.owner,{controlId}),resumeRequest=randomUUID()
  await recoveryWithRun.resume(f.owner,{requestId:resumeRequest,controlId,expectedVersion:pausedAgain.version,candidateRunIds:[run.id]})
  assert.ok(await verify(),'本次明确恢复的原 Run 有对应票据')
  await pool.query("update teloa_work_recovery_tickets set state='unknown' where owner_id=$1 and request_id=$2 and run_id=$3",[f.owner,resumeRequest,run.id])
  await assert.rejects(verify(),{code:'teloa/execution-pending'},'当前恢复结果未知不能凭创建时间或旧票据继续派发')
})

test('保守路径：跨范围订阅拒绝；员工版本提高后续办记 needs-user 不升版本；无账本任务对旧版本事实严格复核且无写；计划暂停不领取新对象',async()=>{
 const f=await fixture();await f.syncOnce();const dispatched=await f.claimAll();assert.equal(dispatched.length,2)
 await assert.rejects(f.createPlan('OTHER'),{code:'teloa/forbidden'},'跨范围的类型级订阅不能配置')
 const target=dispatched[0]!,targetSource=await f.sourceOf(target.task.id),other=dispatched[1]!
 const r=await f.runner(target.task.id),run1=await r.prepare(1)
 await r.runs.claim(f.owner,{runId:run1.id});await r.runs.record(f.owner,{runId:run1.id,sessionId:r.sessionId,nativeRequestId:run1.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}})
 f.state.items=f.state.items.map(item=>item.alert_id===targetSource.object_id?{...item,state:'closed'}:item);await f.syncOnce()
 for(const row of await f.events.pending(f.owner))await f.events.claim(f.owner,{planId:row.planId,definitionVersion:row.definitionVersion,eventId:row.event.id,controlGeneration:row.controlGeneration})
 const [update]=await f.updateRows();assert.equal(update!.state,'pending')
 const beforeRefusalVersion=(await pool.query('select version from teloa_tasks where owner_id=$1 and id=$2',[f.owner,target.task.id])).rows[0].version as number
 await pool.query('update teloa_roles set version=version+1 where owner_id=$1 and id=$2',[f.owner,f.role.id])
 const refused=await f.updates.continueTask(f.owner,update!.id)
 assert.deepEqual([refused.state,refused.reason],['needs-user','teloa/version-conflict'])
 assert.equal((await pool.query('select version from teloa_tasks where owner_id=$1 and id=$2',[f.owner,target.task.id])).rows[0].version,beforeRefusalVersion,'不空升版本、不自动续签')
 await pool.query('update teloa_roles set version=version-1 where owner_id=$1 and id=$2',[f.owner,f.role.id])
 // 另一条告警实质变化但事件尚未领取：没有账本的任务对旧版本事实仍严格复核，复核失败不写任何记录。
 const otherSource=await f.sourceOf(other.task.id)
 f.state.items=f.state.items.map(item=>item.alert_id===otherSource.object_id?{...item,state:'changed'}:item);await f.syncOnce()
 const link=(await pool.query('select claim_id from teloa_plan_task_links where owner_id=$1 and task_id=$2',[f.owner,other.task.id])).rows[0]
 await assert.rejects(f.occurrences.revalidate(f.owner,{claimId:link.claim_id,taskRequestId:(await pool.query('select request_id from teloa_tasks where id=$1',[other.task.id])).rows[0].request_id}),{code:'teloa/version-conflict'})
 assert.equal((await f.updateRows()).length,1);assert.equal(await f.taskCount(),2)
 // 计划暂停后的新对象不领取、不建任务。
 await f.plans.changeConfirmed(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:(await f.plans.get(f.owner,{planId:f.plan.id})).version,action:'pause'})
 f.state.items=[...f.state.items,{alert_id:'wazuh/alerts/3',state:'new'}];await f.syncOnce()
 assert.equal((await f.events.pending(f.owner)).filter(row=>row.planId===f.plan.id).length,0,'暂停的计划不在待领取列表')
 assert.equal(await f.taskCount(),2)
})
