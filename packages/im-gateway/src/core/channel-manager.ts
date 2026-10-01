/**
 * 渠道生命周期（规格 §7、§8）：保存凭据、启用／停用／删除、装载即启动已启用渠道。
 * 凭据只经 ctx.credentials：modifyRecord 是唯一写路径，readRecord 只在适配器连接时按次读取（不缓存），
 * 面板「已保存」只看 describeRecord；任何摘要、日志、审计不含凭据值。
 */
import {credentialKey,type CredentialProvider} from '@deepseek-ai/dsh-credentials'
import {WorkError,imChannelErrorCodes,type ImChannelErrorCode,type ImChannelKind,type ImChannelSummary,type imChannelSaveInput} from '@teloa/contract'
import type {createAdapter} from '../channels/index.ts'
import {feishuSdkRecipe,loadFeishuSdk} from '../channels/feishu-sdk.ts'
import type {createAudit} from './audit.ts'
import type {createBindingStore} from './bindings.ts'
import type {createChannelConfigStore,ImChannelConfig} from './channels-config.ts'
import type {AdapterDeps,ImChannelAdapter,ImCredentialEnv,ImInbound} from './types.ts'

export type ChannelManagerDeps={
 credentials:Pick<CredentialProvider,'readRecord'|'describeRecord'|'modifyRecord'|'deleteRecord'>
 config:ReturnType<typeof createChannelConfigStore>
 bindings:ReturnType<typeof createBindingStore>
 createAdapter:typeof createAdapter
 onInbound:(channelId:string,m:ImInbound)=>Promise<void>
 audit:ReturnType<typeof createAudit>
 /** teloaWork.packages.install：飞书 SDK 按需受管安装（飞书与 Lark 共用同一配方与目录），返回安装目录。 */
 installPackage:(recipe:{package:string;version:string;integrity:string})=>Promise<string>
 lock:{held:boolean}
 log:AdapterDeps['log']
 now:()=>string
}

const labels:Record<ImChannelKind,string>={feishu:'飞书',lark:'Lark',telegram:'Telegram',slack:'Slack',stub:'验收桩'}
/** 走飞书官方 SDK 的渠道种类。 */
const needsFeishuSdk=(kind:ImChannelKind)=>kind==='feishu'||kind==='lark'
/** 飞书与 Lark 各自的 App ID 键：同一 App ID 不能同时给两个渠道用（凭据、token 与事件会互相串）。 */
const appIdKeys:Partial<Record<ImChannelKind,string>>={feishu:'FEISHU_APP_ID',lark:'LARK_APP_ID'}
const disableNotifyMs=3_000

export function createChannelManager(deps:ChannelManagerDeps){
 const adapters=new Map<string,ImChannelAdapter>()
 /** 启动失败的错误码（适配器未能进入运行态时）；不存原始异常。 */
 const startErrors=new Map<string,ImChannelErrorCode>()
 /** 安装 SDK、读凭据两处抛出的错误打上错误码，其余启动失败一律 start-failed。 */
 const failures=new WeakMap<object,ImChannelErrorCode>()
 const tagged=(error:WorkError,code:ImChannelErrorCode)=>{failures.set(error,code);return error}
 const disabledListeners=new Set<(channelId:string)=>void|Promise<void>>()
 /** 进行中的启动令牌（每渠道一个）。 */
 const starting=new Map<string,symbol>()
 /** stopAll 之后（插件释放、即将放锁）不再启动任何渠道。 */
 let closed=false
 const key=(channelId:string)=>credentialKey('im-gateway',channelId)

 const find=async(channelId:string):Promise<ImChannelConfig>=>{
  const row=(await deps.config.list()).find(c=>c.channelId===channelId)
  if(!row)throw new WorkError('teloa/not-found','没有找到该 IM 渠道。')
  return row
 }
 const requireLock=()=>{
  if(!deps.lock.held)throw new WorkError('teloa/conflict','IM 通道已由另一宿主连接。')
 }
 const installFeishuSdk=async():Promise<string>=>{
  try{return await deps.installPackage(feishuSdkRecipe)}
  catch{throw tagged(new WorkError('teloa/dependency-unavailable','飞书 SDK 安装失败，请稍后重试。'),'sdk-install-failed')}
 }
 const readEnv=async(channelId:string):Promise<ImCredentialEnv>=>{
  const record=await deps.credentials.readRecord(key(channelId))
  if(record?.kind!=='api-key'||!record.env)throw tagged(new WorkError('teloa/dependency-unavailable','渠道凭据未保存。'),'credentials-missing')
  return record.env
 }
 const status=(row:ImChannelConfig):ImChannelSummary['status']=>{
  if(!deps.lock.held)return {connected:false,error:'another-host'}
  const current=adapters.get(row.channelId)?.status()
  // 只回稳定错误码（审查 L4）：适配器给出码以外的文字一律记 unknown，不透出原文。
  const reported=current?.error===undefined?undefined:(imChannelErrorCodes as readonly string[]).includes(current.error)?current.error as ImChannelErrorCode:'unknown'
  const error=reported??startErrors.get(row.channelId)
  return {connected:current?.connected??false,...(current?.lastEventAt===undefined?{}:{lastEventAt:current.lastEventAt}),...(error===undefined?{}:{error})}
 }
 const summary=async(row:ImChannelConfig):Promise<ImChannelSummary>=>({
  channelId:row.channelId,kind:row.kind,label:labels[row.kind],enabled:row.enabled,
  credentialsSaved:(await deps.credentials.describeRecord(key(row.channelId))).configured,
  status:status(row),
  bindings:(await deps.bindings.list(row.channelId)).length,
  groups:(await deps.bindings.groups.list(row.channelId)).length,
 })

 /** 单渠道启动：失败只记 startErrors，不抛、不影响其它渠道。 */
 const startOne=async(row:ImChannelConfig):Promise<void>=>{
  const id=row.channelId
  if(closed||adapters.has(id)||starting.has(id))return
  // 启动令牌：途中 disable／stopAll（stopOne 删令牌）后，每个 await 之后都放弃并清理已建连接。
  const token=Symbol(id)
  starting.set(id,token)
  const live=()=>!closed&&starting.get(id)===token
  let adapter:ImChannelAdapter|undefined
  try{
   const loadSdk=needsFeishuSdk(row.kind)?await installFeishuSdk().then(dir=>()=>loadFeishuSdk(dir)):undefined
   if(!live())return
   adapter=deps.createAdapter(row.kind,{env:()=>readEnv(id),log:deps.log,now:()=>new Date(deps.now()),...(loadSdk?{loadSdk}:{})})
   adapters.set(id,adapter)
   await adapter.start(m=>deps.onInbound(id,m))
   // 启动途中已被 disable／stopAll 摘下：连接此刻才建立，补停一次，不留孤儿连接。
   if(!live()||adapters.get(id)!==adapter){
    if(adapters.get(id)===adapter)adapters.delete(id)
    await adapter.stop().catch(()=>{})
    return
   }
   startErrors.delete(id)
  }catch(error){
   if(adapter&&adapters.get(id)===adapter){adapters.delete(id);await adapter.stop().catch(()=>{})}
   if(!live())return
   startErrors.set(id,(typeof error==='object'&&error!==null&&failures.get(error))||'start-failed')
   deps.log.warn('[im-gateway] 渠道 %s 启动失败',id)
  }finally{
   if(starting.get(id)===token)starting.delete(id)
  }
 }
 const stopOne=async(channelId:string):Promise<void>=>{
  starting.delete(channelId)
  const adapter=adapters.get(channelId)
  adapters.delete(channelId)
  startErrors.delete(channelId)
  if(adapter)await adapter.stop().catch(()=>deps.log.warn('[im-gateway] 渠道 %s 停止失败',channelId))
 }
 const disableOne=async(row:ImChannelConfig):Promise<ImChannelConfig>=>{
  // 先通知再停：审批/提问撤卡要趁渠道仍连接时编辑卡片；最多等 disableNotifyMs，不让平台慢响应卡住停用。
  let timer:ReturnType<typeof setTimeout>|undefined
  await Promise.race([
   Promise.all([...disabledListeners].map(listener=>Promise.resolve().then(()=>listener(row.channelId)).catch(()=>{}))),
   new Promise<void>(resolve=>{timer=setTimeout(resolve,disableNotifyMs);timer.unref?.()}),
  ])
  clearTimeout(timer)
  await stopOne(row.channelId)
  const next={...row,enabled:false}
  await deps.config.upsert(next)
  return next
 }

 return {
  async list():Promise<ImChannelSummary[]>{
   return Promise.all((await deps.config.list()).map(summary))
  },
  async save(input:ReturnType<typeof imChannelSaveInput>):Promise<ImChannelSummary>{
   const credential=key(input.channelId)
   if(!(await deps.credentials.describeRecord(credential)).writable)throw new WorkError('teloa/dependency-unavailable','密钥存储当前只读，无法保存渠道密钥。')
   const appIdKey=appIdKeys[input.kind]
   if(appIdKey){
    // 只比较另一渠道已保存的 App ID；比较值不进日志、错误与审计。
    for(const [otherKind,otherKey] of Object.entries(appIdKeys)){
     if(otherKind===input.kind||!otherKey||!(await deps.credentials.describeRecord(key(otherKind))).configured)continue
     const other=await deps.credentials.readRecord(key(otherKind))
     if(other?.kind==='api-key'&&other.env?.[otherKey]===input.credentials[appIdKey])throw new WorkError('teloa/conflict','这个 App ID 已经用在另一个渠道上，请换一个应用。',{reason:'app-id-in-use'})
    }
   }
   if(needsFeishuSdk(input.kind))await installFeishuSdk()
   await deps.credentials.modifyRecord(credential,async()=>({kind:'api-key',env:{...input.credentials}}))
   const existing=(await deps.config.list()).find(c=>c.channelId===input.channelId)
   const row=existing??{channelId:input.channelId,kind:input.kind,enabled:false,createdAt:deps.now()}
   if(!existing)await deps.config.upsert(row)
   // 已启用渠道换凭据：重连一次，让「凭据无效」等终态得以恢复。
   else if(row.enabled&&deps.lock.held){await stopOne(row.channelId);await startOne(row)}
   return summary(row)
  },
  async enable(channelId:string):Promise<ImChannelSummary>{
   const row=await find(channelId)
   requireLock()
   if(!(await deps.credentials.describeRecord(key(channelId))).configured)throw new WorkError('teloa/conflict','请先保存渠道凭据。')
   const next={...row,enabled:true}
   await deps.config.upsert(next)
   await startOne(next)
   return summary(next)
  },
  async disable(channelId:string):Promise<ImChannelSummary>{
   const row=await find(channelId)
   requireLock()
   return summary(await disableOne(row))
  },
  async remove(channelId:string):Promise<void>{
   const row=await find(channelId)
   requireLock()
   await disableOne(row)
   for(const binding of await deps.bindings.list(channelId))await deps.bindings.remove(channelId,binding.imUserId)
   for(const group of await deps.bindings.groups.list(channelId))await deps.bindings.groups.unbind(channelId,group.chatId)
   await deps.credentials.deleteRecord(key(channelId))
   await deps.config.remove(channelId)
  },
  async startEnabled():Promise<void>{
   if(!deps.lock.held||closed)return
   await Promise.all((await deps.config.list()).filter(row=>row.enabled).map(startOne))
  },
  async stopAll():Promise<void>{
   closed=true
   await Promise.all([...adapters.keys()].map(stopOne))
  },
  adapter(channelId:string):ImChannelAdapter|undefined{
   return adapters.get(channelId)
  },
  /** 停用（含删除）前通知；监听器可返回 Promise，停渠道前最多等 disableNotifyMs。 */
  onChannelDisabled(listener:(channelId:string)=>void|Promise<void>):()=>void{
   disabledListeners.add(listener)
   return ()=>{disabledListeners.delete(listener)}
  },
 }
}
