import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setupRoleWork,roleFixture,identity,ownerAuthority} from './role-work-test-fixture.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'

test('同一职责并行预留共享上限，未知消耗不释放，重放回执不双计',{timeout:60000},async t=>{
 const env=await setupRoleWork();t.after(env.close)
 let module:Record<string,any>={};try{module=await import('../src/work/work-budget.ts')}catch(e){if((e as NodeJS.ErrnoException).code!=='ERR_MODULE_NOT_FOUND')throw e}
 assert.equal(typeof module.WorkBudgetService,'function','必须有真实持久预算服务')
 await module.initializeWorkBudgets(env.pool)
 const f=await roleFixture(env.pool,'employee'),db=await env.pool.connect()
 let lineage
 try{await db.query('begin');lineage=await new WorkLineageService(env.pool,identity).bindTask(db,f.owner,{taskId:f.taskId,source:{kind:'owner-task',taskId:f.taskId}});await db.query('commit')}finally{db.release()}
 const service=new module.WorkBudgetService(env.pool,identity,ownerAuthority)
 await service.configure(f.owner,{requestId:randomUUID(),budgetAccountId:lineage.budgetAccountId,expectedVersion:1,policy:{maxGoalRounds:3,maxTokens:100,maxElapsedMs:60000,maxConcurrent:2,maxRetries:2,stagnationRounds:2,money:null}})
 const base={budgetAccountId:lineage.budgetAccountId,controlGeneration:1,kind:'goal',tokens:60,rounds:0}
 const requests=await Promise.allSettled([service.reserve(f.owner,{...base,modelRequestId:randomUUID()}),service.reserve(f.owner,{...base,modelRequestId:randomUUID()})])
 assert.equal(requests.filter(r=>r.status==='fulfilled').length,1)
 const reservation=(requests.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value
 const originalLease=service.lease(f.owner,reservation);originalLease.assertCurrent()
 const again=await service.reserve(f.owner,{...base,modelRequestId:reservation.modelRequestId});assert.equal(again.id,reservation.id)
 await service.markDispatched(f.owner,{reservationId:reservation.id})
 await assert.rejects(service.releaseUnaccepted(f.owner,{reservationId:reservation.id}),{code:'teloa/conflict'})
 const receipt={reservationId:reservation.id,modelRequestId:reservation.modelRequestId,providerRequestId:null,tokens:20,moneyMinorUnits:null,currency:null,receiptId:randomUUID()}
 assert.equal((await service.settle(f.owner,receipt)).state,'settled')
 assert.throws(()=>originalLease.assertCurrent(),{code:'teloa/conflict'})
 assert.deepEqual(await service.settle(f.owner,receipt),await service.settle(f.owner,receipt))
 const next=await service.reserve(f.owner,{...base,modelRequestId:randomUUID(),tokens:70}),releasedLease=service.lease(f.owner,next);await service.releaseUnaccepted(f.owner,{reservationId:next.id})
 const replacement=await service.reserve(f.owner,{...base,modelRequestId:randomUUID(),tokens:70})
 assert.throws(()=>releasedLease.assertCurrent(),{code:'teloa/conflict'})
 assert.throws(()=>service.lease(f.owner,next),{code:'teloa/conflict'})
 await service.releaseUnaccepted(f.owner,{reservationId:replacement.id})
 const uncertain=await service.reserve(f.owner,{...base,modelRequestId:randomUUID(),tokens:60});await service.markDispatched(f.owner,{reservationId:uncertain.id})
 const uncertainReceipt={reservationId:uncertain.id,modelRequestId:uncertain.modelRequestId,provider:'provider-a',providerRequestId:'physical-operation-1',tokens:null,moneyMinorUnits:null,currency:null,receiptId:randomUUID()}
 assert.equal((await service.settle(f.owner,uncertainReceipt)).state,'unknown')
 assert.equal((await service.settle(f.owner,{...uncertainReceipt,tokens:20})).state,'settled')
 await assert.rejects(service.settle(f.owner,{...uncertainReceipt,tokens:10}),{code:'teloa/conflict'})
 const duplicate=await service.reserve(f.owner,{...base,modelRequestId:randomUUID(),tokens:10})
 await assert.rejects(service.settle(f.owner,{...uncertainReceipt,reservationId:duplicate.id,modelRequestId:duplicate.modelRequestId,tokens:10,receiptId:randomUUID()}),{code:'teloa/conflict'})
 assert.equal((await service.settle(f.owner,{...uncertainReceipt,provider:'provider-b',reservationId:duplicate.id,modelRequestId:duplicate.modelRequestId,tokens:10,receiptId:randomUUID()})).state,'settled')
 assert.equal((await service.read(f.owner,{budgetAccountId:lineage.budgetAccountId})).usedTokens,50)
 const ownerPolicy=(await service.readOwner(f.owner)).policy
 const configured=await service.configureOwner(f.owner,{requestId:randomUUID(),expectedVersion:1,policy:{...ownerPolicy,maxGoalRounds:64,maxElapsedMs:43200000,maxTokens:16000000,maxConcurrent:16}})
 assert.equal(configured.version,2);assert.equal((await service.readOwner(f.owner)).policy.maxGoalRounds,64)
 // 本人群路由只服从界面可配置的本人总额，不额外卡在隐藏的职责默认值。
 const routing=await service.reserveOwnerRouting(f.owner,{modelRequestId:randomUUID(),tokens:2_000_001})
 assert.equal((await service.readOwner(f.owner)).usedTokens,2_000_051)
 await service.releaseUnaccepted(f.owner,{reservationId:routing.id})
 // 同一累计账户保留旧长期定义；新 round 的当前祖先决定准入，旧 ended 定义不能误封新工作。
 await env.pool.query("insert into teloa_work_controls(id,owner_id,kind,root_task_id,budget_account_id,state,generation,created_at,updated_at) values($1,$2,'definition',null,$3,'ended',2,now(),now())",[randomUUID(),f.owner,lineage.budgetAccountId])
 const afterDefinitionChange=await service.reserve(f.owner,{...base,modelRequestId:randomUUID(),tokens:1})
 assert.equal(afterDefinitionChange.state,'reserved');assert.equal((await service.read(f.owner,{budgetAccountId:lineage.budgetAccountId})).usedTokens,51)
 await service.releaseUnaccepted(f.owner,{reservationId:afterDefinitionChange.id})
 await assert.rejects(service.read('another-owner',{budgetAccountId:lineage.budgetAccountId}),{code:'teloa/forbidden'})
})
