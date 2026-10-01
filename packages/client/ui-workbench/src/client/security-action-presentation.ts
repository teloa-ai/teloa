import type {SecurityAction,SecurityActionExecution,SecurityActionPanel} from '@teloa/contract'
import type {SecurityActionAttention} from './security-action-api.js'
/** 服务端 `readSecurityActionGraph` 允许接续的三态（`action-panel.ts:56`）。两处按同一份常量走，免得再次漂移。 */
export const securitySupersedableStates=['rejected','withdrawn','failed'] as const
export const securityExecutionPresentation=(execution:SecurityActionExecution)=>({status:('security.execution.'+execution.state) as 'security.execution.dispatching'|'security.execution.accepted'|'security.execution.effect_unknown'|'security.execution.succeeded'|'security.execution.failed',canExecute:false,canObserve:['dispatching','accepted','effect_unknown'].includes(execution.state)})
export function securityActionControls(action:SecurityAction,panel:SecurityActionPanel,attention:readonly SecurityActionAttention[],known:boolean){
 const execution=panel.executions.find(e=>e.actionId===action.id)
 return {submit:action.state==='proposed',decide:action.state==='pending_approval',withdrawSubmission:action.state==='pending_approval',withdrawApproval:action.state==='approved'&&!execution,execute:action.state==='approved'&&!execution&&known&&attention.some(row=>row.taskId===panel.taskId&&row.actionId===action.id&&row.reason==='execution-required'),
  // 过期的批准服务端已经不认（拒绝派发），attention 会把它投影成 approval-expired 而不是 execution-required；
  // 客户端不重算过期时间，只认这条已投影的事实，同一判据两个入口共用，不会一边能执行一边不能。
  expired:action.state==='approved'&&!execution&&known&&attention.some(row=>row.taskId===panel.taskId&&row.actionId===action.id&&row.reason==='approval-expired'),
  observe:!!execution&&securityExecutionPresentation(execution).canObserve,acknowledge:action.state==='failed',repropose:securitySupersedableStates.includes(action.state as typeof securitySupersedableStates[number])}
}
