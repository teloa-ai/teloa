import {createHash,randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {WorkError,readTranscriptCommit,type HardwareOperation,type HardwareReceipt,type TranscriptCommit} from '@teloa/contract'
import type {DirectDeviceBinding,DirectDeviceStore} from '@teloa/backend'
import {DeviceCaptureBusy,DeviceCaptureUnavailable,createDeviceAudioCapture,transcodeSpeechMp3,type DeviceAuthorization,type DeviceMedia,type DeviceSink} from '@teloa/device-gateway'
import type {VoiceSpeech} from './voice-service.ts'
import type {DeviceMediaOwner} from './device-media-owner.ts'
import {deviceSpeechSource} from './device-speech-source.ts'
import type {createDeviceApprovals} from './device-approvals.ts'

type Ports=Readonly<{
 store:DirectDeviceStore;mediaOwner:DeviceMediaOwner;modelPath:string;speech:VoiceSpeech;configured:()=>Promise<boolean>
 verify:(binding:DirectDeviceBinding)=>Promise<()=>void>
 dispatch:(commit:TranscriptCommit,assertCurrent:()=>void)=>Promise<unknown>
 read:(operation:HardwareOperation,binding:DirectDeviceBinding)=>Promise<HardwareReceipt>
 remember:(requestId:string)=>void
 capture?:typeof createDeviceAudioCapture
 packets?:typeof transcodeSpeechMp3
 approvals?:Pick<ReturnType<typeof createDeviceApprovals>,'open'|'decide'>
}>
const forbidden=()=>new WorkError('teloa/forbidden','原设备连接与语音授权已失效。')
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex')
export function splitDeviceSpeech(text:string):string[]{
 const parts:string[]=[];let buffer='',length=0
 for(const point of text){buffer+=point;length++;if(length===240||/[。！？!?；;\n]/.test(point)){if(buffer.trim())parts.push(buffer.trim());buffer='';length=0}}
 if(buffer.trim())parts.push(buffer.trim());return parts
}
/** 网关只获有限媒体端口；原助手输入由宿主 voice scope 最终发布。 */
export function createDirectDeviceHost(ports:Ports){
 const leases=new Map<string,Set<AbortController>>(),bindings=new WeakMap<DeviceAuthorization,DirectDeviceBinding>(),blocked=new Set<string>(),activeSessions=new Map<string,object>(),approvalBindings=new Map<string,DirectDeviceBinding>()
 let closed=false
 const assertBinding=(binding:DirectDeviceBinding)=>{if(closed||blocked.has(binding.id)||binding.status!=='active')throw forbidden()}
 const authorize=async(credential:string,signal:AbortSignal):Promise<DeviceAuthorization|null>=>{
  const binding=await ports.store.authorize(hash(credential));signal.throwIfAborted()
  if(!binding)return null
  assertBinding(binding);const context=await ports.verify(binding);signal.throwIfAborted();assertBinding(binding);context()
  const controller=new AbortController(),set=leases.get(binding.id)??new Set<AbortController>();set.add(controller);leases.set(binding.id,set)
  if(binding.allowApprovals===true)approvalBindings.set(binding.id,binding)
  let released=false
  const authorization=Object.freeze({bindingId:binding.id,signal:controller.signal,assertCurrent(){if(released)throw forbidden();controller.signal.throwIfAborted();assertBinding(binding);context()},release(){if(released)return;released=true;controller.abort();set.delete(controller);if(!set.size)leases.delete(binding.id)}})
  bindings.set(authorization,binding);return authorization
 }
 const media=async(authorization:DeviceAuthorization,sink:DeviceSink,signal:AbortSignal):Promise<DeviceMedia>=>{
  const binding=bindings.get(authorization);if(!binding)throw forbidden()
  const life=new AbortController(),linked=AbortSignal.any([signal,authorization.signal,life.signal])
  type Turn={id:string;controller:AbortController;release:()=>void;capture?:Awaited<ReturnType<typeof createDeviceAudioCapture>>}
  let current:Turn|undefined,disposed=false
  const assertCurrent=()=>{linked.throwIfAborted();authorization.assertCurrent()}
  const clear=(turn:Turn)=>{turn.release();if(current===turn)current=undefined;if(activeSessions.get(binding.assistantSessionId)===turn)activeSessions.delete(binding.assistantSessionId)}
  const abort=()=>{const old=current;if(!old)return;old.controller.abort();old.capture?.abort();clear(old)}
  const operation=async(captureId:string)=>{
   assertCurrent();const row=await ports.store.get(binding.id,captureId);assertCurrent()
   if(!row||row.grantVersion!==binding.grantVersion)throw forbidden()
   return row
  }
  const receipt=async(captureId:string)=>{
   const row=await operation(captureId)
   if(row.state==='discarded'||!row.text)return {operationId:captureId,state:'unknown' as const,speakableText:'原语音尚未受理，请到 Teloa 核对。',resultRef:null}
   const value=await ports.read({...row,state:row.state==='accepted'?'accepted':'unknown'},binding);assertCurrent()
   if(value.resultRef)await ports.store.receipt(binding.id,captureId,'accepted',value.resultRef)
   return value
  }
  const sendReceipt=(captureId:string,value:HardwareReceipt)=>{assertCurrent();sink.control({type:'request.receipt',captureId,state:value.state==='prepared'?'pending':value.state,text:value.speakableText})}
  const speak=async(captureId:string,value:HardwareReceipt,turnSignal:AbortSignal)=>{
   const speechSignal=AbortSignal.any([linked,turnSignal]);speechSignal.throwIfAborted();assertCurrent()
   for(const text of splitDeviceSpeech(value.speakableText)){
    speechSignal.throwIfAborted();assertCurrent()
    await sink.play({captureId,text,packets:playSignal=>{
     const both=AbortSignal.any([speechSignal,playSignal]);return (ports.packets??transcodeSpeechMp3)(deviceSpeechSource(ports.speech,text,both),both)
    }})
   }
  }
  const complete=async(turn:Turn,wav:Uint8Array)=>{
   const turnSignal=AbortSignal.any([linked,turn.controller.signal]),check=()=>{turnSignal.throwIfAborted();assertCurrent();if(current!==turn)throw forbidden()}
   try{
    check();const transcript=await ports.speech.transcribe(wav,'wav',turnSignal);check()
    if(!transcript||transcript.audioSha256!==hash(wav)){await ports.store.receipt(binding.id,turn.id,'discarded');sink.control({type:'error',code:'no-speech'});return}
    await ports.store.transcribed(binding.id,turn.id,transcript.text);check()
    const row=await operation(turn.id);check();sink.control({type:'transcript',captureId:turn.id,text:row.text})
    if(!await ports.store.claim(binding.id,turn.id))return
    const commit=readTranscriptCommit({target:'assistant',ownerId:binding.ownerId,sessionId:binding.assistantSessionId,scope:'general',contextVersion:binding.contextVersion,callId:randomUUID(),callGeneration:randomUUID(),turnId:turn.id,speaker:'owner',revision:1,text:row.text,closed:true,complete:true,producerReceipt:randomUUID(),id:row.nativeRequestId,contentSha256:hash(row.text),source:{kind:'sealed-audio-stt',providerId:transcript.providerId??'minimax',audioSha256:transcript.audioSha256,sealReceiptId:turn.id,sttReceiptId:transcript.receiptId}})
    ports.remember(row.nativeRequestId)
    try{check();await ports.dispatch(commit,check);await ports.store.receipt(binding.id,turn.id,'accepted')}
    catch{await ports.store.receipt(binding.id,turn.id,'unknown')}
    // 受理后只读原请求。媒体取消只停止等待与播报，原生工作继续。
    const deadline=Date.now()+120000;let previous='',approvalSpoken=false
    while(true){
     check();const value=await receipt(turn.id);check()
     const signature=JSON.stringify([value.state,value.speakableText])
     if(signature!==previous){sendReceipt(turn.id,value);previous=signature}
     if(value.state==='needs_approval'&&!approvalSpoken){approvalSpoken=true;await speak(turn.id,value,turnSignal)}
     if(value.state==='completed'||value.state==='rejected'){
      await speak(turn.id,value,turnSignal);return
     }
     if(Date.now()>=deadline)return
     await delay(250,undefined,{signal:turnSignal})
    }
   }catch{if(!turnSignal.aborted){try{sink.control({type:'error',code:'unavailable'})}catch{/* 连接已关闭。 */}}}
   finally{clear(turn)}
  }
  return Object.freeze({
   async start(captureId,captureSignal){
    assertCurrent();if(current)throw new DeviceCaptureBusy()
    let lease:ReturnType<DeviceMediaOwner['acquire']>
    try{lease=ports.mediaOwner.acquire('device')}catch{throw new DeviceCaptureBusy()}
    const turn:Turn={id:captureId,controller:new AbortController(),release:lease.release};current=turn
    try{
     if(!await ports.configured())throw new DeviceCaptureUnavailable()
     assertCurrent();captureSignal.throwIfAborted();if(current!==turn)throw forbidden()
     const reserved=await ports.store.reserve(binding.id,captureId)
     if(!reserved.created)throw new DeviceCaptureBusy()
     activeSessions.set(binding.assistantSessionId,turn)
     const capture=await (ports.capture??createDeviceAudioCapture)({captureId,modelPath:ports.modelPath,signal:AbortSignal.any([linked,captureSignal,turn.controller.signal]),onSealed:sealed=>{
      try{assertCurrent();sink.sealed(captureId,sealed.reason==='manual'?'stop':sealed.reason);void complete(turn,sealed.wav)}catch{abort()}
     },onDiscard:()=>{void ports.store.receipt(binding.id,captureId,'discarded').catch(()=>{});try{sink.discarded(captureId)}finally{clear(turn)}}})
     turn.capture=capture
     return {push:capture.push,stop:capture.stop,abort:()=>{capture.abort();if(current===turn)abort()}}
    }catch(error){clear(turn);throw error}
   },
   async status(captureId){sendReceipt(captureId,await receipt(captureId))},
   async approvals(index){assertCurrent();if(!ports.approvals||binding.allowApprovals!==true)throw new DeviceCaptureUnavailable();const card=await ports.approvals.open(authorization,binding,index);assertCurrent();sink.control(card)},
   async decide(input){assertCurrent();if(!ports.approvals||binding.allowApprovals!==true)throw new DeviceCaptureUnavailable();const receipt=await ports.approvals.decide(authorization,binding,input);assertCurrent();sink.control(receipt)},
   async repeat(captureId){
    assertCurrent();if(current)throw new DeviceCaptureBusy()
    let lease:ReturnType<DeviceMediaOwner['acquire']>
    try{lease=ports.mediaOwner.acquire('device')}catch{throw new DeviceCaptureBusy()}
    const turn:Turn={id:captureId,controller:new AbortController(),release:lease.release};current=turn
    try{const value=await receipt(captureId);sendReceipt(captureId,value);if(value.state==='completed'||value.state==='needs_approval')await speak(captureId,value,turn.controller.signal)}finally{clear(turn)}
   },abort,
   async close(){if(disposed)return;disposed=true;life.abort();const capture=current?.capture;abort();await capture?.close()},
  })
 }
 return Object.freeze({authorize,media,
  approvalConnections:()=>[...approvalBindings.values()].filter(binding=>!closed&&!blocked.has(binding.id)&&(leases.get(binding.id)?.size??0)>0),
  voiceContext:(sessionId:string)=>!closed&&activeSessions.has(sessionId)?'当前输入来自本人已配对的 Teloa 语音硬件，由宿主识别语音并将本次完整回答播报。沿用原助手、原会话、模型、工具和审批；普通交流简短自然地直接回答，不先说“已接手”代替结果。媒体关闭后不再持续监听。':'',
  async revoke(id:string){blocked.add(id);for(const lease of leases.get(id)??[])lease.abort();await ports.store.revoke(id)},
  async close(){closed=true;for(const set of leases.values())for(const lease of set)lease.abort();leases.clear()},
 })
}
