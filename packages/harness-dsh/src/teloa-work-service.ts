import {WorkError,imChannelEndpoints} from '@teloa/contract'
import type {BroadcastNotificationAdapter,NotificationChannelAdapter} from './notification-deliveries.ts'
import {assertAllowedManagedPackage} from './managed-package-install.ts'

/**
 * invoke 端点白名单：只放 IM 通道一期（功能验证a 私聊路由与命令、9b 群发言与群 @ 回复回发的只读反查、8a 设置页员工/群下拉）实际用到的端点；
 * 功能验证 审批/提问走事件、功能验证 通知走 notifications.addAdapter，均不经 invoke。其余端点一律 teloa/forbidden。
 */
export const teloaWorkInvokeEndpoints=['conversations/read','conversations/create','object-conversations/change','roles/list','groups/list','groups/get','groups/messages/send','tasks/list','task-runs/list','tasks/attention','security-actions/attention'] as const

export type TeloaExtensionHandler=(endpoint:string,payload:unknown,signal:AbortSignal)=>Promise<unknown>

/** 进程内 cordis 服务 `teloaWork`：宿主内其它 Teloa 插件（IM 通道）经它调用 Teloa 端点、挂接扩展端点、追加通知适配器、受管安装 npm 包。 */
export type TeloaWorkService={
 /** index.ts 常量 owner（'local:teloa-owner'）。 */
 readonly owner:string
 /** applyHost 内 resolveTeloaRuntime(projectRoot)。 */
 readonly runtimeRoot:string
 /**
  * 直达 applyHost 内的 dispatchTeloaEndpoint：不经 invokeTeloaEndpoint、不 reserve pending request（评审 H3）。
  * 只接受 teloaWorkInvokeEndpoints，其余 → teloa/forbidden（不调用 dispatch）。
  * IM 侧写操作的幂等由调用方按 channel+messageId 派生的确定性 requestId 保证，由各端点自身的 requestId 去重语义兜底。
  */
 invoke(endpoint:string,payload:unknown,signal:AbortSignal):Promise<unknown>
 /** 把一组端点交给扩展处理；只接受契约 imChannelEndpoints（扩展分发先于核心路由，不得覆盖核心端点），其余 → throw；首个调用方登记后锁定，再挂接 → throw；返回 dispose。 */
 attachExtension(endpoints:readonly string[],handler:TeloaExtensionHandler):()=>void
 notifications:{addAdapter(adapter:NotificationChannelAdapter):()=>void}
 /** IM 通道登记其发起的会话（进程内、只增不删）；宿主据此拒绝 IM 会话调用只允许在工作台确认的工具（终审 I-3）。 */
 imSessions:{register(sessionId:string):void;has(sessionId:string):boolean}
 /** 受管 npm 安装（包名白名单、串行队列、--ignore-scripts、核对 integrity），返回安装目录；白名单外 → teloa/forbidden。 */
 packages:{install(recipe:{package:string;version:string;integrity:string}):Promise<string>}
}

declare module '@deepseek-ai/cordis'{interface Context{teloaWork:TeloaWorkService}}

export function createTeloaWorkService(input:{owner:string;runtimeRoot:string;dispatch:TeloaWorkService['invoke'];broadcast:BroadcastNotificationAdapter;install:TeloaWorkService['packages']['install']
 /**
  * 宿主此刻是否开放 IM 通道挂接：装配期（bundles 含 `@teloa/im-gateway`，到首次挂接或本人第一次启停 IM 为止）与本人启用 IM 通道时的那一次热套用窗口内，
  * 且生效组合里确有 `teloa-im-gateway` 行；其余时刻一律拒绝。
  */
 attachAllowed:()=>boolean}):TeloaWorkService&{dispatchExtension(endpoint:string,payload:unknown,signal:AbortSignal):Promise<unknown>|undefined;extensionAttached():boolean
 /** 只供宿主：IM 启用热套用失败时撤掉当前持有者（防窗口内被其它进程内插件抢先挂接后留下）；旧持有者的 dispose 随之失效。 */
 revokeExtension():void}{
 const extensions=new Map<string,TeloaExtensionHandler>()
 const imSessions=new Set<string>()
 let holder:TeloaExtensionHandler|undefined
 return {
  owner:input.owner,
  runtimeRoot:input.runtimeRoot,
  invoke:async(endpoint,payload,signal)=>{
   if(!(teloaWorkInvokeEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/forbidden','IM 通道不能调用该 Teloa 端点：'+endpoint)
   return input.dispatch(endpoint,payload,signal)
  },
  attachExtension(endpoints,handler){
   const foreign=endpoints.find(endpoint=>!(imChannelEndpoints as readonly string[]).includes(endpoint))
   if(foreign!==undefined)throw new Error('Teloa 扩展端点不在 IM 通道契约内：'+foreign)
   // 审查 L6（放宽为单持有者）：同一时刻只接受一个持有者；持有者释放后，仅在宿主开放的挂接窗口内（装配期或本人启用时的热套用）
   // 才接受下一次挂接，防其它进程内插件在窗口外接管 im/*。
   if(holder!==undefined)throw new Error('Teloa 扩展端点已有持有者，不再接受挂接：'+endpoints.join(', '))
   if(!input.attachAllowed())throw new Error('当前不在 IM 通道挂接窗口内，拒绝挂接扩展端点：'+endpoints.join(', '))
   holder=handler
   for(const endpoint of endpoints)extensions.set(endpoint,handler)
   let released=false
   return ()=>{
    if(released)return
    released=true
    for(const endpoint of endpoints)if(extensions.get(endpoint)===handler)extensions.delete(endpoint)
    if(holder===handler)holder=undefined
   }
  },
  dispatchExtension(endpoint,payload,signal){
   const handler=extensions.get(endpoint)
   return handler?handler(endpoint,payload,signal):undefined
  },
  extensionAttached:()=>extensions.size>0,
  revokeExtension(){extensions.clear();holder=undefined},
  notifications:{addAdapter:adapter=>input.broadcast.add(adapter)},
  imSessions:{register:sessionId=>{if(typeof sessionId==='string'&&sessionId)imSessions.add(sessionId)},has:sessionId=>imSessions.has(sessionId)},
  packages:{install:async recipe=>{
   assertAllowedManagedPackage(recipe)
   return input.install(recipe)
  }},
 }
}

/**
 * IM 通道挂接窗口（审查 L6 放宽）：
 * - 装配期窗口：仅当本次启动的 bundles 含 IM 时开放；首次挂接成功（allowed 返回 true）或本人第一次启停（closeStartup）即关闭。
 *   不按宿主就绪关闭：Teloa 业务装配是异步的，`teloaWork` 常在宿主就绪之后才提供，IM 要等它注入后才会挂接。
 * - 启用热套用窗口：本人启用 IM 时那一次官方热套用期间（during）。
 * 两者都还要求生效组合里确有 IM 行。allowed 只由 attachExtension 在即将登记持有者时调用。
 */
export function createImAttachWindow(input:{startup:boolean;rowPresent:()=>boolean}){
 let startup=input.startup,hot=false
 return {
  allowed:()=>{
   if(!input.rowPresent())return false
   if(hot)return true
   if(!startup)return false
   startup=false
   return true
  },
  closeStartup:()=>{startup=false},
  async during<T>(operation:()=>Promise<T>):Promise<T>{
   hot=true
   try{return await operation()}finally{hot=false}
  },
 }
}
