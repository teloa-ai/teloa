import {AsyncLocalStorage} from 'node:async_hooks'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {GenerateOptions,StreamChunk} from '@deepseek-ai/dsh-llm'
import {Session,SessionId,SessionLogOffset,type SessionEvent,type SessionHeader,type SessionStore,type UserMessage} from '@deepseek-ai/dsh-session'
import type {ToolExecutionInput,ToolExecutionResult,ToolRunContext} from '@deepseek-ai/dsh-tools'
import type {WorkAccessLease} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {assertNativeInputAcceptanceCurrent,nativeInputIdentity,type NativeInputAcceptance,type NativeInputIdentity} from './native-input-access.ts'
import {admitNativeResourceCleanup,enterNativeResourceCleanup,isNativeResourceCleanupScope} from './native-resource-cleanup.ts'

type Step={number:number;signal:AbortSignal}
type Turn={agent:Agent;session:Session;number:number;signal:AbortSignal;roots:Set<NativeInputAcceptance>;step:Step|undefined}
type Model={turn:Turn;step:Step;options:GenerateOptions;entered:boolean;active:boolean}
type ToolCause={turn:Turn;step:Step;exec:ToolRunContext;signal:AbortSignal;parent:ToolRunContext['parent'];token:ToolRunContext['token'];agent:Agent;callId:string;rootCallId:string;name:string;arguments:unknown;active:boolean}
type PendingInput={receipt:NativeInputAcceptance;roots:readonly NativeInputAcceptance[]}
type ContextPublication={session:Session;identity:NativeInputIdentity;roots:readonly NativeInputAcceptance[];accepted:boolean}
type Position=Readonly<{agent:Agent;turn:number;signal:AbortSignal}>
type LoopRequest=
 |Position&Readonly<{kind:'turn-start'}>
 |Position&Readonly<{kind:'turn-end'}>
 |Position&Readonly<{kind:'claim';message:UserMessage}>
 |Position&Readonly<{kind:'step-start';step:number}>
 |Position&Readonly<{kind:'step-end';step:number}>
 |Position&Readonly<{kind:'request';step:number;options:GenerateOptions}>
 |Position&Readonly<{kind:'tool-prepare';step:number;input:ToolExecutionInput}>
 |Position&Readonly<{kind:'context';step:number;exec:ToolRunContext;result:ToolExecutionResult;context:UserMessage;publish:()=>void}>
type ToolRequest=
 |Readonly<{kind:'create';input:ToolExecutionInput;exec:ToolRunContext}>
 |Readonly<{kind:'body'|'body-end';exec:ToolRunContext}>
type RestoreRequest=Readonly<{sessionId:string;header:Readonly<SessionHeader>;events:readonly SessionEvent[];inheritedEventCount:number;signal:AbortSignal}>
type PublishContinuation=(agent:Agent,message:UserMessage,lease:WorkAccessLease,publish:()=>void)=>void
const installed=new WeakSet<Context>()
const denied=()=>new WorkError('teloa/forbidden','工作许可或实际受理因果已失效。')
const reason='工作许可或实际受理因果已失效。'
function canonical(value:unknown):string{
 if(value===null||typeof value!=='object'){const text=JSON.stringify(value);if(text===undefined)throw denied();return text}
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(Reflect.get(value,key))).join(',')+'}'
}
function install(receiver:object,requireName:string,installName:string,policy:unknown):void{
 const prototype=Object.getPrototypeOf(receiver) as object
 for(const [name,parameters] of [[requireName,[]],[installName,[policy]]] as const){
  const method:unknown=Reflect.get(prototype,name)
  if(typeof method!=='function')throw denied()
  const returned:unknown=Reflect.apply(method,receiver,parameters)
  if(returned!==undefined){void Promise.resolve(returned).catch(()=>{});throw denied()}
 }
}

/**
 * 权限证明只来自最终受理回执和官方私有执行点；公共事件与归因标记不授予执行许可。
 * 官方 Loop/Tools 仍负责运行、调度、持久化、结果与取消；这里仅核对实际对象与许可。
 */
export function createNativeWorkCausality(ctx:Context,publishContinuation:PublishContinuation){
 if(installed.has(ctx))throw denied()
 const pending=new WeakMap<UserMessage,PendingInput>(),turns=new Map<Agent,Turn>()
 const received=new WeakSet<NativeInputAcceptance>(),acceptedIds=new WeakMap<Session,Set<string>>()
 const models=new WeakMap<GenerateOptions,Model>(),planned=new WeakMap<ToolExecutionInput,{turn:Turn;step:Step}>()
 const executions=new WeakMap<ToolRunContext,ToolCause>(),activeTool=new AsyncLocalStorage<ToolCause>()
 let closed=false,loopReady=false
 // 仅覆盖下面的同步最终发布；不向公共事件、工具或调用者暴露继承证明。
 let contextPublication:ContextPublication|undefined
 const sessions=()=>Reflect.get(ctx,'sessions') as unknown as SessionStore
 const cancel=(agent:Agent)=>{try{agent.cancel({kind:'hook',reason},{keepInbox:true})}catch{}}
 const target=(turn:Turn)=>{if(closed||ctx.agents.get(turn.agent.id)!==turn.agent||turn.agent.session!==turn.session||sessions().get(turn.agent.id)!==turn.session)throw denied()}
 const fixedRoots=(roots:readonly NativeInputAcceptance[])=>{if(closed||roots.length===0)throw denied();for(const receipt of roots)assertNativeInputAcceptanceCurrent(receipt)}
 const current=(turn:Turn,step?:Step)=>{
  try{target(turn);fixedRoots([...turn.roots]);target(turn);if(turns.get(turn.agent)!==turn||step!==undefined&&turn.step!==step)throw denied();turn.signal.throwIfAborted();step?.signal.throwIfAborted()}
  catch{cancel(turn.agent);throw denied()}
 }
 const actual=(request:Position,stepNumber?:number)=>{
  const turn=turns.get(request.agent),step=turn?.step
  if(!turn||turn.number!==request.turn||turn.signal!==request.signal||stepNumber!==undefined&&(!step||step.number!==stepNumber))throw denied()
  current(turn,stepNumber===undefined?undefined:step);return {turn,step}
 }
 const assertModel=(model:Model)=>{
  try{if(!model.active||model.options.signal!==model.step.signal)throw denied();current(model.turn,model.step)}
  catch{cancel(model.turn.agent);throw denied()}
 }
 const assertTool=(cause:ToolCause)=>{
  try{
   const exec=cause.exec
   // 可重入读取和 signal 方法均先于最后许可检查；不从可变 input 重建身份。
   const identity={token:exec.token,agent:exec.agent,callId:exec.callId,rootCallId:exec.rootCallId,name:exec.name,parent:exec.parent,arguments:exec.arguments,signal:exec.signal}
   if(executions.get(exec)!==cause||identity.token!==cause.token||identity.agent!==cause.agent||identity.callId!==cause.callId||identity.rootCallId!==cause.rootCallId||identity.name!==cause.name||identity.parent!==cause.parent||identity.arguments!==cause.arguments)throw denied()
   cause.signal.throwIfAborted();identity.signal.throwIfAborted()
   current(cause.turn,cause.step)
   // 许可回调也可能重入。只读 SDK 原对象的 data descriptor，避免再次调用 getter。
   for(const [key,value] of Object.entries(identity)){
    const descriptor=Object.getOwnPropertyDescriptor(exec,key)
    if(descriptor===undefined?value!==undefined:!Object.hasOwn(descriptor,'value')||descriptor.value!==value)throw denied()
   }
  }catch{cancel(cause.agent);throw denied()}
 }
 const loopPolicy=(request:LoopRequest):void=>{
  const {agent}=request
  if(request.kind==='turn-end'){turns.delete(agent);return}
  if(request.kind==='step-end'){
   const turn=turns.get(agent);if(turn?.number===request.turn&&turn.step?.number===request.step)turn.step=undefined
   return
  }
  try{
   if(closed||!loopReady||ctx.agents.get(agent.id)!==agent||sessions().get(agent.id)!==agent.session)throw denied()
   request.signal.throwIfAborted()
   if(request.kind==='turn-start'){
    if(turns.has(agent))throw denied()
    turns.set(agent,{agent,session:agent.session,number:request.turn,signal:request.signal,roots:new Set(),step:undefined});return
   }
   if(request.kind==='claim'){
    const turn=turns.get(agent),input=pending.get(request.message)
    if(!turn||turn.number!==request.turn||turn.signal!==request.signal||!input||input.receipt.session!==turn.session)throw denied()
    // claim 仍须核对精确最终回执；同 Session 派生输入只合并其原始授权根。
    assertNativeInputAcceptanceCurrent(input.receipt);target(turn);pending.delete(request.message)
    for(const root of input.roots)turn.roots.add(root)
    return
   }
   if(request.kind==='step-start'){
    const {turn}=actual(request)
    if(turn.step!==undefined)throw denied();turn.step={number:request.step,signal:request.signal};return
   }
   const {turn,step}=actual(request,request.step);if(!step)throw denied()
   if(request.kind==='request'){
    const options=request.options
    if(models.has(options)||options.sessionId!==agent.id||options.signal!==step.signal||!Object.isFrozen(options))throw denied()
    models.set(options,{turn,step,options,entered:false,active:false});return
   }
   if(request.kind==='tool-prepare'){
    if(planned.has(request.input)||request.input.agent!==agent||request.input.parent!==undefined||request.input.signal!==step.signal)throw denied()
    planned.set(request.input,{turn,step});return
   }
   const cause=executions.get(request.exec)
   if(!cause||cause.turn!==turn||cause.step!==step)throw denied()
   assertTool(cause)
   const identity=nativeInputIdentity(request.context)
   if(!request.result.additionalContexts?.includes(request.context)||acceptedIds.get(turn.session)?.has(identity.messageId))throw denied()
   let publishing=true
   const captured=[...turn.roots]
   const lease=Object.freeze({
    assertCurrent(){if(!publishing)throw denied();assertTool(cause)},
    assertContinuationCurrent(){fixedRoots(captured)},
   })
   const previous=contextPublication,publication:ContextPublication={session:turn.session,identity,roots:captured,accepted:false}
   contextPublication=publication
   try{
    publishContinuation(agent,request.context,lease,request.publish)
    if(!publication.accepted)throw denied()
   }finally{publishing=false;contextPublication=previous}
  }catch{cancel(agent);throw denied()}
 }
 const toolPolicy=(request:ToolRequest):void=>{
  if(admitNativeResourceCleanup(ctx,request))return
  if(request.kind==='body-end'){
   const cause=executions.get(request.exec);if(cause)cause.active=false
   return
  }
  const {exec}=request,registered=executions.get(exec),agent=registered?.agent??exec.agent
  if(!agent)return
  try{
   if(request.kind==='create'){
    let origin=planned.get(request.input)
    if(origin)planned.delete(request.input)
    else{
     const parent=activeTool.getStore()
     if(!parent||!parent.active||request.input.agent!==parent.agent||request.input.parent!==parent.token||request.input.rootCallId!==parent.rootCallId)throw denied()
     assertTool(parent);origin={turn:parent.turn,step:parent.step}
    }
    if(executions.has(exec)||exec.agent!==request.input.agent||exec.callId!==request.input.callId||exec.name!==request.input.name||exec.parent!==request.input.parent||exec.rootCallId!==(request.input.rootCallId??request.input.callId)||canonical(exec.arguments)!==canonical(request.input.arguments))throw denied()
    const cause:ToolCause={...origin,exec,signal:request.input.signal,parent:exec.parent,token:exec.token,agent,callId:exec.callId,rootCallId:exec.rootCallId,name:exec.name,arguments:exec.arguments,active:false}
    executions.set(exec,cause);assertTool(cause);return
   }
   const cause=registered;if(!cause||cause.active)throw denied()
   assertTool(cause);cause.active=true
  }catch{cancel(agent);throw denied()}
 }
 install(ctx.llm,'requireStreamAdmission','installStreamAdmission',(options:Readonly<GenerateOptions>)=>{
  const model=models.get(options);if(!model)throw denied();assertModel(model)
 })
 install(ctx.tools,'requireWorkAdmission','installWorkAdmission',toolPolicy)
 // 在官方 Service 就绪后安装唯一私有 Loop 回调；输入在此之前维持关闭。
 const loopInjection=ctx.inject(['agentLoop','sessionProjections'],child=>{
  try{
   const loop=Reflect.get(child,'agentLoop') as object,loopIdentity=Reflect.get(loop,'runtime') as unknown
   install(loop,'requireRestoreAdmission','installRestoreAdmission',(request:RestoreRequest)=>{
    // 未发布的载体通过官方投影读取 Inbox；不生成无关客户端视图或新的受理证明。
    const cold=Session.create(SessionId(request.sessionId),request.events,request.header,SessionLogOffset(request.inheritedEventCount))
    const inbox=child.sessionProjections.stateOf(cold,'inbox')
    if(!inbox||inbox['next-turn'].length||inbox['next-step'].length)throw denied()
    // 无待办历史只允许创建空闲载体；不据此为任何后续输入生成受理证明。
    return Object.freeze({assertCurrent(){
     const currentLoop=ctx.get('agentLoop') as object|undefined
     const currentIdentity=currentLoop===undefined?undefined:Reflect.get(currentLoop,'runtime') as unknown
     request.signal.throwIfAborted()
     if(closed||!loopReady||currentIdentity!==loopIdentity)throw denied()
    }})
   })
   install(loop,'requireWorkAdmission','installWorkAdmission',loopPolicy);loopReady=true
  }
  catch{closed=true;for(const agent of turns.keys())cancel(agent);throw denied()}
  return ()=>{loopReady=false}
 })
 ctx.on('llm/stream',async function*(options,next):AsyncIterable<StreamChunk>{
  const model=models.get(options)
  if(!model||model.entered)throw denied()
  model.entered=true;model.active=true
  try{assertModel(model);for await(const chunk of next()){assertModel(model);yield chunk}}
  finally{model.active=false}
 },{global:true,prepend:true})
 ctx.on('tools/execute',async(exec,next)=>{
  // 已有资源的回收没有新工作或父工具权限，不向其工具体传播热执行 scope。
  if(enterNativeResourceCleanup(ctx,exec))return activeTool.exit(next)
  const cause=executions.get(exec as ToolRunContext)
  if(!cause){if(!exec.agent)return next();throw denied()}
  assertTool(cause)
  return activeTool.run(cause,next)
 },{global:true,prepend:true})
 installed.add(ctx)
 const assertReady=():void=>{if(closed||!loopReady)throw denied()}
 return Object.freeze({
  assertReady,
  async whenReady():Promise<void>{
   // Cordis inject 即使依赖已存在也异步启动；缺依赖时 await 会直接结束，随后保持拒绝。
   try{await loopInjection.await()}catch{throw denied()}
   assertReady()
  },
  accept(receipt:NativeInputAcceptance):void{
   assertNativeInputAcceptanceCurrent(receipt)
   const {session,event}=receipt,agent=ctx.agents.get(session.id)
   if(closed||!loopReady||received.has(receipt)||!agent||agent.session!==session||sessions().get(session.id)!==session||event.type!=='agent/inbox/spliced'||event.data.inserted.length!==1)throw denied()
   const message=event.data.inserted[0]!,publication=contextPublication
   if(publication){
    const identity=nativeInputIdentity(message)
    if(publication.accepted||publication.session!==session||publication.identity.messageId!==identity.messageId||publication.identity.payloadSha256!==identity.payloadSha256)throw denied()
    publication.accepted=true
   }
   received.add(receipt)
   const ids=acceptedIds.get(session)??new Set<string>();ids.add(message.id);acceptedIds.set(session,ids)
   // child 首次输入跨 Session，保留它自己的不可伪造回执；不按 source/lineage 授权。
   pending.set(message,{receipt,roots:publication?.roots??[receipt]})
  },
  currentToolLease(sender:Agent):WorkAccessLease|undefined{
   if(isNativeResourceCleanupScope())throw denied()
   const cause=activeTool.getStore();if(!cause)return
   if(!cause.active||cause.agent!==sender)throw denied();assertTool(cause)
   const captured=[...cause.turn.roots]
   return Object.freeze({
    assertCurrent(){if(activeTool.getStore()!==cause||!cause.active)throw denied();assertTool(cause)},
    assertContinuationCurrent(){fixedRoots(captured)},
   })
  },
  close():void{closed=true;for(const agent of turns.keys())cancel(agent);turns.clear()},
 })
}
