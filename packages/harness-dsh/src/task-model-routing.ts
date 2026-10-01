import type {Agent} from '@deepseek-ai/dsh-agent'
import {LlmError,type LlmCallConfig} from '@deepseek-ai/dsh-llm'
import {modelRecoveryReasons,readTaskRunModelPolicy,type ModelReference,type ModelRecovery,type TaskRunModelPolicy} from '@teloa/contract'

export type TaskModelRoutingPorts={
 prepareRequest?:(config:LlmCallConfig,signal:AbortSignal)=>Promise<LlmCallConfig>
 /** 切换前重读原生配置；不能把部署默认或名字叫 remote 的路由当作远程证明。 */
 isRemote:(model:ModelReference,signal:AbortSignal)=>Promise<boolean>
 requiresImages:()=>boolean
 recordRecovery:(recovery:ModelRecovery)=>Promise<void>
}
const fixedModelAgents=new WeakSet<Agent>()
export const hasTaskModelRouting=(agent:Agent)=>fixedModelAgents.has(agent)
const recoverable=(code:string):code is ModelRecovery['reason']=>(modelRecoveryReasons as readonly string[]).includes(code)
/**
 * DSH 0.1.7-rc.1 的 selectModel 会写全局默认；这里仅注册 Agent 作用域内的公开 waterfall。
 * request-error 的 retry 重进同一个 step，不重新发送用户消息，也不重放此前完成的工具。
 */
export function installTaskModelRouting(agent:Agent,input:TaskRunModelPolicy,ports:TaskModelRoutingPorts,recovered?:ModelRecovery){
 const policy=readTaskRunModelPolicy(input)
 let current=recovered?.to??policy.primary,switched=!!recovered,pending:ModelRecovery|undefined
 const switchOnce=async(code:string,signal:AbortSignal)=>{
  signal.throwIfAborted()
  if(switched||!policy.fallback||!recoverable(code))return false
  if(!await ports.isRemote(policy.fallback,signal))return false
  signal.throwIfAborted()
  if(ports.requiresImages()){
   const info=await agent.ctx.llm.resolveModelInfo(policy.fallback.provider,policy.fallback.model,signal)
   signal.throwIfAborted()
   if(!info.inputModalities?.includes('image'))return false
  }
  pending={from:current,to:policy.fallback,reason:code}
  current=policy.fallback;switched=true
  return true
 }
 const resolve=async(signal:AbortSignal,inherited?:LlmCallConfig):Promise<LlmCallConfig>=>{
  signal.throwIfAborted()
  // 只替换路由/思考档位，保留岗位或原生插件设定的输出预算与采样参数。
  const {provider:_provider,model:_model,reasoningEffort:_effort,...sampling}=inherited??{}
  const proposal=()=>({...sampling,...current}) as LlmCallConfig
  const prepare=async()=>{
   const config=await agent.ctx.llm.resolveCallConfig(proposal(),signal)
   return ports.prepareRequest?ports.prepareRequest(config,signal):config
  }
  try{return await prepare()}catch(error){
   signal.throwIfAborted()
   if(!(error instanceof LlmError)||!await switchOnce(error.code,signal))throw error
   return prepare()
  }
 }
 fixedModelAgents.add(agent)
 const disposers=[
  agent.ctx.on('agent/pre-step',async(_payload,next)=>{
   const decision=await next()
   if(decision.kind==='reject')return decision
   // 原生会话选择仍是部署默认，不能让它生成“切回默认”的错误通知。
   // 该 Run 的模型由固定策略独占，真正的切换由持久恢复通知记录。
   return {...decision,messages:decision.messages.filter(message=>message.source.kind!=='model-selection')}
  },{prepend:true}),
  agent.ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{
   const result=await next()
   return {...result,variables:{...result.variables,provider:current.provider,model:current.model}}
  },{prepend:true}),
  agent.ctx.on('agent/request',async({signal},next)=>{
   const inherited=await next();signal.throwIfAborted()
   const config=await resolve(signal,inherited)
   signal.throwIfAborted()
   // 在真实轮次内登记；准备阶段没有用户消息，不能提前污染空会话或造出新轮次。
   if(pending){await ports.recordRecovery(pending);pending=undefined}
   signal.throwIfAborted()
   return config
  },{prepend:true}),
  agent.ctx.on('agent/request-error',async({failure,signal},next)=>{
   if(signal.aborted)return
   // 先交给原生压缩/图片卸载，模型换路由不应掩盖内容预算问题。
   if(failure.code==='CONTEXT_WINDOW_EXCEEDED'||failure.code==='IMAGE_OFFLOAD_REQUIRED')return next()
   if(await switchOnce(failure.code,signal))return {kind:'retry'}
   // 备用失败即结束，不循环切回首选，也不叠加原生无限网络重试。
   if(switched)return
   return next()
  },{prepend:true}),
 ]
 return {current:()=>current,resolve,dispose:()=>{fixedModelAgents.delete(agent);for(const off of disposers)off()}}
}
