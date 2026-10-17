import {isDeepStrictEqual} from 'node:util'
import {SessionId,type SessionEvent,type SessionStore,type UserMessage} from '@deepseek-ai/dsh-session'
import type {AssistantStreamFrame} from '@deepseek-ai/dsh-agent'
import type {SessionController,SessionPromptRequest,SessionPromptValue} from '@deepseek-ai/dsh-api-session-controller'
import {WorkError,sameVoiceCallContext,readTranscriptCommit,readVoiceCall,type Conversation,type TranscriptCommit} from '@teloa/contract'
import type {VoiceCallService} from './voice-call-service.ts'
import {readSessionEvents} from './session-events.ts'
import type {VoiceConversationState,VoiceStageTiming} from './voice-media-registry.ts'

export type VoiceConversationSession=Readonly<{ownerId:string;sessionId:string;inheritedEventCount:number;events:readonly SessionEvent[]}>
export type VoiceConversationReceipt=Readonly<{
 commitId:string;requestId:string;sessionId:string
 state:'unknown'|'queued'|'active'|'ended'
 message:Readonly<{id:string;seq:number}>|null
 reason:string|null
 reply:Readonly<{messageId:string;messageSeq:number;text:string;endSeq:number}>|null
 speech:'not-ready'|'queued'|'suppressed'|'unknown'
}>
export type VoiceConversationDriverPorts=Readonly<{
 owner:string
 assertCurrentCommit:(commit:TranscriptCommit)=>void
 calls:Pick<VoiceCallService,'get'|'enqueueSpeech'>&Partial<Pick<VoiceCallService,'prepareSpeech'>>
 readSession:(sessionId:string)=>Promise<VoiceConversationSession>
 /** host 将原 service 对象注册到 NativeInput voice scope；禁止只按 UUID 或提前检查代替最终准入。 */
 admitPrompt:(commit:TranscriptCommit,request:SessionPromptRequest,signal:AbortSignal)=>Promise<SessionPromptValue>
 /** 宿主原生输入生命周期；绝不能返回媒体、窗口或前台 RPC 的取消信号。 */
 workSignal:(commit:TranscriptCommit)=>AbortSignal
 onConversationState?:(input:VoiceConversationState)=>void
 onTiming?:(input:VoiceStageTiming)=>void
}>
type Preparation={attemptId:string;revision:number;index:number;text:string;verified:boolean;attempted:boolean;dispose?:()=>void}
type Record={commit:TranscriptCommit;fixed:TranscriptCommit;playbackGeneration:number;receipt:VoiceConversationReceipt;pending?:Promise<VoiceConversationReceipt>;speechAttempted:boolean;conversationState?:VoiceConversationState['state'];timings:Set<VoiceStageTiming['stage']>;preparation?:Preparation}
const forbidden=()=>new WorkError('teloa/forbidden','当前语音轮次不属于本人原通话。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','原生会话轮次或请求来源无法核对。')
const closed=()=>new WorkError('teloa/host-unavailable','语音会话驱动已关闭。')

/** 复用本人工作绑定与原生纯读接口；不 resolve/activate Agent，不补写会话事实。 */
export function createDshVoiceSessionReader(ctx:{sessions:Pick<SessionStore,'get'>;sessionController:Pick<SessionController,'inspect'>},ports:{owner:string;conversation:(sessionId:string)=>Promise<Pick<Conversation,'id'|'ownerId'|'sessionId'|'status'>>}){
 return async(sessionId:string):Promise<VoiceConversationSession>=>{
  const binding=await ports.conversation(sessionId)
  if(binding.ownerId!==ports.owner||binding.sessionId!==sessionId||binding.status!=='ready')throw forbidden()
  const id=SessionId(sessionId),attached=ctx.sessions.get(id)
  const source=attached?{meta:attached.header,inheritedEventCount:attached.inheritedEventCount,events:readSessionEvents(attached)}:await ctx.sessionController.inspect(id)
  const current=await ports.conversation(sessionId)
  if(current.id!==binding.id||current.ownerId!==ports.owner||current.sessionId!==sessionId||current.status!=='ready'||source.meta.id!==sessionId||source.meta.origin==='subagent'||attached&&ctx.sessions.get(id)!==attached)throw forbidden()
  return Object.freeze({ownerId:current.ownerId,sessionId:source.meta.id,inheritedEventCount:Number(source.inheritedEventCount),events:source.events})
 }
}

/** 仅投影该原请求的真实本人消息及同一 completed 轮次；不判断 Task/Run 是否受理或完成。 */
export function observeNativeRequest(fixed:Pick<TranscriptCommit,'id'|'text'>,snapshot:VoiceConversationSession):Omit<VoiceConversationReceipt,'commitId'|'requestId'|'sessionId'|'speech'>{
 const {events,inheritedEventCount:cut}=snapshot
 if(!Number.isSafeInteger(cut)||cut<0||cut>events.length||events.some((event,index)=>event.seq!==index))throw corrupt()
 const matches=(message:UserMessage)=>message.source.kind==='user'&&'rpcId' in message.source&&message.source.rpcId===fixed.id
 const exact=(message:UserMessage)=>message.role==='user'&&message.content.length===1&&message.content[0]?.type==='text'&&message.content[0].text===fixed.text
 const inputs=events.filter((event):event is Extract<SessionEvent,{type:'user/message'}>=>event.seq>=cut&&event.type==='user/message'&&event.surfaceOp==='append'&&matches(event.data))
 if(inputs.length>1)throw corrupt()
 const input=inputs[0]
 if(!input){
  // 官方 Inbox 的归属来自持久 splice，而不是模型/客户端自报 accepted。
  const queues:{[key:string]:{message:UserMessage;seq:number}[]}={'next-turn':[],'next-step':[]}
  for(const event of events)if(event.type==='agent/inbox/spliced'){
   const queue=queues[event.data.target]
   if(!queue)throw corrupt()
   queue.splice(event.data.start,event.data.removedCount??0,...event.data.inserted.map(message=>({message,seq:event.seq})))
  }
  const queued=Object.values(queues).flat().filter(item=>item.seq>=cut&&matches(item.message))
  if(queued.length>1||queued.some(item=>!exact(item.message)))throw corrupt()
  return {state:queued.length?'queued':'unknown',message:null,reason:null,reply:null}
 }
 if(!exact(input.data))throw corrupt()
 const start=events.slice(cut,input.seq).reverse().find(event=>event.type==='turn/start')
 if(start?.type!=='turn/start')throw corrupt()
 const end=events.slice(input.seq+1).find(event=>event.type==='turn/end'||event.type==='turn/start')
 const message=Object.freeze({id:input.data.id,seq:Number(input.seq)})
 if(end?.type==='turn/start')throw corrupt()
 if(!end)return {state:'active',message,reason:null,reply:null}
 if(end.type!=='turn/end'||end.data.turn!==start.data.turn)throw corrupt()
 // steer 可在同一轮追加本人消息；最终回答归最后一条输入，不能由前条冒领。
 const own=events.slice(input.seq+1,end.seq),others=own.some(event=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user')
 const assistant=[...own].reverse().find(event=>event.type==='assistant/message'&&event.surfaceOp==='append')
 const text=assistant?.type==='assistant/message'?assistant.data.message.content.filter(part=>part.type==='text').map(part=>part.text).join('\n').trim():''
 const reply=end.data.reason.kind==='completed'&&!others&&assistant?.type==='assistant/message'&&assistant.data.turn===start.data.turn&&!assistant.data.interrupted&&assistant.data.message.source.kind==='model'&&text?Object.freeze({messageId:assistant.data.message.id,messageSeq:Number(assistant.seq),text,endSeq:Number(end.seq)}):null
 return {state:'ended',message,reason:end.data.reason.kind,reply}
}

const observe=observeNativeRequest
/** service 自产最终转写 → 已有官方 prompt → 持久最终回复播报；没有模型、Task 或 stop 引擎。 */
export class VoiceConversationDriver{
 readonly #ports:VoiceConversationDriverPorts
 readonly #records=new Map<string,Record>()
 readonly #observing=new Map<string,{pending:Promise<readonly VoiceConversationReceipt[]>;dirty:boolean}>()
 #closed=false
 constructor(ports:VoiceConversationDriverPorts){
  if(typeof ports.owner!=='string'||!ports.owner.trim()||ports.owner!==ports.owner.trim()||ports.owner.length>128||/[\x00-\x1f\x7f]/.test(ports.owner))throw forbidden()
  if(typeof ports.admitPrompt!=='function')throw new WorkError('teloa/unavailable','语音最终输入准入尚未装配。')
  this.#ports=ports
 }
 #assert(commit:TranscriptCommit):void{
  const result:unknown=this.#ports.assertCurrentCommit(commit)
  if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw forbidden()}
 }
 #call(fixed:TranscriptCommit){
  const call=readVoiceCall(this.#ports.calls.get(this.#ports.owner,{callId:fixed.callId}))
  if(call.ownerId!==this.#ports.owner||call.id!==fixed.callId||call.callGeneration!==fixed.callGeneration||!sameVoiceCallContext(call,fixed))throw forbidden()
  return call
 }
 async #read(record:Record):Promise<VoiceConversationSession>{
  const snapshot=await this.#ports.readSession(record.fixed.sessionId)
  if(snapshot.ownerId!==this.#ports.owner||snapshot.sessionId!==record.fixed.sessionId)throw forbidden()
  return snapshot
 }
 #state(record:Record,state:VoiceConversationState['state']):void{
  if(record.conversationState===state)return
  record.conversationState=state
  const fixed=record.fixed
  try{this.#ports.onConversationState?.({callId:fixed.callId,callGeneration:fixed.callGeneration,turnId:fixed.turnId,playbackGeneration:record.playbackGeneration,state})}catch{/* 媒体状态展示不能改变原会话工作。 */}
 }
 #timing(record:Record,stage:VoiceStageTiming['stage'],at:number):void{
  if(record.timings.has(stage)||!Number.isFinite(at))return
  record.timings.add(stage)
  const fixed=record.fixed
  try{this.#ports.onTiming?.({callId:fixed.callId,callGeneration:fixed.callGeneration,turnId:fixed.turnId,requestId:fixed.id,stage,at})}catch{/* 内部诊断不影响正式输入或播报。 */}
 }
 #discard(record:Record):void{record.preparation?.dispose?.();delete record.preparation}
 #prepare(record:Record,candidate:Preparation):void{
  if(this.#closed||record.preparation!==candidate||!candidate.verified||candidate.attempted)return
  const prefix=candidate.text.match(/^[^，。！？!?；;,、\n]{1,59}[，。！？!?；;,、]/u)?.[0]
  if(!prefix)return
  candidate.attempted=true
  try{
   const call=this.#call(record.fixed)
   if(call.state!=='connected'||call.playbackGeneration!==record.playbackGeneration)return
   const dispose=this.#ports.calls.prepareSpeech?.(this.#ports.owner,{callId:call.id,utteranceId:record.fixed.id,text:prefix,expectedPlaybackGeneration:record.playbackGeneration})
   if(dispose)candidate.dispose=dispose
  }catch{/* 候选失败保留原正式回复播报，不能结束通话或影响原工作。 */}
 }
 /** 只读原生流，候选不进入消息/工具/播放；持久最终回复仍是唯一播报准入。 */
 observeAssistantStream(sessionId:string,frame:AssistantStreamFrame):void{
  if(this.#closed||!this.#ports.calls.prepareSpeech)return
  const record=[...this.#records.values()].reverse().find(row=>row.fixed.sessionId===sessionId&&!row.speechAttempted&&row.receipt.state!=='ended')
  if(!record)return
  if(frame.type==='start'){
   this.#discard(record)
   const candidate:Preparation={attemptId:frame.attemptId,revision:frame.revision,index:0,text:'',verified:false,attempted:false}
   record.preparation=candidate
   void this.#read(record).then(snapshot=>{
    if(record.preparation!==candidate||this.#closed)return
    const observed=observe(record.fixed,snapshot)
    if(observed.state!=='active'||!observed.message)return
    const start=snapshot.events.slice(0,observed.message.seq).reverse().find(event=>event.type==='turn/start')
    if(start?.type!=='turn/start'||start.data.turn!==frame.turn||snapshot.events.slice(observed.message.seq+1).some(event=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user'))return
    candidate.verified=true;this.#prepare(record,candidate)
   }).catch(()=>{})
   return
  }
  const candidate=record.preparation
  if(!candidate||candidate.attemptId!==frame.attemptId||frame.revision<=candidate.revision)return
  candidate.revision=frame.revision
  if(frame.index!==candidate.index){this.#discard(record);return}
  if(frame.type==='end'){
   if(frame.outcome.kind==='abandoned'||frame.outcome.eventType!=='assistant/message')this.#discard(record)
   return
  }
  candidate.index++
  if(frame.chunk.type==='tool-call-delta'||frame.chunk.type==='block-start'&&frame.chunk.blockType==='tool-call'){this.#discard(record);return}
  if(frame.chunk.type==='text-delta'&&!candidate.attempted){
   candidate.text=(candidate.text+frame.chunk.text).slice(0,256)
   this.#prepare(record,candidate)
  }
 }
 async #refresh(record:Record,snapshot?:VoiceConversationSession):Promise<VoiceConversationReceipt>{
  let result:ReturnType<typeof observe>
  try{snapshot??=await this.#read(record);result=observe(record.fixed,snapshot)}catch(error){
   record.receipt=Object.freeze({...record.receipt,state:'unknown',reason:error instanceof WorkError?error.code:'read-unavailable',reply:null});return record.receipt
  }
  record.receipt=Object.freeze({...record.receipt,...result})
  if(result.state==='ended'&&!result.reply)this.#discard(record)
  this.#state(record,result.state==='ended'&&!result.reply?'idle':'waiting')
  // 只计最终可播报回复的首段；工具前正文不是该阶段，不冒称整轮模型首文本。
  if(result.reply&&!record.timings.has('final-response-first-text')){
   const assistant=snapshot.events[result.reply.messageSeq]
   if(assistant?.type==='assistant/message')for(const chunk of assistant.data.stream){
    if(chunk.type!=='text-chunks')continue
    let at=chunk.time0
    for(let index=0;index<chunk.texts.length;index++){if(index)at+=chunk.dt[index-1]??0;if(chunk.texts[index]?.trim()){this.#timing(record,'final-response-first-text',at);break}}
    if(record.timings.has('final-response-first-text'))break
   }
  }
  if(result.state==='ended'&&result.reason==='completed'&&!record.timings.has('model-completed')){
   const end=snapshot.events.find(event=>event.type==='turn/end'&&event.seq>(result.message?.seq??Infinity))
   if(end)this.#timing(record,'model-completed',Number(end.time))
  }
  if(!result.reply||record.speechAttempted)return record.receipt
  record.speechAttempted=true
  let call
  try{call=this.#call(record.fixed)}catch{record.receipt=Object.freeze({...record.receipt,speech:'suppressed'});return record.receipt}
  if(this.#closed||call.state!=='connected'||call.playbackGeneration!==record.playbackGeneration){record.receipt=Object.freeze({...record.receipt,speech:'suppressed'});return record.receipt}
  try{
   const spoken=readVoiceCall(await this.#ports.calls.enqueueSpeech(this.#ports.owner,{callId:call.id,utteranceId:record.fixed.id,text:result.reply.text,expectedPlaybackGeneration:record.playbackGeneration}))
   const queued=spoken.ownerId===call.ownerId&&spoken.id===call.id&&spoken.callGeneration===call.callGeneration&&spoken.state==='connected'&&spoken.playbackGeneration===record.playbackGeneration+1
   record.receipt=Object.freeze({...record.receipt,speech:queued?'queued':'unknown'})
  }catch(error){record.receipt=Object.freeze({...record.receipt,speech:error instanceof WorkError&&(error.code==='teloa/conflict'||error.code==='teloa/forbidden')?'suppressed':'unknown'})}
  return record.receipt
 }
 submit(commit:TranscriptCommit,expectedPlaybackGeneration?:number):Promise<VoiceConversationReceipt>{
  try{
   if(this.#closed)throw closed()
   const fixed=readTranscriptCommit(commit)
   if(fixed.ownerId!==this.#ports.owner)throw forbidden()
   const previous=this.#records.get(fixed.id)
   if(previous){if(previous.commit!==commit||!isDeepStrictEqual(previous.fixed,fixed)||expectedPlaybackGeneration!==undefined&&expectedPlaybackGeneration!==previous.playbackGeneration)throw forbidden();return previous.pending??this.#refresh(previous)}
   this.#assert(commit)
   const call=this.#call(fixed)
   if(call.state!=='connected')throw forbidden()
   const playbackGeneration=expectedPlaybackGeneration??call.playbackGeneration
   if(!Number.isSafeInteger(playbackGeneration)||playbackGeneration<0||playbackGeneration>call.playbackGeneration)throw forbidden()
   const record:Record={commit,fixed,playbackGeneration,speechAttempted:false,timings:new Set(),receipt:Object.freeze({commitId:fixed.id,requestId:fixed.id,sessionId:fixed.sessionId,state:'unknown',message:null,reason:null,reply:null,speech:'not-ready'})}
   // 先固定一次尝试；同 commit 并发与回执未知后只能读原请求，不再次 prompt。
   this.#records.set(fixed.id,record)
   const pending=(async()=>{
    let snapshot:VoiceConversationSession
    try{snapshot=await this.#read(record)}catch{return record.receipt}
    const original=observe(fixed,snapshot)
    if(original.state!=='unknown')return this.#refresh(record,snapshot)
    this.#assert(commit)
    const signal=this.#ports.workSignal(commit)
    if(!(signal instanceof AbortSignal))throw closed()
    signal.throwIfAborted()
    if(this.#closed)throw closed()
    this.#state(record,'waiting');this.#timing(record,'model-submit',Date.now())
    try{await this.#ports.admitPrompt(commit,{requestId:fixed.id as SessionPromptRequest['requestId'],sessionId:SessionId(fixed.sessionId),mode:'queue',content:[{type:'text',text:fixed.text}]},signal)}catch{/* 追加/回执可能已经发生，只核对原请求。 */}
    return this.#refresh(record)
   })()
   record.pending=pending
   void pending.then(()=>{delete record.pending},()=>{delete record.pending})
   return pending
  }catch(error){return Promise.reject(error)}
 }
 reconcile(commitId:string):Promise<VoiceConversationReceipt>{
  const record=this.#records.get(commitId)
  if(!record)return Promise.reject(new WorkError('teloa/not-found','未找到原语音会话请求。'))
  return this.#refresh(record)
 }
 /** 媒体心跳只读最近真实投影，不等待供应商播报或重派原输入。 */
 receipt(commitId:string):VoiceConversationReceipt{
  const record=this.#records.get(commitId)
  if(!record)throw new WorkError('teloa/not-found','未找到原语音会话请求。')
  return record.receipt
 }
 /** session/event 是失效信号；最终证据仍从本人持久事件回读。并发事件合并后补读最新一轮。 */
 observeSession(sessionId:string):Promise<readonly VoiceConversationReceipt[]>{
  if(this.#closed)return Promise.resolve([])
  const prior=this.#observing.get(sessionId)
  if(prior){prior.dirty=true;return prior.pending}
  const state={dirty:true,pending:Promise.resolve([]) as Promise<readonly VoiceConversationReceipt[]>}
  this.#observing.set(sessionId,state)
  state.pending=(async()=>{
   let receipts:VoiceConversationReceipt[]=[]
   while(state.dirty&&!this.#closed){
    state.dirty=false
    const records=[...this.#records.values()].filter(record=>record.fixed.sessionId===sessionId)
    if(!records.length)return receipts
    let snapshot:VoiceConversationSession
    try{snapshot=await this.#read(records[0]!)}catch{return receipts}
    receipts=await Promise.all(records.map(record=>this.#refresh(record,snapshot)))
   }
   return receipts
  })()
  void state.pending.then(()=>{this.#observing.delete(sessionId)},()=>{this.#observing.delete(sessionId)})
  return state.pending
 }
 dispose():void{this.#closed=true;for(const record of this.#records.values())this.#discard(record)}
}
