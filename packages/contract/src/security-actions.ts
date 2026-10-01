import {WorkError,isRecord} from './index.ts'
import type {BusinessObjectSnapshot} from './business-data.ts'

export const securityActionStates=['proposed','pending_approval','approved','rejected','withdrawn','executing','effect_unknown','succeeded','failed'] as const
export const securityApprovalDecisions=['approved','rejected'] as const
export const securityExecutionStates=['dispatching','accepted','effect_unknown','succeeded','failed'] as const
export const securityReceiptStates=['accepted','succeeded','failed'] as const
export const securityRiskTiers=['low','med','high'] as const
export const securityReversibilities=['readonly','reversible','irreversible'] as const
/**
 * 安全审批有效期按风险等级写死（规格 §二 D2）：个人版单机、审批人就是本人，
 * 可配置项只会多一个能被改坏的安全面。数值要改就改这里重发版。
 */
export const securityApprovalTtlMinutes={high:15,med:60,low:1440} as const satisfies Record<typeof securityRiskTiers[number],number>

export const securityActionTransitions={
 proposed:['pending_approval'],pending_approval:['approved','rejected','withdrawn'],
 approved:['executing','withdrawn'],rejected:[],withdrawn:[],
 executing:['succeeded','failed','effect_unknown'],
 effect_unknown:['executing','succeeded','failed'],succeeded:[],failed:[],
} as const

export const securityExecutionTransitions={
 dispatching:['accepted','effect_unknown','succeeded','failed'],
 accepted:['effect_unknown','succeeded','failed'],
 effect_unknown:['accepted','succeeded','failed'],succeeded:[],failed:[],
} as const

export type SecurityActionState=typeof securityActionStates[number]
export type SecurityApprovalDecision=typeof securityApprovalDecisions[number]
export type SecurityExecutionState=typeof securityExecutionStates[number]
export type SecurityReceiptState=typeof securityReceiptStates[number]
export type SecurityRiskTier=typeof securityRiskTiers[number]
export type SecurityReversibility=typeof securityReversibilities[number]

export type SecurityPrincipal={ownerId:string;approverId:string;scopeIds:string[]}

export type SecurityActionProposalInput={
 requestId:string
 taskId:string
 expectedTaskVersion:number
 title:string
 goal:string
 tool:string
 targetSet:string[]
 params:Record<string,unknown>
 supersedesActionId?:string
}

export type SecurityActionSubmitInput={requestId:string;actionId:string;expectedActionVersion:number}
export type SecurityApprovalDecisionInput=SecurityActionSubmitInput&{decision:SecurityApprovalDecision;reason:string;impactConfirmed:boolean}
export type SecurityActionWithdrawInput=SecurityActionSubmitInput
export type SecurityExecutionInput=SecurityActionSubmitInput
export type SecurityObservationInput={requestId:string;operationId:string;expectedRevision:number}
export type SecurityFailureAcknowledgementInput=SecurityActionSubmitInput

export type SecurityActionFrozenValues={
 taskDefinitionDigest:string
 sourceSnapshotDigest:string
 objectSnapshotHash:string
 playbookVersion:string
 paramFingerprint:string
 targetFingerprint:string
}

export type SecurityAction={
 id:string
 ownerId:string
 taskId:string
 version:number
 state:SecurityActionState
 title:string
 goal:string
 tool:string
 riskTier:SecurityRiskTier
 reversible:SecurityReversibility
 playbookVersion:string
 targetSet:string[]
 params:Record<string,unknown>
 supersedesActionId:string|null
 frozen:SecurityActionFrozenValues|null
 proposerId:string
 createdAt:string
 updatedAt:string
}

export type SecurityApproval={
 id:string
 ownerId:string
 actionId:string
 actionVersion:number
 decision:SecurityApprovalDecision
 approverId:string
 reason:string
 impactConfirmed:boolean
 frozen:SecurityActionFrozenValues
 createdAt:string
}

export type SecurityTargetReceipt={target:string;state:'unknown'|'succeeded'|'failed'}
export type SecurityExecutionReceipt={status:SecurityReceiptState;receiptId:string;detail:string;observedAt:string;targets:SecurityTargetReceipt[]}
export type SecurityActionDispatch={operationId:string;actionId:string;tool:string;playbookVersion:string;targets:string[];params:Record<string,unknown>}
export type SecurityActionExecution={
 operationId:string
 ownerId:string
 actionId:string
 approvalId:string
 approvalVersion:number
 state:SecurityExecutionState
 revision:number
 frozen:SecurityActionFrozenValues
 dispatch:SecurityActionDispatch
 acceptanceReceipt:SecurityExecutionReceipt|null
 effectReceipt:SecurityExecutionReceipt|null
 createdAt:string
 updatedAt:string
}

export type SecurityActionAuthorization={tool:string;playbookVersion:string;riskTier:SecurityRiskTier;reversible:SecurityReversibility;targetSet:string[];params:Record<string,unknown>}
export interface SecurityActionDefinition {
 readonly tool:string
 readonly playbookVersion:string
 authorize(snapshot:BusinessObjectSnapshot,targetSet:readonly string[],params:unknown):SecurityActionAuthorization
}
export interface SecurityActionDefinitionCatalog {require(tool:string):SecurityActionDefinition}
export type SecurityActionPanel={
 taskId:string
 actions:SecurityAction[]
 approvals:SecurityApproval[]
 executions:SecurityActionExecution[]
 proposal:{tools:Array<{tool:string;allowedTargets:string[]}>}
}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const iso=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const control=/[\x00-\x1f\x7f]/
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value===value.trim()&&!!value&&value.length<=max&&!control.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const sha256=(value:unknown):value is string=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value)
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)

function inputError(message:string):never{throw new WorkError('teloa/invalid-input',message)}
function hostError(message:string):never{throw new WorkError('teloa/invalid-host-response',message)}
function exactInput(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))inputError('安全动作请求包含未知字段或格式不正确。')
 return value
}
function exactOutput(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!isRecord(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))hostError('安全动作回包字段不正确。')
 return value
}
function json(value:unknown,error:(message:string)=>never,path='params'):unknown{
 if(value===null||typeof value==='string'||typeof value==='boolean')return value
 if(typeof value==='number'){if(!Number.isFinite(value))error(`${path} 含非有限数字。`);return value}
 if(Array.isArray(value))return value.map((item,index)=>json(item,error,`${path}[${index}]`))
 if(typeof value==='object'){
  const prototype=Object.getPrototypeOf(value)
  if(prototype!==Object.prototype&&prototype!==null)error(`${path} 不是普通 JSON 对象。`)
  const out:Record<string,unknown>={}
  for(const [key,item] of Object.entries(value))out[key]=json(item,error,`${path}.${key}`)
  return out
 }
 return error(`${path} 含非 JSON 值。`)
}
function jsonObject(value:unknown,error:(message:string)=>never,path='params'):Record<string,unknown>{
 if(!isRecord(value))return error(`${path} 必须是 JSON 对象。`)
 return json(value,error,path) as Record<string,unknown>
}
function stableJson(value:unknown):string{
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number')return JSON.stringify(value)
 if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`
 return `{${Object.keys(value as Record<string,unknown>).sort().map(key=>`${JSON.stringify(key)}:${stableJson((value as Record<string,unknown>)[key])}`).join(',')}}`
}
function targetSet(value:unknown,error:(message:string)=>never):string[]{
 if(!Array.isArray(value)||value.length<1||value.length>256||value.some(target=>!text(target,512))||new Set(value).size!==value.length)return error('安全动作目标集合为空、重复或超限。')
 return [...value] as string[]
}
function frozen(value:unknown,error:(message:string)=>never):SecurityActionFrozenValues{
 const row=isRecord(value)?value:error('安全动作冻结值格式不正确。')
 if(Object.keys(row).length!==6||Object.keys(row).some(key=>!['taskDefinitionDigest','sourceSnapshotDigest','objectSnapshotHash','playbookVersion','paramFingerprint','targetFingerprint'].includes(key))||!sha256(row.taskDefinitionDigest)||!digest(row.sourceSnapshotDigest)||!digest(row.objectSnapshotHash)||!text(row.playbookVersion,256)||!sha256(row.paramFingerprint)||!sha256(row.targetFingerprint))return error('安全动作冻结值格式不正确。')
 return {taskDefinitionDigest:row.taskDefinitionDigest,sourceSnapshotDigest:row.sourceSnapshotDigest,objectSnapshotHash:row.objectSnapshotHash,playbookVersion:row.playbookVersion,paramFingerprint:row.paramFingerprint,targetFingerprint:row.targetFingerprint}
}

export function securityActionProposalInput(value:unknown):SecurityActionProposalInput{
 const row=exactInput(value,['requestId','taskId','expectedTaskVersion','title','goal','tool','targetSet','params','supersedesActionId'])
 if(!uuid(row.requestId)||!uuid(row.taskId)||!positive(row.expectedTaskVersion)||!text(row.title,120)||!text(row.goal,8000)||!text(row.tool,128)||row.supersedesActionId!==undefined&&!uuid(row.supersedesActionId))inputError('安全动作提议身份或文本不正确。')
 return {requestId:row.requestId.toLowerCase(),taskId:row.taskId.toLowerCase(),expectedTaskVersion:row.expectedTaskVersion,title:row.title,goal:row.goal,tool:row.tool,targetSet:targetSet(row.targetSet,inputError),params:jsonObject(row.params,inputError),...(row.supersedesActionId===undefined?{}:{supersedesActionId:row.supersedesActionId.toLowerCase()})}
}
function actionVersionInput(value:unknown,keys:readonly string[]):SecurityActionSubmitInput{
 const row=exactInput(value,keys)
 if(!uuid(row.requestId)||!uuid(row.actionId)||!positive(row.expectedActionVersion))inputError('安全动作请求身份或版本不正确。')
 return {requestId:row.requestId.toLowerCase(),actionId:row.actionId.toLowerCase(),expectedActionVersion:row.expectedActionVersion}
}
export function securityActionSubmitInput(value:unknown):SecurityActionSubmitInput{return actionVersionInput(value,['requestId','actionId','expectedActionVersion'])}
export function securityActionWithdrawInput(value:unknown):SecurityActionWithdrawInput{return actionVersionInput(value,['requestId','actionId','expectedActionVersion'])}
export function securityExecutionInput(value:unknown):SecurityExecutionInput{return actionVersionInput(value,['requestId','actionId','expectedActionVersion'])}
export function securityFailureAcknowledgementInput(value:unknown):SecurityFailureAcknowledgementInput{return actionVersionInput(value,['requestId','actionId','expectedActionVersion'])}
export function securityApprovalDecisionInput(value:unknown):SecurityApprovalDecisionInput{
 const row=exactInput(value,['requestId','actionId','expectedActionVersion','decision','reason','impactConfirmed'])
 const base=actionVersionInput(row,['requestId','actionId','expectedActionVersion','decision','reason','impactConfirmed'])
 if(!securityApprovalDecisions.includes(row.decision as SecurityApprovalDecision)||!text(row.reason,4000)||typeof row.impactConfirmed!=='boolean')inputError('安全审批决定不正确。')
 return {...base,decision:row.decision as SecurityApprovalDecision,reason:row.reason,impactConfirmed:row.impactConfirmed}
}
export function securityObservationInput(value:unknown):SecurityObservationInput{
 const row=exactInput(value,['requestId','operationId','expectedRevision'])
 if(!uuid(row.requestId)||!uuid(row.operationId)||!positive(row.expectedRevision))inputError('安全动作核对请求不正确。')
 return {requestId:row.requestId.toLowerCase(),operationId:row.operationId.toLowerCase(),expectedRevision:row.expectedRevision}
}

export function readSecurityAction(value:unknown):SecurityAction{
 const row=exactOutput(value,['id','ownerId','taskId','version','state','title','goal','tool','riskTier','reversible','playbookVersion','targetSet','params','supersedesActionId','frozen','proposerId','createdAt','updatedAt'])
 if(!uuid(row.id)||!text(row.ownerId,128)||!uuid(row.taskId)||!positive(row.version)||!securityActionStates.includes(row.state as SecurityActionState)||!text(row.title,120)||!text(row.goal,8000)||!text(row.tool,128)||!securityRiskTiers.includes(row.riskTier as SecurityRiskTier)||!securityReversibilities.includes(row.reversible as SecurityReversibility)||!text(row.playbookVersion,256)||!(row.supersedesActionId===null||uuid(row.supersedesActionId))||!text(row.proposerId,128)||!iso(row.createdAt)||!iso(row.updatedAt)||row.updatedAt<row.createdAt)hostError('安全动作回包内容不正确。')
 const parsedFrozen=row.frozen===null?null:frozen(row.frozen,hostError)
 if(row.state==='proposed'?parsedFrozen!==null:parsedFrozen===null||parsedFrozen.playbookVersion!==row.playbookVersion)hostError('安全动作状态与冻结值不一致。')
 return {id:row.id.toLowerCase(),ownerId:row.ownerId,taskId:row.taskId.toLowerCase(),version:row.version,state:row.state as SecurityActionState,title:row.title,goal:row.goal,tool:row.tool,riskTier:row.riskTier as SecurityRiskTier,reversible:row.reversible as SecurityReversibility,playbookVersion:row.playbookVersion,targetSet:targetSet(row.targetSet,hostError),params:jsonObject(row.params,hostError),supersedesActionId:row.supersedesActionId===null?null:row.supersedesActionId.toLowerCase(),frozen:parsedFrozen,proposerId:row.proposerId,createdAt:row.createdAt,updatedAt:row.updatedAt}
}
export function readSecurityApproval(value:unknown):SecurityApproval{
 const row=exactOutput(value,['id','ownerId','actionId','actionVersion','decision','approverId','reason','impactConfirmed','frozen','createdAt'])
 if(!uuid(row.id)||!text(row.ownerId,128)||!uuid(row.actionId)||!positive(row.actionVersion)||!securityApprovalDecisions.includes(row.decision as SecurityApprovalDecision)||!text(row.approverId,128)||!text(row.reason,4000)||typeof row.impactConfirmed!=='boolean'||!iso(row.createdAt))hostError('安全审批回包内容不正确。')
 return {id:row.id.toLowerCase(),ownerId:row.ownerId,actionId:row.actionId.toLowerCase(),actionVersion:row.actionVersion,decision:row.decision as SecurityApprovalDecision,approverId:row.approverId,reason:row.reason,impactConfirmed:row.impactConfirmed,frozen:frozen(row.frozen,hostError),createdAt:row.createdAt}
}
function receipt(value:unknown):SecurityExecutionReceipt{
 const row=exactOutput(value,['status','receiptId','detail','observedAt','targets'])
 if(!securityReceiptStates.includes(row.status as SecurityReceiptState)||!text(row.receiptId,256)||!text(row.detail,4000)||!iso(row.observedAt)||!Array.isArray(row.targets)||row.targets.length<1||row.targets.length>256)hostError('安全动作回执不正确。')
 const targets=row.targets.map(item=>{const target=exactOutput(item,['target','state']);if(!text(target.target,512)||!['unknown','succeeded','failed'].includes(String(target.state)))hostError('安全动作回执目标不正确。');return {target:target.target,state:target.state as SecurityTargetReceipt['state']}})
 if(new Set(targets.map(target=>target.target)).size!==targets.length)hostError('安全动作回执目标重复。')
 if(row.status==='accepted'&&!targets.every(target=>target.state==='unknown')||row.status==='succeeded'&&!targets.every(target=>target.state==='succeeded')||row.status==='failed'&&!targets.some(target=>target.state==='failed'))hostError('安全动作回执状态与目标结果不一致。')
 return {status:row.status as SecurityReceiptState,receiptId:row.receiptId,detail:row.detail,observedAt:row.observedAt,targets}
}
function dispatch(value:unknown):SecurityActionDispatch{
 const row=exactOutput(value,['operationId','actionId','tool','playbookVersion','targets','params'])
 if(!uuid(row.operationId)||!uuid(row.actionId)||!text(row.tool,128)||!text(row.playbookVersion,256))hostError('安全动作派发信息不正确。')
 return {operationId:row.operationId.toLowerCase(),actionId:row.actionId.toLowerCase(),tool:row.tool,playbookVersion:row.playbookVersion,targets:targetSet(row.targets,hostError),params:jsonObject(row.params,hostError)}
}
export function readSecurityActionExecution(value:unknown):SecurityActionExecution{
 const row=exactOutput(value,['operationId','ownerId','actionId','approvalId','approvalVersion','state','revision','frozen','dispatch','acceptanceReceipt','effectReceipt','createdAt','updatedAt'])
 if(!uuid(row.operationId)||!text(row.ownerId,128)||!uuid(row.actionId)||!uuid(row.approvalId)||!positive(row.approvalVersion)||!securityExecutionStates.includes(row.state as SecurityExecutionState)||!positive(row.revision)||!iso(row.createdAt)||!iso(row.updatedAt)||row.updatedAt<row.createdAt)hostError('安全动作执行回包内容不正确。')
 const parsedFrozen=frozen(row.frozen,hostError),parsedDispatch=dispatch(row.dispatch),acceptanceReceipt=row.acceptanceReceipt===null?null:receipt(row.acceptanceReceipt),effectReceipt=row.effectReceipt===null?null:receipt(row.effectReceipt)
 if(parsedDispatch.operationId.toLowerCase()!==row.operationId.toLowerCase()||parsedDispatch.actionId.toLowerCase()!==row.actionId.toLowerCase()||acceptanceReceipt!==null&&acceptanceReceipt.status!=='accepted'||effectReceipt!==null&&effectReceipt.status==='accepted')hostError('安全动作执行关联不正确。')
 if(acceptanceReceipt!==null&&!sameTargetSet(parsedDispatch.targets,acceptanceReceipt.targets.map(target=>target.target))||effectReceipt!==null&&!sameTargetSet(parsedDispatch.targets,effectReceipt.targets.map(target=>target.target)))hostError('安全动作执行回执目标与派发目标不一致。')
 if(row.state==='dispatching'&&(acceptanceReceipt!==null||effectReceipt!==null)||row.state==='accepted'&&(acceptanceReceipt===null||effectReceipt!==null)||row.state==='effect_unknown'&&effectReceipt!==null||row.state==='succeeded'&&(effectReceipt===null||effectReceipt.status!=='succeeded')||row.state==='failed'&&(effectReceipt===null||effectReceipt.status!=='failed'))hostError('安全动作执行状态与回执不一致。')
 return {operationId:row.operationId.toLowerCase(),ownerId:row.ownerId,actionId:row.actionId.toLowerCase(),approvalId:row.approvalId.toLowerCase(),approvalVersion:row.approvalVersion,state:row.state as SecurityExecutionState,revision:row.revision,frozen:parsedFrozen,dispatch:parsedDispatch,acceptanceReceipt,effectReceipt,createdAt:row.createdAt,updatedAt:row.updatedAt}
}
export function readSecurityActionPanel(value:unknown):SecurityActionPanel{
 const row=exactOutput(value,['taskId','actions','approvals','executions','proposal'])
 if(!uuid(row.taskId)||!Array.isArray(row.actions)||!Array.isArray(row.approvals)||!Array.isArray(row.executions)||!isRecord(row.proposal)||Object.keys(row.proposal).length!==1||!Array.isArray(row.proposal.tools))hostError('安全动作面板回包格式不正确。')
 const taskId=row.taskId.toLowerCase(),actions=row.actions.map(readSecurityAction),approvals=row.approvals.map(readSecurityApproval),executions=row.executions.map(readSecurityActionExecution)
 const actionById=new Map(actions.map(action=>[action.id,action])),approvalById=new Map(approvals.map(approval=>[approval.id,approval]))
 if(actions.some(action=>action.taskId!==taskId)||new Set(actions.map(action=>action.id)).size!==actions.length||approvals.some(approval=>{const action=actionById.get(approval.actionId);return !action||action.ownerId!==approval.ownerId||action.frozen===null||!sameFrozen(action.frozen,approval.frozen)||approval.decision==='approved'&&!approval.impactConfirmed})||executions.some(execution=>{const action=actionById.get(execution.actionId),approval=approvalById.get(execution.approvalId);return !action||!approval||approval.decision!=='approved'||!approval.impactConfirmed||action.ownerId!==execution.ownerId||approval.ownerId!==execution.ownerId||approval.actionId!==execution.actionId||approval.actionVersion!==execution.approvalVersion||!sameFrozen(approval.frozen,execution.frozen)||!executionMatchesAction(execution.state,action.state)||execution.dispatch.tool!==action.tool||execution.dispatch.playbookVersion!==action.playbookVersion||!sameTargetSet(execution.dispatch.targets,action.targetSet)||!sameJson(execution.dispatch.params,action.params)})||new Set(approvals.map(approval=>approval.id)).size!==approvals.length||new Set(executions.map(execution=>execution.operationId)).size!==executions.length)hostError('安全动作面板关联不正确。')
 const tools=row.proposal.tools.map(value=>{const tool=exactOutput(value,['tool','allowedTargets']);if(!text(tool.tool,128))hostError('安全动作提议能力不正确。');return {tool:tool.tool,allowedTargets:targetSet(tool.allowedTargets,hostError)}})
 if(new Set(tools.map(tool=>tool.tool)).size!==tools.length)hostError('安全动作提议能力重复。')
 return {taskId,actions,approvals,executions,proposal:{tools}}
}

function sameFrozen(a:SecurityActionFrozenValues,b:SecurityActionFrozenValues):boolean{return a.taskDefinitionDigest===b.taskDefinitionDigest&&a.sourceSnapshotDigest===b.sourceSnapshotDigest&&a.objectSnapshotHash===b.objectSnapshotHash&&a.playbookVersion===b.playbookVersion&&a.paramFingerprint===b.paramFingerprint&&a.targetFingerprint===b.targetFingerprint}
function sameTargetSet(a:readonly string[],b:readonly string[]):boolean{return a.length===b.length&&a.every(target=>b.includes(target))}
function sameJson(a:Record<string,unknown>,b:Record<string,unknown>):boolean{return stableJson(a)===stableJson(b)}
function executionMatchesAction(execution:SecurityExecutionState,action:SecurityActionState):boolean{return execution==='dispatching'||execution==='accepted'?action==='executing':execution===action}
