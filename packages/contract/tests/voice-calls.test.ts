import test from 'node:test'
import assert from 'node:assert/strict'
import {readVoiceReadiness,voiceCallStartInput,readVoiceCallContext,readVoiceCall,readTranscriptCommit,readVoiceTranscriptSeal,voiceTranscriptCommitInput} from '../src/voice-calls.ts'
import * as voice from '../src/voice-calls.ts'

const requestId='10000000-0000-4000-8000-000000000001',roleId='20000000-0000-4000-8000-000000000001',callId='30000000-0000-4000-8000-000000000001',generation='40000000-0000-4000-8000-000000000001'
const context={ownerId:'owner',roleId,roleKind:'twin' as const,roleVersion:2,sessionId:'role-session',scope:'general'}
const source={kind:'sealed-audio-stt' as const,providerId:'local-stt',audioSha256:'a'.repeat(64),sealReceiptId:'seal-1',sttReceiptId:'stt-1'}
const seal={...context,callId,callGeneration:generation,turnId:'turn-1',speaker:'owner' as const,revision:2,text:'hello',closed:true as const,complete:true as const,source,producerReceipt:'receipt-1'}
const commit={id:'50000000-0000-4000-8000-000000000001',...seal,contentSha256:'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'}
const invalidInput={code:'teloa/invalid-input'},invalidHost={code:'teloa/invalid-host-response'}

test('个人助手语音目标只固定原general/null会话版本，不借员工或分身字段',()=>{
 const start={requestId,sessionId:'assistant-original',target:'assistant',expectedContextVersion:3}
 assert.deepEqual(voiceCallStartInput(start),start)
 const assistant={ownerId:'owner',sessionId:start.sessionId,scope:'general',target:'assistant',contextVersion:3}
 assert.deepEqual(readVoiceCallContext(assistant),assistant)
 const {roleId:oldRole,roleKind:oldKind,roleVersion:oldVersion,...withoutRole}=seal
 const assistantSeal={...withoutRole,...assistant}
 assert.deepEqual(readVoiceTranscriptSeal(assistantSeal),assistantSeal)
 for(const extra of [{roleId},{expectedRoleVersion:2},{scope:'research'},{ownerId:'other'}])assert.throws(()=>voiceCallStartInput({...start,...extra}),invalidInput)
 for(const extra of [{roleId},{roleKind:'twin'},{roleVersion:2},{scope:'research'},{contextVersion:0}])assert.throws(()=>readVoiceCallContext({...assistant,...extra}),invalidHost)
 assert.throws(()=>readVoiceTranscriptSeal({...assistantSeal,roleId:oldRole,roleKind:oldKind,roleVersion:oldVersion}),invalidHost)
})

test('就绪回包不把未配置或包含密钥的回包呈现成可通话',()=>{
 assert.deepEqual(readVoiceReadiness({status:'unavailable',providerId:null,reason:'provider-unconfigured'}),{status:'unavailable',providerId:null,reason:'provider-unconfigured'})
 assert.deepEqual(readVoiceReadiness({status:'ready',providerId:'voice-provider'}),{status:'ready',providerId:'voice-provider'})
 for(const row of [{status:'ready',providerId:null},{status:'ready',providerId:'voice-provider',apiKey:'private'},{status:'unavailable',providerId:null,reason:'raw provider exception'}])assert.throws(()=>readVoiceReadiness(row),invalidHost)
})

test('开始请求只允许本人意图字段，拒绝自报账号与授权范围',()=>{
 const input={requestId,roleId,expectedRoleVersion:2,sessionId:'role-session'}
 assert.deepEqual(voiceCallStartInput(input),input)
 for(const extra of [{ownerId:'other'},{scope:'all'},{callGeneration:generation}])assert.throws(()=>voiceCallStartInput({...input,...extra}),invalidInput)
 for(const changed of [{expectedRoleVersion:0},{expectedRoleVersion:1.5},{sessionId:'../session'},{requestId:'not-id'}])assert.throws(()=>voiceCallStartInput({...input,...changed}),invalidInput)
})

test('身份上下文拒绝非角色主体与非规范 scope，复制后冻结',()=>{
 const parsed=readVoiceCallContext(context)
 assert.deepEqual(parsed,context);assert.ok(Object.isFrozen(parsed))
 for(const changed of [{roleKind:'self'},{scope:'general\npermission'},{ownerId:''},{roleVersion:0},{rawPermissions:{all:true}}])assert.throws(()=>readVoiceCallContext({...context,...changed}),invalidHost)
})

test('通话状态不能把不可用、缺失终止时间或原始异常伪装为已连接',()=>{
 const row={id:callId,requestId,...context,callGeneration:generation,state:'connected',readiness:{status:'ready',providerId:'voice-provider'},playbackGeneration:0,playback:'idle',createdAt:'2026-10-09T00:00:00.000Z',endedAt:null,failure:null}
 assert.deepEqual(readVoiceCall(row),row)
 for(const changed of [{readiness:{status:'unavailable',providerId:null,reason:'provider-unconfigured'}},{state:'ended'},{failure:'api-key leaked'},{playbackGeneration:-1},{createdAt:'2026-10-09'}])assert.throws(()=>readVoiceCall({...row,...changed}),invalidHost)
})

test('完整转写须绑定封口和 STT 来源，delta 与委托元数据不是 commit',()=>{
 const parsed=readTranscriptCommit(commit)
 assert.deepEqual(parsed,commit);assert.ok(Object.isFrozen(parsed));assert.ok(Object.isFrozen(parsed.source))
 for(const changed of [{closed:false},{complete:false},{speaker:'assistant'},{revision:0},{contentSha256:'bad'},{source:{kind:'transcript-delta'}},{source:{kind:'delegation',id:'delegate-1'}},{extra:true}])assert.throws(()=>readTranscriptCommit({...commit,...changed}),invalidHost)
 assert.throws(()=>readVoiceTranscriptSeal({...seal,source:{...source,sttReceiptId:''}}),invalidHost)
 assert.throws(()=>readVoiceTranscriptSeal({...seal,source:{...source,sealReceiptId:''}}),invalidHost)
 assert.throws(()=>readVoiceTranscriptSeal({...seal,callGeneration:''}),invalidHost)
 assert.deepEqual(readVoiceTranscriptSeal(seal),seal)
})

test('消费封口请求只携带宿主回执引用，不能提交自报最终文字',()=>{
 const input={callId,turnId:'turn-1',revision:2,producerReceipt:'receipt-1'}
 assert.deepEqual(voiceTranscriptCommitInput(input),input)
 for(const changed of [{text:'forge'},{complete:true},{source},{revision:1.5},{producerReceipt:''}])assert.throws(()=>voiceTranscriptCommitInput({...input,...changed}),invalidInput)
})
test('按请求查询与取消采用严格本人意图和真实取消回执',()=>{
 assert.equal(typeof voice.voiceCallRequestInput,'function')
 assert.deepEqual(voice.voiceCallRequestInput({requestId}),{requestId})
 for(const bad of [{requestId,ownerId:'other'},{requestId,callId},{requestId:'bad-id'}])assert.throws(()=>voice.voiceCallRequestInput(bad),invalidInput)
 assert.equal(voice.readVoiceCallByRequest(null),null)
 const call=readVoiceCall({id:callId,requestId,...context,callGeneration:generation,state:'ended',readiness:{status:'ready',providerId:'voice-provider'},playbackGeneration:0,playback:'idle',createdAt:'2026-10-09T00:00:00.000Z',endedAt:'2026-10-09T00:01:00.000Z',failure:null})
 assert.deepEqual(voice.readVoiceCallByRequest(call),call)
 for(const value of [{requestId,cancelled:true,call:null},{requestId,cancelled:true,call}])assert.deepEqual(voice.readVoiceCallEndByRequestResult(value),value)
 for(const bad of [{requestId,cancelled:false,call:null},{requestId,cancelled:true,call:{...call,requestId:roleId}},{requestId,cancelled:true,call:{...call,state:'connected',endedAt:null}},{requestId,cancelled:true,call:null,approved:true}])assert.throws(()=>voice.readVoiceCallEndByRequestResult(bad),invalidHost)
 for(const endpoint of ['voice-calls/get-by-request','voice-calls/end-by-request','voice-calls/set-muted'])assert.ok((voice.voiceCallEndpoints as readonly string[]).includes(endpoint))
})
test('静音请求与回执只包含固定通话世代和布尔状态，不接受伪造权限或默认静音',()=>{
 assert.equal(typeof voice.voiceCallMutedInput,'function')
 for(const muted of [true,false]){
  const value={callId,callGeneration:generation,muted}
  assert.deepEqual(voice.voiceCallMutedInput(value),value);assert.deepEqual(voice.readVoiceCallMutedResult(value),value)
 }
 for(const bad of [{callId,callGeneration:generation},{callId,callGeneration:generation,muted:'true'},{callId,callGeneration:'bad-id',muted:true},{callId,callGeneration:generation,muted:true,ownerId:'other'}]){
  assert.throws(()=>voice.voiceCallMutedInput(bad),invalidInput);assert.throws(()=>voice.readVoiceCallMutedResult(bad),invalidHost)
 }
})
