import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,fixture,command,decision,catalog} from './security-action-fixture.ts'
import {SecurityApprovalService,initializeSecurityApprovals} from '../src/security/approvals.ts'
import {SecurityRequestJournal} from '../src/security/request-journal.ts'
import {securityParamFingerprint} from '../src/security/action-authorization.ts'
import {securityApprovalTtlMinutes} from '@teloa/contract'
let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database()},{timeout:60000});after(async()=>{await db?.close()})

// 固定时钟的审批服务：fixture 的 now 是 2026-09-13T01:00:00.000Z，这里造一个"晚 N 分钟"的同构服务，
// 用来把"过期"这件事变成可断言的事实，而不是靠 sleep。
const at=(minutes:number)=>new SecurityApprovalService(db.pool,{id:randomUUID,now:()=>new Date(Date.parse('2026-09-13T01:00:00.000Z')+minutes*60_000).toISOString()},catalog,new SecurityRequestJournal(db.pool))

test('批准保存提交基线，并发同请求重放历史审批；不同请求只允许一个决定',async()=>{
 const f=await fixture(db.pool),pending=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,f.proposal))),input=decision(pending)
 const [a,b]=await Promise.all([f.approvals.decide(f.principal,input),f.approvals.decide(f.principal,input)])
 assert.deepEqual(a,b);assert.deepEqual(a.frozen,pending.frozen);assert.equal(a.actionVersion,pending.version);assert.equal(a.approverId,f.principal.approverId)
 assert.equal((await db.pool.query('select count(*)::int n from teloa_security_approvals where action_id=$1',[pending.id])).rows[0].n,1)
 await assert.rejects(f.approvals.decide(f.principal,{...input,requestId:randomUUID()}),{code:'teloa/version-conflict'})
 const g=await fixture(db.pool),p=await g.actions.submit(g.principal,command(await g.actions.propose(g.principal,g.proposal)))
 const race=await Promise.allSettled([g.approvals.decide(g.principal,decision(p)),g.approvals.decide(g.principal,decision(p))])
 assert.equal(race.filter(x=>x.status==='fulfilled').length,1);assert.equal((await db.pool.query('select count(*)::int n from teloa_security_approvals where action_id=$1',[p.id])).rows[0].n,1)
})

test('任务定义变更拒绝批准；仅状态与版本推进不改变定义摘要',async()=>{
 const f=await fixture(db.pool),pending=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,f.proposal)))
 await f.tasks.edit(f.principal.ownerId,{taskId:f.task.id,expectedVersion:f.task.version,fields:{title:f.task.title,goal:'变化后的调查目标'}})
 await assert.rejects(f.approvals.decide(f.principal,decision(pending)),{code:'teloa/version-conflict'})
 const g=await fixture(db.pool),p=await g.actions.submit(g.principal,command(await g.actions.propose(g.principal,g.proposal)))
 await db.pool.query("update teloa_tasks set state='running',version=version+1 where id=$1",[g.task.id])
 assert.equal((await g.approvals.decide(g.principal,decision(p))).decision,'approved')
})

test('影响确认、理由、跨本人/范围及跨 endpoint 请求必须过闸，拒绝保留原基线',async()=>{
 const f=await fixture(db.pool),pending=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,f.proposal)))
 await assert.rejects(f.approvals.decide(f.principal,{...decision(pending),impactConfirmed:false}),{code:'teloa/forbidden'})
 await assert.rejects(f.approvals.decide(f.principal,{...decision(pending),reason:''}),{code:'teloa/invalid-input'})
 await assert.rejects(f.approvals.decide({...f.principal,ownerId:'other'},decision(pending)),{code:'teloa/forbidden'})
 await assert.rejects(f.approvals.decide({...f.principal,scopeIds:['AppSec']},decision(pending)),{code:'teloa/forbidden'})
 await assert.rejects(f.approvals.decide(f.principal,{...decision(pending),requestId:f.proposal.requestId}),{code:'teloa/conflict'})
 const input={...decision(pending),decision:'rejected',impactConfirmed:false},approval=await f.approvals.decide(f.principal,input)
 assert.equal(approval.decision,'rejected');assert.deepEqual(approval.frozen,pending.frozen);assert.equal((await f.actions.get(f.principal,{actionId:pending.id})).state,'rejected')
 assert.deepEqual(await f.approvals.decide(f.principal,input),approval)
})

test('readForExecution 同事务持有 Action/Task/source/object 锁并重算批准',async()=>{
 const f=await fixture(db.pool),pending=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,f.proposal))),approval=await f.approvals.decide(f.principal,decision(pending)),approved=await f.actions.get(f.principal,{actionId:pending.id})
 const client=await db.pool.connect(),other=await db.pool.connect()
 try{
  await client.query('begin');const result=await f.approvals.readForExecution(client,f.principal,{actionId:approved.id,expectedActionVersion:approved.version})
  assert.deepEqual(result,{action:approved,approval})
  for(const sql of ['select 1 from teloa_security_actions where id=$1 for update nowait','select 1 from teloa_tasks where id=$1 for update nowait','select 1 from teloa_business_task_sources where task_id=$1 for update nowait'])await assert.rejects(other.query(sql,[sql.includes('security_actions')?approved.id:f.task.id]),{code:'55P03'})
  await assert.rejects(other.query('select 1 from teloa_business_object_snapshots where owner_id=$1 for update nowait',[f.principal.ownerId]),{code:'55P03'})
  await client.query('commit')
 }finally{await client.query('rollback');client.release();other.release()}
 await f.tasks.edit(f.principal.ownerId,{taskId:f.task.id,expectedVersion:f.task.version,fields:{title:f.task.title,goal:'变更目标'}})
 const c=await db.pool.connect();try{await c.query('begin');await assert.rejects(f.approvals.readForExecution(c,f.principal,{actionId:approved.id,expectedActionVersion:approved.version}),{code:'teloa/version-conflict'})}finally{await c.query('rollback');c.release()}
})

test('审批重放核对权威 append-only Approval，拒绝被替换的冻结值',async()=>{
 const f=await fixture(db.pool),pending=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,f.proposal))),input=decision(pending),approval=await f.approvals.decide(f.principal,input)
 const approved=await f.actions.get(f.principal,{actionId:pending.id})
 await f.actions.withdrawApproval(f.principal,command(approved))
 assert.deepEqual(await f.approvals.decide(f.principal,input),approval)
 await db.pool.query('alter table teloa_security_approval_requests disable trigger teloa_security_approval_requests_immutable')
 try{await db.pool.query('update teloa_security_approval_requests set result_snapshot=$3 where owner_id=$1 and request_id=$2',[f.principal.ownerId,input.requestId,JSON.stringify({...approval,frozen:{...approval.frozen,paramFingerprint:'sha256:'+'b'.repeat(64)}})])}finally{await db.pool.query('alter table teloa_security_approval_requests enable trigger teloa_security_approval_requests_immutable')}
 await assert.rejects(f.approvals.decide(f.principal,input),{code:'teloa/storage-corrupt'})
})

test('批准按风险等级一次写定有效期，唯一剧本高风险十五分钟',async()=>{
 const f=await fixture(db.pool),pending=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,f.proposal)))
 assert.equal(pending.riskTier,'high')
 const approval=await f.approvals.decide(f.principal,decision(pending))
 const row=(await db.pool.query('select created_at,expires_at from teloa_security_approvals where id=$1',[approval.id])).rows[0]
 assert.equal(row.expires_at.getTime()-row.created_at.getTime(),securityApprovalTtlMinutes.high*60_000)
})

test('有效期内派发照常；过期后派发被拒且动作仍停在已批准',async()=>{
 const f=await fixture(db.pool),pending=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,f.proposal)))
 const approved=await f.actions.get(f.principal,{actionId:(await f.approvals.decide(f.principal,decision(pending))).actionId})
 const input={actionId:approved.id,expectedActionVersion:approved.version}
 const inside=await db.pool.connect()
 try{await inside.query('begin');await at(14).readForExecution(inside,f.principal,input);await inside.query('rollback')}finally{inside.release()}
 const outside=await db.pool.connect()
 try{
  await outside.query('begin')
  await assert.rejects(at(16).readForExecution(outside,f.principal,input),{code:'teloa/conflict'})
  await outside.query('rollback')
 }finally{outside.release()}
 assert.equal((await f.actions.get(f.principal,{actionId:approved.id})).state,'approved')
})

test('拒绝记录同样写定有效期，且不影响任何派发判定',async()=>{
 const f=await fixture(db.pool),pending=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,f.proposal)))
 const approval=await f.approvals.decide(f.principal,{...decision(pending),decision:'rejected',impactConfirmed:false})
 const row=(await db.pool.query('select expires_at from teloa_security_approvals where id=$1',[approval.id])).rows[0]
 assert.ok(row.expires_at instanceof Date)
})

test('存量批准在升级后按各自风险等级补上有效期，记录摘要逐行不变，不可修改触发器仍生效',async()=>{
 const f=await fixture(db.pool),pending=await f.actions.submit(f.principal,command(await f.actions.propose(f.principal,f.proposal)))
 const approval=await f.approvals.decide(f.principal,decision(pending))
 // 造出"升级前"的那一行：把列摘掉，等于回到没有 expires_at 的旧结构。
 await db.pool.query('alter table teloa_security_approvals drop column expires_at')
 await initializeSecurityApprovals(db.pool)
 const row=(await db.pool.query('select created_at,expires_at,record_digest from teloa_security_approvals where id=$1',[approval.id])).rows[0]
 assert.equal(row.expires_at.getTime()-row.created_at.getTime(),securityApprovalTtlMinutes.high*60_000)
 assert.equal(row.record_digest,securityParamFingerprint(approval))
 await assert.rejects(db.pool.query('update teloa_security_approvals set reason=$2 where id=$1',[approval.id,'改过了']),/不可修改/)
 // 第二次初始化没有空值行可回填，就不该再摘一次触发器。触发器 OID 是最直接的证据：
 // drop + create 会换一个身份，走到这里的 create or replace 则原地改写、身份不变。
 const oid=async()=>(await db.pool.query("select oid from pg_trigger where tgname='teloa_security_approvals_immutable' and tgrelid='teloa_security_approvals'::regclass")).rows[0].oid
 const before=await oid()
 await initializeSecurityApprovals(db.pool)
 assert.equal(await oid(),before,'没有待回填的行时，迁移段一次触发器都不动')
})
