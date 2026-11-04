import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {SessionSeq,snapshotSessionEvent,type SessionStore,type UserMessage} from '@deepseek-ai/dsh-session'
import {workAccess,combineWorkAccessLeases,type WorkAccess,type WorkAccessLease,type WorkAccessRequest} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {createNativeInputGuard,nativeInputIdentity} from './native-input-access.ts'
import {createNativeWorkCausality,type NativeJobCompletion} from './native-work-causality.ts'
import {isNativeResourceCleanupScope} from './native-resource-cleanup.ts'
import type {NativeCheckpointSnapshot,NativeInputRoot,NativeInputCheckpoint,NativeProgressCheckpoint,NativeInputRestore,NativeInputRestoreInput} from './native-input-checkpoint.ts'
import {projectRuntimeInputHooks} from './project-runtime-context.ts'
import {ownsDeliveryReviewInput} from './task-delivery-review.ts'

export type NativeInputProducer=Extract<WorkAccessRequest,{kind:'native-input'}>['producer']
// identity 由拥有实际发布点的 producer 构造。它只绑定上下文，不凭此标记授予许可。
export type NativeInputContext=Readonly<{producer:NativeInputProducer;identity:string}>
/** 宿主实际工作归属的附加准入；不向模型或浏览器公开。 */
export type ResidentInputAdmission={acquire:(input:{sessionId:string;producer:NativeInputProducer;sourceKind?:string})=>Promise<WorkAccessLease|null>;continuation?:(agent:Agent,message:UserMessage,ticketId:string)=>Promise<{snapshot:NativeCheckpointSnapshot;roots:readonly NativeInputRoot[];lease:WorkAccessLease}>;restore?:(input:NativeInputRestoreInput,base:NativeInputRestore)=>ReturnType<NativeInputRestore>;nativeCheckpoint?:NativeInputCheckpoint;nativeProgress?:NativeProgressCheckpoint}
type SubagentInput=Readonly<{kind:'initial'|'live'|'resume';agent:Agent;sender:Agent;message:UserMessage;signal?:AbortSignal}>
type SubagentCompletion=Readonly<{agent:Agent;message:UserMessage;childId:string}>
const producers=new Set<NativeInputProducer>(['prompt','queue','subagent','schedule','goal','task-run'])
const denied=()=>new WorkError('teloa/forbidden','当前暂不能提交新输入，请核对运行许可后重试。')

/** 首次输入用新工作许可；真实受理后的热轮次使用固定续作许可。seed 与冷恢复独立核对。 */
export function createNativeWorkInput(ctx:Context,access:WorkAccess=workAccess,checkpoint?:NativeInputCheckpoint,progress?:NativeProgressCheckpoint,restore?:NativeInputRestore,requireResident=false){
 if(typeof requireResident!=='boolean')throw denied()
 if(checkpoint!==undefined&&typeof checkpoint!=='function'||progress!==undefined&&typeof progress!=='function'||restore!==undefined&&typeof restore!=='function')throw denied()
 let ordinaryPublication=false
 const guard=createNativeInputGuard(ctx,{final:true,onAccepted:receipt=>causality.accept(receipt,ordinaryPublication)})
 const prepare=(agent:Agent,message:UserMessage,submit:()=>void,signal?:AbortSignal)=>{
  let snapshot:UserMessage
  try{
   if(typeof submit!=='function'||submit.constructor?.name==='AsyncFunction')throw denied()
   snapshot=snapshotSessionEvent({type:'user/message',seq:SessionSeq(0),time:0,data:message,surfaceOp:'append'}).data
  }catch{throw denied()}
  const rpcId=Reflect.get(snapshot.source,'rpcId')
  if(rpcId!==undefined&&(typeof rpcId!=='string'||!rpcId))throw denied()
  const session=agent.session,identity=nativeInputIdentity(snapshot,rpcId)
  const assertTarget=()=>{signal?.throwIfAborted();if(ctx.agents.get(agent.id)!==agent||agent.session!==session||(Reflect.get(ctx,'sessions') as unknown as SessionStore).get(agent.id)!==session)throw denied()}
  assertTarget()
  return {session,identity,rpcId,sourceKind:snapshot.source.kind,assertTarget:()=>{causality.assertReady();assertTarget()}}
 }
 const publish=(prepared:ReturnType<typeof prepare>,lease:WorkAccessLease,submit:()=>void,ordinary=false)=>{
  const assertLease=lease.assertCurrent,assertContinuation=lease.assertContinuationCurrent??assertLease
  if(typeof assertLease!=='function'||typeof assertContinuation!=='function')throw denied()
  const invoke=(assertion:()=>void)=>{
   prepared.assertTarget();const returned:unknown=Reflect.apply(assertion,lease,[]);prepared.assertTarget()
   if(returned!==undefined){void Promise.resolve(returned).catch(()=>{});throw denied()}
  }
  const fixed=Object.freeze({assertCurrent:()=>invoke(assertLease),assertContinuationCurrent:()=>invoke(assertContinuation),...(lease.releaseUnaccepted?{releaseUnaccepted:()=>lease.releaseUnaccepted!()}: {})})
  guard.withSyncLease(prepared.session,prepared.identity,fixed,()=>{
   prepared.assertTarget()
   const previous=ordinaryPublication;ordinaryPublication=ordinary
   try{
    const returned:unknown=submit()
    if(returned!==undefined){void Promise.resolve(returned).catch(()=>{});throw denied()}
   }finally{ordinaryPublication=previous}
  })
 }
 const resident=()=>ctx.get('teloaResidentInputAdmission' as never) as ResidentInputAdmission|undefined
 const residentLease=async(sessionId:string,producer:NativeInputProducer,sourceKind?:string)=>{
  const provider=resident()
  if(provider===undefined){if(requireResident)throw new WorkError('teloa/unavailable','工作服务正在准备，请稍后继续。');return null}
  if(typeof provider.acquire!=='function')throw denied()
  const lease=await provider.acquire({sessionId,producer,...(sourceKind===undefined?{}:{sourceKind})});if(lease!==null&&typeof lease?.assertCurrent!=='function')throw denied();return lease
 }
 // 默认base只投影数据根，不授予执行权；固定宿主仍必须用持久恢复票据逐根许可。
 const baseRestore:NativeInputRestore|undefined=restore??(requireResident?input=>{
  const roots=input.messages.map(message=>{const rpcId=Reflect.get(message.source,'rpcId'),identity=nativeInputIdentity(message,typeof rpcId==='string'?rpcId:undefined);return Object.freeze({sessionId:input.sessionId,messageId:identity.messageId,nativeRequestId:identity.nativeRequestId??null,payloadSha256:identity.payloadSha256})})
  return Object.freeze({roots:Object.freeze(roots),assertCurrent:()=>{input.signal.throwIfAborted();return undefined}})
 }:undefined)
 const controlledRestore:NativeInputRestore|undefined=baseRestore?async input=>{
  const provider=resident();if(requireResident&&!provider?.restore)throw denied()
  const project=await projectRuntimeInputHooks(ctx)?.restore?.(input)
  const proof=await(provider?.restore?provider.restore(input,baseRestore):baseRestore(input))
  if(!project)return proof
  return Object.freeze({...proof,assertCurrent(){proof.assertCurrent();project.assertCurrent()}})
 }:undefined
 // 固定宿主在同一私有检查点保存账本；额外部署检查器仍先执行，不以公开观察事件补写受理事实。
 const durableCheckpoint:NativeInputCheckpoint|undefined=requireResident?async input=>{await checkpoint?.(input);await resident()?.nativeCheckpoint?.(input)}:checkpoint
 const durableProgress:NativeProgressCheckpoint|undefined=requireResident?async input=>{await progress?.(input);await resident()?.nativeProgress?.(input)}:progress
 const causality=createNativeWorkCausality(ctx,(agent,message,lease,submit)=>publish(prepare(agent,message,submit),lease,submit),durableCheckpoint,durableProgress,controlledRestore,sessionId=>access.authorizeSessionCapabilities(sessionId,'restore'))
 const withNewInput=async(agent:Agent,message:UserMessage,context:NativeInputContext,submit:()=>void,signal?:AbortSignal,additionalLease?:WorkAccessLease):Promise<void>=>{
  if(isNativeResourceCleanupScope())throw denied()
  let producer:NativeInputProducer,contextIdentity:string
  try{
   producer=context.producer;contextIdentity=context.identity
   if(!producers.has(producer)||typeof contextIdentity!=='string'||!contextIdentity||contextIdentity.length>16384)throw denied()
  }catch{throw denied()}
  const prepared=prepare(agent,message,submit,signal),contextSha256=createHash('sha256').update(JSON.stringify([producer,contextIdentity])).digest('hex')
  const extra=additionalLease?combineWorkAccessLeases([additionalLease]):undefined
  const request:WorkAccessRequest={kind:'native-input',sessionId:agent.id,messageId:prepared.identity.messageId,nativeRequestId:prepared.rpcId??null,payloadSha256:prepared.identity.payloadSha256,producer,contextSha256}
  await causality.whenReady();prepared.assertTarget()
  const capabilities=await access.authorizeSessionCapabilities(agent.id,producer)
  prepared.assertTarget();capabilities.assertCurrent()
  const roleLease=await residentLease(agent.id,producer,prepared.sourceKind)
  const projectLease=await projectRuntimeInputHooks(ctx)?.acquire(agent,message,signal)
  const lease=await access.authorize(request)
  const publishInput=prepared.sourceKind==='plugin:teloa.delivery-review'?()=>{if(producer!=='task-run'||!ownsDeliveryReviewInput(agent,message))throw denied();causality.publishActiveContinuation(agent,message,submit)}:submit
  publish(prepared,combineWorkAccessLeases([capabilities,lease,...extra?[extra]:[],...roleLease?[roleLease]:[],...projectLease?[projectLease]:[]]),publishInput,(producer==='prompt'||producer==='queue')&&roleLease===null)
 }
 return Object.freeze({
  withNewInput,
  async withRunContinuation(agent:Agent,message:UserMessage,ticketId:string,signal:AbortSignal):Promise<void>{
   const provider=resident();if(!provider?.continuation)throw denied()
   const proof=await provider.continuation(agent,message,ticketId)
   signal.throwIfAborted();proof.lease.assertCurrent()
   await withNewInput(agent,message,{producer:'task-run',identity:'native-continuation:'+ticketId},()=>causality.publishPersistedContinuation(agent,message,proof,()=>agent.followup(message)),signal,proof.lease)
  },
  /** 唤醒方法自身不授予许可；SDK以所属writer重新核验原Inbox与部署恢复票据。 */
  async wakePending(agent:Agent,signal?:AbortSignal):Promise<boolean>{
   if(ctx.agents.get(agent.id)!==agent)throw denied()
   const loop=ctx.get('agentLoop'),wake=loop&&Reflect.get(loop,'wakePending')
   if(typeof wake!=='function')throw denied()
   const result:unknown=await Reflect.apply(wake,loop,[agent,signal])
   if(typeof result!=='boolean')throw denied()
   return result
  },
  /** 仅原空闲会话的短事务收口；最终append闸冻结所有事件，维护期间不消耗/丢弃晚到输入。 */
  withQuiescentSession<T>(agent:Agent,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
   const session=agent.session
   const assertIdle=()=>{if(ctx.agents.get(agent.id)!==agent||agent.session!==session||agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length||causality.hasPendingJobCompletion(agent.id)||causality.hasCancelledJobCompletion(agent.id))throw denied()}
   assertIdle()
   return agent.runMaintenance(signal=>guard.withQuiescentSession(session,()=>{signal.throwIfAborted();assertIdle()},()=>work(signal)))
  },
  /** 在真实启动工具仍活动时捕获；结果回流不依赖工具结束后的 ALS。 */
  captureSubagentCompletion(parent:Agent,sender:Agent=parent){
   const session=parent.session,continuation=causality.captureToolCompletion(sender)
   return async(candidate:SubagentCompletion,submit:()=>void):Promise<void>=>{
    if(candidate.agent!==parent||parent.session!==session||typeof candidate.childId!=='string'||!candidate.childId)throw denied()
    if(continuation){continuation(parent,candidate.message,submit);return}
    await withNewInput(parent,candidate.message,{producer:'subagent',identity:JSON.stringify(['settlement',candidate.childId,candidate.message.id])},submit)
   }
  },
  withAuxiliaryModel:causality.withAuxiliaryModel,
  hasAuxiliaryModelAdmission:causality.hasAuxiliaryModelAdmission,
  modelPosition:causality.modelPosition,
  harnessDirective:causality.harnessDirective,
  readReviewState:causality.readReviewState,
  hasPendingJobCompletion:causality.hasPendingJobCompletion,
  jobCompletionDecision:causality.jobCompletionDecision,
  hasCancelledJobCompletion:causality.hasCancelledJobCompletion,
  cancelJobCompletions:causality.cancelJobCompletions,
  withJobCompletion(candidate:NativeJobCompletion,publish:()=>void):Promise<void>{
   const signal=AbortSignal.timeout(15000)
   return causality.withJobCompletion(candidate,async signal=>{
    signal.throwIfAborted()
    return Promise.race([residentLease(candidate.agent.id,'task-run',candidate.message.source.kind),new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))])
   },publish,signal)
  },
  async withSubagentInput(candidate:SubagentInput,context:NativeInputContext,submit:()=>void):Promise<void>{
   if(candidate.kind!=='initial'&&candidate.kind!=='live'&&candidate.kind!=='resume')throw denied()
   if(candidate.kind==='initial'||candidate.kind==='live'||candidate.kind==='resume'){
    // 只有当前实际工具体内的派生输入可继承父任务；错 scope/撤销不能降级成新工作。
    const relay=candidate.message.source.kind==='agent-message'&&candidate.message.source.form==='relay'
    const sender=relay?ctx.agents.get(candidate.message.source.senderSessionId):candidate.sender
    if(!sender)throw denied()
    const lease=causality.currentToolLease(sender)
    if(lease){
     const prepared=prepare(candidate.agent,candidate.message,submit,candidate.signal)
     const capabilities=candidate.kind==='initial'?await access.authorizeSessionCapabilities(candidate.agent.id,'subagent'):undefined
     const roleLease=await residentLease(candidate.agent.id,'subagent')
     const projectLease=await projectRuntimeInputHooks(ctx)?.acquire(candidate.agent,candidate.message,candidate.signal,sender)
     publish(prepared,combineWorkAccessLeases([lease,...capabilities?[capabilities]:[],...roleLease?[roleLease]:[],...projectLease?[projectLease]:[]]),submit);return
    }
   }
   await withNewInput(candidate.agent,candidate.message,context,submit,candidate.signal)
  },
  close():void{guard.close();causality.close()},
 })
}
