import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import * as api from '../src/index.ts'
import {PlanService} from '../src/work/plans.ts'
import {readStoredTaskRun} from '../src/work/task-runs.ts'
let pool:Pool,container:StartedPostgreSqlContainer
const clock={id:randomUUID,now:()=>'2026-10-17T10:00:00.000Z'}
const schedule={kind:'schedule',cadence:'daily',weekday:1,time:'11:00',timezone:'Asia/Singapore'}
const configuration={completion:{kind:'manual'},triggers:[{kind:'schedule',schedule}],budget:{maxGoalRounds:4,maxTokens:10000,maxElapsedMs:600000,maxConcurrent:1,maxRetries:1,stagnationRounds:2,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
const policy={agentPresetId:'teloa-standard',allowedTools:['get_goal'],argumentRules:[{name:'get_goal',allowed:[{}]}],modelPolicy:{primary:{provider:'minimax',model:'MiniMax-M3',reasoningEffort:'high'}}}
const lease={assertCurrent(){}}
let sourceActive=true,confirmed=true
const authority={verifySource:async()=>{assert.equal(sourceActive,true,'原方法来源已撤回');return lease},capture:async()=>{assert.equal(confirmed,true,'必须本人确认');return {policy,admission:lease}},authorize:async()=>{assert.equal(confirmed,true,'必须本人确认');return lease}}
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').withPullPolicy({shouldPull:()=>false}).start();pool=new Pool({connectionString:container.getConnectionUri()});await api.initializeTeloaDatabase(pool)},{timeout:120000})
after(async()=>{await pool?.end();await stopTestContainer(container)})
function input(){return {requestId:randomUUID(),fields:{executor:{kind:'owner'},roleId:null,title:'每日核对方法',goal:'核对本人已授权资料并总结变化',scope:'general',dataScope:'本人已选择的资料',delivery:'变化与待确认项',trigger:schedule,notificationPolicy:'attention'},configuration,intent:'save-paused',source:{kind:'method-reuse',artifactId:randomUUID(),version:1,basisHash:'a'.repeat(64),acceptedSource:{sessionId:'owner-source',messageId:randomUUID(),messageSeq:4,requestId:randomUUID()}}}}
async function sourceBackedInput(owner:string){
 const request=input(),source={kind:'session' as const,id:'fixed-method-source',scope:'general',version:'4',title:'原固定行动单'},content={title:'周会行动单',sections:[{id:'actions',title:'行动清单',text:'小林回访，截止2026-10-22；阿文预算复核，截止2026-10-21。'},{id:'risks',title:'风险与下一步',text:'总预算12000，已支出4500，剩余7500；完成状态未知。'}],snapshotIds:[],note:'仅合成资料'}
 const artifact=await new api.ArtifactService(pool,clock,async(_owner,expected)=>({source:expected,sessionIds:[expected.id]})).create(owner,{requestId:randomUUID(),source,content})
 const {methodReuseBasisHash}=await import('@teloa/contract')
 return {...request,source:{...request.source,artifactId:artifact.artifactId,version:artifact.number,basisHash:await methodReuseBasisHash(artifact)}}
}
test('本人能保存暂停且可幂等读回的 Plan，不创建员工，普通保存不产生领取或 Run',async()=>{const owner=randomUUID(),service=new PlanService(pool,clock,undefined,undefined,undefined,undefined,authority),request=input(),plan=await service.createConfirmed(owner,request);assert.equal(plan.state,'paused');assert.equal(plan.roleId,null);assert.equal(plan.roleVersion,null);assert.deepEqual(plan.executor,{kind:'owner',grantId:plan.id,grantVersion:1});assert.equal(plan.workDefinition?.schema,'teloa.plan-work/v3');assert.deepEqual(await service.createConfirmed(owner,request),plan);assert.equal((await pool.query('select count(*)::int n from teloa_roles where owner_id=$1',[owner])).rows[0].n,0);assert.equal((await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1',[owner])).rows[0].n,0)})

test('本人明确启用后沿原日程领取、Task及固定owner Run；暂停或来源撤回在派发前拒绝',async()=>{
 sourceActive=true;confirmed=true
 const owner=randomUUID(),service=new PlanService(pool,clock,undefined,undefined,undefined,undefined,authority),request=await sourceBackedInput(owner)
 const saved=await service.createConfirmed(owner,request),enable={requestId:randomUUID(),planId:saved.id,expectedVersion:saved.version,action:'enable'}
 await assert.rejects(service.change(owner,enable),{code:'teloa/forbidden'})
 confirmed=false;await assert.rejects(service.changeConfirmed(owner,enable),/必须本人确认/);confirmed=true
 const plan=await service.changeConfirmed(owner,enable),{PlanOccurrenceService}=await import('../src/work/plan-occurrences.ts'),occurrences=new PlanOccurrenceService(pool,clock,undefined,undefined,authority)
 await occurrences.recover(owner,{planId:plan.id,now:clock.now()})
 const claim=(await occurrences.claim(owner,{planId:plan.id,now:'2026-10-18T03:00:00.000Z'})).occurrence
 assert.ok(claim);assert.equal(claim.fields.roleId,null);assert.equal(claim.taskRequest.assignee,undefined)
 const dispatched=await occurrences.dispatchTask(owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:clock.now()})
 assert.equal(dispatched.task.assigneeRoleId,null);assert.deepEqual(dispatched.task.executor,plan.executor)
 const sessionId='task-run-'+randomUUID(),conversationId=randomUUID(),inspect=async(actor:string,id:string)=>({id:conversationId,ownerId:actor,sessionId:id,status:'ready'})
 await new api.ObjectConversationService(pool,inspect,clock.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:dispatched.task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new api.TaskRunService(pool,clock,inspect,{allowedTools:[],ownerPlans:authority,planContext:(db,actor,taskId,completion,includeMethodSource)=>occurrences.executionContext(db,actor,taskId,completion,includeMethodSource)})
 assert.deepEqual((await runs.preparationTarget(owner,{taskId:dispatched.task.id,expectedTaskVersion:1})).executor,plan.executor)
 const command={requestId:claim.id,taskId:dispatched.task.id,expectedTaskVersion:1,executor:plan.executor,sessionId,expectedLinkVersion:1}
 await assert.rejects(runs.prepareOwner(owner,command,{...policy,allowedTools:['outside']}),{code:'teloa/invalid-input'})
 const run=await runs.prepareOwner(owner,command,policy);assert.equal(JSON.parse(run.inputText).planContext.occurrenceId,claim.id);assert.equal(JSON.parse(run.inputText).planContext.methodSource.artifactId,request.source.artifactId);assert.equal(JSON.parse(run.inputText).planContext.methodSource.content.sections[0].text,'小林回访，截止2026-10-22；阿文预算复核，截止2026-10-21。');assert.equal(JSON.parse(run.inputText).planContext.methodSource.basisHash,request.source.basisHash)
 const pre=await pool.connect();try{await pre.query('begin');await assert.rejects(runs.executionScopeInTransaction(pre,owner,{runId:run.id,mode:'completion'}),{code:'teloa/conflict'});await pre.query('rollback')}finally{pre.release()}
 sourceActive=false;await assert.rejects(runs.claim(owner,{runId:run.id}),/原方法来源已撤回/);sourceActive=true
 const paused=await service.change(owner,{requestId:randomUUID(),planId:plan.id,expectedVersion:plan.version,action:'pause'})
 assert.equal(paused.state,'paused');await assert.rejects(runs.claim(owner,{runId:run.id}),{code:'teloa/forbidden'})
 assert.equal((await runs.get(owner,{runId:run.id})).state,'prepared')
 assert.equal((await pool.query('select count(*)::int n from teloa_roles where owner_id=$1',[owner])).rows[0].n,0)
})

test('本人 Plan 固定模型和工具沿原 Run 受理、结束及人工等待，原 Task/Run/领取唯一且重建可读',async()=>{
 sourceActive=true;confirmed=true
 const owner=randomUUID(),plans=new PlanService(pool,clock,undefined,undefined,undefined,undefined,authority),request={...await sourceBackedInput(owner),intent:'create-and-enable'},plan=await plans.createConfirmed(owner,request)
 const {PlanOccurrenceService}=await import('../src/work/plan-occurrences.ts'),occurrences=new PlanOccurrenceService(pool,clock,undefined,undefined,authority),trigger={requestId:randomUUID(),planId:plan.id,expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,now:clock.now()}
 const claim=(await occurrences.trigger(owner,trigger)).occurrence
 assert.equal((await occurrences.trigger(owner,trigger)).occurrence.id,claim.id)
 const {task}=await occurrences.dispatchTask(owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:clock.now()})
 const sessionId='owner-plan-'+randomUUID(),conversationId=randomUUID(),inspect=async(actor:string,id:string)=>({id:conversationId,ownerId:actor,sessionId:id,status:'ready'})
 await new api.ObjectConversationService(pool,inspect,clock.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new api.TaskRunService(pool,clock,inspect,{allowedTools:[],ownerPlans:authority,planContext:(db,actor,id,completion,includeMethodSource)=>occurrences.executionContext(db,actor,id,completion,includeMethodSource)}),command={requestId:claim.id,taskId:task.id,expectedTaskVersion:1,executor:plan.executor,sessionId,expectedLinkVersion:1}
 await assert.rejects(runs.prepareOwner(owner,command,{...policy,modelPolicy:{primary:{provider:'other',model:'wrong'}}}),{code:'teloa/forbidden'})
 const run=await runs.prepareOwner(owner,command,policy)
 const pending=await occurrences.pendingExecutions(owner,{limit:50});assert.deepEqual(pending.items[0]?.job.executor,plan.executor)
 assert.equal((await runs.claim(owner,{runId:run.id})).dispatch,true)
 assert.equal((await runs.claim(owner,{runId:run.id})).dispatch,false)
 await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'accepted'}})
 await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 const pausedAfterCompletion=await plans.change(owner,{requestId:randomUUID(),planId:plan.id,expectedVersion:plan.version,action:'pause'})
 assert.equal(pausedAfterCompletion.state,'paused')
 const completed=(await runs.get(owner,{runId:run.id}));assert.equal(completed.evidence?.state,'ended')
 const {taskArtifactSource}=await import('../src/work/artifact-task-source.ts'),source=await taskArtifactSource(pool,owner,task.id,false)
 const wrongProof=await pool.connect();try{await wrongProof.query('begin');await assert.rejects(occurrences.executionContext(wrongProof,owner,task.id,{kind:'completed-run',runId:run.id,nativeRequestId:randomUUID()}),{code:'teloa/forbidden'});await wrongProof.query('rollback')}finally{wrongProof.release()}
 const artifacts=new api.ArtifactService(pool,clock,async(actor,expected,db)=>{await runs.executionScopeInTransaction(db,actor,{runId:run.id,mode:'completion'});return {source:await taskArtifactSource(db,actor,expected.id,true),sessionIds:[sessionId]}})
 const artifactInput={requestId:api.workRequestChildId(run.id,'owner-artifact'),source,content:{title:source.title,sections:[{id:'result',title:'本轮成果',text:'原已受理 Run 的唯一合成结果'}],snapshotIds:[],note:'待本人核对'}}
 sourceActive=false;await assert.rejects(artifacts.create(owner,artifactInput),/原方法来源已撤回/);sourceActive=true
 const artifact=await artifacts.create(owner,artifactInput);assert.deepEqual(await artifacts.create(owner,artifactInput),artifact)
 await runs.ownerResultPublished(owner,run.id)
 await assert.rejects(occurrences.trigger(owner,{...trigger,requestId:randomUUID(),expectedVersion:pausedAfterCompletion.version}),{code:'teloa/forbidden'})
 const db=await pool.connect();try{await db.query('begin');await assert.rejects(runs.executionAdmissionInTransaction(db,owner,run.id),{code:'teloa/forbidden'});await db.query('rollback')}finally{db.release()}
 assert.equal((await new api.TaskService(pool,clock).list(owner,{}))[0]?.state,'waiting')
 assert.equal((await new api.TaskRunService(pool,clock,inspect).get(owner,{runId:run.id})).evidence?.state,'ended')
 assert.equal((await pool.query('select count(*)::int n from teloa_roles where owner_id=$1',[owner])).rows[0].n,0)
 assert.equal((await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1',[owner])).rows[0].n,1)
 assert.equal((await occurrences.executionHistory(owner,{planId:plan.id,limit:50})).items[0]?.run?.id,run.id)
 assert.deepEqual(await plans.createConfirmed(owner,request),plan)
 // 人工认可复用原正式completion，不编造accepted native消息；策略由同一事务读原producer Run。
 await new api.TaskTransitions(pool,clock).change(owner,{requestId:randomUUID(),taskId:task.id,expectedVersion:3,action:'complete',artifact:{id:artifact.artifactId,version:artifact.number},note:'本人认可这份固定成果'})
 const methods=new api.MethodReuseService(pool,clock,{artifacts,drafts:new api.PageCreateDraftService(pool,clock),assertSourceCurrent:async()=>{throw Error('人工completion不能误走旧Task版本当前来源')},readAcceptedMessage:async()=>{throw Error('人工认可不得伪造消息')},prepareBody:async()=>{throw Error('这里只核已有来源') }}),fixed=await methods.readSource(owner,{artifactId:artifact.artifactId,version:artifact.number})
 let captured=false
 const manualAuthority={...authority,verifySource:async(db:import('pg').PoolClient,who:string,value:import('../src/work/owner-plan-authority.ts').OwnerPlanSource)=>{const {kind,acceptedSource,...source}=value;assert.equal(acceptedSource,undefined);await methods.assertPlanSourceInTransaction(db,who,{source});return lease},capture:async(who:string,_input:unknown,db:import('pg').PoolClient)=>{const stored=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 and task_id=$3',[who,run.id,task.id])).rows[0],producer=readStoredTaskRun(stored);assert.equal(producer.evidence?.state,'ended');assert.ok(producer.modelPolicy&&producer.agentPresetId);captured=true;return {policy:{allowedTools:producer.allowedTools,argumentRules:producer.argumentRules!,modelPolicy:producer.modelPolicy,agentPresetId:producer.agentPresetId},admission:lease}}}
 const manualPlans=new PlanService(pool,clock,undefined,undefined,undefined,undefined,manualAuthority),manualInput={...input(),source:{kind:'method-reuse',...fixed.source}}
 await assert.rejects(manualPlans.createConfirmed(owner,{...manualInput,source:{...manualInput.source,taskId:randomUUID()}}),{code:'teloa/forbidden'});assert.equal(captured,false)
 const manual=await manualPlans.createOwnerConfirmed(owner,manualInput);assert.equal(manual.state,'paused');assert.equal(manual.ownerGrant?.source,undefined);assert.equal(captured,true)
 const active=await manualPlans.changeConfirmed(owner,{requestId:randomUUID(),planId:manual.id,expectedVersion:manual.version,action:'enable'})
 const {OwnerWorkAuthority}=await import('../src/work/owner-work-authority.ts'),currentDb=await pool.connect()
 try{await currentDb.query('begin');const grant=await new OwnerWorkAuthority(pool,manualAuthority).current(currentDb,owner,active.executor!);assert.equal(grant.source,undefined);assert.equal(grant.plan?.planId,active.id);await currentDb.query('commit')}finally{currentDb.release()}
})
test('暂停配置换代沿原预算账户，原创建/配置/启用回执固定；旧来源与旧授权不能复活',async()=>{
 sourceActive=true;confirmed=true
 const owner=randomUUID(),plans=new PlanService(pool,clock,undefined,undefined,undefined,undefined,authority),request=input(),original=await plans.createConfirmed(owner,request)
 const nextConfiguration={...configuration,budget:{...configuration.budget,maxTokens:12000}},configure={requestId:randomUUID(),planId:original.id,expectedVersion:1,expectedConfigVersion:1,configuration:nextConfiguration}
 const plan=await plans.configureWorkConfirmed(owner,configure)
 assert.equal(plan.configVersion,2);assert.equal(plan.executor?.grantVersion,2);assert.equal(plan.workDefinition?.budgetAccountId,original.workDefinition?.budgetAccountId)
 assert.deepEqual(await plans.configureWorkConfirmed(owner,configure),plan);assert.deepEqual(await plans.createConfirmed(owner,request),original)
 const {OwnerWorkAuthority}=await import('../src/work/owner-work-authority.ts')
 await assert.rejects(new OwnerWorkAuthority(pool,authority).assertCurrent(owner,original.executor!,'prepare'),{code:'teloa/forbidden'})
 const enable={requestId:randomUUID(),planId:plan.id,expectedVersion:plan.version,action:'enable'},active=await plans.changeConfirmed(owner,enable)
 const db=await pool.connect();let grant;try{await db.query('begin');grant=await new OwnerWorkAuthority(pool,authority).current(db,owner,active.executor!);await db.query('commit')}finally{db.release()}
 assert.equal(active.state,'active')
 const paused=await plans.change(owner,{requestId:randomUUID(),planId:active.id,expectedVersion:active.version,action:'pause'})
 assert.throws(()=>grant!.admission.assertCurrent(),{code:'teloa/forbidden'})
 assert.deepEqual(await plans.changeConfirmed(owner,enable),active)
 assert.equal((await plans.get(owner,{planId:active.id})).state,'paused')
 sourceActive=false
 await assert.rejects(plans.changeConfirmed(owner,{requestId:randomUUID(),planId:paused.id,expectedVersion:paused.version,action:'enable'}),/原方法来源已撤回/)
 sourceActive=true
})
test('owner 标记不能扩大业务、群、观察源或伪造本人确认；旧无员工null不是owner',async()=>{
 sourceActive=true;confirmed=true
 const owner=randomUUID(),plans=new PlanService(pool,clock,undefined,undefined,undefined,undefined,authority),request=input()
 for(const patch of [{scope:'SOC'},{groupId:randomUUID()},{roleId:randomUUID()}])await assert.rejects(plans.createConfirmed(owner,{...request,requestId:randomUUID(),fields:{...request.fields,...patch}}),{code:'teloa/forbidden'})
 await assert.rejects(plans.createConfirmed(owner,{...request,requestId:randomUUID(),configuration:{...configuration,triggers:[{kind:'local-event',eventKind:'material-version',sourceId:randomUUID(),coalesce:'latest'}]}}),{code:'teloa/forbidden'})
 confirmed=false;await assert.rejects(plans.createConfirmed(owner,request),/必须本人确认/);confirmed=true
 assert.equal((await pool.query('select count(*)::int n from teloa_plans where owner_id=$1',[owner])).rows[0].n,0)
 const plan=await plans.createConfirmed(owner,request)
 await assert.rejects(pool.query('update teloa_plans set owner_grant=null where id=$1',[plan.id]),/teloa_plans_executor_check/)
 await assert.rejects(pool.query("update teloa_plans set definition=definition-'executor' where id=$1",[plan.id]),/teloa_plans_executor_check/)
 await api.initializePlans(pool)
 assert.equal((await plans.get(owner,{planId:plan.id})).roleId,null)
})
test('计划领取按同一规范请求指纹核对：默认 groupId/skills 显式与省略同一请求，非默认值、负责人、owner 与 requestId 篡改仍拒绝',async()=>{
 sourceActive=true;confirmed=true
 const owner=randomUUID(),plans=new PlanService(pool,clock,undefined,undefined,undefined,undefined,authority),base=await sourceBackedInput(owner)
 const plan=await plans.createConfirmed(owner,{...base,fields:{...base.fields,groupId:null},intent:'create-and-enable'})
 const {PlanOccurrenceService}=await import('../src/work/plan-occurrences.ts'),occurrences=new PlanOccurrenceService(pool,clock,undefined,undefined,authority)
 const claim=(await occurrences.trigger(owner,{requestId:randomUUID(),planId:plan.id,expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,now:clock.now()})).occurrence
 assert.equal(claim.taskRequest.fields.groupId,null)
 const dispatch={claimId:claim.id,taskRequestId:claim.taskRequestId,now:clock.now()},{task}=await occurrences.dispatchTask(owner,dispatch)
 const stored=(await pool.query('select request_spec from teloa_tasks where id=$1',[task.id])).rows[0].request_spec
 assert.equal(Object.hasOwn(stored.fields,'groupId'),false);assert.equal(Object.hasOwn(stored.fields,'skills'),false)
 assert.equal((await occurrences.dispatchTask(owner,dispatch)).task.id,task.id)
 const context=async()=>{const db=await pool.connect();try{await db.query('begin');return await occurrences.executionContext(db,owner,task.id)}finally{await db.query('rollback');db.release()}}
 const accepted=async()=>{
  assert.equal((await context())?.occurrenceId,claim.id)
  const history=await occurrences.executionHistory(owner,{planId:plan.id,limit:50});assert.equal(history.errors,undefined);assert.equal(history.items.find(item=>item.claimId===claim.id)?.task?.id,task.id)
  const pending=await occurrences.pendingExecutions(owner,{limit:50});assert.equal(pending.errors,undefined);assert.equal(pending.items.find(item=>item.job.claimId===claim.id)?.job.taskId,task.id)
 }
 await accepted()
 // 任务侧沿同一规范函数：显式 groupId:null/skills:[] 与省略是同一请求，非空 skills 是不同请求。
 const tasks=new api.TaskService(pool,clock),requestId=randomUUID(),fields={title:'规范请求',goal:'核对默认字段表示',scope:'general'}
 const explicit=await tasks.create(owner,{requestId,fields:{...fields,groupId:null,skills:[]}})
 assert.equal((await tasks.create(owner,{requestId,fields})).id,explicit.id)
 await assert.rejects(tasks.create(owner,{requestId,fields:{...fields,skills:['other-skill']}}),{code:'teloa/conflict'})
 for(const tampered of [{...stored,fields:{...stored.fields,groupId:randomUUID()}},{...stored,fields:{...stored.fields,skills:['tampered-skill']}},{...stored,assignee:{roleId:randomUUID(),expectedVersion:1}}]){
  await pool.query('update teloa_tasks set request_spec=$2::jsonb where id=$1',[task.id,JSON.stringify(tampered)])
  await assert.rejects(context(),{code:'teloa/storage-corrupt'})
  assert.ok((await occurrences.executionHistory(owner,{planId:plan.id,limit:50})).errors?.some(error=>error.claimId===claim.id))
  assert.ok((await occurrences.pendingExecutions(owner,{limit:50})).errors?.some(error=>error.claimId===claim.id))
  await assert.rejects(occurrences.linkTask(owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,taskId:task.id}),{code:'teloa/conflict'})
 }
 await pool.query('update teloa_tasks set request_spec=$2::jsonb where id=$1',[task.id,JSON.stringify(stored)])
 await accepted()
 await assert.rejects(occurrences.dispatchTask(randomUUID(),dispatch))
 await assert.rejects(occurrences.dispatchTask(owner,{...dispatch,taskRequestId:randomUUID()}))
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[owner])).rows[0].n,2)
})
test('启用后暂停的本人计划仅经明确重配置路径接受 paused 定义控制；ending/ended 与 owner/来源/预算/绑定不符仍拒绝，启用、领取与执行准入不把 paused 当 active',async()=>{
 sourceActive=true;confirmed=true
 const {WorkControlService}=await import('../src/work/work-control.ts'),{OwnerWorkAuthority}=await import('../src/work/owner-work-authority.ts'),{PlanOccurrenceService}=await import('../src/work/plan-occurrences.ts')
 const plans=new PlanService(pool,clock,undefined,undefined,undefined,undefined,authority),occurrences=new PlanOccurrenceService(pool,clock,undefined,undefined,authority)
 const controls=new WorkControlService(pool,clock,{ownerAuthority:{authorize:async()=>({assertCurrent(){}})},inspectRun:async()=>({settled:true,unknownOperationIds:[]})})
 const enabled=async()=>{const owner=randomUUID(),created=await plans.createConfirmed(owner,await sourceBackedInput(owner)),active=await plans.changeConfirmed(owner,{requestId:randomUUID(),planId:created.id,expectedVersion:created.version,action:'enable'});return {owner,active,controlId:active.workDefinition!.definitionControlId}}
 const control=async(owner:string,controlId:string,action:'pause'|'stop',settle=true)=>{const current=await controls.get(owner,{controlId}),changed=await controls.change(owner,{requestId:randomUUID(),controlId,expectedVersion:current.version,action,scope:'definition',roundControlId:null});return settle?controls.reconcile(owner,{controlId,generation:changed.generation}):changed}
 const state=async(owner:string,id:string)=>(await pool.query('select state from teloa_work_controls where owner_id=$1 and id=$2',[owner,id])).rows[0].state
 const pausePlan=(owner:string,plan:{id:string;version:number})=>plans.change(owner,{requestId:randomUUID(),planId:plan.id,expectedVersion:plan.version,action:'pause'})
 const configure=(owner:string,plan:{id:string;version:number;configVersion:number})=>plans.configureWorkConfirmed(owner,{requestId:randomUUID(),planId:plan.id,expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,configuration})
 // 正例：真实控制服务把定义控制推进到 paused；普通启用（恢复）仍要求 active，明确重配置换新 active 定义与 owner_grant。
 const a=await enabled(),aPaused=await pausePlan(a.owner,a.active);assert.equal((await control(a.owner,a.controlId,'pause')).state,'paused');assert.equal(await state(a.owner,a.controlId),'paused')
 await assert.rejects(plans.changeConfirmed(a.owner,{requestId:randomUUID(),planId:aPaused.id,expectedVersion:aPaused.version,action:'enable'}),{code:'teloa/forbidden'})
 const reconfigured=await configure(a.owner,aPaused)
 assert.equal(reconfigured.state,'paused');assert.equal(reconfigured.configVersion,aPaused.configVersion+1);assert.equal(reconfigured.executor?.grantVersion,aPaused.configVersion+1)
 assert.notEqual(reconfigured.workDefinition!.definitionControlId,a.controlId);assert.equal(await state(a.owner,a.controlId),'ended');assert.equal(await state(a.owner,reconfigured.workDefinition!.definitionControlId),'active')
 const grant=(await pool.query('select owner_grant from teloa_plans where owner_id=$1 and id=$2',[a.owner,aPaused.id])).rows[0].owner_grant;assert.deepEqual(grant.policy,(await authority.capture()).policy)
 assert.equal((await plans.changeConfirmed(a.owner,{requestId:randomUUID(),planId:reconfigured.id,expectedVersion:reconfigured.version,action:'enable'})).state,'active')
 // 反例：计划仍 active 而定义控制 paused 时，领取、立即运行与执行准入都不把 paused 当 active；重配置要求计划先暂停。
 const b=await enabled();assert.equal((await control(b.owner,b.controlId,'pause')).state,'paused')
 await assert.rejects(occurrences.claim(b.owner,{planId:b.active.id,now:'2026-10-18T03:00:00.000Z'}),{code:'teloa/forbidden'})
 await assert.rejects(occurrences.trigger(b.owner,{requestId:randomUUID(),planId:b.active.id,expectedVersion:b.active.version,expectedConfigVersion:b.active.configVersion,now:clock.now()}),{code:'teloa/forbidden'})
 const db=await pool.connect();try{await db.query('begin');await assert.rejects(new OwnerWorkAuthority(pool,authority).current(db,b.owner,b.active.executor!),{code:'teloa/forbidden'})}finally{await db.query('rollback');db.release()}
 await assert.rejects(configure(b.owner,b.active),{code:'teloa/conflict'})
 // ending/ended 定义控制一律拒绝重配置。
 const c=await enabled(),cPaused=await pausePlan(c.owner,c.active);assert.equal((await control(c.owner,c.controlId,'stop',false)).state,'stopping');assert.equal(await state(c.owner,c.controlId),'ending')
 await assert.rejects(configure(c.owner,cPaused),{code:'teloa/forbidden'})
 await controls.reconcile(c.owner,{controlId:c.controlId,generation:(await controls.get(c.owner,{controlId:c.controlId})).generation});assert.equal(await state(c.owner,c.controlId),'ended')
 await assert.rejects(configure(c.owner,cPaused),{code:'teloa/forbidden'})
 // paused 控制下 owner、来源、预算、绑定任一不符仍拒绝；恢复原值后才可重配置。
 const d=await enabled(),dPaused=await pausePlan(d.owner,d.active);await control(d.owner,d.controlId,'pause')
 await assert.rejects(configure(randomUUID(),dPaused))
 sourceActive=false;await assert.rejects(configure(d.owner,dPaused),/原方法来源已撤回/);sourceActive=true
 const account=dPaused.workDefinition!.budgetAccountId,policy=(await pool.query('select policy from teloa_work_budget_accounts where owner_id=$1 and id=$2',[d.owner,account])).rows[0].policy
 await pool.query('update teloa_work_budget_accounts set policy=$3 where owner_id=$1 and id=$2',[d.owner,account,JSON.stringify({...policy,maxTokens:policy.maxTokens+1})]);await assert.rejects(configure(d.owner,dPaused),{code:'teloa/forbidden'})
 await pool.query('update teloa_work_budget_accounts set policy=$3 where owner_id=$1 and id=$2',[d.owner,account,JSON.stringify(policy)])
 // 绑定为不可变谱系；仅测试内以 replica 模式模拟存储层篡改，验证重配置仍拒绝错配绑定。
 const tamper=async(value:string)=>{const client=await pool.connect();try{await client.query('begin');await client.query('set local session_replication_role=replica');await client.query('update teloa_work_plan_bindings set definition_control_id=$4 where owner_id=$1 and plan_id=$2 and config_version=$3',[d.owner,dPaused.id,dPaused.configVersion,value]);await client.query('commit')}catch(error){await client.query('rollback');throw error}finally{client.release()}}
 await tamper(randomUUID());await assert.rejects(configure(d.owner,dPaused),{code:'teloa/forbidden'});await tamper(d.controlId)
 assert.equal((await configure(d.owner,dPaused)).configVersion,dPaused.configVersion+1)
})
test('重配置后本人计划授权 v2 可建执行会话并通过准入；过期 v1、伪造 v3 在准入处拒绝，非法形状在会话与契约层拒绝，未重配置 v1 照常',async()=>{
 sourceActive=true;confirmed=true
 const {WorkControlService}=await import('../src/work/work-control.ts'),{OwnerWorkAuthority}=await import('../src/work/owner-work-authority.ts'),{PlanOccurrenceService}=await import('../src/work/plan-occurrences.ts'),{ConversationService,FileConversationRepository}=await import('../src/work/conversations.ts'),{isConversation}=await import('@teloa/contract'),{mkdtemp}=await import('node:fs/promises'),{tmpdir}=await import('node:os')
 const plans=new PlanService(pool,clock,undefined,undefined,undefined,undefined,authority),occurrences=new PlanOccurrenceService(pool,clock,undefined,undefined,authority)
 const controls=new WorkControlService(pool,clock,{ownerAuthority:{authorize:async()=>({assertCurrent(){}})},inspectRun:async()=>({settled:true,unknownOperationIds:[]})})
 const file=join(await mkdtemp(join(tmpdir(),'teloa-owner-grant-')),'conversations.json'),existing=new Set<string>(),host={create:async(id:string)=>{existing.add(id);return id},inspect:async(id:string)=>{if(!existing.has(id))throw Error('missing')}}
 const conversations=new ConversationService(new FileConversationRepository(file),host,{id:randomUUID,now:clock.now})
 const runs=new api.TaskRunService(pool,clock,async(actor:string,id:string)=>({id:randomUUID(),ownerId:actor,sessionId:id,status:'ready'}),{allowedTools:[],ownerPlans:authority,planContext:(db,actor,id,completion,includeMethodSource)=>occurrences.executionContext(db,actor,id,completion,includeMethodSource)})
 const dispatchFor=async(owner:string,plan:{id:string;version:number;configVersion:number})=>{const claim=(await occurrences.trigger(owner,{requestId:randomUUID(),planId:plan.id,expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,now:clock.now()})).occurrence;return (await occurrences.dispatchTask(owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:clock.now()})).task}
 const session=async(owner:string,task:{id:string},executor:unknown)=>conversations.createRun(owner,{requestId:randomUUID(),title:'本人计划执行'},{sessionId:'task-run-'+randomUUID(),taskId:task.id,taskVersion:1,roleId:null,roleVersion:null,agentPresetId:'teloa-standard',executor:executor as never})
 const admit=async(owner:string,executor:{kind:'owner';grantId:string;grantVersion:number})=>{const db=await pool.connect();try{await db.query('begin');return await new OwnerWorkAuthority(pool,authority).current(db,owner,executor)}finally{await db.query('rollback');db.release()}}
 // 正式重配置得到授权 v2：任务、执行会话、准备目标与准入都按当前计划授权通过。
 const owner=randomUUID(),created=await plans.createConfirmed(owner,await sourceBackedInput(owner)),enabled=await plans.changeConfirmed(owner,{requestId:randomUUID(),planId:created.id,expectedVersion:created.version,action:'enable'})
 const paused=await plans.change(owner,{requestId:randomUUID(),planId:enabled.id,expectedVersion:enabled.version,action:'pause'}),controlId=paused.workDefinition!.definitionControlId,current=await controls.get(owner,{controlId})
 await controls.reconcile(owner,{controlId,generation:(await controls.change(owner,{requestId:randomUUID(),controlId,expectedVersion:current.version,action:'pause',scope:'definition',roundControlId:null})).generation})
 const reconfigured=await plans.configureWorkConfirmed(owner,{requestId:randomUUID(),planId:paused.id,expectedVersion:paused.version,expectedConfigVersion:paused.configVersion,configuration})
 const active=await plans.changeConfirmed(owner,{requestId:randomUUID(),planId:reconfigured.id,expectedVersion:reconfigured.version,action:'enable'});assert.equal(active.executor?.grantVersion,2)
 const task=await dispatchFor(owner,active);assert.deepEqual(task.executor,active.executor)
 const v2=await session(owner,task,active.executor);assert.equal(v2.purpose,'task-run');assert.deepEqual(v2.run?.executor,active.executor);assert.equal(isConversation(v2),true)
 assert.equal((await new ConversationService(new FileConversationRepository(file),host,{id:randomUUID,now:clock.now}).bySession(owner,v2.sessionId))?.run?.executor?.grantVersion,2)
 assert.deepEqual((await runs.preparationTarget(owner,{taskId:task.id,expectedTaskVersion:1})).executor,active.executor)
 assert.equal((await admit(owner,{kind:'owner',grantId:active.id,grantVersion:2})).executor.grantVersion,2)
 for(const grantVersion of [1,3])await assert.rejects(admit(owner,{kind:'owner',grantId:active.id,grantVersion}),{code:'teloa/forbidden'})
 for(const grantVersion of [0,-1,1.5,'2'])await assert.rejects(session(owner,task,{kind:'owner',grantId:active.id,grantVersion}),{code:'teloa/invalid-input'})
 for(const grantVersion of [0,1.5,'2'])assert.equal(isConversation({...v2,run:{...v2.run,executor:{...v2.run!.executor,grantVersion}}}),false)
 // 未重配置计划仍是授权 v1，会话与准入照常。
 const other=randomUUID(),first=await plans.createConfirmed(other,await sourceBackedInput(other)),firstActive=await plans.changeConfirmed(other,{requestId:randomUUID(),planId:first.id,expectedVersion:first.version,action:'enable'});assert.equal(firstActive.executor?.grantVersion,1)
 const firstTask=await dispatchFor(other,firstActive),v1=await session(other,firstTask,firstActive.executor);assert.equal(v1.run?.executor?.grantVersion,1);assert.equal(isConversation(v1),true)
 assert.equal((await admit(other,{kind:'owner',grantId:firstActive.id,grantVersion:1})).executor.grantVersion,1)
})
