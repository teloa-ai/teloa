import {createHash} from 'node:crypto'
import {lstat,mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import type {SettingsPort} from './local-models-route.ts'
import {WorkError} from '@teloa/contract'

/** 路由、目录与凭据仍由 DSH settings / credentials 持有；这里只核对统一认证。 */
export const platformProviderIds=Object.freeze(['teloa-platform-responses','teloa-platform-messages','teloa-platform-completions'] as const)
export const platformModelCredentialRef='TELOA_PLATFORM_MODEL_TOKEN'
export type PlatformEngine='codex'|'claude-code'
export type PlatformRoute=Readonly<{provider:string;api:'openai-responses'|'anthropic-messages';baseURL:string;credentialRef:string;model:string;fingerprint:string}>
type CredentialPort={resolve:(ref:string)=>Promise<{value:string;source:unknown}|undefined>}
type Ports={settings:Pick<SettingsPort,'describe'>;credentials:CredentialPort;allowLoopbackHttp?:boolean}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const denied=(message='平台模型连接或凭据已变化，请在原模型设置中重新核对。')=>new WorkError('teloa/dependency-unavailable',message)
const digest=(value:string)=>createHash('sha256').update(value).digest('hex')

export function isPlatformModelProvider(value:unknown):boolean{return platformProviderIds.some(id=>id===value)}

/** 指定平台连接不接受个人密钥引用，也不以缺协议为理由改走别的服务。 */
export function readPlatformRoute(settings:Pick<SettingsPort,'describe'>,engine:PlatformEngine,model?:string,allowLoopbackHttp=false):PlatformRoute{
 const provider=engine==='codex'?platformProviderIds[0]:platformProviderIds[1],api=engine==='codex'?'openai-responses':'anthropic-messages'
 const section=settings.describe().find(row=>row.ns==='llm-pi-ai')?.value
 const route=object(section)&&object(section.providers)?section.providers[provider]:undefined
 if(!object(route)||route.api!==api||route.apiKeyEnv!==platformModelCredentialRef||typeof route.baseURL!=='string'||!Array.isArray(route.models))throw denied('平台模型连接尚未配置所需协议，请在原模型设置中核对。')
 let url:URL
 try{url=new URL(route.baseURL)}catch{throw denied()}
 if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(allowLoopbackHttp&&url.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(url.hostname)))throw denied()
 const selected=route.models.find(item=>object(item)&&typeof item.id==='string'&&(model===undefined||item.id===model))
 if(!object(selected)||typeof selected.id!=='string'||!selected.id||/[\s\x00-\x1f\x7f]/.test(selected.id))throw denied('平台模型未列入当前连接的可用目录。')
 return Object.freeze({provider,api,baseURL:url.href.replace(/\/+$/,''),credentialRef:platformModelCredentialRef,model:selected.id,fingerprint:digest(JSON.stringify(route))})
}

export type PlatformModelLease=Readonly<{engine:PlatformEngine;route:PlatformRoute;token:string;assertCurrent:()=>Promise<void>}>
export type PlatformModelAccess=ReturnType<typeof createPlatformModelAccess>
export function createPlatformModelAccess(ports:Ports){
 let generation=0,closed=false
 const active=new Set<()=>void>()
 return Object.freeze({
  /** Host 在账号退出/切换或凭据更新时调用；不会把平台认证退回个人账号。 */
  invalidate(){generation++;for(const cancel of [...active])cancel()},
  dispose(){closed=true;generation++;for(const cancel of [...active])cancel();active.clear()},
  subscribe(cancel:()=>void){if(closed)throw denied();active.add(cancel);return ()=>{active.delete(cancel)}},
  async acquire(engine:PlatformEngine,signal:AbortSignal,model?:string):Promise<PlatformModelLease>{
   signal.throwIfAborted();if(closed)throw denied()
   const epoch=generation,route=readPlatformRoute(ports.settings,engine,model,ports.allowLoopbackHttp)
   const credential=await ports.credentials.resolve(route.credentialRef)
   signal.throwIfAborted()
   if(closed||epoch!==generation||!credential||typeof credential.value!=='string'||!credential.value||/[\s\x00-\x1f\x7f]/.test(credential.value)||credential.value.length>8192)throw denied('平台模型尚未连接或登录已失效，请核对平台服务。')
   const token=credential.value,stamp=digest(token)
   const assertCurrent=async()=>{
    signal.throwIfAborted()
    if(closed||epoch!==generation||readPlatformRoute(ports.settings,engine,route.model,ports.allowLoopbackHttp).fingerprint!==route.fingerprint)throw denied()
    const current=await ports.credentials.resolve(route.credentialRef)
    signal.throwIfAborted()
    if(closed||epoch!==generation||!current||digest(current.value)!==stamp||readPlatformRoute(ports.settings,engine,route.model,ports.allowLoopbackHttp).fingerprint!==route.fingerprint)throw denied()
   }
   await assertCurrent()
   return Object.freeze({engine,route,token,assertCurrent})
  },
 })
}

export type PlatformLaunch=Readonly<{env:Record<string,string>;model:string;assertCurrent:()=>Promise<void>;dispose:()=>Promise<void>}>
/** 每次原生执行单独认证目录；配置只写凭据引用，Token 只进入该子进程的显式环境。 */
export async function preparePlatformLaunch(lease:PlatformModelLease,runtimeRoot:string,signal:AbortSignal):Promise<PlatformLaunch>{
 await lease.assertCurrent();signal.throwIfAborted()
 await mkdir(runtimeRoot,{recursive:true,mode:0o700})
 const parent=await lstat(runtimeRoot)
 if(!parent.isDirectory()||parent.isSymbolicLink()||process.platform!=='win32'&&(parent.mode&0o077)!==0||await realpath(runtimeRoot)!==runtimeRoot)throw denied('平台模型认证目录无法安全准备。')
 const root=await mkdtemp(join(runtimeRoot,'platform-native-'))
 let disposal:Promise<void>|undefined
 const dispose=()=>disposal??=rm(root,{recursive:true,force:true})
 try{
  const home=join(root,'home'),config=join(root,lease.engine==='codex'?'codex':'claude'),xdg=join(root,'config')
  await Promise.all([home,config,xdg].map(path=>mkdir(path,{mode:0o700})))
  const env:Record<string,string>={HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:xdg}
  if(lease.engine==='codex'){
   env.CODEX_HOME=config;env.TELOA_PLATFORM_MODEL_TOKEN=lease.token
   const text=`model = ${JSON.stringify(lease.route.model)}\nmodel_provider = "teloa-platform"\n[model_providers.teloa-platform]\nname = "Teloa Platform"\nbase_url = ${JSON.stringify(lease.route.baseURL)}\nwire_api = "responses"\nenv_key = "TELOA_PLATFORM_MODEL_TOKEN"\nrequires_openai_auth = false\n`
   await writeFile(join(config,'config.toml'),text,{flag:'wx',mode:0o600})
  }else{
   env.CLAUDE_CONFIG_DIR=config;env.ANTHROPIC_BASE_URL=lease.route.baseURL;env.ANTHROPIC_AUTH_TOKEN=lease.token
   env.ANTHROPIC_MODEL=lease.route.model;env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1'
  }
  await lease.assertCurrent();signal.throwIfAborted()
  return Object.freeze({env,model:lease.route.model,assertCurrent:lease.assertCurrent,dispose})
 }catch(error){await dispose();throw error}
}
