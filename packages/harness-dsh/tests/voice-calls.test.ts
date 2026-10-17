import test from 'node:test'
import assert from 'node:assert/strict'
import {readVoiceCall,type VoiceCall} from '@teloa/contract'
import {VoiceCallService} from '../src/voice-call-service.ts'

let feature:Record<string,any>={}
try{feature=await import('../src/voice-calls.ts')}catch(error){if((error as NodeJS.ErrnoException).code!=='ERR_MODULE_NOT_FOUND')throw error}
const owner='owner',requestId='10000000-0000-4000-8000-000000000001',roleId='20000000-0000-4000-8000-000000000001',callId='30000000-0000-4000-8000-000000000001',generation='40000000-0000-4000-8000-000000000001'
const input={requestId,roleId,expectedRoleVersion:2,sessionId:'role-session'},time='2026-10-09T00:00:00.000Z'
const call=readVoiceCall({id:callId,requestId,ownerId:owner,roleId,roleKind:'employee',roleVersion:2,sessionId:input.sessionId,scope:'general',callGeneration:generation,state:'connected',readiness:{status:'ready',providerId:'voice-relay'},playbackGeneration:0,playback:'idle',createdAt:time,endedAt:null,failure:null})
const ended=readVoiceCall({...call,state:'ended',endedAt:time})
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}

test('八个本人端口固定owner并严格派发，未知接口与外来身份载荷不进入服务',async()=>{
 assert.equal(typeof feature.createVoiceCallHandler,'function','本人通话RPC适配尚未实现')
 const calls:unknown[][]=[],record=(name:string,...args:unknown[])=>{calls.push([name,...args])}
 const service={
  async readiness(){record('readiness');return call.readiness},async start(...args:unknown[]){record('start',...args);return call},get(...args:unknown[]){record('get',...args);return call},
  async end(...args:unknown[]){record('end',...args);return ended},async interrupt(...args:unknown[]){record('interrupt',...args);return call},getByRequest(...args:unknown[]){record('getByRequest',...args);return null},
  async endByRequest(...args:unknown[]){record('endByRequest',...args);return {requestId,cancelled:true,call:null}},async setMuted(...args:unknown[]){record('setMuted',...args);return args[1]},
 }
 const handler=feature.createVoiceCallHandler(owner,service),muted={callId,callGeneration:generation,muted:true}
 const cases:[string,unknown,string,unknown][]=[['readiness',{},'readiness',call.readiness],['start',input,'start',call],['get',{callId},'get',call],['end',{callId},'end',ended],['interrupt',{callId},'interrupt',call],['get-by-request',{requestId},'getByRequest',null],['end-by-request',{requestId},'endByRequest',{requestId,cancelled:true,call:null}],['set-muted',muted,'setMuted',muted]]
 assert.equal(feature.voiceCallEndpoints.length,8)
 for(const [endpoint,payload,method,expected] of cases){
  assert.deepEqual(await handler('voice-calls/'+endpoint,payload),expected)
  assert.deepEqual(calls.at(-1),method==='readiness'?[method]:[method,owner,payload])
 }
 await assert.rejects(handler('voice-calls/tool-stop',{}),{code:'teloa/not-found'})
 await assert.rejects(handler('voice-calls/start',{...input,ownerId:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('voice-calls/start',{roleId,expectedRoleVersion:2,sessionId:input.sessionId}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('voice-calls/readiness',{apiKey:'private'}),{code:'teloa/invalid-input'})
 assert.equal(calls.length,8)
 const malformed=feature.createVoiceCallHandler(owner,{...service,get:()=>({...call,credentials:'private'})})
 await assert.rejects(malformed('voice-calls/get',{callId}),{code:'teloa/invalid-host-response'})
})

test('原request纯查询不start，已取消信号不准入普通查询或开始',async()=>{
 assert.equal(typeof feature.createVoiceCallHandler,'function')
 let connectCount=0,admissions=0
 const service=new VoiceCallService({transport:{async readiness(){return call.readiness},async connect(){connectCount++;return {async close(){},async interruptPlayback(){}}}},async resolveContext(){admissions++;return {context:{ownerId:owner,roleId,roleKind:'employee',roleVersion:2,sessionId:input.sessionId,scope:'general'},assertCurrent(){}}},async readTranscriptSeal(){return null}})
 const handler=feature.createVoiceCallHandler(owner,service),controller=new AbortController()
 assert.equal(await handler('voice-calls/get-by-request',{requestId}),null)
 assert.deepEqual(await handler('voice-calls/readiness',{}),call.readiness)
 assert.equal(admissions,0);assert.equal(connectCount,0)
 controller.abort()
 await assert.rejects(handler('voice-calls/get-by-request',{requestId},controller.signal),{name:'AbortError'})
 await assert.rejects(handler('voice-calls/start',input,controller.signal),{name:'AbortError'})
 assert.equal(admissions,0);assert.equal(connectCount,0)
})

test('start回执取消后可按原request找回并关闭，end不因abort或撤权假装未执行',async()=>{
 assert.equal(typeof feature.createVoiceCallHandler,'function')
 const entered=deferred<void>(),connection=deferred<{close:()=>Promise<void>;interruptPlayback:()=>Promise<void>}>(),controller=new AbortController()
 let closes=0,valid=true
 const media={async close(){closes++},async interruptPlayback(){}}
 const service=new VoiceCallService({transport:{async readiness(){return call.readiness},async connect(){entered.resolve();return connection.promise}},async resolveContext(){return {context:{ownerId:owner,roleId,roleKind:'employee',roleVersion:2,sessionId:input.sessionId,scope:'general'},assertCurrent(){if(!valid)throw Error('authorization changed')}}},async readTranscriptSeal(){return null}})
 const handler=feature.createVoiceCallHandler(owner,service),pending=handler('voice-calls/start',input,controller.signal),rejected=assert.rejects(pending,{name:'AbortError'})
 await entered.promise;controller.abort();connection.resolve(media);await rejected
 const recovered=await handler('voice-calls/get-by-request',{requestId}) as VoiceCall
 assert.equal(recovered.state,'connected');assert.equal(recovered.requestId,requestId)
 valid=false
 const result=await handler('voice-calls/end-by-request',{requestId},controller.signal)
 assert.equal(result.call.id,recovered.id);assert.equal(result.call.state,'ended');assert.equal(closes,1)
 assert.deepEqual(await handler('voice-calls/end',{callId:recovered.id},controller.signal),result.call)
 assert.equal(closes,1)
})
