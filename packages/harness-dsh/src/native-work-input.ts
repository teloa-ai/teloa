import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {SessionSeq,snapshotSessionEvent,type SessionStore,type UserMessage} from '@deepseek-ai/dsh-session'
import {workAccess,combineWorkAccessLeases,type WorkAccess,type WorkAccessLease,type WorkAccessRequest} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {createNativeInputGuard,nativeInputIdentity} from './native-input-access.ts'
import {createNativeWorkCausality} from './native-work-causality.ts'
import {isNativeResourceCleanupScope} from './native-resource-cleanup.ts'
import type {NativeInputCheckpoint,NativeProgressCheckpoint,NativeInputRestore,NativeInputRestoreInput} from './native-input-checkpoint.ts'

export type NativeInputProducer=Extract<WorkAccessRequest,{kind:'native-input'}>['producer']
// identity 由拥有实际发布点的 producer 构造。它只绑定上下文，不凭此标记授予许可。
export type NativeInputContext=Readonly<{producer:NativeInputProducer;identity:string}>
/** 宿主实际工作归属的附加准入；不向模型或浏览器公开。 */
export type ResidentInputAdmission={acquire:(input:{sessionId:string;producer:NativeInputProducer})=>Promise<WorkAccessLease|null>;restore?:(input:NativeInputRestoreInput,base:NativeInputRestore)=>ReturnType<NativeInputRestore>}
type SubagentInput=Readonly<{kind:'initial'|'live'|'resume';agent:Agent;sender:Agent;message:UserMessage;signal?:AbortSignal}>
const producers=new Set<NativeInputProducer>(['prompt','queue','subagent','schedule','goal','task-run'])
const denied=()=>new WorkError('teloa/forbidden','当前暂不能提交新输入，请核对运行许可后重试。')

/** 首次输入用新工作许可；真实受理后的热轮次使用固定续作许可。seed 与冷恢复独立核对。 */
export function createNativeWorkInput(ctx:Context,access:WorkAccess=workAccess,checkpoint?:NativeInputCheckpoint,progress?:NativeProgressCheckpoint,restore?:NativeInputRestore,requireResident=false){
 if(typeof requireResident!=='boolean')throw denied()
 if(checkpoint!==undefined&&typeof checkpoint!=='function'||progress!==undefined&&typeof progress!=='function'||restore!==undefined&&typeof restore!=='function')throw denied()
 const guard=createNativeInputGuard(ctx,{final:true,onAccepted:receipt=>causality.accept(receipt)})
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
  return {session,identity,rpcId,assertTarget:()=>{causality.assertReady();assertTarget()}}
 }
 const publish=(prepared:ReturnType<typeof prepare>,lease:WorkAccessLease,submit:()=>void)=>{
  const assertLease=lease.assertCurrent,assertContinuation=lease.assertContinuationCurrent??assertLease
  if(typeof assertLease!=='function'||typeof assertContinuation!=='function')throw denied()
  const invoke=(assertion:()=>void)=>{
   prepared.assertTarget();const returned:unknown=Reflect.apply(assertion,lease,[]);prepared.assertTarget()
   if(returned!==undefined){void Promise.resolve(returned).catch(()=>{});throw denied()}
  }
  const fixed=Object.freeze({assertCurrent:()=>invoke(assertLease),assertContinuationCurrent:()=>invoke(assertContinuation),...(lease.releaseUnaccepted?{releaseUnaccepted:()=>lease.releaseUnaccepted!()}: {})})
  guard.withSyncLease(prepared.session,prepared.identity,fixed,()=>{
   prepared.assertTarget()
   const returned:unknown=submit()
   if(returned!==undefined){void Promise.resolve(returned).catch(()=>{});throw denied()}
  })
 }
 const resident=()=>ctx.get('teloaResidentInputAdmission' as never) as ResidentInputAdmission|undefined
 const residentLease=async(sessionId:string,producer:NativeInputProducer)=>{
  const provider=resident()
  if(provider===undefined){if(requireResident)throw new WorkError('teloa/unavailable','工作服务正在准备，请稍后继续。');return null}
  if(typeof provider.acquire!=='function')throw denied()
  const lease=await provider.acquire({sessionId,producer});if(lease!==null&&typeof lease?.assertCurrent!=='function')throw denied();return lease
 }
 const controlledRestore:NativeInputRestore|undefined=restore?input=>{const provider=resident();if(requireResident&&!provider?.restore)throw denied();return provider?.restore?provider.restore(input,restore):restore(input)}:undefined
 const causality=createNativeWorkCausality(ctx,(agent,message,lease,submit)=>publish(prepare(agent,message,submit),lease,submit),checkpoint,progress,controlledRestore,sessionId=>access.authorizeSessionCapabilities(sessionId,'restore'))
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
  const roleLease=await residentLease(agent.id,producer)
  const lease=await access.authorize(request)
  publish(prepared,combineWorkAccessLeases([capabilities,lease,...extra?[extra]:[],...roleLease?[roleLease]:[]]),submit)
 }
 return Object.freeze({
  withNewInput,
  modelPosition:causality.modelPosition,
  async withSubagentInput(candidate:SubagentInput,context:NativeInputContext,submit:()=>void):Promise<void>{
   if(candidate.kind!=='initial'&&candidate.kind!=='live'&&candidate.kind!=='resume')throw denied()
   if(candidate.kind==='initial'){
    // 只有当前实际工具体内的派生输入可继承父任务；错 scope/撤销不能降级成新工作。
    const lease=causality.currentToolLease(candidate.sender)
    if(lease){
     const prepared=prepare(candidate.agent,candidate.message,submit,candidate.signal)
     const capabilities=await access.authorizeSessionCapabilities(candidate.agent.id,'subagent')
     const roleLease=await residentLease(candidate.agent.id,'subagent')
     publish(prepared,combineWorkAccessLeases([capabilities,lease,...roleLease?[roleLease]:[]]),submit);return
    }
   }
   await withNewInput(candidate.agent,candidate.message,context,submit,candidate.signal)
  },
  close():void{guard.close();causality.close()},
 })
}
