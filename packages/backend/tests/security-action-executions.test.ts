import assert from 'node:assert/strict'
import {after,before,test} from 'node:test'
import {randomUUID} from 'node:crypto'
import {securityExecutionTransitions,type SecurityExecutionReceipt} from '@teloa/contract'
import {database,fixture,identity,catalog,command,decision} from './security-action-fixture.ts'
import {SecurityActionService} from '../src/security/actions.ts'
import * as executionModule from '../src/security/action-executions.ts'
let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database();await executionModule.initializeSecurityActionExecutions(db.pool)})
after(async()=>{await db?.close()})
async function setup(){
 const f=await fixture(db.pool)
 const actions=new SecurityActionService(db.pool,identity,catalog,f.journal,new executionModule.PgSecurityExecutionExistsReader())
 const action=await actions.propose(f.principal,f.proposal),submitted=await actions.submit(f.principal,command(action))
 await f.approvals.decide(f.principal,decision(submitted))
 const approved=await actions.get(f.principal,{actionId:action.id})
 return {...f,actions,approved,request:command(approved),service:new executionModule.SecurityActionExecutionService(db.pool,identity,f.approvals,f.journal)}
}
const receipt=(status:'accepted'|'succeeded'|'failed'):SecurityExecutionReceipt=>({status,receiptId:status,detail:'目标核对回执',observedAt:identity.now(),targets:[{target:'prod-03',state:status==='accepted'?'unknown':status}]})
test('claim 原子推进 Action，重放保留 dispatching 历史且唯一意图',async()=>{
 const f=await setup(),[a,b]=await Promise.all([f.service.claim(f.principal,f.request),f.service.claim(f.principal,f.request)])
 assert.equal(a.execution.operationId,b.execution.operationId);assert.deepEqual([a.dispatch,b.dispatch].sort(),[false,true])
 assert.equal((await f.actions.get(f.principal,{actionId:f.approved.id})).state,'executing')
 await f.service.recordEffect(f.principal,{operationId:a.execution.operationId,receipt:receipt('succeeded')})
 assert.deepEqual((await f.service.claim(f.principal,f.request)).execution,a.execution)
 assert.equal((await db.pool.query('select * from teloa_security_action_executions where action_id=$1',[f.approved.id])).rowCount,1)
 await assert.rejects(f.service.claim(f.principal,{...f.request,expectedActionVersion:4}),{code:'teloa/conflict'})
})
test('受理→未知→效果保留双回执并拒绝覆盖和删除',async()=>{
 const f=await setup(),{execution:e}=await f.service.claim(f.principal,f.request),accepted=receipt('accepted'),effect=receipt('succeeded')
 await f.service.recordAccepted(f.principal,{operationId:e.operationId,receipt:accepted})
 assert.equal((await f.actions.get(f.principal,{actionId:f.approved.id})).state,'executing')
 const unknown=await f.service.markUnknown(f.principal,{operationId:e.operationId,reason:'连接中断'})
 assert.deepEqual(unknown.acceptanceReceipt,accepted);assert.equal(unknown.effectReceipt,null)
 const final=await f.service.recordEffect(f.principal,{operationId:e.operationId,receipt:effect})
 assert.deepEqual(final.acceptanceReceipt,accepted);assert.deepEqual(final.effectReceipt,effect)
 assert.deepEqual(await f.service.recordEffect(f.principal,{operationId:e.operationId,receipt:effect}),final)
 await assert.rejects(f.service.recordEffect(f.principal,{operationId:e.operationId,receipt:receipt('failed')}),{code:'teloa/conflict'})
 const rows=(await db.pool.query('select kind,receipt from teloa_security_action_execution_receipts where operation_id=$1 order by kind',[e.operationId])).rows
 assert.deepEqual(rows,[{kind:'acceptance',receipt:accepted},{kind:'effect',receipt:effect}])
 for(const kind of ['acceptance','effect'])for(const sql of ['update teloa_security_action_execution_receipts set receipt=receipt where operation_id=$1 and kind=$2','delete from teloa_security_action_execution_receipts where operation_id=$1 and kind=$2'])await assert.rejects(db.pool.query(sql,[e.operationId,kind]),/不可/)
})
test('数据库状态边与合同完全相同，单边写入在提交时失败',async()=>{
 const edges=(await db.pool.query('select from_state,to_state from teloa_security_action_execution_transitions')).rows.map(r=>r.from_state+'->'+r.to_state).sort()
 assert.deepEqual(edges,Object.entries(securityExecutionTransitions).flatMap(([from,to])=>to.map(v=>from+'->'+v)).sort())
 const f=await setup()
 await assert.rejects(db.pool.query("update teloa_security_actions set state='executing',version=version+1 where id=$1",[f.approved.id]),/一致/)
 const {execution:e}=await f.service.claim(f.principal,f.request)
 const c=await db.pool.connect()
 try{await c.query('begin');await c.query("update teloa_security_action_executions set state='effect_unknown',revision=revision+1 where operation_id=$1",[e.operationId]);await assert.rejects(c.query('commit'),/一致/)}finally{await c.query('rollback');c.release()}
 for(const sql of ["update teloa_security_action_executions set dispatch_spec=jsonb_set(dispatch_spec,'{tool}','\"other\"') where operation_id=$1","delete from teloa_security_action_executions where operation_id=$1"])await assert.rejects(db.pool.query(sql,[e.operationId]))
 await f.service.recordAccepted(f.principal,{operationId:e.operationId,receipt:receipt('accepted')})
 await assert.rejects(db.pool.query("update teloa_security_action_executions set state='dispatching',revision=revision+1 where operation_id=$1",[e.operationId]),/转移/)
})
test('真实 execution reader 与 claim/撤回批准并发互斥',async()=>{
 for(let i=0;i<4;i++){
  const f=await setup(),results=await Promise.allSettled([f.service.claim(f.principal,f.request),f.actions.withdrawApproval(f.principal,command(f.approved))])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  const action=await f.actions.get(f.principal,{actionId:f.approved.id}),count=(await db.pool.query('select count(*) from teloa_security_action_executions where action_id=$1',[action.id])).rows[0].count
  assert.deepEqual([action.state,count],results[0]!.status==='fulfilled'?['executing','1']:['withdrawn','0'])
 }
})
test('观察短事务并发只完成同一历史结果，跨命令复用拒绝',async()=>{
 const f=await setup(),{execution:e}=await f.service.claim(f.principal,f.request),request={requestId:randomUUID(),operationId:e.operationId,expectedRevision:1}
 let entered=0;let release!:()=>void;const gate=new Promise<void>(r=>release=r)
 const recover=async()=>{if(++entered===2)release();await gate;return f.service.recordAccepted(f.principal,{operationId:e.operationId,receipt:receipt('accepted')})}
 const [a,b]=await Promise.all([f.service.observeWithJournal(f.principal,request,recover),f.service.observeWithJournal(f.principal,request,recover)])
 assert.deepEqual(a,b)
 await f.service.recordEffect(f.principal,{operationId:e.operationId,receipt:receipt('succeeded')})
 assert.deepEqual(await f.service.observeWithJournal(f.principal,request,async()=>{throw Error('不得再次外呼')}),a)
 await assert.rejects(f.service.observeWithJournal(f.principal,{...request,expectedRevision:2},recover),{code:'teloa/conflict'})
 await assert.rejects(f.service.observeWithJournal(f.principal,{...request,requestId:f.request.requestId},recover),{code:'teloa/conflict'})
 const row=(await db.pool.query('select * from teloa_security_action_observation_requests where request_id=$1',[request.requestId])).rows[0]
 assert.equal(row.state,'completed');assert.equal(row.result_revision,a.revision)
})
const oldSchema=`
 create table teloa_security_action_executions(
 operation_id uuid primary key,owner_id text not null,request_id uuid not null,request_spec jsonb not null,
 action_id text not null,approval_id text not null,approval_version integer not null,action_snapshot jsonb not null,
 state text not null,revision integer not null,receipt jsonb,unknown_reason text,created_at timestamptz not null,updated_at timestamptz not null,
 unique(owner_id,request_id),unique(owner_id,action_id,approval_id,approval_version));
 create table teloa_security_action_execution_audit(id bigserial primary key,owner_id text not null,operation_id uuid not null,at timestamptz not null,event text not null,detail jsonb not null);
`
test('旧主表或孤立 audit 有行均 fail-fast，内容及列/约束原样；空表迁移可重复',async()=>{
 const isolated=await database()
 try{
  await isolated.pool.query(oldSchema)
  const schema=async()=> (await isolated.pool.query("select table_name,column_name,data_type from information_schema.columns where table_name like 'teloa_security_action_execution%' order by table_name,ordinal_position")).rows
  const constraints=async()=> (await isolated.pool.query("select conname,pg_get_constraintdef(oid) definition from pg_constraint where conrelid in ('teloa_security_action_executions'::regclass,'teloa_security_action_execution_audit'::regclass) order by conname")).rows
  const initialSchema=await schema(),initialConstraints=await constraints(),id=randomUUID()
  await isolated.pool.query("insert into teloa_security_action_executions values($1,'old',$2,'{}','action','approval',1,'{}','dispatching',1,null,null,$3,$3)",[id,randomUUID(),identity.now()])
  const original=(await isolated.pool.query('select * from teloa_security_action_executions')).rows
  await assert.rejects(executionModule.initializeSecurityActionExecutions(isolated.pool),/显式.*迁移/)
  assert.deepEqual((await isolated.pool.query('select * from teloa_security_action_executions')).rows,original);assert.deepEqual(await schema(),initialSchema);assert.deepEqual(await constraints(),initialConstraints)
  await isolated.pool.query('delete from teloa_security_action_executions')
  await isolated.pool.query("insert into teloa_security_action_execution_audit(owner_id,operation_id,at,event,detail) values('old',$1,$2,'old','{}')",[id,identity.now()])
  const audit=(await isolated.pool.query('select * from teloa_security_action_execution_audit')).rows
  await assert.rejects(executionModule.initializeSecurityActionExecutions(isolated.pool),/显式.*迁移/)
  assert.deepEqual((await isolated.pool.query('select * from teloa_security_action_execution_audit')).rows,audit);assert.deepEqual(await schema(),initialSchema);assert.deepEqual(await constraints(),initialConstraints)
  await isolated.pool.query('delete from teloa_security_action_execution_audit')
  await executionModule.initializeSecurityActionExecutions(isolated.pool);await executionModule.initializeSecurityActionExecutions(isolated.pool)
  assert.equal((await isolated.pool.query("select obj_description('teloa_security_action_executions'::regclass) marker")).rows[0].marker,'teloa.security-action-execution/v2')
  assert.equal((await isolated.pool.query("select count(*) from information_schema.columns where table_name='teloa_security_action_executions' and column_name='receipt'")).rows[0].count,'0')
 }finally{await isolated.close()}
})
test('未知同名表形状拒绝初始化且原样保留',async()=>{
 const isolated=await database()
 try{
  await isolated.pool.query('create table teloa_security_action_executions(unrecognized text)')
  await assert.rejects(executionModule.initializeSecurityActionExecutions(isolated.pool),{code:'teloa/storage-corrupt'})
  assert.deepEqual((await isolated.pool.query("select column_name from information_schema.columns where table_name='teloa_security_action_executions'")).rows,[{column_name:'unrecognized'}])
 }finally{await isolated.close()}
})
test('Execution INSERT/DELETE 延迟触发器在提交点拒绝，合法双改可提交',async()=>{
 const f=await setup(),approval=(await db.pool.query('select * from teloa_security_approvals where action_id=$1',[f.approved.id])).rows[0],operationId=randomUUID()
 const dispatch={operationId,actionId:f.approved.id,tool:f.approved.tool,playbookVersion:f.approved.playbookVersion,targets:f.approved.targetSet,params:f.approved.params}
 const {securityParamFingerprint}=await import('../src/security/action-authorization.ts')
 const rawAction=(await db.pool.query('select * from teloa_security_actions where id=$1',[f.approved.id])).rows[0]
 for(const state of ['executing','invalid-state'])await assert.rejects(db.pool.query('insert into teloa_security_actions select * from jsonb_populate_record(null::teloa_security_actions,$1)',[JSON.stringify({...rawAction,id:randomUUID(),state})]),state==='executing'?/缺少执行意图/:/check constraint/)
 const client=await db.pool.connect()
 try{
  await client.query('begin')
  await f.journal.reserve(client,f.principal.ownerId,f.request.requestId,'execute',{command:'execute'},identity.now())
  await client.query("insert into teloa_security_action_executions(operation_id,owner_id,request_id,action_id,approval_id,approval_version,frozen,dispatch_spec,dispatch_spec_digest,request_spec_digest,state,revision,created_at,updated_at) values($1,$2,$3,$4,$5,2,$6,$7,$8,$10,'dispatching',1,$9,$9)",[operationId,f.principal.ownerId,f.request.requestId,f.approved.id,approval.id,approval.frozen,dispatch,securityParamFingerprint(dispatch),identity.now(),securityParamFingerprint({command:'execute'})])
  // INSERT 本身成功；必须到提交检查 Action 仍为 approved 才失败。
  await assert.rejects(client.query('commit'),/状态不一致/)
  await client.query('begin')
  await f.journal.reserve(client,f.principal.ownerId,f.request.requestId,'execute',{command:'execute'},identity.now())
  await client.query("update teloa_security_actions set state='executing',version=version+1 where id=$1",[f.approved.id])
  await client.query("insert into teloa_security_action_executions(operation_id,owner_id,request_id,action_id,approval_id,approval_version,frozen,dispatch_spec,dispatch_spec_digest,request_spec_digest,state,revision,created_at,updated_at) values($1,$2,$3,$4,$5,2,$6,$7,$8,$10,'dispatching',1,$9,$9)",[operationId,f.principal.ownerId,f.request.requestId,f.approved.id,approval.id,approval.frozen,dispatch,securityParamFingerprint(dispatch),identity.now(),securityParamFingerprint({command:'execute'})])
  await client.query('commit')
  await client.query('begin');await client.query('delete from teloa_security_action_executions where operation_id=$1',[operationId])
  await assert.rejects(client.query('commit'),/缺少执行意图/)
  await assert.rejects(db.pool.query('delete from teloa_security_actions where id=$1',[f.approved.id]),/foreign key constraint/)
  const triggers=(await db.pool.query("select tgname,tgdeferrable,tginitdeferred,tgtype::integer from pg_trigger where tgname in ('teloa_security_actions_execution_pair','teloa_security_executions_action_pair') order by tgname")).rows
  assert.equal(triggers.length,2);for(const t of triggers){assert.equal(t.tgdeferrable,true);assert.equal(t.tginitdeferred,true);assert.equal(t.tgtype,29)}
 }finally{await client.query('rollback');client.release()}
})
test('观察外部失败保留 pending，新服务同请求恢复，旧 revision 新请求拒绝',async()=>{
 const f=await setup(),{execution:e}=await f.service.claim(f.principal,f.request),request={requestId:randomUUID(),operationId:e.operationId,expectedRevision:e.revision}
 await assert.rejects(f.service.observeWithJournal(f.principal,request,async()=>{throw Error('断线')}),/断线/)
 assert.equal((await db.pool.query('select state from teloa_security_action_observation_requests where request_id=$1',[request.requestId])).rows[0].state,'pending')
 await f.service.recordAccepted(f.principal,{operationId:e.operationId,receipt:receipt('accepted')})
 const restarted=new executionModule.SecurityActionExecutionService(db.pool,identity,f.approvals,f.journal)
 const completed=await restarted.observeWithJournal(f.principal,request,()=>restarted.get(f.principal,{operationId:e.operationId}))
 assert.equal(completed.state,'accepted')
 await assert.rejects(restarted.observeWithJournal(f.principal,{...request,requestId:randomUUID()},async()=>{throw Error('不应外呼')}),{code:'teloa/version-conflict'})
})
test('严格拒绝被改写的历史结果、当前修订与派发摘要',async()=>{
 const f=await setup(),{execution:e}=await f.service.claim(f.principal,f.request),operationId=e.operationId
 await db.pool.query('alter table teloa_security_action_execution_requests disable trigger teloa_security_execution_requests_immutable')
 try{
  await db.pool.query("update teloa_security_action_execution_requests set result_snapshot=jsonb_set(result_snapshot,'{createdAt}','\"2026-09-12T01:00:00.000Z\"') where request_id=$1",[f.request.requestId])
  await assert.rejects(f.service.claim(f.principal,f.request),{code:'teloa/storage-corrupt'})
 }finally{
  await db.pool.query('update teloa_security_action_execution_requests set result_snapshot=$2 where request_id=$1',[f.request.requestId,e])
  await db.pool.query('alter table teloa_security_action_execution_requests enable trigger teloa_security_execution_requests_immutable')
 }
 const request={requestId:randomUUID(),operationId,expectedRevision:1}
 const observed=await f.service.observeWithJournal(f.principal,request,()=>f.service.recordAccepted(f.principal,{operationId,receipt:receipt('accepted')}))
 const final=await f.service.recordEffect(f.principal,{operationId,receipt:receipt('succeeded')})
 const {securityParamFingerprint}=await import('../src/security/action-authorization.ts')
 await db.pool.query('alter table teloa_security_action_observation_requests disable trigger teloa_guard_security_observation')
 try{
  await db.pool.query('update teloa_security_action_observation_requests set result_snapshot=$2,result_revision=$3,result_digest=$4 where request_id=$1',[request.requestId,final,final.revision,securityParamFingerprint(final)])
  await assert.rejects(f.service.observeWithJournal(f.principal,request,async()=>final),{code:'teloa/storage-corrupt'})
 }finally{
  await db.pool.query('update teloa_security_action_observation_requests set result_snapshot=$2,result_revision=$3,result_digest=$4 where request_id=$1',[request.requestId,observed,observed.revision,securityParamFingerprint(observed)])
  await db.pool.query('alter table teloa_security_action_observation_requests enable trigger teloa_guard_security_observation')
 }
 await db.pool.query('alter table teloa_security_action_executions disable trigger teloa_guard_security_execution')
 try{
  await db.pool.query('update teloa_security_action_executions set revision=revision+1 where operation_id=$1',[operationId])
  await assert.rejects(f.service.get(f.principal,{operationId}),{code:'teloa/storage-corrupt'})
 }finally{
  await db.pool.query('update teloa_security_action_executions set revision=$2 where operation_id=$1',[operationId,final.revision])
  await db.pool.query('alter table teloa_security_action_executions enable trigger teloa_guard_security_execution')
 }
})
test('读取执行必须核对共享 execute 请求内容和派发摘要',async()=>{
 const f=await setup(),{execution:e}=await f.service.claim(f.principal,f.request)
 const row=(await db.pool.query('select request_spec from teloa_security_requests where owner_id=$1 and request_id=$2',[f.principal.ownerId,f.request.requestId])).rows[0]
 await db.pool.query("update teloa_security_requests set request_spec=jsonb_set(request_spec,'{approverId}','\"other\"') where owner_id=$1 and request_id=$2",[f.principal.ownerId,f.request.requestId])
 try{await assert.rejects(f.service.get(f.principal,{operationId:e.operationId}),{code:'teloa/storage-corrupt'})}
 finally{await db.pool.query('update teloa_security_requests set request_spec=$3 where owner_id=$1 and request_id=$2',[f.principal.ownerId,f.request.requestId,row.request_spec])}
 await db.pool.query('alter table teloa_security_action_executions disable trigger teloa_guard_security_execution')
 try{
  await db.pool.query("update teloa_security_action_executions set dispatch_spec_digest=$2 where operation_id=$1",[e.operationId,'sha256:'+'a'.repeat(64)])
  await assert.rejects(f.service.get(f.principal,{operationId:e.operationId}),{code:'teloa/storage-corrupt'})
 }finally{await db.pool.query('alter table teloa_security_action_executions enable trigger teloa_guard_security_execution')}
})
test('迁移检查到提交之间排他锁阻断旧表并发 INSERT',async()=>{
 const isolated=await database(),pool=isolated.pool
 let release!:()=>void;let checked!:()=>void
 const gate=new Promise<void>(r=>release=r),atCheck=new Promise<void>(r=>checked=r)
 const originalConnect=pool.connect.bind(pool)
 try{
  await pool.query(oldSchema)
  const migrationPool=new Proxy(pool,{get(target,key){
   if(key!=='connect')return Reflect.get(target,key)
   return async()=>{
    const client=await originalConnect(),query=client.query.bind(client)
    return new Proxy(client,{get(target,key){
     if(key!=='query')return Reflect.get(target,key)
     return async(sql:string,values?:unknown[])=>{
      const result=await query(sql,values)
      if(sql==='select exists(select 1 from only teloa_security_action_executions) present'){checked();await gate}
      return result
     }
    }})
   }
  }})
  const migration=executionModule.initializeSecurityActionExecutions(migrationPool)
  await atCheck
  const concurrent=await originalConnect()
  try{
   const pid=(await concurrent.query('select pg_backend_pid() pid')).rows[0].pid
   const insert=concurrent.query("insert into teloa_security_action_executions values($1,'old',$2,'{}','action','approval',1,'{}','dispatching',1,null,null,$3,$3)",[randomUUID(),randomUUID(),identity.now()])
   const settled=insert.then(()=>true,()=>false)
   let waiting=false
   for(let i=0;i<100&&!waiting;i++){waiting=(await pool.query("select exists(select 1 from pg_locks where pid=$1 and not granted) waiting",[pid])).rows[0].waiting;if(!waiting)await new Promise(r=>setTimeout(r,10))}
   assert.equal(waiting,true)
   release();await migration;assert.equal(await settled,false)
   assert.equal((await pool.query('select count(*) from teloa_security_action_executions')).rows[0].count,'0')
  }finally{release();concurrent.release()}
 }finally{release?.();await isolated.close()}
})
test('旧列名相同但列类型未知时也不得自动重建',async()=>{
 const isolated=await database()
 try{
  await isolated.pool.query(oldSchema)
  await isolated.pool.query('alter table teloa_security_action_executions alter column action_id type uuid using action_id::uuid')
  await assert.rejects(executionModule.initializeSecurityActionExecutions(isolated.pool),{code:'teloa/storage-corrupt'})
  assert.equal((await isolated.pool.query("select data_type from information_schema.columns where table_name='teloa_security_action_executions' and column_name='action_id'")).rows[0].data_type,'uuid')
 }finally{await isolated.close()}
})
test('audit 失败使 claim 与 effect 的 Action/Execution/receipt/request 全部回滚',async()=>{
 const f=await setup(),install=()=>db.pool.query(`create or replace function fail_execution_audit() returns trigger language plpgsql as $$ begin if new.owner_id='${f.principal.ownerId}' then raise exception 'test audit failure'; end if;return new;end $$;
 create trigger fail_execution_audit before insert on teloa_security_action_execution_audit for each row execute function fail_execution_audit()`),remove=()=>db.pool.query('drop trigger fail_execution_audit on teloa_security_action_execution_audit')
 await install()
 try{
  await assert.rejects(f.service.claim(f.principal,f.request),/test audit failure/)
  assert.equal((await f.actions.get(f.principal,{actionId:f.approved.id})).state,'approved')
  assert.equal((await db.pool.query('select count(*) from teloa_security_requests where owner_id=$1 and request_id=$2',[f.principal.ownerId,f.request.requestId])).rows[0].count,'0')
  assert.equal((await db.pool.query('select count(*) from teloa_security_action_executions where owner_id=$1',[f.principal.ownerId])).rows[0].count,'0')
 }finally{await remove()}
 const {execution:e}=await f.service.claim(f.principal,f.request)
 await install()
 try{
  await assert.rejects(f.service.recordEffect(f.principal,{operationId:e.operationId,receipt:receipt('succeeded')}),/test audit failure/)
  assert.equal((await f.actions.get(f.principal,{actionId:f.approved.id})).state,'executing')
  assert.equal((await f.service.get(f.principal,{operationId:e.operationId})).state,'dispatching')
  assert.equal((await db.pool.query('select count(*) from teloa_security_action_execution_receipts where operation_id=$1',[e.operationId])).rows[0].count,'0')
 }finally{await remove()}
})
test('未知后恢复同一受理回执可回 executing，重复受理不新增事实',async()=>{
 const f=await setup(),{execution:e}=await f.service.claim(f.principal,f.request),input={operationId:e.operationId,receipt:receipt('accepted')}
 const accepted=await f.service.recordAccepted(f.principal,input)
 assert.deepEqual(await f.service.recordAccepted(f.principal,input),accepted)
 await f.service.markUnknown(f.principal,{operationId:e.operationId,reason:'需要重新核对'})
 const restored=await f.service.recordAccepted(f.principal,input)
 assert.equal(restored.state,'accepted');assert.equal(restored.revision,4)
 assert.equal((await f.actions.get(f.principal,{actionId:f.approved.id})).state,'executing')
 assert.equal((await db.pool.query("select count(*) from teloa_security_action_execution_receipts where operation_id=$1 and kind='acceptance'",[e.operationId])).rows[0].count,'1')
 await f.service.recordEffect(f.principal,{operationId:e.operationId,receipt:receipt('succeeded')})
 await assert.rejects(db.pool.query("update teloa_security_action_executions set state='dispatching',revision=revision+1 where operation_id=$1",[e.operationId]),/转移/)
})

test('迁移拒绝主表与 audit 的分区和继承结构，并保留子表及历史行',async t=>{
 const isolated=await database()
 try{
  let index=0
  for(const table of ['teloa_security_action_executions','teloa_security_action_execution_audit'])for(const layout of ['partition','inheritance-rows','inheritance-empty','v2-inheritance']){
   await t.test(table+' '+layout,async()=>{
    const schema='migration_topology_'+index++,client=await isolated.pool.connect()
    try{
     await client.query('create schema '+schema);await client.query('set search_path to '+schema+',public')
     const scopedPool=new Proxy(isolated.pool,{get(target,key){if(key==='connect')return async()=>new Proxy(client,{get(target,key){if(key==='release')return ()=>{};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}});return Reflect.get(target,key)}})
     if(layout==='v2-inheritance')await executionModule.initializeSecurityActionExecutions(scopedPool)
     else await client.query(oldSchema)
     const child='preserved_child'
     if(layout==='partition'){
      await client.query('alter table '+table+' rename to legacy_shape')
      await client.query('create table '+table+' (like legacy_shape including defaults including constraints) partition by list(owner_id)')
      await client.query("create table "+child+" partition of "+table+" for values in ('old')")
     }else await client.query('create table '+child+' () inherits ('+table+')')
     if(layout==='partition'||layout==='inheritance-rows'){
      if(table==='teloa_security_action_executions')await client.query("insert into "+child+" values($1,'old',$2,'{}','action','approval',1,'{}','dispatching',1,null,null,$3,$3)",[randomUUID(),randomUUID(),identity.now()])
      else await client.query("insert into "+child+"(owner_id,operation_id,at,event,detail) values('old',$1,$2,'preserved','{}')",[randomUUID(),identity.now()])
     }
     assert.equal((await client.query('select count(*) from only '+table)).rows[0].count,'0')
     const snapshot=async()=>({
      relations:(await client.query("select c.oid,c.relname,c.relkind,c.relispartition,obj_description(c.oid) marker from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 order by c.relname",[schema])).rows,
      inheritance:(await client.query('select inhrelid,inhparent,inhseqno from pg_inherits where inhparent=$1::regclass order by inhrelid',[table])).rows,
      constraints:(await client.query('select oid,conname,pg_get_constraintdef(oid) definition from pg_constraint where conrelid=$1::regclass or conrelid=to_regclass($2) order by oid',[table,child])).rows,
      rows:(await client.query('select to_jsonb(child) body from '+child+' child')).rows,
     })
     const before=await snapshot(),outcome=await executionModule.initializeSecurityActionExecutions(scopedPool).then(()=>null,error=>error as Error&{code?:string})
     assert.equal(outcome?.code,'teloa/storage-corrupt')
     assert.deepEqual(await snapshot(),before)
    }finally{client.release()}
   })
  }
 }finally{await isolated.close()}
})

test('迁移在旧表与 v2 marker 下拒绝非普通关系类型，原对象不变',async t=>{
 const isolated=await database()
 try{
  await isolated.pool.query('create extension postgres_fdw')
  await isolated.pool.query("create server migration_foreign_server foreign data wrapper postgres_fdw options(host '127.0.0.1',dbname 'unused')")
  let index=0
  for(const table of ['teloa_security_action_executions','teloa_security_action_execution_audit'])for(const kind of ['view','materialized view','foreign table','sequence'])for(const marked of [false,true]){
   await t.test(table+' '+kind+(marked?' v2':''),async()=>{
    const schema='migration_kind_'+index++,client=await isolated.pool.connect()
    try{
     await client.query('create schema '+schema);await client.query('set search_path to '+schema+',public')
     if(kind==='view'||kind==='materialized view')await client.query('create '+kind+' '+table+" as select '历史事实'::text preserved")
     else if(kind==='foreign table')await client.query('create foreign table '+table+'(preserved text) server migration_foreign_server')
     else await client.query('create sequence '+table)
     if(marked)await client.query('comment on '+kind+' '+table+" is 'teloa.security-action-execution/v2'")
     const before=(await client.query("select c.oid,c.relname,c.relkind,obj_description(c.oid) marker from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 order by c.relname",[schema])).rows
     const scopedPool=new Proxy(isolated.pool,{get(target,key){if(key==='connect')return async()=>new Proxy(client,{get(target,key){if(key==='release')return ()=>{};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}});return Reflect.get(target,key)}})
     await assert.rejects(executionModule.initializeSecurityActionExecutions(scopedPool),{code:'teloa/storage-corrupt'})
     assert.deepEqual((await client.query("select c.oid,c.relname,c.relkind,obj_description(c.oid) marker from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 order by c.relname",[schema])).rows,before)
     if(kind==='view'||kind==='materialized view')assert.deepEqual((await client.query('select * from '+table)).rows,[{preserved:'历史事实'}])
    }finally{client.release()}
   })
  }
 }finally{await isolated.close()}
})

test('批准前后声明版本或任务定义变化均拒绝旧基线，claim 原子回滚无执行和审计',async()=>{
 const {SecurityApprovalService}=await import('../src/security/approvals.ts')
 const {definition}=await import('./security-action-fixture.ts')
 const changedCatalog={require:()=>({...definition,playbookVersion:'security.endpoint.isolate/v2',authorize:(...args:Parameters<typeof definition.authorize>)=>({...definition.authorize(...args),playbookVersion:'security.endpoint.isolate/v2'})})}
 const pendingFixture=await fixture(db.pool),pending=await pendingFixture.actions.submit(pendingFixture.principal,command(await pendingFixture.actions.propose(pendingFixture.principal,pendingFixture.proposal)))
 const changedApprovals=new SecurityApprovalService(db.pool,identity,changedCatalog,pendingFixture.journal)
 await assert.rejects(changedApprovals.decide(pendingFixture.principal,decision(pending)),{code:'teloa/version-conflict'})
 assert.equal((await pendingFixture.actions.get(pendingFixture.principal,{actionId:pending.id})).state,'pending_approval')
 for(const change of ['task','catalog']){
  const f=await setup()
  if(change==='task')await f.tasks.edit(f.principal.ownerId,{taskId:f.task.id,expectedVersion:f.task.version,fields:{title:f.task.title,goal:'批准后改变调查目标'}})
  const service=change==='catalog'?new executionModule.SecurityActionExecutionService(db.pool,identity,new SecurityApprovalService(db.pool,identity,changedCatalog,f.journal),f.journal):f.service
  await assert.rejects(service.claim(f.principal,f.request),{code:'teloa/version-conflict'})
  assert.deepEqual(await f.actions.get(f.principal,{actionId:f.approved.id}),f.approved)
  for(const table of ['teloa_security_action_executions','teloa_security_action_execution_audit'])assert.equal((await db.pool.query(`select count(*) from ${table} where owner_id=$1`,[f.principal.ownerId])).rows[0].count,'0')
  assert.equal((await db.pool.query('select count(*) from teloa_security_requests where owner_id=$1 and request_id=$2',[f.principal.ownerId,f.request.requestId])).rows[0].count,'0')
 }
})

test('claim 后定义、来源与六个冻结列逐列仍被数据库拒绝',async()=>{
 const f=await setup();await f.service.claim(f.principal,f.request)
 const attacks:Record<string,unknown>={id:randomUUID(),owner_id:'other',task_id:randomUUID(),scope_id:'AppSec',source_id:'other',object_type:'asset',object_id:'other',object_version:2,object_snapshot_hash:'a'.repeat(64),source_snapshot_digest:'b'.repeat(64),title:'改标题',goal:'改目标',tool:'other',risk_tier:'low',reversible:'readonly',playbook_version:'v2',target_set:JSON.stringify(['db-01']),params:JSON.stringify({reason:'改参数'}),supersedes_action_id:randomUUID(),proposer_id:'other',created_at:'2026-09-12T01:00:00.000Z',frozen_task_definition_digest:'sha256:'+'a'.repeat(64),frozen_source_snapshot_digest:'c'.repeat(64),frozen_object_snapshot_hash:'d'.repeat(64),frozen_playbook_version:'v2',frozen_param_fingerprint:'sha256:'+'e'.repeat(64),frozen_target_fingerprint:'sha256:'+'f'.repeat(64)}
 const before=(await db.pool.query('select * from teloa_security_actions where id=$1',[f.approved.id])).rows[0]
 for(const [column,value] of Object.entries(attacks))await assert.rejects(db.pool.query(`update teloa_security_actions set ${column}=$2 where id=$1`,[f.approved.id,value]),/冻结/,column)
 assert.deepEqual((await db.pool.query('select * from teloa_security_actions where id=$1',[f.approved.id])).rows[0],before)
})

test('待恢复执行只列本人的派发中、已受理与效果未知，按创建序且单轮不超过五十条',async()=>{
 const f=await setup()
 // 真造一条 dispatching：claim 之后不落任何回执。
 const {execution}=await f.service.claim(f.principal,f.request)
 assert.equal(execution.state,'dispatching')
 // 冷却判据现在与写入同用 identity.now()（固定时钟），claim 落库那一刻恰好卡在阈值上；
 // 只为量"列出待恢复"这件事临时把落库时间往回退两分钟，量完立刻复原——
 // 不复原的话，updated_at 会跟 audit 落的快照指纹对不上，后面的 recordEffect 会被当成存储损坏拒绝。
 const backdate=async(sign:'-'|'+')=>{
  await db.pool.query('alter table teloa_security_action_executions disable trigger all')
  try{await db.pool.query(`update teloa_security_action_executions set created_at=created_at${sign}interval '2 minutes',updated_at=updated_at${sign}interval '2 minutes' where operation_id=$1`,[execution.operationId])}
  finally{await db.pool.query('alter table teloa_security_action_executions enable trigger all')}
 }
 await backdate('-')
 assert.deepEqual(await f.service.outstanding(f.principal),[execution.operationId])
 await backdate('+')
 // 终态不再出现。
 await f.service.recordEffect(f.principal,{operationId:execution.operationId,receipt:receipt('succeeded')})
 assert.deepEqual(await f.service.outstanding(f.principal),[])
 // 换一个本人身份就一条都看不到。
 assert.deepEqual(await f.service.outstanding({...f.principal,ownerId:randomUUID()}),[])
})
test('刚落库的派发中记录先晾过一分钟冷却才进待恢复目录',async()=>{
 const f=await setup()
 // 这条记录要用真实时钟写：fixture 的固定时钟停在 2026-09-13，落库即已过冷却，量不出这件事。
 const live=new executionModule.SecurityActionExecutionService(db.pool,{id:randomUUID,now:()=>new Date().toISOString()},f.approvals,f.journal)
 const {execution}=await live.claim(f.principal,f.request)
 assert.equal(execution.state,'dispatching')
 assert.deepEqual(await live.outstanding(f.principal),[],'冷却期内不进目录：用户那次首派 POST 可能还在途，抢发会变成第二次外部调用')
 await db.pool.query('alter table teloa_security_action_executions disable trigger all')
 // created_at 一起往前挪：表上有 updated_at>=created_at 的检查，只挪一半会被拒。
 try{await db.pool.query("update teloa_security_action_executions set created_at=now()-interval '3 minutes',updated_at=now()-interval '2 minutes' where operation_id=$1",[execution.operationId])}
 finally{await db.pool.query('alter table teloa_security_action_executions enable trigger all')}
 assert.deepEqual(await live.outstanding(f.principal),[execution.operationId],'超过一分钟才判为真的中断')
})
test('待恢复执行身份损坏时整份目录报存储损坏，不返回半份',async()=>{
 const f=await setup(),{execution}=await f.service.claim(f.principal,f.request)
 await db.pool.query('alter table teloa_security_action_executions disable trigger all')
 // 身份损坏之外，落库时间也要一并回退，否则这条记录还没过冷却，压根进不了 outstanding 的候选集，
 // 也就量不到"损坏身份触发 storage-corrupt"这件事。
 try{await db.pool.query("update teloa_security_action_executions set operation_id='00000000-0000-0000-0000-000000000000',created_at=created_at-interval '2 minutes',updated_at=updated_at-interval '2 minutes' where operation_id=$1",[execution.operationId])}
 finally{await db.pool.query('alter table teloa_security_action_executions enable trigger all')}
 await assert.rejects(f.service.outstanding(f.principal),{code:'teloa/storage-corrupt'})
})
test('待恢复执行超过单轮上限时按创建序只取最早的五十条',async()=>{
 const f=await setup(),operationIds:string[]=[]
 for(let i=0;i<51;i++){
  const proposed=await f.actions.propose(f.principal,{...f.proposal,requestId:randomUUID()})
  const submitted=await f.actions.submit(f.principal,command(proposed))
  await f.approvals.decide(f.principal,decision(submitted))
  const approvedAction=await f.actions.get(f.principal,{actionId:proposed.id})
  const {execution}=await f.service.claim(f.principal,command(approvedAction))
  operationIds.push(execution.operationId)
 }
 // 打乱创建序：直接改 created_at，证明排序真的按时间而非插入顺序或身份随机值。
 // updated_at 一并挪到同一时刻：早于固定时钟一分钟以上才能过冷却，否则查不出这 51 条里的任何一条。
 const shuffled=[...operationIds].sort(()=>Math.random()-0.5)
 await db.pool.query('alter table teloa_security_action_executions disable trigger all')
 try{
  for(const [index,operationId] of shuffled.entries())
   await db.pool.query('update teloa_security_action_executions set created_at=$2,updated_at=$2 where operation_id=$1',
    [operationId,new Date(Date.parse('2026-09-01T00:00:00.000Z')+index*1000).toISOString()])
 }finally{await db.pool.query('alter table teloa_security_action_executions enable trigger all')}
 const outstanding=await f.service.outstanding(f.principal)
 assert.equal(outstanding.length,50)
 assert.deepEqual(outstanding,shuffled.slice(0,50),'恰好取按 created_at 最早的五十条，首条最早')
})
