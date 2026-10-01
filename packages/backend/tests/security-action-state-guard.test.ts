import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {securityActionTransitions} from '@teloa/contract'
import {database,fixture,command,decision} from './security-action-fixture.ts'
let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database()},{timeout:60000});after(async()=>{await db?.close()})

test('数据库状态边与合同双向一致，非法倒退明确报错',async()=>{
 const rows=(await db.pool.query('select from_state,to_state from teloa_security_action_transitions')).rows.map(r=>`${r.from_state}->${r.to_state}`).sort()
 assert.deepEqual(rows,Object.entries(securityActionTransitions).flatMap(([a,bs])=>bs.map(b=>`${a}->${b}`)).sort())
 const f=await fixture(db.pool),p=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,f.proposal)));await f.approvals.decide(f.principal,decision(p))
 await assert.rejects(db.pool.query("update teloa_security_actions set state='pending_approval' where id=$1",[p.id]),/非法的安全动作状态转移/)
})

test('提交后所有定义、来源身份和六个冻结列逐列不可改，撤回后也不可解冻',async()=>{
 const f=await fixture(db.pool),p=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,f.proposal)))
 const attacks:Record<string,unknown>={id:randomUUID(),owner_id:'other',task_id:randomUUID(),scope_id:'AppSec',source_id:'other',object_type:'asset',object_id:'other',object_version:2,object_snapshot_hash:'a'.repeat(64),source_snapshot_digest:'b'.repeat(64),title:'改标题',goal:'改目标',tool:'other',risk_tier:'low',reversible:'readonly',playbook_version:'v2',target_set:JSON.stringify(['db-01']),params:JSON.stringify({reason:'改参数'}),supersedes_action_id:randomUUID(),proposer_id:'other',created_at:'2026-09-12T01:00:00.000Z',frozen_task_definition_digest:'sha256:'+'a'.repeat(64),frozen_source_snapshot_digest:'c'.repeat(64),frozen_object_snapshot_hash:'d'.repeat(64),frozen_playbook_version:'v2',frozen_param_fingerprint:'sha256:'+'e'.repeat(64),frozen_target_fingerprint:'sha256:'+'f'.repeat(64)}
 for(const [column,value] of Object.entries(attacks))await assert.rejects(db.pool.query(`update teloa_security_actions set ${column}=$2 where id=$1`,[p.id,value]),/冻结/,column)
 await f.actions.withdrawSubmission(f.principal,command(p))
 await assert.rejects(db.pool.query('update teloa_security_actions set frozen_param_fingerprint=null where id=$1',[p.id]),/冻结/)
 const a=await f.actions.propose(f.principal,{...f.proposal,requestId:randomUUID()})
 await assert.rejects(db.pool.query('update teloa_security_actions set frozen_param_fingerprint=$2 where id=$1',[a.id,'sha256:'+'a'.repeat(64)]),/冻结/)
})

test('Approval 和失败确认 UPDATE/DELETE 被物理拒绝，journal 必含精确 command',async()=>{
 const f=await fixture(db.pool),p=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,f.proposal))),a=await f.approvals.decide(f.principal,decision(p))
 await assert.rejects(db.pool.query("update teloa_security_approvals set approver_id='other' where id=$1",[a.id]),/不可修改/)
 await assert.rejects(db.pool.query('delete from teloa_security_approvals where id=$1',[a.id]),/不可修改/)
 await db.pool.query("update teloa_security_actions set state='executing',version=version+1 where id=$1",[p.id]);await db.pool.query("update teloa_security_actions set state='failed',version=version+1 where id=$1",[p.id])
 await f.actions.acknowledgeFailure(f.principal,command(await f.actions.get(f.principal,{actionId:p.id})))
 await assert.rejects(db.pool.query("update teloa_security_action_attention_acknowledgements set approver_id='other' where action_id=$1",[p.id]),/不可修改/)
 await assert.rejects(db.pool.query('delete from teloa_security_action_attention_acknowledgements where action_id=$1',[p.id]),/不可修改/)
 for(const spec of [{},{command:'decide'},{command:null},{command:'propose',requestId:randomUUID()}])await assert.rejects(db.pool.query('insert into teloa_security_requests(owner_id,request_id,command,request_spec,created_at) values($1,$2,$3,$4,$5)',[f.principal.ownerId,randomUUID(),'propose',JSON.stringify(spec),'2026-09-13T01:00:00.000Z']),{code:'23514'})
})
