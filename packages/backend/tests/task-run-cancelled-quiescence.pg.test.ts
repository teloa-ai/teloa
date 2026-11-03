import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {readFile,realpath,lstat} from 'node:fs/promises'
import {dirname,isAbsolute,join} from 'node:path'
import {Pool} from './postgres-test-lifecycle.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {RoleService} from '../src/work/roles.ts'
import {TaskService} from '../src/work/tasks.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {WorkControlService} from '../src/work/work-control.ts'
import {WorkRetryService} from '../src/work/work-retries.ts'
import {WorkBudgetService} from '../src/work/work-budget.ts'
import {WorkRecoveryService} from '../src/work/work-recovery.ts'
import {WorkControlDriver} from '../../harness-dsh/src/work-control-driver.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'
import {TaskRunSubmissionService} from '../src/work/task-run-submission.ts'
import {TaskRunRuntimeLinkService} from '../src/work/task-run-runtime-links.ts'
import {taskRunQuiescentSettlement} from '../../harness-dsh/src/task-run-quiescence.ts'
import {quiescenceFixture,SessionId,SessionSeq,createUserMessage,type SessionEvent} from '../../harness-dsh/tests/fixtures/task-run-quiescence.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

const configPath=process.env.TELOA_CANCELLED_QUIESCENCE_PG_CONFIG
const identity={id:randomUUID,now:()=>new Date().toISOString()}

test('155 真PG：同会话两轮失败与两项正式取消正常暂停收口及本人恢复', {skip:!configPath,timeout:90000},async t=>{
 assert.ok(isAbsolute(configPath!),'只接受本轮显式隔离配置，不回退默认数据库')
 const info=await lstat(configPath!);assert.equal(info.isSymbolicLink(),false);assert.equal(info.mode&0o077,0)
 const cfg=JSON.parse(await readFile(configPath!,'utf8')) as {connectionString:string;databaseName:string;fixtureRoot:string;fixtureId:string;dataDirectory:string;port:number;systemIdentifier:string}
 assert.match(cfg.databaseName,/^j155_cancelled_quiescence(?:_r[0-9]+)?$/);assert.ok(isAbsolute(cfg.fixtureRoot))
 const root=await realpath(cfg.fixtureRoot);assert.equal(root,cfg.fixtureRoot);assert.equal(dirname(await realpath(configPath!)),join(root,'private'));assert.equal(cfg.dataDirectory,join(root,'pgdata'))
 const dataInfo=await lstat(cfg.dataDirectory);assert.equal(dataInfo.isSymbolicLink(),false)
 const provenance=JSON.parse(await readFile(join(root,'private/pg-provenance.json'),'utf8'))
 assert.equal(provenance.schema,'teloa.pg-test-owned/v1');assert.equal(provenance.fixtureId,cfg.fixtureId);assert.equal(provenance.pgdata,cfg.dataDirectory);assert.equal(provenance.device,dataInfo.dev);assert.equal(provenance.inode,dataInfo.ino);assert.equal(provenance.systemIdentifier,cfg.systemIdentifier)
 assert.equal((await readFile(join(cfg.dataDirectory,'global/pg_control'))).readBigUInt64LE(0).toString(),cfg.systemIdentifier)
 const url=new URL(cfg.connectionString);assert.equal(url.hostname,'127.0.0.1');assert.equal(Number(url.port),cfg.port);assert.equal(url.pathname,'/'+cfg.databaseName);assert.equal(url.username,'j155')
 const pool=new Pool({connectionString:cfg.connectionString,max:3,connectionTimeoutMillis:3000,statement_timeout:10000});pool.on('error',()=>{});t.after(()=>pool.end())
 assert.equal((await pool.query('select current_database() as name')).rows[0].name,cfg.databaseName)
 assert.equal(await realpath((await pool.query('show data_directory')).rows[0].data_directory),cfg.dataDirectory)
 assert.equal((await pool.query('select system_identifier::text as id from pg_control_system()')).rows[0].id,cfg.systemIdentifier)
 assert.equal((await pool.query("select count(*)::int as n from pg_tables where schemaname='public'")).rows[0].n,0,'只初始化本轮新空库')
 await initializeTeloaDatabase(pool)

 const native=await quiescenceFixture(t),owner=randomUUID(),sessionId=SessionId('pg155-'+randomUUID()),runtimeId=randomUUID(),events:SessionEvent[]=[]
 const writer=await native.ctx.sessionPersistence.create({id:sessionId,version:4,createdAt:Date.now(),cwd:native.ctx.workingDirectory.defaultDirectory,agentPreset:'teloa-standard',isSeeded:false})
 t.after(()=>writer.close())
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'取消历史核对岗',kind:'employee',scopes:['general'],duty:'核对合成材料',dataScope:'本例',executionScope:'无工具',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'teloa-standard'}}})
 const tasks=new TaskService(pool,identity),task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'取消历史与失败收口',goal:'核对原会话',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}}),conversationId=randomUUID()
 const inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[]}),journal=new TaskRunSubmissionService(pool),links=new TaskRunRuntimeLinkService(pool)
 const prepare=async()=>{const current=(await tasks.list(owner,{})).find(row=>row.id===task.id);assert(current);const run=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:current.version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1});await runs.claim(owner,{runId:run.id});return runs.get(owner,{runId:run.id})}
 const link=async(run:Awaited<ReturnType<typeof prepare>>)=>links.put(owner,{runId:run.id,kind:'job',nativeId:`owner:${runtimeId}:${sessionId}`,sessionId,payload:{record:'owner',runtimeId,requestId:run.nativeRequestId}})
 let unsafeCalls=0,hostGeneration=2,driver:WorkControlDriver
 const controls=new WorkControlService(pool,identity,{hostGeneration:()=>hostGeneration,inspectRun:(actor,input)=>driver.inspectRun(actor,input)}),budgets=new WorkBudgetService(pool,identity)
 async function ended(charged=false){
  const run=await prepare();await link(run);const start=events.length,turn=events.filter(e=>e.type==='turn/start').length+1
  if(charged){assert(run.lineage);const retries=new WorkRetryService(pool,identity,{controls,authorizeAttempt:async(db,actor)=>budgets.admissionInTransaction(db,actor,run.lineage!.budgetAccountId)}),operationId='synthetic-operation-'+randomUUID();await retries.register(owner,{runId:run.id,operationId});const claim=await retries.claim(owner,{operationId,requestId:randomUUID(),expectedGeneration:run.lineage.controlGeneration});assert(claim.dispatch);const reservation=await budgets.reserve(owner,{budgetAccountId:run.lineage.budgetAccountId,controlGeneration:run.lineage.controlGeneration,modelRequestId:claim.modelRequestId,kind:'retry',tokens:17,rounds:0});await budgets.markDispatched(owner,{reservationId:reservation.id});await budgets.settle(owner,{reservationId:reservation.id,modelRequestId:claim.modelRequestId,provider:'synthetic-fixture',providerRequestId:'synthetic-'+randomUUID(),tokens:null,moneyMinorUnits:null,currency:null,receiptId:randomUUID()})}
  const more:SessionEvent[]=[{type:'turn/start',seq:SessionSeq(start),time:Date.now(),data:{turn}},{type:'user/message',seq:SessionSeq(start+1),time:Date.now(),surfaceOp:'append',data:createUserMessage({source:{kind:'user',rpcId:run.nativeRequestId},content:[{type:'text',text:run.inputText}]})},{type:'turn/end',seq:SessionSeq(start+2),time:Date.now(),data:{turn,reason:{kind:'error',error:{code:'UNKNOWN',message:'合成普通错误，无模型执行'}}}}]
  await writer.append(more);await writer.flush();events.push(...more)
  await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'accepted'}})
  const result=await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn,messageSeq:start+1,endSeq:start+2,reason:'error'}})
  if(charged)assert.equal((await budgets.recordRunTerminal(owner,{schema:'teloa.work-budget-terminal/v1',runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,turn,messageSeq:start+1,endSeq:start+2,turnEndSeq:start+2,terminalKind:'turn/end',endedAt:new Date(more[2]!.time).toISOString()})).closed,1)
  return result
 }
 async function cancel(maintained:boolean){
  let run=await prepare();await link(run)
  for(let i=0;i<(maintained?2:1);i++){const ticket=await journal.begin(owner,run,runtimeId);await journal.finish(owner,ticket,'not-published')}
  run=await runs.requestStop(owner,{runId:run.id})
  const command={requestId:randomUUID(),runId:run.id,confirmNotPublished:true},fence={runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,inputSha256:createHash('sha256').update(run.inputText).digest('hex'),runtimeId,notPublished:true as const,logCut:events.length-1,logSha256:createHash('sha256').update(JSON.stringify(events)).digest('hex'),assertCurrent(){}}
  if(!maintained)return journal.cancelNotPublished(owner,command,runs,fence)
  return journal.cancelNotPublishedAfterMaintenance(owner,command,runs,fence,{schema:'teloa.task-run-maintenance/v1',source:'maintenance-process-exit',installId:randomUUID(),requestId:command.requestId,runId:run.id,processReceipt:{schema:'teloa.maintenance-process-exit/v1',signal:'SIGTERM',supervisor:{pid:101,pidVersion:1,uniqueId:'101'},child:{pid:102,pidVersion:1,uniqueId:'102'},exited:[101,102],bindingSha256:'a'.repeat(64)},backupSha256:'b'.repeat(64),logFileSha256:'c'.repeat(64)})
 }
 const first=await ended(),maintained=await cancel(true),ordinary=await cancel(false),last=await ended(true);await writer.close()
 assert.equal(maintained.state,'withdrawn');assert.equal(ordinary.state,'withdrawn')
 const reader={pool,readRun:runs.readVerifiedInTransaction.bind(runs)},signal=AbortSignal.timeout(20000)
 const path=await Reflect.get(native.ctx.sessionPersistence,'resolveCurrentLog').call(native.ctx.sessionPersistence,sessionId),beforeNative=await readFile(path)
 assert.equal(await taskRunQuiescentSettlement(native.ctx,owner,last,reader,signal),true)
 assert.equal(await taskRunQuiescentSettlement(native.ctx,randomUUID(),last,reader,signal),false,'foreign owner拒绝')
 const db=await pool.connect()
 try{await db.query('begin');await db.query("update teloa_task_run_submissions set state='accepted' where owner_id=$1 and run_id=$2 and attempt=1",[owner,maintained.id]);await db.query('commit');assert.equal(await taskRunQuiescentSettlement(native.ctx,owner,last,reader,signal),false,'原票据不再未发布则拒');await db.query("update teloa_task_run_submissions set state='not-published' where owner_id=$1 and run_id=$2 and attempt=1",[owner,maintained.id])}finally{db.release()}
 const before=await pool.query('select * from teloa_task_runs where owner_id=$1 order by id',[owner])
 driver=new WorkControlDriver({controls,runs,lineage:new WorkLineageService(pool,identity),runtimeLinks:links,driver:{stop:async()=>{unsafeCalls++;throw Error('不得重发/停止原请求')}},ports:{stop:async()=>{unsafeCalls++;throw Error('必须走真实静止证明')},events:async()=>{unsafeCalls++;throw Error('不得恢复旧Agent')}},quiescentSettled:(actor,run)=>taskRunQuiescentSettlement(native.ctx,actor,run,reader,signal),unpublishedCancellationSettled:(actor,run)=>journal.unpublishedCancellationSettled(actor,run)})
 const trustedBudgetBefore=(await pool.query('select * from teloa_work_budget_reservations where owner_id=$1 order by id',[owner])).rows;assert.equal(trustedBudgetBefore[0].state,'unknown')
 const paused=await controls.disarmForRestart(owner,{hostGeneration:2});assert(paused.length>0)
 for(const control of paused){const result=await driver.apply(owner,control,signal);assert.equal(result.state,'paused');assert.deepEqual(result.pendingRunIds,[]);assert.deepEqual(result.unknownOperationIds,[])}
 assert.deepEqual((await pool.query('select * from teloa_task_runs where owner_id=$1 order by id',[owner])).rows,before.rows)
 assert.deepEqual((await pool.query('select * from teloa_work_budget_reservations where owner_id=$1 order by id',[owner])).rows,trustedBudgetBefore)
 const recovery=new WorkRecoveryService(pool,identity,controls,{hostGeneration:()=>hostGeneration,ownerAuthority:{authorize:async(actor,request)=>{assert.equal(actor,owner);assert.deepEqual(request.candidateRunIds,[]);return {assertCurrent(){}}}},authorizeResume:async()=>({assertCurrent(){}})})
 for(const control of paused){const current=await controls.get(owner,{controlId:control.id});assert.equal((await recovery.resume(owner,{requestId:randomUUID(),controlId:control.id,expectedVersion:current.version,candidateRunIds:[]})).state,'active')}
 assert.deepEqual((await pool.query('select * from teloa_task_runs where owner_id=$1 order by id',[owner])).rows,before.rows)
 assert.deepEqual(await readFile(path),beforeNative);assert.equal(unsafeCalls,0)
 assert(last.lineage)
 const activeControl=await controls.get(owner,{controlId:last.lineage.roundControlId})
 const reservation=await budgets.reserve(owner,{budgetAccountId:last.lineage.budgetAccountId,controlGeneration:activeControl.generation,modelRequestId:'synthetic-history-'+randomUUID(),kind:'retry',tokens:17,rounds:0})
 await budgets.markDispatched(owner,{reservationId:reservation.id})
 await budgets.settle(owner,{reservationId:reservation.id,modelRequestId:reservation.modelRequestId,provider:'synthetic-fixture',providerRequestId:'synthetic-'+randomUUID(),tokens:null,moneyMinorUnits:null,currency:null,receiptId:randomUUID()})
 const budgetBefore=(await pool.query('select * from teloa_work_budget_reservations where owner_id=$1 order by id',[owner])).rows
 assert.equal(budgetBefore.length,2);assert.equal(budgetBefore[0].state,'unknown');assert.equal(budgetBefore[0].actual_tokens,null)

 hostGeneration=3;const blocked=await controls.disarmForRestart(owner,{hostGeneration});for(const control of blocked){const current=await driver.apply(owner,control,signal);assert.equal(current.state,'pausing','没有合法后代terminal链的未知预算不得静默放行');assert(current.pendingRunIds.length>0)}
 assert.deepEqual((await pool.query('select * from teloa_work_budget_reservations where owner_id=$1 order by id',[owner])).rows,budgetBefore,'unknown原金额、claim身份及消耗回执不改、不清零')
 assert.deepEqual([first.evidence?.state,last.evidence?.state],['ended','ended'])
})
