import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {database,fixture,command,decision,identity} from '../../backend/tests/security-action-fixture.ts'
import {initializeSecurityActionExecutions,SecurityActionExecutionService} from '@teloa/backend'
import {SecurityActionExecutionDriver} from '../src/security-action-execution.ts'
import type {SecurityActionAdapter} from '../src/security-action-execution.ts'

test('十一 RPC 严格 payload、固定主体、完整回包及同 signal',async t=>{
 const db=await database();t.after(db.close);await initializeSecurityActionExecutions(db.pool)
 const f=await fixture(db.pool),{createSecurityActionHandler,securityActionEndpoints}=await import('../src/security-actions.ts'),{createSecurityActionDefinitionCatalog}=await import('../src/security-action-definitions.ts'),{SecurityActionPanelService,SecurityActionAttentionService}=await import('@teloa/backend')
 assert.deepEqual(securityActionEndpoints,['security-actions/list','security-actions/get','security-actions/propose','security-actions/submit','security-actions/decide','security-actions/withdraw-submission','security-actions/withdraw-approval','security-actions/execute','security-actions/observe','security-actions/acknowledge-failure','security-actions/attention'])
 const signal=new AbortController().signal,seen:AbortSignal[]=[],catalog=createSecurityActionDefinitionCatalog(),readiness={ready:async(_tool:string,s:AbortSignal)=>{seen.push(s);return {ready:false as const,reason:'未配置'}}}
 const executions=new SecurityActionExecutionService(db.pool,identity,f.approvals,f.journal),driver=new SecurityActionExecutionDriver(executions,[]),handler=createSecurityActionHandler(f.principal,{actions:f.actions,approvals:f.approvals,driver,panel:new SecurityActionPanelService(db.pool,catalog,readiness),attention:new SecurityActionAttentionService(db.pool,catalog,readiness,identity.now)})
 const panel=await handler('security-actions/list',{taskId:f.task.id},signal);assert.equal((panel as {taskId:string}).taskId,f.task.id);assert.equal(seen[0],signal)
 const proposed=await handler('security-actions/propose',f.proposal,signal) as Awaited<ReturnType<typeof f.actions.propose>>
 const pending=await handler('security-actions/submit',command(proposed),signal) as typeof proposed
 const approval=await handler('security-actions/decide',decision(pending),signal) as {approverId:string};assert.equal(approval.approverId,f.principal.approverId);assert.equal(proposed.proposerId,f.principal.approverId)
 await handler('security-actions/attention',{},signal);assert.equal(seen.at(-1),signal)
 const approved=await f.actions.get(f.principal,{actionId:proposed.id}),before=await db.pool.query('select * from teloa_security_action_audit')
 await assert.rejects(handler('security-actions/execute',command(approved),signal),{code:'teloa/dependency-unavailable'})
 assert.equal((await db.pool.query('select * from teloa_security_action_executions')).rowCount,0);assert.deepEqual((await db.pool.query('select * from teloa_security_action_audit')).rows,before.rows)
 const withdrawn=await handler('security-actions/withdraw-approval',command(approved),signal) as typeof proposed;assert.equal(withdrawn.state,'withdrawn')
 const another=await handler('security-actions/propose',{...f.proposal,requestId:randomUUID()},signal) as typeof proposed,pendingAgain=await handler('security-actions/submit',command(another),signal) as typeof proposed
 const cancelled=await handler('security-actions/withdraw-submission',command(pendingAgain),signal) as typeof proposed;assert.equal(cancelled.state,'withdrawn');assert.deepEqual(await handler('security-actions/get',{actionId:cancelled.id},signal),cancelled)
 for(const field of ['ownerId','approverId','proposerId','scopeIds'])await assert.rejects(handler('security-actions/decide',{...decision(pending),[field]:'other'},signal),{code:'teloa/invalid-input'})
 for(const [endpoint,payload] of [['security-actions/list',{}],['security-actions/get',{actionId:'bad'}],['security-actions/attention',{ownerId:'other'}]] as const)await assert.rejects(handler(endpoint,payload,signal),{code:'teloa/invalid-input'})
 await assert.rejects(handler('security-actions/unknown',{},signal),{code:'teloa/not-found'})
 const aborted=AbortSignal.abort();await assert.rejects(handler('security-actions/list',{taskId:f.task.id},aborted),{name:'AbortError'})
})

test('Attention 回包逐项拒绝额外字段、未知原因和重复动作身份',async()=>{
 const {readSecurityActionAttention}=await import('../src/security-actions.ts'),item={taskId:randomUUID(),actionId:randomUUID(),kind:'security-action',reason:'approval-required'}
 assert.deepEqual(readSecurityActionAttention([item]),[item])
 for(const value of [{items:[item]},[{...item,token:'must-not-leak'}],[{...item,reason:'success'}],[item,item],[{...item,actionId:'broken'}],[{...item,kind:'task'}]])assert.throws(()=>readSecurityActionAttention(value),{code:'teloa/invalid-host-response'})
})

test('RPC execute/observe 传原 signal，重建 handler 重放 GET-first 并保持观察 journal',async t=>{
 const db=await database();t.after(db.close);await initializeSecurityActionExecutions(db.pool)
 const f=await fixture(db.pool),{createSecurityActionHandler}=await import('../src/security-actions.ts'),{createSecurityActionDefinitionCatalog}=await import('../src/security-action-definitions.ts'),{SecurityActionPanelService,SecurityActionAttentionService}=await import('@teloa/backend')
 const signal=new AbortController().signal,catalog=createSecurityActionDefinitionCatalog(),events:string[]=[],signals:AbortSignal[]=[]
 let terminal=false
 const receipt=()=>({status:terminal?'succeeded' as const:'accepted' as const,receiptId:terminal?'effect':'acceptance',detail:terminal?'隔离已完成':'已受理',observedAt:identity.now(),targets:[{target:'prod-03',state:terminal?'succeeded' as const:'unknown' as const}]})
 const adapter:SecurityActionAdapter={tool:'security.endpoint.isolate',idempotency:{schema:'teloa.security-action-idempotency/v1',key:'operationId',persistence:'durable',sameRequest:'same-operation',differentRequest:'conflict'},ready:async s=>{signals.push(s);return {ready:true}},execute:async(_dispatch,s)=>{events.push('POST');signals.push(s);return receipt()},observe:async(_input,s)=>{events.push('GET');signals.push(s);return receipt()}}
 const make=()=>{
  const driver=new SecurityActionExecutionDriver(new SecurityActionExecutionService(db.pool,identity,f.approvals,f.journal),[adapter]),readiness={ready:driver.readiness.bind(driver)}
  return createSecurityActionHandler(f.principal,{actions:f.actions,approvals:f.approvals,driver,panel:new SecurityActionPanelService(db.pool,catalog,readiness),attention:new SecurityActionAttentionService(db.pool,catalog,readiness,identity.now)})
 }
 const proposed=await f.actions.propose(f.principal,f.proposal),pending=await f.actions.submit(f.principal,command(proposed));await f.approvals.decide(f.principal,decision(pending))
 const input=command(await f.actions.get(f.principal,{actionId:proposed.id})),handler=make()
 const first=await handler('security-actions/execute',input,signal) as {operationId:string;revision:number;state:string};assert.equal(first.state,'accepted');assert.deepEqual(events,['POST'])
 const replay=await make()('security-actions/execute',input,signal) as typeof first;assert.equal(replay.operationId,first.operationId);assert.deepEqual(events,['POST','GET'])
 terminal=true;const observe={requestId:randomUUID(),operationId:first.operationId,expectedRevision:replay.revision}
 const result=await make()('security-actions/observe',observe,signal) as typeof first;assert.equal(result.state,'succeeded');assert.deepEqual(events,['POST','GET','GET'])
 const before=(await db.pool.query('select * from teloa_security_action_execution_audit order by revision')).rows
 assert.deepEqual(await make()('security-actions/observe',observe,signal),result);assert.deepEqual(events,['POST','GET','GET']);assert.deepEqual((await db.pool.query('select * from teloa_security_action_execution_audit order by revision')).rows,before)
 assert.ok(signals.length>=5);assert.ok(signals.every(s=>s===signal));assert.equal((await db.pool.query('select * from teloa_security_action_executions')).rowCount,1)
})
