import {open,lstat} from 'node:fs/promises'
import {constants} from 'node:fs'
import {isAbsolute,join} from 'node:path'
import {hardwareRecord,hardwareOperationId,WorkError} from '@teloa/contract'
import type {DirectDeviceBinding} from '@teloa/backend'

export type DirectDeviceConfig=Readonly<{listen:{host:string;port:number};tlsKeyFile:string;tlsCertFile:string;vadModelPath:string;devices:readonly Pick<DirectDeviceBinding,'id'|'assistantSessionId'|'contextVersion'|'credentialDigest'>[]}>
/** 只读核对固定工具入口；npm安装没有固件工具时不展示不存在的配对命令，也不影响已配对设备。 */
export async function readDevicePairingHelper(projectRoot:string,socket:string):Promise<{script:string;socket:string}|null>{
 const script=join(projectRoot,'firmware/esp32/tools/pair.py')
 try{return (await lstat(script)).isFile()?{script,socket}:null}catch{return null}
}
const invalid=()=>new WorkError('teloa/unavailable','设备直连配置无法核对，请检查本机配置。')
export async function readDevicePrivateFile(path:string,maxBytes=65536):Promise<Buffer>{
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
 try{
  const stat=await file.stat()
  if(!stat.isFile()||stat.nlink!==1||stat.mode&0o077||process.getuid&&stat.uid!==process.getuid()||stat.size>maxBytes)throw invalid()
  const bytes=await file.readFile();if(bytes.length>maxBytes)throw invalid();return bytes
 }finally{await file.close()}
}
/** 没有本机显式配置时完全关闭；不读取环境中的地址或回退到工作台端口。 */
export async function readDirectDeviceConfig(runtimeRoot:string):Promise<DirectDeviceConfig|null>{
 let bytes:Buffer
 try{bytes=await readDevicePrivateFile(join(runtimeRoot,'direct-device.json'))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw invalid()}
 try{
  const row=hardwareRecord(JSON.parse(bytes.toString('utf8')),['enabled','listen','tlsKeyFile','tlsCertFile','vadModelPath','devices'])
  if(row.enabled===false)return null
  const listen=hardwareRecord(row.listen,['host','port'])
  if(row.enabled!==true||typeof listen.host!=='string'||!Number.isInteger(listen.port)||!Array.isArray(row.devices)||row.devices.length>16)throw invalid()
  for(const key of ['tlsKeyFile','tlsCertFile','vadModelPath'])if(typeof row[key]!=='string'||!isAbsolute(row[key] as string))throw invalid()
  const devices=row.devices.map(value=>{
   const item=hardwareRecord(value,['id','assistantSessionId','contextVersion','credentialDigest'])
   if(!hardwareOperationId(item.id)||!hardwareOperationId(item.assistantSessionId)||!Number.isSafeInteger(item.contextVersion)||Number(item.contextVersion)<1||typeof item.credentialDigest!=='string'||!/^[a-f0-9]{64}$/.test(item.credentialDigest))throw invalid()
   return item as DirectDeviceConfig['devices'][number]
  })
  if(new Set(devices.map(item=>item.id)).size!==devices.length)throw invalid()
  return {listen:listen as DirectDeviceConfig['listen'],tlsKeyFile:row.tlsKeyFile as string,tlsCertFile:row.tlsCertFile as string,vadModelPath:row.vadModelPath as string,devices}
 }catch{throw invalid()}
}
