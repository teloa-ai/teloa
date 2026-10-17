import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {LlmAdapter,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import type {ToolExecutionResult} from '@deepseek-ai/dsh-tools'
import {readSessionEvents} from '../../src/session-events.ts'
import {publishNativeFixtureInput} from './native-host-services.ts'

type Call={kind:'tool';name:string;arguments:Record<string,unknown>;callId:ToolCallId;resolve:(result:ToolExecutionResult)=>void}
type Answer={kind:'answer';text:string}
type State={agent:Agent;queue:(Call|Answer)[];wake?:()=>void;active?:Call}

/** 只脚本化模型 IO；输入、轮次、工具票据、审批及结果均由原生 Loop 生成。 */
export function nativeToolInvocation(ctx:Context,route?:{providers:string[];adapter:LlmAdapter}){
 const states=new Map<string,State>(),provider='fixture-tool-loop-'+randomUUID()
 class ToolModel extends LlmAdapter{
  override async resolveModel(provider:string,model:string){return route?route.adapter.resolveModel(provider,model):{provider,id:model,name:model,defaultMaxTokens:1024}}
  async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
   const state=states.get(String(options.sessionId))
   if(!state){assert.ok(route,'脚本只能服务显式选择的本人 Agent');yield* route.adapter.stream(options);return}
   while(!state.queue.length){
    await new Promise<void>((resolve,reject)=>{
     const abort=()=>{delete state.wake;reject(options.signal?.reason??Error('模型请求取消'))}
     if(options.signal?.aborted)return abort()
     state.wake=()=>{options.signal?.removeEventListener('abort',abort);delete state.wake;resolve()}
     options.signal?.addEventListener('abort',abort,{once:true})
    })
   }
   const call=state.queue.shift()!
   const units=(value:unknown)=>Math.ceil(Buffer.byteLength(JSON.stringify(value),'utf8')/4)
   if(call.kind==='answer'){
    yield {type:'block-start',index:0,blockType:'text'}
    yield {type:'text-delta',index:0,text:call.text}
    yield {type:'block-end',index:0,block:{type:'text',text:call.text}}
    yield {type:'usage',usage:{inputTokens:units({messages:options.messages,system:options.system,tools:options.tools,toolHistory:options.toolHistory}),outputTokens:units(call.text)}}
    yield {type:'finish',reason:{kind:'stop'}}
    return
   }
   state.active=call
   const argumentsText=JSON.stringify(call.arguments)
   yield {type:'block-start',index:0,blockType:'tool-call'}
   yield {type:'tool-call-delta',index:0,id:call.callId,name:call.name,argumentsDelta:argumentsText}
   yield {type:'block-end',index:0,block:{type:'tool-call',id:call.callId,name:call.name,arguments:argumentsText}}
   // 脚本模型的确定性计费单位是四个 UTF-8 字节；这是模型 IO 夹具的用量回包。
   // 未知用量会保留真实预算预留，不能把已经完成的脚本请求留成未知外部消耗。
   yield {type:'usage',usage:{inputTokens:units({messages:options.messages,system:options.system,tools:options.tools,toolHistory:options.toolHistory}),outputTokens:units({name:call.name,arguments:call.arguments})}}
   yield {type:'finish',reason:{kind:'tool-calls'}}
  }
 }
 ctx.llm.registerAdapter(route?.providers??[provider],new ToolModel())
 ctx.on('tools/result',(exec,result)=>{
  if(!exec.agent)return
  const state=states.get(String(exec.agent.id)),call=state?.active
  if(call&&call.callId===exec.callId){delete state!.active;call.resolve(result)}
 })
 ctx.effect(()=>()=>{for(const {agent} of states.values())agent.cancel({kind:'disposed'})})
 const stateFor=(agent:Agent)=>{
  let state=states.get(String(agent.id))
  if(!state){state={agent,queue:[]};states.set(String(agent.id),state);if(!route){agent.options.provider=provider;agent.options.model='scripted-tools';agent.options.maxTokens=1024}}
  return state
 }
 const instruction=async(agent:Agent,text='请整理客户业务草案',options?:{signal:AbortSignal})=>{
  options?.signal.throwIfAborted()
  const abort=()=>agent.cancel({kind:'user'})
  options?.signal.addEventListener('abort',abort,{once:true})
  try{
   const state=stateFor(agent),executing=!!state.active
   if(agent.status==='running'){
    agent.cancel({kind:'user'},{keepInbox:true})
    // 审批回调内不能等待自己结束；取消信号已使旧执行票据失效。
    if(!executing)await agent.whenIdle()
   }
   await publishNativeFixtureInput(ctx,agent,createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}))
   options?.signal.throwIfAborted()
   return agent
  }finally{options?.signal.removeEventListener('abort',abort)}
 }
 const invoke=async(agent:Agent,input:{name:string;arguments?:Record<string,unknown>;callId?:ToolCallId;signal?:AbortSignal}):Promise<ToolExecutionResult>=>{
  const signal=input.signal??AbortSignal.timeout(15000);signal.throwIfAborted()
  const state=stateFor(agent),before=readSessionEvents(agent.session).length,callId=input.callId??ToolCallId(randomUUID())
  let finish!:(result:ToolExecutionResult)=>void
  const result=new Promise<ToolExecutionResult>(resolve=>finish=resolve)
  let rejectAbort!:(reason:unknown)=>void
  const aborted=new Promise<never>((_,reject)=>rejectAbort=reject)
  const abort=()=>{agent.cancel({kind:'user'});rejectAbort(signal.reason)}
  signal.addEventListener('abort',abort,{once:true})
  try{
   state.queue.push({kind:'tool',name:input.name,arguments:input.arguments??{},callId,resolve:finish});state.wake?.()
   if(agent.status==='idle')await instruction(agent)
   const settled=await Promise.race([result,agent.whenIdle().then(()=>{
    const ended=readSessionEvents(agent.session).slice(before).reverse().find(event=>event.type==='turn/end')
    assert.ok(ended?.type==='turn/end','未执行的工具必须有真实轮次拒绝结果')
    assert.notEqual(ended.data.reason.kind,'completed','模型正常结束不能冒充工具拒绝')
    return {isError:true,error:{message:JSON.stringify(ended.data.reason)},content:[{type:'text',text:JSON.stringify(ended.data.reason)}]} as ToolExecutionResult
   }),aborted])
   // tools/result 是公开执行结果；返回前等待 Loop 把同一结果写入真实日志。
   if(!readSessionEvents(agent.session).slice(before).some(event=>event.type==='tool/call'&&event.data.callId===callId)){
    return settled
   }
   for(let attempt=0;attempt<100;attempt++){
    if(readSessionEvents(agent.session).slice(before).some(event=>event.type==='tool/result'&&event.data.message.toolCallId===callId))return settled
    if(agent.status==='idle'&&settled.isError)return settled
    await new Promise(resolve=>setTimeout(resolve,1))
   }
   throw Error('原生工具结果没有提交到日志')
  }finally{
   signal.removeEventListener('abort',abort)
   state.queue=state.queue.filter(call=>call.kind!=='tool'||call.callId!==callId)
   if(state.active?.callId===callId)delete state.active
  }
 }
 const finish=async(agent:Agent,text:string)=>{
  const state=stateFor(agent)
  assert.equal(agent.status,'running','模型回复必须结束真实在途原轮次')
  state.queue.push({kind:'answer',text});state.wake?.()
  await agent.whenIdle()
  const last=readSessionEvents(agent.session).filter(event=>event.type==='turn/end').at(-1)
  assert.equal(last?.data.reason.kind,'completed','脚本回复必须经过真实 Loop 正常结束')
 }
 // 执行域已经由 Task driver 受理的 Agent 只选择模型 IO，不追加本人指令或重建任务输入。
 return {select:(agent:Agent)=>{stateFor(agent)},instruction,invoke,finish}
}
