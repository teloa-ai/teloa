import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,isRoleDailyLog,readScheduleTrigger} from '@teloa/contract'
import {initializeResources} from '../src/capabilities/schema.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations} from '../src/work/object-conversations.ts'
import {initializeTaskRuns} from '../src/work/task-runs.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeArtifacts,ArtifactService} from '../src/work/artifacts.ts'
import {ArtifactMessageStore} from '../src/work/artifact-messages.ts'
import {taskArtifactSource} from '../src/work/artifact-task-source.ts'
import {initializeMarkdownKnowledge} from '../src/capabilities/markdown-knowledge.ts'
import {initializeRoleMemory,RoleMemoryService} from '../src/work/role-memory.ts'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {groupMessageBodySnapshot} from '../src/work/group-message-body.ts'
import {initializePlans} from '../src/work/plans.ts'
import {initializePlanOccurrences} from '../src/work/plan-occurrences.ts'
import {initializeBusinessData,BusinessDataService} from '../src/work/business-data.ts'
import {initializeBusinessSpaces,BusinessSpaceService} from '../src/work/business-spaces.ts'
import {initializeBusinessTasks,BusinessTaskService} from '../src/work/business-tasks.ts'
import {initializeSecurityRequests,SecurityRequestJournal} from '../src/security/request-journal.ts'
import {initializeSecurityActions,SecurityActionService} from '../src/security/actions.ts'
import {initializeSecurityApprovals,SecurityApprovalService} from '../src/security/approvals.ts'
import {createSecurityEndpointIsolateDefinition} from '../src/security/action-authorization.ts'
import {initializeSecurityActionExecutions,SecurityActionExecutionService} from '../src/security/action-executions.ts'
import {readSecurityActionGraph} from '../src/security/action-panel.ts'
import {readStoredTask} from '../src/work/tasks.ts'
import {initializeRoleDailyLogs,roleDailyDigestProposalLimit,RoleDailyLogService} from '../src/work/role-daily-logs.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const now='2026-09-13T01:00:00.000Z'
const identity={id:randomUUID,now:()=>now}
const day='2026-09-13'
const occurrenceId='2026-09-13T09:00[Asia/Singapore]'
const trigger={kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}
const inDay='2026-09-13T02:00:00.000Z'
const digest=(value:string)=>createHash('sha256').update(value).digest('hex')
const securityDefinition=createSecurityEndpointIsolateDefinition()
const catalog={require(tool:string){if(tool!==securityDefinition.tool)throw new WorkError('teloa/forbidden','未授权的工具。');return securityDefinition}}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:2000})
 await initializeResources(pool);await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeMarkdownKnowledge(pool);await initializeRoleMemory(pool)
 await initializeCollaboration(pool);await initializePlans(pool);await initializePlanOccurrences(pool)
 await initializeGroupAgentGrants(pool)
 await initializeBusinessData(pool);await initializeBusinessTasks(pool)
 await initializeSecurityRequests(pool);await initializeSecurityActions(pool);await initializeSecurityApprovals(pool)
  await initializeSecurityActionExecutions(pool)
 await initializeRoleDailyLogs(pool)
 await initializeBusinessSpaces(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

async function world(options:{source?:'system-digest'|'manual';historicalRole?:boolean}={}){
 const owner=randomUUID(),roles=new RoleService(pool,identity)
 const created=await roles.create(owner,{requestId:randomUUID(),fields:{name:'调查岗',kind:'employee',scopes:['SOC'],duty:'核对来源',dataScope:'已授权资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}})
 // 与正式安装一致：本人业务范围先登记，不能把旧内置命名当作读取授权。
 await new BusinessSpaceService(pool,identity).ensurePersonal(owner)
 let roleVersion=Number((await pool.query('select version from teloa_roles where id=$1',[created.id])).rows[0].version)
 const workRoleVersion=roleVersion
 if(options.historicalRole){
  const {id,ownerId,version,state,createdAt,updatedAt,...fields}=created;roleVersion=(await roles.edit(owner,{roleId:id,expectedVersion:roleVersion,fields:{...fields,duty:'在同一范围继续核对历史来源'}})).version
 }
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'季度复盘',goal:'核对处置记录',scope:'SOC'},assignee:{roleId:created.id,expectedVersion:roleVersion}})
 const historicalApproval=options.historicalRole?await approval(owner):undefined
 if(historicalApproval)await endedRun(owner,historicalApproval.task.id,created.id,workRoleVersion,'completed')
 const digestTask=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'每日小结',goal:'总结当天实际工作',scope:'SOC'},assignee:{roleId:created.id,expectedVersion:roleVersion}})
 const planId=randomUUID(),source=options.source==='manual'?{kind:'manual'}:{kind:'system-digest',roleId:created.id}
 const definition={title:'每日小结',goal:'把今天做过的事说清楚。',scope:'SOC',dataScope:'本人已授权资料。',delivery:'结论与证据。',roleId:created.id,trigger,notificationPolicy:'attention'}
 await pool.query(`insert into teloa_plans(id,owner_id,request_id,request_spec,definition,source,notification_policy,role_id,role_version,scope,version,config_version,state,archived_reason,archived_at,created_at,updated_at)
  values($1,$2,$3,$4,$5,$6,'attention',$7,$8,'SOC',1,1,'active',null,null,$9,$9)`,
  [planId,owner,randomUUID(),JSON.stringify({fields:{...definition,expectedRoleVersion:roleVersion},source}),JSON.stringify(definition),JSON.stringify(source),created.id,roleVersion,now])
 const claimId=randomUUID(),taskRequestId=randomUUID()
 await pool.query(`insert into teloa_plan_occurrences(id,owner_id,plan_id,plan_version,config_version,occurrence_id,scheduled_at,claimed_at,task_request_id,snapshot,snapshot_hash)
  values($1,$2,$3,1,1,$4,$5,$5,$6,$7,$8)`,[claimId,owner,planId,occurrenceId,now,taskRequestId,JSON.stringify({fields:definition,source,roleVersion}),digest(claimId)])
 await pool.query('insert into teloa_plan_task_links(claim_id,owner_id,task_request_id,task_id) values($1,$2,$3,$4)',[claimId,owner,taskRequestId,digestTask.id])
 const workRunId=options.historicalRole?await endedRun(owner,task.id,created.id,workRoleVersion,'completed'):await run(owner,task.id,created.id,workRoleVersion),runId=await run(owner,digestTask.id,created.id,roleVersion)
 const memory=new RoleMemoryService(pool,identity)
 return {owner,roleId:created.id,roleVersion,workRoleVersion,task,digestTask,planId,runId,workRunId,historicalApproval,memory,service:new RoleDailyLogService(pool,identity,memory),human:{ownerId:owner,kind:'human' as const}}
}

async function run(owner:string,taskId:string,roleId:string,roleVersion:number,createdAt=inDay){
 const id=randomUUID()
 await pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at)
  values($1,$2,$3,'{}'::jsonb,$4,$5,1,$6,1,$7,$8,'accepted','{}',$9)`,[id,owner,randomUUID(),taskId,roleId,roleVersion,'session-'+id,randomUUID(),createdAt])
 return id
}

async function endedRun(owner:string,taskId:string,roleId:string,roleVersion:number,reason:'completed'|'aborted'|'error',createdAt=inDay,taskVersion=1){
 const id=randomUUID()
 await pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,evidence,input_text,created_at)
  values($1,$2,$3,'{}'::jsonb,$4,$5,$11,$6,1,$7,$8,'ended',$9,'{}',$10)`,[id,owner,randomUUID(),taskId,roleId,roleVersion,'session-'+id,randomUUID(),JSON.stringify({state:'ended',turn:1,messageSeq:2,endSeq:2,reason}),createdAt,taskVersion])
 return id
}

async function artifact(owner:string,source:Record<string,unknown>,title:string,createdAt=inDay,number=1,artifactId=randomUUID(),text='已核对。'){
 if(number===1)await pool.query('insert into teloa_artifacts(id,owner_id,request_id,request_spec,source_key,current_version) values($1,$2,$3,\'{}\'::jsonb,$4,$5)',[artifactId,owner,randomUUID(),artifactId,number])
 else await pool.query('update teloa_artifacts set current_version=$2 where id=$1',[artifactId,number])
 const content={title,sections:[{id:'s1',title:'结论',text}],snapshotIds:[],note:'无附件。'}
 await pool.query('insert into teloa_artifact_versions(owner_id,artifact_id,number,source,content,created_at) values($1,$2,$3,$4,$5,$6)',[owner,artifactId,number,JSON.stringify(source),JSON.stringify(content),createdAt])
 return artifactId
}

async function groupMessage(owner:string,roleId:string,taskId:string,runId:string,createdAt=inDay,text='已按处置手册隔离。'){
 const groups=new CollaborationService(pool,{id:randomUUID,now:()=>createdAt})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'处置组',scope:'SOC',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[roleId]}})
 const root=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'今天的异常怎么处置？'})
 const id=randomUUID(),body=groupMessageBodySnapshot(text)
 await pool.query(`insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,text,reference_snapshot,created_at,task_id,run_id,full_text,full_text_meta)
  values($1,$2,$3,$4,'{}'::jsonb,$5,$6,$7,'[]'::jsonb,$8,$9,$10,$11,$12)`,[id,owner,group.id,randomUUID(),root.id,roleId,body.preview,createdAt,taskId,runId,body.body,body.summary])
 return {id,rootId:root.id,groupId:group.id}
}

async function approval(owner:string,scope='SOC',approverId=owner,at=now){
 const clock={id:randomUUID,now:()=>at}
 const principal={ownerId:owner,approverId,scopeIds:[scope]},sourceId='security-alert-http'
 const alert={scope,type:'alert',id:'evt-'+randomUUID().slice(0,8),version:1,title:'prod-03 异常脚本',source:'EDR',observedAt:'2026-09-12T01:00:00.000Z',receivedAt:'2026-09-12T01:00:01.000Z',quality:'complete' as const,summary:'调查外联。',fields:[{label:'资产',value:'prod-03'}]}
 const data=new BusinessDataService(pool,{id:sourceId,scopes:[scope],query:async()=>({schema:'teloa.data-source-page/v1',sourceId,scope,capturedAt:'2026-09-12T01:00:02.000Z',items:[alert]})})
 const snapshot=(await data.query(principal,{scope,limit:10})).items[0]!
 const {task}=await new BusinessTaskService(pool,clock,new TaskService(pool,clock)).create(principal,{requestId:randomUUID(),reference:{scope,type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash},goal:'核对资产风险'})
 const journal=new SecurityRequestJournal(pool),execution={existsForAction:async()=>false}
 const actions=new SecurityActionService(pool,clock,catalog,journal,execution)
 const approvals=new SecurityApprovalService(pool,clock,catalog,journal)
 const proposed=await actions.propose(principal,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,title:'隔离 prod-03',goal:'阻断异常外联',tool:securityDefinition.tool,targetSet:['prod-03'],params:{reason:'已核对异常进程'}})
 const pending=await actions.submit(principal,{requestId:randomUUID(),actionId:proposed.id,expectedActionVersion:proposed.version})
 const decided=await approvals.decide(principal,{requestId:randomUUID(),actionId:pending.id,expectedActionVersion:pending.version,decision:'approved',reason:'已核对生产影响',impactConfirmed:true})
 return {task,approval:decided,principal,actions,approvals,journal,data,alert}
}

const submission=(scopeIds=['SOC'],candidates=1,pruneHints:Array<{memoryId:string;reason:string}>=[])=>({
 title:'今天的小结',markdown:'核对了处置记录，形成了两条结论。',
 candidates:Array.from({length:candidates},(_,index)=>({title:'交付前核对来源 '+index,markdown:'交付前必须核对来源版本 '+index+'。',scopeIds})),
 pruneHints
})

test('AD05 选中审批的本人绑定损坏：读取和首次提交拒绝，日志记忆零写入',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!,a=await approval(f.owner,'SOC','wrong-fixture-actor')
 await endedRun(f.owner,a.task.id,f.roleId,f.roleVersion,'completed')
 const client=await pool.connect();try{await assert.rejects(readSecurityActionGraph(client,{ownerId:f.owner,approverId:f.owner,scopeIds:['SOC']},catalog),{code:'teloa/storage-corrupt'})}finally{client.release()}
 const before=await digestWriteSet(f.owner),results=await Promise.allSettled([f.service.dayEvidence(f.owner,who),f.service.submitDigest(f.owner,who,randomUUID(),submission())])
 assert.deepEqual(results.map(result=>result.status),['rejected','rejected'])
 for(const result of results)if(result.status==='rejected')assert.equal(result.reason.code,'teloa/storage-corrupt')
 assert.deepEqual(await digestWriteSet(f.owner),before)
})

test('AD05 已取证后 Task 时间损坏：共同读取与首次提交都拒绝，零日志记忆',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 assert.ok((await f.service.dayEvidence(f.owner,who)).runs.some(item=>item.id===f.workRunId))
 await pool.query('update teloa_tasks set created_at=updated_at+interval \'1 second\' where id=$1',[f.task.id])
 const raw=(await pool.query('select * from teloa_tasks where id=$1',[f.task.id])).rows[0]
 const before=await digestWriteSet(f.owner),results=await Promise.allSettled([f.service.dayEvidence(f.owner,who),f.service.submitDigest(f.owner,who,randomUUID(),submission())])
 assert.deepEqual(results.map(result=>result.status),['rejected','rejected'])
 assert.throws(()=>readStoredTask(raw),{code:'teloa/storage-corrupt'})
 for(const result of results)if(result.status==='rejected')assert.equal(result.reason.code,'teloa/storage-corrupt')
 assert.deepEqual(await digestWriteSet(f.owner),before)
})

test('AD05 固定的已执行历史审批在业务新版本和岗位新版本后仍可读',async()=>{
 const f=await world({historicalRole:true}),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!,a=f.historicalApproval!
 const approved=await a.actions.get(a.principal,{actionId:a.approval.actionId}),executions=new SecurityActionExecutionService(pool,identity,a.approvals,a.journal)
 const claimed=await executions.claim(a.principal,{requestId:randomUUID(),actionId:approved.id,expectedActionVersion:approved.version})
 const effect=await executions.recordEffect(a.principal,{operationId:claimed.execution.operationId,receipt:{status:'succeeded',receiptId:'local-fixture-effect',detail:'确定性测试回执，无外部操作',observedAt:now,targets:[{target:'prod-03',state:'succeeded'}]}})
 assert.equal(effect.state,'succeeded')
 a.alert.version=2;a.alert.summary='当日后续版本，历史批准仍指向旧快照'
 assert.equal((await a.data.query(a.principal,{scope:'SOC',limit:10})).items[0]?.version,2)
 assert.equal((await pool.query('select object_version from teloa_business_task_sources where task_id=$1',[a.task.id])).rows[0].object_version,1)
 const evidence=await f.service.dayEvidence(f.owner,who)
 assert.ok(evidence.approvals.some(item=>item.id===a.approval.id))
 assert.ok(f.roleVersion>f.workRoleVersion)
 const saved=await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0))
 assert.ok(saved.log.evidence.some(item=>item.id===a.approval.id))
})

test('AD05 未选中别岗的损坏审批图不污染本岗位证据',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!,other=await new RoleService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{name:'另一个调查岗',kind:'employee',scopes:['SOC'],duty:'处理独立工作',dataScope:'本人已授权资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}}),bad=await approval(f.owner,'SOC','other-invalid-actor')
 await endedRun(f.owner,bad.task.id,other.id,other.version,'completed')
 const evidence=await f.service.dayEvidence(f.owner,who)
 assert.equal(evidence.approvals.some(item=>item.id===bad.approval.id),false)
 const saved=await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0))
 assert.equal(saved.log.evidence.some(item=>item.id===bad.approval.id),false)
})

test('AD05R2 同 Task 旧日未选坏审批不阻断当日合法决定',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!,old=await approval(f.owner,'SOC','old-invalid-actor','2026-09-12T01:00:00.000Z'),actor={ownerId:f.owner,approverId:f.owner,scopeIds:['SOC']}
 await endedRun(f.owner,old.task.id,f.roleId,f.roleVersion,'completed')
 const oldClock={id:randomUUID,now:()=> '2026-09-12T03:00:00.000Z'},priorActions=new SecurityActionService(pool,oldClock,catalog,old.journal,{existsForAction:async()=>false}),priorApprovals=new SecurityApprovalService(pool,oldClock,catalog,old.journal)
 const prior=await priorActions.propose(actor,{requestId:randomUUID(),taskId:old.task.id,expectedTaskVersion:old.task.version,title:'合法旧决定',goal:'保留替代链',tool:securityDefinition.tool,targetSet:['prod-03'],params:{reason:'旧日核对'}}),priorPending=await priorActions.submit(actor,{requestId:randomUUID(),actionId:prior.id,expectedActionVersion:prior.version})
 await priorApprovals.decide(actor,{requestId:randomUUID(),actionId:priorPending.id,expectedActionVersion:priorPending.version,decision:'rejected',reason:'旧日拒绝',impactConfirmed:false})
 const actions=new SecurityActionService(pool,identity,catalog,old.journal,{existsForAction:async()=>false}),approvals=new SecurityApprovalService(pool,identity,catalog,old.journal)
 const proposed=await actions.propose(actor,{requestId:randomUUID(),taskId:old.task.id,expectedTaskVersion:old.task.version,title:'今天的正式决定',goal:'核对当天决定',tool:securityDefinition.tool,targetSet:['prod-03'],params:{reason:'当天已核对'},supersedesActionId:prior.id}),pending=await actions.submit(actor,{requestId:randomUUID(),actionId:proposed.id,expectedActionVersion:proposed.version})
 const current=await approvals.decide(actor,{requestId:randomUUID(),actionId:pending.id,expectedActionVersion:pending.version,decision:'rejected',reason:'今天拒绝',impactConfirmed:false})
 const client=await pool.connect();try{await assert.rejects(readSecurityActionGraph(client,actor,catalog),{code:'teloa/storage-corrupt'})}finally{client.release()}
 assert.deepEqual((await f.service.dayEvidence(f.owner,who)).approvals.map(item=>item.id),[current.id])
 assert.deepEqual((await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0))).log.evidence.filter(item=>item.kind==='approval').map(item=>item.id),[current.id])
})

test('AD05R2 session 成果的首版或精确 producer 仍核对前日 Run 的 Task',async t=>{
 for(const basis of ['first-run','producer'])await t.test(basis,async()=>{
  const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!,yesterday='2026-09-12T02:00:00.000Z',sessionSource={kind:'session',id:'fixed-role-material',scope:'SOC',version:'1',title:'当天成果'}
  await pool.query('update teloa_task_runs set created_at=$2 where id=$1',[f.workRunId,yesterday])
  const id=await artifact(f.owner,basis==='first-run'?{kind:'run',id:f.workRunId,scope:'SOC',version:'1',title:'原稿'}:sessionSource,'原稿',yesterday)
  await artifact(f.owner,sessionSource,'当天成果',inDay,2,id)
  if(basis==='producer'){
   // 覆盖持久化的精确归属读取；正式续改保留 base.source，并另记 producer（artifacts.ts）。
   const requestId=randomUUID()
   await pool.query(`insert into teloa_artifact_revision_requests(owner_id,id,request_spec,artifact_id,base_version,feedback_id,section_id,session_id,state,task_id,run_id,produced_version,created_at)
    values($1,$2,'{}',$3,1,$4,'s1','fixed-revision','completed',$5,$6,2,$7)`,[f.owner,requestId,id,randomUUID(),f.task.id,f.workRunId,inDay])
   await pool.query('insert into teloa_artifact_revision_producers values($1,$2,2,$3,$4,$5,1)',[f.owner,id,requestId,f.task.id,f.workRunId])
  }
  const healthy=await f.service.dayEvidence(f.owner,who)
  assert.ok([...healthy.artifacts,...healthy.revisions].some(item=>item.id===id));assert.equal(healthy.runs.length,0)
  await pool.query('update teloa_tasks set created_at=updated_at+interval \'1 second\' where id=$1',[f.task.id])
  const before=await digestWriteSet(f.owner),results=await Promise.allSettled([f.service.dayEvidence(f.owner,who),f.service.submitDigest(f.owner,who,randomUUID(),submission())])
  assert.deepEqual(results.map(result=>result.status),['rejected','rejected'])
  for(const result of results)if(result.status==='rejected')assert.equal(result.reason.code,'teloa/storage-corrupt')
  assert.deepEqual(await digestWriteSet(f.owner),before)
 })
})

test('AD05R2 无 Task 的本人 role-session 成果仍可读取',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!,sessionId='role-only-'+randomUUID()
 await pool.query('update teloa_task_runs set created_at=$2 where id=$1',[f.workRunId,'2026-09-12T02:00:00.000Z'])
 await pool.query("insert into teloa_object_conversations(owner_id,kind,object_id,object_version,conversation_id,session_id,version,active,updated_at,scope_id) values($1,'role',$2,$3,$4,$5,1,true,$6,'SOC')",[f.owner,f.roleId,f.roleVersion,randomUUID(),sessionId,now])
 const id=await artifact(f.owner,{kind:'session',id:sessionId,scope:'SOC',version:'1',title:'岗位资料'},'岗位资料')
 assert.deepEqual((await f.service.dayEvidence(f.owner,who)).artifacts.map(item=>item.id),[id])
})

const digestWriteTables=['teloa_role_daily_logs','teloa_role_daily_log_changes','teloa_role_memories','teloa_role_memory_versions','teloa_role_memory_creations','teloa_role_memory_changes','teloa_role_memory_edits'] as const
/** 比较本人的完整日志、经验与回执写集，不以只数日志代替整组拒绝。 */
async function digestWriteSet(owner:string){
 const result={} as Record<(typeof digestWriteTables)[number],Record<string,unknown>[]>
 for(const table of digestWriteTables)result[table]=(await pool.query('select to_jsonb(saved) as value from '+table+' saved where owner_id=$1 order by to_jsonb(saved)::text',[owner])).rows.map(row=>row.value as Record<string,unknown>)
 return result
}

async function confirmedDigestMemory(f:Awaited<ReturnType<typeof world>>,label:string,target={roleId:f.roleId,roleVersion:f.roleVersion,taskId:f.task.id}){
 const candidate=await f.memory.create(f.human,{requestId:randomUUID(),roleId:target.roleId,expectedRoleVersion:target.roleVersion,title:label,markdown:'可核对的原经验：'+label,source:{kind:'task',id:target.taskId,version:1},visibility:{kind:'role',scopeIds:['SOC']}})
 return f.memory.confirm(f.human,{requestId:randomUUID(),memoryId:candidate.id,expectedStateVersion:candidate.stateVersion})
}

test('建表幂等；一天一条；habit-digest 不能带运行身份',async()=>{
 await initializeRoleDailyLogs(pool);await initializeRoleDailyLogs(pool)
 const f=await world()
 const insert=(id:string,kind:string,runId:string|null,value=day)=>pool.query(`insert into teloa_role_daily_logs(id,owner_id,role_id,role_version,kind,day,state,run_id,title,markdown,scope_ids,evidence,prune_hints,request_id,request_spec,created_at,discarded_at)
  values($1,$2,$3,$4,$5,$6::date,'kept',$7,'标题','正文','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,$8,'{}'::jsonb,$9,null)`,[id,f.owner,f.roleId,f.roleVersion,kind,value,runId,randomUUID(),now])
 await insert(randomUUID(),'daily-digest',f.runId)
 await assert.rejects(insert(randomUUID(),'daily-digest',f.runId),/teloa_role_daily_logs_owner_id_role_id_kind_day_key|duplicate key/)
 await assert.rejects(insert(randomUUID(),'habit-digest',f.runId,'2026-09-14'),/violates check constraint/)
 await insert(randomUUID(),'habit-digest',null,'2026-09-14')
 await pool.query('insert into teloa_role_daily_log_changes(owner_id,request_id,request_spec,log_id,result,created_at) select owner_id,$1,\'{}\'::jsonb,id,\'{}\'::jsonb,created_at from teloa_role_daily_logs where owner_id=$2 limit 1',[randomUUID(),f.owner])
 await assert.rejects(pool.query('update teloa_role_daily_log_changes set log_id=log_id where owner_id=$1',[f.owner]),/immutable/)
 await assert.rejects(pool.query('delete from teloa_role_daily_log_changes where owner_id=$1',[f.owner]),/immutable/)
})

test('digestRun 只认系统计划的运行，普通计划与断链一律拒',async()=>{
 const system=await world(),manual=await world({source:'manual'})
 assert.deepEqual(await system.service.digestRun(system.owner,{runId:system.runId}),{runId:system.runId,taskId:system.digestTask.id,planId:system.planId,roleId:system.roleId,roleVersion:system.roleVersion,day})
 assert.equal(await manual.service.digestRun(manual.owner,{runId:manual.runId}),null)
 assert.equal(await system.service.digestRun(randomUUID(),{runId:system.runId}),null)
 assert.equal(await system.service.digestRun(system.owner,{runId:randomUUID()}),null)
 // 没有领取记录的任务就是断链：同一岗位、同一本人也照样拒。
 const orphan=await new TaskService(pool,identity).create(system.owner,{requestId:randomUUID(),fields:{title:'临时核对',goal:'没有计划来源',scope:'SOC'},assignee:{roleId:system.roleId,expectedVersion:system.roleVersion}})
 assert.equal(await system.service.digestRun(system.owner,{runId:await run(system.owner,orphan.id,system.roleId,system.roleVersion)}),null)
 const other=await world()
 await pool.query('update teloa_plans set source=$2 where id=$1',[other.planId,JSON.stringify({kind:'system-digest',roleId:randomUUID()})])
 assert.equal(await other.service.digestRun(other.owner,{runId:other.runId}),null)
})

test('五类证据各取一条并汇总范围；五类全空不产出',async()=>{
 const f=await world(),who=await f.service.digestRun(f.owner,{runId:f.runId})
 assert.ok(who)
 await assert.rejects(f.service.dayEvidence(f.owner,{...who,day:'2026-09-20'}),{code:'teloa/source-unavailable'})
 const produced=await artifact(f.owner,{kind:'run',id:f.workRunId,scope:'SOC',version:'1',title:'调查纪要'},'调查纪要')
 const revised=await artifact(f.owner,{kind:'run',id:f.workRunId,scope:'SOC',version:'1',title:'处置报告'},'处置报告')
 await artifact(f.owner,{kind:'session',id:'s-1',scope:'SOC',version:'1',title:'处置报告'},'处置报告',inDay,2,revised)
 const decided=await approval(f.owner)
 await run(f.owner,decided.task.id,f.roleId,f.roleVersion)
 const message=await groupMessage(f.owner,f.roleId,f.task.id,f.workRunId)
 const evidence=await f.service.dayEvidence(f.owner,who)
 assert.equal(evidence.day,day);assert.deepEqual(evidence.scopeIds,['SOC'])
 assert.equal(evidence.timezone,'Asia/Singapore')
 assert.deepEqual(evidence.runs.map(item=>item.title).sort(),['运行（未完成）：'+decided.task.title,'运行（未完成）：季度复盘'].sort())
 assert.deepEqual(evidence.artifacts.map(item=>[item.id,item.version]),[[produced,1],[revised,1]].sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))
 assert.deepEqual(evidence.approvals,[{kind:'approval',id:decided.approval.id,version:1,title:'允许：隔离 prod-03'}])
 assert.deepEqual(evidence.revisions,[{kind:'revision',id:revised,version:2,title:'处置报告'}])
 assert.deepEqual(evidence.groupMessages,[{kind:'group-message',id:message.id,version:1,title:'群回帖 · 话题 '+message.rootId.slice(0,8)}])
})

test('运行证据带真实终态：完成/中止/失败与未完成逐条可分辨，事件时区随证据返回',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const completed=await endedRun(f.owner,f.task.id,f.roleId,f.roleVersion,'completed')
 const aborted=await endedRun(f.owner,f.task.id,f.roleId,f.roleVersion,'aborted')
 const errored=await endedRun(f.owner,f.task.id,f.roleId,f.roleVersion,'error')
 const evidence=await f.service.dayEvidence(f.owner,who)
 const titles=new Map(evidence.runs.map(item=>[item.id,item.title]))
 assert.equal(titles.get(completed),'运行（完成）：季度复盘')
 assert.equal(titles.get(aborted),'运行（中止）：季度复盘')
 assert.equal(titles.get(errored),'运行（失败）：季度复盘')
 // world() 里原有运行仍是 accepted：必须明确为未完成，不能和完成一样。
 assert.equal(titles.get(f.workRunId),'运行（未完成）：季度复盘')
 assert.equal(titles.has(f.runId),false,'日结运行不属于业务工作证据')
 assert.equal(evidence.timezone,'Asia/Singapore')
})

test('当日证据给小结模型提供审批理由与员工回帖正文，不仅是目录标题',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const decided=await approval(f.owner)
 await run(f.owner,decided.task.id,f.roleId,f.roleVersion)
 await groupMessage(f.owner,f.roleId,f.task.id,f.workRunId)
 const evidence=await f.service.dayEvidence(f.owner,who),serialized=JSON.stringify(evidence)
 assert.ok(serialized.includes('已核对生产影响'),'正式审批服务保存的理由必须进入当日证据')
 assert.ok(serialized.includes('已按处置手册隔离。'),'员工回帖正文必须进入当日证据')
 const saved=await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0))
 assert.ok(isRoleDailyLog(saved.log),'输入正文不改变日志证据指针契约')
 assert.ok(saved.log.evidence.every(item=>Object.keys(item).sort().join(',')==='id,kind,title,version'))
})

test('正式任务成果及本人修订进入当日证据，固定版本的规则正文可供比较',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const service=new ArtifactService(pool,{id:randomUUID,now:()=>inDay},async(owner,expected,db)=>({source:await taskArtifactSource(db,owner,expected.id,true),sessionIds:[]}))
 const source=await taskArtifactSource(pool,f.owner,f.task.id,false)
 const content={title:'处置记录',sections:[{id:'rule',title:'判定口径',text:'合成告警只在连续失败达到 17 次时升级。'}],snapshotIds:[],note:'测试资料。'}
 const first=await service.create(f.owner,{requestId:randomUUID(),source,content})
 await service.revise(f.owner,{artifactId:first.artifactId,expectedVersion:1,source,content:{...content,sections:[{id:'rule',title:'判定口径',text:'本人纠正：合成告警连续失败达到 19 次才升级；17 次规则作废。'}]}})
 const evidence=await f.service.dayEvidence(f.owner,who)
 assert.ok(evidence.artifacts.some(item=>item.id===first.artifactId&&item.version===1),'任务来源成果初版不能丢失')
 assert.ok(evidence.revisions.some(item=>item.id===first.artifactId&&item.version===2),'本人保留相同来源的修订必须可见')
 assert.ok(JSON.stringify(evidence).includes('连续失败达到 17 次'))
 assert.ok(JSON.stringify(evidence).includes('连续失败达到 19 次'))
})

test('跨日修订附带固定基准正文，但不把昨天原稿算作今天产出',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const resolver=async(owner:string,expected:{id:string},db:Parameters<typeof taskArtifactSource>[0])=>({source:await taskArtifactSource(db,owner,expected.id,true),sessionIds:[]})
 const source=await taskArtifactSource(pool,f.owner,f.task.id,false)
 const content={title:'处置记录',sections:[{id:'rule',title:'判定口径',text:'旧规则：连续失败 17 次升级。'}],snapshotIds:[],note:'昨天原稿。'}
 const first=await new ArtifactService(pool,{id:randomUUID,now:()=> '2026-09-12T02:00:00.000Z'},resolver).create(f.owner,{requestId:randomUUID(),source,content})
 await new ArtifactService(pool,{id:randomUUID,now:()=>inDay},resolver).revise(f.owner,{artifactId:first.artifactId,expectedVersion:1,source,content:{...content,sections:[{id:'rule',title:'判定口径',text:'本人纠正：连续失败 19 次升级。'}]}})
 const evidence=await f.service.dayEvidence(f.owner,who)
 assert.ok(!evidence.artifacts.some(item=>item.id===first.artifactId),'历史基准不是当天产出')
 const revision=JSON.parse(evidence.contents!.find(item=>item.kind==='revision'&&item.id===first.artifactId)!.text)
 assert.equal(revision.baseline?.version,1)
 assert.equal(revision.baseline?.sections[0].text,content.sections[0]!.text)
 assert.equal(revision.sections[0].text,'本人纠正：连续失败 19 次升级。')
})

test('QLT002：固定修订正文与历史原消息分层，服务端逐段比较而不把原稿当当前稿',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const original='原回复保留过期的待办；这份历史消息不会随本人修订改写。',sessionId='revision-origin'
 const snapshotId=await new ArtifactMessageStore(pool).save(f.owner,{sessionId,messageId:'original-message',seq:2,role:'assistant',at:inDay,text:original,interrupted:false,omittedBlocks:0,images:[]})
 const resolver=async(owner:string,expected:{id:string},db:Parameters<typeof taskArtifactSource>[0])=>({source:await taskArtifactSource(db,owner,expected.id,true),sessionIds:[sessionId]})
 const service=new ArtifactService(pool,{id:randomUUID,now:()=>inDay},resolver),source=await taskArtifactSource(pool,f.owner,f.task.id,false)
 const content={title:'交付记录',sections:[{id:'conclusion',title:'结论',text:'当前结论。'},{id:'followup',title:'待办',text:'本人已删除过期待办。'}],snapshotIds:[],messageSnapshotIds:[snapshotId],note:'待办已修订。'}
 const first=await service.create(f.owner,{requestId:randomUUID(),source,content})
 const current={...content,sections:[content.sections[0]!,{id:'followup',title:'最终待办',text:'本人已确认当前待办。'}],note:'同步最终待办。'}
 await service.revise(f.owner,{artifactId:first.artifactId,expectedVersion:1,source,content:current})
 const evidence=await f.service.dayEvidence(f.owner,who),entry=evidence.contents!.find(item=>item.kind==='revision'&&item.id===first.artifactId)!,revision=JSON.parse(entry.text)
 assert.equal(entry.truncated,false)
 assert.equal(revision.version,2);assert.deepEqual(revision.sections,current.sections)
 assert.deepEqual(revision.baseline.sections,content.sections)
 assert.deepEqual(revision.comparison,{status:'compared',baselineVersion:1,bodyChanged:true,noteChanged:true,sectionOrderChanged:false,sectionChanges:[{id:'followup',kind:'modified',before:content.sections[1],after:current.sections[1]}]})
 assert.equal(revision.messages,undefined,'原始消息不能再以无用途标记的正文并列出现')
 assert.deepEqual(revision.historicalMessages,[{snapshotId,sha256:digest(original),text:original}])
 assert.deepEqual(revision.historicalMessageSnapshotIds,[snapshotId])
 assert.deepEqual(revision.baseline.historicalMessageSnapshotIds,[snapshotId])
 assert.equal(revision.baseline.historicalMessages,undefined,'相同历史正文只保留一份，基线用固定身份引用')
 assert.equal(entry.text.split(original).length-1,1)
 assert.equal(entry.sha256,digest(entry.text))
})

test('QLT002：纯说明修改、无变更拒绝和段落增删与重排分别给出确定性结果',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const source=await taskArtifactSource(pool,f.owner,f.task.id,false)
 const service=new ArtifactService(pool,{id:randomUUID,now:()=>inDay},async(owner,expected,db)=>({source:await taskArtifactSource(db,owner,expected.id,true),sessionIds:[]}))
 const a={id:'a',title:'甲',text:'当前甲。'},b={id:'b',title:'乙',text:'当前乙。'},c={id:'c',title:'丙',text:'旧丙。'},d={id:'d',title:'丁',text:'新增丁。'}
 const content={title:'顺序记录',sections:[a,b,c],snapshotIds:[],note:'最初说明。'},first=await service.create(f.owner,{requestId:randomUUID(),source,content})
 const read=async()=>JSON.parse((await f.service.dayEvidence(f.owner,who)).contents!.find(item=>item.kind==='revision'&&item.id===first.artifactId)!.text)
 const noteOnly={...content,note:'只改说明。'}
 await service.revise(f.owner,{artifactId:first.artifactId,expectedVersion:1,source,content:noteOnly})
 assert.deepEqual((await read()).comparison,{status:'compared',baselineVersion:1,bodyChanged:false,noteChanged:true,sectionOrderChanged:false,sectionChanges:[]})
 await assert.rejects(service.revise(f.owner,{artifactId:first.artifactId,expectedVersion:2,source,content:noteOnly}),{code:'teloa/conflict'})
 await service.revise(f.owner,{artifactId:first.artifactId,expectedVersion:2,source,content:{...noteOnly,sections:[b,a,d]}})
 assert.deepEqual((await read()).comparison,{status:'compared',baselineVersion:2,bodyChanged:true,noteChanged:false,sectionOrderChanged:true,sectionChanges:[{id:'c',kind:'removed',before:c,after:null},{id:'d',kind:'added',before:null,after:d}]})
 await service.revise(f.owner,{artifactId:first.artifactId,expectedVersion:3,source,content:{...noteOnly,sections:[a,b,d]}})
 assert.deepEqual((await read()).comparison,{status:'compared',baselineVersion:3,bodyChanged:true,noteChanged:false,sectionOrderChanged:true,sectionChanges:[]})
})

test('QLT002：未获授权的基准保持unknown，不伪造正文无差异',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const source={kind:'task',id:f.task.id,scope:'SOC',version:'v1',title:f.task.title}
 const outsideSource={kind:'analysis',id:'unrelated-scope',scope:'AppSec',version:'v1',title:'不可读基准'}
 const id=await artifact(f.owner,source,'原成果',inDay)
 // 用既有隔离数据夹具构造范围不可读的中间版本；不删除基准伪造完整历史。
 await artifact(f.owner,outsideSource,'不可读基准',inDay,2,id,'不可读基准正文。')
 await artifact(f.owner,source,'当前修订',inDay,3,id,'当前可读正文。')
 const entry=(await f.service.dayEvidence(f.owner,who)).contents!.find(item=>item.kind==='revision'&&item.id===id)!,revision=JSON.parse(entry.text)
 assert.equal(revision.baselineUnavailable,true);assert.equal(revision.baseline,null)
 assert.deepEqual(revision.comparison,{status:'unavailable',baselineVersion:null,bodyChanged:null,noteChanged:null,sectionOrderChanged:null,sectionChanges:[]})
 assert.ok(entry.text.includes('当前可读正文。'))
 assert.ok(!entry.text.includes('不可读基准'))
})

test('长群回帖读取校验后的全文和获授权话题根，损坏全文不能冒充完整预览',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const body='证据核对。'.repeat(1800)+'末尾决策：只在失败达到 19 次时升级。'
 const message=await groupMessage(f.owner,f.roleId,f.task.id,f.workRunId,inDay,body)
 const evidence=await f.service.dayEvidence(f.owner,who)
 const entry=evidence.contents!.find(item=>item.id===message.id)!,content=JSON.parse(entry.text)
 assert.equal(content.text,body)
 assert.equal(content.root?.id,message.rootId)
 assert.equal(content.root?.text,'今天的异常怎么处置？')
 assert.equal(entry.truncated,false)
 assert.equal(entry.sha256,digest(entry.text))
 await pool.query('update teloa_group_messages set full_text=$2 where owner_id=$1 and id=$3',[f.owner,body+'非法改变',message.id])
 await assert.rejects(f.service.dayEvidence(f.owner,who),{code:'teloa/storage-corrupt'})
})

test('群授权撤销后不读取他人的话题根正文，自己的历史回帖仍可核对',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const message=await groupMessage(f.owner,f.roleId,f.task.id,f.workRunId)
 await pool.query("update teloa_group_agent_grants set state='revoked',resources='[]',can_post=false,can_auto_run=false where owner_id=$1 and group_id=$2",[f.owner,message.groupId])
 const evidence=await f.service.dayEvidence(f.owner,who),content=JSON.parse(evidence.contents!.find(item=>item.id===message.id)!.text)
 assert.equal(content.text,'已按处置手册隔离。')
 assert.equal(content.root,null)
 assert.equal(content.rootUnavailable,true)
})

test('系统日结的历次运行和自产成果都不能递归充当当天工作',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 await pool.query('update teloa_task_runs set created_at=$2 where id=$1',[f.workRunId,'2026-09-12T02:00:00.000Z'])
 const previous=await endedRun(f.owner,f.digestTask.id,f.roleId,f.roleVersion,'completed')
 await artifact(f.owner,{kind:'run',id:previous,scope:'SOC',version:'1',title:'历史日结'},'历史日结')
 await artifact(f.owner,{kind:'task',id:f.digestTask.id,scope:'SOC',version:'1',title:'日结任务'},'日结任务')
 await assert.rejects(f.service.dayEvidence(f.owner,who),{code:'teloa/source-unavailable'})
})

test('成果按产出日入选，昨天运行今天交付可见，明天的版本不可见',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 await pool.query('update teloa_task_runs set created_at=$2 where id=$1',[f.workRunId,'2026-09-12T02:00:00.000Z'])
 const source={kind:'run',id:f.workRunId,scope:'SOC',version:'1',title:'跨日调查'}
 const today=await artifact(f.owner,source,'今天产出',inDay)
 const tomorrow=await artifact(f.owner,source,'明天产出','2026-09-14T02:00:00.000Z')
 const evidence=await f.service.dayEvidence(f.owner,who)
 assert.deepEqual(evidence.runs,[])
 assert.ok(evidence.artifacts.some(item=>item.id===today))
 assert.ok(!evidence.artifacts.some(item=>item.id===tomorrow))
})

test('正文随本人业务与员工范围过滤，业务撤销后不能继续读取旧正文',async()=>{
 const f=await world(),other=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 await artifact(f.owner,{kind:'run',id:f.workRunId,scope:'SOC',version:'1',title:'本岗'},'本岗',inDay,1,randomUUID(),'OWN-ALLOWED-731')
 await artifact(f.owner,{kind:'run',id:f.workRunId,scope:'OPS',version:'1',title:'越界'},'越界',inDay,1,randomUUID(),'OUTSIDE-SCOPE-923')
 await artifact(other.owner,{kind:'run',id:other.workRunId,scope:'SOC',version:'1',title:'他人'},'他人',inDay,1,randomUUID(),'OTHER-OWNER-842')
 const text=JSON.stringify(await f.service.dayEvidence(f.owner,who))
 assert.ok(text.includes('OWN-ALLOWED-731'));assert.ok(!text.includes('OUTSIDE-SCOPE-923'));assert.ok(!text.includes('OTHER-OWNER-842'))
 await pool.query('delete from teloa_business_scopes where owner_id=$1 and scope=$2',[f.owner,'SOC'])
 await assert.rejects(f.service.dayEvidence(f.owner,who),{code:'teloa/source-unavailable'})
})

test('同任务多员工且无版本生产回执时，不把混合成果正文归给某一员工',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const other=await new RoleService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{name:'另一个岗位',kind:'employee',scopes:['SOC'],duty:'复核',dataScope:'已授权资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}})
 await endedRun(f.owner,f.task.id,other.id,other.version,'completed')
 await artifact(f.owner,{kind:'task',id:f.task.id,scope:'SOC',version:'1',title:'混合成果'},'混合成果',inDay,1,randomUUID(),'AMBIGUOUS-EMPLOYEE-451')
 assert.ok(!JSON.stringify(await f.service.dayEvidence(f.owner,who)).includes('AMBIGUOUS-EMPLOYEE-451'))
})

test('精确生产归属不能被原任务回退绕过，越界旧版本不能作为修订基准',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const other=await new RoleService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{name:'另一个岗位',kind:'employee',scopes:['SOC'],duty:'复核',dataScope:'已授权资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}})
 const task=await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'另一员工工作',goal:'独立复核',scope:'SOC'},assignee:{roleId:other.id,expectedVersion:other.version}})
 const runId=await endedRun(f.owner,task.id,other.id,other.version,'completed')
 const source={kind:'task',id:f.task.id,scope:'SOC',version:'1',title:'版本边界'},yesterday='2026-09-12T02:00:00.000Z'
 const id=await artifact(f.owner,source,'版本边界',yesterday,1,randomUUID(),'原稿。')
 await artifact(f.owner,source,'版本边界',yesterday,2,id,'OTHER-PRODUCER-BASE-624')
 // 防御性来源夹具：当前正式续改路径仅允许 owner executor，不据此宣称生产越权已发生。
 const requestId=randomUUID()
 await pool.query(`insert into teloa_artifact_revision_requests(owner_id,id,request_spec,artifact_id,base_version,feedback_id,section_id,session_id,state,task_id,run_id,produced_version,created_at)
  values($1,$2,'{}',$3,1,$4,'s1','fixed-revision','completed',$5,$6,2,$7)`,[f.owner,requestId,id,randomUUID(),task.id,runId,yesterday])
 await pool.query('insert into teloa_artifact_revision_producers values($1,$2,2,$3,$4,$5,1)',[f.owner,id,requestId,task.id,runId])
 await artifact(f.owner,source,'版本边界',inDay,3,id,'今天本人修订。')
 const evidence=await f.service.dayEvidence(f.owner,who)
 const revision=JSON.parse(evidence.contents!.find(item=>item.kind==='revision'&&item.id===id)!.text)
 assert.equal(revision.sections[0].text,'今天本人修订。')
 assert.equal(revision.baseline,null)
 assert.equal(revision.baselineUnavailable,true)
 assert.ok(!JSON.stringify(evidence).includes('OTHER-PRODUCER-BASE-624'))
})

test('大量运行不能挤掉其它证据类别；正文预算保持UTF-8完整并显式标注截断',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 for(let index=0;index<60;index++)await endedRun(f.owner,f.task.id,f.roleId,f.roleVersion,'completed')
 const source={kind:'run',id:f.workRunId,scope:'SOC',version:'1',title:'大段成果'}
 const ids:Array<Awaited<ReturnType<typeof artifact>>>=[]
 for(let index=0;index<3;index++)ids.push(await artifact(f.owner,source,'长正文 '+index,inDay,1,randomUUID(),'😀中'.repeat(4000)))
 await artifact(f.owner,{kind:'session',id:'fixed-revision',scope:'SOC',version:'1',title:'本人修订'},'本人修订',inDay,2,ids[0],'本人纠正：连续失败 19 次才升级。')
 const decided=await approval(f.owner)
 await run(f.owner,decided.task.id,f.roleId,f.roleVersion)
 await groupMessage(f.owner,f.roleId,f.task.id,f.workRunId)
 const evidence=await f.service.dayEvidence(f.owner,who)
 assert.equal(evidence.artifacts.length,3,'运行条数多不应使成果整类消失')
 assert.equal(evidence.runs.length+evidence.artifacts.length+evidence.approvals.length+evidence.revisions.length+evidence.groupMessages.length,60)
 assert.ok(evidence.approvals.length&&evidence.revisions.length&&evidence.groupMessages.length)
 assert.equal(evidence.contents?.length,60)
 assert.ok(evidence.contents!.some(item=>item.truncated))
 assert.ok(evidence.contents!.reduce((sum,item)=>sum+Buffer.byteLength(item.text,'utf8'),0)<=65536)
 assert.ok(evidence.contents!.every(item=>!item.text.includes('\ufffd')&&/^[a-f0-9]{64}$/.test(item.sha256)))
 assert.ok(evidence.contents!.every(item=>item.text.length>0),'已选证据不能因前一条长正文而全部失去正文')
 assert.ok(evidence.contents!.filter(item=>item.kind==='artifact').every(item=>item.text.includes('😀中')),'每份长成果都应得到可读的正文预算')
 assert.ok(evidence.contents!.find(item=>item.kind==='approval')!.text.includes('已核对生产影响'))
 assert.ok(evidence.contents!.find(item=>item.kind==='revision')!.text.includes('连续失败 19 次才升级'))
 assert.ok(evidence.contents!.find(item=>item.kind==='group-message')!.text.includes('已按处置手册隔离'))
 const complete=evidence.contents!.find(item=>item.text&&!item.truncated)!
 assert.equal(complete.sha256,createHash('sha256').update(complete.text).digest('hex'))
})

test('任一类读口失败整次小结失败，不回落成空数组',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 await pool.query('alter table teloa_group_messages rename to teloa_group_messages_moved')
 try{await assert.rejects(f.service.dayEvidence(f.owner,who),{code:'teloa/storage-corrupt'})}
 finally{await pool.query('alter table teloa_group_messages_moved rename to teloa_group_messages')}
 await pool.query('alter table teloa_security_approvals rename to teloa_security_approvals_moved')
 try{await assert.rejects(f.service.dayEvidence(f.owner,who),{code:'teloa/storage-corrupt'})}
 finally{await pool.query('alter table teloa_security_approvals_moved rename to teloa_security_approvals')}
 assert.ok((await f.service.dayEvidence(f.owner,who)).runs.length)
})

test('一次小结落一条日志与三条候选，超额整次拒绝且库里零残留',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const seed=await f.memory.create(f.human,{requestId:randomUUID(),roleId:f.roleId,expectedRoleVersion:f.roleVersion,title:'旧结论',markdown:'旧结论正文。',source:{kind:'task',id:f.task.id,version:1},visibility:{kind:'role',scopeIds:['SOC']}})
 const confirmed=await f.memory.confirm(f.human,{requestId:randomUUID(),memoryId:seed.id,expectedStateVersion:1})
 const count=async()=>Number((await pool.query('select count(*)::int n from teloa_role_daily_logs where owner_id=$1',[f.owner])).rows[0].n)
 await assert.rejects(f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],4)),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.submitDigest(f.owner,who,randomUUID(),{...submission(),pruneHints:[{memoryId:randomUUID(),reason:'不再适用。'}]}),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.submitDigest(f.owner,who,randomUUID(),submission(['OTHER'])),{code:'teloa/forbidden'})
 assert.equal(await count(),0)
 const requestId=randomUUID(),input=submission(['SOC'],3,[{memoryId:confirmed.id,reason:'已被今天的结论取代。'}])
 const first=await f.service.submitDigest(f.owner,who,requestId,input)
 assert.equal(first.log.kind,'daily-digest');assert.equal(first.log.runId,f.runId);assert.equal(first.log.day,day);assert.equal(first.log.state,'kept')
 assert.deepEqual(first.log.pruneHints,[{memoryId:confirmed.id,memoryStateVersion:2,reason:'已被今天的结论取代。'}])
 assert.ok(first.log.evidence.length);assert.ok(isRoleDailyLog(first.log))
 assert.equal(first.candidates.length,3)
 for(const candidate of first.candidates){assert.equal(candidate.state,'confirmed');assert.deepEqual(candidate.source,{kind:'daily-digest',id:first.log.id,version:1});assert.equal(candidate.sourceTitle,'今天的小结');assert.equal(candidate.sourceAvailable,true);assert.deepEqual(candidate.proposedBy,{kind:'role',roleId:f.roleId,roleVersion:f.roleVersion})}
 const replay=await f.service.submitDigest(f.owner,who,requestId,input)
 assert.deepEqual(replay.log,first.log);assert.deepEqual(replay.candidates.map(item=>item.id),first.candidates.map(item=>item.id))
 assert.equal(await count(),1)
 await assert.rejects(f.service.submitDigest(f.owner,who,requestId,submission(['SOC'],1)),{code:'teloa/conflict'})
})

test('AD06：三条合法剪枝建议完整保存固定状态版本，不自行撤回原记忆',async()=>{
 assert.equal(roleDailyDigestProposalLimit,3,'提交规则的真源同时限定候选与剪枝建议')
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const memories:Array<Awaited<ReturnType<typeof confirmedDigestMemory>>>=[]
 for(let index=0;index<3;index++)memories.push(await confirmedDigestMemory(f,'合法剪枝目标 '+index))
 const before=await digestWriteSet(f.owner),original=await f.memory.list(f.human,{roleId:f.roleId})
 const hints=memories.map((memory,index)=>({memoryId:memory.id,reason:'建议核对适用性 '+index}))
 const result=await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0,hints))
 const expected=hints.map((hint,index)=>({...hint,memoryStateVersion:memories[index]!.stateVersion}))
 assert.equal(result.log.state,'kept');assert.deepEqual(result.log.pruneHints,expected);assert.deepEqual(result.candidates,[])
 const after=await digestWriteSet(f.owner)
 assert.equal(before.teloa_role_daily_logs.length,0);assert.equal(after.teloa_role_daily_logs.length,1)
 assert.deepEqual(after.teloa_role_daily_logs[0]!.prune_hints,expected,'三条建议按原顺序实际持久化')
 for(const table of digestWriteTables.filter(table=>table!=='teloa_role_daily_logs'))assert.deepEqual(after[table],before[table],table+' 不应因建议而修改')
 assert.deepEqual(await f.memory.list(f.human,{roleId:f.roleId}),original,'合法建议不改变目标正文、confirmed 状态或状态版本')
 assert.ok(original.every(memory=>memory.state==='confirmed'&&memory.stateVersion===2))
})

test('AD06：四条真实合法剪枝目标超限整组拒绝，日志与经验全部写集不变',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const hints:Array<{memoryId:string;reason:string}>=[]
 for(let index=0;index<4;index++)hints.push({memoryId:(await confirmedDigestMemory(f,'超限目标 '+index)).id,reason:'建议核对 '+index})
 const before=await digestWriteSet(f.owner)
 await assert.rejects(f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],3,hints)),{code:'teloa/invalid-input'})
 assert.deepEqual(await digestWriteSet(f.owner),before,'超限不得截断保存日志、候选、目标或回执')
})

test('AD06：同本人另一员工的真实记忆作为第三条剪枝目标时整组拒绝',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const own=[await confirmedDigestMemory(f,'本员工目标甲'),await confirmedDigestMemory(f,'本员工目标乙')]
 const other=await new RoleService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{name:'另一员工',kind:'employee',scopes:['SOC'],duty:'独立复核',dataScope:'已授权资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const task=await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'另一员工原工作',goal:'核对自己的资料',scope:'SOC'},assignee:{roleId:other.id,expectedVersion:other.version}})
 const foreign=await confirmedDigestMemory(f,'另一员工已确认经验',{roleId:other.id,roleVersion:other.version,taskId:task.id})
 assert.equal(foreign.ownerId,f.owner);assert.notEqual(foreign.roleId,f.roleId);assert.equal(foreign.state,'confirmed')
 const hints=[...own,foreign].map(memory=>({memoryId:memory.id,reason:'建议核对原经验'})),before=await digestWriteSet(f.owner)
 await assert.rejects(f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],3,hints)),{code:'teloa/invalid-input',message:'剪枝建议指向的记忆不存在、不属于本员工或不是已确认记忆。'})
 assert.deepEqual(await digestWriteSet(f.owner),before,'第三条跨员工目标无效时，前两条建议、候选及两名员工的记忆都不能改写')
})

test('AD06：正式撤回的真实记忆作为第三条剪枝目标时整组拒绝且不复活',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const own=[await confirmedDigestMemory(f,'仍有效目标甲'),await confirmedDigestMemory(f,'仍有效目标乙')]
 const remembered=await confirmedDigestMemory(f,'本人已撤回目标')
 const withdrawn=await f.memory.withdraw(f.human,{requestId:randomUUID(),memoryId:remembered.id,expectedStateVersion:remembered.stateVersion})
 assert.equal(withdrawn.state,'withdrawn');assert.equal(withdrawn.stateVersion,3)
 const hints=[...own,withdrawn].map(memory=>({memoryId:memory.id,reason:'建议核对原经验'})),before=await digestWriteSet(f.owner)
 await assert.rejects(f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],3,hints)),{code:'teloa/invalid-input',message:'剪枝建议指向的记忆不存在、不属于本员工或不是已确认记忆。'})
 assert.deepEqual(await digestWriteSet(f.owner),before,'被撤回目标不得复活、改版，前两条建议和候选也不得残留')
 assert.deepEqual((await f.memory.list(f.human,{roleId:f.roleId})).find(memory=>memory.id===withdrawn.id),withdrawn)
})

test('自动保存的记忆立即供运行读取，撤回后重试不重新启用',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const role=(await new RoleService(pool,identity).list(f.owner,{})).find(row=>row.id===f.roleId)!
 const requestId=randomUUID(),input=submission()
 const first=await f.service.submitDigest(f.owner,who,requestId,input)
 const remembered=(await f.memory.list(f.human,{roleId:f.roleId}))[0]!
 assert.equal(remembered.state,'confirmed')
 assert.deepEqual((await f.memory.confirmedForRun(pool,f.owner,{scope:'SOC'},role)).map(row=>row.id),[remembered.id])
 await f.memory.withdraw(f.human,{requestId:randomUUID(),memoryId:remembered.id,expectedStateVersion:remembered.stateVersion})
 await f.service.submitDigest(f.owner,who,requestId,input)
 assert.equal((await f.memory.list(f.human,{roleId:f.roleId}))[0]!.state,'withdrawn')
 assert.equal((await f.memory.confirmedForRun(pool,f.owner,{scope:'SOC'},role)).length,0)
 assert.equal(first.candidates.length,1)
})

test('自动记忆超过三十条仍保存，运行只取最近的三十条；普通工具仍只能提出候选',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const {log}=await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0))
 const role=(await new RoleService(pool,identity).list(f.owner,{})).find(row=>row.id===f.roleId)!
 const rows=[]
 for(let index=0;index<32;index++){
  const now=new Date(Date.parse(log.createdAt)+index*1000+1000).toISOString()
  const memory=new RoleMemoryService(pool,{id:randomUUID,now:()=>now})
  rows.push(await memory.remember({ownerId:f.owner,kind:'agent',roleId:f.roleId},{requestId:randomUUID(),roleId:f.roleId,expectedRoleVersion:f.roleVersion,title:'经验 '+index,markdown:'核对依据 '+index,source:{kind:'daily-digest',id:log.id,version:1},visibility:{kind:'role',scopeIds:['SOC']}}))
 }
 assert.equal((await f.memory.list(f.human,{roleId:f.roleId})).filter(row=>row.state==='confirmed').length,32)
 assert.deepEqual((await f.memory.confirmedForRun(pool,f.owner,{scope:'SOC'},role)).map(row=>row.id),rows.slice(-30).reverse().map(row=>row.id))
 const manual=await f.memory.create(f.human,{requestId:randomUUID(),roleId:f.roleId,expectedRoleVersion:f.roleVersion,title:'补充',markdown:'补充经验',source:{kind:'daily-digest',id:log.id,version:1},visibility:{kind:'role',scopeIds:['SOC']}})
 assert.equal(manual.state,'candidate')
 await assert.rejects(f.memory.remember(f.human,{requestId:randomUUID(),roleId:f.roleId,expectedRoleVersion:f.roleVersion,title:'无来源',markdown:'无来源',source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'role',scopeIds:['SOC']}}),{code:'teloa/invalid-input'})
})

test('list 倒序上限 60、get 回完整 15 键、三口只对本人开放',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const created=await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0))
 // 同一岗位两类日志合计61条，日期均在当前60日窗口内，验证回包上限而非过期条数。
 for(let index=0;index<60;index++)await pool.query(`insert into teloa_role_daily_logs(id,owner_id,role_id,role_version,kind,day,state,run_id,title,markdown,scope_ids,evidence,prune_hints,request_id,request_spec,created_at,discarded_at)
  values($1,$2,$3,$4,'habit-digest',$5::date,'kept',null,'习惯小结','今天的节奏。','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,$6,'{}'::jsonb,$7,null)`,
  [randomUUID(),f.owner,f.roleId,f.roleVersion,new Date(Date.UTC(2026,6,16+index)).toISOString().slice(0,10),randomUUID(),now])
 const listed=await f.service.list(f.human,{roleId:f.roleId})
 assert.equal(listed.items.length,60)
 assert.deepEqual(listed.items.map(item=>item.day),[...listed.items.map(item=>item.day)].sort().reverse())
 assert.equal(listed.items[0]!.day,day);assert.equal(Object.keys(listed.items[0]!).length,6)
 const got=await f.service.get(f.human,{roleId:f.roleId,logId:created.log.id})
 assert.deepEqual(got.log,created.log);assert.equal(Object.keys(got.log).length,15)
 const agent={ownerId:f.owner,kind:'agent' as const,roleId:f.roleId}
 await assert.rejects(f.service.list(agent,{roleId:f.roleId}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.get(agent,{roleId:f.roleId,logId:created.log.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.discard(agent,{requestId:randomUUID(),logId:created.log.id,expectedState:'kept'}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.list({ownerId:randomUUID(),kind:'human'},{roleId:f.roleId}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.get(f.human,{roleId:f.roleId,logId:randomUUID()}),{code:'teloa/forbidden'})
})

test('丢弃幂等且状态不符走版本冲突；派生记忆仍在但来源不可核对',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const created=await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],1))
 const candidate=created.candidates[0]!
 const kept=candidate
 assert.equal(kept.state,'confirmed');assert.equal(kept.sourceAvailable,true)
 const requestId=randomUUID(),input={requestId,logId:created.log.id,expectedState:'kept' as const}
 const discarded=await f.service.discard(f.human,input)
 assert.equal(discarded.log.state,'discarded');assert.ok(discarded.log.discardedAt)
 assert.deepEqual(await f.service.discard(f.human,input),discarded)
 await assert.rejects(f.service.discard(f.human,{requestId:randomUUID(),logId:created.log.id,expectedState:'kept'}),{code:'teloa/version-conflict'})
 await assert.rejects(f.service.discard(f.human,{...input,logId:randomUUID()}),{code:'teloa/conflict'})
 const after=(await f.memory.list(f.human,{roleId:f.roleId})).find(item=>item.id===candidate.id)!
 assert.equal(after.state,'confirmed');assert.equal(after.sourceAvailable,false);assert.deepEqual(after.content,kept.content)
})

test('保留 60 个自然日：日期缺口不延长历史，其派生记忆不受影响',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const oldest=randomUUID()
 for(let index=0;index<60;index++)await pool.query(`insert into teloa_role_daily_logs(id,owner_id,role_id,role_version,kind,day,state,run_id,title,markdown,scope_ids,evidence,prune_hints,request_id,request_spec,created_at,discarded_at)
  values($1,$2,$3,$4,'daily-digest',$5::date,'kept',$6,'历史小结','历史正文。',$7,'[]'::jsonb,'[]'::jsonb,$8,'{}'::jsonb,$9,null)`,
  [index===0?oldest:randomUUID(),f.owner,f.roleId,f.roleVersion,'2026-0'+(index<31?'7-'+String(index+1).padStart(2,'0'):'8-'+String(index-30).padStart(2,'0')),f.runId,JSON.stringify(['SOC']),randomUUID(),now])
 const legacy=await f.memory.create({ownerId:f.owner,kind:'agent',roleId:f.roleId},{requestId:randomUUID(),roleId:f.roleId,expectedRoleVersion:f.roleVersion,title:'历史结论',markdown:'历史结论正文。',source:{kind:'daily-digest',id:oldest,version:1},visibility:{kind:'role',scopeIds:['SOC']}})
 assert.equal(legacy.sourceAvailable,true)
 await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0))
 assert.equal((await pool.query('select count(*)::int n from teloa_role_daily_logs where owner_id=$1 and id=$2',[f.owner,oldest])).rows[0].n,0)
 // 9月13日的60日窗口从7月16日起；7月16日至8月29日共45条，加本日1条。
 assert.equal((await pool.query('select count(*)::int n from teloa_role_daily_logs where owner_id=$1',[f.owner])).rows[0].n,46)
 const survivor=(await f.memory.list(f.human,{roleId:f.roleId})).find(item=>item.id===legacy.id)!
 assert.equal(survivor.state,'candidate');assert.equal(survivor.sourceAvailable,false);assert.deepEqual(survivor.content,legacy.content)
})

for(const kind of ['daily-digest','habit-digest'] as const)test(`AD11 稀疏 ${kind} 按自然日边界淘汰，隔离归属并保留丢弃回执`,async()=>{
 const f=await world(),other=await world(),roles=new RoleService(pool,identity)
 const otherRole=await roles.create(f.owner,{requestId:randomUUID(),fields:{name:'独立岗位',kind:'employee',scopes:['SOC'],duty:'独立核对',dataScope:'本人资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}})
 const insert=async(value:{owner?:string;roleId?:string;roleVersion?:number;kind?:'daily-digest'|'habit-digest';day:string})=>{
  const id=randomUUID(),logKind=value.kind??kind
  await pool.query(`insert into teloa_role_daily_logs(id,owner_id,role_id,role_version,kind,day,state,run_id,title,markdown,scope_ids,evidence,prune_hints,request_id,request_spec,created_at,discarded_at)
   values($1,$2,$3,$4,$5,$6::date,'kept',$7,'稀疏历史','固定历史正文。',$8,'[]'::jsonb,'[]'::jsonb,$9,'{}'::jsonb,$10,null)`,
   [id,value.owner??f.owner,value.roleId??f.roleId,value.roleVersion??f.roleVersion,logKind,value.day,logKind==='daily-digest'?f.runId:null,JSON.stringify(logKind==='daily-digest'?['SOC']:[]),randomUUID(),now])
  return id
 }
 const expired=await insert({day:'2026-01-01'}),beforeBoundary=await insert({day:'2026-07-15'}),boundary=await insert({day:'2026-07-16'}),recent=await insert({day:'2026-08-30'})
 const receiptLog=await insert({day:'2025-12-01'}),discardInput={requestId:randomUUID(),logId:receiptLog,expectedState:'kept' as const}
 const receipt=await f.service.discard(f.human,discardInput)
 const isolated=[await insert({day:'2026-01-01',kind:kind==='daily-digest'?'habit-digest':'daily-digest'}),await insert({day:'2026-01-01',roleId:otherRole.id,roleVersion:otherRole.version}),await insert({day:'2026-01-01',owner:other.owner,roleId:other.roleId,roleVersion:other.roleVersion})]
 const beforeIsolated=(await pool.query('select * from teloa_role_daily_logs where id=any($1::uuid[]) order by id',[isolated])).rows
 if(kind==='daily-digest'){
  const who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
  await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0))
 }else{
  const db=await pool.connect()
  try{
   await db.query('begin')
   await f.service.writeHabitLog(db,f.owner,{roleId:f.roleId,roleVersion:f.roleVersion,day,title:'当前习惯小结',markdown:'当前观察。',evidence:[],requestId:randomUUID()})
   await db.query('commit')
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 const remaining=(await pool.query('select id from teloa_role_daily_logs where owner_id=$1 and role_id=$2 and kind=$3',[f.owner,f.roleId,kind])).rows.map(row=>row.id)
 assert.equal(remaining.includes(expired),false,'少于60条时也删除多月前的日志')
 assert.equal(remaining.includes(beforeBoundary),false,'第61个自然日不保留')
 for(const id of [boundary,recent,receiptLog])assert.ok(remaining.includes(id),'窗口边界及不可变丢弃回执保留')
 assert.equal(remaining.length,4)
 assert.deepEqual((await pool.query('select * from teloa_role_daily_logs where id=any($1::uuid[]) order by id',[isolated])).rows,beforeIsolated)
 assert.deepEqual(await f.service.discard(f.human,discardInput),receipt,'旧丢弃请求仍返回原回执')
})

for(const kind of ['daily-digest','habit-digest'] as const)test(`AD11 闲置 ${kind} 按业务时区到期，暂停不阻止清理且保留回执与派生内容`,async()=>{
 const f=await world(),other=await world()
 if(kind==='habit-digest'){
  const twin=await new RoleService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{name:'我的分身',kind:'twin',scopes:['general'],duty:'代拟',dataScope:'个人资料',executionScope:'仅代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
  f.roleId=twin.id;f.roleVersion=twin.version
 }
 const insert=async(owner:string,roleId:string,roleVersion:number,date:string)=>{
  const id=randomUUID()
  await pool.query(`insert into teloa_role_daily_logs(id,owner_id,role_id,role_version,kind,day,state,run_id,title,markdown,scope_ids,evidence,prune_hints,request_id,request_spec,created_at,discarded_at)
   values($1,$2,$3,$4,$5,$6::date,'kept',$7,'闲置历史','原日志正文。',$8,'[]'::jsonb,'[]'::jsonb,$9,'{}'::jsonb,$10,null)`,
   [id,owner,roleId,roleVersion,kind,date,kind==='daily-digest'?f.runId:null,JSON.stringify(kind==='daily-digest'?['SOC']:[]),randomUUID(),now])
  return id
 }
 const expired=await insert(f.owner,f.roleId,f.roleVersion,'2026-07-15'),boundary=await insert(f.owner,f.roleId,f.roleVersion,'2026-07-16'),receiptId=await insert(f.owner,f.roleId,f.roleVersion,'2026-01-01'),isolated=await insert(other.owner,other.roleId,other.roleVersion,'2026-01-01')
 const memory=await f.memory.create(kind==='daily-digest'?{ownerId:f.owner,kind:'agent',roleId:f.roleId}:f.human,{requestId:randomUUID(),roleId:f.roleId,expectedRoleVersion:f.roleVersion,title:'保留经验',markdown:'经验正文不随来源到期删除。',source:{kind,id:expired,version:1},visibility:kind==='daily-digest'?{kind:'role',scopeIds:['SOC']}:{kind:'private',scopeIds:[]}})
 const discardInput={requestId:randomUUID(),logId:receiptId,expectedState:'kept' as const},receipt=await f.service.discard(f.human,discardInput)
 await pool.query("update teloa_plans set state='paused' where owner_id=$1",[f.owner])
 await pool.query("update teloa_roles set state='paused' where owner_id=$1",[f.owner])
 await artifact(f.owner,{kind:'run',id:f.workRunId,scope:'SOC',version:'1',title:'原业务成果'},'保留的业务成果')
 const sourceBefore=(await pool.query('select * from teloa_artifact_versions where owner_id=$1',[f.owner])).rows
 // 新加坡9月12日23:59尚含7月15日；跨本地午夜后第61日到期，UTC日期仍为9月12日。
 await f.service.pruneExpired(f.owner,'2026-09-12T15:59:00.000Z')
 assert.ok((await pool.query('select 1 from teloa_role_daily_logs where id=$1',[expired])).rows[0])
 await f.service.pruneExpired(f.owner,'2026-09-12T16:00:00.000Z')
 assert.deepEqual((await pool.query('select id from teloa_role_daily_logs where owner_id=$1 order by id',[f.owner])).rows.map(row=>row.id),[boundary,receiptId].sort())
 assert.ok((await pool.query('select 1 from teloa_role_daily_logs where id=$1',[isolated])).rows[0])
 assert.deepEqual(await f.service.discard(f.human,discardInput),receipt)
 const kept=(await f.memory.list(f.human,{roleId:f.roleId})).find(item=>item.id===memory.id)!
 assert.equal(kept.sourceAvailable,false);assert.deepEqual(kept.content,memory.content)
 assert.deepEqual((await pool.query('select * from teloa_artifact_versions where owner_id=$1',[f.owner])).rows,sourceBefore)
 await f.service.pruneExpired(f.owner,'2026-09-12T16:00:00.000Z')
})

for(const kind of ['daily-digest','habit-digest'] as const)test(`AD11 迟到 ${kind} 在窗口边界可写，过期明确拒绝且无日志记忆残留`,async()=>{
 for(const latestDay of ['2026-11-11','2026-11-12']){
  const f=await world(),requestId=randomUUID()
  // 被提交的业务日固定为9月13日；相对后续11月11/12日分别位于第60/61个自然日。
  await pool.query(`insert into teloa_role_daily_logs(id,owner_id,role_id,role_version,kind,day,state,run_id,title,markdown,scope_ids,evidence,prune_hints,request_id,request_spec,created_at,discarded_at)
   values($1,$2,$3,$4,$5,$6::date,'kept',$7,'后续业务日','固定后续正文。',$8,'[]'::jsonb,'[]'::jsonb,$9,'{}'::jsonb,$10,null)`,
   [randomUUID(),f.owner,f.roleId,f.roleVersion,kind,latestDay,kind==='daily-digest'?f.runId:null,JSON.stringify(kind==='daily-digest'?['SOC']:[]),randomUUID(),latestDay+'T12:00:00.000Z'])
  const before=await digestWriteSet(f.owner)
  const submit=async()=>{
   if(kind==='daily-digest')return (await f.service.submitDigest(f.owner,(await f.service.digestRun(f.owner,{runId:f.runId}))!,requestId,submission())).log
   const db=await pool.connect()
   try{
    await db.query('begin')
    const log=await f.service.writeHabitLog(db,f.owner,{roleId:f.roleId,roleVersion:f.roleVersion,day,title:'迟到习惯小结',markdown:'迟到观察。',evidence:[],requestId})
    await db.query('commit');return log
   }catch(error){await db.query('rollback');throw error}finally{db.release()}
  }
  if(latestDay==='2026-11-12'){
   await assert.rejects(submit(),{code:'teloa/source-unavailable'})
   assert.deepEqual(await digestWriteSet(f.owner),before)
  }else{
   const log=await submit()
   assert.equal(log.day,day);assert.equal(log.kind,kind)
   assert.deepEqual(await submit(),log,'边界迟到请求仍可幂等重放')
  }
 }
})

test('writeHabitLog 在调用方事务里落一条无运行身份的习惯小结且重放幂等',async()=>{
 const f=await world(),requestId=randomUUID()
 const value={roleId:f.roleId,roleVersion:f.roleVersion,day,title:'这周的节奏',markdown:'固定在周一开工。',evidence:[{kind:'run' as const,id:f.runId,version:1,title:'运行：季度复盘'}],requestId}
 const client=await pool.connect()
 try{
  await client.query('begin')
  const log=await f.service.writeHabitLog(client,f.owner,value)
  assert.equal(log.kind,'habit-digest');assert.equal(log.runId,null);assert.deepEqual(log.scopeIds,[]);assert.equal(log.evidence.length,1)
  assert.deepEqual(await f.service.writeHabitLog(client,f.owner,value),log)
  await assert.rejects(f.service.writeHabitLog(client,f.owner,{...value,title:'另一份'}),{code:'teloa/conflict'})
  await assert.rejects(f.service.writeHabitLog(client,f.owner,{...value,requestId:randomUUID(),roleVersion:f.roleVersion+1}),{code:'teloa/version-conflict'})
  await client.query('rollback')
 }finally{client.release()}
 assert.equal((await pool.query('select count(*)::int n from teloa_role_daily_logs where owner_id=$1',[f.owner])).rows[0].n,0)
})

test('同一天不同内容的小结走冲突；并发只落一份正文；并发丢弃只成一次',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const created=await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0))
 await assert.rejects(f.service.submitDigest(f.owner,who,randomUUID(),{...submission(['SOC'],0),markdown:'另一份正文，不是恢复原小结。'}),{code:'teloa/conflict'})
 const g=await world(),him=(await g.service.digestRun(g.owner,{runId:g.runId}))!
 const race=await Promise.allSettled([g.service.submitDigest(g.owner,him,randomUUID(),submission(['SOC'],0)),g.service.submitDigest(g.owner,him,randomUUID(),{...submission(['SOC'],0),markdown:'另一份并发正文，不是恢复原小结。'})])
 assert.equal(race.filter(item=>item.status==='fulfilled').length,1)
 assert.equal((race.find(item=>item.status==='rejected') as PromiseRejectedResult).reason.code,'teloa/conflict')
 assert.equal((await pool.query('select count(*)::int n from teloa_role_daily_logs where owner_id=$1',[g.owner])).rows[0].n,1)
 const drop=await Promise.allSettled([
  f.service.discard(f.human,{requestId:randomUUID(),logId:created.log.id,expectedState:'kept'}),
  f.service.discard(f.human,{requestId:randomUUID(),logId:created.log.id,expectedState:'kept'})])
 assert.equal(drop.filter(item=>item.status==='fulfilled').length,1)
 assert.equal((drop.find(item=>item.status==='rejected') as PromiseRejectedResult).reason.code,'teloa/version-conflict')
})

test('日志已提交但某条候选失败时重放补齐，新请求也只返回同一份固定小结',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 let seen=0
 const flaky=new RoleDailyLogService(pool,identity,{remember:async(actor,input,admission)=>{
  if(++seen===2)throw new WorkError('teloa/dependency-unavailable','注入的候选写入失败。')
  return f.memory.remember(actor,input,admission)
 }})
 const requestId=randomUUID(),input=submission(['SOC'],3)
 await assert.rejects(flaky.submitDigest(f.owner,who,requestId,input),{code:'teloa/dependency-unavailable'})
 assert.equal((await pool.query('select count(*)::int n from teloa_role_daily_logs where owner_id=$1',[f.owner])).rows[0].n,1)
 assert.equal((await f.memory.list(f.human,{roleId:f.roleId})).length,1)
 // 重放之前把当天证据弄成读不出来：回执必须在证据之前判，否则补建候选会被证据侧波动切断。
 await pool.query("update teloa_plans set definition=jsonb_set(definition,'{trigger}','null') where id=$1",[f.planId])
 await assert.rejects(f.service.dayEvidence(f.owner,who),{code:'teloa/storage-corrupt'})
 const done=await f.service.submitDigest(f.owner,who,requestId,input)
 await pool.query("update teloa_plans set definition=jsonb_set(definition,'{trigger}',$2::jsonb) where id=$1",[f.planId,JSON.stringify(trigger)])
 assert.equal(done.candidates.length,3);assert.equal(new Set(done.candidates.map(item=>item.id)).size,3)
 assert.equal((await pool.query('select count(*)::int n from teloa_role_daily_logs where owner_id=$1',[f.owner])).rows[0].n,1)
 const newCall=await f.service.submitDigest(f.owner,who,randomUUID(),input)
 assert.equal(newCall.log.id,done.log.id);assert.deepEqual(newCall.candidates.map(item=>item.id),done.candidates.map(item=>item.id))
})

/** AD09 的旧安装形状：首个callId日志已提交，第二条经验失败；原创建回执必须保留。 */
async function partialDigest(){
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!,requestId=randomUUID(),input=submission(['SOC'],3)
 let seen=0
 const flaky=new RoleDailyLogService(pool,identity,{remember:async(actor,proposal,admission)=>{
  if(++seen===2)throw new WorkError('teloa/dependency-unavailable','AD09 第二条经验写入失败。')
  return f.memory.remember(actor,proposal,admission)
 }})
 await assert.rejects(flaky.submitDigest(f.owner,who,requestId,input),{code:'teloa/dependency-unavailable'})
 const log=(await pool.query('select id,request_id,request_spec from teloa_role_daily_logs where owner_id=$1',[f.owner])).rows[0]
 const first=(await f.memory.list(f.human,{roleId:f.roleId}))[0]!
 return {...f,who,requestId,input,log,first}
}

test('AD09 新callId同参恢复旧callId日志，只补经验且保留首个回执与原ID',async()=>{
 const f=await partialDigest(),saved=await f.service.submitDigest(f.owner,f.who,randomUUID(),f.input)
 assert.equal(saved.log.id,f.log.id);assert.equal(saved.candidates.length,3);assert.equal(saved.candidates[0]!.id,f.first.id)
 assert.equal((await pool.query('select request_id from teloa_role_daily_logs where owner_id=$1',[f.owner])).rows[0].request_id,f.requestId)
 assert.equal((await pool.query('select count(*)::int n from teloa_role_daily_logs where owner_id=$1',[f.owner])).rows[0].n,1)
 assert.equal((await f.memory.list(f.human,{roleId:f.roleId})).length,3)
})

test('AD09 两个新callId并发恢复同一固定日结不重复日志或经验',async()=>{
 const f=await partialDigest(),settled=await Promise.allSettled([randomUUID(),randomUUID()].map(id=>f.service.submitDigest(f.owner,f.who,id,f.input)))
 assert.equal(settled.filter(row=>row.status==='fulfilled').length,2)
 const values=settled.filter(row=>row.status==='fulfilled').map(row=>row.value)
 assert.deepEqual(values[0]!.candidates.map(row=>row.id),values[1]!.candidates.map(row=>row.id))
 assert.equal(values[0]!.log.id,f.log.id);assert.equal(values[0]!.candidates[0]!.id,f.first.id)
 assert.equal((await pool.query('select count(*)::int n from teloa_role_memory_creations where owner_id=$1',[f.owner])).rows[0].n,3)
})

test('AD09 恢复拒绝改稿、跨Run/本人/员工和伪造版本，不改原日志',async()=>{
 const f=await partialDigest(),otherRun=await endedRun(f.owner,f.digestTask.id,f.roleId,f.roleVersion,'completed'),otherWho=(await f.service.digestRun(f.owner,{runId:otherRun}))!
 for(const requestId of [f.requestId,randomUUID()])await assert.rejects(f.service.submitDigest(f.owner,f.who,requestId,{...f.input,markdown:'不得覆盖原稿'}),{code:'teloa/conflict'})
 await assert.rejects(f.service.submitDigest(f.owner,otherWho,randomUUID(),f.input),{code:'teloa/conflict'})
 for(const who of [{...f.who,roleId:randomUUID()},{...f.who,roleVersion:f.roleVersion+1},{...f.who,planId:randomUUID()}])await assert.rejects(f.service.submitDigest(f.owner,who,randomUUID(),f.input),{code:'teloa/forbidden'})
 await assert.rejects(f.service.submitDigest(randomUUID(),f.who,randomUUID(),f.input),{code:'teloa/forbidden'})
 assert.equal((await f.memory.list(f.human,{roleId:f.roleId})).length,1)
 assert.deepEqual((await pool.query('select id,request_id,request_spec from teloa_role_daily_logs where owner_id=$1',[f.owner])).rows[0],f.log)
})

test('AD09 旧callId恢复前也核对岗位/计划/业务授权与日志丢弃',async()=>{
 for(const revoke of ['plan','role','version','scope','discard'] as const){
  const f=await partialDigest()
  if(revoke==='plan')await pool.query("update teloa_plans set state='paused' where owner_id=$1 and id=$2",[f.owner,f.planId])
  if(revoke==='role')await pool.query("update teloa_roles set state='paused' where owner_id=$1 and id=$2",[f.owner,f.roleId])
  if(revoke==='version')await pool.query('update teloa_roles set version=version+1 where owner_id=$1 and id=$2',[f.owner,f.roleId])
  if(revoke==='scope')await pool.query("delete from teloa_business_scopes where owner_id=$1 and scope='SOC'",[f.owner])
  if(revoke==='discard')await f.service.discard(f.human,{requestId:randomUUID(),logId:f.log.id,expectedState:'kept'})
  for(const id of [f.requestId,randomUUID()])await assert.rejects(f.service.submitDigest(f.owner,f.who,id,f.input),error=>error instanceof WorkError,['授权变化后仍允许补写：',revoke].join(''))
  assert.equal((await f.memory.list(f.human,{roleId:f.roleId})).length,1)
 }
})

test('AD09 恢复不复活本人已经撤回的首条经验',async()=>{
 const f=await partialDigest()
 await f.memory.withdraw(f.human,{requestId:randomUUID(),memoryId:f.first.id,expectedStateVersion:f.first.stateVersion})
 const saved=await f.service.submitDigest(f.owner,f.who,randomUUID(),f.input)
 assert.equal(saved.candidates.length,3);assert.equal(saved.candidates[0]!.id,f.first.id);assert.equal(saved.candidates[0]!.state,'withdrawn')
 assert.equal(saved.candidates.filter(row=>row.state==='confirmed').length,2)
})

test('AD09 经验保存期间计划撤权，停止后续写入并保留已提交项',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 let saved=0
 const service=new RoleDailyLogService(pool,identity,{remember:async(actor,proposal,admission)=>{
  const memory=await f.memory.remember(actor,proposal,admission)
  if(++saved===1)await pool.query("update teloa_plans set state='paused' where owner_id=$1 and id=$2",[f.owner,f.planId])
  return memory
 }})
 await assert.rejects(service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],3)),{code:'teloa/forbidden'})
 assert.equal((await f.memory.list(f.human,{roleId:f.roleId})).length,1)
 assert.equal((await pool.query('select count(*)::int n from teloa_role_daily_logs where owner_id=$1',[f.owner])).rows[0].n,1)
})

test('AD09 事务外检查后撤权也不能创建经验，单连接池无需嵌套连接',async()=>{
 for(const revoke of ['plan','scope'] as const){
  const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
  let first=true
  const service=new RoleDailyLogService(pool,identity,{remember:async(actor,proposal,admission)=>{
   if(first){
    first=false
    if(revoke==='plan')await pool.query("update teloa_plans set state='paused' where owner_id=$1 and id=$2",[f.owner,f.planId])
    else await pool.query("delete from teloa_business_scopes where owner_id=$1 and scope='SOC'",[f.owner])
   }
   return f.memory.remember(actor,proposal,admission)
  }})
  await assert.rejects(service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],1)),{code:'teloa/forbidden'})
  assert.equal((await f.memory.list(f.human,{roleId:f.roleId})).length,0)
 }
})

test('AD09 经验写事务持有计划、日志和范围锁，撤权后拒绝确认已建候选',{timeout:20000},async()=>{
 for(const revoke of ['plan','log','scope'] as const){
  const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
  const revoker=new Pool({connectionString:container.getConnectionUri(),max:1}),observer=new Pool({connectionString:container.getConnectionUri(),max:1})
  let pending:Promise<{ok:boolean;error?:unknown}>|undefined,checked=0
  try{
   const service=new RoleDailyLogService(pool,identity,{remember:async(actor,proposal,admission)=>f.memory.remember(actor,proposal,async db=>{
    await admission!(db)
    if(++checked!==1)return
    const pid=Number((await revoker.query('select pg_backend_pid() as pid')).rows[0].pid)
    const sql=revoke==='plan'?"update teloa_plans set state='paused' where owner_id=$1":revoke==='log'?"update teloa_role_daily_logs set state='discarded',discarded_at=now() where owner_id=$1":"delete from teloa_business_scopes where owner_id=$1 and scope='SOC'"
    let settled=false
    pending=revoker.query(sql,[f.owner]).then(()=>({ok:true}),error=>({ok:false,error})).finally(()=>{settled=true})
    const deadline=Date.now()+3000
    while(true){
     const blockers=(await observer.query('select pg_blocking_pids($1) as blockers',[pid])).rows[0].blockers
     if(blockers.length)break
     assert.equal(settled,false,'撤权在经验事务提交前完成，说明没有持有准入行锁。')
     assert.ok(Date.now()<deadline,'未观察到撤权等待经验事务的行锁。')
    }
   })})
   await assert.rejects(service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],1)),error=>error instanceof WorkError)
   const outcome=await pending
   if(outcome&&!outcome.ok)throw outcome.error
   assert.equal(checked,1)
   const memories=await f.memory.list(f.human,{roleId:f.roleId})
   assert.equal(memories.length,1);assert.equal(memories[0]!.state,'candidate')
   assert.equal((await pool.query('select count(*)::int n from teloa_role_memory_creations where owner_id=$1',[f.owner])).rows[0].n,1)
  }finally{try{await pending}finally{await Promise.all([revoker.end(),observer.end()])}}
 }
})

test('AD09 交付读口以完整日志经验回执区分未知与已保存，不因日志存在而成功',async()=>{
 const f=await partialDigest()
 // 补齐本用例的真实计划/任务冻结关系，不能用旧夹具的随机摘要冒充可验收回执。
 const task=(await pool.query('select request_id from teloa_tasks where owner_id=$1 and id=$2',[f.owner,f.digestTask.id])).rows[0]
 const fields={title:f.digestTask.title,goal:f.digestTask.goal,scope:'SOC',dataScope:'本人已授权资料。',delivery:'结论与证据。',roleId:f.roleId,trigger:readScheduleTrigger(trigger),notificationPolicy:'attention'}
 const snapshot={fields,source:{kind:'system-digest',roleId:f.roleId},roleVersion:f.roleVersion}
 await pool.query('update teloa_plans set definition=$3 where owner_id=$1 and id=$2',[f.owner,f.planId,JSON.stringify(fields)])
 await pool.query('update teloa_plan_occurrences set task_request_id=$3,snapshot=$4,snapshot_hash=$5 where owner_id=$1 and plan_id=$2',[f.owner,f.planId,task.request_id,JSON.stringify(snapshot),digest(JSON.stringify(snapshot))])
 await pool.query('update teloa_plan_task_links set task_request_id=$3 where owner_id=$1 and task_id=$2',[f.owner,f.digestTask.id,task.request_id])
 assert.equal(typeof f.service.deliveryCheck,'function')
 assert.deepEqual(await f.service.deliveryCheck(f.owner,f.runId),{state:'unknown'})
 await f.service.submitDigest(f.owner,f.who,f.requestId,f.input)
 assert.deepEqual(await f.service.deliveryCheck(f.owner,f.runId),{state:'saved'})
 assert.equal(await f.service.deliveryCheck(f.owner,f.workRunId),undefined)
 assert.equal(await f.service.deliveryCheck(randomUUID(),f.runId),undefined)
})

test('岗位版本变化与已退役岗位在写之前拒绝；运行身份与计划来源不符也拒',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 await assert.rejects(f.service.submitDigest(f.owner,{...who,day:'2026-09-14'},randomUUID(),submission(['SOC'],0)),{code:'teloa/forbidden'})
 await assert.rejects(f.service.submitDigest(f.owner,{...who,planId:randomUUID()},randomUUID(),submission(['SOC'],0)),{code:'teloa/forbidden'})
 await pool.query('update teloa_roles set version=version+1 where id=$1',[f.roleId])
 await assert.rejects(f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0)),{code:'teloa/version-conflict'})
 await pool.query('update teloa_roles set version=version-1 where id=$1',[f.roleId])
 await pool.query("update teloa_roles set state='retired' where id=$1",[f.roleId])
 await assert.rejects(f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0)),{code:'teloa/conflict'})
 assert.equal((await pool.query('select count(*)::int n from teloa_role_daily_logs where owner_id=$1',[f.owner])).rows[0].n,0)
})

test('正文按字节判上限，读到损坏行与损坏丢弃回执一律显式失败',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 // 5334 个中文 = 16002 字节：按字符判会放行，按契约的字节判会在落库后才被判损坏。
 await assert.rejects(f.service.submitDigest(f.owner,who,randomUUID(),{...submission(['SOC'],0),markdown:'核'.repeat(5334)}),{code:'teloa/invalid-input'})
 const created=await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],1))
 const input={requestId:randomUUID(),logId:created.log.id,expectedState:'kept' as const}
 const discarded=await f.service.discard(f.human,input)
 await pool.query('alter table teloa_role_daily_log_changes disable trigger teloa_role_daily_log_changes_immutable')
 await pool.query(`update teloa_role_daily_log_changes set result=result-'title' where owner_id=$1 and request_id=$2`,[f.owner,input.requestId])
 await pool.query('alter table teloa_role_daily_log_changes enable trigger teloa_role_daily_log_changes_immutable')
 await assert.rejects(f.service.discard(f.human,input),{code:'teloa/storage-corrupt'})
 assert.ok(discarded.log.discardedAt)
 await pool.query("update teloa_role_daily_logs set title=' ' where owner_id=$1 and id=$2",[f.owner,created.log.id])
 await assert.rejects(f.service.get(f.human,{roleId:f.roleId,logId:created.log.id}),{code:'teloa/storage-corrupt'})
 await assert.rejects(f.service.list(f.human,{roleId:f.roleId}),{code:'teloa/storage-corrupt'})
})

test('跨岗位引用同一份日志被拒；证据切到 60 条后范围只含留下的条目',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const tasks=new TaskService(pool,identity)
 // world() 已有 1 条运行；再补 59 条同范围的，加 1 条排在最后、只有它带 OPS 范围的运行，凑满 61 条证据。
 for(let index=0;index<59;index++){
  const task=await tasks.create(f.owner,{requestId:randomUUID(),fields:{title:'核对 '+index,goal:'核对当日处置记录。',scope:'SOC'},assignee:{roleId:f.roleId,expectedVersion:f.roleVersion}})
  await run(f.owner,task.id,f.roleId,f.roleVersion)
 }
 const cutId=randomUUID()
 await pool.query(`insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,state,assignee_role_id,assignee_role_version,created_at,updated_at)
  values($1,$2,$3,'{}'::jsonb,$4,1,'ready',$5,$6,$7,$7)`,[cutId,f.owner,randomUUID(),JSON.stringify({title:'越界核对',goal:'只出现在被切掉的那条证据上。',scope:'OPS'}),f.roleId,f.roleVersion,now])
 await run(f.owner,cutId,f.roleId,f.roleVersion,'2026-09-13T05:00:00.000Z')
 const evidence=await f.service.dayEvidence(f.owner,who)
 assert.equal(evidence.runs.length,60);assert.deepEqual(evidence.scopeIds,['SOC'])
 assert.equal(evidence.runs.some(item=>item.title.includes('越界核对')),false)
 const created=await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0))
 assert.equal(created.log.evidence.length,60);assert.deepEqual(created.log.scopeIds,['SOC'])
 assert.deepEqual(created.log.evidence,evidence.runs)
 // 同一本人下的另一个岗位：日志在库里、类别与状态都对，只是不属于它。
 const other=await new RoleService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{name:'处置岗',kind:'employee',scopes:['SOC'],duty:'执行处置',dataScope:'已授权资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}})
 const otherVersion=Number((await pool.query('select version from teloa_roles where id=$1',[other.id])).rows[0].version)
 await assert.rejects(f.memory.create({ownerId:f.owner,kind:'agent',roleId:other.id},{requestId:randomUUID(),roleId:other.id,expectedRoleVersion:otherVersion,title:'跨岗位引用',markdown:'不该成立。',source:{kind:'daily-digest',id:created.log.id,version:1},visibility:{kind:'role',scopeIds:['SOC']}}),{code:'teloa/forbidden'})
})

test('业务范围目录不可读不能把已有工作当作空日',async()=>{
 const f=await world(),who={planId:f.planId,roleId:f.roleId,roleVersion:f.roleVersion,day,runId:f.runId,taskId:f.digestTask.id}
 await pool.query('alter table teloa_business_scopes rename to unavailable_daily_scopes')
 try{await assert.rejects(f.service.dayEvidence(f.owner,who),{code:'teloa/storage-corrupt'})}
 finally{await pool.query('alter table unavailable_daily_scopes rename to teloa_business_scopes')}
 assert.ok((await f.service.dayEvidence(f.owner,who)).runs.some(run=>run.id===f.workRunId))
})

test('成果对象撤回后自动小结不再取原稿/旧版修订/原群回帖正文，历史保留',async()=>{
 const f=await world(),who=await f.service.digestRun(f.owner,{runId:f.runId});assert.ok(who)
 const body='WITHDRAWN-SYNTHETIC-ARTIFACT-BODY',id=await artifact(f.owner,{kind:'run',id:f.workRunId,scope:'SOC',version:'1',title:'合成原稿'},'合成原稿',inDay,1,randomUUID(),body)
 const currentSource={kind:'session' as const,id:'session-'+f.workRunId,scope:'SOC',version:'1',title:'合成修订'}
 await artifact(f.owner,currentSource,'合成修订',inDay,2,id,body+'-V2')
 const message=await groupMessage(f.owner,f.roleId,f.task.id,f.workRunId,inDay,body)
 const before=await f.service.dayEvidence(f.owner,who);assert.ok(before.artifacts.some(x=>x.id===id));assert.ok(before.revisions.some(x=>x.id===id));assert.ok(before.groupMessages.some(x=>x.id===message.id))
 const history=(await pool.query('select * from teloa_artifact_versions where owner_id=$1 order by artifact_id,number',[f.owner])).rows
 const originalMessage=(await pool.query('select * from teloa_group_messages where owner_id=$1 and id=$2',[f.owner,message.id])).rows
 const service=new ArtifactService(pool,identity,async()=>{throw Error('撤回不重新解析活动来源')})
 await service.withdraw(f.owner,{requestId:randomUUID(),artifactId:id,expectedVersion:2,source:currentSource})
 const after=await f.service.dayEvidence(f.owner,who)
 assert.equal(after.artifacts.some(x=>x.id===id),false);assert.equal(after.revisions.some(x=>x.id===id),false);assert.equal(after.groupMessages.some(x=>x.id===message.id),false);assert.doesNotMatch(JSON.stringify(after.contents),/WITHDRAWN-SYNTHETIC-ARTIFACT-BODY/)
 assert.deepEqual((await pool.query('select * from teloa_artifact_versions where owner_id=$1 order by artifact_id,number',[f.owner])).rows,history)
 assert.deepEqual((await pool.query('select * from teloa_group_messages where owner_id=$1 and id=$2',[f.owner,message.id])).rows,originalMessage)
})

test('P2-TASK-BOUNDARY 日结保留同Task后来独立Run回帖，旧来源及显式绑定仍排除',async()=>{
 const f=await world(),who=await f.service.digestRun(f.owner,{runId:f.runId});assert.ok(who)
 let editedAt='2026-09-13T02:01:00.000Z'
 const tasks=new TaskService(pool,{id:randomUUID,now:()=>editedAt})
 const savedState=await tasks.edit(f.owner,{taskId:f.task.id,expectedVersion:f.task.version,fields:{title:'保存时已推进的旧Task状态'}})
 const source=await taskArtifactSource(pool,f.owner,f.task.id,false)
 assert.equal(savedState.version,2);assert.ok(source.version.startsWith('2 · '))
 const id=await artifact(f.owner,source,'旧Task成果','2026-09-13T02:02:00.000Z')
 const oldMessage=await groupMessage(f.owner,f.roleId,f.task.id,f.workRunId,'2026-09-13T02:03:00.000Z','旧来源回帖')
 editedAt='2026-09-13T02:03:30.000Z'
 const later=await tasks.edit(f.owner,{taskId:f.task.id,expectedVersion:savedState.version,fields:{goal:'新的独立任务目标，不消费旧成果'}})
 const freshRun=await endedRun(f.owner,f.task.id,f.roleId,f.roleVersion,'completed','2026-09-13T02:04:00.000Z',later.version)
 const boundRun=await endedRun(f.owner,f.task.id,f.roleId,f.roleVersion,'completed','2026-09-13T02:04:30.000Z',later.version)
 const freshMessage=await groupMessage(f.owner,f.roleId,f.task.id,freshRun,'2026-09-13T02:05:00.000Z','后来独立新来源正文')
 const boundMessage=await groupMessage(f.owner,f.roleId,f.task.id,boundRun,'2026-09-13T02:05:30.000Z','实际读过旧成果的正文')
 await pool.query('insert into teloa_artifact_input_sources(owner_id,session_id,artifact_id,created_at) values($1,$2,$3,$4)',[f.owner,'session-'+boundRun,id,inDay])
 const service=new ArtifactService(pool,identity,async()=>{throw Error('撤回不重建来源')})
 await service.withdraw(f.owner,{requestId:randomUUID(),artifactId:id,expectedVersion:1,source})
 const evidence=await f.service.dayEvidence(f.owner,who)
 assert.equal(evidence.groupMessages.some(x=>x.id===oldMessage.id),false)
 assert.equal(evidence.groupMessages.some(x=>x.id===boundMessage.id),false)
 assert.equal(evidence.groupMessages.some(x=>x.id===freshMessage.id),true,'同Task后来未引用旧成果的独立Run不应连坐')
 assert.match(JSON.stringify(evidence.contents),/后来独立新来源正文/)
})
