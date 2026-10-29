import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import type {WorkBudgetPolicy} from '@teloa/contract'
import {setupRoleWork,roleFixture,identity,ownerAuthority} from './role-work-test-fixture.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'
import {WorkBudgetService,initializeWorkBudgets,defaultWorkBudgetPolicy} from '../src/work/work-budget.ts'

let env:Awaited<ReturnType<typeof setupRoleWork>>
const finite={maxTokens:100,maxGoalRounds:10,maxConcurrent:4,maxElapsedMs:100_000,maxRetries:3,stagnationRounds:3,money:null}
const unlimited={...finite,maxTokens:null,maxGoalRounds:null,maxConcurrent:null,maxElapsedMs:null}
before(async()=>{env=await setupRoleWork();await initializeWorkBudgets(env.pool)})
after(async()=>{await env?.close()})
async function fixture(){
 const f=await roleFixture(env.pool,'employee'),client=await env.pool.connect();let lineage
 try{await client.query('begin');lineage=await new WorkLineageService(env.pool,identity).bindTask(client,f.owner,{taskId:f.taskId,source:{kind:'owner-task',taskId:f.taskId}});await client.query('commit')}finally{client.release()}
 const budgets=new WorkBudgetService(env.pool,identity,ownerAuthority),account=lineage.budgetAccountId
 await budgets.configure(f.owner,{requestId:randomUUID(),budgetAccountId:account,expectedVersion:1,policy:finite})
 await budgets.configureOwner(f.owner,{requestId:randomUUID(),expectedVersion:1,policy:finite})
 const reserve=(tokens=20,rounds=0)=>budgets.reserve(f.owner,{budgetAccountId:account,controlGeneration:1,modelRequestId:randomUUID(),kind:'goal',tokens,rounds})
 const configure=async(target:'work'|'owner',policy:WorkBudgetPolicy)=>target==='work'?budgets.configure(f.owner,{requestId:randomUUID(),budgetAccountId:account,expectedVersion:(await budgets.read(f.owner,{budgetAccountId:account})).version,policy}):budgets.configureOwner(f.owner,{requestId:randomUUID(),expectedVersion:(await budgets.readOwner(f.owner)).version,policy})
 return {...f,account,budgets,reserve,configure}
}

test('本人和工作资源放宽/不限/no-op保留活动许可及预留，后续准入使用新策略而有限另一层仍约束',async()=>{
 const f=await fixture(),reservation=await f.reserve(),lease=f.budgets.lease(f.owner,reservation)
 await f.budgets.markDispatched(f.owner,{reservationId:reservation.id})
 await f.configure('work',{...unlimited,maxRetries:4,stagnationRounds:4});lease.assertCurrent()
 await assert.rejects(f.reserve(101),{code:'teloa/budget-exhausted',details:{reason:'tokens',scope:'owner'}})
 await f.configure('owner',{...unlimited,maxRetries:4,stagnationRounds:4});lease.assertCurrent()
 for(const target of ['work','owner'] as const){await f.configure(target,{...unlimited,maxRetries:4,stagnationRounds:4});lease.assertCurrent()}
 // 超过原token、轮次、并发和耗时上限；仅测试自己的隔离记录。
 await env.pool.query("update teloa_work_budget_reservations set created_at=now()-interval '10 minutes' where id=$1",[reservation.id])
 const more=[];for(let index=0;index<5;index++)more.push(await f.reserve(500,100))
 assert.equal((await f.budgets.read(f.owner,{budgetAccountId:f.account})).usedTokens,2520)
 assert.equal((await f.budgets.readOwner(f.owner)).usedRounds,500)
 assert.equal((await f.budgets.readOwner(f.owner)).concurrent,6)
 await f.budgets.admitRunStart(f.owner,f.account)
 lease.assertCurrent()
 assert.equal((await env.pool.query('select reserved_tokens,state,actual_tokens from teloa_work_budget_reservations where id=$1',[reservation.id])).rows[0].reserved_tokens,20)
 for(const r of more)await f.budgets.releaseUnaccepted(f.owner,{reservationId:r.id})
 // 工作不限不改变独立的本人上限；将本人恢复有限属于收紧，旧许可立即失效。
 await f.configure('owner',finite);assert.throws(lease.assertCurrent,{code:'teloa/budget-exhausted'})
 assert.deepEqual((await f.budgets.read(f.owner,{budgetAccountId:f.account})).policy,{...unlimited,maxRetries:4,stagnationRounds:4})
})

test('任何资源或停止保护降额、混合降额和不限转有限均撤销旧许可；后续提额不能复活旧许可',async()=>{
 const keys=['maxTokens','maxGoalRounds','maxConcurrent','maxElapsedMs','maxRetries','stagnationRounds'] as const
 for(const target of ['work','owner'] as const)for(const key of keys){
  const f=await fixture(),r=await f.reserve(),lease=f.budgets.lease(f.owner,r)
  await f.configure(target,{...finite,maxTokens:1000,[key]:finite[key]-1})
  assert.throws(lease.assertCurrent,{code:'teloa/budget-exhausted'},target+'/'+key)
  await f.configure(target,{...unlimited,maxRetries:4,stagnationRounds:4})
  assert.throws(lease.assertCurrent,{code:'teloa/budget-exhausted'},'放宽不能恢复先前已撤销的许可')
 }
 for(const target of ['work','owner'] as const)for(const key of ['maxTokens','maxGoalRounds','maxConcurrent','maxElapsedMs'] as const){
  const f=await fixture();await f.configure(target,unlimited)
  const r=await f.reserve(),lease=f.budgets.lease(f.owner,r)
  await f.configure(target,{...unlimited,[key]:finite[key]})
  assert.throws(lease.assertCurrent,{code:'teloa/budget-exhausted'},'null→finite '+target+'/'+key)
 }
})

test('提额并发CAS/同请求幂等不重置用量；缺本人确认拒绝；超出预留的真实结算仍撤销同工作许可',async()=>{
 const f=await fixture(),r=await f.reserve(),lease=f.budgets.lease(f.owner,r),current=await f.budgets.read(f.owner,{budgetAccountId:f.account})
 const requests=[600,700].map(maxTokens=>({requestId:randomUUID(),budgetAccountId:f.account,expectedVersion:current.version,policy:{...finite,maxTokens}}))
 const results=await Promise.allSettled(requests.map(request=>f.budgets.configure(f.owner,request))),index=results.findIndex(result=>result.status==='fulfilled')
 assert.ok(index>=0);assert.equal(results.filter(result=>result.status==='fulfilled').length,1)
 assert.equal((results.find(result=>result.status==='rejected') as PromiseRejectedResult).reason.code,'teloa/version-conflict')
 const result=results[index] as PromiseFulfilledResult<Awaited<ReturnType<WorkBudgetService['configure']>>>
 assert.deepEqual(await f.budgets.configure(f.owner,requests[index]!),result.value);lease.assertCurrent()
 await assert.rejects(f.budgets.configure(f.owner,{...requests[index]!,policy:unlimited}),{code:'teloa/conflict'})
 assert.equal((await f.budgets.read(f.owner,{budgetAccountId:f.account})).usedTokens,20)
 await assert.rejects(new WorkBudgetService(env.pool,identity).configure(f.owner,{requestId:randomUUID(),budgetAccountId:f.account,expectedVersion:result.value.version,policy:unlimited}),{code:'teloa/forbidden'})
 lease.assertCurrent()
 await f.configure('work',unlimited);await f.configure('owner',unlimited);lease.assertCurrent()
 const peer=await f.reserve(),peerLease=f.budgets.lease(f.owner,peer)
 await f.budgets.markDispatched(f.owner,{reservationId:r.id})
 await f.budgets.settle(f.owner,{reservationId:r.id,modelRequestId:r.modelRequestId,providerRequestId:null,tokens:21,moneyMinorUnits:null,currency:null,receiptId:randomUUID()})
 assert.throws(peerLease.assertCurrent,{code:'teloa/budget-exhausted'},'不限资源不取消超预留结算保护')
 assert.equal((await f.budgets.read(f.owner,{budgetAccountId:f.account})).usedTokens,41)
 assert.equal(defaultWorkBudgetPolicy.maxTokens,2_000_000)
})
