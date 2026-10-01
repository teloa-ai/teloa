import {
 WorkError,
 isRecord,
 isReservedOfficialPackage,
 readMarketPluginInstallSpec,
 readMarketPluginRegistrySource,
 type MarketPluginRegistrySource,
} from '@teloa/contract'
import type {PluginInstallationService} from '@teloa/backend'

export const marketPluginInstallationEndpoints=['market-plugins/preview','market-plugins/install','market-plugins/reconcile','market-plugins/get','market-plugins/list'] as const
type Operations=Pick<PluginInstallationService,'preview'|'install'|'reconcile'|'get'|'list'>

const invalid=()=>new WorkError('teloa/invalid-input','DSH 扩展安装请求格式不正确或包含未知字段。')
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!isRecord(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))throw invalid()
 return value
}
const reserved=(packageName:string)=>{if(isReservedOfficialPackage(packageName))throw new WorkError('teloa/forbidden','@teloa/ 作用域的包只随 Teloa 发行，不能从 npm 安装。')}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

function sourcePayload(value:unknown):{source:MarketPluginRegistrySource}{
 const row=exact(value,['source'])
 try{return {source:readMarketPluginRegistrySource(row.source)}}catch{throw invalid()}
}

function installationPayload(value:unknown):{installationId:string}{
 const row=exact(value,['installationId'])
 if(!uuid(row.installationId))throw invalid()
 return {installationId:row.installationId.toLowerCase()}
}

/** 只绑定认证宿主的本人身份；profile、DSH_HOME 和命令路径都不能由 RPC 客户端提供。 */
export function createMarketPluginInstallationHandler(ownerId:string,get:(signal?:AbortSignal)=>Promise<Operations>){
 return async(endpoint:string,payload:unknown,signal?:AbortSignal):Promise<unknown>=>{
  if(!marketPluginInstallationEndpoints.includes(endpoint as typeof marketPluginInstallationEndpoints[number]))throw new WorkError('teloa/not-found','未提供此 DSH 扩展安装接口。')
  if(endpoint==='market-plugins/preview'){
   const input=sourcePayload(payload)
   reserved(input.source.packageName)
   return (await get(signal)).preview(ownerId,input)
  }
  if(endpoint==='market-plugins/install'){
   let spec
   try{spec=readMarketPluginInstallSpec(payload)}catch{throw invalid()}
   reserved(spec.preview.source.packageName)
   return (await get(signal)).install(ownerId,spec)
  }
  if(endpoint==='market-plugins/reconcile'){
   const input=installationPayload(payload)
   return (await get(signal)).reconcile(ownerId,input)
  }
  if(endpoint==='market-plugins/get'){
   const input=installationPayload(payload)
   return (await get(signal)).get(ownerId,input)
  }
  exact(payload,[])
  return (await get(signal)).list(ownerId,{})
 }
}
