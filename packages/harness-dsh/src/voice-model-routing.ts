import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {ReasoningEffortId,type LlmCallConfig} from '@deepseek-ai/dsh-llm'
import {appendPluginRecord,pluginRecordOf,type UserMessage} from '@deepseek-ai/dsh-session'
import type {AcceptedVoiceMessage} from './native-voice-input-admission.ts'
import {hasTaskModelRouting} from './task-model-routing.ts'
import {readSessionEvents} from './session-events.ts'
import type {PromptAssembly} from '@deepseek-ai/dsh-system-prompt'

type Route=Readonly<{provider:string;model:string}>
type Selection=Route&Readonly<{reasoningEffort?:NonNullable<LlmCallConfig['reasoningEffort']>}>
type Recovery=Readonly<{baseline:Selection;fast:Selection;selectionSeq:number}>
export type VoiceModelRoutingPorts={
 enabled:()=>boolean
 readAcceptedMessage:(agent:Agent,message:UserMessage)=>AcceptedVoiceMessage|undefined
 /** 宿主只提供原 MiniMax provider 中已声明的快速模型；不写配置、不解析凭据。 */
 selectedFastModel:(baseline:Route,signal:AbortSignal)=>Route|undefined|Promise<Route|undefined>
 /** 只精简本次真实语音轮次的工具参数；普通输入与显式任务路由保留原工具面。 */
 refineAssembly?:(agent:Agent,assembly:PromptAssembly,input:Readonly<{voice:boolean;turn?:number}>)=>PromptAssembly
}
const recordType='plugin:teloa/voice-model-baseline'
export const miniMaxVoiceFlashModel='MiniMax-M3.1-Flash-Preview'
const activeRoutes=new WeakMap<Agent,()=>void>()
declare module '@deepseek-ai/dsh-session'{interface PluginRecordMap{[recordType]:Recovery}}
const sameRoute=(a:Route|undefined,b:Route|undefined)=>!!a&&!!b&&a.provider===b.provider&&a.model===b.model
const sameSelection=(a:Selection|undefined,b:Selection|undefined)=>sameRoute(a,b)&&a?.reasoningEffort===b?.reasoningEffort
const miniMax2=(route:Route)=>/^MiniMax-M2(?:[.-]|$)/.test(route.model)
const eligible=(route:Route)=>miniMax2(route)||route.model==='MiniMax-M3'
const fastEffort=(baseline:Route,fast:Route)=>fast.model===miniMaxVoiceFlashModel&&eligible(baseline)?'low':fast.model==='MiniMax-M3'&&miniMax2(baseline)?'off':undefined
const selection=(config:Selection):Selection=>({provider:config.provider,model:config.model,...config.reasoningEffort===undefined?{}:{reasoningEffort:config.reasoningEffort}})
const replace=(config:LlmCallConfig,next:Selection):LlmCallConfig=>{const {reasoningEffort:_effort,...rest}=config;return {...rest,...next}}
function readRecovery(value:unknown):Recovery|undefined{
 if(!value||typeof value!=='object')return
 const row=value as Recovery,{baseline,fast,selectionSeq}=row
 if(!baseline||!fast||typeof baseline.provider!=='string'||!baseline.provider||typeof baseline.model!=='string'||!eligible(baseline)||fast.provider!==baseline.provider||!fastEffort(baseline,fast)||fast.reasoningEffort!==fastEffort(baseline,fast)||!Number.isSafeInteger(selectionSeq)||selectionSeq< -1)return
 if(baseline.reasoningEffort!==undefined&&(typeof baseline.reasoningEffort!=='string'||!baseline.reasoningEffort||baseline.reasoningEffort.length>64))return
 return {baseline:selection(baseline),fast:selection(fast),selectionSeq}
}

/** 原 Agent 上的临时请求策略；媒体结束不取消已受理的原工作。 */
export function installVoiceModelRouting(agent:Agent,ports:VoiceModelRoutingPorts):()=>void
export function installVoiceModelRouting(agent:Agent,ports:VoiceModelRoutingPorts|undefined):()=>void{
 activeRoutes.get(agent)?.()
 let disposed=false,detached=false
 let selectionSeq=-1,recovery:Recovery|undefined
 // 记录只用于还原我们自己的请求头，绝不恢复 voice 信任或激活 Agent。
 for(const event of readSessionEvents(agent.session)){
  if(event.type==='model/selection'){selectionSeq=Number(event.seq);recovery=undefined}
  const record=pluginRecordOf(event)
  if(record?.type===recordType){const candidate=readRecovery(record.data);if(candidate?.selectionSeq===selectionSeq)recovery=candidate}
 }
 let turn:{number:number;pending:UserMessage[];initial:boolean;voice:boolean}|undefined
 let step:{baseline:Route|undefined;restore:Recovery|undefined;fast:Selection|undefined;suppressNotice:boolean;selectionSeq:number}|undefined
 const disposers=[
  agent.ctx.on('session/event',(session,event)=>{
   if(session!==agent.session)return
   if(event.type==='model/selection'){selectionSeq=Number(event.seq);recovery=undefined;if(turn)turn.voice=false}
   if(event.type==='turn/end'){turn=undefined;step=undefined}
   if(disposed&&event.type==='request/header'&&!sameSelection(event.data.header.config,recovery?.fast))detach()
  },{global:true}),
  agent.ctx.on('agent/inbox/claimed',({message,turn:number})=>{
   if(turn?.number!==number)turn={number,pending:[],initial:true,voice:false}
   turn.pending.push(message)
  }),
  agent.ctx.on('system-prompt/assemble',async(_assembly,context,next)=>{
   if(turn){
    if(turn.initial){const only=turn.pending.length===1?turn.pending[0]:undefined,binding=only&&ports?.readAcceptedMessage(agent,only);turn.voice=!!binding&&binding.standalone&&binding.sessionId===agent.id;turn.initial=false}
    // 本宿主工具的后续说明不是新的本人输入；否则一次查工具就会丢掉语音轮次归属。
    else if(turn.pending.some(message=>message.source.kind!=='plugin:teloa.work'||message.source.form!=='notice'))turn.voice=false
    turn.pending=[]
   }
   const ownerTurn=turn,trusted=turn?.voice===true,revision=selectionSeq,prior=recovery
   const original=await next()
   const result=ports?.refineAssembly?.(agent,original,{voice:trusted&&!disposed&&ports.enabled()&&!hasTaskModelRouting(agent)&&original.variables.provider==='minimax',...(ownerTurn?{turn:ownerTurn.number}:{})})??original
   if(hasTaskModelRouting(agent)){step=undefined;return result}
   const {provider,model}=result.variables
   const native=typeof provider==='string'&&typeof model==='string'?{provider,model}:undefined
   const header=agent.session.requestHeader()?.config
   const restore=prior?.selectionSeq===revision&&sameSelection(header,prior.fast)&&(!native||sameRoute(native,prior.fast)||sameRoute(native,prior.baseline))?prior:undefined
   const baseline=restore?.baseline??native
   const suppressNotice=!!prior&&prior.selectionSeq===revision&&sameSelection(header,prior.fast)&&!!baseline&&sameRoute(baseline,prior.baseline)
   const snapshot={baseline,restore,fast:undefined as Selection|undefined,suppressNotice,selectionSeq:revision}
   step=snapshot
   const currentPorts=ports
   const current=()=>!disposed&&ports===currentPorts&&!!currentPorts?.enabled()&&selectionSeq===revision&&turn===ownerTurn&&turn?.voice===true&&step===snapshot&&!hasTaskModelRouting(agent)
   if(trusted&&current()&&context.signal&&baseline&&eligible(baseline)){
    try{
     const candidate=await currentPorts!.selectedFastModel(baseline,context.signal)
     context.signal.throwIfAborted()
     const effort=candidate&&fastEffort(baseline,candidate)
     if(current()&&candidate?.provider===baseline.provider&&effort){
      const info=await agent.ctx.llm.resolveModelInfo(candidate.provider,candidate.model,context.signal)
      context.signal.throwIfAborted()
      if(current()&&info.reasoning?.efforts.some(row=>row.id===effort))snapshot.fast={...candidate,reasoningEffort:ReasoningEffortId(effort)}
     }
    }catch{context.signal.throwIfAborted()}
   }
   if(selectionSeq!==revision)return result
   const route=snapshot.fast??baseline
   return route?{...result,variables:{...result.variables,provider:route.provider,model:route.model}}:result
  },{prepend:true}),
  agent.ctx.on('agent/pre-step',async(_payload,next)=>{
   const decision=await next()
   return !hasTaskModelRouting(agent)&&step?.selectionSeq===selectionSeq&&step.suppressNotice&&decision.kind!=='reject'?{...decision,messages:decision.messages.filter(message=>message.source.kind!=='model-selection')}:decision
  },{prepend:true}),
  agent.ctx.on('agent/request',async({signal},next)=>{
   const inherited=await next();signal.throwIfAborted()
   if(hasTaskModelRouting(agent)||!step||step.selectionSeq!==selectionSeq)return inherited
   const baseline=step.restore&&sameSelection(inherited,step.restore.fast)?replace(inherited,step.restore.baseline):inherited
   if(disposed||!step.fast||!sameRoute(baseline,step.baseline))return baseline
   const nextRecovery={baseline:selection(baseline),fast:step.fast,selectionSeq:step.selectionSeq}
   if(selectionSeq===step.selectionSeq){
    if(!recovery||!sameSelection(recovery.baseline,nextRecovery.baseline)||!sameSelection(recovery.fast,nextRecovery.fast)||recovery.selectionSeq!==selectionSeq)appendPluginRecord(agent.session,recordType,nextRecovery)
    recovery=nextRecovery
   }
   return replace(baseline,step.fast)
  },{prepend:true}),
 ]
 const detach=()=>{if(detached)return;detached=true;ports=undefined;turn=undefined;step=undefined;for(const off of disposers)off();if(activeRoutes.get(agent)===detach)activeRoutes.delete(agent)}
 activeRoutes.set(agent,detach)
 return ()=>{
  if(disposed)return;disposed=true;ports=undefined;turn=undefined
  // 原 Agent 仍活跃时，仅保留不含宿主 reader 的撤销钩子，直到真实 baseline header 落存。
  if(!step?.fast&&!sameSelection(agent.session.requestHeader()?.config,recovery?.fast))detach()
 }
}

/** 只装配已经存在与以后发布的原 Agent；不 resolve、resume 或创建第二个 Agent。 */
export function installVoiceModelRoutingHost(ctx:Context,ports:VoiceModelRoutingPorts):()=>void{
 const installed=new Map<Agent,()=>void>()
 const attach=(agent:Agent)=>{if(!installed.has(agent))installed.set(agent,installVoiceModelRouting(agent,ports))}
 const offCreated=ctx.on('agent/created',({agent})=>{attach(agent);return undefined})
 const offDisposed=ctx.on('agent/disposed',({agent})=>{installed.get(agent)?.();installed.delete(agent)})
 for(const agent of ctx.agents.list())attach(agent)
 let disposed=false
 return ()=>{if(disposed)return;disposed=true;offCreated();offDisposed();for(const off of installed.values())off();installed.clear()}
}
