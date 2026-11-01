import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用仓库固定的无头浏览器。
import {launchOptions,loadPlaywright} from '../../client/ui-workbench/tests/fixtures/load-playwright.mjs'
import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdtemp,rm,statfs,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {createGroupDeliveryRecoveryApi} from '../../client/ui-workbench/src/client/group-delivery-recovery-api.ts'
import {identity} from './role-work-test-fixture.ts'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {RoleService} from '../src/work/roles.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {GroupAgentGrantService} from '../src/work/group-agent-grants.ts'
import {GroupRoutingDecisionService,initializeGroupRoutingDecisions} from '../src/work/group-routing-decisions.ts'
import {GroupRoutingOutboxService,initializeGroupRoutingOutbox} from '../src/work/group-routing-outbox.ts'
import {GroupTaskService,initializeGroupTasks} from '../src/work/group-tasks.ts'
import {TaskService} from '../src/work/tasks.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {readRunGroupContext} from '../src/work/task-run-group-context.ts'
import {GroupDeliveryRecoveryService,initializeGroupDeliveryRecovery,assertRunTextControlsCurrent} from '../src/work/group-delivery-recovery.ts'
import {drainGroupRoutingOutbox} from '../../harness-dsh/src/group-routing-outbox-driver.ts'
import {initializeGroupWorkInputs,GroupWorkInputService} from '../src/work/group-work-inputs.ts'
import {drainGroupWorkInputs} from '../../harness-dsh/src/group-work-input-driver.ts'
import {GroupRunMessageService} from '../src/work/group-run-messages.ts'
import {ArtifactService,initializeArtifacts} from '../src/work/artifacts.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {taskArtifactSource,taskArtifactSessions} from '../src/work/artifact-task-source.ts'
import {WorkControlService,initializeWorkControl} from '../src/work/work-control.ts'
import {WorkRecoveryService,initializeWorkRecovery} from '../src/work/work-recovery.ts'
import {initializePreparedMaintenance,preservePreparedRun,preparedMaintenanceControlsCurrent,resumePreparedMaintenance,type PreparedMaintenanceAudit} from '../src/work/prepared-maintenance.ts'
import {initializeTaskRunRuntimeLinks} from '../src/work/task-run-runtime-links.ts'
import {GroupRoutingStatusService} from '../src/work/group-routing-status.ts'
import {initializeGroupRoutingAttempts} from '../src/work/group-routing-attempts.ts'
import {WorkRecoveryCoordinator} from '../../harness-dsh/src/work-recovery-coordinator.ts'
import {plannedRestartResume} from '../../harness-dsh/src/planned-restart-resume.ts'
import {plannedRestartResumeRequestId,readRunTextCapability,WorkError} from '@teloa/contract'

let f:{pool:Pool},container:StartedPostgreSqlContainer|undefined,fixtureRoot:string|undefined
const originalEnvironment={host:process.env.DOCKER_HOST,socket:process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE,ryuk:process.env.TESTCONTAINERS_RYUK_DISABLED}
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:15000}).trim()
async function fixtureSpace(){const value=await statfs(tmpdir());assert.ok(Number(value.bavail)*Number(value.bsize)>=20*1024**3+256*1024**2,'保留20GiB及本轮PG资源预算')}
before(async()=>{
 await fixtureSpace();process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';process.env.TESTCONTAINERS_RYUK_DISABLED='true'
 const image=docker('image','inspect','postgres:17-alpine','--format','{{.Id}}')
 container=await new PostgreSqlContainer('postgres:17-alpine').withPullPolicy({shouldPull:()=>false}).withTmpFs({'/var/lib/postgresql/data':'rw,size=128m'}).withResourcesQuota({memory:0.25}).start()
 assert.equal(docker('inspect',container.getId(),'--format','{{.Image}}'),image);assert.equal(Number(docker('inspect',container.getId(),'--format','{{.HostConfig.Memory}}')),268435456)
 assert.equal(JSON.parse(docker('inspect',container.getId(),'--format','{{json .HostConfig.Tmpfs}}'))['/var/lib/postgresql/data'],'rw,size=128m')
 fixtureRoot=await mkdtemp(join(tmpdir(),'teloa-legacy-text-recovery-'));f={pool:new Pool({connectionString:container.getConnectionUri()})}
 await initializeTeloaDatabase(f.pool,{businessSqlSecretPath:join(fixtureRoot,'reader.json')})
 await initializeGroupTasks(f.pool);await initializeGroupRoutingDecisions(f.pool);await initializeGroupRoutingOutbox(f.pool);await initializeGroupWorkInputs(f.pool);await initializeGroupDeliveryRecovery(f.pool);await initializeArtifactSnapshots(f.pool);await initializeArtifacts(f.pool);await initializeWorkControl(f.pool);await initializeWorkRecovery(f.pool)
})
after(async()=>{
 await f?.pool.end();await stopTestContainer(container)
 if(container)assert.equal(docker('ps','-aq','--no-trunc','--filter','id='+container.getId()),'')
 if(fixtureRoot)await rm(fixtureRoot,{recursive:true,force:false})
 for(const [key,value] of [['DOCKER_HOST',originalEnvironment.host],['TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE',originalEnvironment.socket],['TESTCONTAINERS_RYUK_DISABLED',originalEnvironment.ryuk]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value}
 await fixtureSpace()
 if(process.env.TELOA_TEXT_RECOVERY_TEST_OUTPUT_DIR)await writeFile(join(process.env.TELOA_TEXT_RECOVERY_TEST_OUTPUT_DIR,'owned-cleanup.json'),JSON.stringify({poolDrained:true,containerId:container?.getId(),ownContainerRemoved:true,ownTempRemoved:true,memoryBytes:268435456,tmpfsBytes:134217728,QA:0,models:0})+'\n',{flag:'wx'})
})
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function fixture(configured=false,materialCount=3,fixedOwner?:string){
 const owner=fixedOwner??randomUUID(),extraText='本轮不应发送的岗位知识正文',extraKnowledge={id:randomUUID(),version:1,title:'原有岗位资料',sourceId:'role-reference',sourceVersion:createHash('sha256').update(extraText).digest('hex'),scopeIds:['general'],text:extraText}
 if(configured)await f.pool.query("insert into teloa_resources(id,owner_id,revision,status,spec,created_at,updated_at) values($1,$2,1,'active',$3,now(),now())",[extraKnowledge.id,owner,JSON.stringify({title:extraKnowledge.title,sourceId:extraKnowledge.sourceId,sourceVersion:extraKnowledge.sourceVersion,scopeIds:extraKnowledge.scopeIds})])
 let knowledgeReads=0
 const groups=new CollaborationService(f.pool,identity),role=await new RoleService(f.pool,identity,undefined,async()=>({default:null,groups:[{id:'minimax',name:'隔离测试目录',remote:true,models:[{id:'MiniMax-M2.7',name:'隔离测试模型',reasoning:{efforts:[{id:'high',name:'high'}]}}]}],failures:[]})).create(owner,{requestId:randomUUID(),fields:{name:'文本编辑',kind:'employee',scopes:['general'],duty:'核对本人固定资料并起草',dataScope:'本轮固定资料',executionScope:'仅起草，不执行工具或外发',skills:configured?['editorial-sop']:[],knowledge:configured?[extraKnowledge.id]:[],responsibility:testRoleResponsibility,runtimeConfig:{model:{provider:'minimax',model:'MiniMax-M2.7',reasoningEffort:'high'}}}})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'文本恢复隔离验收',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[role.id]}}),resources=[]
 for(const name of ['观测','边界','方法'].slice(0,materialCount))resources.push(await groups.saveResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:name,markdown:name+'固定正文'}))
 const grants=new GroupAgentGrantService(f.pool,identity.now),grant=await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:1,expectedRoleVersion:role.version,action:'save',resources:resources.map(row=>({kind:'group-resource' as const,id:row.id,version:1})),canPost:true,canAutoRun:true})
 const text=materialCount?'仅用三份已授权资料交付内部分析初稿，不执行工具或外发。':'仅用本人本消息中的内容：A=120，B=80，C=50。请给内部分析，不执行工具、不新增事实、不外发。',message=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:1,text,references:resources.map(row=>({kind:'group-resource',id:row.id,version:1})),mentions:[{roleId:role.id,expectedVersion:role.version}]})
 const decisions=new GroupRoutingDecisionService(f.pool,identity),outbox=new GroupRoutingOutboxService(f.pool,identity),decision={kind:'direct' as const,respond:[role.id],reactions:[],hops:0,candidateIds:[role.id],truncatedCandidates:false,stopMessageId:null,at:identity.now(),intent:'work' as const,assignments:[{roleId:role.id,instructionRange:{start:0,end:text.length}}],workTarget:null}
 const [item]=await decisions.withTopicLock(owner,group.id,message.id,async db=>{await decisions.record(db,owner,{groupId:group.id,messageId:message.id,decision});return outbox.recordRecipients(db,owner,{groupId:group.id,messageId:message.id,decision,decisionVersion:1})})
 assert.ok(item)
 const conversations=new Map<string,{id:string;ownerId:string;sessionId:string;status:string}>(),inspect=async(_owner:string,sessionId:string)=>{const value=conversations.get(sessionId);if(!value)throw Error('missing fixture conversation');return value}
 // 兼容夹具明确模拟升级前未装配分析来源读口的旧宿主：只让首次原请求留下blocked。
 // 之后恢复读口走真实当前实现；不伪造scope/审批，不把正常新work强行堵回去。
 let legacyBootstrap=true
 const links=new ObjectConversationService(f.pool,inspect,identity.now),runs=new TaskRunService(f.pool,identity,inspect,{allowedTools:[],roleGrants:{validate:()=>{},recheck:async()=>{}},groupContext:(db,who,task,person,references,selection)=>legacyBootstrap?Promise.resolve(undefined):readRunGroupContext(db,who,task,person,undefined,f.pool,references,selection)})
 let creates=0,starts=0,unsent=true
 const ports={outbox,createTask:async(who:string,input:Parameters<GroupTaskService['create']>[1])=>{creates++;return {taskId:(await new GroupTaskService(f.pool,identity,new TaskService(f.pool,identity)).create(who,input)).task.id}},prepare:async(who:string,input:{requestId:string;taskId:string;expectedTaskVersion:number})=>{
  const sessionId='task-run-'+input.requestId;conversations.set(sessionId,conversations.get(sessionId)??{id:randomUUID(),ownerId:who,sessionId,status:'ready'})
  const link=await links.change(who,{requestId:input.requestId,kind:'task',objectId:input.taskId,expectedObjectVersion:input.expectedTaskVersion,sessionId,expectedLinkVersion:0,action:'link'})
  return {runId:(await runs.prepare(who,{...input,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:link.version},async(_session,person)=>{assert.deepEqual(person.skills,[]);assert.deepEqual(person.knowledge,[]);return []},async()=>{knowledgeReads++;return configured?[extraKnowledge]:[]},undefined,async()=> 'teloa-standard',async()=>({primary:role.runtimeConfig!.model!}))).id}
 },start:async(who:string,runId:string)=>{starts++;const {run}=await runs.claim(who,{runId});await runs.record(who,{runId,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'accepted'}});return {state:'accepted'}},readRun:async(who:string,runId:string)=>runs.get(who,{runId}),reconcile:async(who:string,runId:string)=>runs.get(who,{runId}),report:()=>{}}
 await drainGroupRoutingOutbox(owner,ports,AbortSignal.timeout(10000))
 legacyBootstrap=false
 const before=(await f.pool.query('select * from teloa_group_routing_outbox where id=$1',[item.id])).rows[0]
 assert.equal(before.state,'blocked');assert.equal(before.reason,'teloa/conflict');assert.ok(before.task_id);assert.equal(before.run_id,null);assert.equal(starts,0)
 const recovery=new GroupDeliveryRecoveryService(f.pool,identity,{assertUnsent:async input=>{assert.equal(input.ownerId,owner);assert.equal(input.requestId,item.requestId);if(!unsent)throw Error('fixture native admission unknown');return {sessionId:'task-run-'+item.requestId,sha256:hash({requestId:item.requestId,events:[]}),unsent:true}}})
 const target={groupId:group.id,messageId:message.id,roleId:role.id},candidate=()=>recovery.inspect(owner,target),command=async()=>{const fixed=await candidate();return {...target,requestId:randomUUID(),itemId:item.id,expectedBasisSha256:fixed.basisSha256,capability:'text' as const}}
 return {owner,role,group,groups,extraKnowledge,knowledgeReads:()=>knowledgeReads,resources,grants,grant,message,item,outbox,before,runs,ports,recovery,target,candidate,command,counts:()=>({creates,starts}),setUnsent:(value:boolean)=>{unsent=value}}
}

async function restartFixture(x:Awaited<ReturnType<typeof fixture>>){
 let host=1
 const authority={authorize:async()=>({assertCurrent(){}})},controls=new WorkControlService(f.pool,identity,{hostGeneration:()=>host,ownerAuthority:authority,inspectRun:async()=>({settled:true,unknownOperationIds:[]})}),recovery=new WorkRecoveryService(f.pool,identity,controls,{hostGeneration:()=>host,ownerAuthority:authority,authorizeResume:async()=>({assertCurrent(){}}),inspectCheckpoint:async()=>({reason:'unaccepted',checkpointSha256:hash('本用例的未提交检查点'),hasPendingInput:false,unknownOperationIds:[]})})
 const begin=async(planned=true)=>{
  host++;const restartId=randomUUID(),restarted=await controls.disarmForRestart(x.owner,{hostGeneration:host})
  assert.equal(restarted.length,1);if(planned)assert.equal(await controls.claimPlannedRestart(x.owner,{restartId,hostGeneration:host,controlIds:restarted.map(row=>row.id)}),true)
  for(const control of restarted)await controls.reconcile(x.owner,{controlId:control.id,generation:control.generation})
  return {restartId,hostGeneration:host,restarted}
 }
 const finish=async({restartId,restarted,hostGeneration}:Awaited<ReturnType<typeof begin>>)=>{
  const reports:string[]=[],drain=plannedRestartResume(x.owner,restartId,restarted,{controls,inspect:(owner,input)=>recovery.inspect(owner,input),resume:(owner,input,_signal,planned)=>recovery.resume(owner,input,planned),report:code=>reports.push(code)})
  await drain(AbortSignal.timeout(10000));assert.deepEqual(reports,[])
  return {restartId,hostGeneration,control:await controls.get(x.owner,{controlId:restarted[0]!.id})}
 }
 const restart=async()=>finish(await begin())
 const ordinary=async()=>{const current=await controls.get(x.owner,{controlId:String((x.before.dispatch_control_snapshot as {id:string}[])[0]!.id)}),pausing=await controls.change(x.owner,{requestId:randomUUID(),controlId:current.id,expectedVersion:current.version,action:'pause',scope:'round',roundControlId:null}),paused=await controls.reconcile(x.owner,{controlId:current.id,generation:pausing.generation}),candidates=await recovery.inspect(x.owner,{controlId:current.id});return recovery.resume(x.owner,{requestId:randomUUID(),controlId:current.id,expectedVersion:paused.version,candidateRunIds:candidates.map(candidate=>candidate.runId)})}
 return {controls,recovery,restart,begin,finish,ordinary}
}

test('计划重启连续两跳：inspect零写；本人确认才CAS原snapshot，原Task/request仅运行一次',async()=>{
 const x=await fixture(),r=await restartFixture(x),one=await r.restart(),two=await r.restart()
 assert.equal(one.control.generation,3);assert.equal(two.control.generation,5)
 const original=(await f.pool.query('select * from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0]
 const proofRows=async()=>Promise.all(['teloa_work_controls','teloa_work_control_progress','teloa_work_control_hosts','teloa_work_control_planned_restarts','teloa_work_recovery_requests','teloa_group_delivery_recoveries','teloa_group_delivery_recovery_rejections'].map(async table=>(await f.pool.query('select to_jsonb(t) as row from '+table+' t where owner_id=$1 order by to_jsonb(t)::text',[x.owner])).rows))
 const fixedProof=await proofRows(),candidate=await x.candidate();assert.deepEqual(await proofRows(),fixedProof,'inspect只读控制/正式证明/受理与负审计，零业务或元数据写')
 assert.deepEqual(candidate.controlRebinding,{kind:'planned-restart',restartCount:2})
 assert.deepEqual((await f.pool.query('select * from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0],original,'只读inspect不改变原blocked或snapshot')
 const command={...x.target,requestId:randomUUID(),itemId:x.item.id,expectedBasisSha256:candidate.basisSha256,capability:'text' as const},accepted=await x.recovery.recover(x.owner,command),audit=(await f.pool.query('select * from teloa_group_delivery_recoveries where owner_id=$1',[x.owner])).rows[0],rebound=(await f.pool.query('select * from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0]
 assert.deepEqual(audit.original_blocked,JSON.parse(JSON.stringify(original)));assert.deepEqual(audit.basis.controlRebinding.originalSnapshot,original.dispatch_control_snapshot);assert.equal(audit.basis.controlRebinding.chains[0].steps.length,2)
 assert.deepEqual(rebound.dispatch_control_snapshot,[{id:two.control.id,generation:5}]);assert.equal(rebound.task_id,original.task_id);assert.equal(rebound.request_id,original.request_id);assert.equal(rebound.state,'pending')
 await drainGroupRoutingOutbox(x.owner,x.ports,AbortSignal.timeout(10000));assert.deepEqual(x.counts(),{creates:1,starts:1});assert.equal((await f.pool.query('select * from teloa_task_runs where owner_id=$1',[x.owner])).rows.length,1)
 assert.deepEqual(await x.recovery.recover(x.owner,command),accepted);assert.deepEqual((await x.recovery.receipt(x.owner,command)).state,'accepted')
})

for(const fault of ['ordinary','interleaved','crash','pending','held','abandoned','missing-plan','missing-resume','wrong-request','version'] as const)test('计划重启证明拒绝'+fault+'，inspect零写且原blocked不派发',async()=>{
 const x=await fixture(),r=await restartFixture(x)
 if(fault==='ordinary')await r.ordinary()
 else if(fault==='interleaved'){await r.restart();await r.ordinary();await r.restart()}
 else if(fault==='crash'){
  const begun=await r.begin(false),paused=await r.controls.get(x.owner,{controlId:begun.restarted[0]!.id})
  await r.recovery.resume(x.owner,{requestId:randomUUID(),controlId:paused.id,expectedVersion:paused.version,candidateRunIds:[]})
 }else if(fault==='held'||fault==='abandoned'){
  const begun=await r.begin()
  if(fault==='held')await r.controls.recordPlannedRestart(x.owner,{restartId:begun.restartId,controlId:begun.restarted[0]!.id,outcome:'held:candidates'})
  else await r.controls.abandonPlannedRestarts(x.owner,{hostGeneration:begun.hostGeneration+1})
  const paused=await r.controls.get(x.owner,{controlId:begun.restarted[0]!.id});await r.recovery.resume(x.owner,{requestId:randomUUID(),controlId:paused.id,expectedVersion:paused.version,candidateRunIds:[]})
 }else if(fault==='pending'){
  const begun=await r.begin(),paused=await r.controls.get(x.owner,{controlId:begun.restarted[0]!.id})
  // 正式恢复已提交，但结果登记丢失：不能把尚pending的计划当完整证明。
  const requestId=plannedRestartResumeRequestId(begun.restartId,paused.id,text=>createHash('sha256').update(text).digest('hex'))
  await r.recovery.resume(x.owner,{requestId,controlId:paused.id,expectedVersion:paused.version,candidateRunIds:[]},{generation:paused.generation})
 }else{
  const first=await r.restart();await r.restart()
  // 以下仅破坏本用例拥有的隔离证明，不能作为正式重启的生产过程。
  if(fault==='missing-plan')await f.pool.query('delete from teloa_work_control_planned_restarts where owner_id=$1 and restart_id=$2',[x.owner,first.restartId])
  if(fault==='missing-resume')await f.pool.query('delete from teloa_work_recovery_requests where owner_id=$1 and (result->>\'generation\')::integer=3',[x.owner])
  if(fault==='wrong-request'){const replacement=randomUUID();await f.pool.query("update teloa_work_recovery_requests set request_id=$2::uuid,spec=jsonb_set(spec,'{requestId}',to_jsonb($2::text)) where owner_id=$1 and (result->>'generation')::integer=3",[x.owner,replacement])}
  if(fault==='version')await f.pool.query('update teloa_work_controls set version=version+1 where owner_id=$1',[x.owner])
 }
 const before=(await f.pool.query('select * from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0]
 await assert.rejects(x.candidate(),{code:'teloa/conflict'});assert.deepEqual((await f.pool.query('select * from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0],before);assert.equal(x.counts().starts,0)
 assert.equal((await f.pool.query('select 1 from teloa_group_delivery_recoveries where owner_id=$1',[x.owner])).rows.length,0);assert.equal((await f.pool.query('select 1 from teloa_group_delivery_recovery_rejections where owner_id=$1',[x.owner])).rows.length,0)
})

for(const change of ['restart','resource','grant','role'] as const)test('计划重启重新确认前'+change+'变化留下原nonce负回执，不重绑定不派发',async()=>{
 const x=await fixture(),r=await restartFixture(x);await r.restart();await r.restart();const command=await x.command()
 if(change==='restart')await r.restart()
 if(change==='resource')await f.pool.query('update teloa_group_resources set withdrawn_at=now() where id=$1',[x.resources[0]!.id])
 if(change==='grant')await x.grants.change(x.owner,{requestId:randomUUID(),groupId:x.group.id,roleId:x.role.id,expectedGroupVersion:1,expectedRoleVersion:x.role.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 if(change==='role')await f.pool.query('update teloa_roles set version=version+1 where id=$1',[x.role.id])
 await assert.rejects(x.recovery.recover(x.owner,command));assert.equal((await x.recovery.receipt(x.owner,command)).state,'not-accepted');await assert.rejects(x.recovery.recover(x.owner,command));assert.equal(x.counts().starts,0)
 const original=(await f.pool.query('select * from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0];assert.equal(original.state,'blocked');assert.deepEqual(original.dispatch_control_snapshot,x.before.dispatch_control_snapshot)
})

test('计划重启本人确认后再官方重启：claim保留固定snapshot并由不可变text依据拒绝，历史accepted不重新排队',async()=>{
 const x=await fixture(),r=await restartFixture(x);await r.restart();await r.restart();const command=await x.command(),accepted=await x.recovery.recover(x.owner,command);await r.restart()
 await drainGroupRoutingOutbox(x.owner,x.ports,AbortSignal.timeout(10000));assert.equal(x.counts().starts,0);assert.equal((await f.pool.query('select 1 from teloa_task_runs where owner_id=$1',[x.owner])).rows.length,0)
 const after=(await f.pool.query('select * from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0];assert.equal(after.state,'blocked');assert.equal(after.dispatch_control_snapshot[0].generation,5,'claim不能把已确认的5静默刷新为7');assert.equal((await f.pool.query('select basis from teloa_group_delivery_recoveries where owner_id=$1',[x.owner])).rows[0].basis.controls[0].generation,5,'本人确认的代次仍只在不可变审计中固定')
 assert.deepEqual(await x.recovery.recover(x.owner,command),accepted);assert.deepEqual((await f.pool.query('select * from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0],after)
})

test('计划重启确认后已prepared再普通暂停恢复：原Run的claim与模型准入均拒旧能力，历史仍可读',async()=>{
 const x=await fixture(),r=await restartFixture(x);await r.restart();await r.restart();await x.recovery.recover(x.owner,await x.command())
 const {runId}=await x.ports.prepare(x.owner,{requestId:x.item.requestId,taskId:x.before.task_id,expectedTaskVersion:1});assert.equal((await x.runs.get(x.owner,{runId})).state,'prepared');await x.runs.executionAdmission(x.owner,runId)
 await r.ordinary();await assert.rejects(x.runs.claim(x.owner,{runId}),{code:'teloa/conflict'});await assert.rejects(x.runs.executionAdmission(x.owner,runId),{code:'teloa/conflict'});assert.equal((await x.runs.get(x.owner,{runId})).state,'prepared');assert.equal(x.counts().starts,0)
})

test('生命周期再次确认：accepted后0Run经过正式重启，新inspect/新nonce沿原Task续办，旧nonce仅历史',async()=>{
 const x=await fixture(),firstCommand=await x.command(),first=await x.recovery.recover(x.owner,firstCommand),r=await restartFixture(x)
 await r.restart();assert.equal((await f.pool.query('select 1 from teloa_task_runs where owner_id=$1',[x.owner])).rows.length,0)
 const saved=async()=>Promise.all(['teloa_group_routing_outbox','teloa_group_delivery_recoveries','teloa_group_delivery_recovery_rejections'].map(async table=>(await f.pool.query('select row_to_json(t)::text as body from '+table+' t where owner_id=$1 order by body',[x.owner])).rows)),beforeInspect=await saved(),candidate=await x.candidate();assert.deepEqual(await saved(),beforeInspect,'再次inspect零写，不更新旧accepted、blocked或队列');assert.equal(candidate.reason,'text-capability-reconfirmation-required');assert.equal(candidate.reconfirmation?.previousRecoveryId,first.recoveryId)
 const nextCommand={...x.target,requestId:randomUUID(),itemId:x.item.id,expectedBasisSha256:candidate.basisSha256,capability:'text' as const},next=await x.recovery.recover(x.owner,nextCommand)
 assert.notEqual(next.recoveryId,first.recoveryId);assert.equal(next.taskId,first.taskId);assert.equal(next.dispatchRequestId,first.dispatchRequestId)
 assert.deepEqual(await x.recovery.recover(x.owner,firstCommand),first,'旧nonce不返回新授权，也不重排队')
 await drainGroupRoutingOutbox(x.owner,x.ports,AbortSignal.timeout(10000));const row=(await f.pool.query('select * from teloa_task_runs where owner_id=$1',[x.owner])).rows[0]
 assert.equal(JSON.parse(row.input_text).textCapability.approvalId,next.recoveryId);assert.deepEqual(x.counts(),{creates:1,starts:1})
})

test('生命周期仅本人原文也可再次确认，保留岗位SOP/知识配置但不加载额外正文',async()=>{
 const x=await fixture(true,0),one=await x.recovery.recover(x.owner,await x.command()),r=await restartFixture(x);await r.restart();const candidate=await x.candidate();assert.deepEqual(candidate.materials,[]);assert.equal(candidate.reconfirmation!.previousRecoveryId,one.recoveryId)
 const next=await x.recovery.recover(x.owner,{...x.target,requestId:randomUUID(),itemId:x.item.id,expectedBasisSha256:candidate.basisSha256,capability:'text'}),reads=x.knowledgeReads();await drainGroupRoutingOutbox(x.owner,x.ports,AbortSignal.timeout(10000));const row=(await f.pool.query('select * from teloa_task_runs where owner_id=$1',[x.owner])).rows[0],run=await x.runs.get(x.owner,{runId:row.id})
 assert.equal(run.textCapability!.approvalId,next.recoveryId);assert.deepEqual(run.textCapability!.materials,[]);assert.deepEqual(run.allowedTools,[]);assert.deepEqual(run.skills,[]);assert.deepEqual(run.knowledge,[]);assert.ok(!run.inputText.includes(x.extraKnowledge.text));assert.equal(x.knowledgeReads(),reads);assert.deepEqual(run.roleSnapshot!.skills,['editorial-sop']);assert.equal(run.taskId,x.before.task_id)
})

test('生命周期迁移：56旧item唯一约束真正替换，原行字节不变，重复初始化幂等',async()=>{
 const x=await fixture();await x.recovery.recover(x.owner,await x.command());const schema='j09_confirmation_'+randomUUID().replaceAll('-',''),db=await f.pool.connect()
 try{
  await db.query('begin');await db.query('create schema "'+schema+'"');await db.query('set local search_path to "'+schema+'", public')
  await db.query('create table teloa_group_delivery_recoveries(like public.teloa_group_delivery_recoveries including defaults including constraints)')
  await db.query('alter table teloa_group_delivery_recoveries add primary key(id), add unique(owner_id,request_id), add constraint actual_legacy_owner_item unique(owner_id,item_id)')
  await db.query('insert into teloa_group_delivery_recoveries select * from public.teloa_group_delivery_recoveries where owner_id=$1',[x.owner])
  const contents=async()=>(await db.query('select row_to_json(t)::text as body from teloa_group_delivery_recoveries t order by id')).rows,before=await contents()
  await initializeGroupDeliveryRecovery(db);await initializeGroupDeliveryRecovery(db);assert.deepEqual(await contents(),before,'不加列、不重写旧accepted/basis/receipt/blocked')
  const indexes=(await db.query("select pg_get_indexdef(indexrelid) as definition,indpred is null as plain,indisunique from pg_index where indrelid='teloa_group_delivery_recoveries'::regclass")).rows
  assert.equal(indexes.some(row=>row.plain&&row.indisunique&&row.definition.endsWith('(owner_id, item_id)')),false,'旧单例索引必须实际移除')
  assert.ok(indexes.some(row=>row.definition.includes('teloa_group_delivery_initial_item')));assert.ok(indexes.some(row=>row.definition.includes('teloa_group_delivery_single_successor')))
 }finally{await db.query('rollback');db.release()}
})

test('生命周期单后继：同前驱并发仅一接受，旧cap拒绝，后继再planned续签按链头而非时间选授权',async()=>{
 const x=await fixture(),one=await x.command(),first=await x.recovery.recover(x.owner,one),firstRow=(await f.pool.query('select * from teloa_group_delivery_recoveries where id=$1',[first.recoveryId])).rows[0],r=await restartFixture(x);await r.restart()
 const tied=new GroupDeliveryRecoveryService(f.pool,{...identity,now:()=>firstRow.created_at.toISOString()},x.recovery.host),candidate=await x.candidate(),left={...x.target,requestId:randomUUID(),itemId:x.item.id,expectedBasisSha256:candidate.basisSha256,capability:'text' as const},right={...left,requestId:randomUUID()},both=await Promise.allSettled([tied.recover(x.owner,left),tied.recover(x.owner,right)]),accepted=both.flatMap(row=>row.status==='fulfilled'?[row.value]:[])
 assert.equal(accepted.length,1);const second=accepted[0]!,rows=(await f.pool.query('select * from teloa_group_delivery_recoveries where owner_id=$1',[x.owner])).rows;assert.equal(rows.length,2)
 const duplicate=async(id:string,index:string)=>assert.rejects(f.pool.query("insert into teloa_group_delivery_recoveries(id,owner_id,request_id,item_id,task_id,dispatch_request_id,request_spec,original_blocked,basis,basis_sha256,capability,receipt,created_at) select $1::uuid,owner_id,$2::uuid,item_id,task_id,dispatch_request_id,jsonb_set(request_spec,'{requestId}',to_jsonb(($2::uuid)::text)),original_blocked,basis,basis_sha256,jsonb_set(capability,'{approvalId}',to_jsonb(($1::uuid)::text)),jsonb_set(jsonb_set(receipt,'{requestId}',to_jsonb(($2::uuid)::text)),'{recoveryId}',to_jsonb(($1::uuid)::text)),created_at from teloa_group_delivery_recoveries where id=$3::uuid",[randomUUID(),randomUUID(),id]),{code:'23505',constraint:index})
 await duplicate(first.recoveryId,'teloa_group_delivery_initial_item');await duplicate(second.recoveryId,'teloa_group_delivery_single_successor')
 const db=await f.pool.connect();try{await db.query('begin');await assert.rejects(assertRunTextControlsCurrent(db,x.owner,readRunTextCapability(firstRow.capability),firstRow.basis.outbox.lineage),{code:'teloa/conflict'});await db.query('rollback')}finally{db.release()}
 await r.restart();const latest=await x.candidate();assert.equal(latest.reconfirmation!.previousRecoveryId,second.recoveryId);const third=await tied.recover(x.owner,{...left,requestId:randomUUID(),expectedBasisSha256:latest.basisSha256})
 const beforeOldRead=(await f.pool.query('select * from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0];assert.deepEqual(await x.recovery.recover(x.owner,one),first);assert.deepEqual((await f.pool.query('select * from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0],beforeOldRead)
 assert.deepEqual((await f.pool.query('select * from teloa_group_delivery_recoveries where id=$1',[first.recoveryId])).rows[0],firstRow,'原确认和原blocked整行原样保留')
 const all=(await f.pool.query('select * from teloa_group_delivery_recoveries where owner_id=$1',[x.owner])).rows;assert.equal(all.length,3);assert.ok(all.every(row=>JSON.stringify(row.original_blocked)===JSON.stringify(firstRow.original_blocked)));assert.equal(new Set(all.map(row=>row.created_at.toISOString())).size,1,'真实同时间戳夹具，必须按前驱链选头')
 await drainGroupRoutingOutbox(x.owner,x.ports,AbortSignal.timeout(10000));const run=(await f.pool.query('select * from teloa_task_runs where owner_id=$1',[x.owner])).rows[0];assert.equal(JSON.parse(run.input_text).textCapability.approvalId,third.recoveryId);assert.deepEqual(x.counts(),{creates:1,starts:1})
})

for(const historical of [false,true])test('生命周期worker'+(historical?'旧claim已清snapshot':'当前claim固定snapshot')+'：blocked重新确认必须从旧accepted.controls证明，不信当前outbox快照',async()=>{
 const x=await fixture(),first=await x.recovery.recover(x.owner,await x.command()),r=await restartFixture(x);await r.restart();await drainGroupRoutingOutbox(x.owner,x.ports,AbortSignal.timeout(10000))
 const blocked=(await f.pool.query('select * from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0];assert.equal(blocked.state,'blocked');assert.equal(blocked.dispatch_control_snapshot[0].generation,1,'新claim保留原许可');assert.equal(x.counts().starts,0)
 // 明确注入旧worker曾刷新到3的历史现场；不是要求当前claim继续错误刷新。
 if(historical)await f.pool.query('update teloa_group_routing_outbox set dispatch_control_snapshot=$2 where owner_id=$3 and id=$1',[x.item.id,JSON.stringify(blocked.dispatch_control_snapshot.map((c:{id:string})=>({id:c.id,generation:3}))),x.owner])
 const candidate=await x.candidate();assert.equal(candidate.reconfirmation!.previousRecoveryId,first.recoveryId);const next=await x.recovery.recover(x.owner,{...x.target,requestId:randomUUID(),itemId:x.item.id,expectedBasisSha256:candidate.basisSha256,capability:'text'}),stored=(await f.pool.query('select basis from teloa_group_delivery_recoveries where id=$1',[next.recoveryId])).rows[0]
 assert.equal(stored.basis.controlRebinding.originalSnapshot[0].generation,1);assert.equal(stored.basis.reconfirmation.previousControls[0].generation,1)
 await drainGroupRoutingOutbox(x.owner,x.ports,AbortSignal.timeout(10000));assert.equal(x.counts().starts,1)
})

test('生命周期ordinary控制变化即使worker重置快照仍拒再次确认，同代次pending也不重复授权',async()=>{
 const x=await fixture(),first=await x.recovery.recover(x.owner,await x.command()),r=await restartFixture(x);await assert.rejects(x.candidate(),{code:'teloa/conflict'});await r.ordinary();await drainGroupRoutingOutbox(x.owner,x.ports,AbortSignal.timeout(10000));await assert.rejects(x.candidate(),{code:'teloa/conflict'});assert.equal((await f.pool.query('select 1 from teloa_group_delivery_recoveries where owner_id=$1',[x.owner])).rows.length,1);assert.equal(x.counts().starts,0);assert.equal((await f.pool.query('select receipt from teloa_group_delivery_recoveries where id=$1',[first.recoveryId])).rows[0].receipt.state,'pending')
})

test('生命周期预览后再变代次：新nonce负回执落定，迟到同nonce不复活，新inspect须另一次本人确认',async()=>{
 const x=await fixture(),original=await x.command(),first=await x.recovery.recover(x.owner,original),r=await restartFixture(x);await r.restart();const stale=await x.command();await r.restart();await assert.rejects(x.recovery.recover(x.owner,stale),{code:'teloa/conflict'});assert.equal((await x.recovery.receipt(x.owner,stale)).state,'not-accepted')
 const newest=await x.command(),accepted=await x.recovery.recover(x.owner,newest);assert.notEqual(accepted.recoveryId,first.recoveryId);await assert.rejects(x.recovery.recover(x.owner,stale));assert.deepEqual(await x.recovery.recover(x.owner,original),first);assert.equal(x.counts().starts,0)
})

for(const change of ['resource','grant','role','native-unknown','native-sent','leased'] as const)test('生命周期再次确认前'+change+'变化拒绝，不扩大原授权或派发',async()=>{
 const x=await fixture(),original=await x.command(),first=await x.recovery.recover(x.owner,original),r=await restartFixture(x);await r.restart();const command=await x.command();let service=x.recovery
 if(change==='resource')await f.pool.query('update teloa_group_resources set withdrawn_at=now() where id=$1',[x.resources[0]!.id])
 if(change==='grant')await x.grants.change(x.owner,{requestId:randomUUID(),groupId:x.group.id,roleId:x.role.id,expectedGroupVersion:1,expectedRoleVersion:x.role.version,action:'save',resources:x.resources.map(row=>({kind:'group-resource',id:row.id,version:1})),canPost:true,canAutoRun:true})
 if(change==='role')await f.pool.query('update teloa_roles set version=version+1 where id=$1',[x.role.id])
 if(change==='native-unknown')x.setUnsent(false)
 if(change==='native-sent')service=new GroupDeliveryRecoveryService(f.pool,identity,{assertUnsent:async()=>{throw new WorkError('teloa/conflict','fixture原native已有发送证据')}})
 if(change==='leased'){const item=(await x.outbox.pending(x.owner)).find(row=>row.id===x.item.id)!;assert.ok(await x.outbox.claim(x.owner,{itemId:item.id,expectedLeaseGeneration:item.leaseGeneration}))}
 await assert.rejects(service.recover(x.owner,command));assert.equal((await f.pool.query('select 1 from teloa_group_delivery_recoveries where owner_id=$1',[x.owner])).rows.length,1);assert.equal((await x.recovery.receipt(x.owner,command)).state,change==='native-unknown'?'unobserved':'not-accepted');assert.deepEqual(await x.recovery.recover(x.owner,original),first);assert.equal(x.counts().starts,0);assert.equal((await f.pool.query('select 1 from teloa_task_runs where owner_id=$1',[x.owner])).rows.length,0)
})

test('生命周期已有prepared Run即使native未发送，planned restart保持held且不得重新确认',async()=>{
 const x=await fixture();await x.recovery.recover(x.owner,await x.command());const {runId}=await x.ports.prepare(x.owner,{requestId:x.item.requestId,taskId:x.before.task_id,expectedTaskVersion:1}),r=await restartFixture(x),begun=await r.begin(),reports:string[]=[]
 await plannedRestartResume(x.owner,begun.restartId,begun.restarted,{controls:r.controls,inspect:(owner,input)=>r.recovery.inspect(owner,input),resume:(owner,input,_signal,planned)=>r.recovery.resume(owner,input,planned),report:code=>reports.push(code)})(AbortSignal.timeout(10000));assert.ok(reports.some(code=>code.endsWith(':candidates')))
 await assert.rejects(x.candidate(),{code:'teloa/conflict'});assert.equal((await x.runs.get(x.owner,{runId})).state,'prepared');assert.equal((await f.pool.query('select 1 from teloa_group_delivery_recoveries where owner_id=$1',[x.owner])).rows.length,1);assert.equal(x.counts().starts,0)
})

test('升级前未装配分析来源的work空工具拒绝；本人选择text后由原outbox自然恢复同Task/原request并留下独立失败审计',async()=>{
 const x=await fixture(),command=await x.command(),saved=await x.recovery.recover(x.owner,command)
 assert.equal(saved.taskId,x.before.task_id);assert.equal(saved.dispatchRequestId,x.item.requestId)
 const audit=(await f.pool.query('select * from teloa_group_delivery_recoveries where owner_id=$1',[x.owner])).rows
 assert.equal(audit.length,1);assert.deepEqual(audit[0].original_blocked,JSON.parse(JSON.stringify(x.before)));assert.equal(audit[0].capability.kind,'text')
 await assert.rejects(f.pool.query('update teloa_group_delivery_recoveries set capability=capability where id=$1',[audit[0].id]),/append-only/)
 await drainGroupRoutingOutbox(x.owner,x.ports,AbortSignal.timeout(10000));await drainGroupRoutingOutbox(x.owner,x.ports,AbortSignal.timeout(10000))
 const taskRows=(await f.pool.query('select id,version from teloa_tasks where owner_id=$1',[x.owner])).rows,runRows=(await f.pool.query('select * from teloa_task_runs where owner_id=$1',[x.owner])).rows
 assert.deepEqual(taskRows,[{id:x.before.task_id,version:2}]);assert.equal(runRows.length,1);assert.equal(runRows[0].request_id,x.item.requestId);assert.deepEqual(x.counts(),{creates:1,starts:1})
 const run=await x.runs.get(x.owner,{runId:runRows[0].id});assert.equal(run.textCapability?.approvalId,saved.recoveryId);assert.deepEqual(run.allowedTools,[]);assert.deepEqual(run.argumentRules,[]);assert.deepEqual(run.skills,[]);assert.deepEqual(run.knowledge,[]);assert.deepEqual(run.memory,[]);assert.equal(run.groupContext?.materials.length,3);assert.equal(JSON.parse(run.inputText).groupTopic,undefined)
 assert.deepEqual(await x.recovery.recover(x.owner,command),saved,'丢回包后同一请求只回原确认，不新建或再次派发')
 const toolGrants=(await f.pool.query('select * from teloa_role_tool_grants where role_id=$1',[x.role.id])).rows;assert.deepEqual(toolGrants,[])
})

test('并发恢复只允许一个CAS；相同request返回同审计，不同request不得越过原pending',async()=>{
 const x=await fixture(),one=await x.command()
 const results=await Promise.allSettled([x.recovery.recover(x.owner,one),x.recovery.recover(x.owner,one)])
 assert.equal(results.filter(row=>row.status==='fulfilled').length,2);await assert.rejects(x.recovery.recover(x.owner,{...one,requestId:randomUUID()}));assert.equal((await f.pool.query('select 1 from teloa_group_delivery_recoveries where owner_id=$1',[x.owner])).rows.length,1);assert.equal(x.counts().starts,0)
 const other=await fixture(),first=await other.command(),raced=await Promise.allSettled([other.recovery.recover(other.owner,first),other.recovery.recover(other.owner,{...first,requestId:randomUUID()})]);assert.equal(raced.filter(row=>row.status==='fulfilled').length,1)
})

for(const change of ['resource','grant','role','group','control','task','native'] as const)test('确认前'+change+'变化拒绝恢复且不派发',async()=>{
 const x=await fixture(),command=await x.command()
 if(change==='resource')await x.ports.outbox.pool.query('update teloa_group_resources set withdrawn_at=now() where id=$1',[x.resources[0]!.id])
 if(change==='grant')await x.grants.change(x.owner,{requestId:randomUUID(),groupId:x.group.id,roleId:x.role.id,expectedGroupVersion:1,expectedRoleVersion:x.role.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 if(change==='role')await f.pool.query('update teloa_roles set version=version+1 where id=$1',[x.role.id])
 if(change==='group')await f.pool.query('update teloa_groups set version=version+1 where id=$1',[x.group.id])
 if(change==='control')await f.pool.query('update teloa_work_controls set generation=generation+1 where owner_id=$1',[x.owner])
 if(change==='task')await f.pool.query('update teloa_tasks set version=version+1 where id=$1',[x.before.task_id])
 if(change==='native')x.setUnsent(false)
 await assert.rejects(x.recovery.recover(x.owner,command));assert.equal(x.counts().starts,0);assert.equal((await f.pool.query('select 1 from teloa_group_delivery_recoveries where owner_id=$1',[x.owner])).rows.length,0)
 const current=(await f.pool.query('select state,task_id,run_id,request_id from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0]
 assert.deepEqual(current,{state:'blocked',task_id:x.before.task_id,run_id:null,request_id:x.item.requestId})
})

test('外来owner或已有Run不能使用文本恢复',async()=>{
 const x=await fixture(),command=await x.command();await assert.rejects(x.recovery.recover(randomUUID(),command))
 await x.recovery.recover(x.owner,command);await drainGroupRoutingOutbox(x.owner,x.ports,AbortSignal.timeout(10000));await assert.rejects(x.recovery.recover(x.owner,{...command,requestId:randomUUID()}));assert.equal(x.counts().starts,1)
})


test('有既有SOP和知识的员工保留原配置；text Run只送本人所选固定资料，不加载额外正文',async()=>{
 const x=await fixture(true),readBefore=x.knowledgeReads();assert.equal(readBefore,1)
 await x.recovery.recover(x.owner,await x.command());await drainGroupRoutingOutbox(x.owner,x.ports,AbortSignal.timeout(10000))
 const row=(await f.pool.query('select * from teloa_task_runs where owner_id=$1',[x.owner])).rows[0],run=await x.runs.get(x.owner,{runId:row.id})
 assert.equal(run.state,'accepted');assert.deepEqual(run.skills,[]);assert.deepEqual(run.knowledge,[]);assert.equal(x.knowledgeReads(),readBefore,'text准备不调用额外知识读取端口')
 assert.deepEqual(run.roleSnapshot!.skills,['editorial-sop']);assert.deepEqual(run.roleSnapshot!.knowledge,[x.extraKnowledge.id]);assert.ok(!run.inputText.includes(x.extraKnowledge.text));assert.deepEqual((await new RoleService(f.pool,identity).get(x.owner,x.role.id))!.skills,['editorial-sop'])
})
for(const change of ['resource','grant','control'] as const)test('确认后worker准备前'+change+'失效仍拒绝且不派发',async()=>{
 const x=await fixture();await x.recovery.recover(x.owner,await x.command())
 if(change==='resource')await f.pool.query('update teloa_group_resources set withdrawn_at=now() where id=$1',[x.resources[0]!.id])
 if(change==='grant')await x.grants.change(x.owner,{requestId:randomUUID(),groupId:x.group.id,roleId:x.role.id,expectedGroupVersion:1,expectedRoleVersion:x.role.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 if(change==='control')await f.pool.query("update teloa_work_controls set state='paused',generation=generation+1 where owner_id=$1",[x.owner])
 await drainGroupRoutingOutbox(x.owner,x.ports,AbortSignal.timeout(10000));assert.equal(x.counts().starts,0);assert.equal((await f.pool.query('select 1 from teloa_task_runs where owner_id=$1',[x.owner])).rows.length,0)
 assert.equal((await f.pool.query('select 1 from teloa_group_delivery_recoveries where owner_id=$1',[x.owner])).rows.length,1,'原恢复审计保留，不删除失败事实')
})
test('原Task完整两轮：本人引用长初稿返工，新Run含真实全文/反馈/原3资料；同成果v2保留v1',async()=>{
 const x=await fixture();await x.recovery.recover(x.owner,await x.command());await drainGroupRoutingOutbox(x.owner,x.ports,AbortSignal.timeout(10000))
 const first=(await f.pool.query('select * from teloa_task_runs where owner_id=$1',[x.owner])).rows[0]
 const finish=async(runId:string)=>{const run=await x.runs.get(x.owner,{runId});return x.runs.record(x.owner,{runId,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}})}
 const initialEnded=await finish(first.id)
 const originalText='# 初稿\n\n'+ '这是固定分析原稿，不是授权。'.repeat(700)+'\n结尾事实，必须完整保留。',posts=new GroupRunMessageService(f.pool,identity,undefined,undefined,{recordRunMessage:x.outbox.recordRunMessage.bind(x.outbox),recordWake:x.outbox.recordWake.bind(x.outbox)})
 const delivered=await posts.post(x.owner,{requestId:randomUUID(),runId:first.id,text:originalText});assert.ok(delivered.text.length<originalText.length,'正式群流确实只保存预览')
 const artifacts=new ArtifactService(f.pool,identity,async(who,expected,db)=>({source:await taskArtifactSource(db,who,expected.id,true),sessionIds:await taskArtifactSessions(db,who,expected.id,true)})),source=await taskArtifactSource(f.pool,x.owner,x.before.task_id,true),initial=await artifacts.create(x.owner,{requestId:randomUUID(),source,content:{title:'内部初稿',sections:[{id:'run-result',title:'原稿',text:originalText}],snapshotIds:[],note:'原Run '+first.id}})
 const feedback='请沿原稿修改为读者邮件，保留事实与未知，不新增资料、不联网。',reply=await x.groups.send(x.owner,{requestId:randomUUID(),groupId:x.group.id,expectedVersion:1,replyToMessageId:delivered.id,text:feedback}),inputs=new GroupWorkInputService(f.pool,identity),db=await f.pool.connect();let reserved
 try{reserved=await inputs.reserveInTransaction(db,x.owner,{requestId:randomUUID(),groupId:x.group.id,messageId:reply.id,taskId:x.before.task_id,expectedTaskVersion:3,operation:'continue'})}finally{db.release()}
 const ports={inputs,prepare:x.ports.prepare,start:x.ports.start,readRun:x.ports.readRun,reconcile:x.ports.reconcile,stop:async()=> 'accepted' as const,report:()=>{}}
 await drainGroupWorkInputs(x.owner,ports,AbortSignal.timeout(10000));await drainGroupWorkInputs(x.owner,ports,AbortSignal.timeout(10000))
 assert.equal((await inputs.get(x.owner,reserved!.requestId)).state,'accepted')
 const rows=(await f.pool.query('select * from teloa_task_runs where owner_id=$1 order by task_version',[x.owner])).rows;assert.equal(rows.length,2);assert.equal(rows[0].input_text,first.input_text);assert.equal(rows[1].task_id,first.task_id)
 const second=await x.runs.get(x.owner,{runId:rows[1].id}),input=JSON.parse(second.inputText)
 assert.equal(second.state,'accepted');assert.equal(second.taskVersion,4);assert.equal(second.textCapability!.taskVersion,4);assert.equal(second.textCapability!.approvalId,JSON.parse(first.input_text).textCapability.approvalId);assert.equal(input.groupContinuation.messageId,reply.id);assert.equal(input.groupContinuation.text,feedback);assert.equal(input.groupContinuation.quoted.text,originalText);assert.equal(input.groupContinuation.quoted.sha256,createHash('sha256').update(originalText).digest('hex'));assert.equal(input.groupContinuation.quoted.runId,first.id);assert.equal(input.groupContinuation.quoted.nativeRequestId,first.native_request_id);assert.equal(input.groupContinuation.quoted.endedEvidenceSha256,createHash('sha256').update(JSON.stringify(initialEnded.evidence)).digest('hex'));assert.equal(input.groupContinuation.quoted.messageId,delivered.id);assert.deepEqual(second.textCapability!.materials,JSON.parse(first.input_text).textCapability.materials);assert.deepEqual(second.allowedTools,[])
 await finish(second.id);const finalText='经本人反馈修订的完整第二版。',finalMessage=await posts.post(x.owner,{requestId:randomUUID(),runId:second.id,text:finalText});assert.ok('runId' in finalMessage);assert.equal(finalMessage.runId,second.id)
 const final=await artifacts.revise(x.owner,{artifactId:initial.artifactId,expectedVersion:1,source:await taskArtifactSource(f.pool,x.owner,x.before.task_id,true),content:{...initial.content,sections:[{id:'run-result',title:'原稿',text:finalText}],note:'本人整理原返工Run '+second.id}})
 assert.equal(final.number,2);assert.equal(final.artifactId,initial.artifactId);assert.deepEqual(await artifacts.list(x.owner,{artifactId:initial.artifactId}),[initial,final]);assert.equal((await f.pool.query('select 1 from teloa_tasks where owner_id=$1',[x.owner])).rows.length,1);assert.deepEqual(x.counts(),{creates:1,starts:2})
 const forged=JSON.parse(rows[1].input_text);forged.groupContinuation.quoted.text+='伪造尾部';forged.groupContinuation.quoted.sha256=createHash('sha256').update(forged.groupContinuation.quoted.text).digest('hex')
 try{await f.pool.query('update teloa_task_runs set input_text=$2 where id=$1',[second.id,JSON.stringify(forged)]);await assert.rejects(x.runs.get(x.owner,{runId:second.id}),{code:'teloa/storage-corrupt'})}finally{await f.pool.query('update teloa_task_runs set input_text=$2 where id=$1',[second.id,rows[1].input_text])}
})

test('历史恢复回执严格核本人/Task/item/原dispatch/确认，损坏不重排队也不冒充当前执行',async()=>{
 const x=await fixture(),command=await x.command();await x.recovery.recover(x.owner,command)
 const fixed=(await f.pool.query('select * from teloa_group_delivery_recoveries where owner_id=$1',[x.owner])).rows[0]
 for(const mutate of [(row:any)=>{row.receipt.taskId=randomUUID()},(row:any)=>{row.receipt.recoveryId=randomUUID()},(row:any)=>{row.owner_id=randomUUID()},(row:any)=>{row.dispatch_request_id=randomUUID()},(row:any)=>{row.capability.roleId=randomUUID()},(row:any)=>{row.basis.task.title='损坏的原任务'},(row:any)=>{row.original_blocked.reason='伪造失败'},(row:any)=>{row.capability.sourceDigest='0'.repeat(64)}]){
  const corrupt=structuredClone(fixed);mutate(corrupt)
  const pool={connect:async()=>({query:async(sql:string)=>sql.startsWith('select * from teloa_group_delivery_recoveries')?{rows:[corrupt]}:{rows:[]},release(){}})} as unknown as typeof f.pool
  const recovery=new GroupDeliveryRecoveryService(pool,identity,{assertUnsent:async()=>{throw Error('回读不能重新准备')}})
  await assert.rejects(recovery.recover(x.owner,command),{code:'teloa/storage-corrupt'})
 }
 assert.equal(x.counts().starts,0);assert.equal((await f.pool.query('select state from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0].state,'pending')
})


test('本人原消息足够时materials可空；仍是原work Task/Run，额外角色知识和工具均不进入输入',async()=>{
 const x=await fixture(true,0),candidate=await x.candidate();assert.deepEqual(candidate.materials,[])
 await x.recovery.recover(x.owner,await x.command());await drainGroupRoutingOutbox(x.owner,x.ports,AbortSignal.timeout(10000))
 const row=(await f.pool.query('select * from teloa_task_runs where owner_id=$1',[x.owner])).rows[0],run=await x.runs.get(x.owner,{runId:row.id}),input=JSON.parse(run.inputText),source=(await f.pool.query('select snapshot_digest from teloa_group_task_sources where task_id=$1',[run.taskId])).rows[0]
 assert.equal(run.state,'accepted');assert.deepEqual(run.textCapability!.materials,[]);assert.equal(run.textCapability!.sourceDigest,source.snapshot_digest);assert.equal(input.groupContext.source.text,x.message.text);assert.match(input.groupContext.source.text,/A=120/);assert.deepEqual(run.knowledge,[]);assert.deepEqual(run.skills,[]);assert.deepEqual(run.allowedTools,[]);assert.ok(!run.inputText.includes(x.extraKnowledge.text));assert.equal(x.before.execution_mode,'work');assert.deepEqual(x.counts(),{creates:1,starts:1})
})

test('receipt先unobserved不写负回执；迟到原recover仍按同nonce受理，之后只回原历史受理不再排队',async()=>{
 const x=await fixture(),command=await x.command(),first=await x.recovery.receipt(x.owner,command);assert.equal(first.state,'unobserved')
 assert.equal((await f.pool.query('select 1 from teloa_group_delivery_recovery_rejections where owner_id=$1',[x.owner])).rows.length,0)
 const accepted=await x.recovery.recover(x.owner,command),before=(await f.pool.query('select state,lease_generation from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0]
 await f.pool.query("update teloa_roles set state='paused' where id=$1",[x.role.id])
 assert.deepEqual(await x.recovery.receipt(x.owner,command),{schema:'teloa.group-delivery-recovery-check/v1',state:'accepted',receipt:accepted});assert.deepEqual(await x.recovery.recover(x.owner,command),accepted)
 assert.deepEqual((await f.pool.query('select state,lease_generation from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0],before);assert.equal((await f.pool.query('select 1 from teloa_group_delivery_recovery_rejections where owner_id=$1',[x.owner])).rows.length,0)
})

test('确定未受理提交负回执与nonce围栏；即使原条件变好，迟到同nonce也不受理',async()=>{
 const x=await fixture(),command=await x.command();await f.pool.query("update teloa_roles set state='paused' where id=$1",[x.role.id]);await assert.rejects(x.recovery.recover(x.owner,command))
 const check=await x.recovery.receipt(x.owner,command);assert.equal(check.state,'not-accepted');assert.equal((await f.pool.query('select 1 from teloa_group_delivery_recovery_rejections where owner_id=$1',[x.owner])).rows.length,1)
 await f.pool.query("update teloa_roles set state='active' where id=$1",[x.role.id]);assert.equal((await x.candidate()).basisSha256,command.expectedBasisSha256,'测试确实恢复到原可受理依据')
 await assert.rejects(x.recovery.recover(x.owner,command));assert.equal((await f.pool.query('select 1 from teloa_group_delivery_recoveries where owner_id=$1',[x.owner])).rows.length,0);assert.equal(x.counts().starts,0);assert.equal((await f.pool.query('select state from teloa_group_routing_outbox where id=$1',[x.item.id])).rows[0].state,'blocked')
})

for(const changed of ['resource','grant','control'] as const)test('真实PG+client：inspect后'+changed+'变化→拒绝→只读核负回执→可处理同本人另一Task',async()=>{
 const x=await fixture(),items=[x];let raw:string|null=null;const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}},calls:string[]=[]
 const api=createGroupDeliveryRecoveryApi(async(endpoint,payload)=>{calls.push(endpoint);const row=payload as {groupId:string},target=items.find(item=>item.group.id===row.groupId)!;if(endpoint.endsWith('/inspect'))return target.recovery.inspect(x.owner,payload);if(endpoint.endsWith('/receipt'))return target.recovery.receipt(x.owner,payload);return target.recovery.recover(x.owner,payload)},journal)
 const candidate=await api.inspect(x.target)
 if(changed==='resource')await f.pool.query('update teloa_group_resources set withdrawn_at=now() where id=$1',[x.resources[0]!.id])
 if(changed==='grant')await x.grants.change(x.owner,{requestId:randomUUID(),groupId:x.group.id,roleId:x.role.id,expectedGroupVersion:1,expectedRoleVersion:1,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 if(changed==='control')await f.pool.query('update teloa_work_controls set generation=generation+1 where owner_id=$1',[x.owner])
 await assert.rejects(api.confirm(candidate));assert.ok(raw);const pending=api.pending()!;assert.equal((await api.recover()).state,'not-accepted');assert.equal(raw,null);assert.equal(api.pending(),undefined);assert.deepEqual(calls,['groups/delivery/inspect','groups/delivery/recover','groups/delivery/receipt']);await assert.rejects(x.recovery.recover(x.owner,pending));assert.equal(x.counts().starts,0)
 const other=await fixture(false,0,x.owner);items.push(other);const next=await api.inspect(other.target);assert.equal(next.taskId,other.before.task_id);assert.notEqual((await api.confirm(next)).requestId,pending.requestId);assert.equal(raw,null)
})


test('真实PG+无头UI：检查后材料失效→recover拒绝→只读具名负回执结束本地请求→另一Task的本人原文可确认',{timeout:60000},async t=>{
 const a=await fixture(),b=await fixture(false,0,a.owner),root=fileURLToPath(new URL('../../../',import.meta.url)),client=fileURLToPath(new URL('../../client/ui-workbench/src/client/',import.meta.url)),entryId=root+'__text_recovery_pg_ui.tsx',cryptoId='\0text-recovery-pg-crypto'
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {GroupTextWorkRecovery} from '${client}GroupTextWorkRecovery.tsx';import {createGroupDeliveryRecoveryApi} from '${client}group-delivery-recovery-api.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
 const targets=${JSON.stringify([{target:a.target,taskId:a.before.task_id},{target:b.target,taskId:b.before.task_id}])},f=window.fixture={calls:[],done:0};for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);document.body.style.margin='24px';
 const api=createGroupDeliveryRecoveryApi(async(endpoint,payload)=>{f.calls.push([endpoint,structuredClone(payload)]);const response=await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,payload})}),value=await response.json();if(!value.ok)throw Object.assign(Error(value.message),{code:value.code});return value.value},{read:()=>localStorage.getItem('original'),write:value=>localStorage.setItem('original',value),clear:()=>localStorage.removeItem('original')});
 const runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)},snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},app=createRoot(document.getElementById('root'));let selected=0;const render=()=>flushSync(()=>app.render(<I18nProvider runtime={runtime}><div className={tokens.tokens}><GroupTextWorkRecovery key={selected} api={api} target={targets[selected].target} taskId={targets[selected].taskId} done={()=>{f.done++}}/></div></I18nProvider>));f.selectB=()=>{selected=1;render()};render();`
 const result=await build({configFile:false,root,logLevel:'error',resolve:{alias:[{find:'node:crypto',replacement:cryptoId}]},plugins:[{name:'text-recovery-pg',resolveId:id=>id.endsWith('text-recovery-pg-test')?entryId:id===cryptoId?id:null,load:id=>id===entryId?entry:id===cryptoId?'export function createHash(){throw Error("server hash unavailable")};export function randomUUID(){return crypto.randomUUID()};export function createPublicKey(){throw Error("no signature")};export function verify(){throw Error("no signature")}':null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:'text-recovery-pg-test',name:'TextRecoveryPg',formats:['iife']}}}),bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:900}});t.after(()=>page.close());page.setDefaultTimeout(7000)
 await page.route('**/*',async (route:{request:()=>{url:()=>string;postDataJSON:()=>unknown};abort:()=>Promise<void>;fulfill:(response:{status:number;contentType:string;body:string})=>Promise<void>})=>{
  const url=new URL(route.request().url());if(url.origin!=='http://127.0.0.1:49327')return route.abort()
  if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'})
  if(url.pathname!=='/rpc')return route.abort()
  const request=route.request().postDataJSON() as {endpoint:string;payload:{groupId:string}},target=[a,b].find(item=>item.group.id===request.payload.groupId)
  if(!target)return route.abort()
  try{const value=request.endpoint==='groups/delivery/inspect'?await target.recovery.inspect(a.owner,request.payload):request.endpoint==='groups/delivery/receipt'?await target.recovery.receipt(a.owner,request.payload):request.endpoint==='groups/delivery/recover'?await target.recovery.recover(a.owner,request.payload):undefined;assert.notEqual(value,undefined);return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,value})})}catch(error){return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:false,code:error instanceof Error&&'code'in error?error.code:'teloa/dependency-unavailable',message:'原请求未受理或尚需核对。'})})}
 })
 await page.goto('http://127.0.0.1:49327/');await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const open=()=>page.getByRole('button',{name:'核对执行能力并继续原工作',exact:true}).click(),drawer=page.getByRole('dialog',{name:'继续原工作',exact:true});await open();await drawer.getByText('观测 · v1',{exact:true}).waitFor()
 await f.pool.query('update teloa_group_resources set withdrawn_at=now() where id=$1',[a.resources[0]!.id]);await drawer.getByRole('button',{name:'仅处理固定资料并继续',exact:true}).click();await drawer.getByRole('button',{name:'核对原恢复请求',exact:true}).waitFor();assert.ok(await page.evaluate(()=>localStorage.getItem('original')))
 const original=await page.evaluate(()=>(window as unknown as {fixture:{calls:Array<[string,{requestId:string}]>}}).fixture.calls.find(row=>row[0]==='groups/delivery/recover')![1])
 await drawer.getByRole('button',{name:'核对原恢复请求',exact:true}).click();await drawer.getByText('原恢复请求已确认未受理，没有开始工作。可重新核对原工作或处理其他任务。',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem('original')),null);assert.equal(await page.evaluate(()=>(window as unknown as {fixture:{done:number}}).fixture.done),0)
 if(process.env.TELOA_TEXT_RECOVERY_TEST_OUTPUT_DIR)await page.screenshot({path:join(process.env.TELOA_TEXT_RECOVERY_TEST_OUTPUT_DIR,'text-recovery-authoritative-not-accepted.png')})
 await drawer.getByRole('button',{name:'重新核对原工作',exact:true}).click();await drawer.getByRole('alert').waitFor();await page.keyboard.press('Escape');await page.evaluate(()=>(window as unknown as {fixture:{selectB:()=>void}}).fixture.selectB());await open();await drawer.getByText('本次仅处理本人原消息中的内容，不需要额外资料。',{exact:true}).waitFor()
 if(process.env.TELOA_TEXT_RECOVERY_TEST_OUTPUT_DIR)await page.screenshot({path:join(process.env.TELOA_TEXT_RECOVERY_TEST_OUTPUT_DIR,'text-recovery-owner-text-only.png')})
 await drawer.getByRole('button',{name:'仅处理原消息并继续',exact:true}).click();await drawer.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>(window as unknown as {fixture:{done:number}}).fixture.done),1)
 assert.equal((await a.recovery.receipt(a.owner,original)).state,'not-accepted');assert.equal((await f.pool.query('select 1 from teloa_task_runs where owner_id=$1',[a.owner])).rows.length,0);assert.equal((await f.pool.query('select state from teloa_group_routing_outbox where id=$1',[a.item.id])).rows[0].state,'blocked');assert.equal((await f.pool.query('select state from teloa_group_routing_outbox where id=$1',[b.item.id])).rows[0].state,'pending')
})

async function maintainedPreparedFixture(){
 await initializePreparedMaintenance(f.pool);await initializeTaskRunRuntimeLinks(f.pool)
 const x=await fixture(true),originalConfirmation=await x.recovery.recover(x.owner,await x.command())
 await drainGroupRoutingOutbox(x.owner,{...x.ports,start:async()=>{throw new WorkError('teloa/conflict','模拟实际已prepare但未进入native发送')}},AbortSignal.timeout(10000))
 const raw=(await f.pool.query('select * from teloa_task_runs where owner_id=$1',[x.owner])).rows[0],run=await x.runs.get(x.owner,{runId:raw.id}),runtimeId=null
 assert.equal(run.state,'prepared');assert.equal(run.textCapability!.approvalId,originalConfirmation.recoveryId)
 assert.equal((await f.pool.query('select 1 from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2',[x.owner,run.id])).rows.length,0)
 let host=1
 const authority={authorize:async()=>({assertCurrent(){}})},controls=new WorkControlService(f.pool,identity,{hostGeneration:()=>host,ownerAuthority:authority,inspectRun:async()=>({settled:false,unknownOperationIds:['runtime-owner:'+run.id]})})
 const current=await controls.get(x.owner,{controlId:run.lineage!.roundControlId}),pauseRequest={requestId:randomUUID(),controlId:current.id,expectedVersion:current.version,action:'pause' as const,scope:'round' as const,roundControlId:null},pause=await controls.change(x.owner,pauseRequest)
 const snapshot=hash('本PG用例的独立native冷证明；不冒称真实进程退出'),audit:PreparedMaintenanceAudit={schema:'teloa.prepared-maintenance/v1',requestId:randomUUID(),installId:randomUUID(),ownerId:x.owner,runId:run.id,taskId:run.taskId,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,inputSha256:createHash('sha256').update(run.inputText).digest('hex'),runtimeId,sourceVersion:'0.2.34',targetVersion:'0.2.35',pauseRequestId:pauseRequest.requestId,controlId:pause.id,controlGeneration:pause.generation,nativeSnapshotSha256:snapshot,nativeFileSha256:'a'.repeat(64),processReceiptSha256:'b'.repeat(64),backupManifestSha256:'c'.repeat(64)}
 const recovery=new WorkRecoveryService(f.pool,identity,controls,{hostGeneration:()=>host,ownerAuthority:authority,authorizeResume:async(db,owner,{candidate})=>x.runs.preparedMaintenanceResumeAdmissionInTransaction(db,owner,candidate.runId),inspectCheckpoint:async()=>({reason:'unaccepted',checkpointSha256:snapshot,hasPendingInput:false,unknownOperationIds:[]})})
 const coordinator=new WorkRecoveryCoordinator({service:recovery,runs:x.runs,startUnaccepted:async(owner,input)=>{input.lease.assertCurrent();await x.ports.start(owner,input.runId)},restoreAccepted:async()=>{throw Error('本用例不应重发已受理请求')}})
 const preserve=async()=>{await preservePreparedRun(f.pool,audit,{assertCurrent(){}},identity.now());host=2;await controls.disarmForRestart(x.owner,{hostGeneration:host})}
 const resume=async()=>{const control=await controls.get(x.owner,{controlId:pause.id});return coordinator.resume(x.owner,{requestId:randomUUID(),controlId:control.id,expectedVersion:control.version,candidateRunIds:[run.id]},AbortSignal.timeout(10000))}
 return {...x,run,audit,controls,recovery,preserve,resume,snapshot}
}

test('prepared维护投影：只把本人具名保全且当前来源有效的原blocked执行交给既有群恢复确认',{timeout:60000},async()=>{
 await initializeGroupRoutingAttempts(f.pool)
 const x=await maintainedPreparedFixture(),admit=async(owner:string,runId:string)=>{
  const db=await f.pool.connect();try{await db.query('begin');const lease=await x.runs.preparedMaintenanceResumeAdmissionInTransaction(db,owner,runId);lease.assertCurrent();await db.query('commit')}catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 const status=new GroupRoutingStatusService(f.pool,undefined,admit),read=async(service=status)=>(await service.status(x.owner,{groupId:x.group.id,messageIds:[x.message.id]})).items[0]!,hidden=async(service=status)=>{const row=await read(service);assert.notEqual(row.hintCode,'continue-paused');assert.equal(Object.hasOwn(row,'controlId'),false)}
 await hidden();await x.preserve()
 const before=(await f.pool.query('select * from teloa_group_routing_outbox where id=$1',[x.item.id])).rows
 const paused=await read();assert.equal(paused.phase,'paused');assert.equal(paused.hintCode,'continue-paused');assert.equal(paused.controlId,x.audit.controlId);assert.equal(paused.recipients[0]?.taskId,x.run.taskId);assert.equal(paused.recipients[0]?.runId,x.run.id)
 await hidden(new GroupRoutingStatusService(f.pool))
 await f.pool.query('update teloa_group_resources set withdrawn_at=now() where id=$1',[x.resources[0]!.id]);await hidden();await f.pool.query('update teloa_group_resources set withdrawn_at=null where id=$1',[x.resources[0]!.id])
 await f.pool.query("update teloa_roles set state='paused' where owner_id=$1 and id=$2",[x.owner,x.role.id]);await hidden();await f.pool.query("update teloa_roles set state='active' where owner_id=$1 and id=$2",[x.owner,x.role.id])
 await f.pool.query("update teloa_prepared_run_maintenance set resume='{}'::jsonb where owner_id=$1 and run_id=$2",[x.owner,x.run.id]);await hidden();await f.pool.query('update teloa_prepared_run_maintenance set resume=null where owner_id=$1 and run_id=$2',[x.owner,x.run.id])
 await f.pool.query('update teloa_prepared_run_maintenance set audit=$3 where owner_id=$1 and run_id=$2',[x.owner,x.run.id,JSON.stringify({...x.audit,taskId:randomUUID()})]);await hidden();await f.pool.query('update teloa_prepared_run_maintenance set audit=$3 where owner_id=$1 and run_id=$2',[x.owner,x.run.id,JSON.stringify(x.audit)])
 await f.pool.query("update teloa_work_controls set state='active' where owner_id=$1 and id=$2",[x.owner,x.audit.controlId]);await hidden();await f.pool.query("update teloa_work_controls set state='paused' where owner_id=$1 and id=$2",[x.owner,x.audit.controlId])
 await f.pool.query("update teloa_group_routing_outbox set reason='teloa/forbidden' where id=$1",[x.item.id]);await hidden();await f.pool.query('update teloa_group_routing_outbox set reason=$2 where id=$1',[x.item.id,before[0].reason])
 await assert.rejects(status.status(randomUUID(),{groupId:x.group.id,messageIds:[x.message.id]}),{code:'teloa/forbidden'})
 assert.deepEqual((await f.pool.query('select * from teloa_group_routing_outbox where id=$1',[x.item.id])).rows,before,'状态投影不改变原投递或创建恢复请求')
 assert.equal((await f.pool.query('select resume from teloa_prepared_run_maintenance where owner_id=$1 and run_id=$2',[x.owner,x.run.id])).rows[0].resume,null);assert.equal(x.counts().starts,0)
})

test('prepared维护：原Run明确续办及同Task返工；旧cap/input保持、outbox真实受理收口、负例不扩大许可',{timeout:60000},async t=>{
 const x=await maintainedPreparedFixture(),rows=async()=> (await f.pool.query('select * from teloa_prepared_run_maintenance where owner_id=$1',[x.owner])).rows
 let checks=0;await assert.rejects(preservePreparedRun(f.pool,x.audit,{assertCurrent(){if(++checks>1)throw Error('证明在提交前失效')}},identity.now()))
 assert.deepEqual(await rows(),[]);assert.equal((await x.controls.get(x.owner,{controlId:x.audit.controlId})).state,'pausing')
 await x.preserve();await preservePreparedRun(f.pool,x.audit,{assertCurrent(){}},identity.now());assert.equal((await rows()).length,1)
 assert.equal((await x.runs.get(x.owner,{runId:x.run.id})).inputText,x.run.inputText)
 const db=await f.pool.connect();try{
  await assert.rejects(assertRunTextControlsCurrent(db,x.owner,x.run.textCapability!,x.run.lineage,x.run.id))
  await db.query('begin');await assert.rejects(resumePreparedMaintenance(db,x.owner,{runId:x.run.id,requestId:randomUUID(),hostGeneration:2,checkpointSha256:x.snapshot,automatic:true},{assertCurrent(){}}));await db.query('rollback')
 }finally{db.release()}
 assert.equal((await rows())[0].resume,null);assert.equal(x.counts().starts,0)
 await x.resume();const accepted=await x.runs.get(x.owner,{runId:x.run.id});assert.equal(accepted.state,'accepted');assert.equal(accepted.inputText,x.run.inputText);assert.equal(x.counts().starts,1)
 const outbox=(await f.pool.query('select state,task_id,run_id,attempts from teloa_group_routing_outbox where owner_id=$1 and id=$2',[x.owner,x.item.id])).rows[0]
 assert.equal(outbox.state,'settled');assert.equal(outbox.task_id,x.run.taskId);assert.equal(outbox.run_id,x.run.id)
 assert.equal((await f.pool.query('select count(*)::int as n from teloa_task_runs where owner_id=$1',[x.owner])).rows[0].n,1)
 const firstEnded=await x.runs.record(x.owner,{runId:x.run.id,sessionId:x.run.sessionId,nativeRequestId:x.run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}})
 const posts=new GroupRunMessageService(f.pool,identity,undefined,undefined,{recordRunMessage:x.outbox.recordRunMessage.bind(x.outbox),recordWake:x.outbox.recordWake.bind(x.outbox)}),draftText='固定原稿。'.repeat(2000),delivered=await posts.post(x.owner,{requestId:randomUUID(),runId:x.run.id,text:draftText}),feedback='仅沿原三份资料和此完整原稿修订，不新增权限。',reply=await x.groups.send(x.owner,{requestId:randomUUID(),groupId:x.group.id,expectedVersion:1,replyToMessageId:delivered.id,text:feedback}),inputs=new GroupWorkInputService(f.pool,identity),client=await f.pool.connect();let reserved
 try{reserved=await inputs.reserveInTransaction(client,x.owner,{requestId:randomUUID(),groupId:x.group.id,messageId:reply.id,taskId:x.run.taskId,expectedTaskVersion:3,operation:'continue'})}finally{client.release()}
 await drainGroupWorkInputs(x.owner,{inputs,prepare:x.ports.prepare,start:x.ports.start,readRun:x.ports.readRun,reconcile:x.ports.reconcile,stop:async()=> 'accepted' as const,report:()=>{}},AbortSignal.timeout(10000))
 assert.equal((await inputs.get(x.owner,reserved!.requestId)).state,'accepted')
 const runs=(await f.pool.query('select * from teloa_task_runs where owner_id=$1 order by task_version',[x.owner])).rows;assert.equal(runs.length,2);assert.equal(runs[0].input_text,x.run.inputText)
 const second=await x.runs.get(x.owner,{runId:runs[1].id});assert.equal(second.state,'accepted');assert.equal(second.taskId,x.run.taskId);assert.equal(second.textCapability!.approvalId,x.run.textCapability!.approvalId);assert.deepEqual(second.textCapability!.materials,x.run.textCapability!.materials);assert.equal(JSON.parse(second.inputText).groupContinuation.quoted.text,draftText);assert.equal(JSON.parse(second.inputText).groupContinuation.quoted.endedEvidenceSha256,hash(firstEnded.evidence));assert.equal(x.counts().starts,2)
 const guardDb=await f.pool.connect();try{const current=(await guardDb.query('select id,state,generation from teloa_work_controls where owner_id=$1 order by id',[x.owner])).rows;assert.equal(await preparedMaintenanceControlsCurrent(guardDb,x.owner,second.id,{...second.textCapability!,taskId:randomUUID()},current),false);assert.equal(await preparedMaintenanceControlsCurrent(guardDb,x.owner,second.id,{...second.textCapability!,materials:[]},current),false)}finally{guardDb.release()}
 const active=await x.controls.get(x.owner,{controlId:x.audit.controlId});await x.controls.change(x.owner,{requestId:randomUUID(),controlId:active.id,expectedVersion:active.version,action:'pause',scope:'round',roundControlId:null});await assert.rejects(x.runs.executionAdmission(x.owner,second.id))
 await t.test('材料撤回则本人恢复原Run也拒绝，事务不授新许可',async()=>{const other=await maintainedPreparedFixture();await other.preserve();await f.pool.query('update teloa_group_resources set withdrawn_at=now() where id=$1',[other.resources[0]!.id]);await assert.rejects(other.resume());assert.equal((await other.runs.get(other.owner,{runId:other.run.id})).state,'prepared');assert.equal((await f.pool.query('select resume from teloa_prepared_run_maintenance where owner_id=$1',[other.owner])).rows[0].resume,null);assert.equal(other.counts().starts,0)})
})
