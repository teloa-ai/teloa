import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
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
import {createTaskRunHandler} from '../../harness-dsh/src/task-runs.ts'
import type {StoredConversation} from '../src/work/conversations.ts'
import {createProjectRuntimeAdapters} from '../../harness-dsh/src/project-runtime-adapters.ts'
import {taskRunReviewMaterial} from '../../harness-dsh/src/task-run-dsh.ts'
import {assertUnpublishedSourceFollowupEvents} from '../../harness-dsh/src/task-run-source-followup.ts'
import {createTaskRunApi} from '../../client/ui-workbench/src/client/task-run-api.ts'

let pool:Pool,container:StartedPostgreSqlContainer
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const unavailable=async():Promise<never>=>{throw Error('不得访问市场或远端')}
const ownerAuthority={authorize:async()=>({assertCurrent(){}})}
before(async()=>{
 const privateURL=process.env.TELOA_TEST_SOURCE_UPDATES_PG_URL
 if(privateURL){
  const url=new URL(privateURL);assert(['postgres:','postgresql:'].includes(url.protocol));assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'51125');assert(['/j095_source_error_recovery','/j095_source_error_recovery_140','/j095_unpublished_source_followup_144'].includes(url.pathname));assert.equal(url.search,'')
  pool=new Pool({connectionString:privateURL,max:4,connectionTimeoutMillis:5000,statement_timeout:15000})
 }else{
  process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
  process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
  container=await new PostgreSqlContainer('postgres:17-alpine').withPullPolicy({shouldPull:()=>false}).start()
  pool=new Pool({connectionString:container.getConnectionUri()})
 }
 await api.initializeTeloaDatabase(pool);await api.initializeBusinessSpaces(pool);await api.initializeBusinessDefinitions(pool);await api.initializeBusinessConfigurations(pool);await api.initializeBusinessRuntime(pool);await api.initializeBusinessData(pool);await api.initializeBusinessWarehouse(pool);await api.initializeBusinessSnapshotReferences(pool);await api.initializeBusinessSync(pool);await api.initializeBusinessRecords(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await stopTestContainer(container)})

const type='soc-source-alert',mappingId='soc-alert-sync'
/**
 * 真实链：配置草案（源告警对象类型 + 只读 MCP 映射）→ 本人确认员工委托 → 原已确认 Plan 类型级订阅 → 同步 → 逐对象事件 → 领取 → 任务（原生业务来源）→ Run。
 * 模型端口不装配；来源用固定夹具代替只读 MCP。
 */
async function fixture(options:{group?:boolean;now?:()=>string}={}){
 const clock={id:randomUUID,now:options.now??identity.now}
 const drafts=new api.BusinessConfigurationDraftService(pool,clock),store=new api.BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const runtime=new api.BusinessRuntimeService(pool,clock),spaces=new api.BusinessSpaceService(pool,clock)
 const apply=new api.BusinessConfigurationService(pool,clock,{drafts,store,definitions,runtime,spaces}),preview=new api.BusinessConfigurationPreviewService(pool,drafts,definitions,clock)
 const actor={ownerId:randomUUID(),scopeIds:[] as string[]}
 let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'源告警逐条跟进'})
 const scope=draft.scope
 const definition={format:'teloa.business-object-type/v1',id:type,version:'1.0.0',domain:scope,title:'源告警',unit:'条',lead:'源告警',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'alert_id',label:'告警身份',type:'text',required:true,from:'告警身份'},{name:'state',label:'状态',type:'text',required:true,from:'状态'}]}
 const mapping={format:'teloa.business-source-mapping/v1',id:mappingId,version:'1.0.0',domain:scope,title:'源告警同步',objectType:type,source:{kind:'mcp-tool',serverName:'soc-readonly',tool:'list',arguments:{},itemsPath:'$.items[*]'},mapping:[{path:'$.alert_id',field:'alert_id'},{path:'$.state',field:'state'}],primaryKey:['alert_id'],deletionSemantics:'compare',schedule:{kind:'every',seconds:60},acknowledgeShortInterval:false}
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition},{kind:'source-mapping',definition:mapping}],upsertPages:[{id:'home',title:'告警',kind:'records',objectType:type,fields:['alert_id','state'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'home'}})
 await apply.apply(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:(await preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt})
 actor.scopeIds=(await new api.BusinessScopeService(pool).list(actor.ownerId)).map(row=>row.scope)
 const warehouse=new api.BusinessWarehouseService(pool,clock)
 const state={items:[{alert_id:'wazuh/alerts/1',state:'new'},{alert_id:'malcolm/idx/2',state:'new'}] as Array<Record<string,string>>}
 const source={key:'fixture/soc-alerts',fetch:async()=>({capturedAt:clock.now(),items:state.items})}
 let events:WorkEventService
 const sync=new api.BusinessSyncService(pool,clock,definitions,warehouse,async()=>source,{sync:(db,owner,ref,version)=>events.appendBusinessSource(db,owner,ref,version),object:(db,owner,ref,version)=>events.appendBusinessSource(db,owner,ref,version)})
 const records=new api.BusinessRecordService(pool,clock,{definitions,warehouse,references:new api.BusinessSnapshotReferenceService(pool,clock)})
 const readSource=businessWorkSourceReader({records,sync})
 events=new WorkEventService(pool,clock,{material:unavailable,business:readSource})
 const owner=actor.ownerId,roles=new api.RoleService(pool,clock)
 let role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'源告警调查员',kind:'employee',scopes:[scope],duty:'核对本条源告警',dataScope:'本条固定快照',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'worker'}}})
 const lifecycle=new api.RoleLifecycleService(pool,clock);role=(await lifecycle.change(owner,{roleId:role.id,expectedVersion:role.version,action:'pause',reason:'本人核准工具'})).role
 const grant=await new api.RoleToolGrantService(pool,clock.now,async()=>{}).change(owner,{roleId:role.id,expectedRoleVersion:role.version,action:'save',rules:[{name:'get_goal',allowed:[{}]}]})
 role=(await lifecycle.change(owner,{roleId:role.id,expectedVersion:grant.roleVersion,action:'resume',reason:'已核工具'})).role
 const groups=new api.CollaborationService(pool,clock),grants=new api.GroupAgentGrantService(pool,clock.now)
 const group=options.group?await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'告警研判汇报群',scope,announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[role.id]}}):undefined
 if(group)await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:[],canPost:true,canAutoRun:true})
 await new api.RoleDelegationService(pool,clock,ownerAuthority).change(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,expectedVersion:null,action:'save',fields:{scope,allowedTools:['get_goal'],knowledgeIds:[],memoryViewId:null,groupIds:group?[group.id]:[],safeRecovery:false}})
 const plans=new api.PlanService(pool,clock,undefined,ownerAuthority,undefined,readSource)
 const createPlan=async(observedScope=scope)=>{
  const original=await plans.create(owner,{requestId:randomUUID(),fields:{...(group?{groupId:group.id}:{}),title:'源告警逐条跟进',goal:'核对该条源告警并给出调查结论',scope,roleId:role.id,expectedRoleVersion:role.version,dataScope:'本条源告警固定快照',delivery:'调查结论',notificationPolicy:'attention',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}},source:{kind:'manual'}})
  const configuration={completion:{kind:'manual'},triggers:[{kind:'local-event',eventKind:'business-object-version',sourceRef:{kind:'business-object-type',scope:observedScope,type},coalesce:'latest'}],budget:{maxGoalRounds:32,maxTokens:20000,maxElapsedMs:600000,maxConcurrent:4,maxRetries:3,stagnationRounds:3,money:null},overlap:'independent',missed:'coalesce',safeRecovery:false}
  const configured=await plans.configureWorkConfirmed(owner,{requestId:randomUUID(),planId:original.id,expectedVersion:original.version,expectedConfigVersion:original.configVersion,configuration})
  return plans.changeConfirmed(owner,{requestId:randomUUID(),planId:original.id,expectedVersion:configured.version,action:'enable'})
 }
 const plan=await createPlan()
 const occurrences=new api.PlanOccurrenceService(pool,clock,undefined,(db,who,id)=>events.verifiedSourceInTransaction(db,who,id))
 const updates=new api.BusinessTaskSourceUpdateService(pool,clock)
 const businessTasks=new api.BusinessTaskService(pool,clock,new api.TaskService(pool,clock),{definitions,loads:{} as never,works:{read:unavailable,assertModelsReady:unavailable} as never})
 const syncOnce=()=>sync.run(actor,{scope,mappingId,trigger:'manual'})
 /** 常驻泵的领取与派发：逐条领取 pending 事件；返回新派发的任务。 */
 const claimAll=async()=>{const out:Awaited<ReturnType<typeof occurrences.dispatchTask>>[]=[];for(const row of await events.pending(owner)){const claim=await events.claim(owner,{planId:row.planId,definitionVersion:row.definitionVersion,eventId:row.event.id,controlGeneration:row.controlGeneration});if(claim)out.push(await occurrences.dispatchTask(owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:clock.now()}))}return out}
 const taskCount=async()=>(await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[owner])).rows[0].n as number
 const sourceOf=async(taskId:string)=>(await pool.query('select object_id,object_version from teloa_business_task_sources where owner_id=$1 and task_id=$2',[owner,taskId])).rows[0] as {object_id:string;object_version:number}
 const updateRows=async()=>(await pool.query('select id,task_id,state,reason,object_version,task_version,run_id from teloa_business_task_source_updates where owner_id=$1 order by created_at',[owner])).rows as Array<{id:string;task_id:string;state:string;reason:string|null;object_version:number;task_version:number|null;run_id:string|null}>
 /** 真实 TaskRunService：planContext 走计划领取复核，businessContext 走原生业务来源 + 账本 updates（与宿主装配同一口径）。 */
 const runner=async(taskId:string)=>{
  const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
  await new api.ObjectConversationService(pool,inspect,clock.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
  const runs=new api.TaskRunService(pool,clock,inspect,{allowedTools:['get_goal'],planContext:(db,who,id,completion,includeMethodSource,singleOwner)=>occurrences.executionContext(db,who,id,completion,includeMethodSource,undefined,singleOwner),businessContext:async(db,who,task)=>{const context=await businessTasks.executionContextInTransaction(db,{ownerId:who,scopeIds:[task.scope]},{taskId:task.id});if(!context)return undefined;const carried=await api.readBusinessTaskSourceUpdatesForRun(db,who,task.id,task.version);return {taskId:context.source.taskId,sourceId:context.source.sourceId,object:context.object,...(carried.length?{updates:carried}:{})}}})
  return {runs,sessionId,prepare:(version:number)=>runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1})}
 }
 return {clock,group,groups,grants,owner,actor,scope,state,sync,syncOnce,events,records,plans,plan,createPlan,role,occurrences,updates,businessTasks,claimAll,taskCount,sourceOf,updateRows,runner}
}

test('本人真实 goal-only 编辑回执允许同告警续办，保留冻结计划目标并拒绝篡改或错配回执',async()=>{
 const f=await fixture();await f.syncOnce();const [target]=await f.claimAll();assert.ok(target)
 const source=await f.sourceOf(target.task.id),runner=await f.runner(target.task.id),first=await runner.prepare(1)
 await runner.runs.claim(f.owner,{runId:first.id})
 await runner.runs.record(f.owner,{runId:first.id,sessionId:first.sessionId,nativeRequestId:first.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}})
 const frozenFirst=await runner.runs.get(f.owner,{runId:first.id})
 const tasks=new api.TaskService(pool,identity),before=(await tasks.list(f.owner,{})).find(task=>task.id===target.task.id)!
 const edited=await tasks.edit(f.owner,{taskId:before.id,expectedVersion:before.version,fields:{goal:'核对当前固定告警v2并保留v1报告。'}})
 assert.equal(edited.contentVersion,2)
 const beforeUpdate=await pool.connect()
 try{await assert.rejects(f.occurrences.executionContext(beforeUpdate,f.owner,before.id),{code:'teloa/storage-corrupt'},'编辑回执本身不能替代正式来源更新账本')}finally{beforeUpdate.release()}
 f.state.items=f.state.items.map(item=>item.alert_id===source.object_id?{...item,state:'escalated'}:item);await f.syncOnce()
 for(const event of await f.events.pending(f.owner))await f.events.claim(f.owner,{planId:event.planId,definitionVersion:event.definitionVersion,eventId:event.event.id,controlGeneration:event.controlGeneration})
 const [update]=await f.updateRows();assert.ok(update)
 const continued=await f.updates.continueTask(f.owner,update.id);assert.equal(continued.state,'continued')
 const next=await runner.runs.prepare(f.owner,{requestId:api.businessTaskSourceUpdateRunRequestId(f.owner,update.id),taskId:before.id,expectedTaskVersion:continued.taskVersion,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:first.sessionId,expectedLinkVersion:1})
 const input=JSON.parse(next.inputText)
 assert.equal(input.task.goal,'核对当前固定告警v2并保留v1报告。')
 assert.equal(input.planContext.goal,'核对该条源告警并给出调查结论','计划领取原目标保持冻结，不冒充修改计划')
 assert.equal(input.planContext.goalEdit.goal,input.task.goal);assert.equal(input.planContext.goalEdit.taskContentVersion,2);assert.equal(input.planContext.goalEdit.editVersion,edited.version)
 assert.match(input.planContext.goalEdit.receiptSha256,/^[a-f0-9]{64}$/)
 const material=taskRunReviewMaterial(next);assert.ok(!('skip'in material));assert.equal(material.goal,input.task.goal)
 const view=(await createTaskRunApi(async()=>[next]).list(next.taskId))[0]!
 assert.equal(view.goal,input.task.goal);assert.equal(view.planContext?.goal,'核对该条源告警并给出调查结论');assert.deepEqual(view.planContext?.goalEdit,input.planContext.goalEdit)
 assert.equal(input.businessContext.object.version,1);assert.equal(input.businessContext.updates[0].version,2)
 assert.equal(next.taskId,first.taskId);assert.equal(next.sessionId,first.sessionId);assert.notEqual(next.nativeRequestId,first.nativeRequestId)
 assert.deepEqual(await runner.runs.get(f.owner,{runId:first.id}),frozenFirst)
 await runner.runs.claim(f.owner,{runId:next.id})
 await runner.runs.record(f.owner,{runId:next.id,sessionId:next.sessionId,nativeRequestId:next.nativeRequestId,evidence:{state:'ended',turn:2,messageSeq:3,endSeq:4,reason:'completed'}})
 const current=(await tasks.list(f.owner,{})).find(task=>task.id===before.id)!
 assert.ok(current.version>edited.version,'状态与来源流转可升任务版本，编辑内容版本仍固定')
 const frozenNext=await runner.runs.get(f.owner,{runId:next.id}),frozenText=frozenNext.inputText
 await pool.query("update teloa_task_runs set input_text=jsonb_set(input_text::jsonb,'{task,goal}','\"仅篡改执行目标\"')::text where id=$1",[next.id])
 try{await assert.rejects(runner.runs.get(f.owner,{runId:next.id}),{code:'teloa/storage-corrupt'})}finally{await pool.query('update teloa_task_runs set input_text=$2 where id=$1',[next.id,frozenText])}
 const client=await pool.connect()
 try{
  await client.query('begin')
  assert.equal((await f.occurrences.executionContext(client,f.owner,before.id))!.goal,'核对该条源告警并给出调查结论')
  await assert.rejects(f.occurrences.executionContext(client,'other-owner',before.id),{code:'teloa/forbidden'})
  const mutations=[
   ["update teloa_tasks set definition=jsonb_set(definition,'{goal}','\"SQL无回执目标\"') where id=$1",before.id],
   ["update teloa_tasks set definition=jsonb_set(definition,'{title}','\"越界更名\"') where id=$1",before.id],
   ["update teloa_tasks set definition=jsonb_set(definition,'{scope}','\"general\"') where id=$1",before.id],
   ["update teloa_tasks set request_spec=jsonb_set(request_spec,'{fields,goal}','\"篡改原领取\"') where id=$1",before.id],
   ['update teloa_tasks set content_version=content_version+1 where id=$1',before.id],
   ["update teloa_task_edits set result=jsonb_set(result,'{owner_id}','\"other-owner\"') where task_id=$1",before.id],
   ["update teloa_task_edits set request_spec=jsonb_set(request_spec,'{goal}','\"错配编辑回执\"') where task_id=$1",before.id],
   ["update teloa_plan_task_links set owner_id='other-owner' where task_id=$1",before.id],
  ] as const
  for(const [sql,id] of mutations){await client.query('savepoint bad_edit');await client.query(sql,[id]);await assert.rejects(f.occurrences.executionContext(client,f.owner,before.id),{code:'teloa/storage-corrupt'});await client.query('rollback to savepoint bad_edit')}
  await client.query('rollback')
 }finally{await client.query('rollback');client.release()}
 await tasks.edit(f.owner,{taskId:current.id,expectedVersion:current.version,fields:{goal:'后续本人目标v3'}})
 assert.deepEqual(await runner.runs.get(f.owner,{runId:next.id}),frozenNext,'未来再编辑不改变旧Run的冻结依据或可读性')
 assert.deepEqual(await runner.runs.get(f.owner,{runId:first.id}),frozenFirst,'无编辑依据的旧v1行仍可读')
})

/** 复用正式暂停/本人恢复/启用顺序；临时PG中的冷检查端口不冒充原生日志证明。 */
async function ownerResumePlan(f:Awaited<ReturnType<typeof fixture>>,hostGeneration:number){
 const controlId=f.plan.workDefinition!.definitionControlId
 const controls=new api.WorkControlService(pool,f.clock,{hostGeneration:()=>hostGeneration,ownerAuthority,inspectRun:async()=>({settled:true,unknownOperationIds:[]})})
 const recovery=new api.WorkRecoveryService(pool,f.clock,controls,{hostGeneration:()=>hostGeneration,ownerAuthority,inspectCheckpoint:async()=>{throw Error('空候选不得恢复旧请求')},authorizeResume:async()=>({assertCurrent(){}})})
 const current=await f.plans.get(f.owner,{planId:f.plan.id})
 const pausedPlan=await f.plans.change(f.owner,{requestId:randomUUID(),planId:current.id,expectedVersion:current.version,action:'pause'})
 for(const control of await controls.disarmForRestart(f.owner,{hostGeneration}))await controls.reconcile(f.owner,{controlId:control.id,generation:control.generation})
 const paused=await controls.get(f.owner,{controlId}),requestId=randomUUID()
 assert.deepEqual(await recovery.inspect(f.owner,{controlId}),[])
 await recovery.resume(f.owner,{requestId,controlId,expectedVersion:paused.version,candidateRunIds:[]})
 const active=await f.plans.changeConfirmed(f.owner,{requestId:randomUUID(),planId:current.id,expectedVersion:pausedPlan.version,action:'enable'})
 assert.equal(active.configVersion,current.configVersion)
 return {controls,recovery,requestId,active}
}

async function disposedUnknownForResumption(){
 const f=await fixture();await f.syncOnce();const task=(await f.claimAll())[0]!.task,source=await f.sourceOf(task.id),r=await f.runner(task.id)
 const finish=async(run:api.TaskRun,turn:number)=>{await r.runs.claim(f.owner,{runId:run.id});return r.runs.record(f.owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn,messageSeq:turn*2-1,endSeq:turn*2,reason:'completed'}})}
 await finish(await r.prepare(1),1)
 let last:api.TaskRun|undefined,u:Awaited<ReturnType<typeof f.updates.continueTask>>|undefined
 for(const version of [2,3]){
  f.state.items=f.state.items.map(item=>item.alert_id===source.object_id?{...item,state:'v'+version}:item);await f.syncOnce();await f.claimAll()
  const pending=(await f.updates.pending(f.owner)).find(item=>item.reference.version===version)!
  u=await f.updates.continueTask(f.owner,pending.id)
  last=await r.runs.prepare(f.owner,{requestId:api.businessTaskSourceUpdateRunRequestId(f.owner,u.id),taskId:task.id,expectedTaskVersion:u.taskVersion!,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:r.sessionId,expectedLinkVersion:1})
  await f.updates.settle(f.owner,{id:u.id,state:'continued',runId:last.id,reason:null})
  if(version===2){await finish(last,2);await f.updates.settle(f.owner,{id:u.id,state:'accepted',runId:last.id,reason:null})}
 }
 const unknown=last!,update=u!;await r.runs.claim(f.owner,{runId:unknown.id})
 const runtimeId=randomUUID();await new api.TaskRunRuntimeLinkService(pool).put(f.owner,{runId:unknown.id,sessionId:unknown.sessionId,kind:'job',nativeId:'owner:'+runtimeId+':'+unknown.sessionId,payload:{record:'owner',runtimeId,requestId:unknown.nativeRequestId}})
 await r.runs.requestStop(f.owner,{runId:unknown.id})
 await new api.TaskRunSubmissionService(pool).disposeUnknown(f.owner,{requestId:randomUUID(),runId:unknown.id,acknowledgeUnknown:true},r.runs,{runId:unknown.id,sessionId:unknown.sessionId,nativeRequestId:unknown.nativeRequestId,inputSha256:createHash('sha256').update(unknown.inputText).digest('hex'),runtimeId,logCut:-1,logSha256:createHash('sha256').update('[]').digest('hex'),assertCurrent(){}})
 await f.updates.settle(f.owner,{id:update.id,state:'needs-user',runId:unknown.id,reason:'teloa/submission-unknown'})
 const budgets=new api.WorkBudgetService(pool,f.clock,ownerAuthority),reservation=await budgets.reserve(f.owner,{budgetAccountId:unknown.lineage!.budgetAccountId,controlGeneration:1,modelRequestId:'unknown:'+unknown.id,kind:'retry',tokens:50,rounds:0})
 await budgets.markDispatched(f.owner,{reservationId:reservation.id})
 const handler=createTaskRunHandler(f.owner,async()=>r.runs,{resolvePreset:async p=>p!,inspectSourceFollowup:async()=>{},check:async()=>{throw Error('不得warm')},send:async()=>{throw Error('不得调用模型')},stop:async()=>{},events:async()=>[]},undefined,{conversations:{} as never,links:{} as never,admitRun:(db,who,lineage)=>budgets.admitRunStartInTransaction(db,who,lineage.budgetAccountId)})
 return {f,task,source,r,unknown,update,budgets,reservation,handler,finish}
}

test('A2多世代恢复后新本人F1完成，再次同告警普通续报可执行且旧unknown和预算不变',{timeout:60000},async()=>{
 const {f,task,source,r,unknown,update,reservation,handler,finish}=await disposedUnknownForResumption()
 const beforeRuns=(await pool.query('select * from teloa_task_runs where owner_id=$1 and task_id=$2 order by id',[f.owner,task.id])).rows
 const beforeUpdates=(await pool.query('select * from teloa_business_task_source_updates where owner_id=$1 and task_id=$2 order by id',[f.owner,task.id])).rows,beforeBudget=(await pool.query('select * from teloa_work_budget_reservations where id=$1',[reservation.id])).rows[0]
 await ownerResumePlan(f,2);const recovery=await ownerResumePlan(f,3)
 const version=(await pool.query('select version from teloa_tasks where id=$1',[task.id])).rows[0].version
 await assert.rejects(r.prepare(version),{code:'teloa/conflict'},'普通prepare不能绕过原未知提交专用闸')
 assert.equal((await r.runs.claim(f.owner,{runId:unknown.id})).dispatch,false)
 await assert.rejects(recovery.recovery.begin(f.owner,{requestId:recovery.requestId,runId:unknown.id}),{code:'teloa/forbidden'},'空候选没有原unknown恢复票据')
 const candidate=await handler('task-runs/source-followup/get',{runId:unknown.id},AbortSignal.timeout(10000)) as import('@teloa/contract').TaskRunSourceFollowupCandidate
 const command={kind:'unknown-verification',requestId:randomUUID(),runId:unknown.id,expectedTaskVersion:candidate.expectedTaskVersion,dispositionRequestId:candidate.disposition!.requestId,sourceUpdateId:update.id,acknowledgeUnknown:true,instruction:'只核实当前证据，保留旧未知结果，不重做此前动作。'}
 const next=await handler('task-runs/source-followup/prepare',command,AbortSignal.timeout(10000)) as api.TaskRun
 assert.equal(next.sessionId,unknown.sessionId);assert.notEqual(next.nativeRequestId,unknown.nativeRequestId)
 await assert.rejects(handler('task-runs/source-followup/get',{runId:unknown.id},AbortSignal.timeout(10000)),{code:'teloa/conflict'},'同一任务已有在途F1，不接受针对旧unknown的新确认')
 await assert.rejects(handler('task-runs/source-followup/prepare',{...command,requestId:randomUUID()},AbortSignal.timeout(10000)),{code:'teloa/conflict'})
 await finish(next,3)
 f.state.items=f.state.items.map(item=>item.alert_id===source.object_id?{...item,state:'v4-after-confirmed-F1'}:item);await f.syncOnce();await f.claimAll()
 const pending=(await f.updates.pending(f.owner)).find(item=>item.reference.version===4)!,u4=await f.updates.continueTask(f.owner,pending.id)
 assert.equal(u4.state,'continued')
 const fourth=await r.runs.prepare(f.owner,{requestId:api.businessTaskSourceUpdateRunRequestId(f.owner,u4.id),taskId:task.id,expectedTaskVersion:u4.taskVersion!,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:unknown.sessionId,expectedLinkVersion:unknown.linkVersion})
 await f.updates.settle(f.owner,{id:u4.id,state:'continued',runId:fourth.id,reason:null});await finish(fourth,4)
 assert.equal(fourth.sessionId,unknown.sessionId);assert.equal(JSON.parse(fourth.inputText).businessContext.updates.at(-1).version,4)
 assert.equal((await r.runs.sessionRun(f.owner,{sessionId:unknown.sessionId}))?.id,fourth.id)
 assert.deepEqual((await pool.query('select * from teloa_task_runs where id=any($1::uuid[]) order by id',[beforeRuns.map(row=>row.id)])).rows,beforeRuns)
 assert.deepEqual((await pool.query('select * from teloa_business_task_source_updates where id=any($1::uuid[]) order by id',[beforeUpdates.map(row=>row.id)])).rows,beforeUpdates)
 assert.deepEqual((await pool.query('select * from teloa_work_budget_reservations where id=$1',[reservation.id])).rows[0],beforeBudget)
})

test('仅ended历史按正常UI先恢复控制后启用计划可继续，旧paused收据不能覆盖再次启用',{timeout:30000},async()=>{
 const f=await fixture();await f.syncOnce();const task=(await f.claimAll())[0]!.task,r=await f.runner(task.id),first=await r.prepare(1)
 await r.runs.claim(f.owner,{runId:first.id});await r.runs.record(f.owner,{runId:first.id,sessionId:first.sessionId,nativeRequestId:first.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}})
 const original=(await pool.query('select * from teloa_task_runs where id=$1',[first.id])).rows[0]
 const resumed=await ownerResumePlan(f,2),db=await pool.connect()
 try{assert.ok(await f.occurrences.executionContext(db,f.owner,task.id))}finally{db.release()}
 const paused=await f.plans.change(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:resumed.active.version,action:'pause'})
 await f.plans.changeConfirmed(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:paused.version,action:'enable'})
 const check=await pool.connect();try{await assert.rejects(f.occurrences.executionContext(check,f.owner,task.id),{code:'teloa/version-conflict'})}finally{check.release()}
 assert.deepEqual((await pool.query('select * from teloa_task_runs where id=$1',[first.id])).rows[0],original)
})

test('未知处置后本人新确认沿原告警会话核验，原Run/update/预算不变，并发与claim严格核对',{timeout:30000},async()=>{
 const f=await fixture();await f.syncOnce();const dispatched=await f.claimAll(),task=dispatched[0]!.task,source=await f.sourceOf(task.id),r=await f.runner(task.id)
 const first=await r.prepare(1)
 await r.runs.claim(f.owner,{runId:first.id});await r.runs.record(f.owner,{runId:first.id,sessionId:first.sessionId,nativeRequestId:first.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}})
 f.state.items=f.state.items.map(item=>item.alert_id===source.object_id?{...item,state:'escalated'}:item);await f.syncOnce();await f.claimAll()
 const u=await f.updates.continueTask(f.owner,(await f.updateRows())[0]!.id)
 const a2=await r.runs.prepare(f.owner,{requestId:api.businessTaskSourceUpdateRunRequestId(f.owner,u.id),taskId:task.id,expectedTaskVersion:u.taskVersion!,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:first.sessionId,expectedLinkVersion:first.linkVersion})
 await f.updates.settle(f.owner,{id:u.id,state:'continued',runId:a2.id,reason:null});await r.runs.claim(f.owner,{runId:a2.id})
 const runtimeId=randomUUID(),runtime=new api.TaskRunRuntimeLinkService(pool)
 await runtime.put(f.owner,{runId:a2.id,sessionId:a2.sessionId,kind:'job',nativeId:'owner:'+runtimeId+':'+a2.sessionId,payload:{record:'owner',runtimeId,requestId:a2.nativeRequestId}})
 await r.runs.requestStop(f.owner,{runId:a2.id})
 await new api.TaskRunSubmissionService(pool).disposeUnknown(f.owner,{requestId:randomUUID(),runId:a2.id,acknowledgeUnknown:true},r.runs,{runId:a2.id,sessionId:a2.sessionId,nativeRequestId:a2.nativeRequestId,inputSha256:createHash('sha256').update(a2.inputText).digest('hex'),runtimeId,logCut:-1,logSha256:createHash('sha256').update('[]').digest('hex'),assertCurrent(){}})
 await f.updates.settle(f.owner,{id:u.id,state:'needs-user',runId:a2.id,reason:'teloa/submission-unknown'})
 assert.equal((await r.runs.sessionRun(f.owner,{sessionId:a2.sessionId}))?.id,a2.id,'needs-user不能破坏A1到A2历史归属')
 const unknown=await r.runs.get(f.owner,{runId:a2.id}),beforeRun=(await pool.query('select * from teloa_task_runs where id=$1',[a2.id])).rows[0],beforeUpdate=await f.updateRows(),beforeTask=(await pool.query("select definition->>'goal' as goal,version,state from teloa_tasks where id=$1",[task.id])).rows[0]
 await assert.rejects(r.prepare(beforeTask.version),{code:'teloa/conflict'},'普通prepare不能绕去新Session')
 const budgets=new api.WorkBudgetService(pool,identity,ownerAuthority),account=unknown.lineage!.budgetAccountId
 const reserved=await budgets.reserve(f.owner,{budgetAccountId:account,controlGeneration:1,modelRequestId:'unknown-model:'+a2.id,kind:'retry',tokens:50,rounds:0});await budgets.markDispatched(f.owner,{reservationId:reserved.id})
 const beforeBudget=(await pool.query('select * from teloa_work_budget_reservations where id=$1',[reserved.id])).rows[0]
 let cold=0,warm=0
 const handler=createTaskRunHandler(f.owner,async()=>r.runs,{resolvePreset:async p=>p!,inspectSourceFollowup:async original=>{cold++;assert.equal(original.id,a2.id)},check:async()=>{warm++;throw Error('prepare不得warm')},prepareSession:async()=>{warm++;throw Error('prepare不得创建Session')},send:async()=>{throw Error('本测试不发送模型')},stop:async()=>{},events:async()=>[]},undefined,{conversations:{} as never,links:{} as never,admitRun:(db,who,lineage)=>budgets.admitRunStartInTransaction(db,who,lineage.budgetAccountId)})
 const candidate=await handler('task-runs/source-followup/get',{runId:a2.id},AbortSignal.timeout(10000)) as import('@teloa/contract').TaskRunSourceFollowupCandidate
 const command={kind:'unknown-verification',requestId:randomUUID(),runId:a2.id,expectedTaskVersion:candidate.expectedTaskVersion,dispositionRequestId:candidate.disposition!.requestId,sourceUpdateId:u.id,acknowledgeUnknown:true,instruction:'仅核查最新证据，不重做此前可能执行的动作。'}
 const budget=await budgets.read(f.owner,{budgetAccountId:account});await budgets.configure(f.owner,{requestId:randomUUID(),budgetAccountId:account,expectedVersion:budget.version,policy:{...budget.policy,maxConcurrent:1}})
 await assert.rejects(handler('task-runs/source-followup/prepare',command,AbortSignal.timeout(10000)),{code:'teloa/budget-exhausted'})
 assert.equal((await r.runs.list(f.owner,{taskId:task.id})).length,2)
 const limit=await budgets.read(f.owner,{budgetAccountId:account});await budgets.configure(f.owner,{requestId:randomUUID(),budgetAccountId:account,expectedVersion:limit.version,policy:{...limit.policy,maxConcurrent:2}})
 const parallel=await Promise.all([handler('task-runs/source-followup/prepare',command,AbortSignal.timeout(10000)),handler('task-runs/source-followup/prepare',command,AbortSignal.timeout(10000))]) as api.TaskRun[];const prepared=parallel[0]!;assert.equal(parallel[1]!.id,prepared.id,'并发同一确认只生成同一Run，host confirmedAt差异不改变本人意图')
 assert.equal(warm,0);assert.ok(cold>=2);assert.equal(prepared.state,'prepared');assert.equal(prepared.sessionId,a2.sessionId);assert.notEqual(prepared.nativeRequestId,a2.nativeRequestId);assert.equal(prepared.sourceFollowup?.instruction,command.instruction)
 assert.equal(JSON.parse(prepared.inputText).businessContext.updates.length,1);assert.equal(JSON.parse(prepared.inputText).businessContext.updates[0].version,2)
 assert.equal((await handler('task-runs/source-followup/prepare',command,AbortSignal.timeout(10000)) as api.TaskRun).id,prepared.id)
 await assert.rejects(handler('task-runs/source-followup/prepare',{...command,instruction:'换正文'},AbortSignal.timeout(10000)),{code:'teloa/conflict'})
 await assert.rejects(handler('task-runs/source-followup/prepare',{...command,requestId:randomUUID()},AbortSignal.timeout(10000)),{code:'teloa/conflict'})
 assert.equal((await r.runs.sessionRun(f.owner,{sessionId:a2.sessionId}))?.id,prepared.id)
 await assert.rejects(pool.query('update teloa_task_run_source_followups set binding=$2::jsonb where run_id=$1',[prepared.id,'{}']),/immutable/)
 const originalPreparedInput=prepared.inputText,tampered=JSON.parse(prepared.inputText);tampered.sourceFollowup.instruction='伪造正文'
 await pool.query('update teloa_task_runs set input_text=$2 where id=$1',[prepared.id,JSON.stringify(tampered)])
 await assert.rejects(r.runs.claim(f.owner,{runId:prepared.id}),{code:'teloa/storage-corrupt'})
 await pool.query('update teloa_task_runs set input_text=$2 where id=$1',[prepared.id,originalPreparedInput])
 const claimed=await r.runs.claim(f.owner,{runId:prepared.id});assert.equal(claimed.dispatch,true)
 assert.deepEqual((await pool.query('select * from teloa_task_runs where id=$1',[a2.id])).rows[0],beforeRun)
 assert.deepEqual(await f.updateRows(),beforeUpdate);assert.deepEqual((await pool.query('select * from teloa_work_budget_reservations where id=$1',[reserved.id])).rows[0],beforeBudget)
 assert.equal((await pool.query("select definition->>'goal' as goal from teloa_tasks where id=$1",[task.id])).rows[0].goal,beforeTask.goal)
 await r.runs.record(f.owner,{runId:prepared.id,sessionId:prepared.sessionId,nativeRequestId:prepared.nativeRequestId,evidence:{state:'ended',turn:2,messageSeq:3,endSeq:4,reason:'completed'}})
 f.state.items=f.state.items.map(item=>item.alert_id===source.object_id?{...item,state:'v3-followup'}:item);await f.syncOnce();await f.claimAll()
 const pending3=(await f.updates.pending(f.owner)).find(item=>item.reference.version===3)!,u3=await f.updates.continueTask(f.owner,pending3.id)
 const third=await r.runs.prepare(f.owner,{requestId:api.businessTaskSourceUpdateRunRequestId(f.owner,u3.id),taskId:task.id,expectedTaskVersion:u3.taskVersion!,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:a2.sessionId,expectedLinkVersion:a2.linkVersion})
 await f.updates.settle(f.owner,{id:u3.id,state:'continued',runId:third.id,reason:null})
 assert.equal(third.sessionId,a2.sessionId);assert.equal((await r.runs.sessionRun(f.owner,{sessionId:a2.sessionId}))?.id,third.id,'F1完成后v3事件仍能沿全部历史同源边正常续办')
 assert.equal((await f.updates.get(f.owner,u.id)).state,'needs-user');assert.deepEqual((await pool.query('select * from teloa_work_budget_reservations where id=$1',[reserved.id])).rows[0],beforeBudget)
})

for(const originalCase of ['completed','error','error-recovery-chain','unpublished-recovery','unpublished-recovery-own-unknown'] as const)test('原终态显式续办完成后仍同SID继续新来源：'+originalCase,{timeout:30000},async()=>{
 const unpublished=originalCase.startsWith('unpublished-recovery'),originalReason=originalCase==='completed'?'completed':'error'
 const f=await fixture();await f.syncOnce();const task=(await f.claimAll())[0]!.task,source=await f.sourceOf(task.id),r=await f.runner(task.id),a1=await r.prepare(1)
 await r.runs.claim(f.owner,{runId:a1.id});await r.runs.record(f.owner,{runId:a1.id,sessionId:a1.sessionId,nativeRequestId:a1.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}})
 const originalPrefix=[{seq:0,type:'turn/start',time:1,data:{turn:1}},{seq:1,type:'user/message',time:2,data:{source:{kind:'user',rpcId:a1.nativeRequestId},content:[{type:'text',text:a1.inputText}]}},{seq:2,type:'turn/end',time:3,data:{turn:1,reason:{kind:'completed'}}}]
 f.state.items=f.state.items.map(item=>item.alert_id===source.object_id?{...item,state:'v2-result'}:item);await f.syncOnce();await f.claimAll()
 const u=await f.updates.continueTask(f.owner,(await f.updateRows())[0]!.id)
 const a2=await r.runs.prepare(f.owner,{requestId:api.businessTaskSourceUpdateRunRequestId(f.owner,u.id),taskId:task.id,expectedTaskVersion:u.taskVersion!,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:a1.sessionId,expectedLinkVersion:a1.linkVersion})
 await f.updates.settle(f.owner,{id:u.id,state:'continued',runId:a2.id,reason:null});await r.runs.claim(f.owner,{runId:a2.id})
 if(unpublished){
  const journal=new api.TaskRunSubmissionService(pool),claimed=await r.runs.get(f.owner,{runId:a2.id}),runtimeId=randomUUID(),attempt=await journal.begin(f.owner,claimed,runtimeId)
  await new api.TaskRunRuntimeLinkService(pool).put(f.owner,{runId:a2.id,kind:'job',nativeId:'owner:'+runtimeId+':'+a2.sessionId,sessionId:a2.sessionId,payload:{record:'owner',runtimeId,requestId:a2.nativeRequestId}})
  await journal.finish(f.owner,attempt,'not-published');const stopping=await r.runs.requestStop(f.owner,{runId:a2.id})
  await journal.cancelNotPublished(f.owner,{requestId:randomUUID(),runId:a2.id,confirmNotPublished:true},r.runs,{runId:a2.id,sessionId:a2.sessionId,nativeRequestId:a2.nativeRequestId,inputSha256:createHash('sha256').update(a2.inputText).digest('hex'),runtimeId,notPublished:true,logCut:2,logSha256:createHash('sha256').update(JSON.stringify(originalPrefix)).digest('hex'),assertCurrent(){assert(stopping.stopRequestedAt)}})
  await f.updates.settle(f.owner,{id:u.id,state:'needs-user',runId:a2.id,reason:'teloa/run-not-accepted'})
 }else{
  await f.updates.settle(f.owner,{id:u.id,state:'accepted',runId:a2.id,reason:null})
  await r.runs.record(f.owner,{runId:a2.id,sessionId:a2.sessionId,nativeRequestId:a2.nativeRequestId,evidence:{state:'ended',turn:2,messageSeq:3,endSeq:4,reason:originalReason}})
 }
 const before=(await pool.query('select * from teloa_task_runs where id=$1',[a2.id])).rows[0],beforeUpdate=await f.updateRows(),state=(await pool.query('select version,state from teloa_tasks where id=$1',[task.id])).rows[0]
 assert.equal(state.state,unpublished?'paused':originalReason==='error'?'blocked':'waiting');if(originalReason==='completed')await assert.rejects(r.prepare(state.version),{code:'teloa/conflict'})
 const budgets=new api.WorkBudgetService(pool,identity,ownerAuthority),handler=createTaskRunHandler(f.owner,async()=>r.runs,{resolvePreset:async p=>p!,inspectSourceFollowup:async()=>{},check:async()=>{throw Error('prepare不得warm')},send:async()=>{throw Error('不得发送')},stop:async()=>{},events:async()=>[]},undefined,{conversations:{} as never,links:{} as never,admitRun:(db,who,lineage)=>budgets.admitRunStartInTransaction(db,who,lineage.budgetAccountId)})
 const candidate=await handler('task-runs/source-followup/get',{runId:a2.id},AbortSignal.timeout(10000)) as import('@teloa/contract').TaskRunSourceFollowupCandidate
 assert.equal(candidate.kind,originalReason==='error'?'error-recovery':'result-verification');assert.equal(candidate.disposition,undefined)
 if(unpublished){const cancelled=await r.runs.get(f.owner,{runId:a2.id});assert.equal(cancelled.state,'withdrawn');assert.equal(cancelled.evidence,null);assert.notEqual(candidate.originalEvidenceSha256,createHash('sha256').update('null').digest('hex'),'typed取消证明必须分域，不能伪造原生error evidence')}
 const command={kind:candidate.kind,requestId:randomUUID(),runId:a2.id,expectedTaskVersion:candidate.expectedTaskVersion,sourceUpdateId:u.id,instruction:'核对固定v2来源并重新保存成果；保留原执行回执。'}
 if(unpublished){
  const count=(await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1 and task_id=$2',[f.owner,task.id])).rows[0].n
  await assert.rejects(handler('task-runs/source-followup/prepare',{...command,requestId:randomUUID(),expectedTaskVersion:candidate.expectedTaskVersion-1},AbortSignal.timeout(10000)),{code:'teloa/conflict'},'旧Task CAS不得准备新请求')
  assert.equal((await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1 and task_id=$2',[f.owner,task.id])).rows[0].n,count)
  await assert.rejects(r.runs.sourceFollowupTarget(randomUUID(),{runId:a2.id}),{code:'teloa/forbidden'},'其他owner不可消费同形取消证明')
 }
 let prepared=await handler('task-runs/source-followup/prepare',command,AbortSignal.timeout(10000)) as api.TaskRun
 assert.equal(prepared.state,'prepared');assert.equal(prepared.sessionId,a2.sessionId);assert.notEqual(prepared.nativeRequestId,a2.nativeRequestId)
 assert.equal((await pool.query('select state from teloa_tasks where id=$1',[task.id])).rows[0].state,state.state,'准备不得偷偷修改原Task状态')
 assert.equal((await handler('task-runs/source-followup/prepare',command,AbortSignal.timeout(10000)) as api.TaskRun).id,prepared.id)
 if(unpublished)await assert.rejects(handler('task-runs/source-followup/prepare',{...command,requestId:randomUUID()},AbortSignal.timeout(10000)),{code:'teloa/conflict'},'一个取消原Run不能并列产生两笔新确认')
 const claimed=await r.runs.claim(f.owner,{runId:prepared.id});assert.equal(claimed.dispatch,true)
 if(unpublished){
  for(const evidence of [{state:'accepted'},{state:'active',turn:2,messageSeq:3}] as const){
   await r.runs.record(f.owner,{runId:prepared.id,sessionId:prepared.sessionId,nativeRequestId:prepared.nativeRequestId,evidence})
   const original=await r.runs.sourceFollowupForRun(f.owner,{runId:prepared.id});assert(original);assert.equal(original.id,a2.id);assert.equal(original.state,'withdrawn');assert.equal(original.evidence,null)
   assert.equal(api.sourceFollowupUnpublishedProof(original)?.sha256,candidate.originalEvidenceSha256,'accepted/active内部read新对象必须带真实历史proof')
   assertUnpublishedSourceFollowupEvents(original,originalPrefix as never)
  }
 }

 if(unpublished){
  const operationId='followup-model:'+prepared.id,controls=new api.WorkControlService(pool,identity)
  let ownReservation:Awaited<ReturnType<typeof budgets.reserve>>|undefined
  const retries=new api.WorkRetryService(pool,identity,{controls,authorizeAttempt:async(db,who,input)=>{ownReservation=await budgets.reserveInTransaction(db,who,{budgetAccountId:prepared.lineage!.budgetAccountId,controlGeneration:input.controlGeneration,modelRequestId:input.modelRequestId,kind:'retry',tokens:1,rounds:0});return budgets.lease(who,ownReservation)}})
  await retries.register(f.owner,{runId:prepared.id,operationId});const attempt=await retries.claim(f.owner,{operationId,requestId:randomUUID(),expectedGeneration:prepared.lineage!.controlGeneration});assert(ownReservation)
  assert.equal((await r.runs.get(f.owner,{runId:prepared.id})).id,prepared.id,'本新Run自己的正常模型reservation不能令原取消历史变坏/无法读取')
  ;(await r.runs.executionAdmission(f.owner,prepared.id)).assertCurrent()
  const extra=await budgets.reserve(f.owner,{budgetAccountId:prepared.lineage!.budgetAccountId,controlGeneration:prepared.lineage!.controlGeneration,modelRequestId:'unrelated:'+randomUUID(),kind:'retry',tokens:1,rounds:0})
  await assert.rejects(r.runs.get(f.owner,{runId:prepared.id}),{code:'teloa/conflict'},'其它未收口预算不能冒充本新Run')
  await budgets.releaseUnaccepted(f.owner,{reservationId:extra.id});assert.equal((await r.runs.get(f.owner,{runId:prepared.id})).id,prepared.id)
  if(originalCase==='unpublished-recovery-own-unknown'){
   await budgets.markDispatched(f.owner,{reservationId:ownReservation.id})
   await assert.equal((await r.runs.get(f.owner,{runId:prepared.id})).id,prepared.id,'仅历史读取可识别本新Run正常markDispatched在途；不是新执行许可')
   const historical=await r.runs.sourceFollowupForRun(f.owner,{runId:prepared.id});assert(historical);assert.equal(api.sourceFollowupUnpublishedProof(historical)?.sha256,candidate.originalEvidenceSha256);assertUnpublishedSourceFollowupEvents(historical,originalPrefix as never)

   await assert.rejects(handler('task-runs/source-followup/get',{runId:a2.id},AbortSignal.timeout(10000)),{code:'teloa/conflict'})
   await assert.rejects(handler('task-runs/source-followup/prepare',{...command,requestId:randomUUID()},AbortSignal.timeout(10000)),{code:'teloa/conflict'})
   await assert.rejects(r.runs.executionAdmission(f.owner,prepared.id),{code:'teloa/conflict'},'在途unknown不给新的stream/输入许可')
   await assert.rejects(r.runs.executionScope(f.owner,{runId:prepared.id}),{code:'teloa/conflict'},'driver恢复在claim前复核范围也不能绕过动态unknown门')
   assert.equal((await r.runs.claim(f.owner,{runId:prepared.id})).dispatch,false,'重复start只回原记录，不取得新的发送许可')
   assert.equal((await pool.query('select state from teloa_work_budget_reservations where owner_id=$1 and id=$2',[f.owner,ownReservation.id])).rows[0].state,'unknown')
   assert.deepEqual((await pool.query('select * from teloa_task_runs where id=$1',[a2.id])).rows[0],before);assert.deepEqual(await f.updateRows(),beforeUpdate)
   assert.equal((await pool.query('select state from teloa_task_runs where id=$1',[prepared.id])).rows[0].state,'active','unknown分支保留真实在途，不自动完成/重发')
   return
  }
  await budgets.releaseUnaccepted(f.owner,{reservationId:ownReservation.id});await retries.record(f.owner,{operationId,attempt:attempt.attempt,receiptId:'no-model:'+randomUUID(),outcome:'conflict',reason:'受控端口fixture未派发模型，已正常释放预留'})
 }

 assert.deepEqual((await pool.query('select * from teloa_task_runs where id=$1',[a2.id])).rows[0],before);assert.deepEqual(await f.updateRows(),beforeUpdate)
 let completedTurn=unpublished?2:3,messageSeq=unpublished?3:5,endSeq=unpublished?4:6
 if(originalCase==='error-recovery-chain'){
  await r.runs.record(f.owner,{runId:prepared.id,sessionId:prepared.sessionId,nativeRequestId:prepared.nativeRequestId,evidence:{state:'ended',turn:3,messageSeq:5,endSeq:6,reason:'error'}})
  const firstCorrection=await r.runs.get(f.owner,{runId:prepared.id}),firstBefore=(await pool.query('select * from teloa_task_runs where id=$1',[prepared.id])).rows[0]
  const again=await handler('task-runs/source-followup/get',{runId:prepared.id},AbortSignal.timeout(10000)) as import('@teloa/contract').TaskRunSourceFollowupCandidate
  assert.equal(again.kind,'error-recovery');assert.equal(again.sourceUpdateId,u.id);assert.equal(again.originalNativeRequestId,firstCorrection.nativeRequestId)
  await assert.rejects(handler('task-runs/source-followup/get',{runId:a2.id},AbortSignal.timeout(10000)),{code:'teloa/conflict'},'原失败不再是最新纠正目标')
  const againCommand={kind:again.kind,requestId:randomUUID(),runId:firstCorrection.id,expectedTaskVersion:again.expectedTaskVersion,sourceUpdateId:u.id,instruction:'先核对最新失败，再按同一固定来源完成未完成工作；不要重做已有动作。'}
  prepared=await handler('task-runs/source-followup/prepare',againCommand,AbortSignal.timeout(10000)) as api.TaskRun
  assert.equal(prepared.state,'prepared');assert.equal(prepared.sourceFollowup?.originalRunId,firstCorrection.id);assert.equal(prepared.sourceFollowup?.sourceTaskVersion,u.taskVersion)
  assert.equal((await handler('task-runs/source-followup/prepare',againCommand,AbortSignal.timeout(10000)) as api.TaskRun).id,prepared.id)
  assert.notEqual(prepared.nativeRequestId,firstCorrection.nativeRequestId);assert.equal((await r.runs.claim(f.owner,{runId:prepared.id})).dispatch,true)
  assert.deepEqual((await pool.query('select * from teloa_task_runs where id=$1',[firstCorrection.id])).rows[0],firstBefore);assert.deepEqual(await f.updateRows(),beforeUpdate)
  completedTurn=4;messageSeq=7;endSeq=8
 }
 await r.runs.record(f.owner,{runId:prepared.id,sessionId:prepared.sessionId,nativeRequestId:prepared.nativeRequestId,evidence:{state:'ended',turn:completedTurn,messageSeq,endSeq,reason:'completed'}})
 f.state.items=f.state.items.map(item=>item.alert_id===source.object_id?{...item,state:'v3-normal'}:item);await f.syncOnce();await f.claimAll()
 const pending=(await f.updates.pending(f.owner)).find(item=>item.reference.version===3)!,u3=await f.updates.continueTask(f.owner,pending.id)
 const next=await r.runs.prepare(f.owner,{requestId:api.businessTaskSourceUpdateRunRequestId(f.owner,u3.id),taskId:task.id,expectedTaskVersion:u3.taskVersion!,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:a2.sessionId,expectedLinkVersion:a2.linkVersion});await f.updates.settle(f.owner,{id:u3.id,state:'continued',runId:next.id,reason:null})
 assert.equal((await r.runs.sessionRun(f.owner,{sessionId:a2.sessionId}))?.id,next.id,'后续正常来源必须选择已完成的纠正Run；原失败update绑定不改')
 assert.deepEqual((await pool.query('select * from teloa_task_runs where id=$1',[a2.id])).rows[0],before);assert.equal((await f.updates.get(f.owner,u.id)).runId,a2.id);
 await assert.rejects(handler('task-runs/source-followup/get',{runId:a2.id},AbortSignal.timeout(10000)),{code:'teloa/conflict'})
})

test('F1准备后v3到达仍可读可撤回，拒绝旧来源领取且撤回后原会话v3继续',{timeout:30000},async()=>{
 const f=await fixture();await f.syncOnce();const task=(await f.claimAll())[0]!.task,source=await f.sourceOf(task.id),r=await f.runner(task.id),a1=await r.prepare(1)
 await r.runs.claim(f.owner,{runId:a1.id});await r.runs.record(f.owner,{runId:a1.id,sessionId:a1.sessionId,nativeRequestId:a1.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}})
 f.state.items=f.state.items.map(item=>item.alert_id===source.object_id?{...item,state:'v2-result'}:item);await f.syncOnce();await f.claimAll()
 const u=await f.updates.continueTask(f.owner,(await f.updateRows())[0]!.id)
 const a2=await r.runs.prepare(f.owner,{requestId:api.businessTaskSourceUpdateRunRequestId(f.owner,u.id),taskId:task.id,expectedTaskVersion:u.taskVersion!,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:a1.sessionId,expectedLinkVersion:a1.linkVersion})
 await f.updates.settle(f.owner,{id:u.id,state:'accepted',runId:a2.id,reason:null});await r.runs.claim(f.owner,{runId:a2.id});await r.runs.record(f.owner,{runId:a2.id,sessionId:a2.sessionId,nativeRequestId:a2.nativeRequestId,evidence:{state:'ended',turn:2,messageSeq:3,endSeq:4,reason:'completed'}})
 const before=(await pool.query('select * from teloa_task_runs where id=$1',[a2.id])).rows[0],beforeUpdate=await f.updateRows(),state=(await pool.query('select version,state from teloa_tasks where id=$1',[task.id])).rows[0]
 assert.equal(state.state,'waiting');await assert.rejects(r.prepare(state.version),{code:'teloa/conflict'})
 const budgets=new api.WorkBudgetService(pool,identity,ownerAuthority),handler=createTaskRunHandler(f.owner,async()=>r.runs,{resolvePreset:async p=>p!,inspectSourceFollowup:async()=>{},check:async()=>{throw Error('prepare不得warm')},send:async()=>{throw Error('不得发送')},stop:async()=>{},events:async()=>[]},undefined,{conversations:{} as never,links:{} as never,admitRun:(db,who,lineage)=>budgets.admitRunStartInTransaction(db,who,lineage.budgetAccountId)})
 const candidate=await handler('task-runs/source-followup/get',{runId:a2.id},AbortSignal.timeout(10000)) as import('@teloa/contract').TaskRunSourceFollowupCandidate
 assert.equal(candidate.kind,'result-verification');assert.equal(candidate.disposition,undefined)
 const command={kind:'result-verification',requestId:randomUUID(),runId:a2.id,expectedTaskVersion:candidate.expectedTaskVersion,sourceUpdateId:u.id,instruction:'核对固定v2来源并重新保存成果；保留原执行回执。'}
 const prepared=await handler('task-runs/source-followup/prepare',command,AbortSignal.timeout(10000)) as api.TaskRun
 assert.equal(prepared.state,'prepared');assert.equal(prepared.sessionId,a2.sessionId);assert.notEqual(prepared.nativeRequestId,a2.nativeRequestId)
 assert.equal((await pool.query('select state from teloa_tasks where id=$1',[task.id])).rows[0].state,'waiting','准备不得偷偷修改原Task状态')
 assert.equal((await handler('task-runs/source-followup/prepare',command,AbortSignal.timeout(10000)) as api.TaskRun).id,prepared.id)
 f.state.items=f.state.items.map(item=>item.alert_id===source.object_id?{...item,state:'v3-before-start'}:item);await f.syncOnce();await f.claimAll()
 assert.equal((await r.runs.get(f.owner,{runId:prepared.id})).state,'prepared')
 assert.ok((await r.runs.list(f.owner,{taskId:task.id})).some(item=>item.id===prepared.id))
 await assert.rejects(r.runs.claim(f.owner,{runId:prepared.id}),{code:'teloa/conflict'})
 assert.equal((await r.runs.withdraw(f.owner,{runId:prepared.id})).state,'withdrawn')
 assert.deepEqual((await pool.query('select * from teloa_task_runs where id=$1',[a2.id])).rows[0],before)
 assert.deepEqual((await f.updates.get(f.owner,u.id)).runId,a2.id)
 const pending=(await f.updates.pending(f.owner)).find(item=>item.reference.version===3)!,u3=await f.updates.continueTask(f.owner,pending.id)
 assert.equal(u3.state,'continued')
 const next=await r.runs.prepare(f.owner,{requestId:api.businessTaskSourceUpdateRunRequestId(f.owner,u3.id),taskId:task.id,expectedTaskVersion:u3.taskVersion!,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:a2.sessionId,expectedLinkVersion:a2.linkVersion});await f.updates.settle(f.owner,{id:u3.id,state:'continued',runId:next.id,reason:null})
 assert.equal(next.sessionId,a2.sessionId);assert.equal((await r.runs.sessionRun(f.owner,{sessionId:a2.sessionId}))?.id,next.id)
})

test('本人调整累计额度后同告警仍续办；新告警按当前收窄额度拒绝，调高后沿原事件继续',async()=>{
 const f=await fixture();await f.syncOnce();const first=await f.claimAll();assert.equal(first.length,2)
 const budgets=new api.WorkBudgetService(pool,identity,ownerAuthority),account=f.plan.workDefinition!.budgetAccountId
 const change=async(maxTokens:number)=>{const current=await budgets.read(f.owner,{budgetAccountId:account});return budgets.configure(f.owner,{requestId:randomUUID(),budgetAccountId:account,expectedVersion:current.version,policy:{...current.policy,maxTokens}})}
 await change(30000)
 const original=first[0]!.task.id,source=await f.sourceOf(original)
 f.state.items=f.state.items.map(item=>item.alert_id===source.object_id?{...item,state:'escalated'}:item)
 await f.syncOnce();assert.deepEqual(await f.claimAll(),[])
 const updates=await f.updateRows();assert.equal(updates.length,1);assert.equal(updates[0]!.task_id,original);assert.equal(updates[0]!.state,'pending');assert.equal(await f.taskCount(),2)
 const reserved=await budgets.reserve(f.owner,{budgetAccountId:account,controlGeneration:1,modelRequestId:randomUUID(),kind:'retry',tokens:50,rounds:0})
 await budgets.settle(f.owner,{reservationId:reserved.id,modelRequestId:reserved.modelRequestId,provider:'fixture',providerRequestId:null,tokens:50,moneyMinorUnits:null,currency:null,receiptId:randomUUID()})
 await change(50);f.state.items.push({alert_id:'zeek/conn/3',state:'new'});await f.syncOnce()
 const pending=await f.events.pending(f.owner);assert.equal(pending.length,1)
 await assert.rejects(f.claimAll(),error=>error instanceof Error&&error.message==='长期工作累计额度已用完。')
 assert.equal(await f.taskCount(),2);assert.equal((await f.events.pending(f.owner))[0]!.event.id,pending[0]!.event.id)
 await change(51);const next=await f.claimAll();assert.equal(next.length,1);assert.equal(await f.taskCount(),3)
 assert.equal((await budgets.read(f.owner,{budgetAccountId:account})).usedTokens,50,'调整额度不能重置历史消耗')
 const current=await f.plans.get(f.owner,{planId:f.plan.id});assert.equal(current.version,f.plan.version);assert.equal(current.configVersion,f.plan.configVersion);assert.deepEqual(current.workDefinition,f.plan.workDefinition,'额度确认不改写原计划定义与历史')
})

test('同一计划的两条新告警同时派发，各建一个任务，不发生计划共享锁升级死锁',{timeout:15000},async()=>{
 for(const group of [false,true]){
 const f=await fixture({group});await f.syncOnce()
 const claims=[]
 for(const row of await f.events.pending(f.owner)){const claim=await f.events.claim(f.owner,{planId:row.planId,definitionVersion:row.definitionVersion,eventId:row.event.id,controlGeneration:row.controlGeneration});assert.ok(claim);claims.push(claim)}
 assert.equal(claims.length,2)
 let arrived=0,release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 const synchronizedPool=new Proxy(pool,{get(target,key){
  if(key==='connect')return async()=>{const db=await target.connect();let synchronized=false;return new Proxy(db,{get(client,member){
   if(member==='query')return async(...args:any[])=>{const sql=String(args[0])
    // 新路径先取得排他角色锁，旧路径先取得共享计划锁；只在持排他锁前同步两条领取，不能人为阻塞已串行化的事务。
    const exclusive=sql==='select * from teloa_roles where id=$1 and owner_id=$2 for update'
    if(!synchronized&&exclusive){synchronized=true;if(++arrived===2)release();await gate}
    const result=await (client.query as any)(...args)
    if(!synchronized&&sql.startsWith('select * from teloa_plans where owner_id=$1 and id=$2')){synchronized=true;if(++arrived===2)release();await gate}
    return result
   }
   const value=Reflect.get(client,member);return typeof value==='function'?value.bind(client):value
  }})}
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
 }})
 const occurrences=new api.PlanOccurrenceService(synchronizedPool,identity,undefined,(db,who,id)=>f.events.verifiedSourceInTransaction(db,who,id))
 const results=await Promise.allSettled(claims.map(claim=>occurrences.dispatchTask(f.owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:identity.now()})))
 assert.deepEqual(results.filter(result=>result.status==='rejected').map(result=>String(result.reason)),[])
 assert.equal(arrived,2);assert.equal(await f.taskCount(),2)
 }
})

test('带群旧任务重放与新告警首次派发并发，均按角色到计划取锁且不重复建任务',{timeout:15000},async()=>{
 const f=await fixture({group:true});await f.syncOnce();const claims:api.PlanOccurrence[]=[]
 for(const row of await f.events.pending(f.owner)){const claim=await f.events.claim(f.owner,{planId:row.planId,definitionVersion:row.definitionVersion,eventId:row.event.id,controlGeneration:row.controlGeneration});assert.ok(claim);claims.push(claim)}
 assert.equal(claims.length,2)
 const input=(index:number)=>({claimId:claims[index]!.id,taskRequestId:claims[index]!.taskRequestId,now:identity.now()})
 const original=await f.occurrences.dispatchTask(f.owner,input(0))
 let releaseNew!:()=>void,releaseOld!:()=>void
 const newLocked=new Promise<void>(resolve=>{releaseNew=resolve}),oldReady=new Promise<void>(resolve=>{releaseOld=resolve})
 const synchronizedPool=new Proxy(pool,{get(target,key){
  if(key==='connect')return async()=>{const db=await target.connect();let replay=false,planSeen=false;return new Proxy(db,{get(client,member){
   if(member==='query')return async(...args:any[])=>{const sql=String(args[0])
    if(sql==='select * from teloa_plan_occurrences where id=$1 and owner_id=$2')replay=args[1][0]===claims[0]!.id
    if(replay&&!planSeen&&sql==='select * from teloa_roles where id=$1 and owner_id=$2 for share'){releaseOld();await newLocked}
    const result=await (client.query as any)(...args)
    if(replay&&sql==='select * from teloa_plans where owner_id=$1 and id=$2 for share'){planSeen=true;releaseOld();await newLocked}
    if(!replay&&sql==='select * from teloa_roles where id=$1 and owner_id=$2 for update'){releaseNew();await oldReady}
    return result
   }
   const value=Reflect.get(client,member);return typeof value==='function'?value.bind(client):value
  }})}
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
 }})
 const occurrences=new api.PlanOccurrenceService(synchronizedPool,identity,undefined,(db,who,id)=>f.events.verifiedSourceInTransaction(db,who,id))
 const results=await Promise.allSettled([occurrences.dispatchTask(f.owner,input(0)),occurrences.dispatchTask(f.owner,input(1))])
 assert.deepEqual(results.filter(result=>result.status==='rejected').map(result=>String(result.reason)),[])
 assert.equal(results[0]!.status==='fulfilled'&&results[0].value.task.id,original.task.id)
 assert.equal(await f.taskCount(),2)
})

test('同一员工三条告警经宿主准备各自独立会话，同告警续报仍在原会话且重放不重复准备',async t=>{
 const f=await fixture();f.state.items.push({alert_id:'zeek/conn/3',state:'new'});await f.syncOnce();const dispatched=await f.claimAll();assert.equal(dispatched.length,3)
 // 使用实际宿主准备处理器、会话预约和关联服务；原生会话创建与模型发送为边界夹具，不宣称真实模型验收。
 let rows:StoredConversation[]=[]
 const conversations=new api.ConversationService({read:async()=>rows,write:async value=>{rows=value}},{create:async id=>id,inspect:async()=>{}},identity)
 const inspect=(owner:string,sessionId:string)=>conversations.bySession(owner,sessionId),links=new api.ObjectConversationService(pool,inspect,identity.now)
 const runs=new api.TaskRunService(pool,identity,inspect,{allowedTools:['get_goal'],planContext:(db,who,id)=>f.occurrences.executionContext(db,who,id),businessContext:async(db,who,task)=>{
  const context=await f.businessTasks.executionContextInTransaction(db,{ownerId:who,scopeIds:[task.scope]},{taskId:task.id});if(!context)return undefined
  const updates=await api.readBusinessTaskSourceUpdatesForRun(db,who,task.id,task.version);return {taskId:context.source.taskId,sourceId:context.source.sourceId,object:context.object,...(updates.length?{updates}:{})}
 }})
 const readPool=new Pool({connectionString:container.getConnectionUri(),options:'-c lock_timeout=1000',statement_timeout:3000})
 t.after(()=>readPool.end())
 const submissions=new api.TaskRunSubmissionService(readPool)
 let admissions=0,continuationChecks=0
 const handler=createTaskRunHandler(f.owner,async()=>runs,{resolvePreset:async preset=>preset??'worker',prepareSession:async(_id,preset)=>preset!,check:async input=>{
  if(input.previousRun){
   continuationChecks++
   // 正式宿主核验原会话后台工作时会过滤明确未发布的 owner；外层 prepare 已共享锁定原 Run。
   // 必须调用真实 PG 读口，空 check 会漏掉读口另开事务要求排他锁造成的自等待。
   assert.deepEqual(await submissions.unpublishedOwnerIds(f.owner,input.previousRun.id),[])
  }
 },send:async()=>{throw Error('本测试不得发送模型请求')},stop:async()=>{},events:async()=>[]},undefined,{conversations,links,admitRun:async()=>{admissions++}})
 const signal=AbortSignal.timeout(20000),prepare=async(owner:string,input:{requestId:string;taskId:string;expectedTaskVersion:number})=>{
  assert.equal(owner,f.owner);const run=await handler('task-runs/prepare',input,signal);assert.ok(!Array.isArray(run));return {runId:run.id}
 }
 const first=[] as api.TaskRun[]
 for(const item of dispatched){const prepared=await prepare(f.owner,{requestId:randomUUID(),taskId:item.task.id,expectedTaskVersion:1});first.push(await runs.get(f.owner,{runId:prepared.runId}))}
 assert.equal(new Set(first.map(run=>run.sessionId)).size,3,'同一员工的不同告警不得复用会话')
 assert.equal(new Set(first.map(run=>run.roleId)).size,1)
 const original=first[0]!,source=await f.sourceOf(original.taskId)
 await runs.claim(f.owner,{runId:original.id});await runs.record(f.owner,{runId:original.id,sessionId:original.sessionId,nativeRequestId:original.nativeRequestId,evidence:{state:'accepted'}});await runs.executionAdmission(f.owner,original.id)
 await runs.record(f.owner,{runId:original.id,sessionId:original.sessionId,nativeRequestId:original.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}})
 f.state.items=f.state.items.map(item=>item.alert_id===source.object_id?{...item,state:'escalated'}:item);await f.syncOnce();assert.deepEqual(await f.claimAll(),[])
 const pending=(await f.updates.pending(f.owner))[0]!,receipt=await f.updates.continueTask(f.owner,pending.id)
 assert.equal(receipt.state,'continued')
 const command={requestId:api.businessTaskSourceUpdateRunRequestId(f.owner,pending.id),taskId:original.taskId,expectedTaskVersion:receipt.taskVersion!}
 const parallel=await Promise.all([prepare(f.owner,command),prepare(f.owner,command)])
 assert.equal(parallel[0]!.runId,parallel[1]!.runId,'并发准备同条续报只创建一个Run')
 assert.equal(continuationChecks,1,'同条续报只在实际准备时核对原会话，幂等重放不重复核对')
 assert.equal(admissions,4,'原三条Run和续报均经过事务准入，幂等重放不重复准入')
 const ports={updates:f.updates,prepare,start:async(owner:string,runId:string)=>({state:(await runs.get(owner,{runId})).state}),readRun:async(owner:string,runId:string)=>runs.get(owner,{runId}),reconcile:async(owner:string,runId:string)=>({state:(await runs.get(owner,{runId})).state}),report:()=>{}}
 await drainBusinessTaskSourceUpdates(f.owner,ports,signal)
 const [update]=await f.updateRows();assert.ok(update?.run_id,'后续版本应经宿主准备新的执行回合');const next=await runs.get(f.owner,{runId:update.run_id})
 assert.equal(next.taskId,original.taskId);assert.equal(await f.taskCount(),3);assert.deepEqual(await f.sourceOf(original.taskId),source)
 assert.equal(next.sessionId,original.sessionId,'同告警续报必须保留原会话，而不是仅复用Task编号')
 assert.equal(rows.length,3,'续报不重写原预约或创建额外会话')
 assert.equal((await runs.skillScope(f.owner,{sessionId:next.sessionId}))?.id,next.id,'多轮历史保留时技能作用域选择当前续报Run')
 assert.equal((await runs.sourceContinuationForRun(f.owner,{runId:next.id}))?.id,original.id)
 const session={id:next.sessionId,header:{id:next.sessionId},inheritedEventCount:0,snapshotEvents:()=>[]},context=createProjectRuntimeAdapters({agents:{get:()=>({session,status:'idle',inbox:{nextTurn:[],nextStep:[]}})}} as never,{owner:f.owner,pool,conversations,links,runs:async()=>runs} as never)
 const actor=await context.inspect(f.owner,next.sessionId)
 assert.equal(actor.kind,'task');assert.equal(actor.roleId,f.role.id);assert.equal(actor.scope,f.scope)
 await runs.claim(f.owner,{runId:next.id})
 assert.equal((await context.inspect(f.owner,next.sessionId)).roleId,f.role.id,'实际输入前项目上下文必须接受已提交的同告警续报')
 await runs.record(f.owner,{runId:next.id,sessionId:next.sessionId,nativeRequestId:next.nativeRequestId,evidence:{state:'ended',turn:2,messageSeq:3,endSeq:4,reason:'completed'}})
 assert.equal((await context.inspect(f.owner,next.sessionId)).roleId,f.role.id,'本轮完成后仍可只读核对原执行者，不重新授予运行许可')
 await assert.rejects(runs.executionAdmission(f.owner,next.id),{code:'teloa/forbidden'})
 await assert.rejects(runs.sessionRun('other-owner',{sessionId:next.sessionId}),{code:'teloa/forbidden'})
 assert.equal((await runs.get(f.owner,{runId:original.id})).inputText,original.inputText,'旧Run冻结输入保留')
 await assert.rejects(runs.sourceContinuationForRun('other-owner',{runId:next.id}),{code:'teloa/forbidden'})
 assert.equal(await runs.sourceContinuation(f.owner,{requestId:randomUUID(),taskId:next.taskId,expectedTaskVersion:next.taskVersion}),null,'任意新请求不能冒充续报来源')
 await drainBusinessTaskSourceUpdates(f.owner,ports,signal);assert.equal((await runs.list(f.owner,{taskId:original.taskId})).length,2,'重放只核对已绑定Run')
 for(const other of first.slice(1))assert.equal((await runs.get(f.owner,{runId:other.id})).state,'prepared','续报不改变其他告警执行')
 const other=first[1]!
 await pool.query('update teloa_task_runs set session_id=$2 where id=$1',[other.id,next.sessionId])
 try{await assert.rejects(context.inspect(f.owner,next.sessionId),{code:'teloa/storage-corrupt'},'其他告警的Run混入同一会话必须拒绝，不能仅按最新时间选择')}finally{await pool.query('update teloa_task_runs set session_id=$2 where id=$1',[other.id,other.sessionId])}
})

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

test('备份恢复暂停计划后本人重新启用并恢复工作：配置未变时原告警任务可首次准备；旧恢复收据不覆盖后来的计划暂停或配置变化',async()=>{
 const f=await fixture();await f.syncOnce();const dispatched=await f.claimAll(),target=dispatched[0]!,controlId=f.plan.workDefinition!.definitionControlId
 const controls=new api.WorkControlService(pool,identity,{hostGeneration:()=>2,ownerAuthority,inspectRun:async()=>({settled:true,unknownOperationIds:[]})})
 const recovery=new api.WorkRecoveryService(pool,identity,controls,{hostGeneration:()=>2,ownerAuthority,inspectCheckpoint:async()=>{throw Error('无在途 Run')},authorizeResume:async()=>({assertCurrent(){}})})
 const verify=async()=>{const db=await pool.connect();try{await db.query('begin');return await f.occurrences.executionContext(db,f.owner,target.task.id)}finally{await db.query('rollback');db.release()}}
 const originalClaim=(await pool.query('select snapshot from teloa_plan_occurrences where id=$1',[target.occurrence.id])).rows[0].snapshot
 // 正式 restore 的计划暂停，再经本人确认入口重新启用；不改配置，也不重建任务。
 const pausedPlan=await f.plans.change(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:f.plan.version,action:'pause',note:'从备份恢复；由本人核对后重新启用'})
 const activePlan=await f.plans.changeConfirmed(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:pausedPlan.version,action:'enable'})
 assert.equal(activePlan.configVersion,f.plan.configVersion);assert.equal(activePlan.version,f.plan.version+2)
 for(const control of await controls.disarmForRestart(f.owner,{hostGeneration:2}))await controls.reconcile(f.owner,{controlId:control.id,generation:control.generation})
 await assert.rejects(verify(),{code:'teloa/version-conflict'},'只启用计划，没有本人恢复工作，不执行')
 const paused=await controls.get(f.owner,{controlId})
 await recovery.resume(f.owner,{requestId:randomUUID(),controlId,expectedVersion:paused.version,candidateRunIds:[]})
 assert.ok((await verify())?.event,'本人恢复同一配置后原领取可继续')
 const r=await f.runner(target.task.id),run=await r.prepare(1)
 assert.equal(run.taskId,target.task.id);assert.equal(run.state,'prepared');assert.equal(await f.taskCount(),2)
 assert.deepEqual((await pool.query('select snapshot from teloa_plan_occurrences where id=$1',[target.occurrence.id])).rows[0].snapshot,originalClaim,'不改写原领取证据')
 const pausedAgain=await f.plans.change(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:activePlan.version,action:'pause'})
 const enabledAgain=await f.plans.changeConfirmed(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:pausedAgain.version,action:'enable'})
 await assert.rejects(verify(),{code:'teloa/version-conflict'},'之前的工作恢复收据不授权后来的计划重新启用')
 await r.runs.withdraw(f.owner,{runId:run.id})
 for(const task of await new api.TaskService(pool,identity).list(f.owner,{}))await new api.TaskTransitions(pool,identity).change(f.owner,{requestId:randomUUID(),taskId:task.id,expectedVersion:task.version,action:'cancel'})
 const pausedForEdit=await f.plans.change(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:enabledAgain.version,action:'pause'})
  const budget=f.plan.workDefinition!.budget
  const changed=await f.plans.configureWorkConfirmed(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:pausedForEdit.version,expectedConfigVersion:pausedForEdit.configVersion,configuration:{completion:{kind:'manual'},triggers:f.plan.workDefinition!.triggers,budget:{...budget,maxTokens:budget.maxTokens===null?1000:budget.maxTokens+1},overlap:'independent',missed:'coalesce',safeRecovery:false}})
 assert.ok(changed.configVersion>f.plan.configVersion)
 await f.plans.changeConfirmed(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:changed.version,action:'enable'})
 await assert.rejects(verify(),{code:'teloa/version-conflict'},'配置变化仍需新工作，不能借恢复使用旧领取')
})

test('恢复授权绑定确切计划版本：同毫秒与时钟回拨均不能让旧收据覆盖后来的重新启用',async()=>{
 for(const rollback of [false,true]){
  let now='2026-10-25T06:00:00.000Z'
  const f=await fixture({now:()=>now});await f.syncOnce();const [target]=await f.claimAll(),controlId=f.plan.workDefinition!.definitionControlId
  const controls=new api.WorkControlService(pool,f.clock,{hostGeneration:()=>2,ownerAuthority,inspectRun:async()=>({settled:true,unknownOperationIds:[]})})
  const recovery=new api.WorkRecoveryService(pool,f.clock,controls,{hostGeneration:()=>2,ownerAuthority,inspectCheckpoint:async()=>{throw Error('无在途 Run')},authorizeResume:async()=>({assertCurrent(){}})})
  const verify=async()=>{const db=await pool.connect();try{await db.query('begin');return await f.occurrences.executionContext(db,f.owner,target!.task.id)}finally{await db.query('rollback');db.release()}}
  const paused=await f.plans.change(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:f.plan.version,action:'pause'})
  const active=await f.plans.changeConfirmed(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:paused.version,action:'enable'})
  for(const control of await controls.disarmForRestart(f.owner,{hostGeneration:2}))await controls.reconcile(f.owner,{controlId:control.id,generation:control.generation})
  const control=await controls.get(f.owner,{controlId})
  const request={requestId:randomUUID(),controlId,expectedVersion:control.version,candidateRunIds:[]}
  await recovery.resume(f.owner,request);assert.ok((await verify())?.event,'同毫秒恢复也必须能继续原任务')
  if(rollback)now='2026-10-25T05:00:00.000Z'
  const laterPause=await f.plans.change(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:active.version,action:'pause'})
  await f.plans.changeConfirmed(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:laterPause.version,action:'enable'})
  await recovery.resume(f.owner,request)
  await assert.rejects(verify(),{code:'teloa/version-conflict'},'同毫秒、回拨及幂等重放都不能扩大原恢复授权')
 }
})

test('带群汇报的业务事件恢复原任务后可准备、完成并幂等回群；撤回群授权仍禁止执行',async()=>{
 const f=await fixture({group:true});await f.syncOnce();const [target,other]=await f.claimAll(),controlId=f.plan.workDefinition!.definitionControlId
 const controls=new api.WorkControlService(pool,identity,{hostGeneration:()=>2,ownerAuthority,inspectRun:async()=>({settled:true,unknownOperationIds:[]})})
 const recovery=new api.WorkRecoveryService(pool,identity,controls,{hostGeneration:()=>2,ownerAuthority,inspectCheckpoint:async()=>{throw Error('无在途 Run')},authorizeResume:async()=>({assertCurrent(){}})})
 const paused=await f.plans.change(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:f.plan.version,action:'pause'})
 await f.plans.changeConfirmed(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:paused.version,action:'enable'})
 for(const control of await controls.disarmForRestart(f.owner,{hostGeneration:2}))await controls.reconcile(f.owner,{controlId:control.id,generation:control.generation})
 const control=await controls.get(f.owner,{controlId});await recovery.resume(f.owner,{requestId:randomUUID(),controlId,expectedVersion:control.version,candidateRunIds:[]})
 const r=await f.runner(target!.task.id),run=await r.prepare(1)
 await r.runs.claim(f.owner,{runId:run.id})
 const ended=await r.runs.record(f.owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 const {createTaskRunGroupPublisher}=await import('../../harness-dsh/src/task-run-group-publisher.ts')
 const service=new api.GroupRunMessageService(pool,identity),failures:string[]=[]
 const publish=createTaskRunGroupPublisher({post:input=>service.post(f.owner,input),failure:(run,code)=>service.failure(f.owner,{runId:run.id,nativeRequestId:run.nativeRequestId,code}),report:code=>failures.push(code)})
 await publish(ended,'恢复后原告警的研判结论。');await publish(ended,'恢复后原告警的研判结论。')
 assert.deepEqual(failures,[])
 const messages=await f.groups.messages(f.owner,{groupId:f.group!.id});assert.equal(messages.length,1);assert.ok('taskId' in messages[0]!);assert.equal(messages[0].taskId,target!.task.id)
 await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group!.id,roleId:f.role.id,expectedGroupVersion:f.group!.version,expectedRoleVersion:f.role.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 const otherRunner=await f.runner(other!.task.id)
 await assert.rejects(otherRunner.prepare(1),{code:'teloa/forbidden'},'恢复不能越过实时群授权')
 assert.equal(await f.taskCount(),2)
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

test('真实PG：正常prepare/Start后的F2预留与markDispatched不破坏父F1历史；发送闸独立拒unknown', {timeout:60000},async()=>{
 const f=await fixture();await f.syncOnce();const task=(await f.claimAll())[0]!.task,source=await f.sourceOf(task.id),r=await f.runner(task.id),v1=await r.prepare(1)
 await r.runs.claim(f.owner,{runId:v1.id});await r.runs.record(f.owner,{runId:v1.id,sessionId:v1.sessionId,nativeRequestId:v1.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}})
 const tasks=new api.TaskService(pool,identity),original=(await tasks.list(f.owner,{})).find(x=>x.id===task.id)!
 await tasks.edit(f.owner,{taskId:task.id,expectedVersion:original.version,fields:{goal:'核对固定v2，保留原v1。'}})
 f.state.items=f.state.items.map(item=>item.alert_id===source.object_id?{...item,state:'v2-normal'}:item);await f.syncOnce();await f.claimAll()
 const u=await f.updates.continueTask(f.owner,(await f.updateRows())[0]!.id)
 const old=await r.runs.prepare(f.owner,{requestId:api.businessTaskSourceUpdateRunRequestId(f.owner,u.id),taskId:task.id,expectedTaskVersion:u.taskVersion!,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:v1.sessionId,expectedLinkVersion:v1.linkVersion})
 await f.updates.settle(f.owner,{id:u.id,state:'continued',runId:old.id,reason:null});await r.runs.claim(f.owner,{runId:old.id})
 const journal=new api.TaskRunSubmissionService(pool),runtimeId=randomUUID(),claimed=await r.runs.get(f.owner,{runId:old.id}),ticket=await journal.begin(f.owner,claimed,runtimeId)
 await new api.TaskRunRuntimeLinkService(pool).put(f.owner,{runId:old.id,kind:'job',nativeId:'owner:'+runtimeId+':'+old.sessionId,sessionId:old.sessionId,payload:{record:'owner',runtimeId,requestId:old.nativeRequestId}})
 await journal.finish(f.owner,ticket,'not-published');const stopping=await r.runs.requestStop(f.owner,{runId:old.id})
 await journal.cancelNotPublished(f.owner,{requestId:randomUUID(),runId:old.id,confirmNotPublished:true},r.runs,{runId:old.id,sessionId:old.sessionId,nativeRequestId:old.nativeRequestId,inputSha256:createHash('sha256').update(old.inputText).digest('hex'),runtimeId,notPublished:true,logCut:-1,logSha256:createHash('sha256').update('[]').digest('hex'),assertCurrent(){assert(stopping.stopRequestedAt)}})
 await f.updates.settle(f.owner,{id:u.id,state:'needs-user',runId:old.id,reason:'teloa/run-not-accepted'})
 const budgets=new api.WorkBudgetService(pool,identity,ownerAuthority),handler=createTaskRunHandler(f.owner,async()=>r.runs,{resolvePreset:async p=>p!,inspectSourceFollowup:async()=>{},check:async()=>{throw Error('模型不装配')},send:async()=>{throw Error('不调用provider')},stop:async()=>{},events:async()=>[]},undefined,{conversations:{} as never,links:{} as never,admitRun:(db,who,lineage)=>budgets.admitRunStartInTransaction(db,who,lineage.budgetAccountId)})
 async function confirm(runId:string){
  const c=await handler('task-runs/source-followup/get',{runId},AbortSignal.timeout(5000)) as import('@teloa/contract').TaskRunSourceFollowupCandidate
  return handler('task-runs/source-followup/prepare',{kind:c.kind,requestId:randomUUID(),runId,expectedTaskVersion:c.expectedTaskVersion,sourceUpdateId:c.sourceUpdateId,instruction:'核对固定v2，保留原v1。'},AbortSignal.timeout(5000)) as Promise<api.TaskRun>
 }
 const f1=await confirm(old.id);await r.runs.claim(f.owner,{runId:f1.id});await r.runs.requestStop(f.owner,{runId:f1.id});await r.runs.record(f.owner,{runId:f1.id,sessionId:f1.sessionId,nativeRequestId:f1.nativeRequestId,evidence:{state:'ended',turn:2,messageSeq:3,endSeq:4,reason:'error'}})
 const f1Raw=(await pool.query('select * from teloa_task_runs where id=$1',[f1.id])).rows[0],oldRaw=(await pool.query('select * from teloa_task_runs where id=$1',[old.id])).rows[0],updateRaw=(await pool.query('select * from teloa_business_task_source_updates where id=$1',[u.id])).rows[0]
 // 一次正常提交明确未发布后取消；其固定确认仍保留，但不占后续唯一可执行分支。
 const cancelled=await confirm(f1.id);await r.runs.claim(f.owner,{runId:cancelled.id})
 const cancelledRuntime=randomUUID(),cancelledTicket=await journal.begin(f.owner,await r.runs.get(f.owner,{runId:cancelled.id}),cancelledRuntime)
 await new api.TaskRunRuntimeLinkService(pool).put(f.owner,{runId:cancelled.id,kind:'job',nativeId:'owner:'+cancelledRuntime+':'+cancelled.sessionId,sessionId:cancelled.sessionId,payload:{record:'owner',runtimeId:cancelledRuntime,requestId:cancelled.nativeRequestId}})
 await journal.finish(f.owner,cancelledTicket,'not-published');const cancelledStop=await r.runs.requestStop(f.owner,{runId:cancelled.id})
 const cancelledRun=await journal.cancelNotPublished(f.owner,{requestId:randomUUID(),runId:cancelled.id,confirmNotPublished:true},r.runs,{runId:cancelled.id,sessionId:cancelled.sessionId,nativeRequestId:cancelled.nativeRequestId,inputSha256:createHash('sha256').update(cancelled.inputText).digest('hex'),runtimeId:cancelledRuntime,notPublished:true,logCut:-1,logSha256:createHash('sha256').update('[]').digest('hex'),assertCurrent(){assert(cancelledStop.stopRequestedAt)}})
 assert.equal(cancelledRun.state,'withdrawn');const cancelledRaw=(await pool.query('select * from teloa_task_runs where id=$1',[cancelled.id])).rows[0]
 const f2=await confirm(f1.id);assert.equal((await r.runs.claim(f.owner,{runId:f2.id})).dispatch,true);await r.runs.record(f.owner,{runId:f2.id,sessionId:f2.sessionId,nativeRequestId:f2.nativeRequestId,evidence:{state:'active',turn:3,messageSeq:5}})
 const controls=new api.WorkControlService(pool,identity);let reservation:Awaited<ReturnType<typeof budgets.reserve>>|undefined
 const retries=new api.WorkRetryService(pool,identity,{controls,authorizeAttempt:async(db,who,input)=>{reservation=await budgets.reserveInTransaction(db,who,{budgetAccountId:f2.lineage!.budgetAccountId,controlGeneration:input.controlGeneration,modelRequestId:input.modelRequestId,kind:'retry',tokens:1,rounds:0});return budgets.lease(who,reservation)}})
 const operationId='post-acceptance:'+f2.id;await retries.register(f.owner,{runId:f2.id,operationId});const attempt=await retries.claim(f.owner,{operationId,requestId:randomUUID(),expectedGeneration:f2.lineage!.controlGeneration});assert(reservation)
 const checkHistory=async()=>{assert.equal((await r.runs.get(f.owner,{runId:f1.id})).id,f1.id,'旧F1正常get必须稳定');assert.equal((await r.runs.get(f.owner,{runId:cancelled.id})).id,cancelled.id,'已取消兄弟仍能读取');assert.equal((await r.runs.list(f.owner,{taskId:task.id})).length,5,'正常list包含v1/typedroot/F1/已取消兄弟/F2');assert.equal((await r.runs.sessionRun(f.owner,{sessionId:f2.sessionId}))?.id,f2.id,'正常session父链读取必须稳定');assert.equal((await r.runs.sourceFollowupForRun(f.owner,{runId:f2.id}))?.id,f1.id);const db=await pool.connect();try{assert.ok(await f.occurrences.executionContext(db,f.owner,task.id))}finally{db.release()}}
 await checkHistory();(await r.runs.executionAdmission(f.owner,f2.id)).assertCurrent()
 const foreign=await budgets.reserve(f.owner,{budgetAccountId:f2.lineage!.budgetAccountId,controlGeneration:f2.lineage!.controlGeneration,modelRequestId:'foreign:'+randomUUID(),kind:'retry',tokens:1,rounds:0})
 assert.equal((await r.runs.get(f.owner,{runId:f1.id})).id,f1.id,'陌生预约不改变固定历史身份，也不授予再次发送')
 await assert.rejects(r.runs.executionAdmission(f.owner,f2.id),{code:'teloa/conflict'})
 assert.equal(await journal.unpublishedCancellationSettled(f.owner,await r.runs.get(f.owner,{runId:old.id})),false,'公共结算不豁免外来预算')
 await budgets.releaseUnaccepted(f.owner,{reservationId:foreign.id})
 await budgets.markDispatched(f.owner,{reservationId:reservation.id});await checkHistory()
 // 走真实finally相同的未知用量回执，不补零或已知tokens；此处无模型提供方。
 await budgets.settle(f.owner,{reservationId:reservation.id,modelRequestId:attempt.modelRequestId,provider:'synthetic-unmetered-provider',providerRequestId:null,tokens:null,moneyMinorUnits:null,currency:null,receiptId:'controlled-unknown-'+randomUUID()})
 await retries.record(f.owner,{operationId,attempt:attempt.attempt,receiptId:'controlled-unknown-retry-'+randomUUID(),outcome:'unknown',reason:'受控回归端口未提供计量，unknown原样保留'})
 await assert.rejects(r.runs.executionAdmission(f.owner,f2.id),{code:'teloa/conflict'},'多层error直接父已ended也必须显式拒unknown新发送')
 await assert.rejects(r.runs.executionScope(f.owner,{runId:f2.id}),{code:'teloa/conflict'},'tool/scope复核不得靠history授予发送')
 assert.equal((await r.runs.claim(f.owner,{runId:f2.id})).dispatch,false)
 await r.runs.record(f.owner,{runId:f2.id,sessionId:f2.sessionId,nativeRequestId:f2.nativeRequestId,evidence:{state:'ended',turn:3,messageSeq:5,endSeq:6,reason:'error'}});await checkHistory()
 await assert.rejects(confirm(f2.id),{code:'teloa/conflict'},'没有真实用量回执，不得由native error或private 0HTTP解锁F3')
 assert.equal((await pool.query('select state from teloa_work_budget_reservations where id=$1',[reservation.id])).rows[0].state,'unknown')
 // 正常可信终态计时回执只封本Run生命周期，保留unknown原金额和claim；不伪造提供方计量或清零。
 assert.equal(await journal.unpublishedCancellationSettled(f.owner,await r.runs.get(f.owner,{runId:old.id})),false,'只有原生错误而没有用量终态回执仍未结清')
 const budgetBefore=(await pool.query('select * from teloa_work_budget_reservations where id=$1',[reservation.id])).rows[0],usedBefore=await budgets.read(f.owner,{budgetAccountId:f2.lineage!.budgetAccountId})
 const terminal={schema:'teloa.work-budget-terminal/v1' as const,runId:f2.id,sessionId:f2.sessionId,nativeRequestId:f2.nativeRequestId,turn:3,messageSeq:5,endSeq:6,turnEndSeq:6,terminalKind:'turn/end' as const,endedAt:identity.now()}
 assert.equal((await budgets.recordRunTerminal(f.owner,terminal)).closed,1)
 assert.equal(await journal.unpublishedCancellationSettled(f.owner,await r.runs.get(f.owner,{runId:old.id})),true,'公共取消结算复用唯一确认链的可信终态，保留旧unknown')
 const settled=await pool.connect();try{assert.equal(await api.roleWorkOutstanding(settled,f.owner,f.role.id,{taskId:task.id}),false,'宿主四Run聚合结算使用相同历史证明')}finally{settled.release()}
 const terminalRow=(await pool.query('select * from teloa_work_budget_reservations where id=$1',[reservation.id])).rows[0]
 assert.equal(terminalRow.state,'unknown');assert.equal(terminalRow.reserved_tokens,budgetBefore.reserved_tokens);assert.deepEqual(terminalRow.receipt,budgetBefore.receipt)
 assert.equal((await budgets.read(f.owner,{budgetAccountId:f2.lineage!.budgetAccountId})).usedTokens,usedBefore.usedTokens)
 for(const bad of ['missing','request','run','control','early','receipt'] as const){
  const proof=structuredClone(terminal);if(bad==='request')proof.nativeRequestId=randomUUID();if(bad==='run')proof.runId=randomUUID();if(bad==='early')proof.endedAt='2000-01-01T00:00:00.000Z'
  // 只在隔离反例schema破坏一项持久字段，验证真实SQL拒绝；每次恢复同一normal receipt原值。
  await pool.query('update teloa_work_budget_reservations set elapsed_terminal=$2,control_generation=$3 where id=$1',[reservation.id,bad==='missing'?null:JSON.stringify(proof),terminalRow.control_generation+(bad==='control'?1:0)])
  if(bad==='receipt')await pool.query("update teloa_work_budget_reservations set receipt=jsonb_set(receipt,'{receiptId}','\"wrong-receipt\"') where id=$1",[reservation.id])
  try{assert.equal(await journal.unpublishedCancellationSettled(f.owner,await r.runs.get(f.owner,{runId:old.id})),false,'公共结算拒绝损坏终态：'+bad);await assert.rejects(confirm(f2.id),{code:'teloa/conflict'},bad)}finally{await pool.query('update teloa_work_budget_reservations set elapsed_terminal=$2,control_generation=$3,receipt=$4 where id=$1',[reservation.id,JSON.stringify(terminalRow.elapsed_terminal),terminalRow.control_generation,JSON.stringify(terminalRow.receipt)])}
 }
 const planBefore=await f.plans.get(f.owner,{planId:f.plan.id}),paused=await f.plans.changeConfirmed(f.owner,{requestId:randomUUID(),planId:planBefore.id,expectedVersion:planBefore.version,action:'pause'})
 assert.equal(paused.state,'paused')
 const auto=await pool.connect();try{await assert.rejects(f.occurrences.executionContext(auto,f.owner,task.id),{code:'teloa/version-conflict'},'暂停计划的普通/自动入口没有本人单次证明仍拒')}finally{auto.release()}
 const pausedRaw=(await pool.query('select * from teloa_plans where owner_id=$1 and id=$2',[f.owner,f.plan.id])).rows[0]
 const f3=await confirm(f2.id);assert.equal(f3.sourceFollowup?.originalRunId,f2.id);assert.equal((await r.runs.claim(f.owner,{runId:f3.id})).dispatch,true);assert.equal((await pool.query('select state from teloa_work_budget_reservations where id=$1',[reservation.id])).rows[0].state,'unknown','新的本人确认只发新请求，旧unknown永远保留，不冒充已结算')
 // 新F3仍走原预算fence：本请求reserved可执行；markDispatched后只可读，不再取得新发送资格。
 const operation3='post-acceptance:'+f3.id;await retries.register(f.owner,{runId:f3.id,operationId:operation3});await retries.claim(f.owner,{operationId:operation3,requestId:randomUUID(),expectedGeneration:f3.lineage!.controlGeneration});assert(reservation)
 assert.equal((await r.runs.get(f.owner,{runId:f1.id})).id,f1.id)
 ;(await r.runs.executionAdmission(f.owner,f3.id)).assertCurrent()
 await budgets.markDispatched(f.owner,{reservationId:reservation.id})
 assert.equal((await r.runs.list(f.owner,{taskId:task.id})).length,6)
 assert.equal((await r.runs.sessionRun(f.owner,{sessionId:f3.sessionId}))?.id,f3.id)
 await assert.rejects(r.runs.executionAdmission(f.owner,f3.id),{code:'teloa/conflict'},'本次当前F3未知请求本身不能再次发送')
 await assert.rejects(r.runs.executionScope(f.owner,{runId:f3.id}),{code:'teloa/conflict'})
 assert.equal((await r.runs.claim(f.owner,{runId:f3.id})).dispatch,false)
 assert.deepEqual((await pool.query('select * from teloa_plans where owner_id=$1 and id=$2',[f.owner,f.plan.id])).rows[0],pausedRaw,'本人单次新确认没有恢复自动计划')
 assert.deepEqual((await pool.query('select * from teloa_task_runs where id=$1',[f1.id])).rows[0],f1Raw);assert.deepEqual((await pool.query('select * from teloa_task_runs where id=$1',[old.id])).rows[0],oldRaw);assert.deepEqual((await pool.query('select * from teloa_business_task_source_updates where id=$1',[u.id])).rows[0],updateRaw)
 assert.deepEqual((await pool.query('select * from teloa_task_runs where id=$1',[cancelled.id])).rows[0],cancelledRaw)
})
