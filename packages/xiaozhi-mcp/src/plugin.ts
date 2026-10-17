import type {Context} from '@deepseek-ai/cordis'
import {credentialRef} from '@deepseek-ai/dsh-credentials'
import {WorkError,assistantChannelApiVersion,hardwareRecord,hardwareScopes,type AssistantChannelHost,type AssistantChannelLease,type HardwareRequestPort,type HardwareScope} from '@teloa/contract'
import {createXiaozhiBridge,type XiaozhiBridgePorts} from './bridge.ts'
import {readXiaozhiEndpoint} from './endpoint.ts'

export const name='teloa-xiaozhi-mcp'
export const inject=['teloaAssistantChannels','credentials'] as const
type Bridge=Pick<ReturnType<typeof createXiaozhiBridge>,'start'|'stop'|'state'>
/** 可信宿主测试用的传输工厂；不接受模型、配置或网络传来的工厂。 */
export type XiaozhiPluginOptions={createBridge?:(ports:XiaozhiBridgePorts)=>Bridge}
const ref=credentialRef('XIAOZHI_MCP_ENDPOINT')
const forbidden=()=>new WorkError('teloa/forbidden','该硬件连接当前未获授权。')
const unavailable=()=>new WorkError('teloa/unavailable','请先配置接入点，并使用支持助手通道的 Teloa 版本。')

/** 可选插件：未装载时无官方连接；装载不等于启用，MCP 只得到窄请求端口。 */
export function apply(ctx:Context,options:XiaozhiPluginOptions={}):void{
 const host=ctx.get('teloaAssistantChannels') as AssistantChannelHost|undefined
 if(host?.version!==assistantChannelApiVersion||typeof host.attach!=='function')throw unavailable()
 let closed=false,permitted=false,revision=0
 let management=Promise.resolve<unknown>(undefined)
 let lease:AssistantChannelLease,bridge:Bridge
 const assertLive=()=>{if(closed)throw forbidden()}
 const assertRevision=(expected:number)=>{assertLive();if(revision!==expected)throw new WorkError('teloa/conflict','连接设置已变化，请查看当前状态。')}
 const assertRequest=()=>{assertLive();if(!permitted)throw forbidden()}
 const invokeRequest=async<T>(call:()=>Promise<T>):Promise<T>=>{
  assertRequest();const expected=revision
  const value=await call()
  assertRequest();if(revision!==expected)throw forbidden()
  return value
 }
 const requests:HardwareRequestPort=Object.freeze({
  prepare:text=>invokeRequest(()=>lease.requests.prepare(text)),
  submit:(id,signal)=>invokeRequest(()=>lease.requests.submit(id,signal)),
  result:id=>invokeRequest(()=>lease.requests.result(id)),
 })
 const status=async()=>{
  assertLive()
  const [authorization,credential]=await Promise.all([lease.snapshot(),ctx.credentials.describe(ref)])
  assertLive()
  return {available:true,configured:credential.configured,writable:credential.writable,state:bridge.state,authorization}
 }
 const handle=async(endpoint:string,payload:unknown,signal:AbortSignal):Promise<unknown>=>{
  assertLive();signal.throwIfAborted()
  if(endpoint==='devices/status'){hardwareRecord(payload,[]);return status()}
  if(!['devices/mcp/save','devices/mcp/test','devices/grant/update','devices/revoke'].includes(endpoint))throw forbidden()
  // 先校验再建立拒绝屏障；非法请求不能中断有效通道。
  let secret:string|undefined,scopes:readonly HardwareScope[]|undefined
  if(endpoint==='devices/mcp/save')secret=readXiaozhiEndpoint(hardwareRecord(payload,['endpoint']).endpoint)
  else if(endpoint==='devices/grant/update'){
   const input=hardwareRecord(payload,['scopes']).scopes
   if(!Array.isArray(input)||input.some(scope=>!hardwareScopes.includes(scope))||new Set(input).size!==input.length)throw new WorkError('teloa/invalid-input','连接授权范围不正确。')
   scopes=[...input]
  }else hardwareRecord(payload,[])
  const expected=++revision
  permitted=false
  const stopped=bridge.stop()
  // revoke 在返回 Promise 前建立宿主最终准入屏障，不等停链或管理队列。
  const revoked=endpoint==='devices/mcp/save'||endpoint==='devices/revoke'?lease.revoke():undefined
  void revoked?.catch(()=>{})
  const action=async()=>{
   await stopped;assertRevision(expected);signal.throwIfAborted()
   if(endpoint==='devices/mcp/save'){
    // 更换秘密必须重新授权，不能把既有助手授权自动转给另一个智能体。
    await revoked;assertRevision(expected)
    await ctx.credentials.set(ref,secret!);assertRevision(expected)
   }else if(endpoint==='devices/revoke'){
    await revoked;assertRevision(expected)
   }else{
    if(!(await ctx.credentials.describe(ref)).configured)throw unavailable()
    assertRevision(expected);signal.throwIfAborted()
    if(scopes){await lease.updateGrant(scopes);assertRevision(expected)}
    const authorization=await lease.snapshot();assertRevision(expected)
    if(!authorization.enabled)throw forbidden()
    permitted=true;bridge.start()
   }
   return status()
  }
  const result=management.then(action,action)
  management=result.catch(()=>{})
  return result
 }
 lease=host.attach({id:'xiaozhi-mcp',handle})
 try{
  bridge=(options.createBridge??createXiaozhiBridge)({requests,endpoint:async()=>{
   assertRequest()
   const value=await ctx.credentials.resolve(ref);assertRequest()
   if(!value)throw unavailable()
   return readXiaozhiEndpoint(value.value)
  }})
 }catch(error){void lease.close().catch(()=>{});throw error}
 ctx.effect(()=>()=>{
  closed=true;permitted=false;revision++
  // close 的同步屏障先执行；异步停链和释放不等待/取消原助手任务。
  const detached=lease.close(),stopped=bridge.stop()
  return Promise.all([detached,stopped,management]).then(()=>{})
 },'teloa-xiaozhi-mcp: 断开连接并释放通道')
 const initial=revision
 void Promise.all([lease.snapshot(),ctx.credentials.describe(ref)]).then(([authorization,credential])=>{
  if(!closed&&revision===initial&&authorization.enabled&&credential.configured){permitted=true;bridge.start()}
 }).catch(()=>ctx.logger.warn('小智 MCP 连接尚未就绪，请在设置中核对。'))
}
