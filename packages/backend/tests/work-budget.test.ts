import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setupRoleWork,roleFixture,insertRoleRun,identity,ownerAuthority} from './role-work-test-fixture.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'
import type {RunBudgetTerminal} from '../src/work/work-budget.ts'

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
 assert.throws(()=>originalLease.assertCurrent(),{code:'teloa/budget-exhausted'})
 assert.deepEqual(await service.settle(f.owner,receipt),await service.settle(f.owner,receipt))
 const next=await service.reserve(f.owner,{...base,modelRequestId:randomUUID(),tokens:70}),releasedLease=service.lease(f.owner,next);await service.releaseUnaccepted(f.owner,{reservationId:next.id})
 const replacement=await service.reserve(f.owner,{...base,modelRequestId:randomUUID(),tokens:70})
 assert.throws(()=>releasedLease.assertCurrent(),{code:'teloa/budget-exhausted'})
 assert.throws(()=>service.lease(f.owner,next),{code:'teloa/budget-exhausted'})
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

test('同Run已封口的未知模型预留保留未知token，核验终态后释放活动并发',{timeout:60000},async t=>{
 const env=await setupRoleWork();t.after(env.close)
 const {WorkBudgetService,initializeWorkBudgets}=await import('../src/work/work-budget.ts'),{initializeWorkRetries}=await import('../src/work/work-retries.ts')
 await initializeWorkBudgets(env.pool);await initializeWorkRetries(env.pool)
 const f=await roleFixture(env.pool,'employee'),db=await env.pool.connect();let lineage
 try{await db.query('begin');lineage=await new WorkLineageService(env.pool,identity).bindTask(db,f.owner,{taskId:f.taskId,source:{kind:'owner-task',taskId:f.taskId}});await db.query('commit')}finally{db.release()}
 const service=new WorkBudgetService(env.pool,identity,ownerAuthority)
 await service.configure(f.owner,{requestId:randomUUID(),budgetAccountId:lineage.budgetAccountId,expectedVersion:1,policy:{maxGoalRounds:32,maxTokens:501,maxElapsedMs:21600000,maxConcurrent:1,maxRetries:3,stagnationRounds:3,money:null}})
 const r=await service.reserve(f.owner,{budgetAccountId:lineage.budgetAccountId,controlGeneration:1,kind:'retry',tokens:500,rounds:0,modelRequestId:'retry:terminal-proof'}),runId=await insertRoleRun(env.pool,f.owner,f.role.id,f.taskId,'ended')
 await service.markDispatched(f.owner,{reservationId:r.id})
 const next={budgetAccountId:lineage.budgetAccountId,controlGeneration:1,kind:'retry' as const,tokens:1,rounds:0,modelRequestId:'retry:after-terminal'}
 await assert.rejects(service.reserve(f.owner,next),{code:'teloa/budget-exhausted',details:{reason:'concurrent',scope:'work'}})
 const startedAt=new Date(Date.now()-7*3600000).toISOString(),endedAt=new Date(Date.parse(startedAt)+45000).toISOString(),operationId='model:terminal-proof'
 await env.pool.query('update teloa_task_runs set created_at=$2 where id=$1',[runId,startedAt])
 await env.pool.query('update teloa_work_budget_reservations set created_at=$2 where id=$1',[r.id,startedAt])
 await env.pool.query("insert into teloa_work_retries(owner_id,operation_id,run_id,budget_account_id,attempts,max_attempts,state,completed,last_reason,created_at,updated_at) values($1,$2,$3,$4,1,3,'unknown',false,'等待原受理回执',$5,$5)",[f.owner,operationId,runId,lineage.budgetAccountId,startedAt])
 await env.pool.query("insert into teloa_work_retry_claims(owner_id,request_id,operation_id,attempt,model_request_id,spec) values($1,$2,$3,1,$4,'{}')",[f.owner,randomUUID(),operationId,r.modelRequestId])
 const run=(await env.pool.query('select session_id,native_request_id,evidence from teloa_task_runs where id=$1',[runId])).rows[0],proof:RunBudgetTerminal={schema:'teloa.work-budget-terminal/v1',runId,sessionId:run.session_id,nativeRequestId:run.native_request_id,turn:0,messageSeq:1,endSeq:2,turnEndSeq:2,terminalKind:'turn/end',endedAt}
 const admission=async()=>{const c=await env.pool.connect();try{await c.query('begin');await service.admissionInTransaction(c,f.owner,lineage.budgetAccountId)}finally{await c.query('rollback');c.release()}}
 await assert.rejects(admission,{code:'teloa/budget-exhausted',details:{reason:'elapsed',scope:'work'}},'缺少终态补核的旧预留已把墙钟累计到七小时')
 assert.deepEqual(await service.recordRunTerminal(f.owner,proof),{closed:1})
 await assert.doesNotReject(admission,'原Run已结束后闲置时长不能继续耗尽额度')
 const saved=(await env.pool.query('select state,reserved_tokens,actual_tokens,settled_at,elapsed_ended_at,elapsed_terminal from teloa_work_budget_reservations where id=$1',[r.id])).rows[0]
 assert.equal(saved.state,'unknown');assert.equal(saved.reserved_tokens,500);assert.equal(saved.actual_tokens,null);assert.equal(saved.settled_at,null);assert.equal(saved.elapsed_ended_at.toISOString(),endedAt);assert.deepEqual(saved.elapsed_terminal,proof)
 assert.equal((await service.read(f.owner,{budgetAccountId:lineage.budgetAccountId})).concurrent,0,'已核实结束的未知消耗保留 token 预留，但不再占用活动并发');assert.equal((await service.read(f.owner,{budgetAccountId:lineage.budgetAccountId})).usedTokens,500)
 const afterTerminal=await service.reserve(f.owner,next);await service.releaseUnaccepted(f.owner,{reservationId:afterTerminal.id})
 await assert.rejects(service.reserve(f.owner,{...next,modelRequestId:'retry:over-unknown-budget',tokens:2}),{code:'teloa/budget-exhausted',details:{reason:'tokens',scope:'work'}})
 for(const bad of [{...proof,nativeRequestId:randomUUID()},{...proof,endSeq:3},{...proof,endedAt:new Date(Date.now()+60000).toISOString()}])await assert.rejects(service.recordRunTerminal(f.owner,bad))
 assert.deepEqual(await service.recordRunTerminal(f.owner,proof),{closed:0})
 await service.settle(f.owner,{reservationId:r.id,modelRequestId:r.modelRequestId,providerRequestId:null,tokens:null,moneyMinorUnits:null,currency:null,receiptId:randomUUID()})
 assert.equal((await env.pool.query('select elapsed_ended_at from teloa_work_budget_reservations where id=$1',[r.id])).rows[0].elapsed_ended_at.toISOString(),endedAt,'迟到用量回执也不延长已知耗时')
 await service.configure(f.owner,{requestId:randomUUID(),budgetAccountId:lineage.budgetAccountId,expectedVersion:2,policy:{maxGoalRounds:32,maxTokens:502,maxElapsedMs:21600000,maxConcurrent:1,maxRetries:3,stagnationRounds:3,money:null}})
 const timeout=await service.reserve(f.owner,{...next,modelRequestId:'retry:timeout-finally'})
 await service.markDispatched(f.owner,{reservationId:timeout.id})
 await env.pool.query('update teloa_work_budget_reservations set created_at=$2 where id=$1',[timeout.id,startedAt])
 await service.settle(f.owner,{reservationId:timeout.id,modelRequestId:timeout.modelRequestId,providerRequestId:null,tokens:null,moneyMinorUnits:null,currency:null,receiptId:randomUUID()})
 assert.equal((await service.read(f.owner,{budgetAccountId:lineage.budgetAccountId})).concurrent,1,'超时 finally 写了 elapsed_ended_at 也不证明原请求终止，仍占并发')
 await assert.rejects(service.reserve(f.owner,{...next,modelRequestId:'retry:before-timeout-proof'}),{code:'teloa/budget-exhausted',details:{reason:'concurrent',scope:'work'}})
 await env.pool.query("insert into teloa_work_retries(owner_id,operation_id,run_id,budget_account_id,attempts,max_attempts,state,completed,last_reason,created_at,updated_at) values($1,'model:timeout-finally',$2,$3,1,3,'unknown',false,'超时回包未知',$4,$4)",[f.owner,runId,lineage.budgetAccountId,startedAt])
 await env.pool.query("insert into teloa_work_retry_claims(owner_id,request_id,operation_id,attempt,model_request_id,spec) values($1,$2,'model:timeout-finally',1,$3,'{}')",[f.owner,randomUUID(),timeout.modelRequestId])
 assert.deepEqual(await service.recordRunTerminal(f.owner,proof),{closed:1},'已有未知回执仍能由固定原生日志补封口')
 assert.equal((await service.read(f.owner,{budgetAccountId:lineage.budgetAccountId})).concurrent,0)
 assert.equal((await service.read(f.owner,{budgetAccountId:lineage.budgetAccountId})).usedTokens,501)
 // 子模型预算也映射父Run；仅父会话终态不能证明子会话已结束。
 const childReservation=await service.reserve(f.owner,{budgetAccountId:lineage.budgetAccountId,controlGeneration:1,kind:'retry',tokens:1,rounds:0,modelRequestId:'retry:child-proof'})
 await service.markDispatched(f.owner,{reservationId:childReservation.id})
 await env.pool.query('update teloa_work_budget_reservations set created_at=$2 where id=$1',[childReservation.id,startedAt])
 await env.pool.query("insert into teloa_work_retries(owner_id,operation_id,run_id,budget_account_id,attempts,max_attempts,state,completed,last_reason,created_at,updated_at) values($1,'model:child-proof',$2,$3,1,3,'unknown',false,'原子模型回执未知',$4,$4)",[f.owner,runId,lineage.budgetAccountId,startedAt])
 await env.pool.query("insert into teloa_work_retry_claims(owner_id,request_id,operation_id,attempt,model_request_id,spec) values($1,$2,'model:child-proof',1,$3,'{}')",[f.owner,randomUUID(),childReservation.modelRequestId])
 await env.pool.query("insert into teloa_task_run_subagents(owner_id,run_id,reservation_id,child_session_id,depth,state,created_at,started_at) values($1,$2,'child-budget-proof','child-session',1,'started',$3,$3)",[f.owner,runId,startedAt])
 for(const state of ['started','ended','abandoned']){
  if(state!=='started')await env.pool.query('update teloa_task_run_subagents set state=$3,ended_at=$4,stop_reason=$5 where owner_id=$1 and run_id=$2',[f.owner,runId,state,endedAt,state==='ended'?'completed':'unknown'])
  assert.deepEqual(await service.recordRunTerminal(f.owner,proof),{closed:0},'父终态不得用于封口任何已发布子会话的未知消耗')
  const child=(await env.pool.query('select state,reserved_tokens,actual_tokens,elapsed_ended_at,settled_at from teloa_work_budget_reservations where id=$1',[childReservation.id])).rows[0]
  assert.deepEqual(child,{state:'unknown',reserved_tokens:1,actual_tokens:null,elapsed_ended_at:null,settled_at:null})
 }
})

test('派发前原子并发准入：账户内未终态 Run 与活动预留计入并发位，满额拒绝且不改预算、不建预留；终态或结算后放行',{timeout:60000},async t=>{
 const env=await setupRoleWork();t.after(env.close)
 const {WorkBudgetService,initializeWorkBudgets,defaultWorkBudgetPolicy}=await import('../src/work/work-budget.ts')
 await initializeWorkBudgets(env.pool)
 const {owner,role,taskId}=await roleFixture(env.pool,'employee')
 const db=await env.pool.connect();let lineage
 try{await db.query('begin');lineage=await new WorkLineageService(env.pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
 const account=lineage.budgetAccountId,policy={...defaultWorkBudgetPolicy,maxConcurrent:1}
 await env.pool.query('update teloa_work_budget_accounts set policy=$3 where owner_id=$1 and id=$2',[owner,account,JSON.stringify(policy)])
 const budgets=new WorkBudgetService(env.pool,identity)
 await budgets.admitRunStart(owner,account)
 const runId=await insertRoleRun(env.pool,owner,role.id,taskId,'prepared')
 await assert.rejects(budgets.admitRunStart(owner,account),{code:'teloa/budget-exhausted'},'已准备未终态的 Run 占并发位')
 await env.pool.query("update teloa_task_runs set state='ended' where id=$1",[runId])
 await budgets.admitRunStart(owner,account)
 await env.pool.query("insert into teloa_work_budget_reservations(id,owner_id,budget_account_id,control_generation,model_request_id,kind,reserved_tokens,reserved_rounds,state,created_at) values($1,$2,$3,1,$4,'goal',100,1,'reserved',now())",[randomUUID(),owner,account,'model-'+randomUUID()])
 await assert.rejects(budgets.admitRunStart(owner,account),{code:'teloa/budget-exhausted'},'活动模型预留同样占并发位')
 await env.pool.query("update teloa_work_budget_reservations set state='settled',actual_tokens=100,settled_at=now() where owner_id=$1 and budget_account_id=$2",[owner,account])
 await budgets.admitRunStart(owner,account)
 assert.deepEqual((await env.pool.query('select policy from teloa_work_budget_accounts where owner_id=$1 and id=$2',[owner,account])).rows[0].policy,policy,'准入不改预算')
 assert.equal((await env.pool.query("select count(*)::int n from teloa_work_budget_reservations where owner_id=$1 and budget_account_id=$2 and state='reserved'",[owner,account])).rows[0].n,0,'准入不建预留')
})

test('模型耗时按滚动24小时窗口计：终身累计超限的旧耗时不封住持续业务，窗口内超限按职责/本人范围拒绝并自动恢复',{timeout:60000},async t=>{
 const env=await setupRoleWork();t.after(env.close)
 const {WorkBudgetService,initializeWorkBudgets}=await import('../src/work/work-budget.ts');await initializeWorkBudgets(env.pool)
 const f=await roleFixture(env.pool,'employee'),db=await env.pool.connect();let lineage
 try{await db.query('begin');lineage=await new WorkLineageService(env.pool,identity).bindTask(db,f.owner,{taskId:f.taskId,source:{kind:'owner-task',taskId:f.taskId}});await db.query('commit')}finally{db.release()}
 const service=new WorkBudgetService(env.pool,identity,ownerAuthority),account=lineage.budgetAccountId,hour=3600000
 const policy={maxGoalRounds:32,maxTokens:10_000_000,maxElapsedMs:hour,maxConcurrent:4,maxRetries:3,stagnationRounds:3,money:null}
 await service.configure(f.owner,{requestId:randomUUID(),budgetAccountId:account,expectedVersion:1,policy})
 // 已结算调用：按真实结算终点计时，再把区间整体平移到指定的历史时刻。
 const settled=async(startAgoMs:number,durationMs:number)=>{
  const r=await service.reserve(f.owner,{budgetAccountId:account,controlGeneration:1,kind:'goal',tokens:10,rounds:0,modelRequestId:randomUUID()})
  await service.markDispatched(f.owner,{reservationId:r.id});await service.settle(f.owner,{reservationId:r.id,modelRequestId:r.modelRequestId,providerRequestId:null,tokens:10,moneyMinorUnits:null,currency:null,receiptId:randomUUID()})
  await env.pool.query("update teloa_work_budget_reservations set created_at=now()-$2::double precision*interval '1 millisecond',settled_at=now()-$3::double precision*interval '1 millisecond',elapsed_ended_at=now()-$3::double precision*interval '1 millisecond' where id=$1",[r.id,startAgoMs,startAgoMs-durationMs]);return r
 }
 const admission=async()=>{const c=await env.pool.connect();try{await c.query('begin');await service.admissionInTransaction(c,f.owner,account)}finally{await c.query('rollback');c.release()}}
 const near=(actual:number,expected:number,label:string)=>assert.ok(Math.abs(actual-expected)<60000,label+'：'+actual+' ≈ '+expected)
 // 一周前持续运行的 30 小时累计耗时：旧口径会永久超过 1 小时上限，新口径完全滑出窗口。
 for(let day=7;day>=2;day--)await settled(day*24*hour,5*hour)
 await assert.doesNotReject(admission,'窗口外历史耗时不再封住新工作')
 near((await service.read(f.owner,{budgetAccountId:account})).usedElapsedMs,0,'职责窗口用量');near((await service.readOwner(f.owner)).usedElapsedMs,0,'本人窗口用量')
 // 跨窗口边界的调用只计窗口内部分；再加窗口内 40 分钟即超过职责 1 小时上限。
 await settled(25*hour,1.5*hour);near((await service.read(f.owner,{budgetAccountId:account})).usedElapsedMs,0.5*hour,'跨边界只计窗口内半小时')
 await assert.doesNotReject(admission)
 const inside=await settled(2*hour,40*60000)
 near((await service.read(f.owner,{budgetAccountId:account})).usedElapsedMs,0.5*hour+40*60000,'窗口内合计')
 await assert.rejects(admission,{code:'teloa/budget-exhausted',details:{reason:'elapsed',scope:'work'}})
 await assert.rejects(service.reserve(f.owner,{budgetAccountId:account,controlGeneration:1,kind:'goal',tokens:1,rounds:0,modelRequestId:randomUUID()}),{code:'teloa/budget-exhausted',details:{reason:'elapsed',scope:'work'}})
 // 本人总额同样按窗口：职责放宽后由本人 1 小时上限拒绝，原因与范围分别可见。
 await service.configure(f.owner,{requestId:randomUUID(),budgetAccountId:account,expectedVersion:2,policy:{...policy,maxElapsedMs:4*hour}})
 const owner=await service.readOwner(f.owner);await service.configureOwner(f.owner,{requestId:randomUUID(),expectedVersion:owner.version,policy:{...owner.policy,maxElapsedMs:hour}})
 await assert.rejects(admission,{code:'teloa/budget-exhausted',details:{reason:'elapsed',scope:'owner'}})
 // 无需人工提额：窗口内耗时随时间滑出后自动恢复（以平移区间模拟时间流逝）。
 await env.pool.query("update teloa_work_budget_reservations set created_at=created_at-interval '1 day',settled_at=settled_at-interval '1 day',elapsed_ended_at=elapsed_ended_at-interval '1 day' where id=$1",[inside.id])
 await assert.doesNotReject(admission,'窗口内耗时滑出后自动恢复')
 // 未核验终态的调用仍按进行中计时，即便开始于窗口之前也计满整个窗口，不能借窗口提前释放。
 const open=await service.reserve(f.owner,{budgetAccountId:account,controlGeneration:1,kind:'goal',tokens:1,rounds:0,modelRequestId:randomUUID()});await service.markDispatched(f.owner,{reservationId:open.id})
 await env.pool.query("update teloa_work_budget_reservations set created_at=now()-interval '30 hours' where id=$1",[open.id])
 near((await service.readOwner(f.owner)).usedElapsedMs,24*hour+0.5*hour,'未封口调用计满窗口')
 await assert.rejects(admission,{code:'teloa/budget-exhausted',details:{reason:'elapsed',scope:'work'}},'职责先于本人核对')
 assert.equal((await service.read(f.owner,{budgetAccountId:account})).usedTokens,10*8+1,'token 仍累计，口径不随耗时窗口改变')
})
