import {Service,type Context} from '@deepseek-ai/cordis'
import type {ResolvedCredential,CredentialRef} from '@deepseek-ai/dsh-credentials'
import {WorkError} from '@teloa/contract'
import {platformProviderIds,platformModelCredentialRef} from './platform-model-connection.ts'
import type {SettingsPort} from './local-models-route.ts'
type Connection={schema:'teloa.platform-model-connection/v1';token:string;expiresAt:number;routes:Record<string,unknown>}
export type PlatformAccountPort={connection:(signal:AbortSignal)=>Promise<Connection>;subscribe:(invalidate:()=>void)=>()=>void;close:()=>void}
declare module '@deepseek-ai/cordis'{interface Context{teloaPlatformCredentialSource:{resolve:()=>Promise<ResolvedCredential|undefined>}}}
const unavailable=()=>new WorkError('teloa/dependency-unavailable','平台模型账号连接不可用，请在原账号设置中核对。')
const apis=['openai-responses','anthropic-messages','openai-completions'] as const
/** 账号由宿主拥有；DSH 继续持有唯一凭据与模型配置接口，不暴露账号认证给renderer。 */
export async function connectPlatformModelAccount(ctx:Context,port:PlatformAccountPort,{allowLoopbackHttp=false}={}){
 const settings=ctx.get('settings') as SettingsPort
 let closed=false
 class Source extends Service{
  constructor(ctx:Context){super(ctx,'teloaPlatformCredentialSource')}
  async resolve():Promise<ResolvedCredential|undefined>{
   if(closed)throw unavailable()
   const connection=await port.connection(AbortSignal.timeout(10000))
   if(closed||connection.schema!=='teloa.platform-model-connection/v1'||typeof connection.token!=='string'||!connection.token||/[\s\x00-\x1f\x7f]/.test(connection.token)||!Number.isSafeInteger(connection.expiresAt)||connection.expiresAt<=Date.now())throw unavailable()
   return {value:connection.token,source:'platform-account'}
  }
 }
 const runtime=ctx.plugin(Source)
 await runtime.await()
 let retry:ReturnType<typeof setInterval>|undefined,syncing:Promise<void>|undefined
 // 缺服务不影响既有 BYOK；受管来源已发布，平台引用不会回退到旧静态Token。
 const synchronize=()=>syncing??=(async()=>{
  if(closed)return
  const connection=await port.connection(AbortSignal.timeout(10000)),descriptor=settings.describe().find(row=>row.ns==='llm-pi-ai')
  if(closed||!descriptor||connection.schema!=='teloa.platform-model-connection/v1')throw unavailable()
  const ops:Array<{op:'set';path:readonly string[];value:unknown}>=[]
  for(const [index,id]of platformProviderIds.entries()){
   const value=connection.routes[id]
   if(value===undefined)continue
   if(!value||typeof value!=='object'||Array.isArray(value))throw unavailable()
   const route=value as Record<string,unknown>,url=new URL(String(route.baseURL))
   if(route.api!==apis[index]||route.apiKeyEnv!==platformModelCredentialRef||url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(allowLoopbackHttp&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))||!Array.isArray(route.models))throw unavailable()
   const config={api:route.api,apiKeyEnv:platformModelCredentialRef,baseURL:url.href.replace(/\/+$/,''),models:structuredClone(route.models)}
   const current=(descriptor.value as {providers?:Record<string,unknown>}|undefined)?.providers?.[id]
   if(JSON.stringify(current)!==JSON.stringify(config))ops.push({op:'set',path:['providers',id],value:config})
  }
  if(ops.length)await settings.mutate('llm-pi-ai',ops,descriptor.revision)
  if(retry){clearInterval(retry);retry=undefined}
 })().finally(()=>{syncing=undefined})
 const recover=()=>{if(!closed)void synchronize().catch(()=>{})}
 const unsubscribe=port.subscribe(()=>{ctx.emit('credentials/reference-updated',platformModelCredentialRef as CredentialRef);recover()})
 const close=()=>{if(closed)return;closed=true;if(retry)clearInterval(retry);unsubscribe();port.close();ctx.emit('credentials/reference-updated',platformModelCredentialRef as CredentialRef)}
 ctx.effect(()=>close)
 try{await synchronize()}catch{
  // 首次离线/未授额后可自动恢复目录，不要求用户重启Host；不触发任务执行。
  if(!closed){retry=setInterval(recover,15000);retry.unref?.()}
 }
 return Object.freeze({close})
}
