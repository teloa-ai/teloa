import type {Context} from '@deepseek-ai/cordis'
import {LlmError,type StreamChunk} from '@deepseek-ai/dsh-llm'
import type {ToolExecution,ToolExecutionToken} from '@deepseek-ai/dsh-tools'
import {WorkError} from '@teloa/contract'

/** 仅由本地授权分支赋值；不解析工具错误文本，不把网络或人工审批失败猜成权限拒绝。 */
export type TaskPermissionDenial='tool-scope'|'argument-scope'|'web-scope'
export type EmployeeRunReader=(sessionId:string,nativeRequestId:string)=>Promise<boolean>
type Binding={sessionId:string;nativeRequestId:string;business:boolean;reason?:TaskPermissionDenial}
type Stalled={nativeRequestId:string;counts:Map<TaskPermissionDenial,number>}
const discovery=new Set(['teloa_tools_load','teloa_voice_tools','teloa_capabilities','list_mcp_resources','list_mcp_resource_templates'])

/**
 * 观察官方最终工具结果，在下一次模型派发前阻断重复本地拒绝。只结束当前原生轮次；不取消工作、不结项、不删除轨迹。
 * 计数为进程内状态；宿主重启后的历史Run仍走既有人工恢复核验。新请求、成功业务工具和session释放会清除计数。
 */
export function registerTaskPermissionLoop(ctx:Context,isEmployeeRun:EmployeeRunReader){
 const pending=new Map<ToolExecutionToken,Binding>(),states=new Map<string,Stalled>()
 const result=ctx.on('tools/result',(exec,outcome)=>{
  const binding=pending.get(exec.token);pending.delete(exec.token)
  if(!binding||exec.signal.aborted)return
  let state=states.get(binding.sessionId)
  if(state&&state.nativeRequestId!==binding.nativeRequestId){states.delete(binding.sessionId);state=undefined}
  if(outcome.isError){
   if(!binding.reason)return
   if(!state){state={nativeRequestId:binding.nativeRequestId,counts:new Map()};states.set(binding.sessionId,state)}
   state.counts.set(binding.reason,(state.counts.get(binding.reason)??0)+1)
  }else if(binding.business&&!discovery.has(exec.name))states.delete(binding.sessionId)
  // 工具发现只加载schema；成功不代表目标权限已修正或取得了业务进展。
 })
 const input=ctx.on('session/event',(session,event)=>{
  if(event.type!=='user/message'||event.data.source.kind!=='user')return
  const state=states.get(session.id),request='rpcId'in event.data.source?event.data.source.rpcId:undefined
  if(state&&request!==state.nativeRequestId)states.delete(session.id)
 })
 const disposed=ctx.on('session/disposed',session=>{states.delete(session.id)})
 const check=async(sessionId:string,signal:AbortSignal|undefined)=>{
  const state=states.get(sessionId)
  if(!state||![...state.counts.values()].some(count=>count>=2))return
  signal?.throwIfAborted()
  const employee=await isEmployeeRun(sessionId,state.nativeRequestId)
  signal?.throwIfAborted()
  if(employee&&states.get(sessionId)===state){
   const error=new WorkError('teloa/permission-stalled','同类执行权限连续被拒绝，且没有新的业务进展。本轮已停止自动排查，请核对员工工具授权和本次业务范围后再继续。',{reason:'repeated-local-permission-denial'})
   throw new LlmError(error.message,error.code,{cause:error})
  }
  // 普通本人会话、owner执行或已换Run不继承员工任务的诊断计数。
  if(states.get(sessionId)===state)states.delete(sessionId)
 }
 // Loop先在步边界检查，避免外层模型预算中间件为尚未派发的请求产生预留；不影响正在结束的工具或清理。
 const step=ctx.on('agent/pre-step',async({agent,signal},next)=>{await check(agent.id,signal);return next()})
 const model=ctx.on('llm/stream',async function*(request,next):AsyncIterable<StreamChunk>{
  if(request.sessionId)await check(request.sessionId,request.signal)
  yield* next()
 })
 return {
  capture(exec:ToolExecution,sessionId:string,nativeRequestId:string,business:boolean){pending.set(exec.token,{sessionId,nativeRequestId,business})},
  denied(exec:ToolExecution,reason:TaskPermissionDenial){const binding=pending.get(exec.token);if(binding)binding.reason=reason},
  dispose(){result();input();disposed();step();model();pending.clear();states.clear()},
 }
}
