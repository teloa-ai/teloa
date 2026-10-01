import {WorkError,OLLAMA_CREDENTIAL_REF,OLLAMA_ROUTE_KEY,isRecord} from '@teloa/contract'
import type {OllamaReasoningEfforts} from './ollama-reasoning.ts'

/**
 * 本机模型路由写入（模型二期规格 §6.5，薄适配）：只经 DSH `ctx.settings.mutate` 与 `ctx.credentials.set` 改 `llm-pi-ai` 的
 * `providers.ollama`，不写模型接入代码。Teloa 只增删自己登记过的 `models[]` 项；路由其余字段一旦存在不再覆盖（用户在 Models 页的改动保留）。
 * 占位凭据值为常量，只在未配置时写一次，不进日志、卡片、回包。
 */
export const OLLAMA_PLACEHOLDER_CREDENTIAL='ollama'
export const PI_AI_SETTINGS_NS='llm-pi-ai'

type SettingsPathOp={op:'set';path:readonly string[];value:unknown}|{op:'unset';path:readonly string[]}
type SettingsDescriptor={ns:string;revision:number;value?:unknown;user?:unknown}
/** `ctx.settings` 的结构子集（`@deepseek-ai/dsh-settings` SettingsForms：describe / mutate / writable）。 */
export type SettingsPort={readonly writable:boolean;describe():SettingsDescriptor[];mutate(ns:string,ops:readonly SettingsPathOp[],expectedRevision?:number):Promise<void>}
/** `ctx.credentials` 的结构子集（`@deepseek-ai/dsh-credentials` CredentialProvider：describe / set）。 */
export type CredentialsPort={describe(ref:string):Promise<{configured:boolean;writable:boolean}>;set(ref:string,value:string):Promise<void>}
export type OllamaRouteDeps={settings:SettingsPort;credentials:CredentialsPort}
export type OllamaRouteAddress={baseURL:string;host:string;local:boolean}
export type OllamaRouteModel={id:string;name:string;contextWindow:number;maxTokens:number;input:('text'|'image')[];reasoningEfforts?:OllamaReasoningEfforts|false}

const isConflict=(error:unknown)=>isRecord(error)&&error.code==='SETTINGS_CONFLICT'

/** 读 DSH 解析后的 value（组合底层 + 用户覆盖），写操作仍只写用户层的具体路径。 */
function readRoute(settings:SettingsPort):{revision:number;route:Record<string,unknown>|null}{
 const descriptor=settings.describe().find(item=>item.ns===PI_AI_SETTINGS_NS)
 if(!descriptor)throw new WorkError('teloa/dependency-unavailable','DSH 模型提供方配置（llm-pi-ai）不可用，无法写入本机模型路由。')
 const section=isRecord(descriptor.value)?descriptor.value:isRecord(descriptor.user)?descriptor.user:{}
 const providers=isRecord(section.providers)?section.providers:{}
 const route=providers[OLLAMA_ROUTE_KEY]
 return {revision:descriptor.revision,route:isRecord(route)?route:null}
}
const routeModels=(route:Record<string,unknown>):Record<string,unknown>[]=>Array.isArray(route.models)?route.models.filter((item):item is Record<string,unknown>=>isRecord(item)&&typeof item.id==='string'):[]
const routeMatches=(route:Record<string,unknown>,address:OllamaRouteAddress)=>{
 try{return route.api==='openai-completions'&&typeof route.baseURL==='string'&&new URL(route.baseURL.replace(/\/+$/,'')).href===new URL(`${address.baseURL}/v1`).href}catch{return false}
}
const checkRoute=(route:Record<string,unknown>|null,address:OllamaRouteAddress)=>{
 if(route!==null&&!routeMatches(route,address))throw new WorkError('teloa/version-conflict','现有 Ollama 模型路由与当前地址或协议不一致，请在模型设置中核对后重试。')
}
/** 就绪状态每次读取真实路由；记录文件不是可用性真源。 */
export function ollamaRouteHasModel(settings:SettingsPort,address:OllamaRouteAddress,id:string):boolean{
 try{const {route}=readRoute(settings);return route!==null&&routeMatches(route,address)&&routeModels(route).some(model=>model.id===id)}catch{return false}
}

/** 核对经手路由身份；实际请求不能偷偷探测或接管用户改指的另一台服务。 */
export function readOllamaRequestRoute(settings:SettingsPort,address:OllamaRouteAddress,id:string){
 const {route}=readRoute(settings)
 checkRoute(route,address)
 const model=route&&routeModels(route).find(row=>row.id===id)
 if(!model)throw new WorkError('teloa/version-conflict','本地模型路由已移除，请在模型设置中重新接入。')
 const positive=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:undefined
 return {fingerprint:JSON.stringify(route),contextWindow:positive(model.contextWindow),maxTokens:positive(model.maxTokens)}
}

/** 只收紧自己登记的模型预算；保留名称、能力、费用及其他模型，不放大用户的手工限制。 */
export async function tightenOllamaRequestRoute(settings:SettingsPort,address:OllamaRouteAddress,id:string,expected:string,contextWindow:number,maxTokens:number,signal:AbortSignal):Promise<void>{
 await writeRoute(settings,route=>{
  signal.throwIfAborted()
  checkRoute(route,address)
  if(!route||JSON.stringify(route)!==expected)throw new WorkError('teloa/version-conflict','模型配置在容量核对期间发生变化，请重试。')
  const models=routeModels(route),model=models.find(row=>row.id===id)
  if(!model)throw new WorkError('teloa/version-conflict','本地模型路由已移除。')
  if(model.contextWindow===contextWindow&&model.maxTokens===maxTokens)return null
  return [{op:'set',path:['providers',OLLAMA_ROUTE_KEY,'models'],value:models.map(row=>row.id===id?{...row,contextWindow,maxTokens}:row)}]
 })
}

/** 写一次；`SETTINGS_CONFLICT` 重读一次重试，再冲突 → version-conflict。`plan` 回 null 表示无需写。 */
async function writeRoute(settings:SettingsPort,plan:(route:Record<string,unknown>|null)=>SettingsPathOp[]|null):Promise<void>{
 for(let attempt=0;;attempt++){
  const {revision,route}=readRoute(settings)
  const ops=plan(route)
  if(ops===null)return
  if(!settings.writable)throw new WorkError('teloa/forbidden','当前 DSH 配置不可写，无法写入本机模型路由。')
  try{await settings.mutate(PI_AI_SETTINGS_NS,ops,revision);return}
  catch(error){
   if(!isConflict(error)||attempt>=1)throw isConflict(error)?new WorkError('teloa/version-conflict','模型提供方配置刚被改动，请重试。'):error
  }
 }
}

/** 确保 `providers.ollama` 存在并含给定模型：不存在整体写入；存在只按 id 增改 `models[]`，用户自加的项与其余字段不动。`owned` 为 Teloa 已登记的 id；同 id 但非 Teloa 登记的用户项不覆盖。 */
export async function ensureOllamaRoute(deps:OllamaRouteDeps,address:OllamaRouteAddress,models:OllamaRouteModel[],owned:string[]):Promise<string[]>{
 // 先确认 llm-pi-ai 在场且可写，再碰凭据：缺依赖时不留下孤立的占位凭据。
 checkRoute(readRoute(deps.settings).route,address)
 if(!deps.settings.writable)throw new WorkError('teloa/forbidden','当前 DSH 配置不可写，无法写入本机模型路由。')
 const credential=await deps.credentials.describe(OLLAMA_CREDENTIAL_REF)
 if(!credential.configured){
  if(!credential.writable)throw new WorkError('teloa/dependency-unavailable','密钥存储不可写，无法登记本机模型占位密钥。')
  await deps.credentials.set(OLLAMA_CREDENTIAL_REF,OLLAMA_PLACEHOLDER_CREDENTIAL)
 }
 let managed:string[]=[]
 await writeRoute(deps.settings,route=>{
  checkRoute(route,address)
  if(route===null){
   managed=models.map(model=>model.id)
   return [{op:'set',path:['providers',OLLAMA_ROUTE_KEY],value:{displayName:address.local?'本机模型（Ollama）':`外部 Ollama（${address.host}）`,apiKeyEnv:OLLAMA_CREDENTIAL_REF,api:'openai-completions',baseURL:`${address.baseURL.replace(/\/+$/,'')}/v1`,models:models.map(model=>({...model}))}}]
  }
  const existing=routeModels(route),ownedSet=new Set(owned)
  // 复用用户同名项不等于取得管理权；移除模型时不能顺带删除用户自己维护的路由。
  managed=models.filter(model=>ownedSet.has(model.id)||!existing.some(item=>item.id===model.id)).map(model=>model.id)
  const kept=existing.filter(item=>!models.some(model=>model.id===item.id&&ownedSet.has(model.id)))
  const additions=models.filter(model=>!kept.some(item=>item.id===model.id)).map(model=>({...model}))
  if(!additions.length&&kept.length===existing.length)return null
  return [{op:'set',path:['providers',OLLAMA_ROUTE_KEY,'models'],value:[...kept,...additions]}]
 })
 return managed
}

/** 只删已登记的 id；DSH 0.1.7-rc.1 不接受空模型目录，最后一项移除时必须 unset 整条连接（界面确认已说明）。 */
export async function removeFromOllamaRoute(deps:OllamaRouteDeps,id:string,address:OllamaRouteAddress):Promise<void>{
 await writeRoute(deps.settings,route=>{
  if(route===null)return null
  const existing=routeModels(route),kept=existing.filter(item=>item.id!==id)
  if(kept.length!==existing.length)checkRoute(route,address)
  if(kept.length===existing.length)return null
  return kept.length===0?[{op:'unset',path:['providers',OLLAMA_ROUTE_KEY]}]:[{op:'set',path:['providers',OLLAMA_ROUTE_KEY,'models'],value:kept}]
 })
}
