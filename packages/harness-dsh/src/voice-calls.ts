import {WorkError,voiceCallMatchesStart,voiceCallEndpoints,voiceCallStartInput,voiceCallIdInput,voiceCallRequestInput,voiceCallMutedInput,readVoiceReadiness,readVoiceCall,readVoiceCallByRequest,readVoiceCallEndByRequestResult,readVoiceCallMutedResult,type VoiceCall} from '@teloa/contract'
import type {VoiceCallService} from './voice-call-service.ts'

export {voiceCallEndpoints}
type VoiceCallRpcService=Pick<VoiceCallService,'readiness'|'start'|'get'|'end'|'interrupt'|'getByRequest'|'endByRequest'|'setMuted'>
const badResponse=()=>new WorkError('teloa/invalid-host-response','通话回包与本人原请求不一致。')
const terminal=(call:VoiceCall)=>call.state==='ended'||call.state==='failed'

/** 仅装配已认证的本人 RPC；没有模型工具、IM 调用面或 Task stop 能力。 */
export function createVoiceCallHandler(owner:string,service:VoiceCallRpcService){
 const boundCall=(value:unknown,matches:(call:VoiceCall)=>boolean):VoiceCall=>{
  const call=readVoiceCall(value)
  if(call.ownerId!==owner||!matches(call))throw badResponse()
  return call
 }
 return async(endpoint:string,payload:unknown,signal?:AbortSignal)=>{
  if(!(voiceCallEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此本人通话接口。')
  const closing=endpoint==='voice-calls/end'||endpoint==='voice-calls/end-by-request'
  // 媒体关闭不消费执行许可；RPC 超时或取消不能阻止收尾，也不能覆盖已完成的真实回执。
  if(!closing)signal?.throwIfAborted()
  let value
  if(endpoint==='voice-calls/readiness'){
   if(!payload||typeof payload!=='object'||Array.isArray(payload)||(Object.getPrototypeOf(payload)!==Object.prototype&&Object.getPrototypeOf(payload)!==null)||Object.keys(payload).length!==0)throw new WorkError('teloa/invalid-input','通话就绪请求只接受空对象。')
   value=readVoiceReadiness(await service.readiness())
  }else if(endpoint==='voice-calls/start'){
   const input=voiceCallStartInput(payload)
   value=boundCall(await service.start(owner,input),call=>call.requestId===input.requestId&&voiceCallMatchesStart(call,input))
  }else if(endpoint==='voice-calls/get-by-request'){
   const input=voiceCallRequestInput(payload),call=readVoiceCallByRequest(service.getByRequest(owner,input))
   value=call===null?null:boundCall(call,item=>item.requestId===input.requestId)
  }else if(endpoint==='voice-calls/end-by-request'){
   const input=voiceCallRequestInput(payload),result=readVoiceCallEndByRequestResult(await service.endByRequest(owner,input))
   if(result.requestId!==input.requestId||result.call&&result.call.ownerId!==owner)throw badResponse()
   value=result
  }else if(endpoint==='voice-calls/set-muted'){
   const input=voiceCallMutedInput(payload),result=readVoiceCallMutedResult(await service.setMuted(owner,input))
   if(result.callId!==input.callId||result.callGeneration!==input.callGeneration||result.muted!==input.muted)throw badResponse()
   value=result
  }else{
   const input=voiceCallIdInput(payload),result=endpoint==='voice-calls/get'?service.get(owner,input):endpoint==='voice-calls/end'?await service.end(owner,input):await service.interrupt(owner,input)
   value=boundCall(result,call=>call.id===input.callId&&(!closing||terminal(call)))
  }
  if(!closing)signal?.throwIfAborted()
  return value
 }
}
