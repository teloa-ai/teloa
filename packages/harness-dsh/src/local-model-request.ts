import type {Context} from '@deepseek-ai/cordis'
import type {SessionStore} from '@deepseek-ai/dsh-session'
import {LlmError,isAgentLoopRequest,createUserMessage,type GenerateOptions,type LlmCallConfig,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {estimateMessage,estimateContent,estimateToolsTokens} from '@deepseek-ai/dsh-token-meter/estimate'
import type {} from '@deepseek-ai/dsh-token-meter'
import {hasTaskModelRouting} from './task-model-routing.ts'

export type LocalModelRequestPorts={
 prepareRequest:(config:LlmCallConfig,signal:AbortSignal)=>Promise<LlmCallConfig>
 requestCapacity:(config:LlmCallConfig,signal:AbortSignal,load?:boolean)=>Promise<number|null>
}

/** 辅助请求只估自己的实际消息；不能把整段会话的压力套给压缩选出的前缀。 */
export function estimateLocalRequest(ctx:Context,options:GenerateOptions):number{
 const pricing=ctx.llm.imageRequestPricing(options.provider,options.model)
 const images=options.messages.flatMap(message=>message.content.filter(block=>block.type==='image'))
 const prices=pricing?.priceImages(images)
 if(prices&&prices.length!==images.length)throw new Error('本地模型图片计量回包不一致。')
 let imageIndex=0,visual=0
 const messages=options.messages.map(message=>{
  const content=message.content.map(block=>{
   if(block.type==='file')return {type:'text' as const,text:ctx.llm.fileRequestText(block.attachment)}
   if(block.type==='image'&&prices){const price=prices[imageIndex++]!;visual+=price.visualTokens;return {type:'text' as const,text:price.text}}
   return block
  })
  return message.id===undefined?createUserMessage({source:{kind:'user'},content}):{...message,content}
 })
 return visual+messages.reduce((sum,message)=>sum+estimateMessage(message),0)
  +(options.system?estimateContent([{type:'text',text:options.system}])+4:0)
  +estimateToolsTokens({config:options,...(options.tools?{tools:options.tools}:{})})
}

/** DSH rc.1 公共接缝：先确定预算再记录请求，发送阶段只读，超限进入原生压缩恢复。 */
export function installLocalModelRequests(ctx:Context,ports:LocalModelRequestPorts){
 const disposePorts=ctx.provide('teloaLocalModelRequests',ports)
 const disposeRequest=ctx.on('agent/request',async({agent,signal},next)=>{
  const config=await next()
  // 根任务由固定策略在最终选模之后准备，不能先加载普通会话的部署默认模型。
  if(hasTaskModelRouting(agent)||config.provider!=='ollama')return config
  return ports.prepareRequest(await ctx.llm.resolveCallConfig(config,signal),signal)
 },{prepend:true})
 const disposeStream=ctx.on('llm/stream',async function*(options,next):AsyncIterable<StreamChunk>{
  if(options.provider!=='ollama'){yield* next();return}
  const signal=options.signal??new AbortController().signal
  try{
   signal.throwIfAborted()
   const loop=isAgentLoopRequest(options)
   const capacity=await ports.requestCapacity(options,signal,!loop)
   signal.throwIfAborted()
   if(capacity!==null){
    const store=Reflect.get(ctx,'sessions') as unknown as SessionStore
    const session=loop&&options.sessionId?store.get(options.sessionId):undefined
    if(loop&&!session)throw new Error('本地模型请求缺少原生会话计量。')
    const estimate=estimateLocalRequest(ctx,options)
    // 会话计量来自持久 surface，发送闸同时复核实际请求；缺失 usage 也不能降低这条下限。
    const measurement=session?ctx.tokenMeter.measure(session,{config:options,...(options.tools?{tools:options.tools}:{})}):undefined
    const input=Math.max(estimate,measurement?.totalTokens??0)
    // 原生计量仍为估计值；留出少量格式余量，不声称拥有 Ollama 的精确 tokenizer。
    const reserve=Math.min(256,Math.ceil(capacity*0.05))
    if(input+(options.maxTokens??capacity)+reserve>capacity){
     ctx.logger.warn('Teloa 本地模型：请求容量不足（%s，输入约 %d，请求估计 %d，会话估计 %d，输出 %d，容量 %d）。',options.purpose==='compaction'?'压缩':'对话',input,estimate,measurement?.totalTokens??0,options.maxTokens??capacity,capacity)
     yield {type:'finish',reason:{kind:'error',failure:{code:'CONTEXT_WINDOW_EXCEEDED',message:'当前内容超过本地模型实际上下文容量，请压缩会话或选择容量更大的模型。'}}}
     return
    }
   }
  }catch(error){
   signal.throwIfAborted()
   if(!(error instanceof LlmError))throw error
   yield {type:'finish',reason:{kind:'error',failure:error.failure}}
   return
  }
  yield* next()
 },{prepend:true})
 return ()=>{disposeRequest();disposeStream();disposePorts()}
}
