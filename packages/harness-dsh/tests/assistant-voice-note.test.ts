import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createAssistantVoiceNote} from '../src/assistant-voice-note.ts'
import {readAssistantVoiceContext} from '../src/voice-assistant-context.ts'
const owner='voice-note-owner',requestId='11111111-1111-4111-8111-111111111111',sessionId='assistant-original'
function fixture(){
 let count=0,valid=true,version=3,finish:(()=>void)|undefined
 const ports={owner,conversation:async()=>({id:'owned',ownerId:owner,sessionId,status:'ready' as const}),requestedRoleId:async()=>null,links:{bySession:async()=>[]},readHomeContext:async()=>({sessionId,scopeId:'general',roleId:null,version}),assistantEligible:async()=>true,
  capture:()=>({signal:new AbortController().signal,assertCurrent(){if(!valid)throw Error('invalidated')},release(){}}),
  speech:{async transcribe(bytes:Uint8Array,_format:'wav',signal:AbortSignal){count++;await new Promise<void>(resolve=>{finish=resolve});signal.throwIfAborted();return {text:'本人需要编辑的草稿',audioSha256:createHash('sha256').update(bytes).digest('hex'),receiptId:'fixture-stt'}},async speak(){throw Error('留言不能TTS或派发模型')}}}
 const audio=Buffer.alloc(44);audio.write('RIFF');audio.write('WAVE',8)
 const handle=createAssistantVoiceNote(ports),input={requestId,sessionId,expectedContextVersion:3,audio:audio.toString('base64')}
 return {handle,input,ports,complete:()=>finish!(),revoke:()=>{valid=false},changeContext:()=>{version++},get count(){return count}}
}
test('正式目录登记 purpose=assistant 的原主聊可以进入语音上下文',async()=>{
 const f=fixture()
 const context=await readAssistantVoiceContext(owner,{target:'assistant',requestId,sessionId,expectedContextVersion:3},{readConversation:async()=>({...await f.ports.conversation(),purpose:'assistant'}),readRequestedRoleId:f.ports.requestedRoleId,links:f.ports.links,readHomeContext:f.ports.readHomeContext,assistantEligible:f.ports.assistantEligible},()=>{})
 assert.equal(context.target,'assistant')
})
test('留言ASR仅返回原助手草稿，同请求并发及丢回包只转写一次',async()=>{
 const f=fixture(),signal=new AbortController().signal,first=f.handle(f.input,signal),second=f.handle(f.input,signal)
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.count,1);f.complete()
 const result=await first;assert.deepEqual(result,{requestId,sessionId,contextVersion:3,text:'本人需要编辑的草稿'});assert.deepEqual(await second,result);assert.deepEqual(await f.handle(f.input,signal),result);assert.equal(f.count,1)
 await assert.rejects(f.handle({...f.input,audio:Buffer.alloc(44).toString('base64')},signal))
 await assert.rejects(f.handle({...f.input,sessionId:'other'},signal),{code:'teloa/conflict'})
})
test('取消、上下文变化和迟到ASR均不返回可插入文本，不接受自报文字或员工字段',async()=>{
 for(const action of ['cancel','revoke','context'] as const){const f=fixture(),cancel=new AbortController(),pending=f.handle(f.input,cancel.signal);await new Promise<void>(resolve=>setImmediate(resolve));if(action==='cancel')cancel.abort();else if(action==='revoke')f.revoke();else f.changeContext();f.complete();await assert.rejects(pending)}
 const f=fixture();for(const extra of [{text:'fake'},{roleId:'fake'},{scope:'all'},{target:'role'}])await assert.rejects(f.handle({...f.input,...extra},new AbortController().signal));assert.equal(f.count,0)
})
