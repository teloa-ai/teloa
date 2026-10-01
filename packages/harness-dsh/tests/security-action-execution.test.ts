import assert from 'node:assert/strict'
import {before,after,test} from 'node:test'
import {randomUUID} from 'node:crypto'
import {database,fixture,identity,command,decision} from '../../backend/tests/security-action-fixture.ts'
import {initializeSecurityActionExecutions,SecurityActionExecutionService} from '../../backend/src/security/action-executions.ts'
import {SecurityActionExecutionDriver,type SecurityActionAdapter} from '../src/security-action-execution.ts'
import type {SecurityActionDispatch,SecurityExecutionReceipt} from '@teloa/contract'
let db:Awaited<ReturnType<typeof database>>
before(async()=>{db=await database();await initializeSecurityActionExecutions(db.pool)})
after(async()=>{await db?.close()})
async function setup(){
 const f=await fixture(db.pool),a=await f.actions.propose(f.principal,f.proposal),s=await f.actions.submit(f.principal,command(a))
 await f.approvals.decide(f.principal,decision(s))
 return {...f,request:command(await f.actions.get(f.principal,{actionId:a.id})),service:new SecurityActionExecutionService(db.pool,identity,f.approvals,f.journal)}
}
const signal=()=>new AbortController().signal
const capability={schema:'teloa.security-action-idempotency/v1',key:'operationId',persistence:'durable',sameRequest:'same-operation',differentRequest:'conflict'} as const
function target(){
 const calls:string[]=[],bodies:SecurityActionDispatch[]=[],effects=new Map<string,SecurityExecutionReceipt>()
 const adapter:SecurityActionAdapter={tool:'security.endpoint.isolate',idempotency:capability,ready:async()=>({ready:true}),observe:async({operationId})=>{calls.push('GET');return effects.get(operationId)??null},execute:async dispatch=>{calls.push('POST');bodies.push(structuredClone(dispatch));let result=effects.get(dispatch.operationId);if(!result){result={receiptId:randomUUID(),status:'succeeded',detail:'已完成隔离',observedAt:identity.now(),targets:dispatch.targets.map(target=>({target,state:'succeeded'}))};effects.set(dispatch.operationId,result)}return result}}
 return {adapter,calls,bodies,effects}
}
test('空目录与不合格幂等声明在 claim 前拒绝，Action/Execution/audit 零改动',async()=>{
 const f=await setup(),t=target()
 for(const adapters of [[],[{...t.adapter,ready:async()=>({ready:false as const,reason:'未配置'})}],[{...t.adapter,idempotency:{...capability,persistence:'memory'}} as unknown as SecurityActionAdapter]]){
  const driver=new SecurityActionExecutionDriver(f.service,adapters)
  await assert.rejects(driver.run(f.principal,f.request,signal()),{code:'teloa/dependency-unavailable'})
 }
 assert.equal((await f.actions.get(f.principal,{actionId:f.request.actionId})).state,'approved')
 assert.equal((await db.pool.query('select count(*) from teloa_security_action_executions where owner_id=$1',[f.principal.ownerId])).rows[0].count,'0')
 assert.equal((await db.pool.query('select count(*) from teloa_security_action_execution_audit where owner_id=$1',[f.principal.ownerId])).rows[0].count,'0')
})
test('claim 后 POST 前重启始终 GET-first 并复用持久 body',async()=>{
 const f=await setup(),t=target(),claimed=await f.service.claim(f.principal,f.request)
 const result=await new SecurityActionExecutionDriver(f.service,[t.adapter]).run(f.principal,f.request,signal())
 assert.equal(result.state,'succeeded');assert.equal(result.operationId,claimed.execution.operationId);assert.deepEqual(t.calls,['GET','POST'])
 assert.deepEqual(t.bodies,[claimed.execution.dispatch]);assert.equal(t.effects.size,1)
})
test('POST 已生效丢回包，重建 Driver 先 GET，查无仍仅同 operation/body 重放',async()=>{
 const f=await setup(),t=target(),execute=t.adapter.execute
 let lost=true
 t.adapter.execute=async(body,signal)=>{const result=await execute(body,signal);if(lost){lost=false;throw Error('lost response')}return result}
 const unknown=await new SecurityActionExecutionDriver(f.service,[t.adapter]).run(f.principal,f.request,signal())
 assert.equal(unknown.state,'effect_unknown')
 t.adapter.observe=async()=>{t.calls.push('GET');return null}
 const restored=await new SecurityActionExecutionDriver(f.service,[t.adapter]).observe(f.principal,{requestId:randomUUID(),operationId:unknown.operationId,expectedRevision:unknown.revision},signal())
 assert.equal(restored.state,'succeeded');assert.equal(t.effects.size,1);assert.deepEqual(t.calls,['POST','GET','POST']);assert.deepEqual(t.bodies[0],t.bodies[1])
})
test('POST 生效后取消保留 dispatching；新服务和 Driver 用 GET 恢复效果',async()=>{
 const f=await setup(),t=target(),abort=new AbortController(),execute=t.adapter.execute
 t.adapter.execute=async(body,signal)=>{const result=await execute(body,signal);abort.abort();return result}
 await assert.rejects(new SecurityActionExecutionDriver(f.service,[t.adapter]).run(f.principal,f.request,abort.signal),{name:'AbortError'})
 const claimed=await f.service.claim(f.principal,f.request);assert.equal(claimed.execution.state,'dispatching')
 const service=new SecurityActionExecutionService(db.pool,identity,f.approvals,f.journal)
 const result=await new SecurityActionExecutionDriver(service,[t.adapter]).run(f.principal,f.request,signal())
 assert.equal(result.state,'succeeded');assert.deepEqual(t.calls,['POST','GET']);assert.equal(t.effects.size,1)
})
test('两个 Driver 并发观察在 GET 屏障后完成相同历史，外部效果仍恰好一次',async()=>{
 const f=await setup(),t=target(),{execution:e}=await f.service.claim(f.principal,f.request)
 let entered=0;let release!:()=>void;const gate=new Promise<void>(r=>release=r)
 t.adapter.observe=async()=>{t.calls.push('GET');if(++entered===2)release();await gate;return null}
 const request={requestId:randomUUID(),operationId:e.operationId,expectedRevision:1}
 const a=new SecurityActionExecutionDriver(f.service,[t.adapter]),b=new SecurityActionExecutionDriver(new SecurityActionExecutionService(db.pool,identity,f.approvals,f.journal),[t.adapter])
 const [left,right]=await Promise.all([a.observe(f.principal,request,signal()),b.observe(f.principal,request,signal())])
 assert.deepEqual(left,right);assert.equal(left.state,'succeeded');assert.equal(t.effects.size,1)
 assert.deepEqual(t.calls,['GET','GET','POST','POST']);assert.deepEqual(t.bodies,[e.dispatch,e.dispatch])
 assert.equal((await db.pool.query("select count(*) from teloa_security_action_execution_receipts where operation_id=$1 and kind='effect'",[e.operationId])).rows[0].count,'1')
 assert.equal((await db.pool.query("select count(*) from teloa_security_action_execution_audit where operation_id=$1 and event='effect-recorded'",[e.operationId])).rows[0].count,'1')
})
test('未知观察不完成 journal，重新观察同 request 恢复；错误目标回执不入库',async()=>{
 const f=await setup(),t=target(),{execution:e}=await f.service.claim(f.principal,f.request),driver=new SecurityActionExecutionDriver(f.service,[t.adapter])
 const request={requestId:randomUUID(),operationId:e.operationId,expectedRevision:1},execute=t.adapter.execute
 t.adapter.execute=async()=>{throw Error('外部超时')}
 await assert.rejects(driver.observe(f.principal,request,signal()),/外部超时/)
 assert.equal((await db.pool.query('select state from teloa_security_action_observation_requests where request_id=$1',[request.requestId])).rows[0].state,'pending')
 t.adapter.execute=async(body,signal)=>({...await execute(body,signal),targets:[{target:'other',state:'succeeded'}]})
 await assert.rejects(driver.observe(f.principal,request,signal()),{code:'teloa/invalid-host-response'})
 assert.equal((await db.pool.query('select count(*) from teloa_security_action_execution_receipts where operation_id=$1',[e.operationId])).rows[0].count,'0')
 t.adapter.execute=execute
 const result=await new SecurityActionExecutionDriver(f.service,[t.adapter]).observe(f.principal,request,signal())
 assert.equal(result.state,'succeeded');assert.equal(result.operationId,e.operationId);assert.equal(t.effects.size,1)
})
test('恢复始终使用数据库规范化的 operationId，不把调用方大小写当作新操作身份',async()=>{
 const f=await setup(),t=target(),{execution:e}=await f.service.claim(f.principal,f.request)
 const result=await new SecurityActionExecutionDriver(f.service,[t.adapter]).recover(f.principal,e.operationId.toUpperCase(),signal())
 assert.equal(result.operationId,e.operationId);assert.deepEqual(t.bodies,[e.dispatch]);assert.equal(t.effects.size,1)
})
