import test from 'node:test'
import assert from 'node:assert/strict'
import {readVoiceCall} from '../src/voice-calls.ts'
let api:Record<string,any>={}
try{api=await import('../src/voice-call-progress.ts')}catch(error){if((error as NodeJS.ErrnoException).code!=='ERR_MODULE_NOT_FOUND')throw error}
const call=readVoiceCall({ownerId:'local:owner',roleId:'11111111-1111-4111-8111-111111111111',roleKind:'employee',roleVersion:3,sessionId:'session-test',scope:'current',id:'33333333-3333-4333-8333-333333333333',requestId:'22222222-2222-4222-8222-222222222222',callGeneration:'44444444-4444-4444-8444-444444444444',state:'connected',readiness:{status:'ready',providerId:'test-provider'},playbackGeneration:0,playback:'idle',createdAt:'2026-10-09T01:00:00.000Z',endedAt:null,failure:null})
assert.ok(call.target!=='assistant','旧fixture保持员工目标')
const commit={ownerId:call.ownerId,roleId:call.roleId,roleKind:call.roleKind,roleVersion:call.roleVersion,sessionId:call.sessionId,scope:call.scope,callId:call.id,callGeneration:call.callGeneration,turnId:'turn-1',speaker:'owner',source:{kind:'sealed-audio-stt',providerId:'test-provider',audioSha256:'a'.repeat(64),sealReceiptId:'seal:1',sttReceiptId:'stt:1'},revision:1,text:'核对项目',closed:true,complete:true,producerReceipt:'producer:1',id:'55555555-5555-4555-8555-555555555555',contentSha256:'b'.repeat(64)}
const progress={callId:call.id,callGeneration:call.callGeneration,sessionId:call.sessionId,transcripts:[commit],work:[{taskId:'66666666-6666-4666-8666-666666666666',title:'核对项目',status:'running'}]}
test('进度只接受固定通话的完整封口与真实Task状态，复制冻结且两集合有界',()=>{
 assert.equal(typeof api.readVoiceCallProgress,'function','须提供严格通话进度读器')
 const parsed=api.readVoiceCallProgress(progress,call);assert.deepEqual(parsed,progress);assert.ok(Object.isFrozen(parsed.transcripts));assert.ok(Object.isFrozen(parsed.work[0]))
 for(const patch of [{callId:call.roleId},{callGeneration:call.roleId},{sessionId:'another'},{transcripts:[{...commit,ownerId:'other'}]},{transcripts:[{...commit,roleVersion:4}]},{transcripts:[{...commit,scope:'all'}]},{transcripts:[{...commit,complete:false}]},{transcripts:[commit,commit]},{transcripts:Array(51).fill(commit)},{work:Array(51).fill(progress.work[0])},{work:[{...progress.work[0],status:'reply-completed'}]},{work:[{...progress.work[0],ownerId:'other'}]},{work:[progress.work[0],progress.work[0]]},{authority:'granted'}])assert.throws(()=>api.readVoiceCallProgress({...progress,...patch},call),{code:'teloa/invalid-host-response'})
 assert.throws(()=>api.readVoiceCallProgress({...progress,transcripts:[{...commit,callGeneration:call.roleId}]}),{code:'teloa/invalid-host-response'})
 let accessed=false;const getter={...commit};Object.defineProperty(getter,'text',{enumerable:true,get(){accessed=true;return '伪字段'}})
 assert.throws(()=>api.readVoiceCallProgress({...progress,transcripts:[getter]},call),{code:'teloa/invalid-host-response'});assert.equal(accessed,false)
})
