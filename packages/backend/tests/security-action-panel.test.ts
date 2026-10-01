import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readSecurityActionPanel} from '@teloa/contract'
import {database,fixture,catalog,command,decision,identity} from './security-action-fixture.ts'
import {initializeSecurityActionExecutions,SecurityActionExecutionService} from '../src/security/action-executions.ts'
import {securityParamFingerprint} from '../src/security/action-authorization.ts'

test('Panel 从固定快照生成空动作能力，同一 signal 核对 readiness；不暴露凭据或额外字段',async t=>{
 const db=await database();t.after(db.close);await initializeSecurityActionExecutions(db.pool)
 const f=await fixture(db.pool),module=await import('../src/security/action-panel.ts'),signal=new AbortController().signal,calls:unknown[][]=[]
 const service=new module.SecurityActionPanelService(db.pool,catalog,{ready:async(...args:unknown[])=>{calls.push(args);return {ready:false as const,reason:'未配置'}}})
 const panel=await service.list(f.principal,{taskId:f.task.id},signal)
 assert.deepEqual(readSecurityActionPanel(panel),{taskId:f.task.id,actions:[],approvals:[],executions:[],proposal:{tools:[{tool:'security.endpoint.isolate',allowedTargets:['prod-03']}]}})
 assert.equal(calls[0]![1],signal)
 await assert.rejects(service.list({...f.principal,ownerId:'other'},{taskId:f.task.id},signal),{code:'teloa/forbidden'})
})

test('Panel 聚合真实批准及执行，并拒绝损坏派发摘要',async t=>{
 const db=await database();t.after(db.close);await initializeSecurityActionExecutions(db.pool)
 const f=await fixture(db.pool),{SecurityActionPanelService}=await import('../src/security/action-panel.ts'),signal=new AbortController().signal
 const service=new SecurityActionPanelService(db.pool,catalog,{ready:async()=>({ready:true})})
 const proposed=await f.actions.propose(f.principal,f.proposal),pending=await f.actions.submit(f.principal,command(proposed)),approval=await f.approvals.decide(f.principal,decision(pending)),approved=await f.actions.get(f.principal,{actionId:proposed.id})
 const executions=new SecurityActionExecutionService(db.pool,identity,f.approvals,f.journal),claimed=await executions.claim(f.principal,command(approved))
 const panel=await service.list(f.principal,{taskId:f.task.id},signal)
 assert.equal(panel.actions[0]?.state,'executing');assert.deepEqual(panel.approvals,[approval]);assert.deepEqual(panel.executions,[claimed.execution])
 const client=await db.pool.connect()
 await client.query("set session_replication_role='replica'")
 await client.query("update teloa_security_action_executions set dispatch_spec_digest=$1 where operation_id=$2",['sha256:'+'0'.repeat(64),claimed.execution.operationId]);client.release()
 await assert.rejects(service.list(f.principal,{taskId:f.task.id},signal),{code:'teloa/storage-corrupt'})
})

test('Panel 拒绝 Action 任务关联断裂和固定来源被替换，不能变成空面板',async t=>{
 const db=await database();t.after(db.close);await initializeSecurityActionExecutions(db.pool)
 const {SecurityActionPanelService}=await import('../src/security/action-panel.ts'),signal=new AbortController().signal,service=new SecurityActionPanelService(db.pool,catalog,{ready:async()=>({ready:true})})
 for(const mutation of ['task_id','source_snapshot_digest'])await t.test(mutation,async()=>{
  const f=await fixture(db.pool),action=await f.actions.propose(f.principal,f.proposal),client=await db.pool.connect()
  try{await client.query("set session_replication_role='replica'");await client.query(`update teloa_security_actions set ${mutation}=$1 where id=$2`,[mutation==='task_id'?randomUUID():'0'.repeat(64),action.id]);await client.query("set session_replication_role='origin'")}finally{client.release()}
  await assert.rejects(service.list(f.principal,{taskId:f.task.id},signal),{code:'teloa/storage-corrupt'})
 })
})

test('本人任务中的 Action owner 损坏不能被首查询过滤，正常他人任务仍隔离',async t=>{
 const db=await database();t.after(db.close);await initializeSecurityActionExecutions(db.pool)
 const {SecurityActionPanelService}=await import('../src/security/action-panel.ts'),{SecurityActionAttentionService}=await import('../src/security/action-attention.ts'),signal=new AbortController().signal,ready={ready:async()=>({ready:true as const})}
 const panel=new SecurityActionPanelService(db.pool,catalog,ready),attention=new SecurityActionAttentionService(db.pool,catalog,ready,identity.now)
 for(const state of ['proposed','pending_approval'])await t.test(state,async()=>{
  const f=await fixture(db.pool),other=await fixture(db.pool),proposed=await f.actions.propose(f.principal,f.proposal),otherProposed=await other.actions.propose(other.principal,other.proposal)
  if(state==='pending_approval')await f.actions.submit(f.principal,command(proposed))
  await other.actions.submit(other.principal,command(otherProposed))
  assert.deepEqual((await panel.list(f.principal,{taskId:f.task.id},signal)).actions.map(action=>action.id),[proposed.id])
  assert.ok((await attention.list(f.principal,{},signal)).every(item=>item.actionId===proposed.id))
  assert.deepEqual((await attention.list(other.principal,{},signal)).map(item=>item.actionId),[otherProposed.id])
  const client=await db.pool.connect()
  try{await client.query("set session_replication_role='replica'");await client.query('update teloa_security_actions set owner_id=$1 where id=$2',['corrupt:'+randomUUID(),proposed.id]);await client.query("set session_replication_role='origin'")}finally{client.release()}
  const stored=(await db.pool.query('select id,owner_id,task_id from teloa_security_actions where id=$1',[proposed.id])).rows[0]
  assert.equal(stored.task_id,f.task.id);assert.notEqual(stored.owner_id,f.principal.ownerId)
  await assert.rejects(panel.list(f.principal,{taskId:f.task.id},signal),{code:'teloa/storage-corrupt'})
  await assert.rejects(attention.list(f.principal,{},signal),{code:'teloa/storage-corrupt'})
  assert.deepEqual((await attention.list(other.principal,{},signal)).map(item=>item.actionId),[otherProposed.id])
 })
})

test('固定快照中缺失、重复或非法资产均不可产生 capability',async t=>{
 const db=await database();t.after(db.close);await initializeSecurityActionExecutions(db.pool)
 const {securityEndpointAllowedTargets}=await import('../src/security/action-authorization.ts'),f=await fixture(db.pool)
 assert.deepEqual(securityEndpointAllowedTargets(f.snapshot),['prod-03'])
 for(const fields of [[],[{label:'资产',value:'a'},{label:'资产',value:'b'}],[{label:'资产',value:' a'}]])assert.throws(()=>securityEndpointAllowedTargets({...f.snapshot,fields}),{code:'teloa/forbidden'})
})

test('Panel 和 Attention 对缺失执行、未知状态、重复执行与重复确认均停止读取',async t=>{
 const db=await database();t.after(db.close);await initializeSecurityActionExecutions(db.pool)
 const {SecurityActionPanelService}=await import('../src/security/action-panel.ts'),{SecurityActionAttentionService}=await import('../src/security/action-attention.ts'),signal=new AbortController().signal,ready={ready:async()=>({ready:true as const})}
 for(const mutation of ['missing-execution','unknown-state','duplicate-execution','duplicate-ack','null-request'])await t.test(mutation,async()=>{
  const f=await fixture(db.pool),proposed=await f.actions.propose(f.principal,f.proposal),pending=await f.actions.submit(f.principal,command(proposed));await f.approvals.decide(f.principal,decision(pending))
  const approved=await f.actions.get(f.principal,{actionId:proposed.id}),executions=new SecurityActionExecutionService(db.pool,identity,f.approvals,f.journal),claimed=await executions.claim(f.principal,command(approved))
  if(mutation==='duplicate-ack'){
   await executions.recordEffect(f.principal,{operationId:claimed.execution.operationId,receipt:{status:'failed',receiptId:'failed',detail:'隔离失败',observedAt:identity.now(),targets:[{target:'prod-03',state:'failed'}]}})
   await f.actions.acknowledgeFailure(f.principal,command(await f.actions.get(f.principal,{actionId:proposed.id})))
  }
  const client=await db.pool.connect()
  try{
   await client.query("set session_replication_role='replica'")
   if(mutation==='missing-execution')await client.query('delete from teloa_security_action_executions where operation_id=$1',[claimed.execution.operationId])
   if(mutation==='unknown-state'){
    const constraints=(await client.query("select conname from pg_constraint where conrelid='teloa_security_actions'::regclass and contype='c' and pg_get_constraintdef(oid) like '%state%'")).rows
    for(const row of constraints)await client.query('alter table teloa_security_actions drop constraint "'+row.conname+'"')
    await client.query("update teloa_security_actions set state='broken' where id=$1",[proposed.id])
   }
   if(mutation==='duplicate-execution'){
    const constraints=(await client.query("select conname from pg_constraint where conrelid='teloa_security_action_executions'::regclass and contype='u' and pg_get_constraintdef(oid) like '%action_id%'")).rows
    for(const row of constraints)await client.query('alter table teloa_security_action_executions drop constraint "'+row.conname+'"')
    const row=(await client.query('select * from teloa_security_action_executions where operation_id=$1',[claimed.execution.operationId])).rows[0],operationId=randomUUID(),dispatch={...row.dispatch_spec,operationId}
    await client.query('insert into teloa_security_action_executions select * from jsonb_populate_record(null::teloa_security_action_executions,$1)',[JSON.stringify({...row,operation_id:operationId,request_id:randomUUID(),dispatch_spec:dispatch,dispatch_spec_digest:securityParamFingerprint(dispatch)})])
    assert.equal((await client.query('select * from teloa_security_action_executions where action_id=$1',[proposed.id])).rowCount,2)
   }
   if(mutation==='duplicate-ack'){
    const constraints=(await client.query("select conname from pg_constraint where conrelid='teloa_security_action_attention_acknowledgements'::regclass and contype='u'")).rows
    for(const row of constraints)await client.query('alter table teloa_security_action_attention_acknowledgements drop constraint "'+row.conname+'"')
    const row=(await client.query('select * from teloa_security_action_attention_acknowledgements where action_id=$1',[proposed.id])).rows[0]
    await client.query('insert into teloa_security_action_attention_acknowledgements select * from jsonb_populate_record(null::teloa_security_action_attention_acknowledgements,$1)',[JSON.stringify({...row,request_id:randomUUID()})])
    assert.equal((await client.query('select * from teloa_security_action_attention_acknowledgements where action_id=$1',[proposed.id])).rowCount,2)
   }
   if(mutation==='null-request'){
    const constraints=(await client.query("select conname from pg_constraint where conrelid='teloa_security_requests'::regclass and contype='c' and pg_get_constraintdef(oid) like '%request_spec%'")).rows
    for(const row of constraints)await client.query('alter table teloa_security_requests drop constraint "'+row.conname+'"')
    await client.query("update teloa_security_requests set request_spec='null'::jsonb where owner_id=$1 and command='execute'",[f.principal.ownerId])
   }
   await client.query("set session_replication_role='origin'")
  }finally{client.release()}
  await assert.rejects(new SecurityActionPanelService(db.pool,catalog,ready).list(f.principal,{taskId:f.task.id},signal),{code:'teloa/storage-corrupt'})
  await assert.rejects(new SecurityActionAttentionService(db.pool,catalog,ready,identity.now).list(f.principal,{},signal),{code:'teloa/storage-corrupt'})
 })
})
