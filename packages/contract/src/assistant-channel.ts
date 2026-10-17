import type {HardwareRequestPort,HardwareScope} from './devices.ts'

export const assistantChannelApiVersion=1
export type AssistantChannelStatus=Readonly<{enabled:boolean;grantVersion:number;scopes:readonly HardwareScope[];assistantName:string}>
/** 原助手的宿主权威端口：不接受外部 owner、session、路径或原生 RPC。 */
export type AssistantChannelLease=Readonly<{
 requests:HardwareRequestPort
 snapshot:()=>Promise<AssistantChannelStatus>
 updateGrant:(scopes:readonly HardwareScope[])=>Promise<void>
 /** 调用即同步拒绝新输入与外发，返回前持久撤销；更早的在途授权更新不得重新开放。不取消已受理工作。 */
 revoke:()=>Promise<void>
 /** 调用即封闭本租约；释放挂接，不删除持久来源和原工作。 */
 close:()=>Promise<void>
}>
export type AssistantChannelRegistration=Readonly<{
 id:'xiaozhi-mcp'
 handle:(endpoint:string,payload:unknown,signal:AbortSignal)=>Promise<unknown>
}>
/** 同进程可信插件的版本化扩展面；不是恶意插件沙箱。 */
export type AssistantChannelHost=Readonly<{version:typeof assistantChannelApiVersion;attach:(registration:AssistantChannelRegistration)=>AssistantChannelLease}>
