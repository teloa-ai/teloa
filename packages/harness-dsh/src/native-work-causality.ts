import {AsyncLocalStorage} from 'node:async_hooks'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {GenerateOptions,StreamChunk} from '@deepseek-ai/dsh-llm'
import {Session,SessionId,SessionLogOffset,interruptedTurnClosers,type SessionEvent,type SessionHeader,type SessionStore,type UserMessage} from '@deepseek-ai/dsh-session'
import type {ToolExecutionInput,ToolExecutionResult,ToolRunContext} from '@deepseek-ai/dsh-tools'
import type {WorkAccessLease} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {assertNativeInputAcceptanceCurrent,nativeInputIdentity,type NativeInputAcceptance,type NativeInputIdentity} from './native-input-access.ts'
import {admitNativeResourceCleanup,enterNativeResourceCleanup,isNativeResourceCleanupScope} from './native-resource-cleanup.ts'
import type {NativeInputCheckpoint,NativeInputCheckpointInput,NativeInputRoot,NativeProgressCheckpoint,NativeProgressCheckpointInput,NativeInputRestore} from './native-input-checkpoint.ts'

type Step={number:number;signal:AbortSignal}
type InputCause={session:Session;event:Readonly<SessionEvent>;assertCurrent:()=>void}
type Turn={agent:Agent;session:Session;number:number;signal:AbortSignal;roots:Set<InputCause>;step:Step|undefined}
type Model={turn:Turn;step:Step;options:GenerateOptions;entered:boolean;active:boolean}
type ToolCause={turn:Turn;step:Step;exec:ToolRunContext;signal:AbortSignal;parent:ToolRunContext['parent'];token:ToolRunContext['token'];agent:Agent;callId:string;rootCallId:string;name:string;arguments:unknown;active:boolean}
type PendingInput={receipt:InputCause;roots:readonly InputCause[]}
type ContextPublication={session:Session;identity:NativeInputIdentity;roots:readonly InputCause[];accepted:boolean}
type Position=Readonly<{agent:Agent;turn:number;signal:AbortSignal}>
type LoopRequest=
 |Readonly<{kind:'restore-publish';agent:Agent;signal:AbortSignal}>
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
export function createNativeWorkCausality(ctx:Context,publishContinuation:PublishContinuation,checkpoint?:NativeInputCheckpoint,progress?:NativeProgressCheckpoint,restore?:NativeInputRestore){
 if(installed.has(ctx))throw denied()
 const pending=new WeakMap<UserMessage,PendingInput>(),turns=new Map<Agent,Turn>()
 const received=new WeakSet<NativeInputAcceptance>(),acceptedIds=new WeakMap<Session,Set<string>>()
 const models=new WeakMap<GenerateOptions,Model>(),planned=new WeakMap<ToolExecutionInput,{turn:Turn;step:Step}>()
 const executions=new WeakMap<ToolRunContext,ToolCause>(),activeTool=new AsyncLocalStorage<ToolCause>()
 const recovering=new Map<string,{publish:(agent:Agent,signal?:AbortSignal)=>void}>(),recoveryAbort=new AbortController()
 let closed=false,loopReady=false
 // 仅覆盖下面的同步最终发布；不向公共事件、工具或调用者暴露继承证明。
 let contextPublication:ContextPublication|undefined
 const sessions=()=>Reflect.get(ctx,'sessions') as unknown as SessionStore
 const cancel=(agent:Agent)=>{try{agent.cancel({kind:'hook',reason},{keepInbox:true})}catch{}}
 const target=(turn:Turn)=>{if(closed||ctx.agents.get(turn.agent.id)!==turn.agent||turn.agent.session!==turn.session||sessions().get(turn.agent.id)!==turn.session)throw denied()}
 const messageRoot=(sessionId:string,message:UserMessage):NativeInputRoot=>{
  const rpcId=Reflect.get(message.source,'rpcId'),identity=nativeInputIdentity(message,typeof rpcId==='string'?rpcId:undefined)
  if(rpcId!==undefined&&(typeof rpcId!=='string'||!rpcId))throw denied()
  return Object.freeze({sessionId,messageId:identity.messageId,nativeRequestId:identity.nativeRequestId??null,payloadSha256:identity.payloadSha256})
 }
 const fixedRoots=(roots:readonly InputCause[])=>{if(closed||roots.length===0)throw denied();for(const receipt of roots)receipt.assertCurrent()}
 const rootIdentities=(roots:readonly InputCause[]):readonly NativeInputRoot[]=>Object.freeze([...new Set(roots)].map(receipt=>{
  receipt.assertCurrent()
  const event=receipt.event
  if(event.type!=='agent/inbox/spliced'||event.data.inserted.length!==1)throw denied()
  return messageRoot(receipt.session.id,event.data.inserted[0]!)
 }))
 // 公开创建通知只核验已经由官方私有恢复发布点绑定的因果，不消费恢复证明。
 ctx.on('agent/created',({agent,signal})=>{
  signal?.throwIfAborted()
  const messages=[...agent.inbox.nextTurn,...agent.inbox.nextStep]
  if(messages.length){
   if(ctx.agents.get(agent.id)!==agent||sessions().get(agent.id)!==agent.session)throw denied()
   for(const message of messages){
    const input=pending.get(message)
    if(!input||input.receipt.session!==agent.session)throw denied()
    input.receipt.assertCurrent();fixedRoots(input.roots)
   }
   if(canonical([...agent.inbox.nextTurn,...agent.inbox.nextStep])!==canonical(messages)||ctx.agents.get(agent.id)!==agent||sessions().get(agent.id)!==agent.session)throw denied()
  }
  signal?.throwIfAborted()
  return undefined
 },{global:true,prepend:true})
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
  if(request.kind==='restore-publish'){
   try{
    if(closed||!loopReady||ctx.agents.get(agent.id)!==agent||sessions().get(agent.id)!==agent.session)throw denied()
    request.signal.throwIfAborted()
    const proof=recovering.get(agent.id)
    if(proof){proof.publish(agent,request.signal);recovering.delete(agent.id)}
    else if(agent.inbox.nextTurn.length||agent.inbox.nextStep.length)throw denied()
    request.signal.throwIfAborted();return
   }catch{cancel(agent);throw denied()}
  }
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
    input.receipt.assertCurrent();target(turn);pending.delete(request.message)
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
   if(checkpoint)install(loop,'requireInputCheckpoint','installInputCheckpoint',async(request:Omit<NativeInputCheckpointInput,'assertCurrent'|'roots'>)=>{
    const turn=turns.get(request.agent),inputs=request.messages.map(message=>pending.get(message))
    const assertCurrent=()=>{
     try{
      if(!turn||turns.get(request.agent)!==turn||turn.number!==request.turn||turn.signal!==request.signal||inputs.length===0)throw denied()
      target(turn);request.signal.throwIfAborted()
      for(let index=0;index<inputs.length;index++){
       const input=inputs[index],message=request.messages[index]
       if(!input||!message||pending.get(message)!==input||input.receipt.session!==turn.session||canonical(request.snapshot.events[input.receipt.event.seq])!==canonical(input.receipt.event))throw denied()
       input.receipt.assertCurrent();fixedRoots(input.roots)
      }
      target(turn);request.signal.throwIfAborted()
     }catch{cancel(request.agent);throw denied()}
    }
    assertCurrent()
    const roots=rootIdentities(inputs.flatMap(input=>input?.roots??[]))
    await checkpoint(Object.freeze({...request,roots,assertCurrent}))
    assertCurrent()
    return Object.freeze({assertCurrent})
   })
   if(progress)install(loop,'requireProgressCheckpoint','installProgressCheckpoint',async(request:Omit<NativeProgressCheckpointInput,'assertCurrent'|'roots'>)=>{
    const turn=turns.get(request.agent),step=turn?.step
    const assertCurrent=()=>{
     try{
      if(!turn||turn.number!==request.turn||turn.signal!==request.signal||turns.get(request.agent)!==turn||turn.step!==step)throw denied()
      current(turn,step);request.signal.throwIfAborted()
     }catch{cancel(request.agent);throw denied()}
    }
    assertCurrent()
    const roots=rootIdentities([...turn!.roots])
    await progress(Object.freeze({...request,roots,assertCurrent}))
    assertCurrent();return Object.freeze({assertCurrent})
   })
   install(loop,'requireRestoreAdmission','installRestoreAdmission',async(request:RestoreRequest)=>{
    // 未发布的载体通过官方投影读取 Inbox；不生成无关客户端视图或新的受理证明。
    const cold=Session.create(SessionId(request.sessionId),request.events,request.header,SessionLogOffset(request.inheritedEventCount))
    const inbox=child.sessionProjections.stateOf(cold,'inbox')
    if(!inbox)throw denied()
    const assertOwner=()=>{
     const currentLoop=ctx.get('agentLoop') as object|undefined
     const currentIdentity=currentLoop===undefined?undefined:Reflect.get(currentLoop,'runtime') as unknown
     request.signal.throwIfAborted()
     if(closed||!loopReady||currentIdentity!==loopIdentity)throw denied()
    }
    assertOwner()
    // 空闲日志可读，但本证明不能授权任何新输入。派生 next-step 必须另有持久因果协议。
    if(!inbox['next-turn'].length&&!inbox['next-step'].length)return Object.freeze({assertCurrent:assertOwner})
    if(!restore||inbox['next-step'].length||recovering.has(request.sessionId))throw denied()
    const messages=Object.freeze([...inbox['next-turn']]),events:SessionEvent[]=[],roots:NativeInputRoot[]=[]
    // 已领取的未结束轮次可能有未知外部成果，不因仍有其他排队消息而重放。
    let activeTurn=false,claimed=false
    for(const event of request.events){
     if(event.type==='turn/start'){activeTurn=true;claimed=false}
     else if(event.type==='turn/end'){activeTurn=false;claimed=false}
     else if(activeTurn&&event.type==='agent/inbox/spliced'&&(event.data.removedCount??0)>0)claimed=true
    }
    if(activeTurn&&claimed)throw denied()
    for(const message of messages){
     const matches=request.events.filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(inserted=>inserted.id===message.id))
     const event=matches[0]
     if(matches.length!==1||!event||event.type!=='agent/inbox/spliced'||event.seq<request.inheritedEventCount||event.data.target!=='next-turn'||event.data.inserted.length!==1||message.source.kind==='tool'||canonical(event.data.inserted[0])!==canonical(message))throw denied()
     events.push(event);roots.push(messageRoot(request.sessionId,message))
    }
    const signal=AbortSignal.any([request.signal,recoveryAbort.signal]),snapshot=Object.freeze({header:request.header,events:request.events,inheritedEventCount:request.inheritedEventCount})
    const candidate=Object.freeze({sessionId:request.sessionId,snapshot,messages,signal})
    let onAbort:()=>void=()=>{}
    const aborted=new Promise<never>((_resolve,reject)=>{onAbort=()=>reject(denied());signal.addEventListener('abort',onAbort,{once:true})})
    let lease:Awaited<ReturnType<NativeInputRestore>>
    try{signal.throwIfAborted();lease=await Promise.race([Promise.resolve().then(()=>restore(candidate)),aborted])}
    finally{signal.removeEventListener('abort',onAbort)}
    assertOwner();signal.throwIfAborted()
    if(!lease||!Object.isFrozen(lease))throw denied()
    const assertion:unknown=Object.getOwnPropertyDescriptor(lease,'assertCurrent')?.value,granted:unknown=Object.getOwnPropertyDescriptor(lease,'roots')?.value
    if(typeof assertion!=='function'||!Array.isArray(granted)||!Object.isFrozen(granted)||granted.some(root=>!root||!Object.isFrozen(root))||granted.length!==roots.length||new Set(granted.map(canonical)).size!==roots.length||canonical(granted.map(canonical).sort())!==canonical(roots.map(canonical).sort()))throw denied()
    let bound:Agent|undefined,published=false
    const assertCurrent=()=>{
     assertOwner();signal.throwIfAborted()
     const returned:unknown=Reflect.apply(assertion,lease,[])
     if(returned!==undefined){void Promise.resolve(returned).catch(()=>{});throw denied()}
     assertOwner();signal.throwIfAborted()
     if(bound&&(ctx.agents.get(bound.id)!==bound||sessions().get(bound.id)!==bound.session))throw denied()
    }
    assertCurrent()
    const proof={publish(agent:Agent,publishSignal?:AbortSignal){
     assertCurrent();publishSignal?.throwIfAborted()
     if(published||ctx.agents.get(agent.id)!==agent||sessions().get(agent.id)!==agent.session||agent.id!==request.sessionId||canonical(agent.session.header)!==canonical(request.header)||agent.session.inheritedEventCount!==request.inheritedEventCount)throw denied()
     const actual=agent.session.snapshotEvents(),suffix=actual.slice(request.events.length),closers=interruptedTurnClosers(request.events)
     if(canonical(actual.slice(0,request.events.length))!==canonical(request.events)||suffix.length<closers.length||suffix.length>closers.length+1)throw denied()
     if(canonical(suffix.slice(0,closers.length))!==canonical(closers))throw denied()
     if(suffix.length>closers.length&&(suffix.at(-1)?.type!=='session/end-seed'||canonical(suffix.at(-1)?.data)!=='{}'))throw denied()
     const actualMessages=agent.inbox.nextTurn
     if(agent.inbox.nextStep.length||canonical(actualMessages)!==canonical(messages))throw denied()
     assertCurrent();publishSignal?.throwIfAborted()
     bound=agent;published=true
     const ids=new Set<string>()
     for(let index=0;index<actualMessages.length;index++){
      const message=actualMessages[index]!,event=agent.session.eventAt(events[index]!.seq)
      if(!event||canonical(event)!==canonical(events[index]))throw denied()
      const receipt:InputCause=Object.freeze({session:agent.session,event,assertCurrent})
      pending.set(message,{receipt,roots:[receipt]});ids.add(message.id)
     }
     acceptedIds.set(agent.session,ids);assertCurrent()
    }}
    recovering.set(request.sessionId,proof)
    request.signal.addEventListener('abort',()=>{if(recovering.get(request.sessionId)===proof)recovering.delete(request.sessionId)},{once:true})
    // 官方 Loop 在真实恢复完成并释放临时 owner 后唤醒原 Inbox；不新增 steer 输入。
    return Object.freeze({assertCurrent,wakePending:true})
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
   const cause:InputCause=Object.freeze({session,event,assertCurrent:()=>assertNativeInputAcceptanceCurrent(receipt)})
   pending.set(message,{receipt:cause,roots:publication?.roots??[cause]})
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
  close():void{closed=true;recoveryAbort.abort(denied());recovering.clear();for(const agent of turns.keys())cancel(agent);turns.clear()},
 })
}
