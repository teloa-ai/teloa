import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool,type PoolClient,type QueryResult} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import type {Conversation,BusinessReassignmentInstruction} from '@teloa/contract'
import {BusinessReassignmentService,initializeBusinessReassignments} from '../src/work/business-reassignment.ts'
import {ConversationWorkService,initializeConversationWork,workRequestChildId} from '../src/work/conversation-work.ts'
import {BusinessConversationBindingService,initializeBusinessConversationBindings} from '../src/work/business-conversation-bindings.ts'
import {BusinessSpaceService,initializeBusinessSpaces} from '../src/work/business-spaces.ts'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {TaskRunService,TaskRunPresetError,initializeTaskRuns} from '../src/work/task-runs.ts'
import {ObjectConversationService,initializeObjectConversations} from '../src/work/object-conversations.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {businessObjectSnapshotHash,initializeBusinessData} from '../src/work/business-data.ts'
import {BusinessTaskService,initializeBusinessTasks} from '../src/work/business-tasks.ts'
import {ArtifactService,initializeArtifacts} from '../src/work/artifacts.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeBusinessDefinitions} from '../src/work/business-definition-local.ts'
import {BusinessConfigurationStore,initializeBusinessConfigurations} from '../src/work/business-configuration-store.ts'
import {BusinessConfigurationDraftService} from '../src/work/business-configuration-drafts.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import {BusinessRuntimeService,initializeBusinessRuntime} from '../src/work/business-runtime.ts'
import {BusinessConfigurationService} from '../src/work/business-configuration.ts'
import {BusinessConfigurationPreviewService} from '../src/work/business-configuration-preview.ts'
import {initializeBusinessResponsibilities} from '../src/work/business-responsibility.ts'

let container:StartedPostgreSqlContainer,pool:Pool,observer:Pool,locks:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 const connectionString=container.getConnectionUri()
 pool=new Pool({connectionString,max:1,connectionTimeoutMillis:2000,statement_timeout:5000,lock_timeout:3000})
 observer=new Pool({connectionString,max:3,connectionTimeoutMillis:2000,statement_timeout:5000,lock_timeout:3000})
 locks=new Pool({connectionString,max:2,connectionTimeoutMillis:2000,statement_timeout:5000,lock_timeout:3000})
 await initializeBusinessSpaces(pool);await initializeRoles(pool);await initializeTasks(pool);await initializeConversationWork(pool)
 await initializeBusinessConversationBindings(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeBusinessReassignments(pool)
 await initializeBusinessData(pool);await initializeBusinessTasks(pool);await initializeArtifactSnapshots(pool);await initializeArtifacts(pool)
 await initializeBusinessDefinitions(pool);await initializeBusinessConfigurations(pool);await initializeBusinessRuntime(pool);await initializeBusinessResponsibilities(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await observer?.end();await locks?.end();await container?.stop()})
async function deadline<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>timer=setTimeout(()=>reject(Error('single-connection operation deadline')),8000))])}finally{clearTimeout(timer)}}
async function waitForLock(query:string){const until=Date.now()+2500;while(!(await observer.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like $1",[query])).rowCount){assert.ok(Date.now()<until,'必须观察到真实PG锁等待 '+query);await new Promise(resolve=>setTimeout(resolve,10))}}
function gate(){let open!:()=>void;const promise=new Promise<void>(resolve=>{open=resolve});return {promise,open}}
async function blockedBy(pid:number,blocker:number){
 const until=Date.now()+2500
 for(;;){const row=(await observer.query("select wait_event_type,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=$1",[pid])).rows[0];if(row?.wait_event_type==='Lock'&&row.blockers.includes(blocker))return;assert.ok(Date.now()<until,`PG ${pid} 必须被 ${blocker} 阻塞`);await new Promise(resolve=>setTimeout(resolve,10))}
}
async function backendPid(db:PoolClient){return (await db.query('select pg_backend_pid() pid')).rows[0].pid as number}
/** 只拦截真实pg连接的指定写入，全部SQL仍由同一真实PoolClient执行。 */
function interceptConnections(real:Pool,beforeQuery:(db:PoolClient,sql:string)=>Promise<void>,afterQuery?:(db:PoolClient,sql:string,result:QueryResult)=>Promise<void>):Pool{
 return new Proxy(real,{get(target,key){
  if(key==='connect')return async()=>{
   const db=await target.connect()
   return new Proxy(db,{get(client,property){
    if(property==='query')return async(sql:string,values?:unknown[])=>{await beforeQuery(db,sql);const result=await db.query(sql,values);await afterQuery?.(db,sql,result);return result}
    const value=Reflect.get(client,property);return typeof value==='function'?value.bind(client):value
   }})
  }
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
 }})
}
async function fixture(withReference=false,managed=false){
 const owner=randomUUID(),roles=new RoleService(pool,identity),space=await new BusinessSpaceService(pool,identity).ensurePersonal(owner),scope=managed?await adoptConfiguration(owner):'SOC'
 const oldRole=await roles.create(owner,{requestId:randomUUID(),fields:{name:'原同事',kind:'employee',scopes:[scope],duty:'核对',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const newRole=await roles.create(owner,{requestId:randomUUID(),fields:{name:'新同事',kind:'employee',scopes:[scope],duty:'核对',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const sessions=new Map<string,Conversation>(),allowed=new Set([scope])
 const work=new ConversationWorkService(pool,identity.now,async(actor,sessionId)=>{const native=sessions.get(sessionId);if(!native||native.ownerId!==actor)throw Error('native missing');return {...native,submitted:true}},undefined,async()=>[...allowed],locks)
 const bindings=new BusinessConversationBindingService(pool,identity,{drafts:{begin:async()=>{throw Error('daily cannot begin draft')},get:async()=>{throw Error('daily cannot read draft')}},conversations:{bySession:async(actor,id)=>{const n=sessions.get(id);assert.equal(n?.ownerId,actor);assert.equal(n?.status,'ready');return {...n!,status:'ready' as const}}},contexts:work})
 async function daily(){
  const id='daily-'+randomUUID(),requestId=randomUUID(),now=identity.now(),native:Conversation={id:randomUUID(),ownerId:owner,title:'日常工作',scopeIds:['general'],version:1,status:'ready',sessionId:id,requestedSessionId:id,requestId,createdAt:now}
  sessions.set(id,native)
  await pool.query('insert into teloa_conversation_work_contexts values($1,$2,$3,null,1,true)',[owner,id,scope])
  await pool.query("insert into teloa_business_conversation_bindings(owner_id,request_id,kind,title,scope_id,session_id,created_at,updated_at) values($1,$2,'daily',$3,$6,$4,$5,$5)",[owner,requestId,native.title,id,now,scope])
  return id
 }
 const oldSessionId=await daily(),newSessionId=await daily(),oldRequestId=randomUUID()
 const fixed={scope,type:'alert',id:'fixed-object',version:1,title:'固定资料',source:'test',observedAt:identity.now(),receivedAt:identity.now(),quality:'complete' as const,summary:'原对象',fields:[]},reference={scope:fixed.scope,type:fixed.type,id:fixed.id,version:fixed.version,snapshotHash:businessObjectSnapshotHash(fixed)}
 if(withReference)await pool.query('insert into teloa_business_object_snapshots values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[owner,fixed.scope,fixed.type,fixed.id,fixed.version,reference.snapshotHash,JSON.stringify(fixed),fixed.source,fixed.receivedAt])
 const original=await work.reserve(owner,{requestId:oldRequestId,sessionId:oldSessionId,messageId:'original',messageSeq:1,kind:'task',scope,title:'固定标题',goal:'固定目标',sourceText:'原资料必须保留',roleId:oldRole.id,expectedRoleVersion:oldRole.version,...(withReference?{reference}:{}),...(managed?{responsibility:{version:0,roleId:null}}:{})})
 const service=new BusinessReassignmentService(pool,identity.now,work,bindings),tasks=new TaskService(pool,identity)
 const instruction=():BusinessReassignmentInstruction=>({requestId:randomUUID(),sessionId:newSessionId,messageId:randomUUID(),messageSeq:2,sourceText:'本人明确改派',selection:{oldRequestId,newRoleId:newRole.id,expectedNewRoleVersion:newRole.version}})
 const input={oldRequestId,instruction:instruction()},snapshot=await service.prepare(owner,input,async()=>{})
 async function stop(){await work.stop(owner,{requestId:oldRequestId,sessionId:oldSessionId})}
 async function history(){const rows=await pool.query('select to_jsonb(r)-\'notified_at\'-\'stopped_at\' as row from teloa_conversation_work_requests r where owner_id=$1 and request_id=$2',[owner,oldRequestId]);const taskRows=await pool.query('select to_jsonb(t) as row from teloa_tasks t where owner_id=$1 order by id',[owner]);const runRows=await pool.query('select to_jsonb(r) as row from teloa_task_runs r where owner_id=$1 order by id',[owner]);const sources=await pool.query('select to_jsonb(s) as row from teloa_business_task_sources s where owner_id=$1 order by task_id',[owner]),artifacts=await pool.query('select to_jsonb(a) as row from teloa_artifact_versions a where owner_id=$1 order by artifact_id,number',[owner]);return createHash('sha256').update(JSON.stringify([rows.rows,taskRows.rows,runRows.rows,sources.rows,artifacts.rows])).digest('hex')}
 return {owner,scope,space,oldRole,newRole,work,bindings,service,oldSessionId,newSessionId,oldRequestId,original,input,snapshot,instruction,stop,history,tasks,allowed,sessions,reference}
}
async function counts(owner:string){return (await pool.query('select (select count(*)::int from teloa_conversation_work_successors where owner_id=$1) mappings,(select count(*)::int from teloa_conversation_work_requests where owner_id=$1) requests',[owner])).rows[0]}
async function adoptConfiguration(owner:string){
 const drafts=new BusinessConfigurationDraftService(pool,identity),store=new BusinessConfigurationStore(pool),unavailable=async():Promise<never>=>{throw Error('test prohibits remote resources')}
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const apply=new BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime:new BusinessRuntimeService(pool,identity),spaces:new BusinessSpaceService(pool,identity)}),preview=new BusinessConfigurationPreviewService(pool,drafts,definitions,identity),actor={ownerId:owner,scopeIds:[] as string[]}
 let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'采用配置'})
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,patch:{upsertDefinitions:[{kind:'object-type',definition:{format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:draft.scope,title:'客户',unit:'条',lead:'客户',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'name',label:'名称',from:'名称',type:'text',required:true}]}}],upsertPages:[{id:'home',title:'客户',kind:'records',objectType:'customer',fields:['name'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'home'}})
 await apply.apply(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:draft.baseVersion,previewReceipt:(await preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt})
 return draft.scope
}
async function runFixture(sourceLink=false,configurationFailed=false){
 const f=await fixture(),task=await f.tasks.createForConversation(f.owner,{sessionId:f.oldSessionId,requestId:f.oldRequestId,roleId:f.oldRole.id}),sessionId='run-'+randomUUID(),conversationId=randomUUID()
 const inspect=async(owner:string,id:string)=>({ownerId:owner,sessionId:id,id:conversationId,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),input={requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,roleId:f.oldRole.id,expectedRoleVersion:f.oldRole.version,sessionId,expectedLinkVersion:1}
 const run=await runs.prepare(f.owner,input,undefined,undefined,undefined,async()=>{if(configurationFailed)throw new TaskRunPresetError('teloa/preset-unavailable','preset-resolve','固定配置暂不可用');return 'fixed-preset'})
 if(sourceLink)await sourceTaskLink(f.owner,f.oldSessionId,task.id,task.version,f.sessions)
 return {...f,task,runs,run,runInput:input}
}
async function sourceTaskLink(owner:string,sessionId:string,taskId:string,taskVersion:number,sessions:Map<string,Conversation>){
 await new ObjectConversationService(pool,async(actor,id)=>{const native=sessions.get(id);assert.equal(native?.ownerId,actor);return native!},identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:taskVersion,sessionId,expectedLinkVersion:0,action:'link'})
}
test('two_successors_exactly_one_wins',{timeout:20000},async()=>{
 const f=await fixture(),second={oldRequestId:f.oldRequestId,instruction:f.instruction()},approved=await f.service.prepare(f.owner,second,async()=>{});await f.stop();const history=await f.history()
 const holder=await locks.connect(),competitor=new BusinessReassignmentService(observer,identity.now,f.work,f.bindings)
 await holder.query('begin');await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/conversation-work',f.owner,'request:'+f.oldRequestId])])
 const competing=Promise.allSettled([f.service.commit(f.owner,f.input,f.snapshot,async()=>{}),competitor.commit(f.owner,second,approved,async()=>{})])
 let outcomes:Awaited<typeof competing>
 try{
  const until=Date.now()+2500
  while((await observer.query("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select pg_advisory_xact_lock%'" )).rows[0].n<2){assert.ok(Date.now()<until,'两条真实事务必须在共同C/P保护域重叠等待');await new Promise(resolve=>setTimeout(resolve,10))}
  await holder.query('commit');outcomes=await deadline(competing)
 }finally{await holder.query('rollback');holder.release();await competing}
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected').length,1)
 assert.deepEqual(await counts(f.owner),{mappings:1,requests:2});assert.equal(await f.history(),history);assert.equal(pool.waitingCount,0)
})
test('same_new_replays_original_chain',{timeout:20000},async()=>{
 const f=await fixture();await f.stop();const a=await deadline(f.service.commit(f.owner,f.input,f.snapshot,async()=>{})),b=await deadline(f.service.commit(f.owner,f.input,f.snapshot,async()=>{}))
 assert.deepEqual(a,b);assert.equal(a.oldRequestId,f.oldRequestId);assert.equal(a.newRequestId,f.input.instruction.requestId);assert.deepEqual(await counts(f.owner),{mappings:1,requests:2});assert.equal(pool.idleCount,1)
 const restored=await f.service.prepare(f.owner,f.input,async()=>{});assert.deepEqual(restored,f.snapshot)
})
test('same_new_changed_snapshot_conflicts',{timeout:20000},async()=>{
 const f=await fixture();await f.stop();await f.service.commit(f.owner,f.input,f.snapshot,async()=>{})
 await assert.rejects(f.service.commit(f.owner,{...f.input,instruction:{...f.input.instruction,sourceText:'另一个改派指令'}},f.snapshot,async()=>{}),{code:'teloa/conflict'});assert.deepEqual(await counts(f.owner),{mappings:1,requests:2})
})
test('internal_receipt_reader_restores_fixed_chain_without_native_after_restart',{timeout:20000},async()=>{
 const f=await fixture();assert.equal(await f.service.readReceiptForRequest(f.owner,f.input.instruction.requestId),null);await f.stop()
 const receipt=await f.service.commit(f.owner,f.input,f.snapshot,async()=>{});f.sessions.clear()
 const cold=new BusinessReassignmentService(pool,identity.now,f.work,f.bindings)
 assert.deepEqual(await deadline(cold.readReceiptForRequest(f.owner,receipt.newRequestId)),receipt);assert.equal(await cold.readReceiptForRequest(randomUUID(),receipt.newRequestId),null);assert.equal(await cold.readReceiptForRequest(f.owner,randomUUID()),null);assert.deepEqual(await counts(f.owner),{mappings:1,requests:2});assert.equal(pool.waitingCount,0)
})
for(const field of ['snapshot_hash','new_reserve'] as const)test('internal_receipt_reader_fails_closed_on_'+field+'_mismatch',{timeout:20000},async()=>{
 const f=await fixture();await f.stop();const receipt=await f.service.commit(f.owner,f.input,f.snapshot,async()=>{})
 if(field==='snapshot_hash')await pool.query("update teloa_conversation_work_successors set snapshot_hash=repeat('0',64) where owner_id=$1 and new_request_id=$2",[f.owner,receipt.newRequestId])
 else await pool.query("update teloa_conversation_work_requests set request_spec=jsonb_set(request_spec,'{title}','\"被篡改标题\"'::jsonb) where owner_id=$1 and request_id=$2",[f.owner,receipt.newRequestId])
 await assert.rejects(f.service.readReceiptForRequest(f.owner,receipt.newRequestId),{code:'teloa/storage-corrupt'});assert.deepEqual(await counts(f.owner),{mappings:1,requests:2});assert.equal(pool.waitingCount,0)
})
test('only_leaf_can_be_reassigned',{timeout:20000},async()=>{
 const f=await fixture();await f.stop();await f.service.commit(f.owner,f.input,f.snapshot,async()=>{})
 await assert.rejects(f.service.prepare(f.owner,{oldRequestId:f.oldRequestId,instruction:f.instruction()},async()=>{}),{code:'teloa/conflict'});assert.deepEqual(await counts(f.owner),{mappings:1,requests:2})
 const leaf=f.input.instruction.requestId,next={oldRequestId:leaf,instruction:{...f.instruction(),sessionId:f.oldSessionId,selection:{oldRequestId:leaf,newRoleId:f.oldRole.id,expectedNewRoleVersion:f.oldRole.version}}}
 const approved=await f.service.prepare(f.owner,next,async()=>{});await f.work.stop(f.owner,{requestId:leaf,sessionId:f.newSessionId})
 const receipt=await f.service.commit(f.owner,next,approved,async()=>{});assert.equal(receipt.oldRequestId,leaf);assert.equal(receipt.newRequestId,next.instruction.requestId);assert.deepEqual(await counts(f.owner),{mappings:2,requests:3})
})
test('retired_old_role_commits_without_changing_historical_target',{timeout:20000},async()=>{
 const f=await runFixture(true);await f.runs.withdraw(f.owner,{runId:f.run.id})
 await pool.query("update teloa_roles set state='retired',version=version+1 where owner_id=$1 and id=$2",[f.owner,f.oldRole.id])
 const approved=await f.service.prepare(f.owner,f.input,async()=>{});assert.equal(approved.oldRoleCurrent?.state,'retired');assert.equal(approved.oldTarget.roleVersion,f.oldRole.version);await f.stop();const history=await f.history()
 await f.service.commit(f.owner,f.input,approved,async()=>{});assert.equal(await f.history(),history);assert.deepEqual(await counts(f.owner),{mappings:1,requests:2})
})
test('retired_old_role_can_be_reassigned_but_changes_after_approval_conflict',{timeout:20000},async()=>{
 const f=await fixture();await pool.query("update teloa_roles set state='retired',version=version+1 where owner_id=$1 and id=$2",[f.owner,f.oldRole.id])
 const approved=await f.service.prepare(f.owner,f.input,async()=>{});assert.equal(approved.oldTarget.roleVersion,f.oldRole.version);assert.equal(approved.oldRoleCurrent?.state,'retired');await f.stop()
 await pool.query('update teloa_roles set version=version+1 where owner_id=$1 and id=$2',[f.owner,f.oldRole.id]);await assert.rejects(f.service.commit(f.owner,f.input,approved,async()=>{}),{code:'teloa/version-conflict'});assert.deepEqual(await counts(f.owner),{mappings:0,requests:1})
})
for(const mutation of ['binding','context','scope','role'] as const)test('role_or_scope_revoked_after_approval '+mutation,{timeout:20000},async()=>{
 const f=await fixture();await f.stop()
 if(mutation==='binding')await pool.query('delete from teloa_business_conversation_bindings where owner_id=$1 and session_id=$2',[f.owner,f.oldSessionId])
 if(mutation==='context')await pool.query('update teloa_conversation_work_contexts set version=version+1 where owner_id=$1 and session_id=$2',[f.owner,f.newSessionId])
 if(mutation==='scope')f.allowed.clear()
 if(mutation==='role')await pool.query("update teloa_roles set state='paused',version=version+1 where owner_id=$1 and id=$2",[f.owner,f.newRole.id])
 await assert.rejects(f.service.commit(f.owner,f.input,f.snapshot,async()=>{}));assert.deepEqual(await counts(f.owner),{mappings:0,requests:1});assert.equal(pool.waitingCount,0)
})
test('run_enumeration_requires_both_bound_daily_permissions',{timeout:20000},async()=>{
 const f=await fixture(),tuple=await f.service.readReassignmentRuns(f.owner,f.input,async()=>{})
 assert.deepEqual(tuple,{oldRequestId:f.oldRequestId,oldSessionId:f.oldSessionId,scope:'SOC',targets:[{roleId:f.oldRole.id,taskRequestId:workRequestChildId(f.oldRequestId,'task',f.oldRole.id),taskId:null,runs:[]}]})
 await pool.query("update teloa_business_conversation_bindings set session_id=null where owner_id=$1 and session_id=$2",[f.owner,f.oldSessionId]);await assert.rejects(f.service.readReassignmentRuns(f.owner,f.input,async()=>{}));assert.deepEqual(await counts(f.owner),{mappings:0,requests:1})
})
test('caller_cannot_select_old_session_or_run',{timeout:20000},async()=>{
 const f=await fixture(),untrusted={...f.input,oldSessionId:f.newSessionId};await assert.rejects(f.service.readReassignmentRuns(f.owner,untrusted,async()=>{}),{code:'teloa/invalid-input'})
 await assert.rejects(f.work.get(f.owner,{sessionId:f.newSessionId,requestId:f.oldRequestId}),{code:'teloa/forbidden'})
})
test('supersede_vs_task_create and old_replay_after_successor',{timeout:20000},async()=>{
 const f=await fixture();await f.stop();const parent={sessionId:f.oldSessionId,requestId:f.oldRequestId,roleId:f.oldRole.id}
 const held=gate(),release=gate(),createStarted=gate();let commitPid=0,createPid=0
 const committer=new BusinessReassignmentService(interceptConnections(pool,async(db,sql)=>{if(sql.startsWith('select * from teloa_conversation_work_requests')&&sql.includes('for update')){commitPid=await backendPid(db);held.open();await release.promise}}),identity.now,f.work,f.bindings)
 const creator=new TaskService(interceptConnections(locks,async(db,sql)=>{if(sql.startsWith('select pg_advisory_xact_lock')){createPid=await backendPid(db);createStarted.open()}}),identity)
 const committing=committer.commit(f.owner,f.input,f.snapshot,async()=>{}),commitResult=committing.then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 let creating:ReturnType<TaskService['createForConversation']>|undefined
 try{
  await deadline(held.promise);creating=creator.createForConversation(f.owner,parent);const createResult=creating.then(value=>({value,error:undefined}),error=>({value:undefined,error}));await deadline(createStarted.promise)
  assert.notEqual(commitPid,createPid);await blockedBy(createPid,commitPid);release.open()
  const [commit,create]=await deadline(Promise.all([commitResult,createResult]));assert.equal(commit.error,undefined);assert.equal(create.error?.code,'teloa/conflict');assert.notEqual(create.error?.code,'40P01')
 }finally{release.open();await commitResult;await creating?.catch(()=>{})}
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,0);assert.deepEqual(await counts(f.owner),{mappings:1,requests:2})
 await assert.rejects(f.tasks.createForConversation(f.owner,parent),{code:'teloa/conflict'});assert.equal(pool.waitingCount,0);assert.equal(locks.waitingCount,0)
})
for(const state of ['prepared','submitting','accepted','active','completed','failed','interrupted','aborted'] as const)test('all_runs_not_latest_only '+state,{timeout:20000},async()=>{
 const f=await runFixture()
 if(state!=='prepared')await f.runs.claim(f.owner,{runId:f.run.id})
 if(state==='accepted')await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'accepted'}})
 if(state==='active')await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'active',turn:1,messageSeq:2}})
 if(['completed','failed','interrupted','aborted'].includes(state)){
  await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:4,reason:state}})
 }
 await f.stop();const history=await f.history()
 await assert.rejects(deadline(f.service.commit(f.owner,f.input,f.snapshot,async()=>{})));assert.deepEqual(await counts(f.owner),{mappings:0,requests:1});assert.equal(await f.history(),history)
})
test('earlier_aborted_is_not_hidden_by_latest_withdrawn',{timeout:20000},async()=>{
 const f=await runFixture();await f.runs.claim(f.owner,{runId:f.run.id});await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:4,reason:'aborted'}})
 const current=(await f.tasks.list(f.owner,{})).find(task=>task.id===f.task.id)!
 const later=await f.runs.prepare(f.owner,{...f.runInput,requestId:randomUUID(),expectedTaskVersion:current.version},undefined,undefined,undefined,async()=> 'fixed-preset');await f.runs.withdraw(f.owner,{runId:later.id});await f.stop()
 await assert.rejects(f.service.commit(f.owner,f.input,f.snapshot,async()=>{}));assert.deepEqual(await counts(f.owner),{mappings:0,requests:1})
})
test('withdrawn has no sending right and permits successor on max1',{timeout:20000},async()=>{
 const f=await runFixture();await f.runs.withdraw(f.owner,{runId:f.run.id});await f.stop();const history=await f.history()
 const receipt=await deadline(f.service.commit(f.owner,f.input,f.snapshot,async()=>{}));assert.equal(receipt.oldRequestId,f.oldRequestId);assert.equal(await f.history(),history);assert.equal(pool.waitingCount,0);assert.equal(pool.idleCount,1)
 await assert.rejects(f.runs.claim(f.owner,{runId:f.run.id}).then(value=>{if(!value.dispatch)throw Object.assign(Error('no send'),{code:'teloa/conflict'})}),{code:'teloa/conflict'})
})
test('daily_source_task_link_preserves_main_identity_and_successor_receipt',{timeout:20000},async()=>{
 const f=await runFixture(true);await f.runs.withdraw(f.owner,{runId:f.run.id});const approved=await f.service.prepare(f.owner,f.input,async()=>{})
 const tuple=await f.service.readReassignmentRuns(f.owner,f.input,async()=>{});assert.equal(tuple.targets[0]?.taskId,f.task.id);assert.equal(tuple.targets[0]?.runs[0]?.id,f.run.id)
 await f.stop();const oldHistory=await f.history(),receipt=await f.service.commit(f.owner,f.input,approved,async()=>{});assert.equal(await f.history(),oldHistory)
 const successorTask=await f.tasks.createForConversation(f.owner,{sessionId:f.newSessionId,requestId:receipt.newRequestId,roleId:f.newRole.id})
 await sourceTaskLink(f.owner,f.newSessionId,successorTask.id,successorTask.version,f.sessions)
 assert.deepEqual(await f.service.prepare(f.owner,f.input,async()=>{}),approved);assert.deepEqual(await f.service.commit(f.owner,f.input,approved,async()=>{}),receipt)
 assert.deepEqual(await counts(f.owner),{mappings:1,requests:2});assert.equal((await pool.query('select count(*)::int n from teloa_object_conversations where owner_id=$1 and active=true',[f.owner])).rows[0].n,3)
})
for(const polluted of [false,true])test('configuration_failed_with_daily_source_link '+(polluted?'claimed_marker_rejected':'never_sent_allowed'),{timeout:20000},async()=>{
 const f=await runFixture(true,true);assert.equal(f.run.state,'configuration_failed');assert.equal(f.run.evidence,null);assert.ok(f.run.configurationError)
 const approved=await f.service.prepare(f.owner,f.input,async()=>{});await f.stop()
 if(polluted){
  await pool.query('update teloa_task_runs set task_state_version=task_version+1 where owner_id=$1 and id=$2',[f.owner,f.run.id])
  assert.equal((await f.runs.get(f.owner,{runId:f.run.id})).state,'configuration_failed')
 }
 const history=await f.history()
 if(polluted){await assert.rejects(f.service.commit(f.owner,f.input,approved,async()=>{}),{code:'teloa/conflict'});assert.deepEqual(await counts(f.owner),{mappings:0,requests:1})}
 else{await f.service.commit(f.owner,f.input,approved,async()=>{});assert.deepEqual(await counts(f.owner),{mappings:1,requests:2});assert.equal((await f.runs.claim(f.owner,{runId:f.run.id})).dispatch,false)}
 assert.equal(await f.history(),history)
})
for(const kind of ['task','role'] as const)test('daily_rejects_unrelated_'+kind+'_link_even_with_another_main_request',{timeout:20000},async()=>{
 const f=await fixture(),object=kind==='role'?f.oldRole:await f.tasks.create(f.owner,{requestId:randomUUID(),fields:{title:'独立任务',goal:'无主交办依据',scope:f.scope},assignee:{roleId:f.oldRole.id,expectedVersion:f.oldRole.version}})
 await new ObjectConversationService(pool,async(actor,id)=>{const native=f.sessions.get(id);assert.equal(native?.ownerId,actor);return native!},identity.now).change(f.owner,{requestId:randomUUID(),kind,objectId:object.id,expectedObjectVersion:object.version,sessionId:f.oldSessionId,expectedLinkVersion:0,action:'link'})
 await assert.rejects(f.service.prepare(f.owner,f.input,async()=>{}),{code:'teloa/forbidden'});assert.deepEqual(await counts(f.owner),{mappings:0,requests:1})
})
test('original_reference_task_source_artifact_are_unchanged',{timeout:20000},async()=>{
 const f=await fixture(true),business=new BusinessTaskService(pool,identity,f.tasks)
 const record=await business.createForConversation({ownerId:f.owner,scopeIds:['SOC']},{sessionId:f.oldSessionId,requestId:f.oldRequestId,roleId:f.oldRole.id})
 const source={kind:'task' as const,id:record.task.id,scope:'SOC',version:String(record.task.version),title:record.task.title}
 await new ArtifactService(pool,identity,async()=>({source,sessionIds:[]})).create(f.owner,{requestId:randomUUID(),source,content:{title:'保留成果',sections:[{id:'result',title:'结果',text:'原成果内容'}],snapshotIds:[],note:'待本人核对'}})
 await f.stop();const history=await f.history();await f.service.commit(f.owner,f.input,f.snapshot,async()=>{});assert.equal(await f.history(),history)
 const next=await f.work.get(f.owner,{sessionId:f.newSessionId,requestId:f.input.instruction.requestId});assert.deepEqual(next?.reference,f.reference);assert.equal(next?.sourceText,f.original.sourceText)
})
test('managed_empty_responsibility_remains_distinct_from_unmanaged',{timeout:20000},async()=>{
 const unmanaged=await fixture();assert.equal(unmanaged.snapshot.responsibility,null)
 const f=await fixture(false,true),approved=f.snapshot;assert.deepEqual(approved.responsibility,{version:0,roleId:null});await f.stop()
 const head=(await pool.query('select * from teloa_business_configuration_heads where owner_id=$1 and scope_id=$2',[f.owner,f.scope])).rows[0]
 // 合法的 legacy 持久形状：marker=false 且无 head，保留历史版本与旧请求；仅隔离夹具模拟模式迁移。
 const db=await pool.connect()
 try{await db.query('begin');await db.query('delete from teloa_business_configuration_heads where owner_id=$1 and scope_id=$2',[f.owner,f.scope]);await db.query('update teloa_business_scopes set configuration_managed=false where owner_id=$1 and scope=$2',[f.owner,f.scope]);await db.query('commit')}finally{db.release()}
 const legacy=await f.service.prepare(f.owner,f.input,async()=>{});assert.equal(legacy.responsibility,null);assert.notEqual(legacy.snapshotHash,approved.snapshotHash)
 await assert.rejects(f.service.commit(f.owner,f.input,approved,async()=>{}),{code:'teloa/version-conflict'});assert.deepEqual(await counts(f.owner),{mappings:0,requests:1})
 await pool.query('update teloa_business_scopes set configuration_managed=true where owner_id=$1 and scope=$2',[f.owner,f.scope]);await pool.query('insert into teloa_business_configuration_heads(owner_id,scope_id,version,updated_at) values($1,$2,$3,$4)',[f.owner,f.scope,head.version,head.updated_at])
 await f.service.commit(f.owner,f.input,approved,async()=>{});const next=await f.work.get(f.owner,{sessionId:f.newSessionId,requestId:f.input.instruction.requestId});assert.deepEqual(next?.responsibility,{version:0,roleId:null})
})
for(const action of ['prepare','claim'] as const)test('supersede_vs_'+action+' holds prerequisite locks and reverse C try-lock rolls back',{timeout:20000},async()=>{
 const f=await runFixture();if(action==='prepare')await f.runs.withdraw(f.owner,{runId:f.run.id});await f.stop()
 const prerequisite=gate(),release=gate(),commitWaiting=gate();let runPid=0,commitPid=0;const tries:boolean[]=[]
 const runner=new TaskRunService(interceptConnections(locks,async()=>{},async(_db,sql,result)=>{if(sql.startsWith('select pg_try_advisory_xact_lock'))tries.push(result.rows[0].locked)}),identity,f.runs.inspect,{allowedTools:[],planContext:async(db)=>{runPid=await backendPid(db);prerequisite.open();await release.promise;return undefined}})
 const committer=new BusinessReassignmentService(interceptConnections(pool,async(db,sql)=>{if(sql.startsWith('select * from '+(action==='claim'?'teloa_task_runs':'teloa_tasks'))&&sql.includes('for update')){commitPid=await backendPid(db);commitWaiting.open()}}),identity.now,f.work,f.bindings)
 const running=action==='prepare'?runner.prepare(f.owner,{...f.runInput,requestId:randomUUID()},undefined,undefined,undefined,async()=> 'fixed-preset'):runner.claim(f.owner,{runId:f.run.id}),runResult=running.then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 let committing:ReturnType<BusinessReassignmentService['commit']>|undefined
 try{
  await deadline(prerequisite.promise);committing=committer.commit(f.owner,f.input,f.snapshot,async()=>{});const commitResult=committing.then(value=>({value,error:undefined}),error=>({value:undefined,error}));await deadline(commitWaiting.promise)
  assert.notEqual(runPid,commitPid);await blockedBy(commitPid,runPid);release.open()
  const [run,commit]=await deadline(Promise.all([runResult,commitResult]));assert.equal(run.error?.code,'teloa/conflict');assert.notEqual(run.error?.code,'40P01');assert.deepEqual(tries,[false])
  if(action==='prepare')assert.equal(commit.error,undefined);else{assert.equal(commit.error?.code,'teloa/conflict');assert.notEqual(commit.error?.code,'40P01')}
 }finally{release.open();await runResult;await committing?.catch(()=>{})}
 assert.equal((await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1',[f.owner])).rows[0].n,1);assert.equal((await f.runs.get(f.owner,{runId:f.run.id})).state,action==='claim'?'prepared':'withdrawn')
 assert.equal((await f.tasks.list(f.owner,{})).find(task=>task.id===f.task.id)?.state,'ready');assert.deepEqual(await counts(f.owner),{mappings:action==='claim'?0:1,requests:action==='claim'?1:2});assert.equal(pool.waitingCount,0);assert.equal(locks.waitingCount,0)
})
test('supersede_vs_record respects Run then Task without deadlock',{timeout:20000},async()=>{
 const f=await runFixture();await f.runs.claim(f.owner,{runId:f.run.id});await f.stop()
 const holder=await observer.connect();await holder.query('begin');await holder.query('select id from teloa_tasks where owner_id=$1 and id=$2 for update',[f.owner,f.task.id])
 const recorder=new TaskRunService(locks,identity,async(owner,id)=>({ownerId:owner,sessionId:id,id:randomUUID(),status:'ready'})),recording=recorder.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:4,reason:'aborted'}})
 const recorded=recording.then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 let committing:Promise<Awaited<ReturnType<BusinessReassignmentService['commit']>>>|undefined
 try{
  await waitForLock('update teloa_tasks%');committing=f.service.commit(f.owner,f.input,f.snapshot,async()=>{});const outcome=committing.then(value=>({value,error:undefined}),error=>({value:undefined,error}))
  await waitForLock('select * from teloa_task_runs%for update');await holder.query('commit');const resultRecord=await recorded;assert.equal(resultRecord.error,undefined);assert.equal(resultRecord.value?.state,'ended')
  const result=await deadline(outcome);assert.equal(result.error?.code,'teloa/conflict');assert.notEqual(result.error?.code,'40P01');assert.deepEqual(await counts(f.owner),{mappings:0,requests:1})
 }finally{await holder.query('rollback');holder.release();await recorded;await committing?.catch(()=>{})}
})
test('late_acceptance_after_stop remains rejected until native settlement',{timeout:20000},async()=>{
 const f=await runFixture();await f.runs.claim(f.owner,{runId:f.run.id});await f.stop()
 const held=gate(),release=gate(),commitWaiting=gate();let recordPid=0,commitPid=0
 const recorder=new TaskRunService(interceptConnections(locks,async(db,sql)=>{if(sql.startsWith('update teloa_task_runs set state=')){recordPid=await backendPid(db);held.open();await release.promise}}),identity,f.runs.inspect)
 const committer=new BusinessReassignmentService(interceptConnections(pool,async(db,sql)=>{if(sql.startsWith('select * from teloa_task_runs')&&sql.includes('for update')){commitPid=await backendPid(db);commitWaiting.open()}}),identity.now,f.work,f.bindings)
 const recording=recorder.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'accepted'}}),recordResult=recording.then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 let committing:ReturnType<BusinessReassignmentService['commit']>|undefined
 try{
  await deadline(held.promise);committing=committer.commit(f.owner,f.input,f.snapshot,async()=>{});const commitResult=committing.then(value=>({value,error:undefined}),error=>({value:undefined,error}));await deadline(commitWaiting.promise);assert.notEqual(recordPid,commitPid);await blockedBy(commitPid,recordPid);release.open()
  const [record,commit]=await deadline(Promise.all([recordResult,commitResult]));assert.equal(record.error,undefined);assert.equal(record.value?.state,'accepted');assert.equal(commit.error?.code,'teloa/conflict');assert.notEqual(commit.error?.code,'40P01')
 }finally{release.open();await recordResult;await committing?.catch(()=>{})}
 assert.equal((await f.runs.get(f.owner,{runId:f.run.id})).state,'accepted');assert.deepEqual(await counts(f.owner),{mappings:0,requests:1});assert.equal(pool.waitingCount,0);assert.equal(locks.waitingCount,0)
})
test('pool_exhaustion_deadline_returns_no_successor_then_recovers_max1',{timeout:20000},async()=>{
 const f=await fixture();await f.stop();const held=await pool.connect()
 try{await assert.rejects(deadline(f.service.commit(f.owner,f.input,f.snapshot,async()=>{})));assert.equal(pool.waitingCount,0);assert.equal((await observer.query('select count(*)::int n from teloa_conversation_work_successors where owner_id=$1',[f.owner])).rows[0].n,0)}finally{held.release()}
 await deadline(f.service.commit(f.owner,f.input,f.snapshot,async()=>{}));assert.deepEqual(await counts(f.owner),{mappings:1,requests:2});assert.equal(pool.waitingCount,0);assert.equal(pool.idleCount,1)
})
test('mapping_write_failure_rolls_back_reserve_on_same_connection',{timeout:20000},async()=>{
 const f=await fixture();await f.stop();const guarded=interceptConnections(pool,async(_,sql)=>{if(sql.startsWith('insert into teloa_conversation_work_successors'))throw Error('controlled mapping write failure')})
 await assert.rejects(new BusinessReassignmentService(guarded,identity.now,f.work,f.bindings).commit(f.owner,f.input,f.snapshot,async()=>{}),/controlled mapping write failure/)
 assert.deepEqual(await counts(f.owner),{mappings:0,requests:1});assert.equal(pool.waitingCount,0);assert.equal(pool.idleCount,1)
})
test('transaction_connection_loss_never_returns_success_or_half_chain',{timeout:20000},async()=>{
 const f=await fixture();await f.stop();let lost=false
 const guarded=interceptConnections(pool,async(db,sql)=>{if(!lost&&sql.startsWith('insert into teloa_conversation_work_successors')){lost=true;db.on('error',()=>{});const pid=(await db.query('select pg_backend_pid() pid')).rows[0].pid;assert.equal((await observer.query('select pg_terminate_backend($1) killed',[pid])).rows[0].killed,true)}})
 await assert.rejects(deadline(new BusinessReassignmentService(guarded,identity.now,f.work,f.bindings).commit(f.owner,f.input,f.snapshot,async()=>{})))
 assert.equal(lost,true);assert.deepEqual(await counts(f.owner),{mappings:0,requests:1});assert.equal(pool.waitingCount,0)
})
test('independent_dispatch_connection_loss_does_not_return_success',{timeout:20000},async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void,aborted!:()=>void
 const held=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve),lost=new Promise<void>(resolve=>aborted=resolve)
 const pending=f.work.withDispatchLock(f.owner,f.oldRequestId,async signal=>{signal.addEventListener('abort',()=>aborted(),{once:true});entered();await gate;return 'must not return success'})
 const outcome=pending.then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 try{await held;const rows=(await observer.query("select distinct pid from pg_locks where locktype='advisory' and granted and mode='ExclusiveLock' and pid in(select pid from pg_stat_activity where datname=current_database())")).rows;assert.equal(rows.length,1);await observer.query('select pg_terminate_backend($1)',[rows[0].pid]);await deadline(lost);release();assert.equal((await deadline(outcome)).error?.code,'teloa/storage-unavailable');assert.deepEqual(await counts(f.owner),{mappings:0,requests:1})}finally{release();await outcome}
})
test('same_daily_uses_current_null_preference_and_preserves_locked_old_preference',{timeout:20000},async()=>{
 const f=await fixture(),input={...f.input,instruction:{...f.input.instruction,sessionId:f.oldSessionId}}
 const approved=await f.service.prepare(f.owner,input,async()=>{});await f.stop();const receipt=await f.service.commit(f.owner,input,approved,async()=>{});assert.equal(receipt.oldSessionId,receipt.newSessionId)
 const other=await fixture();await pool.query('update teloa_conversation_work_contexts set role_id=$3 where owner_id=$1 and session_id=$2',[other.owner,other.oldSessionId,other.oldRole.id])
 await assert.rejects(other.service.prepare(other.owner,{...other.input,instruction:{...other.input.instruction,sessionId:other.oldSessionId}},async()=>{}),{code:'teloa/conflict'})
 assert.equal((await pool.query('select role_id from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2',[other.owner,other.oldSessionId])).rows[0].role_id,other.oldRole.id)
})
test('revalidation_failure_never_reserves_or_stops',{timeout:20000},async()=>{
 const f=await fixture();await assert.rejects(f.service.prepare(f.owner,f.input,async()=>{throw Error('changed native user instruction')}),/changed native user instruction/)
 await assert.rejects(f.service.commit(f.owner,f.input,f.snapshot,async()=>{throw Error('approval no longer valid')}),/approval no longer valid/)
 assert.deepEqual(await counts(f.owner),{mappings:0,requests:1});assert.equal((await f.work.get(f.owner,{sessionId:f.oldSessionId,requestId:f.oldRequestId}))?.stoppedAt,null)
})
