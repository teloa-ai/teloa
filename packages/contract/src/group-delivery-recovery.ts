import {WorkError} from './work-error.ts'
import {taskInput} from './tasks.ts'

export const groupDeliveryRecoveryEndpoints=['groups/delivery/inspect','groups/delivery/recover','groups/delivery/receipt'] as const
export type GroupDeliveryRecoveryTarget={groupId:string;messageId:string;roleId:string}
export type GroupDeliveryRecoveryCommand=GroupDeliveryRecoveryTarget&{requestId:string;itemId:string;expectedBasisSha256:string;capability:'text'|'analysis'}
export type GroupDeliveryRecoveryCandidate={schema:'teloa.group-delivery-recovery-candidate/v1';target:GroupDeliveryRecoveryTarget;itemId:string;taskId:string;taskTitle:string;basisSha256:string;materials:{id:string;title:string;version:number;sha256:string}[];files?:{kind:'attachment'|'artifact';id:string;title:string;version:number;sha256:string;bytes:number;mime:string}[];reason:'text-capability-required'|'text-capability-reconfirmation-required'|'analysis-capability-required'|'analysis-capability-reconfirmation-required';controlRebinding?:{kind:'planned-restart';restartCount:number};reconfirmation?:{previousRecoveryId:string;previousConfirmedAt:string}}
export type GroupDeliveryRecoveryReceipt={schema:'teloa.group-delivery-recovery-receipt/v1';requestId:string;recoveryId:string;itemId:string;groupId:string;messageId:string;taskId:string;dispatchRequestId:string;state:'pending';capability:'text'|'analysis';confirmedAt:string}
export type GroupDeliveryRecoveryCheck={schema:'teloa.group-delivery-recovery-check/v1';state:'accepted';receipt:GroupDeliveryRecoveryReceipt}|{schema:'teloa.group-delivery-recovery-check/v1';state:'not-accepted';command:GroupDeliveryRecoveryCommand;recordedAt:string;reason:'teloa/conflict'|'teloa/forbidden'|'teloa/version-conflict'}|{schema:'teloa.group-delivery-recovery-check/v1';state:'unobserved';command:GroupDeliveryRecoveryCommand}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
export function groupDeliveryRecoveryTarget(value:unknown):GroupDeliveryRecoveryTarget{
 const row=taskInput(value,['groupId','messageId','roleId']);if(!uuid(row.groupId)||!uuid(row.messageId)||!uuid(row.roleId))throw new WorkError('teloa/invalid-input','请选择当前群原工作中的员工。')
 return {groupId:row.groupId,messageId:row.messageId,roleId:row.roleId}
}
export function groupDeliveryRecoveryCommand(value:unknown):GroupDeliveryRecoveryCommand{
 const row=taskInput(value,['groupId','messageId','roleId','requestId','itemId','expectedBasisSha256','capability']),target=groupDeliveryRecoveryTarget({groupId:row.groupId,messageId:row.messageId,roleId:row.roleId})
 if(!uuid(row.requestId)||!uuid(row.itemId)||!['text','analysis'].includes(String(row.capability))||typeof row.expectedBasisSha256!=='string'||!/^[a-f0-9]{64}$/.test(row.expectedBasisSha256))throw new WorkError('teloa/invalid-input','请核对原工作和受限文本能力后继续。')
 return {...target,requestId:row.requestId,itemId:row.itemId,expectedBasisSha256:row.expectedBasisSha256,capability:row.capability as 'text'|'analysis'}
}
