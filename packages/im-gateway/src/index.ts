import {randomBytes} from 'node:crypto'
import {join} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import {WorkError,imChannelEndpoints,imChannelKinds,imStubChannelKind} from '@teloa/contract'
import {createAdapter} from './channels/index.ts'
import {stubChannelPort} from './channels/stub.ts'
import {securityEnv} from '@teloa/harness-dsh/launch-env'
import {createImApproval,type ApprovalDeps} from './core/approval.ts'
import {createAudit} from './core/audit.ts'
import {createBindingStore} from './core/bindings.ts'
import {createChannelManager} from './core/channel-manager.ts'
import {createChannelConfigStore} from './core/channels-config.ts'
import {createGroupBuffer} from './core/group-buffer.ts'
import {createDedupe,createInbound} from './core/inbound.ts'
import {createOutbound} from './core/outbound.ts'
import {createImNotificationAdapter,type NotificationAdapter} from './core/notify.ts'
import {createPairingService,pairingCode} from './core/pairing.ts'
import {createImQuestions} from './core/questions.ts'
import {createRateLimiter} from './core/rate-limit.ts'
import {imRequestId} from './core/request-id.ts'
import {createRouter} from './core/router.ts'
import {acquireInstanceLock} from './instance-lock.ts'
import {createImEndpointHandler,type TeloaExtensionHandler} from './server.ts'

export const name='teloa-im-gateway'
// teloaWork 由 @teloa/harness-dsh 的 applyHost 末尾 ctx.provide；credentials 由 dsh-base 的 dsh-credentials-local 提供。
export const inject=['teloaWork','credentials','sessionController','sessions'] as const

/** 本插件用到的 teloaWork 子集（类型定义在 harness-dsh teloa-work-service.ts，插件不引入宿主源码）。 */
type TeloaWorkPort={
 readonly owner:string
 readonly runtimeRoot:string
 invoke(endpoint:string,payload:unknown,signal:AbortSignal):Promise<unknown>
 attachExtension(endpoints:readonly string[],handler:TeloaExtensionHandler):()=>void
 notifications:{addAdapter(adapter:NotificationAdapter):()=>void}
 /** 宿主 IM 会话登记（终审 I-3）；旧宿主没有该口时不登记。 */
 imSessions?:{register(sessionId:string):void}
 packages:{install(recipe:{package:string;version:string;integrity:string}):Promise<string>}
}

/** 只供测试替换适配器工厂；宿主装载时不传。 */
export type ImGatewayOptions={createAdapter?:typeof createAdapter}

const idList=async(work:TeloaWorkPort,endpoint:string):Promise<{id:string;name:string;version:number}[]>=>{
 const rows=await work.invoke(endpoint,{},new AbortController().signal)
 if(!Array.isArray(rows))return []
 return rows.flatMap(row=>typeof row?.id==='string'?[{id:row.id as string,name:String(row.name??''),version:Number(row.version??0)}]:[])
}

/**
 * 宿主已知的工作台地址（不含令牌）：dsh-host-webserver 实际监听端口拼本机地址。
 * 带令牌的启动地址只在宿主控制台输出，插件拿不到也不外发；没有 webServer（桌面壳走 file://）或尚未监听 → 不附链接。
 */
export function workbenchUrlOf(server:{port?:unknown}|undefined):string|undefined{
 const port=server?.port
 return typeof port==='number'&&Number.isInteger(port)&&port>0?`http://127.0.0.1:${port}/`:undefined
}

/** 插件释放时撤卡的等待上限。 */
const withdrawLimitMs=3000

/**
 * cordis 4.0.4 没有 `ready` 事件（评审 C1）：`inject` 已保证依赖服务就绪，
 * 因此在 apply 内直接组装存储 → manager → attachExtension → startEnabled()，一切资源经 ctx.effect 释放。
 */
export function apply(ctx:Context,options:ImGatewayOptions={}):void{
 const work=Reflect.get(ctx,'teloaWork') as TeloaWorkPort
 const dir=join(work.runtimeRoot,'im-gateway')
 // 同一运行目录只允许一个进程连 IM 渠道。锁被他人持有时插件照常加载（面板可读、写端点 conflict），不抛。
 const lock:{held:boolean;release?:()=>void}={held:false}
 try{lock.release=acquireInstanceLock(join(dir,'instance.lock')).release;lock.held=true}
 catch(error){
  if(!(error instanceof WorkError))throw error
  ctx.logger.warn('IM 通道实例锁被本机另一 Teloa 进程持有，本宿主不连接 IM 渠道。')
 }
 // 取锁之后、释放钩子登记之前任何一步抛错都要立即放锁，否则同机下一宿主要等本进程退出才能接管。
 try{
  const audit=createAudit(dir)
  // 验收桩渠道只在浏览器验收环境可用；正式环境端点拒绝、适配器工厂抛错。
  // 验收开关只认启动时继承的进程环境：工作区 .env 被 DSH 合入 process.env，不能借它在正式宿主里打开桩渠道端口。
  const launchEnv=securityEnv(ctx),stub=stubChannelPort(launchEnv)!==undefined
  const channelKinds=stub?[...imChannelKinds,imStubChannelKind]:[...imChannelKinds]
  const config=createChannelConfigStore(dir)
  const bindings=createBindingStore(dir,{perChannel:1})
  const pairing=createPairingService({now:Date.now,random:pairingCode,audit})
  const label=(channelId:string)=>manager.adapter(channelId)?.label??channelId
  // 插件释放时中止路由在途的 teloaWork.invoke 与 prompt。
  const released=new AbortController()
  const markImSession=(sessionId:string)=>work.imSessions?.register(sessionId)
  const router=createRouter({work,sessionController:ctx.sessionController,bindings,requestId:imRequestId,label,signal:released.signal,markImSession})
  // 重启后绑定里已记录的 IM 会话先行登记：工作台在首条 IM 消息到达前也不能借这些会话下载模型。
  void bindings.list().then(rows=>{for(const row of rows){if(row.assistantSessionId)markImSession(row.assistantSessionId);for(const sessionId of Object.values(row.roleSessionIds??{}))markImSession(sessionId)}}).catch(()=>{})
  // webServer 不在 inject 里（桌面壳没有），按次可选读取。
  const workbenchUrl=()=>workbenchUrlOf(ctx.get('webServer') as {port?:unknown}|undefined)
  const log={info:(format:string,...values:unknown[])=>ctx.logger.info(format,...values),warn:(format:string,...values:unknown[])=>ctx.logger.warn(format,...values)}
  // 出站按渠道限流表（capabilities.rateLimitPerMinute），首次投递时按该渠道建限流器。
  const outboundLimits=new Map<string,ReturnType<typeof createRateLimiter>>()
  const outbound=createOutbound({
   adapter:channelId=>manager.adapter(channelId),
   bindings,
   groupRunSessions:trigger=>router.groupRunSessions(trigger),
   rateLimit:{take:channelId=>{
    let limiter=outboundLimits.get(channelId)
    if(!limiter){limiter=createRateLimiter(manager.adapter(channelId)?.capabilities.rateLimitPerMinute??20,Date.now);outboundLimits.set(channelId,limiter)}
    return limiter.take(channelId)
   }},
   log,
  })
  // 审批与提问旁路（规格 §6）：发往在线渠道里绑定者的私聊，30 分钟超时只撤卡、不产生否决。
  const sideDeps:ApprovalDeps={
   bindings,
   adapter:channelId=>manager.adapter(channelId),
   onlineChannels:()=>channelKinds.filter(channelId=>manager.adapter(channelId)?.status().connected===true),
   ownerId:work.owner,
   audit,
   now:Date.now,
   timeoutMs:30*60_000,
   random:()=>randomBytes(4).toString('hex'),
   setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer},
   clearTimeout:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>),
   workbenchUrl,
  }
  const approval=createImApproval(sideDeps)
  const questions=createImQuestions(sideDeps)
  const inbound=createInbound({
   owner:work.owner,bindings,pairing,router,audit,
   rateLimit:createRateLimiter(30,Date.now),
   adapter:channelId=>manager.adapter(channelId),
   approval,
   questions,
   workbenchUrl,
   dedupe:createDedupe(),
   now:Date.now,
   // 群内他人发言：每群 10 条、合计 ≤4000 字，只在内存，不落库。
   groupBuffer:createGroupBuffer({lines:10,chars:4000}),
   outbound,
  })
  const manager=createChannelManager({
   credentials:ctx.credentials,
   config,
   bindings,
   createAdapter:(kind,deps)=>(options.createAdapter??createAdapter)(kind,{...deps,launchEnv}),
   onInbound:inbound,
   audit,
   installPackage:recipe=>work.packages.install(recipe),
   lock,
   log,
   now:()=>new Date().toISOString(),
  })
  const handler=createImEndpointHandler({
   manager,bindings,pairing,audit,lock,stub,roles:()=>idList(work,'roles/list'),groups:()=>idList(work,'groups/list'),
   // 解绑：该用户的待决审批卡与提问撤下（「已失效」），不裁决。
   onBindingRemoved:(channelId,imUserId)=>{void approval.withdrawUser(channelId,imUserId);void questions.withdrawUser(channelId,imUserId)},
  })
  const detach=work.attachExtension(imChannelEndpoints,handler)
  // 渠道停用或删除：停渠道前撤下该渠道全部待决卡与提问，不裁决。
  const offDisabled=manager.onChannelDisabled(channelId=>Promise.all([approval.withdrawChannel(channelId),questions.withdrawChannel(channelId)]).then(()=>{}))
  ctx.effect(()=>ctx.on('session/event',(session,event)=>outbound.onSessionEvent(session,event),{global:true}),'teloa-im-gateway: 出站订阅')
  // prepend：排在工作台 answerer 之前，next() 指向工作台（cordis events.d.ts EventOptions.prepend）；global：收到所有会话的请求。
  ctx.effect(()=>ctx.on('approval/request',approval.answerer,{global:true,prepend:true}),'teloa-im-gateway: 审批旁路')
  ctx.effect(()=>ctx.on('user-questions/request',questions.answerer,{global:true,prepend:true}),'teloa-im-gateway: 提问旁路')
  // 通知推送（规格 §9）：旁路挂到宿主广播适配器，只推绑定者私聊；释放时摘除。
  ctx.effect(()=>work.notifications.addAdapter(createImNotificationAdapter({bindings,adapter:sideDeps.adapter,onlineChannels:sideDeps.onlineChannels,workbenchUrl,send:(channelId,chatId,text)=>outbound.sendDirect({channelId,chatId},text)})),'teloa-im-gateway: 通知推送')
  // 验收环境预置未启用、无凭据的桩渠道行，设置页的渠道类型下拉才会出现「验收桩」。
  const provisionStub=async()=>{
   if(stub&&lock.held&&!(await config.list()).some(row=>row.channelId===imStubChannelKind))await config.upsert({channelId:imStubChannelKind,kind:imStubChannelKind,enabled:false,createdAt:new Date().toISOString()})
  }
  void provisionStub().then(()=>manager.startEnabled()).catch(()=>ctx.logger.warn('IM 渠道启动失败。'))
  // 先撤全部待决卡与提问（至多等 withdrawLimitMs，渠道还连着才能编辑卡片），再停渠道；不裁决，工作台照常可答。
  const withdrawAll=()=>new Promise<void>(resolve=>{
   const timer=setTimeout(resolve,withdrawLimitMs)
   timer.unref()
   void Promise.all([approval.withdrawAll(),questions.withdrawAll()]).catch(()=>{}).then(()=>{clearTimeout(timer);resolve()})
  })
  // 先停渠道再放锁，避免下一宿主在本宿主断开前就连上同一 bot。
  ctx.effect(()=>()=>{released.abort();detach();offDisabled();return withdrawAll().then(()=>manager.stopAll()).finally(()=>lock.release?.())},'teloa-im-gateway: 释放渠道与实例锁')
 }catch(error){
  lock.release?.()
  throw error
 }
}
