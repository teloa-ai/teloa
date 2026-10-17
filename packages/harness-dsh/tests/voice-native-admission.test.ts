import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import type {SessionPromptRequest} from '@deepseek-ai/dsh-api-session-controller'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {WorkError,type TranscriptCommit} from '@teloa/contract'
import {WorkAccess} from '@teloa/backend'
import {VoiceCallService} from '../src/voice-call-service.ts'
import {VoiceConversationDriver} from '../src/voice-conversation-driver.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {createNativeProducerAdmissions} from '../src/native-producer-admission.ts'
import {controllerAdmissionFixture,promptRequest} from './fixtures/native-controller-admission.ts'
import {nativeHotCausalityFixture,hotGate,textAnswer} from './fixtures/native-hot-causality.ts'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {NativeVoiceInputAdmissions} from '../src/native-voice-input-admission.ts'

const registry=()=>new NativeVoiceInputAdmissions()

test('语音插话由宿主固定 steer；普通 queue 许可不能被换成 steer',async t=>{
 const f=await controllerAdmissionFixture(t),v=await voice(f.agent),voiceInput=registry()
 t.after(()=>voiceInput.close());t.after(()=>v.calls.end(v.owner,{callId:v.call.id}))
 const input=createNativeWorkInput(f.ctx,new WorkAccess());t.after(()=>input.close())
 f.controller.requireInputAdmission();f.controller.installInputAdmission(createNativeProducerAdmissions(input,undefined,voiceInput).controller)
 await voiceInput.withPrompt(v.commit,()=>v.assert(v.commit),()=>f.controller.prompt(promptRequest(f.agent,v.commit.id,v.commit.text,'steer'),v.work.signal),'steer')
 assert.equal(f.agent.inbox.nextStep.length,1)
 assert.equal(f.agent.inbox.nextTurn.length,0)
 assert.deepEqual(f.agent.inbox.nextStep[0]?.content,[{type:'text',text:v.commit.text}])
 const another=await voice(f.agent);t.after(()=>another.calls.end(another.owner,{callId:another.call.id}))
 await assert.rejects(voiceInput.withPrompt(another.commit,()=>another.assert(another.commit),()=>f.controller.prompt(promptRequest(f.agent,another.commit.id,another.commit.text,'steer'),another.work.signal)),{code:'teloa/forbidden'})
 assert.equal(f.agent.inbox.nextStep.length,1)
})

async function voice(agent:Agent,assistant=false){
 const owner=randomUUID(),context=assistant?{ownerId:owner,target:'assistant' as const,contextVersion:3,sessionId:String(agent.id),scope:'general' as const}:{ownerId:owner,roleId:randomUUID(),roleKind:'employee' as const,roleVersion:1,sessionId:String(agent.id),scope:'general'}
 let current=true,closes=0
 const spoken:string[]=[]
 const seals=new Map<string,unknown>(),work=new AbortController()
 const calls=new VoiceCallService({async resolveContext(){return {context,assertCurrent(){if(!current)throw new WorkError('teloa/forbidden','岗位会话已解绑')}}},async readTranscriptSeal(receipt){return seals.get(receipt)??null},transport:{async readiness(){return {status:'ready',providerId:'host'}},async connect(){return {async close(){closes++},async interruptPlayback(){},async enqueueSpeech(value){if(!assistant)throw Error('旧回复不能播报');spoken.push(value.text)}}}}})
 const call=await calls.start(owner,context.target==='assistant'?{requestId:randomUUID(),target:'assistant',expectedContextVersion:context.contextVersion,sessionId:context.sessionId}:{requestId:randomUUID(),roleId:context.roleId,expectedRoleVersion:1,sessionId:context.sessionId})
 seals.set('native-voice',{...context,callId:call.id,callGeneration:call.callGeneration,turnId:'turn-owner',speaker:'owner',source:{kind:'sealed-audio-stt',providerId:'host',audioSha256:createHash('sha256').update('owner native voice').digest('hex'),sealReceiptId:'seal',sttReceiptId:'stt'},revision:1,text:'请在原岗位会话回答。',closed:true,complete:true,producerReceipt:'native-voice'})
 const commit=await calls.commitTranscript(owner,{callId:call.id,turnId:'turn-owner',revision:1,producerReceipt:'native-voice'})
 return {owner,call,calls,commit,work,spoken,assert:(value:TranscriptCommit)=>calls.assertTranscriptCommitCurrent(owner,value),revoke(){current=false},get closes(){return closes}}
}

function driverFor(v:Awaited<ReturnType<typeof voice>>,agent:Agent,admitPrompt:(commit:TranscriptCommit,request:SessionPromptRequest,signal:AbortSignal)=>Promise<any>){
 return new VoiceConversationDriver({owner:v.owner,calls:v.calls,assertCurrentCommit:v.assert,workSignal:()=>v.work.signal,async readSession(){return {ownerId:v.owner,sessionId:String(agent.id),inheritedEventCount:Number(agent.session.inheritedEventCount),events:agent.session.snapshotEvents()}},admitPrompt,
 })
}

test('真实 Controller 异步许可等待后岗位解绑，原语音在最终 append 前拒绝且未知不补发',async t=>{
 const f=await controllerAdmissionFixture(t),v=await voice(f.agent),access=new WorkAccess(),gate=hotGate(),voiceInput=registry()
 t.after(gate.release);t.after(()=>voiceInput.close());t.after(()=>v.calls.end(v.owner,{callId:v.call.id}))
 let permissions=0
 access.installPolicy(async()=>{permissions++;await gate.wait();return {assertCurrent(){}}})
 const input=createNativeWorkInput(f.ctx,access);t.after(()=>input.close())
 const admissions=createNativeProducerAdmissions(input,undefined,voiceInput)
 f.controller.requireInputAdmission();f.controller.installInputAdmission(admissions.controller)
 const driver=driverFor(v,f.agent,(commit,request,signal)=>voiceInput.withPrompt(commit,()=>v.assert(commit),()=>f.controller.prompt(request,signal)));t.after(()=>driver.dispose())
 const before=f.agent.session.snapshotEvents(),pending=driver.submit(v.commit)
 await gate.entered;v.revoke();gate.release()
 const receipt=await pending
 assert.equal(f.agent.inbox.nextTurn.length,0,'旧语音不能在当前岗位解绑后进入官方 Inbox')
 assert.deepEqual(f.agent.session.snapshotEvents(),before,'最终 Session append 必须为零')
 assert.equal(receipt.state,'unknown');assert.equal(receipt.requestId,v.commit.id)
 await driver.submit(v.commit);await driver.reconcile(v.commit.id);assert.equal(permissions,1,'未知回执只读原请求')
})

test('真实 Controller 只有宿主 opaque voice scope 可用原 UUID，错会话拒绝且普通输入独立继续',async t=>{
 const f=await controllerAdmissionFixture(t),v=await voice(f.agent),voiceInput=registry(),gate=hotGate()
 t.after(gate.release);t.after(()=>voiceInput.close());t.after(()=>v.calls.end(v.owner,{callId:v.call.id}))
 const input=createNativeWorkInput(f.ctx,new WorkAccess());t.after(()=>input.close())
 const admissions=createNativeProducerAdmissions(input,undefined,voiceInput)
 f.controller.requireInputAdmission();f.controller.installInputAdmission(admissions.controller)
 // 预留真实 commit 后暂停宿主 dispatch；页面请求不能抢先用同 UUID 构造原语音事实。
 const pending=voiceInput.withPrompt(v.commit,()=>v.assert(v.commit),async()=>{await gate.wait();return f.controller.prompt(promptRequest(f.agent,v.commit.id,v.commit.text),v.work.signal)})
 void pending.catch(()=>{})
 await gate.entered
 const before=f.agent.session.snapshotEvents()
 await assert.rejects(f.controller.prompt(promptRequest(f.agent,v.commit.id,'页面同 UUID 伪装'),v.work.signal),{code:'teloa/forbidden'})
 assert.deepEqual(f.agent.session.snapshotEvents(),before)
 await f.controller.prompt(promptRequest(f.agent,'ordinary-input','本人普通输入'),v.work.signal)
 assert.equal(f.agent.inbox.nextTurn.length,1)
 gate.release();await pending
 assert.equal(f.agent.inbox.nextTurn.length,2)
 const original=f.agent.inbox.nextTurn.find(message=>'rpcId' in message.source&&message.source.rpcId===v.commit.id)!
 assert.equal(original.source.kind,'user');assert.deepEqual(original.content,[{type:'text',text:v.commit.text}])
 await assert.rejects(voiceInput.withPrompt(v.commit,()=>v.assert(v.commit),()=>f.controller.prompt(promptRequest(f.other,v.commit.id,v.commit.text),v.work.signal)),{code:'teloa/conflict'})
 const different=await voice(f.agent);t.after(()=>different.calls.end(different.owner,{callId:different.call.id}))
 await assert.rejects(voiceInput.withPrompt(different.commit,()=>different.assert(different.commit),()=>f.controller.prompt(promptRequest(f.other,different.commit.id,different.commit.text),different.work.signal)),{code:'teloa/forbidden'})
 assert.equal(f.other.inbox.nextTurn.length,0)
})

test('真实最终受理后的媒体挂断不撤原生续作，官方 Loop 完成原 UUID 轮次且旧音频不播放',async t=>{
 const f=await nativeHotCausalityFixture(t),v=await voice(f.agent),voiceInput=registry(),gate=hotGate();t.after(gate.release);t.after(()=>voiceInput.close())
 f.adapter.prepareGate=gate;f.adapter.scripts.push(textAnswer)
 const admissions=createNativeProducerAdmissions(f.work,undefined,voiceInput)
 let prompts=0
 const driver=driverFor(v,f.agent,(commit,request,_signal)=>voiceInput.withPrompt(commit,()=>v.assert(commit),async()=>{
  prompts++;assert.equal(request.requestId,v.commit.id);assert.equal(request.sessionId,f.agent.id)
  const message=createUserMessage({source:{kind:'user',rpcId:request.requestId},content:request.content as any})
  await admissions.controller({kind:'prompt',agent:f.agent,message,requestId:request.requestId,mode:request.mode},()=>f.agent.followup(message))
  return {accepted:true}
 }));t.after(()=>driver.dispose());t.after(()=>v.calls.end(v.owner,{callId:v.call.id}))
 await driver.submit(v.commit);await gate.entered
 await v.calls.end(v.owner,{callId:v.call.id});assert.equal(v.work.signal.aborted,false);gate.release();await f.agent.whenIdle()
 const receipt=await driver.reconcile(v.commit.id)
 assert.equal(f.adapter.requests.length,1);assert.equal(receipt.state,'ended');assert.equal(receipt.reason,'completed');assert.equal(receipt.speech,'suppressed')
 const messages=f.events().filter(event=>event.type==='user/message'&&event.surfaceOp==='append')
 assert.equal(messages.length,1);assert.equal((messages[0]!.data as any).source.rpcId,v.commit.id);assert.equal(prompts,1);assert.ok(v.closes>0)
})
test('助手自产封口经同一NativeInput进入原Session，官方Loop完成后只播报一次且不借员工身份',async t=>{
 const f=await nativeHotCausalityFixture(t),v=await voice(f.agent,true),voiceInput=registry()
 t.after(()=>voiceInput.close());t.after(()=>v.calls.end(v.owner,{callId:v.call.id}))
 assert.equal(v.call.target,'assistant');assert.equal('roleId'in v.call,false);assert.equal(v.commit.target,'assistant')
 f.adapter.scripts.push(textAnswer)
 const admissions=createNativeProducerAdmissions(f.work,undefined,voiceInput)
 let prompts=0
 const driver=driverFor(v,f.agent,(commit,request)=>voiceInput.withPrompt(commit,()=>v.assert(commit),async()=>{
  prompts++;assert.equal(request.sessionId,f.agent.id);assert.equal(request.requestId,v.commit.id);assert.deepEqual(request.content,[{type:'text',text:commit.text}])
  const message=createUserMessage({source:{kind:'user',rpcId:request.requestId},content:[{type:'text',text:commit.text}]})
  await admissions.controller({kind:'prompt',agent:f.agent,message,requestId:request.requestId,mode:request.mode},()=>f.agent.followup(message))
  return {accepted:true}
 }));t.after(()=>driver.dispose())
 await assert.rejects(driver.submit({...v.commit}),{code:'teloa/forbidden'})
 await driver.submit(v.commit);await f.agent.whenIdle()
 const receipt=await driver.reconcile(v.commit.id)
 assert.equal(receipt.sessionId,String(f.agent.id));assert.equal(receipt.state,'ended');assert.equal(receipt.reason,'completed');assert.equal(receipt.speech,'queued')
 assert.equal(v.spoken.length,1);assert.equal(f.adapter.requests.length,1);assert.equal(prompts,1)
 await driver.submit(v.commit);assert.equal(prompts,1);assert.equal(v.spoken.length,1)
 assert.equal(v.work.signal.aborted,false)
})
