import {WorkError} from './work-error.ts'

/** 只由真实 Run、当前宿主与持久控制派生，客户端不能提供此绑定。 */
export type GoalRunBinding={ownerId:string;runId:string;sessionId:string;goalId:string;revision:number;hostGeneration:number;controlId:string;controlGeneration:number}
export type GoalContinuationReceipt=GoalRunBinding&{round:number;messageId:string;nativeRequestId:string;payloadSha256:string;acceptedSeq:number|null;state:'reserved'|'accepted'|'unknown'|'withdrawn'}
export type GoalObservationContext={binding:GoalRunBinding;continuations:readonly GoalContinuationReceipt[];goalPhase:'active'|'paused'|'blocked'|'complete';activation:'armed'|'disarmed';pendingRound:boolean;childrenOutstanding:boolean}
const bindingKeys=['ownerId','runId','sessionId','goalId','revision','hostGeneration','controlId','controlGeneration'] as const
const receiptKeys=[...bindingKeys,'round','messageId','nativeRequestId','payloadSha256','acceptedSeq','state'] as const
const fail=()=>new WorkError('teloa/invalid-input','Goal 执行绑定或续轮票据不正确。')
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0
const text=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim()&&v.length<=256&&!/[\x00-\x1f]/.test(v)
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!keys.includes(key)))throw fail();return value as Record<string,unknown>}
function binding(value:Record<string,unknown>):GoalRunBinding{
 if(!['ownerId','runId','sessionId','goalId','controlId'].every(key=>text(value[key]))||!['revision','hostGeneration','controlGeneration'].every(key=>positive(value[key])))throw fail()
 return {ownerId:value.ownerId as string,runId:value.runId as string,sessionId:value.sessionId as string,goalId:value.goalId as string,revision:value.revision as number,hostGeneration:value.hostGeneration as number,controlId:value.controlId as string,controlGeneration:value.controlGeneration as number}
}
export function readGoalRunBinding(value:unknown):GoalRunBinding{return binding(exact(value,bindingKeys))}
export function readGoalContinuationReceipt(value:unknown):GoalContinuationReceipt{
 const r=exact(value,receiptKeys),b=binding(r)
 if(!positive(r.round)||!text(r.messageId)||!text(r.nativeRequestId)||typeof r.payloadSha256!=='string'||!/^[a-f0-9]{64}$/.test(r.payloadSha256)||!['reserved','accepted','unknown','withdrawn'].includes(r.state as string)||!(r.acceptedSeq===null||Number.isSafeInteger(r.acceptedSeq)&&Number(r.acceptedSeq)>=0)||((r.state==='accepted')!==(r.acceptedSeq!==null)))throw fail()
 return {...b,round:r.round,messageId:r.messageId,nativeRequestId:r.nativeRequestId,payloadSha256:r.payloadSha256,acceptedSeq:r.acceptedSeq as number|null,state:r.state as GoalContinuationReceipt['state']}
}
