import test from 'node:test'
import assert from 'node:assert/strict'
import {createUnavailableVoiceTransport,VoiceTransportFailure,sanitizeVoiceFailure} from '../src/voice-transport.ts'

test('未配置传输明确不可用，connect 不创建假连接',async()=>{
 const transport=createUnavailableVoiceTransport()
 assert.deepEqual(await transport.readiness(),{status:'unavailable',providerId:null,reason:'provider-unconfigured'})
 await assert.rejects(()=>transport.connect({callId:'call',callGeneration:'generation',roleContext:{ownerId:'owner',roleId:'role',roleKind:'employee',roleVersion:1,sessionId:'session',scope:'general'},signal:new AbortController().signal,onEvent(){}}),{code:'teloa/unavailable'})
})

test('传输错误只向状态机暴露受限错误类别，原始凭据异常不外泄',()=>{
 assert.equal(sanitizeVoiceFailure(new Error('api_key=private; sdp=private')),'connection-failed')
 assert.equal(sanitizeVoiceFailure(new VoiceTransportFailure('microphone-denied')),'microphone-denied')
 assert.throws(()=>new VoiceTransportFailure('private-provider-error' as never),{code:'teloa/invalid-host-response'})
})
