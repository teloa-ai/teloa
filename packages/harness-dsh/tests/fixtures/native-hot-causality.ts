import assert from 'node:assert/strict'
import type {TestContext} from 'node:test'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import type {ToolRunContext} from '@deepseek-ai/dsh-tools'
import type {Session,SessionEvent} from '@deepseek-ai/dsh-session'
import {LlmRuntime,LlmAdapter,ToolCallId,createUserMessage,markAgentLoopRequest,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {WorkAccess,type WorkAccessRequest,type WorkAccessPolicy} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {createNativeWorkInput} from '../../src/native-work-input.ts'
import {patchedSessionPackage,type FinalSessionStore} from './native-final-session.ts'
import {patchedNativePackage} from './native-patched-package.ts'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {NativeInputCheckpoint,NativeProgressCheckpoint} from '../../src/native-input-checkpoint.ts'

const denied=()=>new WorkError('teloa/forbidden','热运行工作因果已失效。')
export type StreamAdmissionRuntime=LlmRuntime&{
 requireStreamAdmission:()=>void
 installStreamAdmission:(policy:(options:Readonly<GenerateOptions>)=>void)=>void
}
/** 完整官方 npm 副本施精确补丁；原 marker/Adapter 模块继续只读复用。 */
export async function patchedHotLlmPackage(t:TestContext){
 const result=await patchedNativePackage<typeof import('@deepseek-ai/dsh-llm')&{
  LlmRuntime:new(ctx:Context)=>StreamAdmissionRuntime
 }>(t,{packageName:'@deepseek-ai/dsh-llm',compatBasename:'dsh-llm-0.2.0-rc.2-stream-admission'})
 return result.namespace
}

/** 官方 provider kernel 的真实四包补口副本图；Loop 直接复用同一 Tools 副本。 */
export async function nativeHotKernel(t:TestContext){
 const sessionPackage=await patchedSessionPackage(t),llmPackage=await patchedHotLlmPackage(t)
 const toolsPackage=await patchedNativePackage<typeof import('@deepseek-ai/dsh-tools')>(t,{packageName:'@deepseek-ai/dsh-tools',compatBasename:'dsh-tools-0.2.0-rc.2-work-admission'})
 const loopPackage=await patchedNativePackage<typeof import('@deepseek-ai/dsh-agent-loop')>(t,{packageName:'@deepseek-ai/dsh-agent-loop',compatBasename:'dsh-agent-loop-0.2.0-rc.2-work-admission',overrides:{'@deepseek-ai/dsh-tools':toolsPackage.root}})
 const ctx=new Context()
 t.after(()=>ctx.fiber.dispose())
 for(const plugin of [llmPackage.LlmRuntime,sessionPackage.SessionStore,SessionProjectionRegistry,SystemPrompt,toolsPackage.namespace.ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 return {ctx,sessionPackage,loopPackage,toolsPackage,sessions:Reflect.get(ctx,'sessions') as unknown as FinalSessionStore,llm:ctx.llm as StreamAdmissionRuntime}
}

/** 独立 SDK seam 验收不安装业务许可策略；只验证真实 adapter 最终派发底座。 */
export async function nativeHotLlmFixture(t:TestContext){
 const pkg=await patchedHotLlmPackage(t),ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(pkg.LlmRuntime)
 const llm=ctx.llm as StreamAdmissionRuntime,adapter=new HotAdapter();llm.registerAdapter(['hot-test'],adapter)
 return {ctx,llm,adapter,request:()=>({provider:'hot-test',model:'hot-model',messages:[]}) satisfies GenerateOptions}
}

export const textAnswer:readonly StreamChunk[]=[
 {type:'block-start',index:0,blockType:'text'},
 {type:'text-delta',index:0,text:'done'},
 {type:'block-end',index:0,block:{type:'text',text:'done'}},
 {type:'finish',reason:{kind:'stop'}},
]
export const toolAnswer:readonly StreamChunk[]=[
 {type:'block-start',index:0,blockType:'tool-call'},
 {type:'tool-call-delta',index:0,id:ToolCallId('hot-tool-call'),name:'hot_result',argumentsDelta:'{}'},
 {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('hot-tool-call'),name:'hot_result',arguments:'{}'}},
 {type:'finish',reason:{kind:'tool-calls'}},
]

/** 只控制真实公开 prepare/middleware 等待点；不在测试中替宿主主动取消 Agent。 */
function deferred<T>(){
 let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(reason?:unknown)=>void
 const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail})
 return {promise,resolve,reject}
}
export function hotGate(){
 const entered=deferred<void>(),released=deferred<void>()
 return Object.freeze({
  entered:entered.promise,
  release:()=>released.resolve(),
  async wait(signal?:AbortSignal):Promise<void>{
   entered.resolve();signal?.throwIfAborted()
   const aborted=deferred<never>()
   const onAbort=()=>aborted.reject(signal?.reason)
   signal?.addEventListener('abort',onAbort,{once:true})
   try{await Promise.race([released.promise,aborted.promise]);signal?.throwIfAborted()}
   finally{signal?.removeEventListener('abort',onAbort)}
  },
 })
}
export type HotGate=ReturnType<typeof hotGate>

/** 确定性官方适配器夹具：真实 Model/Tool/Session 路径，不代表公网模型质量。 */
export class HotAdapter extends LlmAdapter{
 readonly requests:GenerateOptions[]=[]
 readonly yielded:StreamChunk[]=[]
 readonly prepares:Array<{provider:string;model:string}>=[]
 readonly scripts:Array<readonly StreamChunk[]>=[]
 prepareGate:HotGate|undefined
 override async resolveModel(provider:string,model:string,signal?:AbortSignal){
  this.prepares.push({provider,model})
  const gate=this.prepareGate;this.prepareGate=undefined
  if(gate)await gate.wait(signal)
  return {provider,id:model,name:model,inputModalities:['text'] as const}
 }
 async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
  this.requests.push(options)
  const script=this.scripts.shift();assert.ok(script,'本地模型调用超出明确脚本')
  for(const chunk of script){this.yielded.push(chunk);yield chunk}
 }
}

/** 独立双断言只模拟业务许可；受理因果必须来自真实最终 Session 受理回执。 */
export async function nativeHotCausalityFixture(t:TestContext,options:{checkpoint?:NativeInputCheckpoint;progress?:NativeProgressCheckpoint;persistenceRoot?:string;capabilityPolicy?:WorkAccessPolicy}={}){
 const f=await nativeHotKernel(t),{ctx}=f
 if(options.persistenceRoot)await ctx.plugin(Persistence,{root:options.persistenceRoot,compression:'none'})
 const observed=new Map<Session,SessionEvent[]>()
 ctx.on('session/event',(session,event)=>{const rows=observed.get(session)??[];rows.push(event);observed.set(session,rows)},{global:true})
 const rights={valid:true,revoked:false,generation:0}
 const counters={newAssertions:0,continuationAssertions:0,tools:0}
 const authorizations:Readonly<WorkAccessRequest>[]=[]
 const access=new WorkAccess();access.requirePolicy()
 access.installPolicy(async request=>{
  if(request.kind==='capability'&&options.capabilityPolicy)return options.capabilityPolicy(request)
  authorizations.push(request)
  const generation=rights.generation
  return Object.freeze({
   assertCurrent(){counters.newAssertions++;if(!rights.valid||rights.revoked||generation!==rights.generation)throw denied()},
   assertContinuationCurrent(){counters.continuationAssertions++;if(rights.revoked||generation!==rights.generation)throw denied()},
  })
 })
 const work=createNativeWorkInput(ctx,access,options.checkpoint,options.progress);t.after(()=>work.close())
 const adapter=new HotAdapter();ctx.llm.registerAdapter(['hot-test'],adapter)
 const toolExecutions:ToolRunContext[]=[]
 let toolAction:(exec:ToolRunContext)=>Promise<void>=async()=>{}
 ctx.tools.register(defineTool({
  name:'hot_result',description:'本地确定性结果夹具',parameters:{},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  async execute(_args,exec){counters.tools++;toolExecutions.push(exec);await toolAction(exec);return 'hot-result'},
 }))
 await ctx.plugin(f.loopPackage.namespace.AgentLoop,{agents:[]})
 // factory 在 Loop 尚未挂载时创建；activate 完成必须已安装唯一原 policy，测试不补装。
 const loop=Reflect.get(ctx,'agentLoop') as object
 const installPolicy=Reflect.get(Object.getPrototypeOf(loop) as object,'installWorkAdmission') as unknown
 assert.equal(typeof installPolicy,'function')
 assert.throws(()=>Reflect.apply(installPolicy as (...args:unknown[])=>unknown,loop,[()=>{}]),{message:'Agent loop work admission is unavailable or invalid'})
 const {agent}=await ctx.agents.create({sessionId:f.sessionPackage.SessionId('hot-a'),agentOptions:{provider:'hot-test',model:'hot-model'}})
 const {agent:other}=await ctx.agents.create({sessionId:f.sessionPackage.SessionId('hot-b'),agentOptions:{provider:'hot-test',model:'hot-model'}})
 assert.equal(f.sessions.get(agent.id),agent.session);assert.equal(ctx.agents.get(agent.id),agent)
 return {
  ...f,agent,other,rights,counters,authorizations,adapter,work,access,toolExecutions,
  events(target:Agent=agent):readonly SessionEvent[]{return observed.get(target.session)??[]},
  setToolAction(action:(exec:ToolRunContext)=>Promise<void>){toolAction=action},
  async send(rpcId:string,target:Agent=agent,wakeup=true){
   const message=createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text:'完成本地热因果验证'}]})
   await work.withNewInput(target,message,{producer:'prompt',identity:rpcId},()=>{if(wakeup)target.followup(message);else target.inbox.append('next-turn',message)})
   return message
  },
  holdStream(gate:HotGate,prepend:boolean){
   return ctx.on('llm/stream',async function*(options,next){await gate.wait(options.signal);yield* next()},{prepend})
  },
 }
}

export async function drain(stream:AsyncIterable<StreamChunk>):Promise<StreamChunk[]>{
 const chunks:StreamChunk[]=[];for await(const chunk of stream)chunks.push(chunk);return chunks
}

/** 真实历史可以重建请求，但已结束的 step 和可人为设定的 initiator 不是执行许可。 */
export function reconstructedRequest(agent:Agent,baseline:GenerateOptions):GenerateOptions{
 const header=agent.session.requestHeader();assert.ok(header)
 const messages=agent.session.deriveMessages();Object.freeze(messages)
 return markAgentLoopRequest(Object.freeze({
  ...baseline,...header.config,
  messages,
  toolHistory:agent.session.toolHistory(),
  ...header.tools===undefined?{}:{tools:header.tools},
  sessionId:agent.id,signal:new AbortController().signal,
 }))
}
