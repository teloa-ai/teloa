import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {createUserMessage,type GenerateOptions} from '@deepseek-ai/dsh-llm'
import {renderContextSnapshot,type PromptAssembly} from '@deepseek-ai/dsh-system-prompt'
import type {Conversation,VoiceCall} from '@teloa/contract'
import {createBrowserVoiceHost} from '../src/browser-voice-host.ts'
import type {VoiceMediaSnapshot} from '../src/voice-media-registry.ts'
import {HotAdapter,hotGate,nativeHotCausalityFixture,textAnswer} from './fixtures/native-hot-causality.ts'
import {nativeProviderFixture} from './fixtures/native-input-provider.ts'
import {installNativeSessionController} from './fixtures/native-host-services.ts'
import {TeloaNativeInput} from '../src/native-input-provider.ts'
import type {VoiceSpeech} from '../src/voice-service.ts'

/** 正式浏览器媒体/宿主/Controller/NativeInput/Loop；仅替代语音供应商、模型及本人目录端口。 */
async function mediaHost(t:TestContext){
 const f=await nativeProviderFixture(t,{maintenance:false,persistence:true}),owner=randomUUID(),model=new HotAdapter()
 f.ctx.llm.registerAdapter(['test'],model)
 await f.ctx.plugin(TeloaNativeInput);await installNativeSessionController(f.ctx,{nativeOpen:false})
 const counts={transcribe:0,speak:0},controls:{asr?:ReturnType<typeof hotGate>;tts?:ReturnType<typeof hotGate>;silence?:boolean}={}
 const speech:VoiceSpeech={async transcribe(audio){counts.transcribe++;await controls.asr?.wait();return controls.silence?null:{text:'核对原会话的资料。',audioSha256:createHash('sha256').update(audio).digest('hex'),receiptId:'synthetic-stt-receipt',providerId:'minimax'}},async speak(_text,_signal,onAudio){counts.speak++;await controls.tts?.wait();await onAudio(new Uint8Array([255,251,1,2]))}}
 const host=createBrowserVoiceHost(f.ctx,{owner,configured:async()=>true,speech,conversation:async sessionId=>({id:'owned-'+sessionId,ownerId:owner,title:'本人原会话',scopeIds:['general'],version:1,status:'ready',requestedSessionId:sessionId,sessionId,createdAt:'2026-10-16T00:00:00Z',purpose:'assistant'}),requestedRoleId:async()=>null,role:async()=>null,links:{bySession:async()=>[]},readHomeContext:async sessionId=>({sessionId,scopeId:'general',roleId:null,version:3}),assistantEligible:async()=>true})
 let bound:{callId:string;callGeneration:string;token:string}|undefined
 t.after(async()=>{controls.asr?.release();controls.tts?.release();if(bound)await host.handler('voice-calls/media-closed',bound).catch(()=>{});await host.dispose()})
 const requestId=randomUUID(),pending=host.handler('voice-calls/start',{requestId,target:'assistant',expectedContextVersion:3,sessionId:String(f.agent.id)}) as Promise<VoiceCall>
 void pending.catch(()=>{})
 let call:VoiceCall|null=null,snapshot:VoiceMediaSnapshot|null=null
 for(let attempt=0;attempt<100&&!snapshot;attempt++){
  await new Promise<void>(resolve=>setImmediate(resolve));call=await host.handler('voice-calls/get-by-request',{requestId}) as VoiceCall|null
  if(call)snapshot=await host.handler('voice-calls/media',{callId:call.id,callGeneration:call.callGeneration}) as VoiceMediaSnapshot|null
 }
 assert.ok(call&&snapshot,'正式媒体必须建立可握手的预约')
 bound={callId:call.id,callGeneration:call.callGeneration,token:snapshot.token};await host.handler('voice-calls/media-ready',bound);call=await pending
 const identity={callId:call.id,callGeneration:call.callGeneration}
 return {...f,host,model,counts,controls,call,bound,identity,
  audio:()=>({...bound,turnId:randomUUID(),audio:Buffer.from('synthetic-wave').toString('base64')}),
  snapshot:()=>host.handler('voice-calls/media',identity) as Promise<VoiceMediaSnapshot>,
  current:()=>host.handler('voice-calls/get',{callId:call.id}) as Promise<VoiceCall>,
  async close(){await host.handler('voice-calls/media-closed',bound);return host.handler('voice-calls/end',{callId:call.id})},
 }
}

type AudioReceipt={text:string|null;receipt:null|{state:string;commitId:string;sessionId:string}}
type TurnReceipt={state:string;speech:string;replyExpected:boolean;reason:string|null}
async function settledVoiceTurn(f:Awaited<ReturnType<typeof mediaHost>>,commitId:string){
 let value!:TurnReceipt
 for(let attempt=0;attempt<100;attempt++){
  value=await f.host.handler('voice-calls/turn',{callId:f.call.id,commitId}) as TurnReceipt
  if(value.state==='ended'&&value.speech!=='not-ready')return value
  await new Promise<void>(resolve=>setImmediate(resolve))
 }
 assert.fail('原语音轮次没有收口：'+JSON.stringify(value))
}

test('E07：宿主audio经封口和正式Controller只派发一次，turn纯读、播放回执按原世代生效',{timeout:30000},async t=>{
 const f=await mediaHost(t),input=f.audio()
 for(const bad of [{...input,token:randomUUID()},{...input,callGeneration:randomUUID()},{...input,text:'页面伪造转写'}])await assert.rejects(f.host.handler('voice-calls/audio',bad))
 assert.equal(f.counts.transcribe,0);assert.equal(f.model.requests.length,0)
 f.controls.silence=true
 assert.deepEqual(await f.host.handler('voice-calls/audio',f.audio()),{text:null,receipt:null});assert.equal(f.model.requests.length,0)
 f.controls.silence=false;f.model.scripts.push(textAnswer)
 const [first,duplicate]=await Promise.all([f.host.handler('voice-calls/audio',input),f.host.handler('voice-calls/audio',input)]) as AudioReceipt[]
 assert.ok(first?.receipt&&duplicate?.receipt);assert.equal(first.text,'核对原会话的资料。');assert.equal(first.receipt.sessionId,String(f.agent.id));assert.equal(first.receipt.commitId,duplicate.receipt.commitId)
 await f.agent.whenIdle()
 const result=await settledVoiceTurn(f,first.receipt.commitId)
 assert.deepEqual(result,{state:'ended',speech:'queued',replyExpected:true,reason:'completed'})
 assert.equal(f.counts.transcribe,2);assert.equal(f.counts.speak,1);assert.equal(f.model.requests.length,1)
 const messages=f.agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.source.kind==='user')
 assert.equal(messages.length,1);const user=messages[0];assert.ok(user?.type==='user/message');assert.deepEqual(user.data.content,[{type:'text',text:first.text}]);assert.equal(f.other.session.snapshotEvents().filter(event=>event.type==='user/message').length,0)
 const events=f.agent.session.snapshotEvents()
 for(let i=0;i<3;i++)assert.deepEqual(await f.host.handler('voice-calls/turn',{callId:f.call.id,commitId:first.receipt.commitId}),result)
 await assert.rejects(f.host.handler('voice-calls/turn',{callId:f.call.id,commitId:randomUUID()}))
 await assert.rejects(f.host.handler('voice-calls/turn',{callId:f.call.id,commitId:first.receipt.commitId,sessionId:String(f.other.id)}))
 await assert.rejects(f.host.handler('voice-calls/audio',{...input,audio:Buffer.from('changed-wave').toString('base64')}))
 assert.deepEqual(f.agent.session.snapshotEvents(),events);assert.equal(f.model.requests.length,1);assert.equal(f.counts.speak,1)
 const media=await f.snapshot();assert.ok(media.speech);assert.equal((await f.current()).playback,'idle')
 const playback={...f.bound,playbackGeneration:media.playbackGeneration,state:'playing'}
 await assert.rejects(f.host.handler('voice-calls/playback',{...playback,token:randomUUID()}))
 await f.host.handler('voice-calls/playback',{...playback,playbackGeneration:media.playbackGeneration-1});assert.equal((await f.current()).playback,'idle')
 assert.deepEqual(await f.host.handler('voice-calls/playback',playback),{accepted:true});assert.equal((await f.current()).playback,'playing')
 await f.host.handler('voice-calls/interrupt',{callId:f.call.id});await f.host.handler('voice-calls/playback',playback)
 assert.equal((await f.current()).playback,'idle');assert.equal((await f.snapshot()).speech,null)
 await f.close();await assert.rejects(f.host.handler('voice-calls/playback',playback));await assert.rejects(f.host.handler('voice-calls/audio',f.audio()))
 assert.equal((await f.current()).state,'ended');assert.equal(f.model.requests.length,1)
})

test('生成回答时的第二句语音排入原会话下一轮，不改写当前轮受理根', {timeout:30000},async t=>{
 const f=await mediaHost(t),gate=hotGate();t.after(gate.release)
 f.model.prepareGate=gate;f.model.scripts.push(textAnswer,textAnswer)
 const first=await f.host.handler('voice-calls/audio',f.audio()) as AudioReceipt;assert.ok(first.receipt)
 await gate.entered
 await f.host.handler('voice-calls/interrupt',{callId:f.call.id})
 const second=await f.host.handler('voice-calls/audio',f.audio()) as AudioReceipt;assert.ok(second.receipt)
 assert.notEqual(first.receipt.commitId,second.receipt.commitId)
 assert.ok(f.agent.inbox.nextTurn.some(message=>message.source.kind==='user'&&'rpcId'in message.source&&message.source.rpcId===second.receipt!.commitId),'新语音必须等待下一轮，不能作为steer改写当前轮')
 gate.release();await f.agent.whenIdle()
 const events=f.agent.session.snapshotEvents(),ends=events.filter(event=>event.type==='turn/end')
 assert.equal(ends.length,2);assert.ok(ends.every(event=>event.type==='turn/end'&&event.data.reason.kind==='completed'))
 const inputs=events.filter(event=>event.type==='user/message'&&event.data.source.kind==='user')
 assert.equal(inputs.length,2);assert.equal(f.model.requests.length,2)
})

for(const action of ['hangup','revoke'] as const)test(`E07：ASR忽略取消迟答，${action}后不能封口或提交原会话`,{timeout:30000},async t=>{
 const f=await mediaHost(t),gate=hotGate();f.controls.asr=gate;t.after(gate.release)
 const before=f.agent.session.snapshotEvents(),pending=f.host.handler('voice-calls/audio',f.audio());void pending.catch(()=>{})
 await gate.entered
 if(action==='hangup')await f.close();else{f.host.invalidateSession(String(f.agent.id));await f.host.handler('voice-calls/media-closed',f.bound)}
 gate.release();await assert.rejects(pending)
 assert.deepEqual(f.agent.session.snapshotEvents(),before);assert.equal(f.model.requests.length,0);assert.equal(f.counts.speak,0);assert.equal((await f.snapshot()).speech,null)
})

test('E07：挂断后迟到TTS不能重新发布音频；已受理工作保留完成且轮询不重发',{timeout:30000},async t=>{
 const f=await mediaHost(t),gate=hotGate();f.controls.tts=gate;t.after(gate.release);f.model.scripts.push(textAnswer)
 const result=await f.host.handler('voice-calls/audio',f.audio()) as AudioReceipt;assert.ok(result.receipt)
 await gate.entered;await f.agent.whenIdle();await f.close();gate.release()
 const receipt=await settledVoiceTurn(f,result.receipt.commitId)
 assert.equal(receipt.state,'ended');assert.equal(receipt.reason,'completed');assert.notEqual(receipt.speech,'queued')
 assert.equal((await f.snapshot()).speech,null);assert.equal((await f.current()).state,'ended');assert.equal(f.model.requests.length,1);assert.equal(f.counts.speak,1)
 await f.host.handler('voice-calls/turn',{callId:f.call.id,commitId:result.receipt.commitId});assert.equal(f.model.requests.length,1);assert.equal(f.counts.speak,1)
})

async function fixture(t:TestContext,connecting=false,legacy=false){
 const f=await nativeHotCausalityFixture(t),owner=randomUUID(),gate=hotGate()
 t.after(gate.release)
 // 本批直接输入走真实 NativeInput/Loop；不使用 Controller 的 inspect 或 prompt 端口。
 f.ctx.provide('sessionController',{} as never)
 const ports={
  owner,configured:async()=>true,
  speech:{async transcribe(){throw Error('本批不请求真实 ASR')},async speak(){throw Error('文字输入不应触发 TTS')}},
  conversation:async(sessionId:string)=>({id:'owned-'+sessionId,ownerId:owner,title:'本人原会话',scopeIds:['general'],version:1,status:'ready',requestedSessionId:sessionId,sessionId,createdAt:'2026-10-16T00:00:00Z',purpose:'assistant'} satisfies Conversation),
  requestedRoleId:async()=>null,role:async()=>null,links:{bySession:async()=>[]},
  readHomeContext:async(sessionId:string)=>({sessionId,scopeId:'general',roleId:null,version:3}),assistantEligible:async()=>true,
 }
 const host=createBrowserVoiceHost(f.ctx,ports)
 t.after(()=>host.dispose())
 const attach=(host:ReturnType<typeof createBrowserVoiceHost>)=>host.plugin.attach({
  transport:{async readiness(){return {status:'ready',providerId:'fixture-media'}},async connect(){if(connecting)await gate.wait();return {async close(){},async interruptPlayback(){},async enqueueSpeech(){throw Error('未受理语音轮次不能播报')}}}},
  snapshot:()=>null,ready(){},closed(){},playback(){},async transcribe(){return null},async readTranscriptSeal(){return null},inactiveCalls:()=>[],dispose(){},
 })
 if(!legacy)attach(host)
 const assemble=(agent=f.agent)=>f.ctx.systemPrompt.assemble({agent,scope:agent})
 const start=(target=host)=>target.handler('voice-calls/start',{requestId:randomUUID(),target:'assistant',expectedContextVersion:3,sessionId:String(f.agent.id)}) as Promise<VoiceCall>
 const send=async(text:string,agent=f.agent)=>{
  f.adapter.scripts.push(textAnswer)
  const rpcId=randomUUID(),message=createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text}]})
  await f.work.withNewInput(agent,message,{producer:'prompt',identity:rpcId},()=>agent.followup(message));await agent.whenIdle()
  return f.adapter.requests.at(-1)!
 }
 return {...f,host,ports,attach,gate,assemble,start,send}
}

function facts(assembly:PromptAssembly){
 const context=assembly.contexts.find(row=>row.name==='teloa:voice-call')
 assert.ok(context?.text,'原模型缺少真实宿主通话上下文')
 return JSON.parse(context.text.split('\n').at(-1)!)
}
function latestRuntime(request:GenerateOptions){
 const message=[...request.messages].reverse().find(row=>row.source?.kind==='runtime-context')
 return message?.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')??''
}

test('已接通的宿主事实进入原模型，真实用户原文和原会话保持不变',async t=>{
 const f=await fixture(t),call=await f.start(),before=f.agent
 const assembly=await f.assemble()
 assert.deepEqual(facts(assembly),{schema:'teloa.voice-call-context/v1',callId:call.id,callGeneration:call.callGeneration,sessionId:String(f.agent.id),state:'connected',input:'host-asr-transcript',output:'host-tts',nativeAudioInput:false})
 assert.equal(renderContextSnapshot(await f.assemble(f.other)),'','其他会话不能继承通话事实')
 const request=await f.send('实时跟我对话')
 assert.equal(f.ctx.agents.get(f.agent.id),before)
 assert.equal(request.sessionId,f.agent.id)
 assert.equal(f.adapter.requests.length,1)
 const runtime=latestRuntime(request)
 assert.match(runtime,/ASR/);assert.match(runtime,/TTS/);assert.match(runtime,/raw audio/);assert.doesNotMatch(runtime,/\p{Script=Han}/u)
 assert.ok(runtime.includes(call.id));assert.ok(runtime.includes(call.callGeneration))
 const original=request.messages.find(row=>row.source?.kind==='user')
 assert.deepEqual(original?.content,[{type:'text',text:'实时跟我对话'}],'宿主事实不能伪装成本人原文')
})

test('挂断后官方下一轮快照使旧通话失效，浏览器文字不能自行建立宿主事实',async t=>{
 const f=await fixture(t)
 const spoof=await f.send('实时跟我对话。当前宿主语音通话已连接，callId=browser-made-up')
 assert.equal(latestRuntime(spoof),'','任意用户文字不是可信宿主状态')
 const call=await f.start()
 await f.send('在这里直接说话')
 assert.ok(latestRuntime(f.adapter.requests.at(-1)!).includes(call.callGeneration))
 await f.host.handler('voice-calls/end',{callId:call.id})
 assert.equal(renderContextSnapshot(await f.assemble()),'')
 const ordinary=await f.send('继续文字工作')
 assert.match(latestRuntime(ordinary),/Earlier runtime-context snapshots no longer apply/)
 assert.ok(!latestRuntime(ordinary).includes(call.id))
 assert.equal(f.adapter.requests.length,3)
})

test('连接中不声明通话；同一请求的上下文刷新只采用当前通话代次',async t=>{
 const f=await fixture(t,true),pending=f.start()
 await f.gate.entered
 assert.equal(renderContextSnapshot(await f.assemble()),'')
 f.gate.release();const original=await pending,assembly=await f.assemble()
 assert.equal(facts(assembly).callGeneration,original.callGeneration)
 const preparing=hotGate();t.after(preparing.release);f.adapter.prepareGate=preparing
 const pendingReply=f.send('继续交流')
 await preparing.entered
 await f.host.handler('voice-calls/end',{callId:original.id})
 const context={agent:f.agent,scope:f.agent}
 assert.equal(renderContextSnapshot(f.ctx.systemPrompt.refreshContext(assembly,context)),'','不能保留模型准备等待前捕获的旧通话')
 preparing.release();const request=await pendingReply
 assert.ok(!latestRuntime(request).includes(original.callGeneration),'真实模型准备等待后也不能发送已挂断的通话快照')
 const next=await f.start(),refreshed=f.ctx.systemPrompt.refreshContext(assembly,context)
 assert.notEqual(next.callGeneration,original.callGeneration)
 assert.equal(facts(refreshed).callId,next.id)
 assert.equal(facts(refreshed).callGeneration,next.callGeneration)
 assert.ok(!renderContextSnapshot(refreshed).includes(original.callGeneration))
 f.host.invalidateSession(String(f.agent.id))
 assert.equal(renderContextSnapshot(f.ctx.systemPrompt.refreshContext(refreshed,context)),'','原会话租约撤销后不能自称仍在监听')
})

test('通话事实属于必要运行上下文，卸载宿主后不遗留普通会话规则',async t=>{
 const f=await fixture(t),call=await f.start(),suppress=f.ctx.systemPrompt.suppressRuntimeContext()
 t.after(suppress)
 assert.equal(facts(await f.assemble()).callId,call.id)
 await f.host.dispose()
 assert.equal(renderContextSnapshot(await f.assemble()),'')
})

test('宿主在模型准备等待期间卸载，在途普通输入不能派发已关闭的通话事实',async t=>{
 const f=await fixture(t),call=await f.start(),preparing=hotGate()
 t.after(preparing.release);f.adapter.prepareGate=preparing
 const pending=f.send('继续原会话的工作')
 await preparing.entered
 await f.host.dispose()
 preparing.release();const request=await pending
 assert.equal(f.adapter.requests.length,1,'关闭媒体不撤销已受理的普通文字工作')
 assert.ok(!latestRuntime(request).includes(call.callGeneration),'不能派发卸载前接受但已失效的通话代次')
 assert.ok(!latestRuntime(request).includes(call.id),'不能派发已关闭通话的 connected 事实')
})

test('同一运行上下文可重建通话宿主，旧宿主迟到清理不能撤销新宿主事实',async t=>{
 const f=await fixture(t),original=await f.start(),assembly=await f.assemble()
 await f.host.dispose()
 const next=createBrowserVoiceHost(f.ctx,f.ports);t.after(()=>next.dispose());f.attach(next)
 const call=await f.start(next)
 await f.host.dispose()
 assert.equal(facts(await f.assemble()).callGeneration,call.callGeneration)
 const refreshed=f.ctx.systemPrompt.refreshContext(assembly,{agent:f.agent,scope:f.agent})
 assert.equal(facts(refreshed).callId,call.id)
 assert.ok(!renderContextSnapshot(refreshed).includes(original.callGeneration))
})

test('真实媒体已关闭而结束RPC丢失，不再向模型声明持续采音',async t=>{
 const f=await fixture(t,false,true),requestId=randomUUID()
 const pending=f.host.handler('voice-calls/start',{requestId,target:'assistant',expectedContextVersion:3,sessionId:String(f.agent.id)}) as Promise<VoiceCall>
 let call:VoiceCall|null=null,snapshot:VoiceMediaSnapshot|null=null
 for(let count=0;count<30&&!snapshot;count++){
  await new Promise<void>(resolve=>setImmediate(resolve))
  call=await f.host.handler('voice-calls/get-by-request',{requestId}) as VoiceCall|null
  if(call)snapshot=await f.host.handler('voice-calls/media',{callId:call.id,callGeneration:call.callGeneration}) as VoiceMediaSnapshot|null
 }
 assert.ok(call&&snapshot,'真实媒体必须已建立原通话预约')
 const binding={callId:call.id,callGeneration:call.callGeneration,token:snapshot.token}
 await f.host.handler('voice-calls/media-ready',binding)
 call=await pending
 assert.equal(facts(await f.assemble()).callId,call.id)
 await f.host.handler('voice-calls/media-closed',binding)
 assert.equal(renderContextSnapshot(await f.assemble()),'','浏览器可信关闭回执后不能因end RPC未到仍声明connected')
 const request=await f.send('继续文字交流')
 assert.ok(!latestRuntime(request).includes(call.id))
})
