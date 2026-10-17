import test from 'node:test'
import assert from 'node:assert/strict'
import {VoiceCallService} from '../src/voice-call-service.ts'
import {VoiceTransportFailure,type VoiceTransportEvent,type VoiceTransportConnectInput} from '../src/voice-transport.ts'
import {WorkError} from '@teloa/contract'

const owner='owner',roleId='20000000-0000-4000-8000-000000000001'
const input={requestId:'10000000-0000-4000-8000-000000000001',roleId,expectedRoleVersion:1,sessionId:'role-session'}
function setup(speech=true,waiting?:Promise<void>){
 let receiver:VoiceTransportConnectInput|undefined,valid=true,fail=false,closes=0
 const queued:{utteranceId:string;text:string;callGeneration:string;playbackGeneration:number}[]=[]
 const service=new VoiceCallService({
  transport:{async readiness(){return {status:'ready',providerId:'test-speech'}},async connect(next){receiver=next;return {
   async close(){closes++},async interruptPlayback(){},
   ...(speech?{async enqueueSpeech(value:typeof queued[number]){queued.push(value);await waiting;if(fail)throw new VoiceTransportFailure('provider-unavailable')}}:{}),
  }}},
  async resolveContext(actor,request){if(request.target==='assistant')throw Error('此fixture仅模拟员工目标');return {context:{ownerId:actor,roleId:request.roleId,roleKind:'employee',roleVersion:1,sessionId:request.sessionId,scope:'general'},assertCurrent(){if(!valid)throw new WorkError('teloa/forbidden','身份已变化。')}}},
  async readTranscriptSeal(){return null},
 })
 return {service,queued,get closes(){return closes},emit:(event:VoiceTransportEvent)=>receiver?.onEvent(event),revoke(){valid=false},fail(){fail=true}}
}

test('播报回执不冒充可闻声音；插话后拒绝旧回复及播放事件，同一请求不重复播报',async()=>{
 const f=setup(),call=await f.service.start(owner,input)
 const request={callId:call.id,utteranceId:'reply-1',text:'你好。',expectedPlaybackGeneration:0}
 const queued=await f.service.enqueueSpeech(owner,request)
 assert.equal(queued.playback,'idle');assert.equal(queued.playbackGeneration,1)
 f.emit({type:'playback',callGeneration:call.callGeneration,playbackGeneration:1,state:'playing'})
 assert.equal(f.service.get(owner,{callId:call.id}).playback,'playing')
 await f.service.enqueueSpeech(owner,request);assert.equal(f.queued.length,1)
 const interrupted=await f.service.interrupt(owner,{callId:call.id});assert.equal(interrupted.playbackGeneration,2)
 f.emit({type:'playback',callGeneration:call.callGeneration,playbackGeneration:1,state:'playing'})
 assert.equal(f.service.get(owner,{callId:call.id}).playback,'idle')
 await assert.rejects(f.service.enqueueSpeech(owner,{...request,utteranceId:'late-reply'}),{code:'teloa/conflict'})
 await f.service.enqueueSpeech(owner,request);assert.equal(f.queued.length,1)
 await assert.rejects(f.service.enqueueSpeech(owner,{...request,text:'改写的回答。'}),{code:'teloa/conflict'})
})

test('缺少实际播报端口、跨本人、撤权或挂断不能播报，提供方错误只报告类别',async()=>{
 const absent=setup(false),noSpeech=await absent.service.start(owner,input)
 await assert.rejects(absent.service.enqueueSpeech(owner,{callId:noSpeech.id,utteranceId:'reply',text:'你好',expectedPlaybackGeneration:0}),{code:'teloa/unavailable'})
 const f=setup(),call=await f.service.start(owner,input),request={callId:call.id,utteranceId:'reply',text:'你好',expectedPlaybackGeneration:0}
 await assert.rejects(f.service.enqueueSpeech('other',request),{code:'teloa/forbidden'})
 f.revoke();await assert.rejects(f.service.enqueueSpeech(owner,request),{code:'teloa/forbidden'});assert.equal(f.queued.length,0)
 await f.service.end(owner,{callId:call.id});await assert.rejects(f.service.enqueueSpeech(owner,request),{code:'teloa/conflict'})
 const failed=setup(),active=await failed.service.start(owner,input);failed.fail()
 const result=await failed.service.enqueueSpeech(owner,{...request,callId:active.id})
 assert.equal(result.state,'failed');assert.equal(result.failure,'provider-unavailable')
})

test('等待播报期间本人插话，旧提供方拒绝只丢弃旧播报；当前世代真实错误仍结束媒体',async()=>{
 let release!:()=>void
 const waiting=new Promise<void>(resolve=>{release=resolve}),f=setup(true,waiting),call=await f.service.start(owner,input)
 f.fail()
 const speaking=f.service.enqueueSpeech(owner,{callId:call.id,utteranceId:'old-reply',text:'被插话的回答。',expectedPlaybackGeneration:0})
 assert.equal(f.queued.length,1)
 const interrupted=await f.service.interrupt(owner,{callId:call.id})
 assert.equal(interrupted.state,'connected');assert.equal(interrupted.playbackGeneration,2)
 release()
 const settled=await speaking
 assert.equal(settled.state,'connected');assert.equal(settled.failure,null);assert.equal(settled.playbackGeneration,2);assert.equal(f.closes,0)
 f.emit({type:'playback',callGeneration:call.callGeneration,playbackGeneration:1,state:'playing'})
 assert.equal(f.service.get(owner,{callId:call.id}).playback,'idle')
 const failed=await f.service.enqueueSpeech(owner,{callId:call.id,utteranceId:'current-reply',text:'当前回答。',expectedPlaybackGeneration:2})
 assert.equal(failed.state,'failed');assert.equal(failed.failure,'provider-unavailable');assert.equal(f.closes,1)
})
