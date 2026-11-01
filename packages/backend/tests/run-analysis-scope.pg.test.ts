import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {execFileSync} from 'node:child_process'
import {mkdir,mkdtemp,rm,statfs,writeFile,readFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import type {ArtifactFile,GroupMessage,GroupRoutingDecision,MessageReference,DigitalRole} from '@teloa/contract'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {BusinessSpaceService} from '../src/work/business-spaces.ts'
import {BusinessScopeService} from '../src/work/business-scopes.ts'
import {RoleService} from '../src/work/roles.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {GroupAgentGrantService} from '../src/work/group-agent-grants.ts'
import {GroupAttachmentService} from '../src/work/group-attachments.ts'
import {GroupRoutingDecisionService} from '../src/work/group-routing-decisions.ts'
import {GroupRoutingOutboxService} from '../src/work/group-routing-outbox.ts'
import {GroupTaskService} from '../src/work/group-tasks.ts'
import {GroupRunMessageService} from '../src/work/group-run-messages.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {TaskService,readStoredTask} from '../src/work/tasks.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {HandoffService} from '../src/work/handoffs.ts'
import {TaskMaterialService} from '../src/work/task-materials.ts'
import {deriveOwnerTaskAnalysisScope} from '../src/work/owner-task-analysis-scope.ts'
import {TaskRunDriver} from '../../harness-dsh/src/task-run-driver.ts'
import {createTaskRunApi} from '../../client/ui-workbench/src/client/task-run-api.ts'
import {readRunGroupContext,runGroupContextHash,type RunGroupFilePorts} from '../src/work/task-run-group-context.ts'
import {ArtifactService} from '../src/work/artifacts.ts'
import {ArtifactSnapshotStore} from '../src/work/artifact-snapshots.ts'
import {taskArtifactSource,taskArtifactSessions} from '../src/work/artifact-task-source.ts'
import {ReferenceCatalog} from '@teloa/mcp-reference/catalog'
import {ResourceService} from '../src/capabilities/resources.ts'
import {RoleMemoryService} from '../src/work/role-memory.ts'
import {readRunSkills} from '../src/work/task-run-skills.ts'
import {GroupWorkInputService} from '../src/work/group-work-inputs.ts'
import {groupWorkContinuationRunRequestId,readRunAnalysisScope,runAnalysisNotice,WorkError} from '@teloa/contract'
import {deriveRunAnalysisScope,verifyRunAnalysisScope,assertRunAnalysisControls} from '../src/work/run-analysis-scope.ts'
import {GroupDeliveryRecoveryService} from '../src/work/group-delivery-recovery.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'
import {businessObjectSnapshotHash} from '../src/work/business-data.ts'
import {WorkControlService} from '../src/work/work-control.ts'
import {WorkRecoveryService} from '../src/work/work-recovery.ts'
import {preservePreparedRun,preparedMaintenanceControlsCurrent,type PreparedMaintenanceAudit} from '../src/work/prepared-maintenance.ts'
import {WorkRecoveryCoordinator} from '../../harness-dsh/src/work-recovery-coordinator.ts'

let container:StartedPostgreSqlContainer|undefined,pool:Pool,root:string|undefined
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:15000}).trim()
const previous={host:process.env.DOCKER_HOST,socket:process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE,ryuk:process.env.TESTCONTAINERS_RYUK_DISABLED}
async function space(){const value=await statfs(tmpdir());assert.ok(Number(value.bavail)*Number(value.bsize)>=20*1024**3+256*1024**2,'保持20GiB及本轮PG预算')}
before(async()=>{
 await space()
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 process.env.TESTCONTAINERS_RYUK_DISABLED='true'
 const image=docker('image','inspect','postgres:17-alpine','--format','{{.Id}}')
 container=await new PostgreSqlContainer('postgres:17-alpine').withPullPolicy({shouldPull:()=>false}).withTmpFs({'/var/lib/postgresql/data':'rw,size=128m'}).withResourcesQuota({memory:0.25}).start()
 assert.equal(docker('inspect',container.getId(),'--format','{{.Image}}'),image)
 assert.equal(Number(docker('inspect',container.getId(),'--format','{{.HostConfig.Memory}}')),256*1024**2)
 assert.equal(JSON.parse(docker('inspect',container.getId(),'--format','{{json .HostConfig.Tmpfs}}'))['/var/lib/postgresql/data'],'rw,size=128m')
 root=await mkdtemp(join(tmpdir(),'teloa-run-analysis-'))
 pool=new Pool({connectionString:container.getConnectionUri(),max:4})
 await initializeTeloaDatabase(pool,{businessSqlSecretPath:join(root,'reader.json')})
})
after(async()=>{
 await pool?.end();await stopTestContainer(container)
 if(container)assert.equal(docker('ps','-aq','--no-trunc','--filter','id='+container.getId()),'')
 if(root)await rm(root,{recursive:true,force:false})
 for(const [key,value] of [['DOCKER_HOST',previous.host],['TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE',previous.socket],['TESTCONTAINERS_RYUK_DISABLED',previous.ryuk]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value}
 await space()
 if(process.env.TELOA_RUN_ANALYSIS_TEST_OUTPUT_DIR)await writeFile(join(process.env.TELOA_RUN_ANALYSIS_TEST_OUTPUT_DIR,'owned-cleanup.json'),JSON.stringify({poolDrained:true,containerId:container?.getId(),ownContainerRemoved:true,ownTempRemoved:true,memoryBytes:268435456,tmpfsBytes:134217728,QA:0,models:0})+'\n',{flag:'wx'})
})

/** 本人独立交办与固定资料沿正式服务；native发送仅服务层回执，不调用模型。 */
async function standaloneFixture(count=7,fixed?:{bodies:string[];goal:string},deferAssignment=false,roleKind:DigitalRole['kind']='employee'){
 const owner=randomUUID(),human={ownerId:owner,kind:'human' as const,scopeIds:['general']}
 await new BusinessSpaceService(pool,identity).ensurePersonal(owner)
 const directory=join(root!,randomUUID());await mkdir(directory)
 const definitions=[]
 for(let i=0;i<count;i++){const file='source-'+i+'.md';await writeFile(join(directory,file),fixed?.bodies[i]??'合成固定材料 '+i+'，金额 '+(i+1)+'。');definitions.push({id:'source-'+i,title:'固定材料 '+i,file})}
 const catalog=new ReferenceCatalog(directory,definitions),resources=new ResourceService(pool,catalog,identity),materials=new TaskMaterialService(pool,identity),tasks=new TaskService(pool,identity,{authorize:async()=>({assertCurrent(){}})})
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{kind:roleKind,name:'独立复核员',scopes:['general'],duty:'只分析本人原文及固定资料并交付报告。',dataScope:'本人原文及固定资料。',executionScope:'不调用工具。',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'ptc-persistent'}}})
 const taskRequest={requestId:randomUUID(),fields:{title:'独立材料复核',goal:fixed?.goal??'仅分析随任务固定的资料，生成 Markdown 报告；不调用工具、不检查目录、不联网、不代本人验收。',scope:'general'},...(deferAssignment?{}:{assignee:{roleId:role.id,expectedVersion:role.version}})}
 let task=roleKind==='twin'&&!deferAssignment?await tasks.createConfirmed(owner,taskRequest):await tasks.create(owner,taskRequest)
 const selected=[]
 for(const item of (await catalog.list()).references){
  const draft=await resources.create(human,{requestId:randomUUID(),title:item.title,sourceId:item.id,sourceVersion:item.version,scopeIds:['general']})
  const resource=await resources.apply(human,{draftId:draft.id,expectedVersion:draft.version});selected.push(resource)
  task=(await materials.add(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,resourceId:resource.id,expectedResourceVersion:resource.version})).task
 }
 if(deferAssignment)task=(await new HandoffService(pool,identity).change(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,target:{kind:'role',roleId:role.id,expectedRoleVersion:role.version},note:'原任务和固定资料保持不变，交由当前负责人。'})).task
 const sessionId=randomUUID(),inspect=async()=>({id:sessionId,ownerId:owner,sessionId,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[],roleGrants:{validate:async rules=>assert.deepEqual(rules,[]),recheck:async(run,target,context)=>{
  const current=await resources.executionKnowledgeReferencesInTransaction(context.db,{...human,kind:'agent'},[target.scope],run.knowledge.map(item=>({id:item.id,version:item.version})))
  if(!isDeepStrictEqual(current,run.knowledge))throw new WorkError('teloa/version-conflict','执行资料已变化。')
 }}})
 const command={requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1}
 const prepare=()=>runs.prepare(owner,command,async()=>[],async()=>[],async(target,_role,db)=>resources.executionKnowledgeReferencesInTransaction(db,{...human,kind:'agent'},[target.scope],await materials.executionRefsInTransaction(db,owner,target.taskId,target.taskVersion)))
 return {owner,human,task,role,runs,prepare,command,selected,resources,tasks}
}
test('独立任务：正常恢复冻结当前控制世代，原lineage与七资料不改；暂停和旧scope不能借新世代执行',async()=>{
 const inputPath=process.env.TELOA_OWNER_ANALYSIS_FIXED_INPUT
 const captured=inputPath?JSON.parse(await readFile(inputPath,'utf8')) as {taskGoal:string;items:{text:string;sourceVersion:string;bytes:number}[]}:undefined
 if(captured){assert.equal(captured.items.length,7);for(const item of captured.items){assert.equal(sha(item.text),item.sourceVersion);assert.equal(Buffer.byteLength(item.text),item.bytes)}}
 const f=await standaloneFixture(7,captured?{bodies:captured.items.map(x=>x.text),goal:captured.taskGoal}:undefined,true)
 assert.equal(f.task.version,9);assert.equal(f.task.contentVersion,2)
 const lineage=await new WorkLineageService(pool,identity).read(f.owner,{taskId:f.task.id});assert.ok(lineage);assert.equal(lineage.controlGeneration,1)
 const authority={authorize:async()=>({assertCurrent(){}})},controls=new WorkControlService(pool,identity,{hostGeneration:()=>1,ownerAuthority:authority,inspectRun:async()=>({settled:true,unknownOperationIds:[]})}),recovery=new WorkRecoveryService(pool,identity,controls,{hostGeneration:()=>1,ownerAuthority:authority,authorizeResume:async()=>{throw Error('没有既有Run可恢复')},inspectCheckpoint:async()=>{throw Error('没有Run检查点')}})
 const current=await controls.get(f.owner,{controlId:lineage.roundControlId}),pausing=await controls.change(f.owner,{requestId:randomUUID(),controlId:current.id,expectedVersion:current.version,action:'pause',scope:'round',roundControlId:null}),paused=await controls.reconcile(f.owner,{controlId:current.id,generation:pausing.generation})
 assert.equal(paused.state,'paused');assert.equal(paused.generation,2);await assert.rejects(f.prepare(),{code:'teloa/forbidden'})
 const resumed=await recovery.resume(f.owner,{requestId:randomUUID(),controlId:current.id,expectedVersion:paused.version,candidateRunIds:[]});assert.equal(resumed.state,'active');assert.equal(resumed.generation,3)
 const run=await f.prepare();assert.ok(run.analysisScope?.kind==='owner-task-derived');assert.deepEqual(run.analysisScope.controls,[{id:current.id,generation:3}]);assert.equal(run.lineage!.controlGeneration,1);assert.deepEqual(run.allowedTools,[]);assert.equal(run.knowledge.length,7)
 assert.deepEqual(await new WorkLineageService(pool,identity).read(f.owner,{taskId:f.task.id}),lineage)
 if(captured)assert.deepEqual(run.knowledge.map(x=>x.sourceVersion),captured.items.map(x=>x.sourceVersion))
 const db=await pool.connect();try{await assertRunAnalysisControls(db,f.owner,run.analysisScope,run.id);await assert.rejects(assertRunAnalysisControls(db,f.owner,{...run.analysisScope,controls:[{id:current.id,generation:1}]},run.id));await assert.rejects(assertRunAnalysisControls(db,randomUUID(),run.analysisScope,run.id))}finally{db.release()}
 const nextPause=await controls.change(f.owner,{requestId:randomUUID(),controlId:current.id,expectedVersion:resumed.version,action:'pause',scope:'round',roundControlId:null}),nextPaused=await controls.reconcile(f.owner,{controlId:current.id,generation:nextPause.generation})
 // 结束旧准备占用后正常恢复本轮；不授予旧Run维护许可，它仍须被当前epoch拒绝。
 await f.runs.withdraw(f.owner,{runId:run.id});await recovery.resume(f.owner,{requestId:randomUUID(),controlId:current.id,expectedVersion:nextPaused.version,candidateRunIds:[]})
 const oldInput=run.inputText,check=await pool.connect();try{await assert.rejects(assertRunAnalysisControls(check,f.owner,run.analysisScope,run.id))}finally{check.release()}
 assert.equal((await f.runs.get(f.owner,{runId:run.id})).inputText,oldInput)
 f.command.requestId=randomUUID();const next=await f.prepare();assert.ok(next.analysisScope?.kind==='owner-task-derived');assert.deepEqual(next.analysisScope.controls,[{id:current.id,generation:5}]);assert.equal(next.lineage!.controlGeneration,1)
 await f.runs.claim(f.owner,{runId:next.id});(await f.runs.executionAdmission(f.owner,next.id)).assertCurrent()
 if(process.env.TELOA_RUN_ANALYSIS_TEST_OUTPUT_DIR)await writeFile(join(process.env.TELOA_RUN_ANALYSIS_TEST_OUTPUT_DIR,'owner-task-resumed-epoch.json'),JSON.stringify({sameSevenTexts:!!captured,sourceBytes:run.knowledge.reduce((n,x)=>n+Buffer.byteLength(x.text),0),taskVersion:run.taskVersion,contentVersion:2,originGeneration:1,scopeGeneration:3,oldScopeCannotFollowGeneration5:true,freshGeneration5ClaimAndAdmissionPassed:true,models:0})+'\n',{flag:'wx'})
})
test('独立任务：七份本人固定资料正常prepare、持久读验、claim与发送前复验，仍为真实零工具范围',async()=>{
 const f=await standaloneFixture(),run=await f.prepare(),scope=run.analysisScope
 assert.ok(scope?.kind==='owner-task-derived');assert.equal(run.groupContext,undefined);assert.equal(run.textCapability,undefined)
 assert.equal(scope.groupId,undefined);assert.equal(scope.dispatch,undefined);assert.equal(run.agentPresetId,'ptc-persistent')
 assert.equal(run.knowledge.length,7);assert.deepEqual(run.allowedTools,[]);assert.deepEqual(run.argumentRules,[])
 assert.equal((await f.runs.get(f.owner,{runId:run.id})).inputText,run.inputText)
 const views=await createTaskRunApi(async(method,input)=>{assert.equal(method,'task-runs/list');assert.deepEqual(input,{taskId:run.taskId});return [run]}).list(run.taskId)
 assert.deepEqual(views[0]!.analysisScope,scope,'现有客户端读取器按共享契约接受新来源，不改客户端源码')
 assert.equal((await f.prepare()).id,run.id,'幂等准备不新建Run')
 let sends=0
 const controls=new WorkControlService(pool,identity)
 const driver=new TaskRunDriver(f.runs,{controlState:async current=>(await controls.get(f.owner,{controlId:current.lineage!.roundControlId})).state,check:async()=>{},send:async current=>{sends++;assert.deepEqual(current.allowedTools,[]);assert.equal(current.knowledge.length,7);assert.equal(current.inputText,run.inputText);(await f.runs.executionAdmission(f.owner,current.id)).assertCurrent()},events:async()=>[],stop:async()=>{throw Error('本例不停止')}})
 assert.equal((await driver.start(f.owner,{runId:run.id},AbortSignal.timeout(10000))).state,'accepted')
 await driver.start(f.owner,{runId:run.id},AbortSignal.timeout(10000));assert.equal(sends,1)
 assert.equal(Number((await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows[0].n),1)
})
test('独立任务：撤回、资料变版和工作控制失效阻断claim与发送前准入，旧输入仍可读',async()=>{
 for(const mutation of ['withdraw','revision','control'] as const){
  const f=await standaloneFixture(1),run=await f.prepare()
  if(mutation==='withdraw')await f.resources.withdraw(f.human,{resourceId:f.selected[0]!.id,expectedVersion:1})
  // 自有隔离PG负例：模拟并发资料版本与控制世代失效；不改实际安装态。
  if(mutation==='revision')await pool.query('update teloa_resources set revision=revision+1 where id=$1',[f.selected[0]!.id])
  if(mutation==='control')await pool.query("update teloa_work_controls set state='paused',generation=generation+1 where owner_id=$1 and id=$2",[f.owner,run.lineage!.roundControlId])
  assert.equal((await f.runs.get(f.owner,{runId:run.id})).inputText,run.inputText)
  await assert.rejects(f.runs.claim(f.owner,{runId:run.id}))
  await assert.rejects(f.runs.executionAdmission(f.owner,run.id))
  assert.equal((await f.runs.get(f.owner,{runId:run.id})).state,'prepared')
 }
})
test('独立任务：已claim后资料撤回仍阻断模型输入准入，不沿旧scope继续发送',async()=>{
 const f=await standaloneFixture(1),run=await f.prepare(),claimed=await f.runs.claim(f.owner,{runId:run.id})
 assert.equal(claimed.dispatch,true);assert.equal(claimed.run.state,'submitting')
 await f.resources.withdraw(f.human,{resourceId:f.selected[0]!.id,expectedVersion:1})
 await assert.rejects(f.runs.executionAdmission(f.owner,run.id))
 const fixed=await f.runs.get(f.owner,{runId:run.id});assert.equal(fixed.state,'submitting');assert.equal(fixed.inputText,run.inputText)
})
test('独立任务：员工和本人分身仅分析原文也取得零执行工具范围，暂停仍阻断原scope',async()=>{
 for(const kind of ['employee','twin'] as const){
  const f=await standaloneFixture(0,undefined,false,kind),run=await f.prepare()
  assert.equal(run.analysisScope?.kind,'owner-task-derived');assert.deepEqual(run.knowledge,[])
  assert.deepEqual(run.allowedTools,[]);assert.deepEqual(run.argumentRules,[])
  assert.deepEqual(run.analysisScope?.kind==='owner-task-derived'?run.analysisScope.selfAuthorizedTools:undefined,kind==='twin'?['teloa_role_memory_propose']:undefined)
  assert.equal((await f.prepare()).id,run.id,'重复准备不新增Run')
  assert.equal((await f.runs.get(f.owner,{runId:run.id})).inputText,run.inputText)
  assert.equal((await f.runs.toolPolicy(f.owner,{sessionId:run.sessionId}))?.selfAuthorizedTools,undefined,'prepared不提前开放候选工具')
  assert.equal((await f.runs.claim(f.owner,{runId:run.id})).dispatch,true)
  ;(await f.runs.executionAdmission(f.owner,run.id)).assertCurrent()
  assert.deepEqual((await f.runs.toolPolicy(f.owner,{sessionId:run.sessionId}))?.selfAuthorizedTools,kind==='twin'?['teloa_role_memory_propose']:undefined)
  await assert.rejects(f.runs.get(randomUUID(),{runId:run.id}),{code:'teloa/forbidden'})
  const controls=new WorkControlService(pool,identity,{ownerAuthority:{authorize:async()=>({assertCurrent(){}})}}),current=await controls.get(f.owner,{controlId:run.lineage!.roundControlId})
  await controls.change(f.owner,{requestId:randomUUID(),controlId:current.id,expectedVersion:current.version,action:'pause',scope:'round',roundControlId:null})
  await assert.rejects(f.runs.executionAdmission(f.owner,run.id))
  assert.equal((await f.runs.toolPolicy(f.owner,{sessionId:run.sessionId}))?.selfAuthorizedTools,undefined)
  assert.equal((await f.runs.get(f.owner,{runId:run.id})).inputText,run.inputText,'暂停不改写历史输入')
 }
 const fixed=await standaloneFixture(1,undefined,false,'twin'),run=await fixed.prepare()
 assert.equal(run.analysisScope?.kind,'owner-task-derived');assert.equal(run.knowledge.length,1)
 await fixed.resources.withdraw(fixed.human,{resourceId:fixed.selected[0]!.id,expectedVersion:1})
 await assert.rejects(fixed.runs.claim(fixed.owner,{runId:run.id}),'本人分身同样受固定资料撤回约束')
})
test('本人分身候选许可：角色改版或改类拒绝执行但保留历史；旧scope不补许可',async()=>{
 for(const column of ['version','kind'] as const){
  const f=await standaloneFixture(0,undefined,false,'twin'),run=await f.prepare()
  await f.runs.claim(f.owner,{runId:run.id})
  // 本轮隔离PG负例模拟并发定义变化；原固定Run可读，发送与候选工具不得使用旧授权。
  await pool.query(column==='version'?'update teloa_roles set version=version+1 where owner_id=$1 and id=$2':"update teloa_roles set definition=jsonb_set(definition,'{kind}',to_jsonb('employee'::text)),version=version+1 where owner_id=$1 and id=$2",[f.owner,f.role.id])
  assert.equal((await f.runs.get(f.owner,{runId:run.id})).inputText,run.inputText)
  await assert.rejects(f.runs.executionAdmission(f.owner,run.id))
  assert.equal((await f.runs.toolPolicy(f.owner,{sessionId:run.sessionId}))?.selfAuthorizedTools,undefined)
 }
 const f=await standaloneFixture(0,undefined,false,'twin'),run=await f.prepare(),snapshot=JSON.parse(run.inputText)
 delete snapshot.analysisScope.selfAuthorizedTools;snapshot.analysisScope.notice=runAnalysisNotice
 const old=JSON.stringify(snapshot)
 await pool.query('update teloa_task_runs set input_text=$2 where id=$1',[run.id,old])
 assert.equal((await f.runs.get(f.owner,{runId:run.id})).inputText,old)
 await f.runs.claim(f.owner,{runId:run.id});(await f.runs.executionAdmission(f.owner,run.id)).assertCurrent()
 assert.equal((await f.runs.toolPolicy(f.owner,{sessionId:run.sessionId}))?.selfAuthorizedTools,undefined)
})
test('独立任务：错本人、资料来源缺失或伪群输入不取得分析范围，历史无scope不补权',async()=>{
 const f=await standaloneFixture(1),run=await f.prepare(),scope=run.analysisScope;assert.ok(scope?.kind==='owner-task-derived')
 await assert.rejects(f.runs.get(randomUUID(),{runId:run.id}),{code:'teloa/forbidden'})
 const raw=(await pool.query('select * from teloa_task_runs where id=$1',[run.id])).rows[0],{readStoredTaskRun}=await import('../src/work/task-runs.ts')
 const snapshot=JSON.parse(run.inputText)
 for(const changed of [{...snapshot,analysisScope:{...scope,ownerId:randomUUID()}},{...snapshot,analysisScope:{...scope,knowledgeSha256:'f'.repeat(64)}},{...snapshot,knowledge:{...snapshot.knowledge,contents:[]}},{...snapshot,analysisScope:{...scope,groupId:randomUUID()}}])assert.throws(()=>readStoredTaskRun({...raw,input_text:JSON.stringify(changed)}),{code:'teloa/storage-corrupt'})
 const db=await pool.connect()
 try{
  await db.query('begin')
  const lineage=run.lineage!,knowledge=run.knowledge
  assert.equal(await deriveOwnerTaskAnalysisScope(db,pool,f.owner,{...f.task,groupId:randomUUID()},f.role,lineage,knowledge),undefined)
  assert.equal(await deriveOwnerTaskAnalysisScope(db,pool,f.owner,f.task,f.role,{...lineage,parentRunId:randomUUID()},knowledge),undefined)
  await db.query('update teloa_task_materials set snapshot=jsonb_set(snapshot,\'{sourceVersion}\',to_jsonb($2::text)) where task_id=$1',[f.task.id,'e'.repeat(64)])
  await assert.rejects(verifyRunAnalysisScope(db,pool,f.owner,scope,undefined,lineage),{code:'teloa/forbidden'})
  await db.query('rollback')
 }finally{await db.query('rollback');db.release()}
 delete snapshot.analysisScope
 await pool.query('update teloa_task_runs set input_text=$2 where id=$1',[run.id,JSON.stringify(snapshot)])
 assert.equal((await f.runs.get(f.owner,{runId:run.id})).analysisScope,undefined)
 const driver=new TaskRunDriver(f.runs,{check:async()=>{},send:async()=>{throw Error('历史无scope不应发送')},events:async()=>[],stop:async()=>{throw Error('不停止')}})
 await assert.rejects(driver.start(f.owner,{runId:run.id},AbortSignal.timeout(5000)),{code:'teloa/conflict'})
})

/** 真实正式服务及PG；路由decision与native终态仅服务层夹具，不调用模型/SDK。 */
async function fixture(kind:'attachment'|'artifact'|'image'='attachment',groupResources=0,artifactFiles=2,rich=false,scopeOnly?:string){
 const owner=randomUUID(),roles=new RoleService(pool,identity),tasks=new TaskService(pool,identity),groups=new CollaborationService(pool,identity),grants=new GroupAgentGrantService(pool,identity.now)
 const scope=scopeOnly??'general',space=await new BusinessSpaceService(pool,identity).ensurePersonal(owner)
 if(scopeOnly)await BusinessScopeService.ensure(pool,owner,{scope,title:'本轮分析范围',kind:'domain',spaceId:space.id})
 const directory=join(root!,randomUUID());await mkdir(directory)
 const knowledgeText='核对金额时保留项目、数量和合计。',skillText='---\nname: amount-review\ndescription: 合成金额核对说明\n---\n先核对各项再汇总；这份说明不授予任何工具执行权限。'
 await writeFile(join(directory,'source.md'),knowledgeText)
 const catalog=new ReferenceCatalog(directory,[{id:'amount-reference',title:'金额说明',file:'source.md'}]),resources=new ResourceService(pool,catalog,identity),human={ownerId:owner,kind:'human' as const,scopeIds:[scope]}
 const draft=rich?await resources.create(human,{requestId:randomUUID(),title:'金额说明',sourceId:'amount-reference',sourceVersion:(await catalog.list()).references[0]!.version,scopeIds:[scope]}):undefined
 const knowledge=draft?await resources.apply(human,{draftId:draft.id,expectedVersion:draft.version}):undefined
 const skill=readRunSkills([{name:'amount-review',provider:'fixture-local',source:'local-method',description:'合成金额核对说明',content:skillText,sha256:sha(skillText)}])[0]!
 const fields={kind:'employee' as const,scopes:[scope],duty:'核对明确提供的合成资料。',dataScope:'本轮资料。',executionScope:'群内分析。',skills:rich?[skill.name]:[],knowledge:knowledge?[knowledge.id]:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}
 const a=await roles.create(owner,{requestId:randomUUID(),fields:{...fields,name:'编制A'}}),b=await roles.create(owner,{requestId:randomUUID(),fields:{...fields,name:'复核B'}})
 const memories=new RoleMemoryService(pool,identity),fixedMemories=new Map<string,Awaited<ReturnType<RoleMemoryService['confirm']>>>()
 if(rich)for(const role of [a,b]){const candidate=await memories.create(human,{requestId:randomUUID(),roleId:role.id,expectedRoleVersion:role.version,title:'核对习惯',markdown:'交付前复核原件的每项数量。',source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'role',scopeIds:[scope]}});fixedMemories.set(role.id,await memories.confirm(human,{requestId:randomUUID(),memoryId:candidate.id,expectedStateVersion:1}))}
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'输入原件交接',scope,announcement:'新合成资料。',memberRoleIds:[a.id,b.id],rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:false,mentionAllAllowed:false}}})
 const body='新合成物资：南场18份，北场27份。\n',stored=new Map<string,Buffer>()
 const ports:RunGroupFilePorts={readAttachmentBytes:async(file,maxBytes)=>{const bytes=stored.get(file.attachmentId);assert.ok(bytes);if('sha256:'+sha(bytes)!==file.attachmentId)throw Object.assign(Error('ATTACHMENT_CORRUPT'),{code:'ATTACHMENT_CORRUPT'});return bytes.subarray(0,maxBytes??bytes.length)}}
 let fileReference:MessageReference
 if(kind==='attachment'||kind==='image'){
  const attachments=new GroupAttachmentService(pool,identity,{saveFile:async(dataBase64,name)=>{const bytes=Buffer.from(dataBase64,'base64'),attachmentId='sha256:'+sha(bytes);stored.set(attachmentId,bytes);return {attachmentId,bytes:bytes.length,name}},saveImage:async dataBase64=>{const bytes=Buffer.concat([Buffer.from(dataBase64,'base64'),Buffer.from('\n')]),attachmentId='sha256:'+sha(bytes);stored.set(attachmentId,bytes);return {attachmentId,bytes:bytes.length,width:1,height:1,mediaType:'image/png'}},readBytes:async row=>{const bytes=stored.get(row.attachmentId);assert.ok(bytes);return bytes}})
  // 图片端口仅模拟宿主归一化元数据，不在本PG例中做图像解码/variant或视觉质量验收。
  const file=await attachments.upload(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,name:kind==='image'?'原图.png':'新原件.txt',mime:kind==='image'?'image/png':'text/plain',dataBase64:kind==='image'?'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0VYAAAAASUVORK5CYII=':Buffer.from(body).toString('base64')})
  fileReference={kind:'attachment',id:file.attachmentId,version:file.version}
 }else{
  const task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'固定文件来源',goal:'保留新合成文件。',scope}}),sessionId=randomUUID()
  const inspect=async()=>({id:sessionId,ownerId:owner,sessionId,status:'ready'})
  await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
  const store=new ArtifactSnapshotStore(pool),snapshotIds:string[]=[]
  for(let i=0;i<artifactFiles;i++){const text=body+'文件'+i,path='固定'+i+'.txt';snapshotIds.push(await store.save(owner,{schema:'teloa.file-snapshot/v1',sessionId,id:sha(sessionId+path),path,sha256:sha(text),bytes:Buffer.byteLength(text),capturedAt:identity.now(),contentBase64:Buffer.from(text).toString('base64')}))}
  const source=await taskArtifactSource(pool,owner,task.id,false)
  const saved=await new ArtifactService(pool,identity,async(actor,expected,db)=>({source:await taskArtifactSource(db,actor,expected.id,true),sessionIds:await taskArtifactSessions(db,actor,expected.id,true)})).create(owner,{requestId:randomUUID(),source,content:{title:'新固定成果',sections:[],snapshotIds,note:'仅本测试合成。'}})
  fileReference={kind:'artifact',id:saved.artifactId,version:saved.number}
 }
 const references:MessageReference[]=[]
 for(let i=0;i<groupResources;i++){const r=await groups.saveResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:'固定资料'+i,markdown:'新合成资料'+i});references.push({kind:'group-resource',id:r.id,version:r.version})}
 references.push(fileReference)
 const grant=async(role:DigitalRole,resources:MessageReference[])=>grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources,canPost:true,canAutoRun:true})
 await grant(a,references);await grant(b,references)
 const initial=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'@编制A 先按原件写初稿，然后请复核B独立核对同一原件。',mentions:[{roleId:a.id,expectedVersion:a.version}],references})
 const outbox=new GroupRoutingOutboxService(pool,identity),decisions=new GroupRoutingDecisionService(pool,identity)
 async function register(message:GroupMessage,role:DigitalRole){
  const decision:GroupRoutingDecision={kind:'routed',intent:'work',respond:[role.id],reactions:[],hops:message.authorId==='self'?0:1,candidateIds:[a.id,b.id],truncatedCandidates:false,stopMessageId:null,at:identity.now(),assignments:[{roleId:role.id,instructionRange:{start:0,end:message.text.length},...(scopeOnly?{businessTarget:{scope}}:{})}],workTarget:null}
  const items=await decisions.withTopicLock(owner,group.id,message.rootId??message.id,async db=>{await decisions.record(db,owner,{groupId:group.id,messageId:message.id,decision});return outbox.recordRecipients(db,owner,{groupId:group.id,messageId:message.id,decision,decisionVersion:1})})
  const item=items[0];assert.ok(item)
  const claimed=await outbox.claim(owner,{itemId:item.id,expectedLeaseGeneration:0}),created=await new GroupTaskService(pool,identity,tasks).create(owner,await outbox.taskInput(owner,{itemId:item.id}))
  assert.ok(claimed)
  await outbox.assertDispatch(owner,{itemId:item.id,leaseGeneration:claimed.leaseGeneration})
  return {item,claimed,created}
 }
 async function prepare(message:GroupMessage,role:DigitalRole,existing?:Awaited<ReturnType<typeof register>>,skipReserve=false){
  const {item,claimed,created}=existing??await register(message,role)
  await outbox.assertDispatch(owner,{itemId:item.id,leaseGeneration:claimed.leaseGeneration})
  const sessionId=randomUUID(),inspect=async()=>({id:sessionId,ownerId:owner,sessionId,status:'ready'})
  await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:created.task.id,expectedObjectVersion:created.task.version,sessionId,expectedLinkVersion:0,action:'link'})
  const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[],roleGrants:{validate:async rules=>assert.deepEqual(rules,[]),recheck:async(run,target)=>{const current=await resources.executionKnowledge({...human,kind:'agent'},[target.scope],run.knowledge.map(item=>item.id));assert.deepEqual(current,run.knowledge)}},roleMemory:(db,actor,target,currentRole,selectedIds)=>memories.confirmedForRun(db,actor,target,currentRole,undefined,selectedIds),groupContext:(db,actor,task,currentRole,refs,selection)=>readRunGroupContext(db,actor,task,currentRole,ports,pool,refs,selection)})
  const run=await runs.prepare(owner,{requestId:item.requestId,taskId:created.task.id,expectedTaskVersion:created.task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1},async(_id,currentRole)=>{assert.deepEqual(currentRole.skills,rich?[skill.name]:[]);return rich?[skill]:[]},async(target,currentRole)=>resources.executionKnowledge({...human,kind:'agent'},[target.scope],currentRole.knowledge))
  assert.equal(run.agentPresetId,'standard')
  if(!skipReserve)await outbox.reserveSubmission(owner,{itemId:item.id,leaseGeneration:claimed.leaseGeneration,taskId:created.task.id,runId:run.id})
  return {runs,run,item,claimed,created}
 }
 const parent=await prepare(initial,a);assert.equal(parent.run.groupContext?.files.length,kind==='artifact'?artifactFiles:1)
 await parent.runs.claim(owner,{runId:parent.run.id})
 await parent.runs.record(owner,{runId:parent.run.id,sessionId:parent.run.sessionId,nativeRequestId:parent.run.nativeRequestId,evidence:{state:'accepted'}})
 await parent.runs.record(owner,{runId:parent.run.id,sessionId:parent.run.sessionId,nativeRequestId:parent.run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}})
 await outbox.settle(owner,{itemId:parent.item.id,leaseGeneration:parent.claimed.leaseGeneration,taskId:parent.run.taskId,runId:parent.run.id,state:'settled',reason:null})
 const publisher=new GroupRunMessageService(pool,identity,undefined,ports,outbox),input={requestId:parent.run.nativeRequestId,runId:parent.run.id,text:'已按原件整理。@复核B 请独立核对原附件并给复核。'}
 return {owner,a,b,group,scope,initial,tasks,body,stored,ports,references,fileReference,grant,grants,groups,parent,publisher,input,prepare,register,outbox,memories,fixedMemories,resources,knowledge,human,skill}
}

test('可信本人文本附件自然派生分析scope，可信父回帖把完整正文交给B而不授工具',async()=>{
 const f=await fixture();assert.ok(f.parent.run.analysisScope);assert.equal(f.parent.run.textCapability,undefined)
 assert.deepEqual(f.parent.run.allowedTools,[]);assert.deepEqual(f.parent.run.knowledge,[]);assert.deepEqual(f.parent.run.skills,[])
 const text=('完整合成原稿🙂：逐项核对原件。\n'.repeat(700))+'最后一行也是原稿。'
 const posted=await f.publisher.post(f.owner,{...f.input,text}),child=await f.prepare(posted,f.b)
 assert.ok(child.run.analysisScope);assert.equal(child.run.analysisScope.parent?.text,text);assert.equal(child.run.analysisScope.parent?.sha256,sha(text))
 assert.equal(child.run.analysisScope.parent?.runId,f.parent.run.id);assert.equal(child.run.groupContext?.files[0]?.text,f.body)
 assert.equal(child.run.groupContext?.ownerRequest?.messageId,f.parent.run.groupContext?.ownerRequest?.messageId)
 await child.runs.claim(f.owner,{runId:child.run.id});assert.equal((await child.runs.get(f.owner,{runId:child.run.id})).state,'submitting')
 const policy=await child.runs.toolPolicy(f.owner,{sessionId:child.run.sessionId});assert.equal(policy?.textOnly,true);assert.deepEqual(policy?.allowedTools,[])
})

test('成果多文本文件保留原版本且可分析；B缺少授权不派生scope',async()=>{
 const f=await fixture('artifact'),posted=await f.publisher.post(f.owner,f.input),child=await f.prepare(posted,f.b)
 assert.equal(child.run.analysisScope?.files.length,2);assert.deepEqual(child.run.analysisScope?.files.map(x=>x.version),[1,1])
 const no=await fixture();await no.grant(no.b,[]);const output=await no.publisher.post(no.owner,no.input)
 await assert.rejects(no.prepare(output,no.b),{code:'teloa/forbidden'})
})

test('原件不再完整、本人归属错误或控制已换代均拒绝，旧Run不回填',async()=>{
 const f=await fixture(),posted=await f.publisher.post(f.owner,f.input),child=await f.prepare(posted,f.b)
 await assert.rejects(child.runs.get(randomUUID(),{runId:child.run.id}),{code:'teloa/forbidden'})
 await pool.query('update teloa_work_controls set generation=generation+1 where owner_id=$1 and id=$2',[f.owner,child.run.lineage!.roundControlId])
 await assert.rejects(child.runs.claim(f.owner,{runId:child.run.id}),{code:'teloa/forbidden'})
 assert.equal((await pool.query('select state from teloa_task_runs where owner_id=$1 and id=$2',[f.owner,child.run.id])).rows[0].state,'prepared')
 const old=await fixture(),row=(await pool.query('select input_text from teloa_task_runs where owner_id=$1 and id=$2',[old.owner,old.parent.run.id])).rows[0],input=JSON.parse(row.input_text)
 delete input.analysisScope // 本轮自有PG负例：模拟升级前没有scope的持久输入，不重写任何实际历史。
 await pool.query('update teloa_task_runs set input_text=$3 where owner_id=$1 and id=$2',[old.owner,old.parent.run.id,JSON.stringify(input)])
 assert.equal((await old.parent.runs.get(old.owner,{runId:old.parent.run.id})).analysisScope,undefined)
})

test('正常分析保留群授权资料、已确认经验与说明技能；经验撤回后拒绝旧固定输入',async()=>{
 const f=await fixture('attachment',1,2,true)
 assert.deepEqual(f.parent.run.skills,[f.skill]);assert.deepEqual(f.parent.run.knowledge,[],'岗位私有知识没有获得群授权，仍不得入模');assert.equal(f.parent.run.memory[0]?.id,f.fixedMemories.get(f.a.id)!.id)
 assert.equal(f.parent.run.groupContext?.materials[0]?.markdown,'新合成资料0');assert.equal(f.parent.run.groupContext?.materials[0]?.resourceVersion,1)
 const input=JSON.parse(f.parent.run.inputText);assert.deepEqual(input.skills,f.parent.run.skills);assert.equal(input.knowledge,undefined);assert.deepEqual(input.memory.contents,f.parent.run.memory)
 const posted=await f.publisher.post(f.owner,f.input),child=await f.prepare(posted,f.b)
 assert.equal(child.run.memory[0]?.id,f.fixedMemories.get(f.b.id)!.id);assert.deepEqual(child.run.allowedTools,[])
 await child.runs.executionAdmission(f.owner,child.run.id)
 const memory=f.fixedMemories.get(f.b.id)!
 await f.memories.withdraw(f.human,{requestId:randomUUID(),memoryId:memory.id,expectedStateVersion:memory.stateVersion})
 await assert.rejects(child.runs.claim(f.owner,{runId:child.run.id}),{code:'teloa/version-conflict'})
 assert.equal((await child.runs.get(f.owner,{runId:child.run.id})).state,'prepared','历史固定经验仍可读，但不得再发送')
})

test('同群固定资料撤权后发送准入拒绝；岗位私有知识仍不获得群授权',async()=>{
 const f=await fixture('attachment',1,2,true),posted=await f.publisher.post(f.owner,f.input),child=await f.prepare(posted,f.b)
 await child.runs.claim(f.owner,{runId:child.run.id})
 await child.runs.executionAdmission(f.owner,child.run.id)
 await f.grant(f.b,[f.fileReference])
 await assert.rejects(child.runs.executionAdmission(f.owner,child.run.id),{code:'teloa/forbidden'})
 const old=await child.runs.get(f.owner,{runId:child.run.id});assert.deepEqual(old.knowledge,[]);assert.equal(old.groupContext?.materials[0]?.resourceVersion,1)
})

for(const scopeOnly of [undefined,'j06-scope-continuation'])test('B同Task的本人返工保留完整交接、完整原稿与当前反馈，新Run仍为零工具'+(scopeOnly?'（scope-only）':''),async()=>{
 const f=await fixture('attachment',0,2,false,scopeOnly),posted=await f.publisher.post(f.owner,f.input),child=await f.prepare(posted,f.b)
 await child.runs.claim(f.owner,{runId:child.run.id})
 await child.runs.record(f.owner,{runId:child.run.id,sessionId:child.run.sessionId,nativeRequestId:child.run.nativeRequestId,evidence:{state:'accepted'}})
 await child.runs.record(f.owner,{runId:child.run.id,sessionId:child.run.sessionId,nativeRequestId:child.run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}})
 await new GroupRoutingOutboxService(pool,identity).settle(f.owner,{itemId:child.item.id,leaseGeneration:child.claimed.leaseGeneration,taskId:child.run.taskId,runId:child.run.id,state:'settled',reason:null})
 const fullText='原始复核全文🙂\n'.repeat(1000)+'不可遗漏的最后一句。',delivered=await f.publisher.post(f.owner,{requestId:child.run.nativeRequestId,runId:child.run.id,text:fullText})
 assert.ok(delivered.text.length<fullText.length)
 const feedback='仅调整为简短信函，保留原件事实。',reply=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,replyToMessageId:delivered.id,text:feedback})
 const task=(await pool.query('select version from teloa_tasks where owner_id=$1 and id=$2',[f.owner,child.run.taskId])).rows[0],inputs=new GroupWorkInputService(pool,identity),db=await pool.connect()
 let reserved
 try{await db.query('begin');reserved=await inputs.reserveInTransaction(db,f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:reply.id,taskId:child.run.taskId,expectedTaskVersion:task.version,operation:'continue'});await db.query('commit')}catch(error){await db.query('rollback');throw error}finally{db.release()}
 const continued=await inputs.continueTask(f.owner,reserved.requestId);assert.equal(continued.state,'continued');assert.ok(continued.taskVersion)
 const next=await child.runs.prepare(f.owner,{requestId:groupWorkContinuationRunRequestId(f.owner,reserved.requestId),taskId:child.run.taskId,expectedTaskVersion:continued.taskVersion,roleId:f.b.id,expectedRoleVersion:f.b.version,sessionId:child.run.sessionId,expectedLinkVersion:1})
 assert.equal(next.taskId,child.run.taskId);assert.ok(next.analysisScope);assert.equal(next.analysisScope.parent?.text,posted.text)
 const fixed=JSON.parse(next.inputText);assert.equal(fixed.groupContinuation.text,feedback);assert.equal(fixed.groupContinuation.quoted.text,fullText);assert.equal(fixed.groupContinuation.quoted.runId,child.run.id);assert.equal(fixed.groupContext.files[0].text,f.body)
 await child.runs.claim(f.owner,{runId:next.id});assert.deepEqual(next.allowedTools,[])
 assert.equal((await pool.query('select input_text from teloa_task_runs where owner_id=$1 and id=$2',[f.owner,child.run.id])).rows[0].input_text,child.run.inputText)
})

for(const scopeOnly of [undefined,'j06-scope-maintenance'])test('分析prepared维护只沿本人原receipt/ticket恢复同Run；缺证明或错范围仍拒且原输入不变'+(scopeOnly?'（scope-only）':''),async()=>{
 const f=await fixture('attachment',0,2,false,scopeOnly),posted=await f.publisher.post(f.owner,f.input),child=await f.prepare(posted,f.b),run=child.run
 // 正式outbox接口保留“已prepared、启动前检查失败且未发送”的blocked状态，不能把未知派发冒充旧恢复入口。
 await new GroupRoutingOutboxService(pool,identity).settle(f.owner,{itemId:child.item.id,leaseGeneration:child.claimed.leaseGeneration,taskId:run.taskId,runId:run.id,state:'blocked',reason:'teloa/conflict'})
 let host=1,sends=0
 const authority={authorize:async()=>({assertCurrent(){}})},controls=new WorkControlService(pool,identity,{hostGeneration:()=>host,ownerAuthority:authority,inspectRun:async(_owner,{runId})=>({settled:runId!==run.id,unknownOperationIds:runId===run.id?['runtime-owner:'+run.id]:[]})})
 const current=await controls.get(f.owner,{controlId:run.lineage!.roundControlId}),pauseRequest={requestId:randomUUID(),controlId:current.id,expectedVersion:current.version,action:'pause' as const,scope:'round' as const,roundControlId:null},pause=await controls.change(f.owner,pauseRequest)
 // 维护/native检查点为服务层元数据夹具，不冒称真实CLI退出或模型原生发送。
 const snapshot=sha('本例独立冷检查点'),audit:PreparedMaintenanceAudit={schema:'teloa.prepared-maintenance/v1',requestId:randomUUID(),installId:randomUUID(),ownerId:f.owner,runId:run.id,taskId:run.taskId,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,inputSha256:sha(run.inputText),runtimeId:null,sourceVersion:'0.2.1',targetVersion:'0.2.2',pauseRequestId:pauseRequest.requestId,controlId:pause.id,controlGeneration:pause.generation,nativeSnapshotSha256:snapshot,nativeFileSha256:'a'.repeat(64),processReceiptSha256:'b'.repeat(64),backupManifestSha256:'c'.repeat(64)}
 // 父A已正式结束，同轮暂停先用检查器收口它，只保留本轮未发送B；不得冒称所有后代都仍在途。
 await controls.reconcile(f.owner,{controlId:pause.id,generation:pause.generation})
 await preservePreparedRun(pool,audit,{assertCurrent(){}},identity.now());host=2;await controls.disarmForRestart(f.owner,{hostGeneration:host})
 await assert.rejects(child.runs.claim(f.owner,{runId:run.id}),{code:'teloa/forbidden'});assert.equal(sends,0)
 const recovery=new WorkRecoveryService(pool,identity,controls,{hostGeneration:()=>host,ownerAuthority:authority,authorizeResume:async(db,owner,{candidate})=>child.runs.preparedMaintenanceResumeAdmissionInTransaction(db,owner,candidate.runId),inspectCheckpoint:async()=>({reason:'unaccepted',checkpointSha256:snapshot,hasPendingInput:false,unknownOperationIds:[]})})
 const coordinator=new WorkRecoveryCoordinator({service:recovery,runs:child.runs,startUnaccepted:async(owner,input)=>{input.lease.assertCurrent();await child.runs.claim(owner,{runId:input.runId});await child.runs.executionAdmission(owner,input.runId);sends++;await child.runs.record(owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'accepted'}})},restoreAccepted:async()=>{throw Error('不重放受理工作')}})
 const active=await controls.get(f.owner,{controlId:pause.id}),request={requestId:randomUUID(),controlId:active.id,expectedVersion:active.version,candidateRunIds:[run.id]}
 await assert.rejects(recovery.resume(randomUUID(),request),{code:'teloa/forbidden'})
 await coordinator.resume(f.owner,request,AbortSignal.timeout(10000))
 const accepted=await child.runs.get(f.owner,{runId:run.id});assert.equal(accepted.state,'accepted');assert.equal(accepted.inputText,run.inputText);assert.deepEqual(accepted.analysisScope,run.analysisScope);assert.equal(sends,1)
 assert.equal((await pool.query('select count(*)::int as n from teloa_task_runs where owner_id=$1 and task_id=$2',[f.owner,run.taskId])).rows[0].n,1)
 const db=await pool.connect()
 try{
  const currentControls=(await db.query('select id,state,generation from teloa_work_controls where owner_id=$1 order by id',[f.owner])).rows.filter(row=>row.id===pause.id)
  assert.equal(await preparedMaintenanceControlsCurrent(db,f.owner,run.id,run.analysisScope,currentControls),true)
  assert.equal(await preparedMaintenanceControlsCurrent(db,randomUUID(),run.id,run.analysisScope,currentControls),false)
  assert.equal(await preparedMaintenanceControlsCurrent(db,f.owner,randomUUID(),run.analysisScope,currentControls),false)
  assert.equal(await preparedMaintenanceControlsCurrent(db,f.owner,run.id,{...run.analysisScope!,files:[]},currentControls),false)
  const saved=(await db.query('select resume from teloa_prepared_run_maintenance where owner_id=$1 and run_id=$2',[f.owner,run.id])).rows[0].resume
  try{await db.query("update teloa_prepared_run_maintenance set resume=resume-'analysisScopeSha256' where owner_id=$1 and run_id=$2",[f.owner,run.id]);await assert.rejects(child.runs.executionAdmission(f.owner,run.id),{code:'teloa/forbidden'})}finally{await db.query('update teloa_prepared_run_maintenance set resume=$3 where owner_id=$1 and run_id=$2',[f.owner,run.id,JSON.stringify(saved)])}
 }finally{db.release()}
 await child.runs.record(f.owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}})
 const check=await pool.connect();try{
  const activeControls=(await check.query('select id,state,generation from teloa_work_controls where owner_id=$1 and id=$2',[f.owner,pause.id])).rows
  assert.equal(await preparedMaintenanceControlsCurrent(check,f.owner,undefined,{...run.analysisScope!,taskVersion:4,contextSha256:'e'.repeat(64)},activeControls,true),false,'没有本人新continue ledger，不得借旧维护许可建立后继')
 }finally{check.release()}
 const text='维护恢复后的完整交付。'.repeat(700),delivered=await f.publisher.post(f.owner,{requestId:run.nativeRequestId,runId:run.id,text}),feedback='只改为项目符号，仍沿同一原件。',reply=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,replyToMessageId:delivered.id,text:feedback}),task=(await pool.query('select version from teloa_tasks where owner_id=$1 and id=$2',[f.owner,run.taskId])).rows[0],inputs=new GroupWorkInputService(pool,identity),client=await pool.connect()
 let reserved
 try{await client.query('begin');reserved=await inputs.reserveInTransaction(client,f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:reply.id,taskId:run.taskId,expectedTaskVersion:task.version,operation:'continue'});await client.query('commit')}catch(error){await client.query('rollback');throw error}finally{client.release()}
 const continuation=await inputs.continueTask(f.owner,reserved.requestId),command={requestId:groupWorkContinuationRunRequestId(f.owner,reserved.requestId),taskId:run.taskId,expectedTaskVersion:continuation.taskVersion,roleId:f.b.id,expectedRoleVersion:f.b.version,sessionId:run.sessionId,expectedLinkVersion:1}
 await assert.rejects(child.runs.prepare(f.owner,{...command,requestId:randomUUID()}),{code:'teloa/forbidden'},'有本人ledger但nonce不属于它，也不能建立后继')
 const next=await child.runs.prepare(f.owner,command);assert.equal(next.taskId,run.taskId);assert.deepEqual(next.analysisScope?.controls,run.analysisScope?.controls);assert.equal(JSON.parse(next.inputText).groupContinuation.quoted.text,text);assert.equal(JSON.parse(next.inputText).groupContinuation.text,feedback)
 await child.runs.claim(f.owner,{runId:next.id});await child.runs.executionAdmission(f.owner,next.id)
 assert.equal((await child.runs.get(f.owner,{runId:run.id})).inputText,run.inputText);assert.equal((await pool.query('select count(*)::int as n from teloa_task_runs where owner_id=$1 and task_id=$2',[f.owner,run.taskId])).rows[0].n,2)
 const now=await controls.get(f.owner,{controlId:pause.id});await controls.change(f.owner,{requestId:randomUUID(),controlId:now.id,expectedVersion:now.version,action:'pause',scope:'round',roundControlId:null})
 await assert.rejects(child.runs.executionAdmission(f.owner,next.id),{code:'teloa/forbidden'})
})

test('既有授权PNG可进入零工具分析prepare与原生准入，元数据摘要不冒称归一化字节摘要；撤权仍拒',async()=>{
 const f=await fixture('image'),image=f.parent.run.groupContext!.files[0]!
 assert.equal(image.mime,'image/png');assert.equal(image.text,undefined);assert.notEqual(image.sha256,image.id.slice('sha256:'.length),'原上传元数据与宿主归一化内容寻址保持不同语义')
 assert.deepEqual(f.parent.run.analysisScope?.files,[{kind:image.kind,id:image.id,version:image.version,bytes:image.bytes,sha256:image.sha256}])
 const posted=await f.publisher.post(f.owner,f.input),child=await f.prepare(posted,f.b)
 await child.runs.claim(f.owner,{runId:child.run.id});await child.runs.executionAdmission(f.owner,child.run.id)
 assert.deepEqual(child.run.allowedTools,[]);assert.deepEqual(child.run.groupContext?.files,[image])
 await f.grant(f.b,[]);await assert.rejects(child.runs.executionAdmission(f.owner,child.run.id),{code:'teloa/forbidden'})
})


test('scope-only 已登记非general范围自然A/B均派生零工具分析，固定来源不改写',async()=>{
 const f=await fixture('attachment',1,2,true,'j06-scope-analysis'),first=f.parent.run
 assert.deepEqual(f.parent.created.source.schema,'teloa.group-task-source/v2');assert.ok('businessTarget'in f.parent.created.source);assert.deepEqual(f.parent.created.source.businessTarget,{scope:f.scope})
 assert.ok(first.analysisScope);assert.equal(first.textCapability,undefined);assert.deepEqual(first.allowedTools,[]);assert.equal(JSON.parse(first.inputText).task.scope,f.scope);assert.equal(first.memory.length,1);assert.deepEqual(first.skills.map(item=>item.name),[f.skill.name]);assert.deepEqual(first.knowledge,[],'岗位私有知识不因业务标签获得群授权');assert.equal(first.groupContext?.materials.length,1)
 const posted=await f.publisher.post(f.owner,{...f.input,text:'本轮原件南场18份、北场27份。@复核B 请独立核对完整原件。'}),child=await f.prepare(posted,f.b),run=child.run
 assert.ok(run.analysisScope);assert.equal(run.analysisScope.parent?.text,posted.text);assert.deepEqual(run.allowedTools,[]);assert.equal(run.textCapability,undefined);assert.equal(JSON.parse(run.inputText).groupContext.files[0].text,f.body)
 assert.ok('businessTarget'in child.created.source);assert.deepEqual(child.created.source.businessTarget,{scope:f.scope})
 const stored=(await pool.query('select source_snapshot,snapshot_digest from teloa_group_task_sources where owner_id=$1 and task_id=$2',[f.owner,run.taskId])).rows[0]
 assert.deepEqual(stored.source_snapshot.businessTarget,{scope:f.scope});assert.equal(stored.snapshot_digest,run.analysisScope.sourceDigest)
 assert.equal((await child.runs.get(f.owner,{runId:run.id})).inputText,run.inputText)
 await child.runs.claim(f.owner,{runId:run.id});await child.runs.executionAdmission(f.owner,run.id)
 assert.deepEqual((await child.runs.toolPolicy(f.owner,{sessionId:run.sessionId}))?.allowedTools,[])
 if(process.env.TELOA_RUN_ANALYSIS_TEST_OUTPUT_DIR)await writeFile(join(process.env.TELOA_RUN_ANALYSIS_TEST_OUTPUT_DIR,'scope-only-natural.json'),JSON.stringify({scope:f.scope,owner:f.owner,parentRunId:first.id,childRunId:run.id,sourceBusinessTarget:stored.source_snapshot.businessTarget,sourceDigest:stored.snapshot_digest,analysisScope:run.analysisScope,allowedTools:run.allowedTools,realPG:true,nativeModel:false})+'\n',{flag:'wx'})
})


test('scope-only 不放宽具体对象、旧来源、reply、计划定义或当前授权',async()=>{
 const f=await fixture('attachment',0,2,false,'j06-scope-boundary'),base=f.parent.run.analysisScope;assert.ok(base)
 const snapshot={scope:f.scope,type:'alert',id:'fixture-object',version:1,title:'合成原对象',source:'本轮隔离测试',observedAt:identity.now(),receivedAt:identity.now(),quality:'complete' as const,summary:'不因标签取得对象处置授权',fields:[{label:'状态',value:'待核对'}]},snapshotHash=businessObjectSnapshotHash(snapshot)
 // 原对象快照是自有PG合成输入；来源与对象关联均仍由正式GroupTaskService校验并保存。
 await pool.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[f.owner,f.scope,'alert',snapshot.id,1,snapshotHash,JSON.stringify(snapshot),'fixture-object-source',identity.now()])
 const reference={scope:f.scope,type:'alert',id:snapshot.id,version:1,snapshotHash},tasks=new GroupTaskService(pool,identity,f.tasks)
 await assert.rejects(tasks.create(f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:f.initial.id,expectedGroupVersion:f.group.version,goal:'不能改变原业务范围。',assignee:{roleId:f.a.id,expectedVersion:f.a.version},businessTarget:{scope:'SOC'}}),{code:'teloa/forbidden'})
 for(const kind of ['object','legacy','reply'] as const){
  const created=await tasks.create(f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:f.initial.id,expectedGroupVersion:f.group.version,goal:'仅核对原合成资料。',assignee:{roleId:f.a.id,expectedVersion:f.a.version},...(kind==='legacy'?{}:kind==='object'?{businessTarget:{scope:f.scope,object:reference}}:{trigger:'routed' as const,executionMode:'reply' as const,routingAttemptVersion:1})})
  const db=await pool.connect()
  try{
   await db.query('begin')
   const context=await readRunGroupContext(db,f.owner,created.task,f.a,f.ports,pool,[],{kind:'prepare',taskVersion:created.task.version}),lineage=await new WorkLineageService(pool,identity).readInTransaction(db,f.owner,{taskId:created.task.id});assert.ok(context);assert.ok(lineage)
   assert.equal(await deriveRunAnalysisScope(db,pool,f.owner,created.task,f.a,context,lineage),undefined,kind+' 不派生分析scope')
   const source=(await db.query('select snapshot_digest from teloa_group_task_sources where owner_id=$1 and task_id=$2',[f.owner,created.task.id])).rows[0],ids=[lineage.roundControlId,...(lineage.definitionControlId?[lineage.definitionControlId]:[])].sort(),controls=(await db.query('select id,generation from teloa_work_controls where owner_id=$1 and id=any($2::uuid[]) order by id',[f.owner,ids])).rows
   if(context.ownerRequest){
    // 负例仅组装结构合法的未签来源：真实source/Task/context/lineage均取PG，verify必须拒绝，不冒称可派生。
    const {dispatch:_unrelated,...unsigned}=base;const claimed=readRunAnalysisScope({...unsigned,taskId:created.task.id,taskVersion:created.task.version,sourceDigest:source.snapshot_digest,contextSha256:runGroupContextHash(context),lineageSha256:sha(JSON.stringify(lineage)),controls})
    await assert.rejects(verifyRunAnalysisScope(db,pool,f.owner,claimed,context,lineage),{code:'teloa/forbidden'},kind+' 回验沿同一来源资格')
   }
   await db.query('rollback')
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
  assert.equal(Number((await pool.query('select count(*)::int as count from teloa_task_runs where owner_id=$1 and task_id=$2',[f.owner,created.task.id])).rows[0].count),0)
 }
 const db=await pool.connect()
 try{
  await db.query('begin')
  const task=readStoredTask((await db.query('select * from teloa_tasks where owner_id=$1 and id=$2',[f.owner,f.parent.run.taskId])).rows[0]),context=f.parent.run.groupContext!,lineage=f.parent.run.lineage!
  // 显式合成的无权计划定义负例，不能从普通Task声明获得计划资格；不创建或运行计划。
  const planLineage={...lineage,definition:{planId:randomUUID(),definitionVersion:1,occurrenceId:'fixture-occurrence'}}
  assert.equal(await deriveRunAnalysisScope(db,pool,f.owner,task,f.a,context,planLineage),undefined)
  const planScope=readRunAnalysisScope({...base,lineageSha256:sha(JSON.stringify(planLineage))})
  await assert.rejects(verifyRunAnalysisScope(db,pool,f.owner,planScope,context,planLineage),{code:'teloa/forbidden'})
  await db.query('rollback')
 }catch(error){await db.query('rollback');throw error}finally{db.release()}
 const posted=await f.publisher.post(f.owner,f.input),child=await f.prepare(posted,f.b),input=child.run.inputText
 const admission=await child.runs.executionAdmission(f.owner,child.run.id);admission.assertCurrent()
 await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.b.id,expectedGroupVersion:f.group.version,expectedRoleVersion:f.b.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 await assert.rejects(child.runs.claim(f.owner,{runId:child.run.id}))
 await assert.rejects(child.runs.executionAdmission(f.owner,child.run.id))
 assert.equal((await pool.query('select input_text from teloa_task_runs where owner_id=$1 and id=$2',[f.owner,child.run.id])).rows[0].input_text,input)
 if(process.env.TELOA_RUN_ANALYSIS_TEST_OUTPUT_DIR)await writeFile(join(process.env.TELOA_RUN_ANALYSIS_TEST_OUTPUT_DIR,'scope-only-negative.json'),JSON.stringify({scope:f.scope,objectRejected:true,legacyNotDerived:true,replyNotDerived:true,syntheticPlanDefinitionRejected:true,revokedAdmissionRejected:true,oldInputExact:true,realPG:true,models:0})+'\n',{flag:'wx'})
})

// J06: causal generation is immutable; a newly authenticated dispatch has its own epoch.
async function resumeAnalysisRootTwice(f:Awaited<ReturnType<typeof fixture>>){
 const authority={authorize:async()=>({assertCurrent(){}})},controls=new WorkControlService(pool,identity,{hostGeneration:()=>1,ownerAuthority:authority,inspectRun:async()=>({settled:true,unknownOperationIds:[]})}),recovery=new WorkRecoveryService(pool,identity,controls,{hostGeneration:()=>1,ownerAuthority:authority,authorizeResume:async()=>{throw Error('no live Run may be restored')},inspectCheckpoint:async()=>{throw Error('no checkpoint needed')}})
 for(let i=0;i<2;i++){const current=await controls.get(f.owner,{controlId:f.parent.run.lineage!.roundControlId}),pausing=await controls.change(f.owner,{requestId:randomUUID(),controlId:current.id,expectedVersion:current.version,action:'pause',scope:'round',roundControlId:null}),paused=await controls.reconcile(f.owner,{controlId:pausing.id,generation:pausing.generation});await recovery.resume(f.owner,{requestId:randomUUID(),controlId:paused.id,expectedVersion:paused.version,candidateRunIds:[]})}
 assert.equal((await controls.get(f.owner,{controlId:f.parent.run.lineage!.roundControlId})).generation,5)
 return controls
}
test('J06 current-epoch: restored A1 at active5 hands fixed attachment to first B without rewriting lineage',async()=>{
 const f=await fixture('attachment',0,2,false,'j06-generation'),original=f.parent.run.inputText,controls=await resumeAnalysisRootTwice(f),posted=await f.publisher.post(f.owner,f.input),child=await f.prepare(posted,f.b)
 assert.equal(child.run.lineage!.controlGeneration,1);assert.equal(child.run.lineage!.parentRunId,f.parent.run.id);assert.equal(child.run.analysisScope!.controls[0]!.generation,1)
 assert.deepEqual(child.run.groupContext!.files[0]!.text,f.body);assert.deepEqual(child.run.allowedTools,[])
 await child.runs.claim(f.owner,{runId:child.run.id});assert.equal((await child.runs.get(f.owner,{runId:child.run.id})).state,'submitting');assert.equal((await f.parent.runs.get(f.owner,{runId:f.parent.run.id})).inputText,original)
 const current=await controls.get(f.owner,{controlId:child.run.lineage!.roundControlId});assert.equal(current.generation,5)
})


test('J06 analysis recovery: same B Task fixed text/image, explicit owner request once, no Run or provider on inspect/recover',async()=>{
 for(const kind of ['attachment','image'] as const){
  const f=await fixture(kind,0,2,false,'j06-'+kind),controls=await resumeAnalysisRootTwice(f),posted=await f.publisher.post(f.owner,f.input),reg=await f.register(posted,f.b),target={groupId:f.group.id,messageId:posted.id,roleId:f.b.id}
  await f.outbox.settle(f.owner,{itemId:reg.item.id,leaseGeneration:reg.claimed.leaseGeneration,taskId:reg.created.task.id,runId:null,state:'blocked',reason:'teloa/forbidden'})
  const original=(await pool.query('select * from teloa_group_task_sources where task_id=$1',[reg.created.task.id])).rows[0],lineage=(await pool.query('select * from teloa_task_work_lineage where task_id=$1',[reg.created.task.id])).rows[0]
  let proof=0;const recovery=new GroupDeliveryRecoveryService(pool,identity,{assertUnsent:async()=>{proof++;return {sessionId:null,sha256:sha('unsent'),unsent:true}}},f.ports),candidate=await recovery.inspect(f.owner,target)
  assert.equal(candidate.reason,'analysis-capability-required');assert.equal(candidate.taskId,reg.created.task.id);assert.equal(candidate.files?.length,1);assert.equal(candidate.files![0]!.mime,kind==='image'?'image/png':'text/plain')
  const command={...target,requestId:randomUUID(),itemId:candidate.itemId,expectedBasisSha256:candidate.basisSha256,capability:'analysis'},receipt=await recovery.recover(f.owner,command)
  assert.equal(receipt.capability,'analysis');assert.deepEqual(await recovery.recover(f.owner,command),receipt);assert.equal((await recovery.receipt(f.owner,command)).state,'accepted');assert.equal((await pool.query('select 1 from teloa_task_runs where task_id=$1',[reg.created.task.id])).rowCount,0)
  const ready=(await f.outbox.list(f.owner,{groupId:f.group.id,messageIds:[posted.id]}))[0]!,claim=await f.outbox.claim(f.owner,{itemId:ready.id,expectedLeaseGeneration:ready.leaseGeneration});assert.ok(claim)
  const child=await f.prepare(posted,f.b,{...reg,claimed:claim})
  assert.equal(child.run.taskId,reg.created.task.id);assert.equal(child.run.textCapability,undefined);assert.equal(child.run.analysisScope?.dispatch?.controls[0]?.generation,5);assert.deepEqual(child.run.allowedTools,[])
  assert.deepEqual((await pool.query('select * from teloa_group_task_sources where task_id=$1',[reg.created.task.id])).rows[0],original);assert.deepEqual((await pool.query('select * from teloa_task_work_lineage where task_id=$1',[reg.created.task.id])).rows[0],lineage)
  // 本人接受回执只返回原事实，不因已有 prepared Run 再排队；异主、已准备来源均拒。
  assert.deepEqual(await recovery.recover(f.owner,command),receipt);await assert.rejects(recovery.inspect(randomUUID(),target));await assert.rejects(recovery.inspect(f.owner,target));assert.ok(proof>=2)
  assert.equal((await controls.get(f.owner,{controlId:lineage.lineage.roundControlId})).generation,5)
 }
})

test('J06 epoch fences: fixed5 cannot follow claim7, legacy no dispatch denied, exact outbox/request/Run binding and crash reclaim',async()=>{
 const f=await fixture('attachment',0,2,false,'j06-epoch'),controls=await resumeAnalysisRootTwice(f),posted=await f.publisher.post(f.owner,f.input),child=await f.prepare(posted,f.b,undefined,true),run=child.run,scope=run.analysisScope!
 assert.equal(scope.kind,'source-derived');assert.ok(scope.kind==='source-derived')
 assert.equal(scope.dispatch!.controls[0]!.generation,5)
 const original=run.inputText,db=await pool.connect()
 try{
  await assert.rejects(assertRunAnalysisControls(db,f.owner,scope,run.id),'prepare commit before reserve cannot be admitted')
  await pool.query("update teloa_group_routing_outbox set next_attempt_at=now()-interval '1 second' where owner_id=$1 and id=$2",[f.owner,child.item.id])
  const reclaimed=await f.outbox.claim(f.owner,{itemId:child.item.id,expectedLeaseGeneration:child.claimed.leaseGeneration});assert.ok(reclaimed)
  await f.outbox.assertDispatch(f.owner,{itemId:child.item.id,leaseGeneration:reclaimed.leaseGeneration});await f.outbox.reserveSubmission(f.owner,{itemId:child.item.id,leaseGeneration:reclaimed.leaseGeneration,taskId:run.taskId,runId:run.id})
  await assertRunAnalysisControls(db,f.owner,scope,run.id)
  for(const bad of [{...scope,dispatch:{...scope.dispatch!,itemId:randomUUID()}},{...scope,dispatch:{...scope.dispatch!,requestId:randomUUID()}},{...scope,dispatch:{...scope.dispatch!,decisionVersion:99}},{...scope,sourceMessageId:randomUUID()},{...scope,sourceDigest:'0'.repeat(64)},{...scope,roleId:randomUUID()},{...scope,taskId:randomUUID()}])await assert.rejects(assertRunAnalysisControls(db,f.owner,bad,run.id))
  await assert.rejects(assertRunAnalysisControls(db,randomUUID(),scope,run.id));await assert.rejects(assertRunAnalysisControls(db,f.owner,scope,f.parent.run.id))
  const {dispatch:_,...legacy}=scope;await assert.rejects(assertRunAnalysisControls(db,f.owner,legacy,run.id),'old scope cannot borrow current outbox authority')
  const current=await controls.get(f.owner,{controlId:run.lineage!.roundControlId}),pausing=await controls.change(f.owner,{requestId:randomUUID(),controlId:current.id,expectedVersion:current.version,action:'pause',scope:'round',roundControlId:null});await controls.reconcile(f.owner,{controlId:pausing.id,generation:pausing.generation})
  await assert.rejects(assertRunAnalysisControls(db,f.owner,scope,run.id))
  const recovery=new WorkRecoveryService(pool,identity,controls,{hostGeneration:()=>1,ownerAuthority:{authorize:async()=>({assertCurrent(){}})},authorizeResume:async()=>({assertCurrent(){}}),inspectCheckpoint:async()=>({reason:'unaccepted',checkpointSha256:sha('new owned unsent checkpoint'),hasPendingInput:false,unknownOperationIds:[]})}),paused=await controls.get(f.owner,{controlId:current.id});await recovery.resume(f.owner,{requestId:randomUUID(),controlId:paused.id,expectedVersion:paused.version,candidateRunIds:(await recovery.inspect(f.owner,{controlId:current.id})).map(c=>c.runId)})
  await pool.query("update teloa_group_routing_outbox set next_attempt_at=now()-interval '1 second' where owner_id=$1 and id=$2",[f.owner,child.item.id]);const claim7=await f.outbox.claim(f.owner,{itemId:child.item.id,expectedLeaseGeneration:reclaimed.leaseGeneration});assert.ok(claim7)
  const row=(await pool.query('select * from teloa_group_routing_outbox where id=$1',[child.item.id])).rows[0];assert.equal(row.dispatch_control_snapshot[0].generation,5)
  await assert.rejects(f.outbox.assertDispatch(f.owner,{itemId:row.id,leaseGeneration:claim7.leaseGeneration}));await assert.rejects(assertRunAnalysisControls(db,f.owner,scope,run.id))
  // 即使不可信新 snapshot 被存为7，旧Run固定5也不能换权。
  await pool.query('update teloa_group_routing_outbox set dispatch_control_snapshot=$2 where id=$1',[row.id,JSON.stringify([{id:current.id,generation:7}])]);await assert.rejects(assertRunAnalysisControls(db,f.owner,scope,run.id))
  assert.equal((await child.runs.get(f.owner,{runId:run.id})).inputText,original)
 }finally{db.release()}
})


test('J06 analysis recovery negatives: pause, revoke, non-auto grant, unknown delivery, wrong item and stale basis never queue',async()=>{
 for(const fault of ['pause','revoke','no-auto','unknown','wrong-item','stale-basis'] as const){
  const f=await fixture('attachment',0,2,false,'j06-no-'+fault),controls=await resumeAnalysisRootTwice(f),posted=await f.publisher.post(f.owner,f.input),reg=await f.register(posted,f.b),target={groupId:f.group.id,messageId:posted.id,roleId:f.b.id},recovery=new GroupDeliveryRecoveryService(pool,identity,{assertUnsent:async()=>({sessionId:null,sha256:sha('unsent'),unsent:true})},f.ports)
  await f.outbox.settle(f.owner,{itemId:reg.item.id,leaseGeneration:reg.claimed.leaseGeneration,taskId:reg.created.task.id,runId:null,state:fault==='unknown'?'unknown':'blocked',reason:'teloa/forbidden'})
  if(fault==='pause'){const current=await controls.get(f.owner,{controlId:f.parent.run.lineage!.roundControlId}),pausing=await controls.change(f.owner,{requestId:randomUUID(),controlId:current.id,expectedVersion:current.version,action:'pause',scope:'round',roundControlId:null});await controls.reconcile(f.owner,{controlId:current.id,generation:pausing.generation})}
  if(fault==='revoke'||fault==='no-auto')await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.b.id,expectedGroupVersion:f.group.version,expectedRoleVersion:f.b.version,action:fault==='revoke'?'revoke':'save',resources:fault==='revoke'?[]:f.references,canPost:fault!=='revoke',canAutoRun:false})
  if(fault==='wrong-item'||fault==='stale-basis'){const c=await recovery.inspect(f.owner,target),cmd={...target,requestId:randomUUID(),itemId:fault==='wrong-item'?randomUUID():c.itemId,expectedBasisSha256:fault==='stale-basis'?'0'.repeat(64):c.basisSha256,capability:'analysis'};await assert.rejects(recovery.recover(f.owner,cmd));assert.equal((await recovery.receipt(f.owner,cmd)).state,'not-accepted')}
  else await assert.rejects(recovery.inspect(f.owner,target))
  assert.equal((await pool.query('select 1 from teloa_task_runs where task_id=$1',[reg.created.task.id])).rowCount,0);assert.equal((await pool.query('select state from teloa_group_routing_outbox where id=$1',[reg.item.id])).rows[0].state,fault==='unknown'?'unknown':'blocked')
 }
})


test('J06 analysis explicit epoch reconfirmation: Run0 owner5→7 approval appends once, same B Task and source, old receipt does not requeue',async()=>{
 const f=await fixture('attachment',0,2,false,'j06-reconfirm'),controls=await resumeAnalysisRootTwice(f),posted=await f.publisher.post(f.owner,f.input),reg=await f.register(posted,f.b),target={groupId:f.group.id,messageId:posted.id,roleId:f.b.id},recovery=new GroupDeliveryRecoveryService(pool,identity,{assertUnsent:async()=>({sessionId:null,sha256:sha('unsent'),unsent:true})},f.ports)
 await f.outbox.settle(f.owner,{itemId:reg.item.id,leaseGeneration:reg.claimed.leaseGeneration,taskId:reg.created.task.id,runId:null,state:'blocked',reason:'teloa/forbidden'})
 const c=await recovery.inspect(f.owner,target),firstCommand={...target,requestId:randomUUID(),itemId:c.itemId,expectedBasisSha256:c.basisSha256,capability:'analysis'},first=await recovery.recover(f.owner,firstCommand)
 const control=await controls.get(f.owner,{controlId:f.parent.run.lineage!.roundControlId}),pausing=await controls.change(f.owner,{requestId:randomUUID(),controlId:control.id,expectedVersion:control.version,action:'pause',scope:'round',roundControlId:null}),paused=await controls.reconcile(f.owner,{controlId:control.id,generation:pausing.generation}),resume=new WorkRecoveryService(pool,identity,controls,{hostGeneration:()=>1,ownerAuthority:{authorize:async()=>({assertCurrent(){}})},authorizeResume:async()=>{throw Error('Run0 only')},inspectCheckpoint:async()=>{throw Error('Run0 only')}})
 await resume.resume(f.owner,{requestId:randomUUID(),controlId:control.id,expectedVersion:paused.version,candidateRunIds:[]})
 const blocked=(await f.outbox.list(f.owner,{groupId:f.group.id,messageIds:[posted.id]}))[0]!,lease=await f.outbox.claim(f.owner,{itemId:blocked.id,expectedLeaseGeneration:blocked.leaseGeneration});assert.ok(lease);await assert.rejects(f.outbox.assertDispatch(f.owner,{itemId:lease.id,leaseGeneration:lease.leaseGeneration}));await f.outbox.settle(f.owner,{itemId:lease.id,leaseGeneration:lease.leaseGeneration,taskId:reg.created.task.id,runId:null,state:'blocked',reason:'teloa/forbidden'})
 const next=await recovery.inspect(f.owner,target);assert.equal(next.reason,'analysis-capability-reconfirmation-required');assert.equal(next.reconfirmation!.previousRecoveryId,first.recoveryId)
 const command={...target,requestId:randomUUID(),itemId:next.itemId,expectedBasisSha256:next.basisSha256,capability:'analysis'},second=await recovery.recover(f.owner,command),before=(await pool.query('select * from teloa_group_routing_outbox where id=$1',[lease.id])).rows[0]
 assert.deepEqual(await recovery.recover(f.owner,firstCommand),first);assert.deepEqual(await recovery.recover(f.owner,command),second);assert.deepEqual((await pool.query('select * from teloa_group_routing_outbox where id=$1',[lease.id])).rows[0],before);assert.equal(before.dispatch_control_snapshot[0].generation,7)
 const claim=await f.outbox.claim(f.owner,{itemId:lease.id,expectedLeaseGeneration:before.lease_generation});assert.ok(claim);const child=await f.prepare(posted,f.b,{...reg,claimed:claim});assert.equal(child.run.taskId,reg.created.task.id);assert.equal(child.run.lineage!.controlGeneration,1);assert.equal(child.run.analysisScope!.dispatch!.controls[0]!.generation,7)
})

test('J06 17-node continuation: original Run plus 16 formal owner feedbacks retains one dispatch and admits final Run',async()=>{
 const f=await fixture('attachment',0,2,false,'j06-seventeen'),posted=await f.publisher.post(f.owner,f.input),child=await f.prepare(posted,f.b),original=child.run.inputText,inputs=new GroupWorkInputService(pool,identity),ids=[child.run.id]
 let run=child.run
 for(let index=1;index<=16;index++){
  await child.runs.claim(f.owner,{runId:run.id})
  await child.runs.record(f.owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'accepted'}})
  await child.runs.record(f.owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}})
  if(index===1)await f.outbox.settle(f.owner,{itemId:child.item.id,leaseGeneration:child.claimed.leaseGeneration,taskId:run.taskId,runId:run.id,state:'settled',reason:null})
  const delivered=await f.publisher.post(f.owner,{requestId:run.nativeRequestId,runId:run.id,text:'本轮隔离合成报告，第'+index+'次交付。'}),reply=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,replyToMessageId:delivered.id,text:'仅调整合成报告为第'+index+'版，保留同一固定原件事实。'}),task=(await pool.query('select version from teloa_tasks where owner_id=$1 and id=$2',[f.owner,run.taskId])).rows[0],db=await pool.connect()
  let reserved
  try{await db.query('begin');reserved=await inputs.reserveInTransaction(db,f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:reply.id,taskId:run.taskId,expectedTaskVersion:task.version,operation:'continue'});await db.query('commit')}catch(error){await db.query('rollback');throw error}finally{db.release()}
  const continued=await inputs.continueTask(f.owner,reserved.requestId)
  run=await child.runs.prepare(f.owner,{requestId:groupWorkContinuationRunRequestId(f.owner,reserved.requestId),taskId:run.taskId,expectedTaskVersion:continued.taskVersion,roleId:f.b.id,expectedRoleVersion:f.b.version,sessionId:run.sessionId,expectedLinkVersion:1})
  assert.deepEqual(run.analysisScope!.dispatch,child.run.analysisScope!.dispatch);assert.deepEqual(run.lineage,child.run.lineage);assert.deepEqual(run.allowedTools,[]);ids.push(run.id)
 }
 assert.equal(ids.length,17);assert.equal(new Set(ids).size,17);assert.equal(run.groupContext!.ownerRequest!.priorRequests!.length,16,'原契约允许17条本人消息、priorRequests16')
 await child.runs.claim(f.owner,{runId:run.id});await child.runs.executionAdmission(f.owner,run.id)
 assert.equal((await child.runs.get(f.owner,{runId:child.run.id})).inputText,original);assert.equal((await pool.query('select count(*)::int as n from teloa_group_work_inputs where owner_id=$1 and task_id=$2',[f.owner,run.taskId])).rows[0].n,16);assert.equal((await pool.query('select count(*)::int as n from teloa_task_runs where owner_id=$1 and task_id=$2',[f.owner,run.taskId])).rows[0].n,17)
})
