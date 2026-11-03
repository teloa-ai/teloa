import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile,realpath,lstat} from 'node:fs/promises'
import {dirname,isAbsolute,join} from 'node:path'
import {Pool} from './postgres-test-lifecycle.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {RoleService} from '../src/work/roles.ts'
import {TaskService} from '../src/work/tasks.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {WorkControlService} from '../src/work/work-control.ts'
import {WorkRecoveryService} from '../src/work/work-recovery.ts'
import {TaskRunDriver} from '../../harness-dsh/src/task-run-driver.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

const configPath=process.env.TELOA_PAUSED_RECORD_PG_CONFIG
const identity={id:randomUUID,now:()=>new Date().toISOString()}

test('153 真PG：暂停普通失败可观察，正常恢复后精确结算；未知、停止与Task CAS仍保护', {skip:!configPath,timeout:90000},async t=>{
 assert.ok(isAbsolute(configPath!),'只接受本轮显式隔离配置，不回退默认数据库')
 const info=await lstat(configPath!);assert.equal(info.isSymbolicLink(),false);assert.equal(info.mode&0o077,0)
 const cfg=JSON.parse(await readFile(configPath!,'utf8')) as {connectionString:string;databaseName:string;fixtureRoot:string;fixtureId:string;dataDirectory:string;port:number;systemIdentifier:string}
 assert.equal(cfg.databaseName,'j153_paused_record');assert.ok(isAbsolute(cfg.fixtureRoot))
 const root=await realpath(cfg.fixtureRoot);assert.equal(root,cfg.fixtureRoot);assert.equal(dirname(await realpath(configPath!)),join(root,'private'));assert.equal(cfg.dataDirectory,join(root,'pgdata'))
 const dataInfo=await lstat(cfg.dataDirectory);assert.equal(dataInfo.isSymbolicLink(),false)
 const provenance=JSON.parse(await readFile(join(root,'private/pg-provenance.json'),'utf8'))
 assert.equal(provenance.schema,'teloa.pg-test-owned/v1');assert.equal(provenance.fixtureId,cfg.fixtureId);assert.equal(provenance.pgdata,cfg.dataDirectory);assert.equal(provenance.device,dataInfo.dev);assert.equal(provenance.inode,dataInfo.ino);assert.equal(provenance.systemIdentifier,cfg.systemIdentifier)
 assert.equal((await readFile(join(cfg.dataDirectory,'global/pg_control'))).readBigUInt64LE(0).toString(),cfg.systemIdentifier)
 const url=new URL(cfg.connectionString);assert.equal(url.hostname,'127.0.0.1');assert.equal(Number(url.port),cfg.port);assert.equal(url.pathname,'/'+cfg.databaseName);assert.equal(url.username,'j153')
 const pool=new Pool({connectionString:cfg.connectionString,max:3,connectionTimeoutMillis:3000,statement_timeout:10000});pool.on('error',()=>{});t.after(()=>pool.end())
 assert.equal((await pool.query('select current_database() as name')).rows[0].name,cfg.databaseName)
 assert.equal(await realpath((await pool.query('show data_directory')).rows[0].data_directory),cfg.dataDirectory)
 assert.equal((await pool.query('select system_identifier::text as id from pg_control_system()')).rows[0].id,cfg.systemIdentifier)
 assert.equal((await pool.query("select count(*)::int as n from pg_tables where schemaname='public'")).rows[0].n,0,'只初始化本轮新空库')
 await initializeTeloaDatabase(pool)

 async function fixture(reason:'error'|'interrupted'){
  const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'暂停核对岗',kind:'employee',scopes:['general'],duty:'核对合成材料',dataScope:'本例',executionScope:'无工具',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'teloa-standard'}}})
  const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'153合成任务',goal:'核对暂停后的记账',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}})
  const sessionId='pg153-'+randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
  await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
  let callbacks=0,publications=0
  const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[],onSettled:async()=>{callbacks++}})
  const prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1})
  const claimed=await runs.claim(owner,{runId:prepared.id});assert.equal(claimed.dispatch,true)
  // 仅本例合成证据，验证真实SQL/事务和消费者；不冒充SDK原生日志或实际模型执行。
  const active=await runs.record(owner,{runId:prepared.id,sessionId,nativeRequestId:prepared.nativeRequestId,evidence:{state:'active',turn:1,messageSeq:1}})
  assert.equal(active.state,'active');assert.ok(active.lineage)
  const seal={assertCurrent(){}}
  const controls=new WorkControlService(pool,identity,{ownerAuthority:{authorize:async(actor)=>{assert.equal(actor,owner);return seal}},inspectRun:async(actor,{runId})=>{const run=await runs.get(actor,{runId});return {settled:run.state==='ended',unknownOperationIds:[]}}})
  const control=await controls.get(owner,{controlId:active.lineage.roundControlId})
  const pausing=await controls.change(owner,{requestId:randomUUID(),controlId:control.id,expectedVersion:control.version,action:'pause',scope:'round',roundControlId:null})
  const input={runId:active.id,sessionId,nativeRequestId:active.nativeRequestId,evidence:{state:'ended' as const,turn:1,messageSeq:1,endSeq:2,reason}}
  const snapshot=async()=>({task:(await pool.query('select * from teloa_tasks where owner_id=$1 and id=$2',[owner,task.id])).rows[0],run:(await pool.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,active.id])).rows[0],control:await controls.get(owner,{controlId:control.id})})
  const driver=new TaskRunDriver(runs,{check:async()=>{},send:async()=>{throw Error('不得重发输入')},stop:async()=>{throw Error('不得启动/停止原执行')},events:async()=>{throw Error('已固定失败不重读原生或执行')},controlState:run=>controls.stateForRun(owner,{runId:run.id}),publishOwnerResult:async()=>{publications++},publishGroupResult:async()=>{publications++}})
  async function defer(){await runs.record(owner,input,{deferSettlement:true});const paused=await controls.reconcile(owner,{controlId:control.id,generation:pausing.generation});assert.equal(paused.state,'paused');return paused}
  async function resume(){const recovery=new WorkRecoveryService(pool,identity,controls,{hostGeneration:()=>1,ownerAuthority:{authorize:async(actor,request)=>{assert.equal(actor,owner);assert.deepEqual(request.candidateRunIds,[]);return seal}},authorizeResume:async()=>seal});const current=await controls.get(owner,{controlId:control.id});const result=await recovery.resume(owner,{requestId:randomUUID(),controlId:control.id,expectedVersion:current.version,candidateRunIds:[]});assert.equal(result.state,'active')}
  return {owner,task,role,runs,active,input,controls,control,driver,snapshot,defer,resume,callbacks:()=>callbacks,publications:()=>publications}
 }
 await t.test('error/interrupted：真实outstanding包含本人且不包含foreign；暂停保留Task，恢复结算一次且不发布',async()=>{
  for(const reason of ['error','interrupted'] as const){const f=await fixture(reason),before=await f.snapshot();await f.defer();const deferred=await f.snapshot();assert.deepEqual(deferred.task,before.task);assert.equal(deferred.run.state,'ended');assert.equal(deferred.run.evidence.reason,reason);assert.equal(f.callbacks(),0)
   assert.deepEqual(await f.runs.outstanding(f.owner),[f.active.id]);assert.deepEqual(await f.runs.outstanding(randomUUID()),[]);await assert.rejects(f.runs.get(randomUUID(),{runId:f.active.id}),{code:'teloa/forbidden'})
   await f.driver.reconcile(f.owner,{runId:f.active.id});assert.deepEqual((await f.snapshot()).task,before.task)
   await f.resume();await f.driver.reconcile(f.owner,{runId:f.active.id});const after=await f.snapshot();assert.equal(after.task.state,'blocked');assert.equal(after.task.version,before.task.version+1);assert.equal(after.run.evidence.reason,reason);assert.equal(after.run.group_publication,null);assert.equal(after.run.owner_result_pending,false);assert.equal(f.callbacks(),1);assert.equal(f.publications(),0);assert.deepEqual(await f.runs.outstanding(f.owner),[])
   await f.driver.reconcile(f.owner,{runId:f.active.id});await f.runs.settleDeferred(f.owner,f.input);assert.deepEqual(await f.snapshot(),after);assert.equal(f.callbacks(),1);assert.equal(f.publications(),0)
  }
 })
 await t.test('未知控制与停止保留；不得延期登记或恢复结算',async()=>{
  for(const kind of ['unknown','stop'] as const){const f=await fixture('error');await f.defer()
   if(kind==='unknown')await pool.query('update teloa_work_control_progress set unknown_operation_ids=$3 where owner_id=$1 and control_id=$2',[f.owner,f.control.id,['synthetic-unknown']])
   else await pool.query('update teloa_task_runs set stop_requested_at=now() where owner_id=$1 and id=$2',[f.owner,f.active.id])
   const before=await f.snapshot();await assert.rejects(f.runs.settleDeferred(f.owner,f.input),{code:'teloa/conflict'});assert.deepEqual(await f.snapshot(),before);assert.equal(f.callbacks(),0);assert.equal(f.publications(),0)
   if(kind==='unknown')await assert.rejects(f.resume());else assert.deepEqual(await f.runs.outstanding(f.owner),[])
  }
 })
 await t.test('Task版本或负责人后续变化：outstanding与CAS均不覆盖本人后续决定',async()=>{
  for(const kind of ['version','role'] as const){const f=await fixture('interrupted');await f.defer();await f.resume()
   await pool.query(kind==='version'?'update teloa_tasks set version=version+1 where owner_id=$1 and id=$2':'update teloa_tasks set assignee_role_id=null,assignee_role_version=null where owner_id=$1 and id=$2',[f.owner,f.task.id])
   const before=await f.snapshot();assert.deepEqual(await f.runs.outstanding(f.owner),[]);assert.equal((await f.runs.settleDeferred(f.owner,f.input)).disposition,'inapplicable');await f.driver.reconcile(f.owner,{runId:f.active.id});assert.deepEqual(await f.snapshot(),before);assert.equal(f.callbacks(),0);assert.equal(f.publications(),0)
  }
 })
})
