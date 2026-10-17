import {WorkError,assistantChannelApiVersion,hardwareScopes,type AssistantChannelHost,type AssistantChannelLease,type AssistantChannelRegistration,type HardwareBinding,type HardwareRequestPort,type HardwareScope} from '@teloa/contract'
import type {HardwareStore,createHardwareStore} from '@teloa/backend'
import {createHardwareRequestService,type HardwareHostPorts} from './hardware-request-service.ts'
import {readOrCreateInstallId} from './usage-stats.ts'

/** 在冷恢复之前核对持久安装；旧来源存在时不以新身份查空后继续。 */
export async function readAssistantChannelInstallation(pool:Parameters<typeof createHardwareStore>[0],ownerId:string,runtimeRoot:string){
 const table=(await pool.query("select to_regclass('teloa_device_bindings') as name")).rows[0]?.name
 const direct=(await pool.query("select to_regclass('teloa_direct_devices') as name")).rows[0]?.name
 const pairing=(await pool.query("select to_regclass('teloa_device_pairing_jobs') as name")).rows[0]?.name
 const prior=[...pairing?(await pool.query('select installation_id from teloa_device_pairing_jobs where owner_id=$1',[ownerId])).rows:[],...table?(await pool.query('select installation_id from teloa_device_bindings where owner_id=$1',[ownerId])).rows:[],...direct?(await pool.query('select installation_id from teloa_direct_devices where owner_id=$1',[ownerId])).rows:[]]
 const installationId=await readOrCreateInstallId(runtimeRoot,{create:prior.length===0})
 if(prior.length&&(!installationId||!prior.some(row=>row.installation_id===installationId)))throw new WorkError('teloa/storage-corrupt','已有硬件请求的安装身份无法核对，请恢复原安装身份。')
 return installationId
}

type Ports=Pick<HardwareHostPorts,'dispatch'|'read'|'workSignal'|'remember'|'waitMs'>&{
 store:()=>Promise<HardwareStore>
 allowed:()=>boolean
 ensure:()=>Promise<{assistantSessionId:string;contextVersion:number}>
 verify:(binding:HardwareBinding)=>Promise<()=>void>
}
const denied=()=>new WorkError('teloa/forbidden','该助手通道当前未获授权。')
const fullGrant=(scopes:readonly HardwareScope[])=>scopes.length===hardwareScopes.length&&hardwareScopes.every(scope=>scopes.includes(scope))
/** 宿主持有原助手及持久回执；可选插件只拿到当前安装的有限租约。 */
export function createAssistantChannelHost(ports:Ports){
 let holder:{registration:AssistantChannelRegistration;close:()=>Promise<void>}|undefined,disposed=false
 let mutations=Promise.resolve<unknown>(undefined)
 const serial=<T>(operation:()=>Promise<T>):Promise<T>=>{const result=mutations.then(operation,operation);mutations=result.catch(()=>{});return result}
 const service:AssistantChannelHost=Object.freeze({version:assistantChannelApiVersion,attach(registration){
  if(disposed||holder||registration.id!=='xiaozhi-mcp'||typeof registration.handle!=='function'||!ports.allowed())throw denied()
  let closed=false,blocked=false,epoch=0
  const assertLive=()=>{if(closed||disposed)throw denied()}
  const assertCurrent=(expected:number)=>{assertLive();if(blocked||epoch!==expected)throw denied()}
  const checkEpoch=(expected:number)=>{assertLive();if(epoch!==expected)throw denied()}
  const snapshot=async()=>{
   assertLive();const binding=await(await ports.store()).current();assertLive()
   return {enabled:!blocked&&binding?.status==='active'&&fullGrant(binding.scopes),grantVersion:binding?.grantVersion??0,scopes:binding?.scopes??[],assistantName:'Teloa'}
  }
  const authorize:HardwareHostPorts['authorize']=async()=>{
   const expected=epoch;assertCurrent(expected)
   const binding=await(await ports.store()).current();assertCurrent(expected)
   if(!binding||binding.status!=='active'||!fullGrant(binding.scopes))throw denied()
   const context=await ports.verify(binding);assertCurrent(expected);context()
   return {binding,assertCurrent:()=>{assertCurrent(expected);context()}}
  }
  let requests:HardwareRequestPort|undefined
  const requestService=async()=>{
   const authority=await authorize()
   if(!requests)requests=createHardwareRequestService({...ports,store:await ports.store(),bindingId:authority.binding.id,authorize})
   authority.assertCurrent()
   return requests
  }
  const lease:AssistantChannelLease=Object.freeze({
   requests:Object.freeze<HardwareRequestPort>({
    prepare:async text=>(await requestService()).prepare(text),
    submit:async(id,signal)=>(await requestService()).submit(id,signal),
    result:async id=>(await requestService()).result(id),
   }),snapshot,
   updateGrant(scopes){
    assertLive()
    // 首版为一组明确权限：提交、查原结果、准备任务。空集合即撤销。
    if(scopes.length===0)return lease.revoke()
    if(!fullGrant(scopes)||new Set(scopes).size!==scopes.length)throw new WorkError('teloa/invalid-input','请核对本次提交、结果返回与任务准备授权。')
    const expected=++epoch;blocked=true
    return serial(async()=>{
     checkEpoch(expected)
     const target=await ports.ensure();checkEpoch(expected)
     const store=await ports.store();checkEpoch(expected)
     const binding=await store.bind(target);checkEpoch(expected)
     const context=await ports.verify(binding);checkEpoch(expected);context()
     await store.updateGrant(binding.id,hardwareScopes);checkEpoch(expected);context()
     blocked=false
    })
   },
   revoke(){
    assertLive();epoch++;blocked=true
    return serial(async()=>{const store=await ports.store(),binding=await store.current();if(binding)await store.revoke(binding.id)})
   },
   close(){
    if(closed)return mutations.then(()=>{})
    closed=true;blocked=true;epoch++
    return mutations.then(()=>{if(holder?.registration===registration)holder=undefined})
   },
  })
  holder={registration,close:lease.close}
  return lease
 }})
 return Object.freeze({service,
  async handle(endpoint:string,payload:unknown,signal:AbortSignal):Promise<unknown>{
   if(!holder){if(endpoint==='devices/status')return {available:false};throw new WorkError('teloa/dependency-unavailable','请先安装并启用小智 MCP 插件。')}
   return holder.registration.handle(endpoint,payload,signal)
  },
  async close(){disposed=true;await holder?.close()},
 })
}
