import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,fixture,catalog,command,decision,identity} from './security-action-fixture.ts'
import {initializeSecurityActionExecutions,SecurityActionExecutionService} from '../src/security/action-executions.ts'

test('Attention 持久状态、ready 互斥、受理非成功、未知与失败确认重启恢复',async t=>{
 const db=await database();t.after(db.close);await initializeSecurityActionExecutions(db.pool)
 const f=await fixture(db.pool),{SecurityActionAttentionService}=await import('../src/security/action-attention.ts'),signal=new AbortController().signal
 let ready=true;const seen:AbortSignal[]=[],port={ready:async(_tool:string,signal:AbortSignal)=>{seen.push(signal);return ready?{ready:true as const}:{ready:false as const,reason:'未配置'}}}
 const attention=new SecurityActionAttentionService(db.pool,catalog,port,identity.now),read=()=>attention.list(f.principal,{},signal),expectReason=async(reason:string)=>{assert.deepEqual(await read(),[{taskId:f.task.id,actionId:proposed.id,kind:'security-action',reason}])}
 const proposed=await f.actions.propose(f.principal,f.proposal);assert.deepEqual(await read(),[])
 const pending=await f.actions.submit(f.principal,command(proposed));await expectReason('approval-required')
 await f.approvals.decide(f.principal,decision(pending));await expectReason('execution-required');ready=false;await expectReason('adapter-unavailable');assert.equal(seen.at(-1),signal)
 const executions=new SecurityActionExecutionService(db.pool,identity,f.approvals,f.journal),approved=await f.actions.get(f.principal,{actionId:proposed.id}),claimed=await executions.claim(f.principal,command(approved));await expectReason('execution-dispatching')
 const receipt={status:'accepted' as const,receiptId:'accepted',detail:'已受理',observedAt:identity.now(),targets:[{target:'prod-03',state:'unknown' as const}]}
 await executions.recordAccepted(f.principal,{operationId:claimed.execution.operationId,receipt});await expectReason('external-accepted')
 await executions.markUnknown(f.principal,{operationId:claimed.execution.operationId,reason:'连接中断'});await expectReason('effect-unknown')
 await executions.recordEffect(f.principal,{operationId:claimed.execution.operationId,receipt:{...receipt,status:'failed',receiptId:'failed',targets:[{target:'prod-03',state:'failed'}]}});await expectReason('execution-failed')
 const failed=await f.actions.get(f.principal,{actionId:proposed.id}),ack=command(failed)
 await f.actions.acknowledgeFailure(f.principal,ack);await f.actions.acknowledgeFailure(f.principal,ack);assert.deepEqual(await read(),[])
 assert.deepEqual(await new SecurityActionAttentionService(db.pool,catalog,port,identity.now).list(f.principal,{},signal),[])
 assert.equal((await db.pool.query('select * from teloa_security_action_attention_acknowledgements where action_id=$1',[failed.id])).rowCount,1)
})

test('Attention 遇到未声明工具必须明确存储损坏',async t=>{
 const db=await database();t.after(db.close);await initializeSecurityActionExecutions(db.pool)
 const f=await fixture(db.pool),{SecurityActionAttentionService}=await import('../src/security/action-attention.ts'),signal=new AbortController().signal
 const proposed=await f.actions.propose(f.principal,f.proposal)
 await db.pool.query("update teloa_security_actions set tool='unknown-tool' where id=$1",[proposed.id])
 await assert.rejects(new SecurityActionAttentionService(db.pool,catalog,{ready:async()=>({ready:true})},identity.now).list(f.principal,{},signal),{code:'teloa/storage-corrupt'})
})

test('supersedes 循环不能把两个失败动作同时静默消退',async t=>{
 const db=await database();t.after(db.close);await initializeSecurityActionExecutions(db.pool)
 const f=await fixture(db.pool),{SecurityActionAttentionService}=await import('../src/security/action-attention.ts'),signal=new AbortController().signal,executions=new SecurityActionExecutionService(db.pool,identity,f.approvals,f.journal)
 const fail=async(supersedesActionId?:string)=>{
  const proposed=await f.actions.propose(f.principal,{...f.proposal,requestId:randomUUID(),...(supersedesActionId?{supersedesActionId}:{})}),pending=await f.actions.submit(f.principal,command(proposed));await f.approvals.decide(f.principal,decision(pending))
  const approved=await f.actions.get(f.principal,{actionId:proposed.id}),claimed=await executions.claim(f.principal,command(approved))
  await executions.recordEffect(f.principal,{operationId:claimed.execution.operationId,receipt:{status:'failed',receiptId:'failed-'+proposed.id,detail:'隔离失败',observedAt:identity.now(),targets:[{target:'prod-03',state:'failed'}]}})
  return proposed.id
 }
 const first=await fail(),second=await fail(first),client=await db.pool.connect()
 try{await client.query("set session_replication_role='replica'");await client.query('update teloa_security_actions set supersedes_action_id=$1 where id=$2',[second,first]);await client.query("set session_replication_role='origin'")}finally{client.release()}
 await assert.rejects(new SecurityActionAttentionService(db.pool,catalog,{ready:async()=>({ready:true})},identity.now).list(f.principal,{},signal),{code:'teloa/storage-corrupt'})
})

test('失败 supersede 后消退；他人动作隔离，损坏状态不能跳过',async t=>{
 const db=await database();t.after(db.close);await initializeSecurityActionExecutions(db.pool)
 const f=await fixture(db.pool),other=await fixture(db.pool),{SecurityActionAttentionService}=await import('../src/security/action-attention.ts'),signal=new AbortController().signal
 const attention=new SecurityActionAttentionService(db.pool,catalog,{ready:async()=>({ready:true})},identity.now)
 const p=await f.actions.propose(f.principal,f.proposal),pending=await f.actions.submit(f.principal,command(p));await f.approvals.decide(f.principal,decision(pending))
 const executions=new SecurityActionExecutionService(db.pool,identity,f.approvals,f.journal),a=await f.actions.get(f.principal,{actionId:p.id}),e=await executions.claim(f.principal,command(a))
 await executions.recordEffect(f.principal,{operationId:e.execution.operationId,receipt:{status:'failed',receiptId:'failed',detail:'隔离失败',observedAt:identity.now(),targets:[{target:'prod-03',state:'failed'}]}})
 await f.actions.propose(f.principal,{...f.proposal,requestId:randomUUID(),supersedesActionId:p.id})
 assert.deepEqual(await attention.list(f.principal,{},signal),[])
 const op=await other.actions.propose(other.principal,other.proposal);await other.actions.submit(other.principal,command(op));assert.deepEqual(await attention.list(f.principal,{},signal),[])
 const client=await db.pool.connect();await client.query("set session_replication_role='replica'")
 await client.query('update teloa_security_action_executions set owner_id=$1 where operation_id=$2',[other.principal.ownerId,e.execution.operationId]);client.release()
 await assert.rejects(attention.list(f.principal,{},signal),{code:'teloa/storage-corrupt'})
})

test('批准过期后事项原因变为审批已过期，优先于执行器未就绪',async t=>{
 const db=await database();t.after(db.close);await initializeSecurityActionExecutions(db.pool)
 const {SecurityActionAttentionService}=await import('../src/security/action-attention.ts')
 const f=await fixture(db.pool),pending=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,f.proposal)))
 await f.approvals.decide(f.principal,decision(pending))
 const later=()=>new Date(Date.parse('2026-09-13T01:00:00.000Z')+16*60_000).toISOString()
 const notReady={ready:async()=>({ready:false as const,reason:'执行器未就绪。'})}
 const service=new SecurityActionAttentionService(db.pool,catalog,notReady,later)
 const items=await service.list(f.principal,{},new AbortController().signal)
 assert.deepEqual(items.map(item=>item.reason),['approval-expired'])
})

test('有效期内且执行器未就绪时仍报执行器未就绪',async t=>{
 const db=await database();t.after(db.close);await initializeSecurityActionExecutions(db.pool)
 const {SecurityActionAttentionService}=await import('../src/security/action-attention.ts')
 const f=await fixture(db.pool),pending=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,f.proposal)))
 await f.approvals.decide(f.principal,decision(pending))
 const inside=()=>new Date(Date.parse('2026-09-13T01:00:00.000Z')+14*60_000).toISOString()
 const notReady={ready:async()=>({ready:false as const,reason:'执行器未就绪。'})}
 const items=await new SecurityActionAttentionService(db.pool,catalog,notReady,inside).list(f.principal,{},new AbortController().signal)
 assert.deepEqual(items.map(item=>item.reason),['adapter-unavailable'])
})
