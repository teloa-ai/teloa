import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {database,fixture,command,decision,identity,definition} from './security-action-fixture.ts'
import {SecurityActionService} from '../src/security/actions.ts'
let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database()},{timeout:60000});after(async()=>{await db?.close()})

test('固定来源提议由目录确定风险，提交六值并历史重放，不重复审计',async()=>{
 const f=await fixture(db.pool),[a,b]=await Promise.all([f.actions.propose(f.principal,f.proposal),f.actions.propose(f.principal,f.proposal)])
 assert.deepEqual(a,b);assert.equal(a.riskTier,'high');assert.equal(a.reversible,'reversible');assert.equal(a.frozen,null)
 const input=command(a),pending=await f.actions.submit(f.principal,input)
 assert.equal(pending.state,'pending_approval');assert.equal(pending.version,2)
 const sourceRow=(await db.pool.query('select snapshot_digest from teloa_business_task_sources where task_id=$1',[a.taskId])).rows[0]
 assert.deepEqual(pending.frozen,{
  taskDefinitionDigest:'sha256:'+createHash('sha256').update(JSON.stringify({goal:f.task.goal,id:f.task.id,scope:'SOC',title:f.task.title})).digest('hex'),
  sourceSnapshotDigest:sourceRow.snapshot_digest,objectSnapshotHash:f.snapshot.snapshotHash,playbookVersion:'security.endpoint.isolate/v1',
  paramFingerprint:'sha256:'+createHash('sha256').update('{"reason":"已核对异常进程"}').digest('hex'),targetFingerprint:'sha256:'+createHash('sha256').update('prod-03').digest('hex'),
 })
 await f.approvals.decide(f.principal,decision(pending))
 assert.deepEqual(await f.actions.submit(f.principal,input),pending)
 assert.deepEqual(await f.actions.propose(f.principal,f.proposal),a)
 assert.equal((await f.actions.get(f.principal,{actionId:a.id})).state,'approved')
 assert.equal((await f.actions.list(f.principal,{taskId:a.taskId})).length,1)
 assert.deepEqual((await db.pool.query('select event,count(*)::int n from teloa_security_action_audit where owner_id=$1 group by event order by event',[f.principal.ownerId])).rows,[{event:'decide',n:1},{event:'propose',n:1},{event:'submit',n:1}])
})

test('本人、SOC、HTTP来源、任务版本和固定资产边界均不可绕过',async()=>{
 const f=await fixture(db.pool)
 for(const input of [{...f.proposal,riskTier:'low'},{...f.proposal,playbookVersion:'fake'}])await assert.rejects(f.actions.propose(f.principal,input),{code:'teloa/invalid-input'})
 await assert.rejects(f.actions.propose({...f.principal,ownerId:'other'},f.proposal),{code:'teloa/forbidden'})
 await assert.rejects(f.actions.propose({...f.principal,scopeIds:['AppSec']},f.proposal),{code:'teloa/forbidden'})
 await assert.rejects(f.actions.propose(f.principal,{...f.proposal,expectedTaskVersion:2}),{code:'teloa/version-conflict'})
 await assert.rejects(f.actions.propose(f.principal,{...f.proposal,targetSet:['db-01']}),{code:'teloa/forbidden'})
 const other=await fixture(db.pool,'fixture-alert');await assert.rejects(other.actions.propose(other.principal,other.proposal),{code:'teloa/forbidden'})
 const scope=await fixture(db.pool,'security-alert-http','AppSec');await assert.rejects(scope.actions.propose(scope.principal,scope.proposal),{code:'teloa/forbidden'})
 await db.pool.query('update teloa_business_task_sources set snapshot_digest=$2 where task_id=$1',[f.task.id,'a'.repeat(64)])
 await assert.rejects(f.actions.propose(f.principal,f.proposal),{code:'teloa/storage-corrupt'})
 assert.equal((await db.pool.query('select count(*)::int n from teloa_security_requests where owner_id=$1',[f.principal.ownerId])).rows[0].n,0)
})

test('两个撤回入口保留六值；有执行意图拒绝撤回批准；接续只允许同任务终态',async()=>{
 const f=await fixture(db.pool),a=await f.actions.propose(f.principal,f.proposal)
 await assert.rejects(f.actions.withdrawSubmission(f.principal,command(a)),{code:'teloa/conflict'})
 await assert.rejects(f.actions.propose(f.principal,{...f.proposal,requestId:randomUUID(),supersedesActionId:a.id}),{code:'teloa/conflict'})
 const pending=await f.actions.submit(f.principal,command(a)),input=command(pending),withdrawn=await f.actions.withdrawSubmission(f.principal,input)
 assert.equal(withdrawn.state,'withdrawn');assert.deepEqual(withdrawn.frozen,pending.frozen);assert.deepEqual(await f.actions.withdrawSubmission(f.principal,input),withdrawn)
 const next=await f.actions.propose(f.principal,{...f.proposal,requestId:randomUUID(),supersedesActionId:a.id});assert.notEqual(next.id,a.id);assert.equal(next.supersedesActionId,a.id)
 const pendingNext=await f.actions.submit(f.principal,command(next));await f.approvals.decide(f.principal,decision(pendingNext))
 const approved=await f.actions.get(f.principal,{actionId:next.id}),withdraw=command(approved)
 f.execution.exists=true;await assert.rejects(f.actions.withdrawApproval(f.principal,withdraw),{code:'teloa/conflict'})
 f.execution.exists=false;const result=await f.actions.withdrawApproval(f.principal,withdraw);assert.equal(result.state,'withdrawn');assert.deepEqual(result.frozen,approved.frozen)
 assert.deepEqual(await f.actions.withdrawApproval(f.principal,withdraw),result)
})

test('失败确认独立保留失败事实，同请求重放只有一行',async()=>{
 const f=await fixture(db.pool),pending=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,f.proposal)))
 await assert.rejects(f.actions.acknowledgeFailure(f.principal,command(pending)),{code:'teloa/conflict'})
 await f.approvals.decide(f.principal,decision(pending))
 await db.pool.query("update teloa_security_actions set state='executing',version=version+1 where id=$1",[pending.id]);await db.pool.query("update teloa_security_actions set state='failed',version=version+1 where id=$1",[pending.id])
 const failed=await f.actions.get(f.principal,{actionId:pending.id}),input=command(failed),[a,b]=await Promise.all([f.actions.acknowledgeFailure(f.principal,input),f.actions.acknowledgeFailure(f.principal,input)])
 assert.deepEqual(a,failed);assert.deepEqual(a,b)
 assert.equal((await db.pool.query('select count(*)::int n from teloa_security_action_attention_acknowledgements where action_id=$1',[failed.id])).rows[0].n,1)
 await assert.rejects(f.actions.acknowledgeFailure(f.principal,command(failed)),{code:'teloa/conflict'})
 await db.pool.query('alter table teloa_security_action_attention_acknowledgements disable trigger teloa_security_acknowledgements_immutable')
 try{await db.pool.query("update teloa_security_action_attention_acknowledgements set result_snapshot=jsonb_set(result_snapshot,'{version}','99') where action_id=$1",[failed.id])}finally{await db.pool.query('alter table teloa_security_action_attention_acknowledgements enable trigger teloa_security_acknowledgements_immutable')}
 await assert.rejects(f.actions.acknowledgeFailure(f.principal,input),{code:'teloa/storage-corrupt'})
})

test('来源或声明变化拒绝提交；伪造的新低风险声明不能改写原动作',async()=>{
 const f=await fixture(db.pool),a=await f.actions.propose(f.principal,f.proposal)
 const downgraded=new SecurityActionService(db.pool,identity,{require:()=>({...definition,authorize:(...args)=>({...definition.authorize(...args),riskTier:'low'})})},f.journal,f.execution)
 await assert.rejects(downgraded.submit(f.principal,command(a)),{code:'teloa/version-conflict'})
 await db.pool.query("update teloa_business_object_snapshots set snapshot=jsonb_set(snapshot,'{summary}','\"被改写\"') where owner_id=$1",[f.principal.ownerId])
 await assert.rejects(f.actions.submit(f.principal,command(a)),{code:'teloa/storage-corrupt'})
 assert.equal((await f.actions.get(f.principal,{actionId:a.id})).state,'proposed')
})

test('目录收到严格读取并携带真实 snapshotHash 的完整固定快照',async()=>{
 const f=await fixture(db.pool)
 const complete=new SecurityActionService(db.pool,identity,{require:()=>({...definition,authorize:(snapshot,targets,params)=>{
  assert.equal(snapshot.snapshotHash,f.snapshot.snapshotHash)
  return definition.authorize(snapshot,targets,params)
 }})},f.journal,f.execution)
 const action=await complete.propose(f.principal,f.proposal)
 assert.equal((await complete.submit(f.principal,command(action))).frozen?.objectSnapshotHash,f.snapshot.snapshotHash)
})

test('跨 execute/observe 命令重用 propose requestId 统一冲突；未知结果重建服务重放',async()=>{
 const f=await fixture(db.pool),a=await f.actions.propose(f.principal,f.proposal)
 for(const name of ['execute','observe'] as const)await assert.rejects(f.journal.transaction(client=>f.journal.reserve(client,f.principal.ownerId,f.proposal.requestId,name,{command:name,actionId:a.id},identity.now())),{code:'teloa/conflict'})
 const fresh=new SecurityActionService(db.pool,identity,{require:()=>definition},f.journal,f.execution)
 assert.deepEqual(await fresh.propose(f.principal,f.proposal),a)
 const other=await fixture(db.pool)
 await assert.rejects(other.actions.get(other.principal,{actionId:a.id}),{code:'teloa/forbidden'})
 await assert.rejects(other.actions.list(other.principal,{taskId:a.taskId}),{code:'teloa/forbidden'})
})

test('审计写失败完整回滚；同请求异内容与损坏历史结果显式拒绝',async()=>{
 const f=await fixture(db.pool)
 await db.pool.query(`create function fail_security_audit_test() returns trigger language plpgsql as $$ begin raise exception 'audit failed'; end $$;create trigger fail_security_audit_test before insert on teloa_security_action_audit for each row execute function fail_security_audit_test()`)
 try{await assert.rejects(f.actions.propose(f.principal,f.proposal),/audit failed/)}finally{await db.pool.query('drop trigger fail_security_audit_test on teloa_security_action_audit;drop function fail_security_audit_test()')}
 assert.equal((await db.pool.query('select count(*)::int n from teloa_security_requests where owner_id=$1',[f.principal.ownerId])).rows[0].n,0)
 assert.equal((await db.pool.query('select count(*)::int n from teloa_security_actions where owner_id=$1',[f.principal.ownerId])).rows[0].n,0)
 await f.actions.propose(f.principal,f.proposal)
 await assert.rejects(f.actions.propose(f.principal,{...f.proposal,goal:'不同目标'}),{code:'teloa/conflict'})
 await db.pool.query("update teloa_security_action_requests set result_snapshot=jsonb_set(result_snapshot,'{version}','99') where owner_id=$1",[f.principal.ownerId])
 await assert.rejects(f.actions.propose(f.principal,f.proposal),{code:'teloa/storage-corrupt'})
})

test('submit 重放拒绝被改成 approved 的历史状态，保留真实 pending 快照',async()=>{
 const f=await fixture(db.pool),a=await f.actions.propose(f.principal,f.proposal),input=command(a),pending=await f.actions.submit(f.principal,input)
 await f.approvals.decide(f.principal,decision(pending))
 assert.deepEqual(await f.actions.submit(f.principal,input),pending)
 await db.pool.query("update teloa_security_action_requests set result_snapshot=jsonb_set(result_snapshot,'{state}','\"approved\"') where owner_id=$1 and request_id=$2",[f.principal.ownerId,input.requestId])
 await assert.rejects(f.actions.submit(f.principal,input),{code:'teloa/storage-corrupt'})
})

test('动作重放拒绝同 owner 同任务另一动作的完整快照与绑定替换',async()=>{
 const f=await fixture(db.pool),a=await f.actions.propose(f.principal,f.proposal),b=await f.actions.propose(f.principal,{...f.proposal,requestId:randomUUID()}),input=command(a),pending=await f.actions.submit(f.principal,input),other=await f.actions.submit(f.principal,command(b))
 await db.pool.query('update teloa_security_action_requests set result_action_id=$3,result_action_version=$4,result_snapshot=$5 where owner_id=$1 and request_id=$2',[f.principal.ownerId,input.requestId,other.id,other.version,JSON.stringify(other)])
 await db.pool.query('update teloa_security_action_requests set result_action_id=$3,result_action_version=$4,result_snapshot=$5 where owner_id=$1 and request_id=$2',[f.principal.ownerId,f.proposal.requestId,b.id,b.version,JSON.stringify(b)])
 const results=await Promise.allSettled([f.actions.submit(f.principal,input),f.actions.propose(f.principal,f.proposal)])
 assert.deepEqual(results.map(result=>result.status==='rejected'?result.reason.code:'fulfilled'),['teloa/storage-corrupt','teloa/storage-corrupt'])
 assert.equal(pending.id,a.id)
})

test('历史动作定义与冻结摘要必须等于权威动作，不能仅保持合法形状',async()=>{
 const f=await fixture(db.pool),a=await f.actions.propose(f.principal,f.proposal),input=command(a),pending=await f.actions.submit(f.principal,input)
 const results=[]
 for(const snapshot of [{...pending,riskTier:'low'},{...pending,frozen:{...pending.frozen,paramFingerprint:'sha256:'+'b'.repeat(64)}},{...pending,updatedAt:'2026-09-13T02:00:00.000Z'}]){
  await db.pool.query('update teloa_security_action_requests set result_snapshot=$3 where owner_id=$1 and request_id=$2',[f.principal.ownerId,input.requestId,JSON.stringify(snapshot)])
  results.push(...await Promise.allSettled([f.actions.submit(f.principal,input)]))
 }
 assert.deepEqual(results.map(result=>result.status==='rejected'?result.reason.code:'fulfilled'),['teloa/storage-corrupt','teloa/storage-corrupt','teloa/storage-corrupt'])
})
