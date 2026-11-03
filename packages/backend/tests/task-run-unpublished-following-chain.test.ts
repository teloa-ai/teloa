import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {goalEditFixture} from './fixtures/plan-goal-edit-unpublished.ts'
import {readStoredTaskRun} from '../src/work/task-runs.ts'
import {readUnpublishedCancellationSettled,readUnpublishedFollowingBudgetScope} from '../src/work/task-run-submission.ts'
import {verifySourceFollowup,assertSourceFollowupDispatch} from '../src/work/task-run-source-followups.ts'

function chain(depth:number){const f=goalEditFixture();let parent:Record<string,any>=f.runRow,last:ReturnType<typeof f.appendFollowing>|undefined;for(let i=0;i<depth;i++){if(parent!==f.runRow){parent.state='ended';parent.evidence={state:'ended',turn:i,messageSeq:i*2+1,endSeq:i*2+2,reason:'error'}}last=f.appendFollowing(parent);parent=last.row}const root=readStoredTaskRun(f.runRow);f.state.budgetRunId=last!.row.id;return{...f,root,leaf:last!}}

test('原typed未发布取消的一次及多次合法后代，只认当前leaf自己的reserved预算',async()=>{
 for(const depth of[1,2,3]){const f=chain(depth);assert.equal(await readUnpublishedCancellationSettled(f.db,f.owner,f.root,f.root,f.leaf.binding),true,'depth '+depth)}
})

test('多层goal-only历史及真实source-followup verifier沿当前leaf核原取消',async()=>{
 const f=chain(3);assert.ok(await f.read());assert.ok(await verifySourceFollowup(f.db,f.owner,readStoredTaskRun(f.leaf.row)))
})

test('当前leaf历史预算可分域读取，但dispatch未知/陌生预算/无leaf确认仍拒绝',async()=>{
 const f=chain(3);f.state.budgetState='unknown'
 assert.equal(await readUnpublishedCancellationSettled(f.db,f.owner,f.root,f.root,f.leaf.binding,'history'),true)
 assert.equal(await readUnpublishedCancellationSettled(f.db,f.owner,f.root,f.root,f.leaf.binding,'dispatch'),false)
 assert.equal(await readUnpublishedCancellationSettled(f.db,f.owner,f.root),false)
 f.state.budgetState='reserved';f.state.budgetRunId=randomUUID()
 assert.equal(await readUnpublishedCancellationSettled(f.db,f.owner,f.root,f.root,f.leaf.binding),false,'same account foreign Run must not be exempted')
 const prospective=chain(2);prospective.state.following.pop()
 assert.equal(await readUnpublishedCancellationSettled(prospective.db,prospective.owner,prospective.root,prospective.root,prospective.leaf.binding),false,'unpersisted owner input cannot exclude any budget')
})

test('链上owner/SID/Role/版本/原文hash/来源/签收凭据/分叉或停止漂移不取得自身预算资格',async()=>{
 for(const mutation of['owner','SID','role','role-version','version','input-hash','evidence-hash','source-hash','source-version','source-state','receipt','current','stop','unknown','branch','cycle'] as const){
  const f=chain(3),middle=f.childRows.get(f.state.following[0]!.binding.requestId)!,latest=f.leaf.row
  if(mutation==='owner')latest.owner_id='foreign-owner'
  if(mutation==='SID')latest.session_id='foreign-sid'
  if(mutation==='role')latest.role_id=randomUUID()
  if(mutation==='role-version')latest.role_version=3
  if(mutation==='version')latest.task_version++
  if(mutation==='input-hash')f.leaf.binding.originalInputSha256='e'.repeat(64)
  if(mutation==='evidence-hash')f.leaf.binding.originalEvidenceSha256='e'.repeat(64)
  if(mutation==='source-hash')f.update.snapshot_hash='e'.repeat(64)
  if(mutation==='source-version')f.update.object_version=3
  if(mutation==='source-state')f.update.reason='teloa/submission-unknown'
  if(mutation==='receipt')f.receipt.identity.inputSha256='e'.repeat(64)
  if(mutation==='current')f.state.current=false
  if(mutation==='stop')middle.stop_requested_at=new Date('2026-09-01T01:00:00.000Z')
  if(mutation==='unknown'){middle.state='submission_unknown';middle.evidence=null}
  if(mutation==='branch')f.state.following.push({binding:{...f.state.following[0]!.binding,requestId:randomUUID()}})
  if(mutation==='cycle')f.leaf.binding.originalRunId=latest.id
  assert.equal(await readUnpublishedCancellationSettled(f.db,f.owner,f.root,f.root,f.leaf.binding),false,mutation)
 }
})

test('多级确认保留原行与source锚，SQL故障正常传播而非当作安全成功',async()=>{
 const f=chain(3),before=structuredClone({root:f.runRow,rows:[...f.childRows.values()],records:f.records(),update:f.update,receipt:f.receipt})
 assert.equal(await readUnpublishedCancellationSettled(f.db,f.owner,f.root,f.root,f.leaf.binding),true)
 assert.deepEqual({root:f.runRow,rows:[...f.childRows.values()],records:f.records(),update:f.update,receipt:f.receipt},before)
 const error=Error('database unavailable'),broken={query:async()=>{throw error}}
 await assert.rejects(readUnpublishedCancellationSettled(broken as never,f.owner,f.root,f.root,f.leaf.binding),e=>e===error)
})

test('停止不自动变成续办资格；只有原公开stopped确认及exact停止时刻保留合法链',async()=>{
 const f=chain(1),first=f.leaf.row;first.state='ended';first.evidence={state:'ended',turn:2,messageSeq:3,endSeq:4,reason:'error'};first.stop_requested_at=new Date('2026-09-01T01:00:00.000Z');f.state.budgetRunId=null
 assert.ok(await f.read(),'stopped history remains readable when no inflight budget')
 f.state.budgetRunId=first.id;assert.equal(await readUnpublishedCancellationSettled(f.db,f.owner,f.root,f.root,f.leaf.binding),false,'stopped leaf cannot consume the budget exemption')
 const next=f.appendFollowing(first,'stopped-continuation');f.state.budgetRunId=next.row.id
 assert.equal(await readUnpublishedCancellationSettled(f.db,f.owner,f.root,f.root,next.binding),true)
 assert.ok(await verifySourceFollowup(f.db,f.owner,readStoredTaskRun(next.row)))
})

test('独立真实source-followup verifier把当前leaf传到typed根，不退回祖先预算身份',async()=>{
 for(const depth of[2,3]){const f=chain(depth),before=structuredClone(f.records());assert.ok(await verifySourceFollowup(f.db,f.owner,readStoredTaskRun(f.leaf.row)));assert.deepEqual(f.records(),before)}
})

test('持久来源历史不因后来账户预算失读，发送仍重核当前unknown与foreign',async()=>{
 const f=chain(2),run=readStoredTaskRun(f.leaf.row),before=structuredClone({root:f.runRow,update:f.update,receipt:f.receipt})
 f.state.budgetState='unknown';f.state.budgetRunId=randomUUID()
 assert.ok(await verifySourceFollowup(f.db,f.owner,run),'历史来源身份不是新发送的预算准入')
 await assert.rejects(assertSourceFollowupDispatch(f.db,f.owner,run),{code:'teloa/conflict'})
 f.state.budgetRunId=run.id
 assert.ok(await verifySourceFollowup(f.db,f.owner,run),'本次在途unknown不得阻断原Run的历史回读')
 await assert.rejects(assertSourceFollowupDispatch(f.db,f.owner,run),{code:'teloa/conflict'})
 f.receipt.identity.inputSha256='e'.repeat(64)
 await assert.rejects(verifySourceFollowup(f.db,f.owner,run),{code:'teloa/conflict'},'取消凭据损坏仍拒绝')
 f.receipt.identity.inputSha256=before.receipt.identity.inputSha256
 assert.deepEqual({root:f.runRow,update:f.update,receipt:f.receipt},before)
})

function cancelledSibling(){
 const f=chain(1),parent=f.leaf.row
 parent.state='ended';parent.evidence={state:'ended',turn:2,messageSeq:3,endSeq:4,reason:'error'};parent.stop_requested_at=new Date('2026-09-01T01:00:00.000Z')
 const cancelled=f.appendFollowing(parent,'stopped-continuation');cancelled.row.state='withdrawn';cancelled.row.stop_requested_at=new Date('2026-09-01T01:00:00.000Z')
 const current=f.appendFollowing(parent,'stopped-continuation');current.binding.taskVersion+=2;current.row.task_version=current.binding.taskVersion;current.row.request_spec.expectedTaskVersion=current.binding.taskVersion
 const body=JSON.parse(current.row.input_text);body.task.version=current.binding.taskVersion;body.sourceFollowup=current.binding;current.row.input_text=JSON.stringify(body)
 const attempt={...f.attempt,attempt_id:randomUUID(),native_request_id:cancelled.row.native_request_id,input_sha256:createHash('sha256').update(cancelled.row.input_text).digest('hex')}
 const receipt={...f.receipt,requestId:randomUUID(),identity:{runId:cancelled.row.id,sessionId:cancelled.row.session_id,nativeRequestId:cancelled.row.native_request_id,inputSha256:attempt.input_sha256},attemptIds:[attempt.attempt_id],latestAttemptId:attempt.attempt_id}
 let present=true,effect=false
 const db={query:async(sql:string,args:unknown[]=[])=>{
  const rows=(value:unknown[])=>({rows:value,rowCount:value.length})
  if(sql.startsWith('select 1 from teloa_work_budget_reservations b join')&&sql.includes('r.run_id=$2'))return rows(args[1]===f.state.budgetRunId?[{one:1}]:[])
  if(args[1]===cancelled.row.id){
   if(sql.startsWith('select id from teloa_task_runs'))return rows(cancelled.row.state==='withdrawn'?[{id:cancelled.row.id}]:[])
   if(sql.startsWith('select request_id,receipt,audit'))return rows(present?[{request_id:receipt.requestId,receipt,audit:null}]:[])
   if(sql.startsWith('select * from teloa_task_run_submissions'))return rows([attempt])
   if(sql.startsWith('select 1 from teloa_task_run_flows')&&effect)return rows([{one:1}])
  }
  return f.db.query(sql,args)
 }}
 f.state.budgetRunId=current.row.id
 return{...f,parent,cancelled,current,receipt,attempt,db,setReceipt:(value:boolean)=>present=value,setEffect:(value:boolean)=>effect=value}
}

test('正式未发布取消兄弟不占唯一当前分支；新reserved可准入而unknown/foreign仍拒',async()=>{
 const f=cancelledSibling(),before=structuredClone({root:f.runRow,cancelled:f.cancelled.row,receipt:f.receipt,bindings:f.records()})
 const retired=await readUnpublishedFollowingBudgetScope(f.db as never,f.owner,f.root,f.cancelled.binding)
 assert.ok(retired,'已取消确认仍供原goal-only历史消费');assert.equal(retired.mayOwnBudget,false)
 assert.ok(await readUnpublishedFollowingBudgetScope(f.db as never,f.owner,f.root,f.current.binding),'正常取消后本人的新确认形成唯一当前leaf')
 assert.equal(await readUnpublishedCancellationSettled(f.db as never,f.owner,f.root,f.root,f.current.binding,'dispatch'),true)
 const run=readStoredTaskRun(f.current.row);assert.ok(await verifySourceFollowup(f.db as never,f.owner,run));await assertSourceFollowupDispatch(f.db as never,f.owner,run)
 f.state.budgetState='unknown'
 assert.ok(await verifySourceFollowup(f.db as never,f.owner,run));assert.equal(await readUnpublishedCancellationSettled(f.db as never,f.owner,f.root,f.root,f.current.binding,'dispatch'),false)
 await assert.rejects(assertSourceFollowupDispatch(f.db as never,f.owner,run),{code:'teloa/conflict'})
 f.state.budgetState='reserved';f.state.budgetRunId=randomUUID()
 assert.equal(await readUnpublishedCancellationSettled(f.db as never,f.owner,f.root,f.root,f.current.binding,'dispatch'),false)
 assert.deepEqual({root:f.runRow,cancelled:f.cancelled.row,receipt:f.receipt,bindings:f.records()},before)
})

test('不能凭withdrawn跳过分支：缺或坏取消回执、已发布/未知、异归属或后台后果均拒',async()=>{
 for(const mutation of['missing','receipt','attempt','active','unknown','owner','sid','role','source','effect'] as const){
  const f=cancelledSibling()
  if(mutation==='missing')f.setReceipt(false)
  if(mutation==='receipt')f.receipt.identity.nativeRequestId=randomUUID()
  if(mutation==='attempt')f.attempt.state='accepted'
  if(mutation==='active')f.cancelled.row.state='active'
  if(mutation==='unknown')f.cancelled.row.state='submission_unknown'
  if(mutation==='owner')f.cancelled.row.owner_id='foreign'
  if(mutation==='sid')f.cancelled.row.session_id='foreign'
  if(mutation==='role')f.cancelled.row.role_id=randomUUID()
  if(mutation==='source')f.cancelled.binding.sourceEventId=randomUUID()
  if(mutation==='effect')f.setEffect(true)
  assert.equal(await readUnpublishedCancellationSettled(f.db as never,f.owner,f.root,f.root,f.current.binding,'dispatch'),false,mutation)
 }
})
