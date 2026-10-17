import {createHash} from 'node:crypto'
import {WorkError,assistantVoiceNoteInput,readAssistantVoiceNoteResult,type AssistantVoiceCallStartInput,type AssistantVoiceNoteResult} from '@teloa/contract'
import {readAssistantVoiceContext,type AssistantVoiceContextPorts} from './voice-assistant-context.ts'
import type {VoiceCallContextLease} from './voice-call-runtime.ts'
import type {VoiceSpeech} from './voice-service.ts'

type Ports=Omit<AssistantVoiceContextPorts,'readConversation'|'readRequestedRoleId'>&{
 owner:string;conversation:AssistantVoiceContextPorts['readConversation'];requestedRoleId:AssistantVoiceContextPorts['readRequestedRoleId']
 capture:(input:AssistantVoiceCallStartInput)=>VoiceCallContextLease
 speech:Pick<VoiceSpeech,'transcribe'>
}
/** 单次语音草稿只消费ASR；这里没有 Call、prompt、模型、Task 或TTS端口。 */
export function createAssistantVoiceNote(ports:Ports){
 const requests=new Map<string,{spec:string;pending:Promise<AssistantVoiceNoteResult>}>()
 const contextPorts={...ports,readConversation:ports.conversation,readRequestedRoleId:ports.requestedRoleId}
 return async(payload:unknown,signal:AbortSignal):Promise<AssistantVoiceNoteResult>=>{
  const input=assistantVoiceNoteInput(payload);signal.throwIfAborted()
  const bytes=Buffer.from(input.audio,'base64')
  if(bytes.length<44||bytes.toString('base64')!==input.audio||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw new WorkError('teloa/invalid-input','语音留言需要有效的有界WAV音频。')
  const hash=createHash('sha256').update(bytes).digest('hex'),spec=JSON.stringify([input.sessionId,input.expectedContextVersion,hash]),previous=requests.get(input.requestId)
  if(previous&&previous.spec!==spec)throw new WorkError('teloa/conflict','同一留言不能改换音频、上下文或原会话。')
  const target:AssistantVoiceCallStartInput={requestId:input.requestId,sessionId:input.sessionId,target:'assistant',expectedContextVersion:input.expectedContextVersion},lease=ports.capture(target)
  const currentSignal=AbortSignal.any([signal,lease.signal]),check=()=>{currentSignal.throwIfAborted();lease.assertCurrent()}
  if(previous){try{await readAssistantVoiceContext(ports.owner,target,contextPorts,check);const result=await previous.pending;check();return result}finally{lease.release()}}
  const pending=(async()=>{
   try{
    await readAssistantVoiceContext(ports.owner,target,contextPorts,check);check()
    const transcript=await ports.speech.transcribe(bytes,'wav',currentSignal);check()
    await readAssistantVoiceContext(ports.owner,target,contextPorts,check);check()
    if(transcript&&transcript.audioSha256!==hash)throw new WorkError('teloa/invalid-host-response','转写与原音频不一致。')
    return readAssistantVoiceNoteResult({requestId:input.requestId,sessionId:input.sessionId,contextVersion:input.expectedContextVersion,text:transcript?.text??null})
   }finally{lease.release()}
  })()
  // 先固定尝试；未知或取消后不自动再次请求供应商，也不会产生一次模型输入。
  requests.set(input.requestId,{spec,pending})
  return pending
 }
}
