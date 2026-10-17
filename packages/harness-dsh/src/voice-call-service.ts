import {createHash,randomUUID} from 'node:crypto'
import {WorkError,sameVoiceCallContext,voiceCallMatchesStart,readVoiceCall,readVoiceCallContext,readVoiceReadiness,readVoiceTranscriptSeal,readTranscriptCommit,voiceCallStartInput,voiceCallIdInput,voiceCallRequestInput,voiceCallMutedInput,readVoiceCallEndByRequestResult,readVoiceCallMutedResult,voiceTranscriptCommitInput,type VoiceCall,type VoiceCallContext,type VoiceCallStartInput,type VoiceFailureReason,type VoiceReadiness,type VoiceTranscriptCandidate,type TranscriptCommit,type VoiceTranscriptCommitInput,type VoiceCallEndByRequestResult,type VoiceCallMutedResult} from '@teloa/contract'
import {createUnavailableVoiceTransport,sanitizeVoiceFailure,VoiceTransportFailure,type VoiceTransport,type VoiceConnection,type VoiceTransportEvent} from './voice-transport.ts'
import {voiceCallProgressLimit} from '@teloa/contract'

export type VoiceCallAdmission=Readonly<{context:VoiceCallContext;assertCurrent:()=>void}>
export type VoiceCallServicePorts=Readonly<{
 transport?:VoiceTransport
 /** 从本人原会话/角色关系回读范围；包含当前角色、委托、consent 与准入世代复核。 */
 resolveContext:(owner:string,input:VoiceCallStartInput)=>Promise<VoiceCallAdmission>
 /** 仅可信宿主读口能提供实际完整封口/STT 记录，不能读页面/模型同形对象。 */
 readTranscriptSeal:(producerReceipt:string)=>Promise<unknown|null>
 onChange?:(call:VoiceCall)=>void
}>
type CallRecord={call:VoiceCall;assertCurrent:()=>void;controller:AbortController;connection?:VoiceConnection;connecting?:boolean;pendingMedia?:boolean;closing?:Promise<void>;failureBeforeClose?:VoiceFailureReason|null;candidates:Map<string,VoiceTranscriptCandidate>;commits:Map<string,TranscriptCommit>;speech:Map<string,{sha256:string;generation:number}>}
type StartReservation={fingerprint:string|null;cancelled:boolean;pending?:Promise<VoiceCall>;record?:CallRecord}
const terminal=(call:VoiceCall)=>call.state==='ended'||call.state==='failed'
const forbidden=()=>new WorkError('teloa/forbidden','当前通话身份或执行许可已变化。')
const cancelled=()=>new WorkError('teloa/conflict','原通话请求已取消，请主动发起新的通话。')
const requestKey=(owner:string,requestId:string)=>JSON.stringify([owner,requestId])
function ownerIdentity(owner:string):void{
 if(typeof owner!=='string'||!owner.trim()||owner!==owner.trim()||owner.length>128||/[\x00-\x1f\x7f]/.test(owner))throw forbidden()
}
function fields(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))throw new WorkError('teloa/invalid-input','通话读取请求不正确。')
 return value as Record<string,unknown>
}
const turnIdentity=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_:-]{1,128}$/.test(value)
const sameCommitRequest=(commit:TranscriptCommit,input:VoiceTranscriptCommitInput)=>commit.revision===input.revision&&commit.producerReceipt===input.producerReceipt

/** 进程内媒体状态/回执基础；持久 VoiceWorkIntent、Task/Run 受理是独立工作层。 */
export class VoiceCallService{
 readonly #ports:VoiceCallServicePorts
 readonly #transport:VoiceTransport
 readonly #calls=new Map<string,CallRecord>()
 readonly #requests=new Map<string,StartReservation>()
 readonly #issued=new WeakMap<object,CallRecord>()
 constructor(ports:VoiceCallServicePorts){this.#ports=ports;this.#transport=ports.transport??createUnavailableVoiceTransport()}
 async readiness():Promise<VoiceReadiness>{
  try{return readVoiceReadiness(await this.#transport.readiness())}catch{return Object.freeze({status:'unavailable',providerId:null,reason:'provider-unavailable'})}
 }
 start(owner:string,value:unknown):Promise<VoiceCall>{
  try{
   ownerIdentity(owner)
   const input=voiceCallStartInput(value),key=requestKey(owner,input.requestId),fingerprint=JSON.stringify(input),previous=this.#requests.get(key)
   if(previous){
    if(previous.fingerprint!==null&&previous.fingerprint!==fingerprint)throw new WorkError('teloa/conflict','同一通话请求不能改换身份或会话。')
    if(previous.fingerprint===null)previous.fingerprint=fingerprint
    if(previous.record&&terminal(previous.record.call))return Promise.resolve(previous.record.call)
    if(previous.cancelled||!previous.pending)throw cancelled()
    return previous.pending.then(call=>previous.record?.call??call)
   }
   // 在异步身份读口前预约，同 requestId 并发也只打开一次媒体。
   let resolve!:(call:VoiceCall)=>void,reject!:(error:unknown)=>void
   const pending=new Promise<VoiceCall>((done,failed)=>{resolve=done;reject=failed}),reservation:StartReservation={fingerprint,cancelled:false,pending}
   this.#requests.set(key,reservation)
   void this.#start(owner,input,reservation).then(resolve,reject)
   return pending
  }catch(error){return Promise.reject(error)}
 }
 async #start(owner:string,input:VoiceCallStartInput,reservation:StartReservation):Promise<VoiceCall>{
  let admission:VoiceCallAdmission
  try{admission=await this.#ports.resolveContext(owner,input)}catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/host-unavailable','暂时不能核对通话身份。')}
  if(reservation.cancelled)throw cancelled()
  const context=readVoiceCallContext(admission.context)
  const assertCurrent=()=>{
   try{
    if(typeof admission.assertCurrent!=='function')throw forbidden()
    const result:unknown=admission.assertCurrent()
    if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw forbidden()}
   }catch{throw forbidden()}
  }
  if(context.ownerId!==owner||!voiceCallMatchesStart(context,input))throw forbidden()
  assertCurrent()
  // 本人主动重新拨号先收尾所属旧媒体；终态 DTO 不能代替实际连接关闭。
  for(const previous of this.#calls.values()){
   if(previous.call.ownerId!==owner||!terminal(previous.call))continue
   if(previous.connecting)throw new WorkError('teloa/conflict','上一通话仍在收尾，请稍后重试。')
   await this.#close(previous)
   if(previous.connection||previous.call.failure==='media-close-failed')throw new WorkError('teloa/unavailable','上一通话尚未完全关闭，请重试挂断。')
   assertCurrent()
  }
  if(reservation.cancelled)throw cancelled()
  if([...this.#calls.values()].some(record=>record.call.ownerId===owner&&!terminal(record.call)))throw new WorkError('teloa/conflict','请先结束本人正在进行的通话。')
  const record:CallRecord={call:readVoiceCall({...context,id:randomUUID(),requestId:input.requestId,callGeneration:randomUUID(),state:'connecting',readiness:{status:'unavailable',providerId:null,reason:'provider-unavailable'},playbackGeneration:0,playback:'idle',createdAt:new Date().toISOString(),endedAt:null,failure:null}),assertCurrent,controller:new AbortController(),candidates:new Map(),commits:new Map(),speech:new Map()}
  reservation.record=record;this.#calls.set(record.call.id,record);this.#notify(record)
  const readiness=await this.readiness()
  if(terminal(record.call))return record.call
  this.#change(record,{readiness})
  if(terminal(record.call)||record.controller.signal.aborted)return record.call
  try{assertCurrent()}catch{await this.#fail(record,'authorization-changed');return record.call}
  if(readiness.status==='unavailable'){await this.#fail(record,readiness.reason);return record.call}
  try{
   assertCurrent()
   if(terminal(record.call)||record.controller.signal.aborted)return record.call
   record.connecting=true;record.pendingMedia=typeof this.#transport.closePending==='function'
   const connection=await this.#transport.connect({callId:record.call.id,callGeneration:record.call.callGeneration,roleContext:context,signal:record.controller.signal,onEvent:event=>this.#receive(record,event)})
   if(!connection||typeof connection.close!=='function'||typeof connection.interruptPlayback!=='function')throw new VoiceTransportFailure('connection-failed')
   record.connection=connection;delete record.pendingMedia
   if(terminal(record.call)||record.controller.signal.aborted){await this.#close(record);return record.call}
   try{assertCurrent()}catch{await this.#fail(record,'authorization-changed');return record.call}
   this.#change(record,{state:'connected'})
  }catch(error){if(!terminal(record.call))await this.#fail(record,sanitizeVoiceFailure(error))}
  finally{record.connecting=false}
  return record.call
 }
 #record(owner:string,callId:string):CallRecord{
  ownerIdentity(owner)
  const record=this.#calls.get(callId)
  if(!record)throw new WorkError('teloa/not-found','未找到原通话。')
  if(record.call.ownerId!==owner)throw forbidden()
  return record
 }
 get(owner:string,value:unknown):VoiceCall{return this.#record(owner,voiceCallIdInput(value).callId).call}
 /** 仅宿主提示装配读取真实连接；不接受浏览器提交的 call DTO 或历史转写代替当前状态。 */
 connectedForSession(owner:string,sessionId:string):VoiceCall|null{
  ownerIdentity(owner)
  for(const record of this.#calls.values()){
   if(record.call.ownerId!==owner||record.call.sessionId!==sessionId||record.call.state!=='connected')continue
   try{this.#assertLive(record)}catch{return null}
   return record.call
  }
  return null
 }
 /** 纯读本进程原call自产的最近封口；挂断保留历史，读取不触发STT或工作受理。 */
 progressTranscripts(owner:string,value:unknown):readonly TranscriptCommit[]{
  const record=this.#record(owner,voiceCallIdInput(value).callId),call=record.call,commits=[...record.commits.values()].slice(-voiceCallProgressLimit)
  for(const commit of commits)if(this.#issued.get(commit)!==record||commit.ownerId!==call.ownerId||commit.callId!==call.id||commit.callGeneration!==call.callGeneration||!sameVoiceCallContext(commit,call))throw forbidden()
  return Object.freeze(commits)
 }
 /** 纯读原请求；查询未知/准备中的请求绝不触发身份准入、start 或打开媒体。 */
 getByRequest(owner:string,value:unknown):VoiceCall|null{
  ownerIdentity(owner);const {requestId}=voiceCallRequestInput(value)
  return this.#requests.get(requestKey(owner,requestId))?.record?.call??null
 }
 async endByRequest(owner:string,value:unknown):Promise<VoiceCallEndByRequestResult>{
  ownerIdentity(owner);const {requestId}=voiceCallRequestInput(value),key=requestKey(owner,requestId)
  let reservation=this.#requests.get(key)
  if(!reservation){reservation={fingerprint:null,cancelled:true};this.#requests.set(key,reservation)}
  reservation.cancelled=true
  const record=reservation.record
  if(record){this.#finish(record,'ended',null);await this.#close(record)}
  return readVoiceCallEndByRequestResult({requestId,cancelled:true,call:record?.call??null})
 }
 #change(record:CallRecord,patch:Partial<VoiceCall>):void{record.call=readVoiceCall({...record.call,...patch});this.#notify(record)}
 #notify(record:CallRecord):void{try{const result:unknown=this.#ports.onChange?.(record.call);if(result!==undefined)void Promise.resolve(result).catch(()=>{})}catch{/* 展示通知不能改变真实媒体状态。 */}}
 #finish(record:CallRecord,state:'ended'|'failed',failure:VoiceFailureReason|null):void{
  if(terminal(record.call))return
  const endedAt=new Date(Math.max(Date.now(),Date.parse(record.call.createdAt))).toISOString()
  this.#change(record,{state,endedAt,failure,playback:'idle'})
  record.candidates.clear();record.controller.abort()
 }
 async #close(record:CallRecord):Promise<void>{
  const connection=record.connection,pending=record.pendingMedia?this.#transport.closePending:undefined
  if(!connection&&!pending)return
  if(!record.closing){
   const priorFailure=record.call.failure
   const closing=Promise.resolve().then(()=>connection?connection.close():pending!.call(this.#transport,{callId:record.call.id,callGeneration:record.call.callGeneration})).then(()=>{
    if(record.connection===connection)delete record.connection
    if(!connection)delete record.pendingMedia
    if(record.call.failure==='media-close-failed')this.#change(record,{failure:record.failureBeforeClose??(record.call.state==='failed'?'connection-failed':null)})
    delete record.failureBeforeClose
   }).catch(()=>{
    if(record.failureBeforeClose===undefined)record.failureBeforeClose=priorFailure
    this.#change(record,{failure:'media-close-failed'})
   }).finally(()=>{if(record.closing===closing)delete record.closing})
   record.closing=closing
  }
  await record.closing
 }
 async #fail(record:CallRecord,reason:VoiceFailureReason):Promise<void>{this.#finish(record,'failed',reason);await this.#close(record)}
 async end(owner:string,value:unknown):Promise<VoiceCall>{
  const record=this.#record(owner,voiceCallIdInput(value).callId)
  // 撤权后本人仍可挂断；媒体停止不消费工作执行许可，也没有 Task stop 端口。
  this.#finish(record,'ended',null);await this.#close(record);return record.call
 }
 async interrupt(owner:string,value:unknown):Promise<VoiceCall>{
  const record=this.#record(owner,voiceCallIdInput(value).callId)
  if(record.call.state!=='connected'||!record.connection)return record.call
  const playbackGeneration=record.call.playbackGeneration+1
  this.#change(record,{playbackGeneration,playback:'idle'})
  try{await record.connection.interruptPlayback({playbackGeneration})}catch{await this.#fail(record,'connection-failed')}
  return record.call
 }
 async setMuted(owner:string,value:unknown):Promise<VoiceCallMutedResult>{
  const input=voiceCallMutedInput(value),record=this.#record(owner,input.callId),connection=record.connection
  const assertCurrent=()=>{
   if(record.call.callGeneration!==input.callGeneration||record.call.state!=='connected'||record.controller.signal.aborted||record.connection!==connection)throw new WorkError('teloa/conflict','通话已结束或世代已变化，请重新核对。')
   record.assertCurrent()
  }
  assertCurrent()
  if(!connection?.setMuted)throw new WorkError('teloa/unavailable','当前语音连接尚不支持静音。')
  try{await connection.setMuted({muted:input.muted,callGeneration:input.callGeneration})}catch{throw new WorkError('teloa/unavailable','暂时无法确认媒体静音状态，请重试。')}
  assertCurrent()
  return readVoiceCallMutedResult(input)
 }
 /** 仅宿主真实模型回复进入播报；不向页面开放文本转语音或任何工作授权。 */
 prepareSpeech(owner:string,value:unknown):(()=>void)|undefined{
  const input=fields(value,['callId','utteranceId','text','expectedPlaybackGeneration']),record=this.#record(owner,voiceCallIdInput({callId:input.callId}).callId)
  if(!turnIdentity(input.utteranceId)||typeof input.text!=='string'||!input.text.trim()||input.text.length>60||/[\x00-\x1f\x7f]/.test(input.text)||!Number.isSafeInteger(input.expectedPlaybackGeneration)||Number(input.expectedPlaybackGeneration)<0)throw new WorkError('teloa/invalid-input','候选首句不正确。')
  this.#assertLive(record)
  if(record.call.playbackGeneration!==input.expectedPlaybackGeneration||record.speech.has(input.utteranceId))return
  return record.connection?.prepareSpeech?.({utteranceId:input.utteranceId,text:input.text,callGeneration:record.call.callGeneration,playbackGeneration:record.call.playbackGeneration})
 }
 /** 只接受原生持久最终回复，预合成不能推进播放代次。 */
 async enqueueSpeech(owner:string,value:unknown):Promise<VoiceCall>{
  const input=fields(value,['callId','utteranceId','text','expectedPlaybackGeneration']),record=this.#record(owner,voiceCallIdInput({callId:input.callId}).callId)
  if(!turnIdentity(input.utteranceId)||typeof input.text!=='string'||!input.text.trim()||input.text.length>16384||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.text)||!Number.isSafeInteger(input.expectedPlaybackGeneration)||Number(input.expectedPlaybackGeneration)<0)throw new WorkError('teloa/invalid-input','播报输入或世代不正确。')
  this.#assertLive(record)
  const digest=createHash('sha256').update(JSON.stringify([input.text,input.expectedPlaybackGeneration])).digest('hex'),previous=record.speech.get(input.utteranceId)
  if(previous){if(previous.sha256!==digest)throw new WorkError('teloa/conflict','原播报内容已固定，不能改写。');return record.call}
  if(record.call.playbackGeneration!==input.expectedPlaybackGeneration)throw new WorkError('teloa/conflict','回答已被插话中断，不能继续播报旧内容。')
  const connection=record.connection,callGeneration=record.call.callGeneration
  if(!connection?.enqueueSpeech)throw new WorkError('teloa/unavailable','当前语音连接尚不支持播报。')
  const playbackGeneration=record.call.playbackGeneration+1
  if(!Number.isSafeInteger(playbackGeneration))throw new WorkError('teloa/conflict','播报世代已不可继续。')
  // 跨提供方调用前固定请求；回包未知也不重新播放。playing 只接真实播放事件。
  record.speech.set(input.utteranceId,{sha256:digest,generation:playbackGeneration})
  this.#change(record,{playbackGeneration,playback:'idle'})
  try{await connection.enqueueSpeech({utteranceId:input.utteranceId,text:input.text,callGeneration,playbackGeneration})}
  catch(error){
   // 本人插话已经推进世代；旧播报迟到拒绝不能结束当前通话。
   if(record.call.state==='connected'&&!record.controller.signal.aborted&&record.connection===connection&&record.call.callGeneration===callGeneration&&record.call.playbackGeneration===playbackGeneration)await this.#fail(record,sanitizeVoiceFailure(error))
  }
  return record.call
 }
 #receive(record:CallRecord,event:VoiceTransportEvent):void{
  if(terminal(record.call)||record.controller.signal.aborted||!event||event.callGeneration!==record.call.callGeneration)return
  try{record.assertCurrent()}catch{void this.#fail(record,'authorization-changed');return}
  if(event.type==='disconnected'){void this.#fail(record,'connection-lost');return}
  if(event.type==='error'){
   let reason:VoiceFailureReason='connection-failed'
   try{reason=sanitizeVoiceFailure(new VoiceTransportFailure(event.reason))}catch{/* 只上报脱敏类别。 */}
   void this.#fail(record,reason);return
  }
  if(event.type==='playback'){
   if(event.playbackGeneration===record.call.playbackGeneration&&(event.state==='playing'||event.state==='idle'))this.#change(record,{playback:event.state})
   return
  }
  if(event.type!=='transcript-candidate'||event.sessionId!==record.call.sessionId||!turnIdentity(event.turnId)||!Number.isSafeInteger(event.revision)||event.revision<1||event.revision>2147483647||typeof event.text!=='string'||event.text.length>65536||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(event.text)||record.commits.has(event.turnId))return
  const previous=record.candidates.get(event.turnId)
  if(previous&&previous.revision>=event.revision)return
  record.candidates.set(event.turnId,Object.freeze({callGeneration:event.callGeneration,sessionId:event.sessionId,turnId:event.turnId,revision:event.revision,text:event.text}))
 }
 getTranscriptCandidate(owner:string,value:unknown):VoiceTranscriptCandidate|null{
  const input=fields(value,['callId','turnId']),record=this.#record(owner,voiceCallIdInput({callId:input.callId}).callId)
  if(!turnIdentity(input.turnId))throw new WorkError('teloa/invalid-input','转写轮次不正确。')
  return record.candidates.get(input.turnId)??null
 }
 #assertLive(record:CallRecord):void{
  if(record.call.state!=='connected'||record.controller.signal.aborted)throw new WorkError('teloa/conflict','原通话已结束或尚未连接，不能接纳新转写。')
  record.assertCurrent()
 }
 async commitTranscript(owner:string,value:unknown):Promise<TranscriptCommit>{
  const input=voiceTranscriptCommitInput(value),record=this.#record(owner,input.callId)
  const previous=record.commits.get(input.turnId)
  if(previous){if(!sameCommitRequest(previous,input))throw new WorkError('teloa/conflict','该轮最终转写已固定，不能改写。');return previous}
  this.#assertLive(record)
  let receipt:unknown
  try{receipt=await this.#ports.readTranscriptSeal(input.producerReceipt)}catch{throw new WorkError('teloa/unavailable','暂时不能核对完整转写回执。')}
  this.#assertLive(record)
  if(receipt===null)throw new WorkError('teloa/unavailable','尚无可信完整音频封口及 STT 回执。')
  const seal=readVoiceTranscriptSeal(receipt),call=record.call
  if(seal.ownerId!==owner||!sameVoiceCallContext(seal,call)||seal.callId!==call.id||seal.callGeneration!==call.callGeneration||seal.turnId!==input.turnId||seal.revision!==input.revision||seal.producerReceipt!==input.producerReceipt)throw new WorkError('teloa/conflict','完整转写回执与原通话身份、范围或世代不一致。')
  const current=record.commits.get(input.turnId)
  if(current){if(!sameCommitRequest(current,input))throw new WorkError('teloa/conflict','该轮最终转写已固定，不能改写。');return current}
  const candidate=record.candidates.get(input.turnId)
  if(candidate&&candidate.revision>seal.revision)throw new WorkError('teloa/conflict','完整转写版本落后于当前候选。')
  record.assertCurrent()
  const commit=readTranscriptCommit({...seal,id:randomUUID(),contentSha256:createHash('sha256').update(seal.text,'utf8').digest('hex')})
  record.commits.set(input.turnId,commit);record.candidates.delete(input.turnId);this.#issued.set(commit,record)
  return commit
 }
 getTranscriptCommit(owner:string,value:unknown):TranscriptCommit{
  const input=fields(value,['callId','commitId']),record=this.#record(owner,voiceCallIdInput({callId:input.callId}).callId),commitId=voiceCallIdInput({callId:input.commitId}).callId
  const commit=[...record.commits.values()].find(item=>item.id===commitId)
  if(!commit)throw new WorkError('teloa/not-found','未找到原最终转写回执。')
  return commit
 }
 /** 仅验证本进程 service 实际生成的对象；持久化后的受理须由 Task5 独立回读来源。 */
 assertTranscriptCommitCurrent(owner:string,commit:unknown):void{
  if(!commit||typeof commit!=='object')throw forbidden()
  const record=this.#issued.get(commit)
  if(!record||record.call.ownerId!==owner||![...record.commits.values()].some(item=>item===commit))throw forbidden()
  this.#assertLive(record)
 }
}
