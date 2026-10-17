import {WorkError} from './work-error.ts'

export type VoiceUnavailableReason='provider-unconfigured'|'provider-unavailable'|'microphone-unavailable'
export type VoiceReadiness=Readonly<{status:'ready';providerId:string}|{status:'unavailable';providerId:string|null;reason:VoiceUnavailableReason}>
export type VoiceCallState='idle'|'connecting'|'connected'|'reconnecting'|'ended'|'failed'
export type VoiceFailureReason=VoiceUnavailableReason|'microphone-denied'|'connection-failed'|'connection-lost'|'authorization-changed'|'media-close-failed'
/** 只包含当前本人可比对的身份/范围标识，不承载权限材料或提供方凭据。 */
type VoiceContextBase=Readonly<{ownerId:string;sessionId:string;scope:string}>
export type RoleVoiceCallContext=VoiceContextBase&Readonly<{target?:'role';roleId:string;roleKind:'employee'|'twin';roleVersion:number}>
export type AssistantVoiceCallContext=VoiceContextBase&Readonly<{target:'assistant';scope:'general';contextVersion:number}>
export type VoiceCallContext=RoleVoiceCallContext|AssistantVoiceCallContext
export type RoleVoiceCallStartInput=Readonly<{requestId:string;target?:'role';roleId:string;expectedRoleVersion:number;sessionId:string}>
export type AssistantVoiceCallStartInput=Readonly<{requestId:string;target:'assistant';expectedContextVersion:number;sessionId:string}>
export type VoiceCallStartInput=RoleVoiceCallStartInput|AssistantVoiceCallStartInput
export type AssistantVoiceNoteInput=Readonly<{requestId:string;sessionId:string;expectedContextVersion:number;audio:string}>
export type AssistantVoiceNoteResult=Readonly<{requestId:string;sessionId:string;contextVersion:number;text:string|null}>
export type VoiceCallIdInput=Readonly<{callId:string}>
export type VoiceCallRequestInput=Readonly<{requestId:string}>
export type VoiceCallEndByRequestResult=Readonly<{requestId:string;cancelled:true;call:VoiceCall|null}>
export type VoiceCallMutedInput=Readonly<{callId:string;callGeneration:string;muted:boolean}>
export type VoiceCallMutedResult=VoiceCallMutedInput
export type VoiceCall=Readonly<VoiceCallContext&{id:string;requestId:string;callGeneration:string;state:VoiceCallState;readiness:VoiceReadiness;playbackGeneration:number;playback:'idle'|'playing';createdAt:string;endedAt:string|null;failure:VoiceFailureReason|null}>
export type VoiceTranscriptSource=Readonly<{kind:'sealed-audio-stt';providerId:string;audioSha256:string;sealReceiptId:string;sttReceiptId:string}>
/** 仅能由可信宿主的封口/STT 回执读口提供；结构校验本身不授予可信生产者身份。 */
export type VoiceTranscriptSeal=Readonly<VoiceCallContext&{callId:string;callGeneration:string;turnId:string;speaker:'owner';source:VoiceTranscriptSource;revision:number;text:string;closed:true;complete:true;producerReceipt:string}>
export type TranscriptCommit=Readonly<VoiceTranscriptSeal&{id:string;contentSha256:string}>
export type VoiceTranscriptCommitInput=Readonly<{callId:string;turnId:string;revision:number;producerReceipt:string}>
export type VoiceTranscriptCandidate=Readonly<{callGeneration:string;sessionId:string;turnId:string;revision:number;text:string}>
export const voiceCallEndpoints=['voice-calls/readiness','voice-calls/start','voice-calls/get','voice-calls/end','voice-calls/interrupt','voice-calls/get-by-request','voice-calls/end-by-request','voice-calls/set-muted'] as const

const contextKeys=['ownerId','roleId','roleKind','roleVersion','sessionId','scope'] as const
const sealFields=['callId','callGeneration','turnId','speaker','source','revision','text','closed','complete','producerReceipt'] as const
const unavailableReasons=['provider-unconfigured','provider-unavailable','microphone-unavailable'] as const
const failureReasons=[...unavailableReasons,'microphone-denied','connection-failed','connection-lost','authorization-changed','media-close-failed'] as const
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const token=(value:unknown,max=128):value is string=>typeof value==='string'&&value.length<=max&&/^[a-zA-Z0-9_:-]+$/.test(value)
const provider=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_.-]{1,64}$/.test(value)
const session=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const version=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const text=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=65536&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const hostError=():never=>{throw new WorkError('teloa/invalid-host-response','语音服务回包不正确。')}
const inputError=():never=>{throw new WorkError('teloa/invalid-input','通话请求不正确。')}
function record(value:unknown,keys:readonly string[],error:()=>never):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))return error()
 const row=value as Record<string,unknown>
 const descriptors=Object.getOwnPropertyDescriptors(row)
 if(Reflect.ownKeys(row).length!==keys.length||Object.keys(descriptors).some(key=>!keys.includes(key)||!('value'in descriptors[key]!)))return error()
 return row
}
export const voiceCallContextKeys=(value:unknown):readonly string[]=>{
 const target=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'target')?.value:undefined
 return target==='assistant'?['ownerId','sessionId','scope','target','contextVersion']:[...contextKeys,...(target===undefined?[]:['target'])]
}
function context(row:Record<string,unknown>):VoiceCallContext{
 if(typeof row.ownerId!=='string'||!row.ownerId.trim()||row.ownerId!==row.ownerId.trim()||row.ownerId.length>128||/[\x00-\x1f\x7f]/.test(row.ownerId)||!session(row.sessionId)||typeof row.scope!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(row.scope))return hostError()
 if(row.target==='assistant'){
  if(row.scope!=='general'||!version(row.contextVersion))return hostError()
  return Object.freeze({ownerId:row.ownerId,sessionId:row.sessionId,scope:'general',target:'assistant',contextVersion:row.contextVersion})
 }
 if(row.target!==undefined&&row.target!=='role'||!uuid(row.roleId)||!['employee','twin'].includes(String(row.roleKind))||!version(row.roleVersion))return hostError()
 return Object.freeze({ownerId:row.ownerId,roleId:row.roleId.toLowerCase(),roleKind:row.roleKind as RoleVoiceCallContext['roleKind'],roleVersion:row.roleVersion,sessionId:row.sessionId,scope:row.scope,...(row.target==='role'?{target:'role' as const}:{})})
}
export function readVoiceCallContext(value:unknown):VoiceCallContext{return context(record(value,voiceCallContextKeys(value),hostError))}
/** 旧角色输入归一为明确 role 分支；助手从不借角色字段代表自己。 */
export function sameVoiceCallContext(a:VoiceCallContext,b:VoiceCallContext):boolean{
 if(a.ownerId!==b.ownerId||a.sessionId!==b.sessionId||a.scope!==b.scope)return false
 if(a.target==='assistant')return b.target==='assistant'&&a.contextVersion===b.contextVersion
 return b.target!=='assistant'&&a.roleId===b.roleId&&a.roleKind===b.roleKind&&a.roleVersion===b.roleVersion
}
export function voiceCallMatchesStart(context:VoiceCallContext,input:VoiceCallStartInput):boolean{
 if(context.sessionId!==input.sessionId)return false
 return input.target==='assistant'?context.target==='assistant'&&context.contextVersion===input.expectedContextVersion:context.target!=='assistant'&&context.roleId===input.roleId&&context.roleVersion===input.expectedRoleVersion
}
export function readVoiceReadiness(value:unknown):VoiceReadiness{
 if(!value||typeof value!=='object'||Array.isArray(value))return hostError()
 const row=record(value,(value as Record<string,unknown>).status==='ready'?['status','providerId']:['status','providerId','reason'],hostError)
 if(row.status==='ready'&&provider(row.providerId))return Object.freeze({status:'ready',providerId:row.providerId})
 if(row.status==='unavailable'&&(row.providerId===null||provider(row.providerId))&&unavailableReasons.includes(row.reason as VoiceUnavailableReason))return Object.freeze({status:'unavailable',providerId:row.providerId,reason:row.reason as VoiceUnavailableReason})
 return hostError()
}
export function voiceCallStartInput(value:unknown):VoiceCallStartInput{
 const target=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'target')?.value:undefined,assistant=target==='assistant',explicit=target!==undefined
 const row=record(value,assistant?['requestId','target','expectedContextVersion','sessionId']:['requestId','roleId','expectedRoleVersion','sessionId',...(explicit?['target']:[])],inputError)
 if(!uuid(row.requestId)||!session(row.sessionId))return inputError()
 if(assistant){if(!version(row.expectedContextVersion))return inputError();return Object.freeze({requestId:row.requestId.toLowerCase(),target:'assistant',expectedContextVersion:row.expectedContextVersion,sessionId:row.sessionId})}
 if(row.target!==undefined&&row.target!=='role'||!uuid(row.roleId)||!version(row.expectedRoleVersion))return inputError()
 return Object.freeze({requestId:row.requestId.toLowerCase(),roleId:row.roleId.toLowerCase(),expectedRoleVersion:row.expectedRoleVersion,sessionId:row.sessionId,...(row.target==='role'?{target:'role' as const}:{})})
}
export function assistantVoiceNoteInput(value:unknown):AssistantVoiceNoteInput{
 const row=record(value,['requestId','sessionId','expectedContextVersion','audio'],inputError)
 if(!uuid(row.requestId)||!session(row.sessionId)||!version(row.expectedContextVersion)||typeof row.audio!=='string'||!row.audio.length||row.audio.length>700000||row.audio.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(row.audio))return inputError()
 return Object.freeze({requestId:row.requestId.toLowerCase(),sessionId:row.sessionId,expectedContextVersion:row.expectedContextVersion,audio:row.audio})
}
export function readAssistantVoiceNoteResult(value:unknown):AssistantVoiceNoteResult{
 const row=record(value,['requestId','sessionId','contextVersion','text'],hostError)
 if(!uuid(row.requestId)||!session(row.sessionId)||!version(row.contextVersion)||row.text!==null&&!text(row.text))return hostError()
 return Object.freeze({requestId:row.requestId.toLowerCase(),sessionId:row.sessionId,contextVersion:row.contextVersion,text:row.text as string|null})
}
export function voiceCallIdInput(value:unknown):VoiceCallIdInput{
 const row=record(value,['callId'],inputError)
 if(!uuid(row.callId))return inputError()
 return Object.freeze({callId:row.callId.toLowerCase()})
}
export function voiceCallRequestInput(value:unknown):VoiceCallRequestInput{
 const row=record(value,['requestId'],inputError)
 if(!uuid(row.requestId))return inputError()
 return Object.freeze({requestId:row.requestId.toLowerCase()})
}
function mutedInput(value:unknown,error:()=>never):VoiceCallMutedInput{
 const row=record(value,['callId','callGeneration','muted'],error)
 if(!uuid(row.callId)||!uuid(row.callGeneration)||typeof row.muted!=='boolean')return error()
 return Object.freeze({callId:row.callId.toLowerCase(),callGeneration:row.callGeneration.toLowerCase(),muted:row.muted})
}
export function voiceCallMutedInput(value:unknown):VoiceCallMutedInput{return mutedInput(value,inputError)}
export function readVoiceCallMutedResult(value:unknown):VoiceCallMutedResult{return mutedInput(value,hostError)}
export function readVoiceCall(value:unknown):VoiceCall{
 const row=record(value,[...voiceCallContextKeys(value),'id','requestId','callGeneration','state','readiness','playbackGeneration','playback','createdAt','endedAt','failure'],hostError),parsed=context(row),readiness=readVoiceReadiness(row.readiness)
 if(!uuid(row.id)||!uuid(row.requestId)||!uuid(row.callGeneration)||!['idle','connecting','connected','reconnecting','ended','failed'].includes(String(row.state))||!Number.isSafeInteger(row.playbackGeneration)||Number(row.playbackGeneration)<0||!['idle','playing'].includes(String(row.playback))||!stamp(row.createdAt)||row.endedAt!==null&&(!stamp(row.endedAt)||row.endedAt<row.createdAt)||row.failure!==null&&!failureReasons.includes(row.failure as VoiceFailureReason))return hostError()
 const terminal=row.state==='ended'||row.state==='failed'
 if(terminal!==(row.endedAt!==null)||row.state==='failed'&&row.failure===null||row.state==='connected'&&readiness.status!=='ready'||terminal&&row.playback!=='idle')return hostError()
 return Object.freeze({...parsed,id:row.id.toLowerCase(),requestId:row.requestId.toLowerCase(),callGeneration:row.callGeneration.toLowerCase(),state:row.state as VoiceCallState,readiness,playbackGeneration:row.playbackGeneration as number,playback:row.playback as VoiceCall['playback'],createdAt:row.createdAt,endedAt:row.endedAt as string|null,failure:row.failure as VoiceFailureReason|null})
}
export function readVoiceCallByRequest(value:unknown):VoiceCall|null{return value===null?null:readVoiceCall(value)}
export function readVoiceCallEndByRequestResult(value:unknown):VoiceCallEndByRequestResult{
 const row=record(value,['requestId','cancelled','call'],hostError)
 if(!uuid(row.requestId)||row.cancelled!==true)return hostError()
 const call=readVoiceCallByRequest(row.call)
 if(call&&(call.requestId!==row.requestId.toLowerCase()||!['ended','failed'].includes(call.state)))return hostError()
 return Object.freeze({requestId:row.requestId.toLowerCase(),cancelled:true,call})
}
function transcriptSeal(row:Record<string,unknown>):VoiceTranscriptSeal{
 const parsed=context(row),source=record(row.source,['kind','providerId','audioSha256','sealReceiptId','sttReceiptId'],hostError)
 if(!uuid(row.callId)||!uuid(row.callGeneration)||!token(row.turnId)||row.speaker!=='owner'||!version(row.revision)||!text(row.text)||row.closed!==true||row.complete!==true||!token(row.producerReceipt,256)||source.kind!=='sealed-audio-stt'||!provider(source.providerId)||!hash(source.audioSha256)||!token(source.sealReceiptId,256)||!token(source.sttReceiptId,256))return hostError()
 return Object.freeze({...parsed,callId:row.callId.toLowerCase(),callGeneration:row.callGeneration.toLowerCase(),turnId:row.turnId,speaker:'owner',revision:row.revision,text:row.text,closed:true,complete:true,producerReceipt:row.producerReceipt,source:Object.freeze({kind:'sealed-audio-stt',providerId:source.providerId,audioSha256:source.audioSha256,sealReceiptId:source.sealReceiptId,sttReceiptId:source.sttReceiptId})})
}
export function readVoiceTranscriptSeal(value:unknown):VoiceTranscriptSeal{return transcriptSeal(record(value,[...voiceCallContextKeys(value),...sealFields],hostError))}
/** 只验证持久/传输结构；工作受理仍须回读可信生产者回执，不能把此函数当授权证明。 */
export function readTranscriptCommit(value:unknown):TranscriptCommit{
 const row=record(value,[...voiceCallContextKeys(value),...sealFields,'id','contentSha256'],hostError),seal=transcriptSeal(row)
 if(!uuid(row.id)||!hash(row.contentSha256))return hostError()
 return Object.freeze({...seal,id:row.id.toLowerCase(),contentSha256:row.contentSha256})
}
export function voiceTranscriptCommitInput(value:unknown):VoiceTranscriptCommitInput{
 const row=record(value,['callId','turnId','revision','producerReceipt'],inputError)
 if(!uuid(row.callId)||!token(row.turnId)||!version(row.revision)||!token(row.producerReceipt,256))return inputError()
 return Object.freeze({callId:row.callId.toLowerCase(),turnId:row.turnId,revision:row.revision,producerReceipt:row.producerReceipt})
}
