import {randomBytes,createHash,X509Certificate} from 'node:crypto'
import {open} from 'node:fs/promises'
import {constants} from 'node:fs'
import {join} from 'node:path'
import type {DirectDeviceStore} from '@teloa/backend'
import type {DirectDeviceConfig} from './direct-device-config.ts'
import {readDevicePrivateFile} from './direct-device-config.ts'
import {createDevicePairing,type DevicePairingJob} from './device-pairing.ts'
import {startDeviceProvisioningIpc} from './device-provisioning-ipc.ts'
import {startDeviceTime} from './device-time.ts'

export async function startDevicePairingRuntime(root:string,config:DirectDeviceConfig,store:DirectDeviceStore,target:()=>Promise<{assistantSessionId:string;contextVersion:number}>){
 const keyPath=join(root,'device-pairing.key')
 let secret:Buffer
 try{secret=await readDevicePrivateFile(keyPath,32)}catch(error){
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
  if(await store.hasPairingJobs())throw new Error('配对恢复密钥缺失，请恢复原文件。')
  const file=await open(keyPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
  try{await file.writeFile(randomBytes(32));await file.sync()}finally{await file.close()}
  secret=await readDevicePrivateFile(keyPath,32)
 }
 if(secret.length!==32)throw new Error('配对恢复密钥无法核对。')
 const ca=(await readDevicePrivateFile(config.tlsCertFile)).toString('utf8'),cert=new X509Certificate(ca)
 const names=(cert.subjectAltName??'').split(', ').filter(item=>item.startsWith('DNS:')).map(item=>item.slice(4))
 if(names.length!==1||!names[0]||!cert.checkHost(names[0]))throw new Error('USB 配对需要证书中唯一且可验证的主机名称。')
 const pairing=createDevicePairing({secret,host:config.listen.host,port:config.listen.port,serverName:names[0],ca,target,save:job=>store.savePairing(job),load:async id=>await store.readPairing(id) as DevicePairingJob|undefined,latest:async()=>await store.latestPairing() as DevicePairingJob|undefined,finish:(job,input)=>store.completePairing(job,input)})
 const ipc=await startDeviceProvisioningIpc(root,pairing)
 let clock:Awaited<ReturnType<typeof startDeviceTime>>
 try{clock=await startDeviceTime({host:config.listen.host,port:config.listen.port,secret,allowed:async(id,credential)=>{const binding=await store.authorize(createHash('sha256').update(credential).digest('hex'));return binding?.id===id}})}catch(error){await ipc.close();throw error}
 return Object.freeze({pairing,ipcPath:ipc.path,async close(){await clock.close();await ipc.close()}})
}
