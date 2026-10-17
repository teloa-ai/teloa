import {hardwareRecord,hardwareScopes,type HardwareScope} from '@teloa/contract'
export type HardwareConnectionStatus={available:false}|{available:true;configured:boolean;writable:boolean;state:'idle'|'connecting'|'ready'|'retrying'|'failed'|'stopped';authorization:{enabled:boolean;grantVersion:number;scopes:readonly HardwareScope[];assistantName:string}}
const invalid=()=>new Error('硬件连接状态无法核对。')
export function readHardwareStatus(value:unknown):HardwareConnectionStatus{
 const row=hardwareRecord(value,['available','configured','writable','state','authorization'])
 if(row.available===false&&Object.keys(row).length===1)return {available:false}
 if(row.available!==true||typeof row.configured!=='boolean'||typeof row.writable!=='boolean'||!['idle','connecting','ready','retrying','failed','stopped'].includes(String(row.state)))throw invalid()
 const grant=hardwareRecord(row.authorization,['enabled','grantVersion','scopes','assistantName'])
 if(typeof grant.enabled!=='boolean'||!Number.isSafeInteger(grant.grantVersion)||Number(grant.grantVersion)<0||typeof grant.assistantName!=='string'||grant.assistantName.length>120||!Array.isArray(grant.scopes)||grant.scopes.some(scope=>!hardwareScopes.includes(scope))||new Set(grant.scopes).size!==grant.scopes.length)throw invalid()
 return row as HardwareConnectionStatus
}
export function createHardwareDevicesApi(call:(endpoint:string,payload:unknown)=>Promise<unknown>){
 const invoke=async(endpoint:string,payload:unknown={})=>readHardwareStatus(await call(endpoint,payload))
 return {status:()=>invoke('devices/status'),save:(endpoint:string)=>invoke('devices/mcp/save',{endpoint}),enable:()=>invoke('devices/grant/update',{scopes:[...hardwareScopes]}),test:()=>invoke('devices/mcp/test'),revoke:()=>invoke('devices/revoke'),direct:{
  status:async()=>readDirectDeviceStatus(await call('devices/direct/status',{})),
  begin:async(allowApprovals:boolean)=>readPairingJob(await call('devices/pairing/begin',{allowApprovals})),
  pairing:async(id?:string)=>readPairingJob(await call('devices/pairing/status',id?{id}:{})),
  cancel:async(id:string)=>readPairingJob(await call('devices/pairing/cancel',{id})),
  revoke:async(bindingId:string)=>{await call('devices/direct/revoke',{bindingId})},
 }}
}
export type PairingJob={id:string;state:'awaiting-device'|'ready'|'paired'|'cancelled';expiresAt:number;allowApprovals:boolean;host:string;serverName:string}
export type DirectDeviceStatus={enabled:boolean;devices:readonly {id:string;status:'active'|'revoked';grantVersion:number;assistantSessionId:string;allowApprovals:boolean}[];helper:{script:string;socket:string}|null}
export function readPairingJob(value:unknown):PairingJob|null{
 if(value===null)return null
 const row=hardwareRecord(value,['id','state','expiresAt','allowApprovals','host','serverName'])
 if(typeof row.id!=='string'||!['awaiting-device','ready','paired','cancelled'].includes(String(row.state))||!Number.isSafeInteger(row.expiresAt)||typeof row.allowApprovals!=='boolean'||typeof row.host!=='string'||typeof row.serverName!=='string')throw invalid()
 return row as PairingJob
}
export function readDirectDeviceStatus(value:unknown):DirectDeviceStatus{
 const row=hardwareRecord(value,['enabled','devices','helper'])
 if(typeof row.enabled!=='boolean'||!Array.isArray(row.devices))throw invalid()
 for(const item of row.devices){const device=hardwareRecord(item,['id','status','grantVersion','assistantSessionId','allowApprovals']);if(typeof device.id!=='string'||!['active','revoked'].includes(String(device.status))||!Number.isSafeInteger(device.grantVersion)||typeof device.assistantSessionId!=='string'||typeof device.allowApprovals!=='boolean')throw invalid()}
 if(row.helper!==null){const helper=hardwareRecord(row.helper,['script','socket']);if(typeof helper.script!=='string'||typeof helper.socket!=='string')throw invalid()}
 return row as DirectDeviceStatus
}
export type HardwareDevicesApi=ReturnType<typeof createHardwareDevicesApi>
