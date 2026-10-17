import {WorkError} from './work-error.ts'

export type HardwareScope='assistant.send'|'reply.read'|'task.prepare'
export const hardwareScopes:readonly HardwareScope[]=['assistant.send','reply.read','task.prepare']
export type HardwareBinding=Readonly<{id:string;ownerId:string;installationId:string;transport:'xiaozhi-mcp';assistantSessionId:string;contextVersion:number;grantVersion:number;status:'active'|'revoked';scopes:readonly HardwareScope[]}>
export type HardwareResultRef=Readonly<{nativeRequestId:string;messageId:string;endSeq:number}>
export type HardwareOperation=Readonly<{id:string;bindingId:string;grantVersion:number;nativeRequestId:string;text:string;textDigest:string;state:'prepared'|'dispatching'|'accepted'|'rejected'|'unknown';createdAt:string;expiresAt:string;resultRef:HardwareResultRef|null}>
export type HardwareReceipt=Readonly<{operationId:string;state:'prepared'|'pending'|'needs_approval'|'completed'|'unknown'|'rejected';speakableText:string;resultRef:HardwareResultRef|null;expiresAt?:string;assistantName?:string}>
export type HardwareRequestPort=Readonly<{prepare:(text:string)=>Promise<HardwareReceipt>;submit:(operationId:string,signal?:AbortSignal)=>Promise<HardwareReceipt>;result:(operationId?:string)=>Promise<HardwareReceipt>}>
export const hardwareEndpoints=['devices/status','devices/mcp/save','devices/mcp/test','devices/grant/update','devices/revoke'] as const
export const directDeviceEndpoints=['devices/direct/status','devices/direct/revoke','devices/pairing/begin','devices/pairing/status','devices/pairing/cancel'] as const
const invalid=()=>new WorkError('teloa/invalid-input','硬件连接请求不正确。')
export const hardwareOperationId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
export function hardwareRecord(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw invalid()
 const fields=Object.getOwnPropertyDescriptors(value)
 if(Reflect.ownKeys(value).some(key=>typeof key!=='string'||!keys.includes(key)||!('value' in fields[key]!)))throw invalid()
 return value as Record<string,unknown>
}
export function readHardwarePrepare(value:unknown):{text:string}{
 const row=hardwareRecord(value,['text'])
 if(typeof row.text!=='string')throw invalid()
 const text=row.text.trim()
 if(!text||Array.from(text).length>4000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))throw invalid()
 return {text}
}
export function readHardwareOperationId(value:unknown,optional=false):{operationId?:string}{
 const row=hardwareRecord(value,['operationId'])
 if(optional&&Object.keys(row).length===0)return {}
 if(!hardwareOperationId(row.operationId))throw invalid()
 return {operationId:row.operationId.toLowerCase()}
}
