import {WorkError} from '@teloa/contract'
import {runEvidence,type AcceptedInboxFailureEvidence} from './task-run-evidence.ts'

export type StoppedInboxErrorIssuer=Readonly<{kind:'stopped-session-writer-maintenance';originalRuntimeId:string;maintenanceRuntimeId:string;physicalSha256:string}>
export type AcceptedInboxErrorFence=Readonly<{issuer?:StoppedInboxErrorIssuer;runId:string;sessionId:string;nativeRequestId:string;runtimeId:string;inputSha256:string;endedAt:string;evidence:AcceptedInboxFailureEvidence}>
const fences=new WeakMap<AcceptedInboxErrorFence,()=>void>()
const denied=()=>new WorkError('teloa/conflict','原受理输入的失败与实际资源尚未核清，不能结束或重复派发。')
/** 仅原Agent冻结或正常独占writer维护闭包签发；同形JSON不能取得内部记账资格。 */
export async function withAcceptedInboxErrorFence<T>(input:AcceptedInboxErrorFence,assertCurrent:()=>void,work:(fence:AcceptedInboxErrorFence)=>Promise<T>):Promise<T>{
 const evidence=runEvidence(input.evidence)
 if(typeof input.endedAt!=='string'||!Number.isFinite(Date.parse(input.endedAt))||new Date(input.endedAt).toISOString()!==input.endedAt||evidence.state!=='ended'||!evidence.inputAnchor||evidence.inputAnchor.inputSha256!==input.inputSha256)throw denied()
 const uuid=(v:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
 if(input.issuer&&(Object.keys(input.issuer).length!==4||input.issuer.kind!=='stopped-session-writer-maintenance'||input.issuer.originalRuntimeId!==input.runtimeId||!uuid(input.issuer.originalRuntimeId)||!uuid(input.issuer.maintenanceRuntimeId)||!/^[a-f0-9]{64}$/.test(input.issuer.physicalSha256)))throw denied()
 const issuer=input.issuer?Object.freeze({...input.issuer}):undefined
 Object.freeze(evidence.inputAnchor);Object.freeze(evidence)
 const fence=Object.freeze({...input,...issuer?{issuer}:{},evidence}) as AcceptedInboxErrorFence
 fences.set(fence,assertCurrent)
 try{assertAcceptedInboxErrorFence(fence);return await work(fence)}finally{fences.delete(fence)}
}
export function assertAcceptedInboxErrorFence(fence:AcceptedInboxErrorFence):void{
 const check=fences.get(fence);if(!check)throw denied()
 const result:unknown=check();if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw denied()}
}
