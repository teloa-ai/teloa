import {createHash,createHmac,randomUUID} from 'node:crypto'
import {WorkError,hardwareOperationId,hardwareRecord} from '@teloa/contract'

export type DevicePairingJob=Readonly<{id:string;state:'awaiting-device'|'ready'|'paired'|'cancelled';createdAt:number;expiresAt:number;allowApprovals:boolean;assistantSessionId:string;contextVersion:number;nonce?:string;digest?:string}>
type Ports=Readonly<{secret:Uint8Array;host:string;port:number;serverName:string;ca:string;now?:()=>number;latest?:()=>Promise<DevicePairingJob|undefined>;target:()=>Promise<{assistantSessionId:string;contextVersion:number}>;save:(job:DevicePairingJob)=>Promise<void>;load:(id:string)=>Promise<DevicePairingJob|undefined>;finish:(job:DevicePairingJob,input:{id:string;assistantSessionId:string;contextVersion:number;credentialDigest:string;allowApprovals:boolean})=>Promise<unknown>}>
const denied=()=>new WorkError('teloa/forbidden','配对意图已过期、取消或不属于当前设备。')
export const deriveDeviceCredential=(secret:Uint8Array,id:string)=>createHmac('sha256',secret).update('teloa-device-credential/v1\0'+id).digest('base64url')
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
/** 只有本人管理端创建意图；IPC输出秘密只交串口内存流，不返回浏览器。 */
export function createDevicePairing(ports:Ports){
 if(ports.secret.length!==32)throw denied()
 const now=ports.now??Date.now
 let chain:Promise<unknown>=Promise.resolve()
 let currentId:string|undefined
 const serial=<T>(operation:()=>Promise<T>)=>{const next=chain.then(operation,operation);chain=next.catch(()=>{});return next}
 const validate=(job:DevicePairingJob|undefined)=>{
  if(!job||!hardwareOperationId(job.id)||!['awaiting-device','ready','paired','cancelled'].includes(job.state)||typeof job.allowApprovals!=='boolean'||!hardwareOperationId(job.assistantSessionId)||!Number.isSafeInteger(job.contextVersion)||job.contextVersion<1||!Number.isSafeInteger(job.createdAt)||job.expiresAt!==job.createdAt+300000||job.nonce!==undefined&&!hardwareOperationId(job.nonce)||job.digest!==undefined&&!/^[a-f0-9]{64}$/.test(job.digest)||['ready','paired'].includes(job.state)&&(!job.nonce||!job.digest))throw denied()
  return job
 }
 const load=async(id:string)=>{if(!hardwareOperationId(id))throw denied();const job=validate(await ports.load(id));if(job.id!==id)throw denied();return job}
 const live=(job:DevicePairingJob)=>{if(job.state==='cancelled'||job.expiresAt<=now())throw denied()}
 const configuration=(job:DevicePairingJob)=>JSON.stringify({schema:1,device_id:job.id,host:ports.host,port:ports.port,server_name:ports.serverName,ca:ports.ca,credential:deriveDeviceCredential(ports.secret,job.id),unix_time:Math.floor(job.createdAt/1000)})
 const publicJob=(job:DevicePairingJob)=>({id:job.id,state:job.state,expiresAt:job.expiresAt,allowApprovals:job.allowApprovals,host:ports.host,serverName:ports.serverName})
 const latest=async()=>{const stored=currentId?await ports.load(currentId):await ports.latest?.();const current=stored?validate(stored):undefined;return current&&['awaiting-device','ready'].includes(current.state)&&current.expiresAt>now()?current:undefined}
 const targetCurrent=async(job:DevicePairingJob)=>{const target=await ports.target();if(target.assistantSessionId!==job.assistantSessionId||target.contextVersion!==job.contextVersion)throw denied()}
 return Object.freeze({
  begin:(value:unknown)=>serial(async()=>{
   const row=hardwareRecord(value,['allowApprovals']);if(typeof row.allowApprovals!=='boolean')throw denied()
   const original=await latest();if(original){if(original.allowApprovals!==row.allowApprovals)throw denied();return publicJob(original)}
   const target=await ports.target(),stamp=now(),job:DevicePairingJob={id:randomUUID(),state:'awaiting-device',createdAt:stamp,expiresAt:stamp+300000,allowApprovals:row.allowApprovals,...target}
   await ports.save(job);currentId=job.id;return publicJob(job)
  }),
  status:async(id?:string)=>{const job=id?await load(id):await latest();return job?publicJob(job):null},
  provision:(id:string,input:{nonce:string;confirmed:boolean})=>serial(async()=>{
   let job=await load(id);live(job)
   await targetCurrent(job);live(job)
   if(job.state==='paired'||input.confirmed!==true||!hardwareOperationId(input.nonce)||job.nonce&&job.nonce!==input.nonce)throw denied()
   const config=configuration(job),digest=hash(config)
   job={...job,state:'ready',nonce:input.nonce,digest};await ports.save(job)
   return {configuration:config,digest}
  }),
  complete:(id:string,digest:string)=>serial(async()=>{
   const job=await load(id);if(job.state==='paired'){if(job.digest!==digest)throw denied();return publicJob(job)}
   live(job);if(job.state!=='ready'||job.digest!==digest)throw denied()
   await targetCurrent(job);live(job)
   const completed={...job,state:'paired' as const}
   await ports.finish(completed,{id:job.id,assistantSessionId:job.assistantSessionId,contextVersion:job.contextVersion,credentialDigest:hash(deriveDeviceCredential(ports.secret,job.id)),allowApprovals:job.allowApprovals})
   return publicJob(completed)
  }),
  cancel:(id:string)=>serial(async()=>{const job=await load(id);if(job.state==='paired')throw denied();const cancelled={...job,state:'cancelled' as const};await ports.save(cancelled);return publicJob(cancelled)}),
 })
}
