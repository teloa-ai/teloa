import {isDeepStrictEqual} from 'node:util'
import {WorkError,readVoiceCallContext,voiceCallStartInput,type Conversation,type DigitalRole,type VoiceCall,type VoiceCallContext,type VoiceCallStartInput} from '@teloa/contract'
import type {ObjectConversationService,WorkAccessLease} from '@teloa/backend'
import {VoiceCallService,type VoiceCallServicePorts} from './voice-call-service.ts'
import {createVoiceCallHandler} from './voice-calls.ts'
import {createUnavailableVoiceTransport,VoiceTransportFailure,type VoiceTransport,type VoiceTransportEvent} from './voice-transport.ts'
import {readAssistantVoiceContext,type AssistantVoiceContextPorts} from './voice-assistant-context.ts'

/** 宿主在异步回读前捕获的真实世代句柄；撤权 signal 与同步判据必须来自同一可信源。 */
export type VoiceCallContextLease=Readonly<{signal:AbortSignal;assertCurrent:()=>void;release:()=>void}>
export type VoiceCallRuntimePorts=Readonly<{
 owner:string
 readRole:(roleId:string)=>Promise<DigitalRole|null>
 readConversation:(sessionId:string)=>Promise<Pick<Conversation,'id'|'ownerId'|'sessionId'|'status'|'purpose'>>
 readRequestedRoleId:(sessionId:string)=>Promise<string|null>
 links:Pick<ObjectConversationService,'bySession'>
 /** 只封当前本人/宿主/角色/会话关联租约，不新增委托、consent 或执行权。缺失即拒绝建连。 */
 acquireContextLease:(input:Readonly<VoiceCallStartInput>)=>VoiceCallContextLease
 /** 继承当前宿主的真实会话能力政策；媒体 proof 不受理 Task 或签发执行委托。 */
 authorizeMedia:(input:Readonly<VoiceCallStartInput>)=>Promise<WorkAccessLease>
 transport?:VoiceTransport
 readTranscriptSeal:VoiceCallServicePorts['readTranscriptSeal']
 onChange?:VoiceCallServicePorts['onChange']
} & Pick<AssistantVoiceContextPorts,'readHomeContext'|'assistantEligible'>>
type Admission={requestId:string;lease:VoiceCallContextLease;assertCurrent:()=>void;bindMedia:(lease:WorkAccessLease)=>void;release:()=>void;context?:VoiceCallContext;onEvent?:((event:VoiceTransportEvent)=>void);call?:VoiceCall}
const forbidden=()=>new WorkError('teloa/forbidden','当前本人、角色或会话许可已变化，请重新核对。')
const terminal=(call:VoiceCall)=>call.state==='ended'||call.state==='failed'

/** 仅供本人 RPC 装配；媒体与已受理 Task 的生命周期没有共享停止端口。 */
export function createVoiceCallRuntime(ports:VoiceCallRuntimePorts){
 const {owner}=ports
 if(typeof owner!=='string'||!owner.trim()||owner!==owner.trim()||owner.length>128||/[\x00-\x1f\x7f]/.test(owner))throw forbidden()
 const transport=ports.transport??createUnavailableVoiceTransport(),admissions=new Map<string,Admission>(),calls=new Map<string,VoiceCall>()
 const pendingStarts=new Set<Promise<VoiceCall>>()
 let closed=false
 const capture=(input:VoiceCallStartInput):Admission=>{
  if(closed)throw forbidden()
  if(typeof ports.acquireContextLease!=='function')throw new WorkError('teloa/unavailable','当前通话许可尚未就绪。')
  const lease=ports.acquireContextLease(input),assertion=lease?.assertCurrent,release=lease?.release,signal=lease?.signal
  if(!lease||!(signal instanceof AbortSignal)||typeof assertion!=='function'||typeof release!=='function')throw forbidden()
  let released=false,mediaCheck:(()=>void)|undefined,releaseMedia:(()=>void)|undefined
  const assertCurrent=()=>{
   if(closed||released||signal.aborted)throw forbidden()
   const result:unknown=Reflect.apply(assertion,lease,[])
   if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw forbidden()}
   mediaCheck?.()
   if(closed||released||signal.aborted)throw forbidden()
  }
  const admission:Admission={requestId:input.requestId,lease,assertCurrent,bindMedia(proof){
   const current=proof?.assertCurrent,releaseProof=proof?.releaseUnaccepted
   let proofReleased=false
   releaseMedia=()=>{
    if(proofReleased)return
    proofReleased=true
    if(typeof releaseProof!=='function')return
    try{const result:unknown=Reflect.apply(releaseProof,proof,[]);if(result!==undefined)void Promise.resolve(result).catch(()=>{})}catch{/* 释放未受理 proof 不覆盖媒体的真实终态。 */}
   }
   // 等待许可时可能已经撤权/取消；迟到 proof 也必须释放一次，不能再接纳上下文。
   if(released||closed||signal.aborted)releaseMedia()
   if(typeof current!=='function'||releaseProof!==undefined&&typeof releaseProof!=='function'){releaseMedia();throw forbidden()}
   mediaCheck=()=>{
    const result:unknown=Reflect.apply(current,proof,[])
    if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw forbidden()}
   }
   assertCurrent()
  },release(){
   if(released)return
   released=true;signal.removeEventListener('abort',invalidate)
   if(admissions.get(input.requestId)===admission)admissions.delete(input.requestId)
   releaseMedia?.()
   // 清理不能覆盖真实媒体关闭回执；失败的关闭仍由 service 保留并允许本人重试。
   try{const result:unknown=Reflect.apply(release,lease,[]);if(result!==undefined)void Promise.resolve(result).catch(()=>{})}catch{/* 不把展示/订阅清理异常伪装成媒体关闭失败。 */}
  }}
  const invalidate=()=>{
   if(released)return
   if(admission.onEvent&&admission.call)admission.onEvent({type:'error',callGeneration:admission.call.callGeneration,reason:'authorization-changed'})
   else if(admission.call)void service.endByRequest(owner,{requestId:input.requestId})
  }
  admissions.set(input.requestId,admission);signal.addEventListener('abort',invalidate,{once:true})
  try{assertCurrent()}catch(error){admission.release();throw error}
  return admission
 }
 // 保持原 service 行为，只跟踪其真实 start 收尾，以等待迟到连接关闭而非只等 terminal DTO。
 const service=new class extends VoiceCallService{
  override start(actor:string,value:unknown):Promise<VoiceCall>{
   try{
    if(actor!==owner||closed)throw forbidden()
    const input=voiceCallStartInput(value),pending=super.start(actor,input)
    pendingStarts.add(pending)
    const settled=()=>{
     pendingStarts.delete(pending)
     const call=this.getByRequest(owner,{requestId:input.requestId})
     if(call===null||terminal(call))admissions.get(input.requestId)?.release()
    }
    void pending.then(settled,settled)
    return pending
   }catch(error){return Promise.reject(error)}
  }
 }({
  readTranscriptSeal:ports.readTranscriptSeal,
  async resolveContext(actor,input){
   if(actor!==owner)throw forbidden()
   const admission=capture(input)
   try{
    if(typeof ports.authorizeMedia!=='function')throw new WorkError('teloa/unavailable','当前媒体运行许可尚未就绪。')
    admission.bindMedia(await ports.authorizeMedia(input))
    if(input.target==='assistant'){
     const context=await readAssistantVoiceContext(owner,input,ports,admission.assertCurrent)
     admission.assertCurrent();admission.context=context
     return {context,assertCurrent:admission.assertCurrent}
    }
    const conversation=await ports.readConversation(input.sessionId)
    admission.assertCurrent()
    if(conversation.ownerId!==owner||conversation.status!=='ready'||conversation.sessionId!==input.sessionId||conversation.purpose!==undefined)throw forbidden()
    const role=await ports.readRole(input.roleId)
    admission.assertCurrent()
    if(!role||role.ownerId!==owner||role.id!==input.roleId||role.state==='retired')throw forbidden()
    if(role.version!==input.expectedRoleVersion)throw new WorkError('teloa/version-conflict','角色版本已变化，请重新选择当前同事。')
    const links=await ports.links.bySession(owner,{sessionId:input.sessionId}),roleLinks=links.filter(link=>link.kind==='role'&&link.active)
    admission.assertCurrent()
    if(roleLinks.length!==1)throw forbidden()
    const link=roleLinks[0]!
    if(link.objectId!==role.id||link.conversationId!==conversation.id||link.sessionId!==input.sessionId)throw forbidden()
    if(link.objectVersion!==role.version)throw new WorkError('teloa/version-conflict','角色会话关联版本已变化，请重新核对。')
    const requestedRoleId=await ports.readRequestedRoleId(input.sessionId)
    admission.assertCurrent()
    if(requestedRoleId!==null&&requestedRoleId!==role.id)throw forbidden()
    const scope=link.scopeId??(role.scopes.length===1?role.scopes[0]:undefined)
    if(!scope||!role.scopes.includes(scope))throw new WorkError('teloa/conflict','当前角色会话尚未固定可核对的业务范围。')
    const context=readVoiceCallContext({ownerId:owner,roleId:role.id,roleKind:role.kind,roleVersion:role.version,sessionId:input.sessionId,scope})
    admission.assertCurrent();admission.context=context
    return {context,assertCurrent:admission.assertCurrent}
   }catch(error){admission.release();throw error}
  },
  transport:{
   readiness:()=>transport.readiness(),
   ...(transport.closePending?{closePending:(input:Readonly<{callId:string;callGeneration:string}>)=>transport.closePending!(input)}:{}),
   async connect(input){
    const admission=[...admissions.values()].find(item=>item.call?.id===input.callId)
    if(!admission||!isDeepStrictEqual(admission.context,input.roleContext))throw new VoiceTransportFailure('authorization-changed')
    admission.assertCurrent();admission.onEvent=input.onEvent
    return transport.connect({...input,onEvent:event=>{
     // 事件转交前再次核对同步当前句柄；原 service 还会核对 call/playback 世代。
     try{admission.assertCurrent()}catch{input.onEvent({type:'error',callGeneration:input.callGeneration,reason:'authorization-changed'});return}
     input.onEvent(event)
    }})
   },
  },
  onChange(call){
   if(call.ownerId!==owner)return
   calls.set(call.requestId,call)
   const admission=admissions.get(call.requestId)
   if(admission){admission.call=call;if(terminal(call))admission.release()}
   ports.onChange?.(call)
  },
 })
 const baseHandler=createVoiceCallHandler(owner,service)
 const dispose=async()=>{
  closed=true
  const requests=new Set([...admissions.keys(),...calls.keys()])
  const results=await Promise.allSettled([...requests].map(requestId=>service.endByRequest(owner,{requestId})))
  await Promise.allSettled([...pendingStarts])
  for(const admission of admissions.values())admission.release()
  if(results.some(result=>result.status==='rejected')||[...calls.values()].some(call=>call.failure==='media-close-failed'))throw new WorkError('teloa/unavailable','媒体资源尚未确认关闭，请重试挂断。')
 }
 return Object.freeze({service,handler:baseHandler,dispose})
}
