import type {Context} from '@deepseek-ai/cordis'
import type {SessionController} from '@deepseek-ai/dsh-api-session-controller'
import {credentialRef} from '@deepseek-ai/dsh-credentials'
import {isRecord} from '@teloa/contract'

export type NativeModelCatalog=Awaited<ReturnType<SessionController['modelCatalog']>>
export type ModelCatalogReadiness={catalog:NativeModelCatalog;missingCredentialProviders:string[]}
export type ModelCatalogReader={read:(signal?:AbortSignal)=>Promise<ModelCatalogReadiness>}
type ReadinessSettings={describe:(options:{redactSecrets:true})=>readonly {ns:string;value:unknown}[]}
declare module '@deepseek-ai/cordis'{interface Context{teloaModelCatalog:ModelCatalogReader}}

/** 只读脱敏设置与凭据描述；不读取密钥值，不探测远端，也不把无法核实当作缺失。 */
export async function readModelCatalogReadiness(ctx:Context,catalog:NativeModelCatalog,signal?:AbortSignal):Promise<ModelCatalogReadiness>{
 signal?.throwIfAborted()
 try{
  const settings=Reflect.get(ctx,'settings') as ReadinessSettings
  const namespaces=settings.describe({redactSecrets:true}),providers=ctx.llm.listConfigurableProviders()
  const states=await Promise.all(providers.map(async provider=>{
   signal?.throwIfAborted()
   // 官方账号路由使用登录状态，不以 BYOK 引用是否配置判断可用性。
   if(provider.provider==='deepseek-account')return undefined
   let profile:unknown=namespaces.find(row=>row.ns===provider.settingsNs)?.value
   for(const key of provider.settingsPath)profile=isRecord(profile)?profile[key]:undefined
   const ref=isRecord(profile)?profile.apiKeyEnv:undefined
   if(typeof ref!=='string'||!ref)return undefined
   try{const info=await ctx.credentials.describe(credentialRef(ref));signal?.throwIfAborted();return info.configured===false?provider.provider:undefined}
   catch{signal?.throwIfAborted();return undefined}
  }))
  signal?.throwIfAborted()
  return {catalog,missingCredentialProviders:[...new Set(states.filter((id):id is string=>id!==undefined))]}
 }catch{signal?.throwIfAborted();return {catalog,missingCredentialProviders:[]}}
}

export function createModelCatalogReader(ctx:Context,nativeCatalog:()=>Promise<NativeModelCatalog>):ModelCatalogReader{
 return {read:async(signal)=>{signal?.throwIfAborted();const catalog=await nativeCatalog();signal?.throwIfAborted();return readModelCatalogReadiness(ctx,catalog,signal)}}
}

/** 原生会话菜单与 /model 继续消费官方目录；仅过滤已确认缺密钥的路由，原默认选择不变。 */
export function runnableModelCatalog({catalog,missingCredentialProviders}:ModelCatalogReadiness):NativeModelCatalog{
 const missing=new Set(missingCredentialProviders)
 return {...catalog,groups:catalog.groups.filter(group=>!missing.has(group.id)),routableProviders:catalog.routableProviders.filter(id=>!missing.has(id))}
}
