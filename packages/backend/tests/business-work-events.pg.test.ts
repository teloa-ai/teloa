import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import * as api from '../src/index.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'

let pool:Pool,container:StartedPostgreSqlContainer
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const unavailable=async():Promise<never>=>{throw Error('不得访问市场或远端')}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').withPullPolicy({shouldPull:()=>false}).start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await api.initializeTeloaDatabase(pool);await api.initializeBusinessSpaces(pool);await api.initializeBusinessDefinitions(pool);await api.initializeBusinessConfigurations(pool);await api.initializeBusinessRuntime(pool);await api.initializeBusinessData(pool);await api.initializeBusinessWarehouse(pool);await api.initializeBusinessSnapshotReferences(pool);await api.initializeBusinessSync(pool);await api.initializeBusinessRecords(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(withSync=false){
 const drafts=new api.BusinessConfigurationDraftService(pool,identity),store=new api.BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const runtime=new api.BusinessRuntimeService(pool,identity),spaces=new api.BusinessSpaceService(pool,identity)
 const apply=new api.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime,spaces}),preview=new api.BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 const actor={ownerId:randomUUID(),scopeIds:[] as string[]}
 let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'本轮业务事件'})
 const definition={format:'teloa.business-object-type/v1',id:'lead-record',version:'1.0.0',domain:draft.scope,title:'线索',unit:'条',lead:'线索记录',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'state',label:'状态',type:'text',required:true,from:'状态'}]}
 const mapping={format:'teloa.business-source-mapping/v1',id:'lead-sync',version:'1.0.0',domain:draft.scope,title:'线索同步',objectType:'lead-record',source:{kind:'mcp-tool',serverName:'event-test',tool:'list',arguments:{},itemsPath:'$.items[*]'},mapping:[{path:'$.state',field:'state'}],primaryKey:['state'],deletionSemantics:'compare',schedule:{kind:'every',seconds:60},acknowledgeShortInterval:false}
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition},...(withSync?[{kind:'source-mapping',definition:mapping}]:[])],upsertPages:[{id:'home',title:'记录',kind:'records',objectType:'lead-record',fields:['state'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'home'}})
 await apply.apply(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:(await preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt})
 actor.scopeIds=(await new api.BusinessScopeService(pool).list(actor.ownerId)).map(row=>row.scope)
 const dependencies={definitions,warehouse:new api.BusinessWarehouseService(pool,identity),references:new api.BusinessSnapshotReferenceService(pool,identity)}
 const updateConfiguration=async()=>{const next=await drafts.begin(actor,{requestId:randomUUID(),title:'本轮业务事件',scope:draft.scope});return apply.apply(actor,{requestId:randomUUID(),draftId:next.id,expectedRevision:next.revision,expectedBaseVersion:1,previewReceipt:(await preview.preview(actor,{draftId:next.id,expectedRevision:next.revision})).receipt})}
 return {actor,dependencies,updateConfiguration,input:{scope:draft.scope,type:'lead-record',requestId:randomUUID(),title:'线索甲',summary:'',fields:[{name:'state',value:'待联系'}]}}
}

test('正式本地记录在原事务产出一次可信事件；原回放和读取不再派发，producer失败回滚记录',async()=>{
 const f=await fixture(),calls:unknown[]=[]
 const records=new api.BusinessRecordService(pool,identity,{...f.dependencies,events:{object:async(...args:unknown[])=>{calls.push(args.slice(1))}}} as ConstructorParameters<typeof api.BusinessRecordService>[2])
 const first=await records.create(f.actor,f.input)
 assert.equal(calls.length,1,'正式提交必须调用可信producer')
 assert.deepEqual(await records.create(f.actor,f.input),first);await records.get(f.actor,{scope:first.scope,type:first.type,id:first.id});assert.equal(calls.length,1)
 const failing=new api.BusinessRecordService(pool,identity,{...f.dependencies,events:{object:async()=>{throw Error('event failure')}}} as ConstructorParameters<typeof api.BusinessRecordService>[2])
 await assert.rejects(failing.edit(f.actor,{scope:first.scope,type:first.type,id:first.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'已联系'}]}),/event failure/)
 assert.equal((await records.get(f.actor,{scope:first.scope,type:first.type,id:first.id})).version,1)
})

// 全链使用原正式 Plan/Task/Run 服务，模型端口不装配。
const ownerAuthority={authorize:async()=>({assertCurrent(){}})}
async function planFixture(){
 const f=await fixture(),baseRecords=new api.BusinessRecordService(pool,identity,f.dependencies),object=await baseRecords.create(f.actor,f.input)
 const {WorkEventService}=await import('../src/work/work-events.ts'),{businessWorkSourceReader}=await import('../src/work/business-work-event-source.ts')
 const sync=new api.BusinessSyncService(pool,identity,f.dependencies.definitions,f.dependencies.warehouse,unavailable)
 const readSource=businessWorkSourceReader({records:baseRecords,sync})
 let originRun:string|undefined
 const events=new WorkEventService(pool,identity,{material:unavailable,business:readSource,businessOrigin:async(_db,_owner,origin)=>origin.sessionId==='verified-native'&&originRun?{kind:'task-run',runId:originRun}:origin.sessionId==='verified-ordinary'?{kind:'ordinary-conversation'}:undefined})
 const records=new api.BusinessRecordService(pool,identity,{...f.dependencies,events:{object:(db,owner,source,version,origin)=>events.appendBusinessSource(db,owner,source,version,origin)}})
 const owner=f.actor.ownerId,roles=new api.RoleService(pool,identity)
 let role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'业务观察员工',kind:'employee',scopes:[object.scope],duty:'核对本轮业务对象',dataScope:'原本人业务',executionScope:'只读',skills:[],knowledge:[],responsibility:(await import('./role-test-fixture.ts')).testRoleResponsibility,runtimeConfig:{agentPresetId:'worker'}}})
 const lifecycle=new api.RoleLifecycleService(pool,identity);role=(await lifecycle.change(owner,{roleId:role.id,expectedVersion:role.version,action:'pause',reason:'本人核准工具'})).role
 const tools=new api.RoleToolGrantService(pool,identity.now,async(_db,_owner,_role,rules)=>assert.deepEqual(rules,[{name:'get_goal',allowed:[{}]}]))
 const grant=await tools.change(owner,{roleId:role.id,expectedRoleVersion:role.version,action:'save',rules:[{name:'get_goal',allowed:[{}]}]})
 role=(await lifecycle.change(owner,{roleId:role.id,expectedVersion:grant.roleVersion,action:'resume',reason:'已核工具'})).role
 await new api.RoleDelegationService(pool,identity,ownerAuthority).change(owner,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,expectedVersion:null,action:'save',fields:{scope:object.scope,allowedTools:['get_goal'],knowledgeIds:[],memoryViewId:null,groupIds:[],safeRecovery:false}})
 const plans=new api.PlanService(pool,identity,undefined,ownerAuthority,undefined,readSource)
 const sourceRef={kind:'business-object' as const,scope:object.scope,type:object.type,id:object.id}
 const createPlan=async(observed=sourceRef)=>{
  const original=await plans.create(owner,{requestId:randomUUID(),fields:{title:'本对象变化跟进',goal:'核对对象当前状态',scope:object.scope,roleId:role.id,expectedRoleVersion:role.version,dataScope:'本对象原版本',delivery:'核对说明',notificationPolicy:'attention',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}},source:{kind:'manual'}})
  const configuration={completion:{kind:'manual'},triggers:[{kind:'local-event',eventKind:'business-object-version',sourceRef:observed,coalesce:'latest'}],budget:{maxGoalRounds:32,maxTokens:2000,maxElapsedMs:600000,maxConcurrent:1,maxRetries:3,stagnationRounds:3,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
  const configured=await plans.configureWorkConfirmed(owner,{requestId:randomUUID(),planId:original.id,expectedVersion:original.version,expectedConfigVersion:original.configVersion,configuration})
  const plan=await plans.changeConfirmed(owner,{requestId:randomUUID(),planId:original.id,expectedVersion:configured.version,action:'enable'})
  assert.equal(plan.workDefinition?.schema,'teloa.plan-work/v3');return plan
 }
 const plan=await createPlan(),occurrences=new api.PlanOccurrenceService(pool,identity,undefined,(db,owner,id)=>events.verifiedSourceInTransaction(db,owner,id))
 return {...f,owner,object,sourceRef,events,records,readSource,plans,plan,createPlan,role,occurrences,setOriginRun:(value:string)=>{originRun=value}}
}

test('业务复合来源精确合并；claim后变更拒绝派发；原Task准备/开始/提交复核同一版本且冻结原正文',async()=>{
 const f=await planFixture(),first=await f.records.edit(f.actor,{scope:f.object.scope,type:f.object.type,id:f.object.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'已联系'}]})
 const event1=(await f.events.pending(f.owner))[0]!
 assert.equal(event1.event.schema,'teloa.work-event/v2');assert.equal('sourceId' in event1.event,false)
 const second=await f.records.edit(f.actor,{scope:first.scope,type:first.type,id:first.id,expectedVersion:2,requestId:randomUUID(),fields:[{name:'state',value:'已确认'}]})
 let pending=await f.events.pending(f.owner);assert.equal(pending.length,1);assert.notEqual(pending[0]!.event.id,event1.event.id)
 const claimInput=(eventId:string)=>({planId:f.plan.id,definitionVersion:f.plan.configVersion,eventId,controlGeneration:1})
 assert.equal(await f.events.claim(f.owner,claimInput(event1.event.id)),null)
 await assert.rejects(f.events.claim('other',claimInput(pending[0]!.event.id)),{code:'teloa/forbidden'})
 const claim=await f.events.claim(f.owner,claimInput(pending[0]!.event.id));assert.ok(claim?.event)
 assert.equal(claim.event.event.sourceVersion,'3');assert.deepEqual(claim.event.data.object,second)
 const third=await f.records.edit(f.actor,{scope:first.scope,type:first.type,id:first.id,expectedVersion:3,requestId:randomUUID(),fields:[{name:'state',value:'待核对'}]})
 await assert.rejects(f.occurrences.dispatchTask(f.owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:identity.now()}),{code:'teloa/version-conflict'})
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,0)
 // 旧领取保持原件；新独立计划观察同一对象，走原 Task/Run 服务。
 const nextPlan=await f.createPlan(),fourth=await f.records.edit(f.actor,{scope:first.scope,type:first.type,id:first.id,expectedVersion:third.version,requestId:randomUUID(),fields:[{name:'state',value:'可处理'}]})
 pending=await f.events.pending(f.owner);const event=pending.find(row=>row.planId===nextPlan.id)!
 const next=await f.events.claim(f.owner,{planId:nextPlan.id,definitionVersion:nextPlan.configVersion,eventId:event.event.id,controlGeneration:1});assert.ok(next)
 const dispatched=await f.occurrences.dispatchTask(f.owner,{claimId:next.id,taskRequestId:next.taskRequestId,now:identity.now()})
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:f.owner,sessionId,status:'ready'})
 await new api.ObjectConversationService(pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:dispatched.task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new api.TaskRunService(pool,identity,inspect,{allowedTools:['get_goal'],planContext:(db,owner,id)=>f.occurrences.executionContext(db,owner,id)})
 const input={requestId:randomUUID(),taskId:dispatched.task.id,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId,expectedLinkVersion:1}
 const run=await runs.prepare(f.owner,input);assert.deepEqual(JSON.parse(run.inputText).planContext.event.data.object,fourth)
 await runs.claim(f.owner,{runId:run.id});await runs.record(f.owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'accepted'}})
 const db=await pool.connect();try{await db.query('begin');await runs.executionAdmissionInTransaction(db,f.owner,run.id);await db.query('commit')}finally{db.release()}
 await f.records.edit(f.actor,{scope:first.scope,type:first.type,id:first.id,expectedVersion:fourth.version,requestId:randomUUID(),fields:[{name:'state',value:'已变化'}]})
 await assert.rejects(runs.executionAdmission(f.owner,run.id),{code:'teloa/version-conflict'})
 const saved=await runs.get(f.owner,{runId:run.id});assert.equal(saved.inputText,run.inputText)
})

test('缺可信Run链的原生来源回滚；同Plan真实产物不自唤醒；撤回合并旧pending而不派发',async()=>{
 const f=await planFixture(),change=()=>({scope:f.object.scope,requestId:randomUUID(),operations:[{operation:'edit',type:f.object.type,id:f.object.id,expectedVersion:1,fields:[{name:'state',value:'原生写入'}]}]})
 await assert.rejects(f.records.batch(f.actor,change(),{sessionId:'unknown',messageId:'unverified',seq:1}),{code:'teloa/forbidden'})
 assert.equal((await f.records.get(f.actor,{scope:f.object.scope,type:f.object.type,id:f.object.id})).version,1)
 await f.records.batch(f.actor,change(),{sessionId:'verified-ordinary',messageId:'ordinary-tool',seq:2})
 assert.equal((await f.events.pending(f.owner)).length,1,'已核普通会话可写，但不猜造Plan来源')
 const edited=await f.records.edit(f.actor,{scope:f.object.scope,type:f.object.type,id:f.object.id,expectedVersion:2,requestId:randomUUID(),fields:[{name:'state',value:'待工作'}]})
 const event=(await f.events.pending(f.owner))[0]!,claim=await f.events.claim(f.owner,{planId:f.plan.id,definitionVersion:f.plan.configVersion,eventId:event.event.id,controlGeneration:1});assert.ok(claim)
 const task=await f.occurrences.dispatchTask(f.owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:identity.now()})
 const runId=await (await import('./role-work-test-fixture.ts')).insertRoleRun(pool,f.owner,f.role.id,task.task.id,'active');f.setOriginRun(runId)
 const memberId='call:'+randomUUID(),subagents=new api.TaskRunSubagentService(pool,identity)
 await subagents.reserve(f.owner,{runId,reservationId:memberId,limit:1})
 const childDb=await pool.connect();let childTask:Awaited<ReturnType<api.TaskService['createInTransaction']>>
 try{await childDb.query('begin');childTask=await new api.TaskService(pool,identity).createInTransaction(childDb,f.owner,{requestId:randomUUID(),fields:{title:'同计划子工作',goal:'核对固定对象',scope:f.object.scope},assignee:{roleId:f.role.id,expectedVersion:f.role.version}},{kind:'team-child',parentRunId:runId,memberId});await childDb.query('commit')}finally{childDb.release()}
 const childRun=await (await import('./role-work-test-fixture.ts')).insertRoleRun(pool,f.owner,f.role.id,childTask.id,'ended')
 await f.records.batch(f.actor,{scope:f.object.scope,requestId:randomUUID(),operations:[{operation:'edit',type:f.object.type,id:f.object.id,expectedVersion:edited.version,fields:[{name:'state',value:'本计划产物'}]}]},{sessionId:'verified-native',messageId:'tool-message',seq:7})
 assert.equal((await f.events.pending(f.owner)).filter(row=>row.planId===f.plan.id).length,0)
 f.setOriginRun(childRun)
 const childInput={scope:f.object.scope,requestId:randomUUID(),operations:[{operation:'edit',type:f.object.type,id:f.object.id,expectedVersion:edited.version+1,fields:[{name:'state',value:'同计划子工作产物'}]}]}
 await f.records.batch(f.actor,childInput,{sessionId:'verified-native',messageId:'child-tool-message',seq:9})
 assert.equal((await f.events.pending(f.owner)).filter(row=>row.planId===f.plan.id).length,0,'可信子Task继承同Plan，不得漏排自身产物')
 const result=await f.records.get(f.actor,{scope:f.object.scope,type:f.object.type,id:f.object.id})
 await f.records.edit(f.actor,{scope:result.scope,type:result.type,id:result.id,expectedVersion:result.version,requestId:randomUUID(),fields:[{name:'state',value:'新的本人修改'}]})
 assert.equal((await f.events.pending(f.owner)).length,1)
 await f.records.archive(f.actor,{scope:result.scope,type:result.type,id:result.id,expectedVersion:result.version+1,requestId:randomUUID()})
 assert.equal((await f.events.pending(f.owner)).length,0)
})

test('同步成功变更在原提交发可信事件；无变化和失败不冒成功；固定映射配置改变后旧事件失效',async()=>{
 const f=await fixture(true),owner=f.actor.ownerId,{WorkEventService}=await import('../src/work/work-events.ts'),{businessWorkSourceReader}=await import('../src/work/business-work-event-source.ts')
 const source={key:'fixture/declared-list',fetch:async()=>{if(failure)throw Error('本轮真实端口失败');return {capturedAt:identity.now(),items:[{state:state}]}}}
 let failure=false,state='待联系',events:InstanceType<typeof WorkEventService>
 const sync=new api.BusinessSyncService(pool,identity,f.dependencies.definitions,f.dependencies.warehouse,async()=>source,{sync:(db,owner,ref,version)=>events.appendBusinessSource(db,owner,ref,version)})
 const records=new api.BusinessRecordService(pool,identity,f.dependencies),readSource=businessWorkSourceReader({records,sync})
 events=new WorkEventService(pool,identity,{material:unavailable,business:readSource})
 const first=await sync.run(f.actor,{scope:f.input.scope,mappingId:'lead-sync',trigger:'manual'});assert.equal(first.status,'ok');assert.equal(first.upserted,1)
 const stored=(await pool.query('select event from teloa_work_events where owner_id=$1',[owner])).rows;assert.equal(stored.length,1);assert.equal(stored[0].event.sourceVersion,first.id)
 const second=await sync.run(f.actor,{scope:f.input.scope,mappingId:'lead-sync',trigger:'manual'});assert.equal(second.upserted,0)
 failure=true;const failed=await sync.run(f.actor,{scope:f.input.scope,mappingId:'lead-sync',trigger:'manual'});assert.equal(failed.status,'failed')
 assert.equal((await pool.query('select count(*)::int n from teloa_work_events where owner_id=$1',[owner])).rows[0].n,1)
 const db=await pool.connect();try{await db.query('begin');assert.equal((await events.verifiedSourceInTransaction(db,owner,stored[0].event.id)).event.id,stored[0].event.id);await db.query('rollback')}finally{db.release()}
 await f.updateConfiguration()
 const changed=await pool.connect();try{await changed.query('begin');await assert.rejects(events.verifiedSourceInTransaction(changed,owner,stored[0].event.id),{code:'teloa/forbidden'});await changed.query('rollback')}finally{changed.release()}
})

test('无内容变化仍保原+1回执且不唤醒；原事件依连续历史固定旧snapshot；中间真变化再改回与缺历史拒绝',async()=>{
 const f=await planFixture(),target={scope:f.object.scope,type:f.object.type,id:f.object.id},changed=await f.records.edit(f.actor,{...target,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'已联系'}]})
 const original=(await f.events.pending(f.owner))[0]!,noopInput={...target,expectedVersion:2,requestId:randomUUID(),fields:[{name:'state',value:'已联系'}]}
 const noop=await f.records.edit(f.actor,noopInput);assert.equal(noop.version,3);assert.deepEqual(await f.records.edit(f.actor,noopInput),noop)
 assert.equal((await f.events.pending(f.owner))[0]!.event.id,original.event.id)
 const claim=await f.events.claim(f.owner,{planId:f.plan.id,definitionVersion:f.plan.configVersion,eventId:original.event.id,controlGeneration:1});assert.ok(claim?.event)
 assert.equal(claim.event.event.sourceVersion,'2');assert.deepEqual(claim.event.data.object,changed)
 const dispatched=await f.occurrences.dispatchTask(f.owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:identity.now()})
 const conversationId=randomUUID(),sessionId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:f.owner,sessionId,status:'ready'})
 await new api.ObjectConversationService(pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:dispatched.task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new api.TaskRunService(pool,identity,inspect,{allowedTools:['get_goal'],planContext:(db,owner,id)=>f.occurrences.executionContext(db,owner,id)}),run=await runs.prepare(f.owner,{requestId:randomUUID(),taskId:dispatched.task.id,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId,expectedLinkVersion:1})
 assert.equal(JSON.parse(run.inputText).planContext.event.event.sourceVersion,'2')
 await f.records.edit(f.actor,{...target,expectedVersion:3,requestId:randomUUID(),fields:[{name:'state',value:'已联系'}]});await runs.claim(f.owner,{runId:run.id})
 await f.records.edit(f.actor,{...target,expectedVersion:4,requestId:randomUUID(),fields:[{name:'state',value:'中间真实改变'}]})
 await f.records.edit(f.actor,{...target,expectedVersion:5,requestId:randomUUID(),fields:[{name:'state',value:'已联系'}]})
 await assert.rejects(f.occurrences.revalidate(f.owner,{claimId:claim.id,taskRequestId:claim.taskRequestId}),{code:'teloa/version-conflict'})
 assert.equal((await runs.get(f.owner,{runId:run.id})).inputText,run.inputText)
 // 只在本临时库模拟既有保留策略已移除中间版本，不能把首尾同值当作连续证明。
 await pool.query('delete from teloa_business_snapshot_references where owner_id=$1 and scope_id=$2 and object_id=$3 and object_version=3',[f.owner,target.scope,target.id])
 await pool.query('delete from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_id=$3 and object_version=3',[f.owner,target.scope,target.id])
 const db=await pool.connect();try{await db.query('begin');await assert.rejects(f.events.verifiedSourceInTransaction(db,f.owner,original.event.id),{code:'teloa/source-unavailable'});await db.query('rollback')}finally{db.release()}
})

test('观察配置拒绝越范围来源；固定定义控制世代变化后不能开始原prepared Run',async()=>{
 const f=await planFixture()
 await assert.rejects(f.createPlan({...f.sourceRef,scope:'SOC'}),{code:'teloa/forbidden'})
 const edited=await f.records.edit(f.actor,{scope:f.object.scope,type:f.object.type,id:f.object.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'待执行'}]})
 const item=(await f.events.pending(f.owner))[0]!,claim=await f.events.claim(f.owner,{planId:f.plan.id,definitionVersion:f.plan.configVersion,eventId:item.event.id,controlGeneration:1});assert.ok(claim)
 const task=await f.occurrences.dispatchTask(f.owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:identity.now()})
 const conversationId=randomUUID(),sessionId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:f.owner,sessionId,status:'ready'})
 await new api.ObjectConversationService(pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:task.task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new api.TaskRunService(pool,identity,inspect,{allowedTools:['get_goal'],planContext:(db,owner,id)=>f.occurrences.executionContext(db,owner,id)}),run=await runs.prepare(f.owner,{requestId:randomUUID(),taskId:task.task.id,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId,expectedLinkVersion:1})
 assert.equal(JSON.parse(run.inputText).planContext.event.event.sourceVersion,String(edited.version))
 const controls=new api.WorkControlService(pool,identity,{ownerAuthority}),control=await controls.get(f.owner,{controlId:f.plan.workDefinition!.definitionControlId})
 await controls.change(f.owner,{requestId:randomUUID(),controlId:control.id,expectedVersion:control.version,scope:'definition',roundControlId:null,action:'pause'})
 await assert.rejects(runs.claim(f.owner,{runId:run.id}),{code:'teloa/version-conflict'})
 assert.equal((await runs.get(f.owner,{runId:run.id})).state,'prepared')
 assert.equal((await pool.query('select count(*)::int n from teloa_work_budget_reservations where owner_id=$1',[f.owner])).rows[0].n,0)
})
