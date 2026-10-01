import {WorkError,isRecord,taskInput,readSecurityAction,readSecurityApproval,readSecurityActionExecution,readSecurityActionPanel,securityActionProposalInput,securityActionSubmitInput,securityApprovalDecisionInput,securityActionWithdrawInput,securityExecutionInput,securityObservationInput,securityFailureAcknowledgementInput,type SecurityPrincipal,type SecurityAction} from '@teloa/contract'
import {securityActionReadId,securityActionAttentionReasons,type SecurityActionService,type SecurityApprovalService,type SecurityActionPanelService,type SecurityActionAttentionService,type SecurityActionAttentionItem} from '@teloa/backend'
import type {SecurityActionExecutionDriver} from './security-action-execution.ts'

export const securityActionEndpoints=['security-actions/list','security-actions/get','security-actions/propose','security-actions/submit','security-actions/decide','security-actions/withdraw-submission','security-actions/withdraw-approval','security-actions/execute','security-actions/observe','security-actions/acknowledge-failure','security-actions/attention'] as const
type Ports={actions:Pick<SecurityActionService,'get'|'propose'|'submit'|'withdrawSubmission'|'withdrawApproval'|'acknowledgeFailure'>;approvals:Pick<SecurityApprovalService,'decide'>;driver:Pick<SecurityActionExecutionDriver,'run'|'observe'>;panel:Pick<SecurityActionPanelService,'list'>;attention:Pick<SecurityActionAttentionService,'list'>}
const invalid=()=>new WorkError('teloa/invalid-host-response','安全动作接口回包或主体关联不正确。')
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
export function readSecurityActionAttention(value:unknown):SecurityActionAttentionItem[]{
 if(!Array.isArray(value))throw invalid()
 const ids=new Set<string>()
 return value.map(item=>{
  if(!isRecord(item)||Object.keys(item).length!==4||Object.keys(item).some(key=>!['taskId','actionId','kind','reason'].includes(key))||!uuid(item.taskId)||!uuid(item.actionId)||item.kind!=='security-action'||!securityActionAttentionReasons.some(reason=>reason===item.reason)||ids.has(item.actionId.toLowerCase()))throw invalid()
  ids.add(item.actionId.toLowerCase());return {taskId:item.taskId.toLowerCase(),actionId:item.actionId.toLowerCase(),kind:'security-action',reason:item.reason as SecurityActionAttentionItem['reason']}
 })
}

export function createSecurityActionHandler(principal:SecurityPrincipal,ports:Ports){
 // 复制并冻结 composition root 的身份，任何 RPC payload 都不能扩充它。
 const actor:SecurityPrincipal={...principal,scopeIds:[...principal.scopeIds]}
 Object.freeze(actor.scopeIds);Object.freeze(actor)
 const action=(value:unknown,expectedId?:string):SecurityAction=>{const result=readSecurityAction(value);if(result.ownerId!==actor.ownerId||result.proposerId!==actor.approverId||expectedId!==undefined&&result.id!==expectedId)throw invalid();return result}
 return async(endpoint:string,payload:unknown,signal:AbortSignal):Promise<unknown>=>{
  signal.throwIfAborted()
  let result:unknown
  if(endpoint==='security-actions/list'){
   const taskId=securityActionReadId(payload,'taskId'),panel=readSecurityActionPanel(await ports.panel.list(actor,{taskId},signal))
   if(panel.taskId!==taskId||panel.actions.some(a=>a.ownerId!==actor.ownerId||a.proposerId!==actor.approverId)||panel.approvals.some(a=>a.approverId!==actor.approverId))throw invalid();result=panel
  }else if(endpoint==='security-actions/get'){
   const actionId=securityActionReadId(payload,'actionId');result=action(await ports.actions.get(actor,{actionId}),actionId)
  }else if(endpoint==='security-actions/propose'){
   const input=securityActionProposalInput(payload),value=action(await ports.actions.propose(actor,input));if(value.taskId!==input.taskId)throw invalid();result=value
  }else if(endpoint==='security-actions/submit'){
   const input=securityActionSubmitInput(payload);result=action(await ports.actions.submit(actor,input),input.actionId)
  }else if(endpoint==='security-actions/decide'){
   const input=securityApprovalDecisionInput(payload),value=readSecurityApproval(await ports.approvals.decide(actor,input));if(value.ownerId!==actor.ownerId||value.approverId!==actor.approverId||value.actionId!==input.actionId||value.actionVersion!==input.expectedActionVersion)throw invalid();result=value
  }else if(endpoint==='security-actions/withdraw-submission'||endpoint==='security-actions/withdraw-approval'){
   const input=securityActionWithdrawInput(payload),method=endpoint==='security-actions/withdraw-submission'?'withdrawSubmission':'withdrawApproval';result=action(await ports.actions[method](actor,input),input.actionId)
  }else if(endpoint==='security-actions/acknowledge-failure'){
   const input=securityFailureAcknowledgementInput(payload);result=action(await ports.actions.acknowledgeFailure(actor,input),input.actionId)
  }else if(endpoint==='security-actions/execute'){
   const input=securityExecutionInput(payload),value=readSecurityActionExecution(await ports.driver.run(actor,input,signal));if(value.ownerId!==actor.ownerId||value.actionId!==input.actionId)throw invalid();result=value
  }else if(endpoint==='security-actions/observe'){
   const input=securityObservationInput(payload),value=readSecurityActionExecution(await ports.driver.observe(actor,input,signal));if(value.ownerId!==actor.ownerId||value.operationId!==input.operationId)throw invalid();result=value
  }else if(endpoint==='security-actions/attention'){
   taskInput(payload,[]);result=readSecurityActionAttention(await ports.attention.list(actor,{},signal))
  }else throw new WorkError('teloa/not-found','未提供此安全动作接口。')
  signal.throwIfAborted();return result
 }
}
