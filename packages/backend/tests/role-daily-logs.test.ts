import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,isRoleDailyLog} from '@teloa/contract'
import {initializeResources} from '../src/capabilities/schema.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations} from '../src/work/object-conversations.ts'
import {initializeTaskRuns} from '../src/work/task-runs.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeArtifacts} from '../src/work/artifacts.ts'
import {initializeMarkdownKnowledge} from '../src/capabilities/markdown-knowledge.ts'
import {initializeRoleMemory,RoleMemoryService} from '../src/work/role-memory.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializePlans} from '../src/work/plans.ts'
import {initializePlanOccurrences} from '../src/work/plan-occurrences.ts'
import {initializeBusinessData,BusinessDataService} from '../src/work/business-data.ts'
import {initializeBusinessTasks,BusinessTaskService} from '../src/work/business-tasks.ts'
import {initializeSecurityRequests,SecurityRequestJournal} from '../src/security/request-journal.ts'
import {initializeSecurityActions,SecurityActionService} from '../src/security/actions.ts'
import {initializeSecurityApprovals,SecurityApprovalService} from '../src/security/approvals.ts'
import {createSecurityEndpointIsolateDefinition} from '../src/security/action-authorization.ts'
import {initializeRoleDailyLogs,RoleDailyLogService} from '../src/work/role-daily-logs.ts'
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
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeResources(pool);await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeMarkdownKnowledge(pool);await initializeRoleMemory(pool)
 await initializeCollaboration(pool);await initializePlans(pool);await initializePlanOccurrences(pool)
 await initializeBusinessData(pool);await initializeBusinessTasks(pool)
 await initializeSecurityRequests(pool);await initializeSecurityActions(pool);await initializeSecurityApprovals(pool)
 await initializeRoleDailyLogs(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

async function world(options:{source?:'system-digest'|'manual'}={}){
 const owner=randomUUID(),roles=new RoleService(pool,identity)
 const created=await roles.create(owner,{requestId:randomUUID(),fields:{name:'调查岗',kind:'employee',scopes:['SOC'],duty:'核对来源',dataScope:'已授权资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}})
 const roleVersion=Number((await pool.query('select version from teloa_roles where id=$1',[created.id])).rows[0].version)
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'季度复盘',goal:'核对处置记录',scope:'SOC'},assignee:{roleId:created.id,expectedVersion:roleVersion}})
 const planId=randomUUID(),source=options.source==='manual'?{kind:'manual'}:{kind:'system-digest',roleId:created.id}
 const definition={title:'每日小结',goal:'把今天做过的事说清楚。',scope:'SOC',dataScope:'本人已授权资料。',delivery:'结论与证据。',roleId:created.id,trigger,notificationPolicy:'attention'}
 await pool.query(`insert into teloa_plans(id,owner_id,request_id,request_spec,definition,source,notification_policy,role_id,role_version,scope,version,config_version,state,archived_reason,archived_at,created_at,updated_at)
  values($1,$2,$3,$4,$5,$6,'attention',$7,$8,'SOC',1,1,'active',null,null,$9,$9)`,
  [planId,owner,randomUUID(),JSON.stringify({fields:{...definition,expectedRoleVersion:roleVersion},source}),JSON.stringify(definition),JSON.stringify(source),created.id,roleVersion,now])
 const claimId=randomUUID(),taskRequestId=randomUUID()
 await pool.query(`insert into teloa_plan_occurrences(id,owner_id,plan_id,plan_version,config_version,occurrence_id,scheduled_at,claimed_at,task_request_id,snapshot,snapshot_hash)
  values($1,$2,$3,1,1,$4,$5,$5,$6,$7,$8)`,[claimId,owner,planId,occurrenceId,now,taskRequestId,JSON.stringify({fields:definition,source,roleVersion}),digest(claimId)])
 await pool.query('insert into teloa_plan_task_links(claim_id,owner_id,task_request_id,task_id) values($1,$2,$3,$4)',[claimId,owner,taskRequestId,task.id])
 const runId=await run(owner,task.id,created.id,roleVersion)
 const memory=new RoleMemoryService(pool,identity)
 return {owner,roleId:created.id,roleVersion,task,planId,runId,memory,service:new RoleDailyLogService(pool,identity,memory),human:{ownerId:owner,kind:'human' as const}}
}

async function run(owner:string,taskId:string,roleId:string,roleVersion:number,createdAt=inDay){
 const id=randomUUID()
 await pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at)
  values($1,$2,$3,'{}'::jsonb,$4,$5,1,$6,1,$7,$8,'accepted','{}',$9)`,[id,owner,randomUUID(),taskId,roleId,roleVersion,'session-'+id,randomUUID(),createdAt])
 return id
}

async function artifact(owner:string,source:Record<string,unknown>,title:string,createdAt=inDay,number=1,artifactId=randomUUID()){
 if(number===1)await pool.query('insert into teloa_artifacts(id,owner_id,request_id,request_spec,source_key,current_version) values($1,$2,$3,\'{}\'::jsonb,$4,$5)',[artifactId,owner,randomUUID(),artifactId,number])
 else await pool.query('update teloa_artifacts set current_version=$2 where id=$1',[artifactId,number])
 const content={title,sections:[{id:'s1',title:'结论',text:'已核对。'}],snapshotIds:[],note:'无附件。'}
 await pool.query('insert into teloa_artifact_versions(owner_id,artifact_id,number,source,content,created_at) values($1,$2,$3,$4,$5,$6)',[owner,artifactId,number,JSON.stringify(source),JSON.stringify(content),createdAt])
 return artifactId
}

async function groupMessage(owner:string,roleId:string,taskId:string,runId:string,createdAt=inDay){
 const groupId=randomUUID(),rootId=randomUUID(),id=randomUUID()
 await pool.query(`insert into teloa_groups(id,owner_id,request_id,request_spec,definition,version,pinned,archived,created_at,updated_at)
  values($1,$2,$3,'{}'::jsonb,$4,1,false,false,$5,$5)`,[groupId,owner,randomUUID(),JSON.stringify({title:'处置组',scope:'SOC'}),now])
 await pool.query(`insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,text,reference_snapshot,created_at,task_id,run_id)
  values($1,$2,$3,$4,'{}'::jsonb,null,'self','今天的异常怎么处置？','[]'::jsonb,$5,null,null)`,[rootId,owner,groupId,randomUUID(),createdAt])
 await pool.query(`insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,text,reference_snapshot,created_at,task_id,run_id)
  values($1,$2,$3,$4,'{}'::jsonb,$5,$6,'已按处置手册隔离。','[]'::jsonb,$7,$8,$9)`,[id,owner,groupId,randomUUID(),rootId,roleId,createdAt,taskId,runId])
 return {id,rootId}
}

async function approval(owner:string,scope='SOC'){
 const principal={ownerId:owner,approverId:'local-self',scopeIds:[scope]},sourceId='security-alert-http'
 const alert={scope,type:'alert',id:'evt-'+randomUUID().slice(0,8),version:1,title:'prod-03 异常脚本',source:'EDR',observedAt:'2026-09-12T01:00:00.000Z',receivedAt:'2026-09-12T01:00:01.000Z',quality:'complete' as const,summary:'调查外联。',fields:[{label:'资产',value:'prod-03'}]}
 const data=new BusinessDataService(pool,{id:sourceId,scopes:[scope],query:async()=>({schema:'teloa.data-source-page/v1',sourceId,scope,capturedAt:'2026-09-12T01:00:02.000Z',items:[alert]})})
 const snapshot=(await data.query(principal,{scope,limit:10})).items[0]!
 const {task}=await new BusinessTaskService(pool,identity,new TaskService(pool,identity)).create(principal,{requestId:randomUUID(),reference:{scope,type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash},goal:'核对资产风险'})
 const journal=new SecurityRequestJournal(pool),execution={existsForAction:async()=>false}
 const actions=new SecurityActionService(pool,identity,catalog,journal,execution)
 const approvals=new SecurityApprovalService(pool,identity,catalog,journal)
 const proposed=await actions.propose(principal,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,title:'隔离 prod-03',goal:'阻断异常外联',tool:securityDefinition.tool,targetSet:['prod-03'],params:{reason:'已核对异常进程'}})
 const pending=await actions.submit(principal,{requestId:randomUUID(),actionId:proposed.id,expectedActionVersion:proposed.version})
 const decided=await approvals.decide(principal,{requestId:randomUUID(),actionId:pending.id,expectedActionVersion:pending.version,decision:'approved',reason:'已核对生产影响',impactConfirmed:true})
 return {task,approval:decided}
}

const submission=(scopeIds=['SOC'],candidates=1,pruneHints:Array<{memoryId:string;reason:string}>=[])=>({
 title:'今天的小结',markdown:'核对了处置记录，形成了两条结论。',
 candidates:Array.from({length:candidates},(_,index)=>({title:'交付前核对来源 '+index,markdown:'交付前必须核对来源版本 '+index+'。',scopeIds})),
 pruneHints
})

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
 assert.deepEqual(await system.service.digestRun(system.owner,{runId:system.runId}),{runId:system.runId,taskId:system.task.id,planId:system.planId,roleId:system.roleId,roleVersion:system.roleVersion,day})
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
 const produced=await artifact(f.owner,{kind:'run',id:f.runId,scope:'SOC',version:'1',title:'调查纪要'},'调查纪要')
 const revised=await artifact(f.owner,{kind:'run',id:f.runId,scope:'SOC',version:'1',title:'处置报告'},'处置报告')
 await artifact(f.owner,{kind:'session',id:'s-1',scope:'SOC',version:'1',title:'处置报告'},'处置报告',inDay,2,revised)
 const decided=await approval(f.owner)
 await run(f.owner,decided.task.id,f.roleId,f.roleVersion)
 const message=await groupMessage(f.owner,f.roleId,f.task.id,f.runId)
 const evidence=await f.service.dayEvidence(f.owner,who)
 assert.equal(evidence.day,day);assert.deepEqual(evidence.scopeIds,['SOC'])
 assert.deepEqual(evidence.runs.map(item=>item.title).sort(),['运行：'+decided.task.title,'运行：季度复盘'].sort())
 assert.deepEqual(evidence.artifacts.map(item=>[item.id,item.version]),[[produced,1],[revised,1]].sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))
 assert.deepEqual(evidence.approvals,[{kind:'approval',id:decided.approval.id,version:1,title:'允许：隔离 prod-03'}])
 assert.deepEqual(evidence.revisions,[{kind:'revision',id:revised,version:2,title:'处置报告'}])
 assert.deepEqual(evidence.groupMessages,[{kind:'group-message',id:message.id,version:1,title:'群回帖 · 话题 '+message.rootId.slice(0,8)}])
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
 for(let index=0;index<61;index++)await pool.query(`insert into teloa_role_daily_logs(id,owner_id,role_id,role_version,kind,day,state,run_id,title,markdown,scope_ids,evidence,prune_hints,request_id,request_spec,created_at,discarded_at)
  values($1,$2,$3,$4,'habit-digest',$5::date,'kept',null,'习惯小结','今天的节奏。','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,$6,'{}'::jsonb,$7,null)`,
  [randomUUID(),f.owner,f.roleId,f.roleVersion,'2026-0'+(index<31?'7-'+String(index+1).padStart(2,'0'):'8-'+String(index-30).padStart(2,'0')),randomUUID(),now])
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

test('保留 60 天：最旧一条被淘汰，其派生记忆不受影响',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const oldest=randomUUID()
 for(let index=0;index<60;index++)await pool.query(`insert into teloa_role_daily_logs(id,owner_id,role_id,role_version,kind,day,state,run_id,title,markdown,scope_ids,evidence,prune_hints,request_id,request_spec,created_at,discarded_at)
  values($1,$2,$3,$4,'daily-digest',$5::date,'kept',$6,'历史小结','历史正文。',$7,'[]'::jsonb,'[]'::jsonb,$8,'{}'::jsonb,$9,null)`,
  [index===0?oldest:randomUUID(),f.owner,f.roleId,f.roleVersion,'2026-0'+(index<31?'7-'+String(index+1).padStart(2,'0'):'8-'+String(index-30).padStart(2,'0')),f.runId,JSON.stringify(['SOC']),randomUUID(),now])
 const legacy=await f.memory.create({ownerId:f.owner,kind:'agent',roleId:f.roleId},{requestId:randomUUID(),roleId:f.roleId,expectedRoleVersion:f.roleVersion,title:'历史结论',markdown:'历史结论正文。',source:{kind:'daily-digest',id:oldest,version:1},visibility:{kind:'role',scopeIds:['SOC']}})
 assert.equal(legacy.sourceAvailable,true)
 await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0))
 assert.equal((await pool.query('select count(*)::int n from teloa_role_daily_logs where owner_id=$1 and id=$2',[f.owner,oldest])).rows[0].n,0)
 assert.equal((await pool.query('select count(*)::int n from teloa_role_daily_logs where owner_id=$1',[f.owner])).rows[0].n,60)
 const survivor=(await f.memory.list(f.human,{roleId:f.roleId})).find(item=>item.id===legacy.id)!
 assert.equal(survivor.state,'candidate');assert.equal(survivor.sourceAvailable,false);assert.deepEqual(survivor.content,legacy.content)
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

test('同一天第二次小结走冲突；并发不同请求只落一条；并发丢弃只成一次',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 const created=await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0))
 await assert.rejects(f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0)),{code:'teloa/conflict'})
 const g=await world(),him=(await g.service.digestRun(g.owner,{runId:g.runId}))!
 const race=await Promise.allSettled([g.service.submitDigest(g.owner,him,randomUUID(),submission(['SOC'],0)),g.service.submitDigest(g.owner,him,randomUUID(),submission(['SOC'],0))])
 assert.equal(race.filter(item=>item.status==='fulfilled').length,1)
 assert.equal((race.find(item=>item.status==='rejected') as PromiseRejectedResult).reason.code,'teloa/conflict')
 assert.equal((await pool.query('select count(*)::int n from teloa_role_daily_logs where owner_id=$1',[g.owner])).rows[0].n,1)
 const drop=await Promise.allSettled([
  f.service.discard(f.human,{requestId:randomUUID(),logId:created.log.id,expectedState:'kept'}),
  f.service.discard(f.human,{requestId:randomUUID(),logId:created.log.id,expectedState:'kept'})])
 assert.equal(drop.filter(item=>item.status==='fulfilled').length,1)
 assert.equal((drop.find(item=>item.status==='rejected') as PromiseRejectedResult).reason.code,'teloa/version-conflict')
})

test('日志已提交但某条候选失败时，重放同一请求补齐；换请求身份仍是同一天冲突',async()=>{
 const f=await world(),who=(await f.service.digestRun(f.owner,{runId:f.runId}))!
 let seen=0
 const flaky=new RoleDailyLogService(pool,identity,{remember:async(actor,input)=>{
  if(++seen===2)throw new WorkError('teloa/dependency-unavailable','注入的候选写入失败。')
  return f.memory.remember(actor,input)
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
 await assert.rejects(f.service.submitDigest(f.owner,who,randomUUID(),input),{code:'teloa/conflict'})
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
 assert.equal(evidence.runs.some(item=>item.title==='运行：越界核对'),false)
 const created=await f.service.submitDigest(f.owner,who,randomUUID(),submission(['SOC'],0))
 assert.equal(created.log.evidence.length,60);assert.deepEqual(created.log.scopeIds,['SOC'])
 assert.deepEqual(created.log.evidence,evidence.runs)
 // 同一本人下的另一个岗位：日志在库里、类别与状态都对，只是不属于它。
 const other=await new RoleService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{name:'处置岗',kind:'employee',scopes:['SOC'],duty:'执行处置',dataScope:'已授权资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}})
 const otherVersion=Number((await pool.query('select version from teloa_roles where id=$1',[other.id])).rows[0].version)
 await assert.rejects(f.memory.create({ownerId:f.owner,kind:'agent',roleId:other.id},{requestId:randomUUID(),roleId:other.id,expectedRoleVersion:otherVersion,title:'跨岗位引用',markdown:'不该成立。',source:{kind:'daily-digest',id:created.log.id,version:1},visibility:{kind:'role',scopeIds:['SOC']}}),{code:'teloa/forbidden'})
})
