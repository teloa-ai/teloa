import {WorkError} from './work-error.ts'
import {taskInput} from './tasks.ts'
export const taskRunReconcileEndReasons=['completed','aborted','blocked','error','max-tokens','interrupted'] as const
/** 普通原生终态仅表示执行收口；不代表业务成功或用量结清。forked与未知扩展不授予延期记账。 */
export function isTaskRunReconcileEndReason(reason:string):boolean{return taskRunReconcileEndReasons.some(kind=>kind===reason)}
export type AcceptedInboxErrorAnchor={kind:'accepted-inbox-error';acceptedSeq:number;turnStartSeq:number;consumedSeq:number;messageId:string;payloadSha256:string;inputSha256:string;prefixSha256:string;errorSha256:string}
export type AcceptedInboxErrorEvidence={state:'ended';turn:number;/** 此分支等于acceptedSeq，明确不是user/message。 */messageSeq:number;endSeq:number;reason:'error';inputAnchor:AcceptedInboxErrorAnchor}
export type AcceptedInboxInterruptedAnchor=Omit<AcceptedInboxErrorAnchor,'kind'|'errorSha256'>&{kind:'accepted-inbox-interrupted';resumeSealSeq:number;reasonSha256:string}
export type AcceptedInboxInterruptedEvidence={state:'ended';turn:number;/** 受理序号，不是未曾发布的user/message。 */messageSeq:number;/** 始终指官方turn/end，恢复封口另由resumeSealSeq绑定。 */endSeq:number;reason:'interrupted';inputAnchor:AcceptedInboxInterruptedAnchor}
export type AcceptedInboxFailureEvidence=AcceptedInboxErrorEvidence|AcceptedInboxInterruptedEvidence
export type TaskRunEvidence={state:'accepted'}|{state:'active';turn:number;messageSeq:number}|{state:'ended';turn:number;messageSeq:number;endSeq:number;reason:string;inputAnchor?:never}|AcceptedInboxFailureEvidence
/** 只用于完整证明前缀；不改变通用endSeq的turn/end语义。 */
export function taskRunEvidenceProofEnd(evidence:Extract<TaskRunEvidence,{state:'ended'}>):number{return evidence.inputAnchor?.kind==='accepted-inbox-interrupted'?evidence.inputAnchor.resumeSealSeq:evidence.endSeq}
const natural=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0
/** 仅接收宿主从原生日志/发送回执得到的事实，不接收浏览器自报运行状态。 */
export function runEvidence(input:unknown):TaskRunEvidence{
 const row=taskInput(input,['state','turn','messageSeq','endSeq','reason','inputAnchor'])
 if(row.state==='accepted'){
  taskInput(row,['state']);return {state:'accepted'}
 }
 if(typeof row.state!=='string'||!['active','ended'].includes(row.state)||!natural(row.turn)||!natural(row.messageSeq))throw new WorkError('teloa/invalid-input','执行证据轮次或序号无效。')
 if(row.state==='active'){
  taskInput(row,['state','turn','messageSeq']);return {state:'active',turn:row.turn as number,messageSeq:row.messageSeq as number}
 }
 if(!natural(row.endSeq)||(row.endSeq as number)<=(row.messageSeq as number)||typeof row.reason!=='string'||!row.reason.trim()||row.reason.length>128)throw new WorkError('teloa/invalid-input','执行终止证据无效。')
 if(row.inputAnchor!==undefined){
  if(taskInput(row.inputAnchor,['kind','acceptedSeq','turnStartSeq','consumedSeq','messageId','payloadSha256','inputSha256','prefixSha256','errorSha256','resumeSealSeq','reasonSha256']).kind==='accepted-inbox-interrupted'){
   const a=taskInput(row.inputAnchor,['kind','acceptedSeq','turnStartSeq','consumedSeq','messageId','payloadSha256','inputSha256','prefixSha256','resumeSealSeq','reasonSha256'])
   if(row.reason!=='interrupted'||![a.acceptedSeq,a.turnStartSeq,a.consumedSeq,a.resumeSealSeq].every(natural)||a.acceptedSeq!==row.messageSeq||a.resumeSealSeq!==Number(row.endSeq)+1||!(Number(a.acceptedSeq)<Number(a.turnStartSeq)&&Number(a.turnStartSeq)<Number(a.consumedSeq)&&Number(a.consumedSeq)<Number(row.endSeq))||typeof a.messageId!=='string'||!a.messageId||a.messageId.length>128||![a.payloadSha256,a.inputSha256,a.prefixSha256,a.reasonSha256].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)))throw new WorkError('teloa/invalid-input','原生受理中断证据不完整。')
   return {state:'ended',turn:row.turn as number,messageSeq:row.messageSeq as number,endSeq:row.endSeq as number,reason:'interrupted',inputAnchor:{kind:'accepted-inbox-interrupted',acceptedSeq:a.acceptedSeq as number,turnStartSeq:a.turnStartSeq as number,consumedSeq:a.consumedSeq as number,resumeSealSeq:a.resumeSealSeq as number,messageId:a.messageId,payloadSha256:a.payloadSha256 as string,inputSha256:a.inputSha256 as string,prefixSha256:a.prefixSha256 as string,reasonSha256:a.reasonSha256 as string}}
  }
  const a=taskInput(row.inputAnchor,['kind','acceptedSeq','turnStartSeq','consumedSeq','messageId','payloadSha256','inputSha256','prefixSha256','errorSha256'])
  if(a.kind!=='accepted-inbox-error'||row.reason!=='error'||![a.acceptedSeq,a.turnStartSeq,a.consumedSeq].every(natural)||a.acceptedSeq!==row.messageSeq||!(Number(a.acceptedSeq)<Number(a.turnStartSeq)&&Number(a.turnStartSeq)<Number(a.consumedSeq)&&Number(a.consumedSeq)<Number(row.endSeq))||typeof a.messageId!=='string'||!a.messageId||a.messageId.length>128||![a.payloadSha256,a.inputSha256,a.prefixSha256,a.errorSha256].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)))throw new WorkError('teloa/invalid-input','原生受理失败证据不完整。')
  return {state:'ended',turn:row.turn as number,messageSeq:row.messageSeq as number,endSeq:row.endSeq as number,reason:'error',inputAnchor:{kind:'accepted-inbox-error',acceptedSeq:a.acceptedSeq as number,turnStartSeq:a.turnStartSeq as number,consumedSeq:a.consumedSeq as number,messageId:a.messageId,payloadSha256:a.payloadSha256 as string,inputSha256:a.inputSha256 as string,prefixSha256:a.prefixSha256 as string,errorSha256:a.errorSha256 as string}}
 }
 return {state:'ended',turn:row.turn as number,messageSeq:row.messageSeq as number,endSeq:row.endSeq as number,reason:row.reason}
}
export function mergeRunEvidence(previous:TaskRunEvidence|null,next:TaskRunEvidence):TaskRunEvidence{
 if(!previous||previous.state==='accepted')return next
 if(next.state==='accepted')return previous
 const before=previous.state==='ended'?previous.inputAnchor:undefined,after=next.state==='ended'?next.inputAnchor:undefined
 if((before===undefined)!==(after===undefined)||before&&after&&Object.keys(before).some(key=>Reflect.get(before,key)!==Reflect.get(after,key)))throw new WorkError('teloa/conflict','执行输入证据锚点不能改变。')
 if(previous.turn!==next.turn||previous.messageSeq!==next.messageSeq)throw new WorkError('teloa/conflict','执行证据指向不同原生轮次。')
 if(previous.state==='ended'){
  if(next.state==='ended'&&(previous.endSeq!==next.endSeq||previous.reason!==next.reason))throw new WorkError('teloa/conflict','执行终止证据不一致。')
  return previous
 }
 return next
}
