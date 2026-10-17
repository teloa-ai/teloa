import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {Session,SessionId,type SessionEventMap} from '@deepseek-ai/dsh-session'
import {createUserMessage,createAssistantMessage} from '@deepseek-ai/dsh-llm'
import type {SessionPromptRequest} from '@deepseek-ai/dsh-api-session-controller'
import {VoiceCallService} from '../src/voice-call-service.ts'

let feature:Record<string,any>={}
try{feature=await import('../src/voice-conversation-driver.ts')}catch(error){if((error as NodeJS.ErrnoException).code!=='ERR_MODULE_NOT_FOUND')throw error}
async function fixture(){
 assert.equal(typeof feature.VoiceConversationDriver,'function','语音原生会话驱动尚未实现')
 const owner=randomUUID(),context={ownerId:owner,roleId:randomUUID(),roleKind:'employee' as const,roleVersion:1,sessionId:'voice-'+randomUUID(),scope:'general'},seals=new Map<string,unknown>(),spoken:unknown[]=[],prepared:unknown[]=[],timings:any[]=[],states:any[]=[]
 let closes=0,prompts=0,unreadable=false,loseReceipt=false,discarded=0
 const work=new AbortController(),session=Session.create(SessionId(context.sessionId))
 const calls=new VoiceCallService({async resolveContext(){return {context,assertCurrent(){}}},async readTranscriptSeal(receipt){return seals.get(receipt)??null},transport:{async readiness(){return {status:'ready',providerId:'host'}},async connect(){return {async close(){closes++},async interruptPlayback(){},async enqueueSpeech(value){spoken.push(value)},prepareSpeech(value){prepared.push(value);return ()=>{discarded++}}}}}})
 const call=await calls.start(owner,{requestId:randomUUID(),roleId:context.roleId,expectedRoleVersion:1,sessionId:context.sessionId})
 seals.set('producer-1',{...context,callId:call.id,callGeneration:call.callGeneration,turnId:'turn-1',speaker:'owner',source:{kind:'sealed-audio-stt',providerId:'host',audioSha256:createHash('sha256').update('sealed owner audio').digest('hex'),sealReceiptId:'sealed',sttReceiptId:'stt-final'},revision:1,text:'你好，请回答当前问题。',closed:true,complete:true,producerReceipt:'producer-1'})
 const commit=await calls.commitTranscript(owner,{callId:call.id,turnId:'turn-1',revision:1,producerReceipt:'producer-1'})
 const reader=feature.createDshVoiceSessionReader({sessions:{get:(id:string)=>id===session.id?session:undefined},sessionController:{async inspect(){throw Error('attached reader must not activate or reopen')}}},{owner,async conversation(id:string){return {id:'conversation',ownerId:owner,sessionId:id,status:'ready'}}})
 let promptedMessage:ReturnType<typeof createUserMessage>|undefined,promptedSignal:AbortSignal|undefined
 const driver=new feature.VoiceConversationDriver({owner,calls,onTiming:(event:unknown)=>timings.push(event),onConversationState:(event:unknown)=>states.push(event),assertCurrentCommit:(value:unknown)=>calls.assertTranscriptCommitCurrent(owner,value),async readSession(id:string){if(unreadable)throw Error('read unavailable');return reader(id)},workSignal:()=>work.signal,async admitPrompt(sourceCommit:unknown,request:SessionPromptRequest,signal:AbortSignal){
  assert.equal(sourceCommit,commit,'最终准入必须拿到 service 自产对象，而不是复制的 UUID 字段')
  prompts++;promptedSignal=signal
  assert.equal(request.sessionId,session.id);assert.equal(request.requestId,commit.id);assert.equal(request.mode,'queue');assert.deepEqual(request.content,[{type:'text',text:commit.text}])
  promptedMessage=createUserMessage({source:{kind:'user',rpcId:request.requestId},content:[{type:'text',text:commit.text}]})
  session.append('turn/start',{turn:0});session.append('user/message',promptedMessage,{surfaceOp:'append'})
  if(loseReceipt){unreadable=true;throw Error('prompt receipt lost')}
  return {accepted:true}
 }})
 const reply=(text:string,interrupted=false,stream:SessionEventMap['assistant/message']['stream']=[])=>{const message=createAssistantMessage({source:{provider:'local-fixture',model:'script'},content:[{type:'text',text}]});session.append('assistant/message',{turn:0,step:0,message,stream,...(interrupted?{interrupted:true as const}:{})},{surfaceOp:'append'});return message}
 const end=()=>session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 return {owner,calls,call,commit,driver,session,reader,work,spoken,prepared,timings,states,reply,end,get discarded(){return discarded},get promptedMessage(){return promptedMessage},get promptedSignal(){return promptedSignal},get prompts(){return prompts},get closes(){return closes},set unreadable(value:boolean){unreadable=value},set loseReceipt(value:boolean){loseReceipt=value}}
}

test('原生首句只预合成：核对真实请求与turn，推理/放弃/错轮/本人续写不能成为播报',async()=>{
 const f=await fixture();await f.driver.submit(f.commit)
 let revision=-1
 const frame=(type:string,rest:object={})=>({type,attemptId:'native-attempt',revision:++revision,turn:0,step:0,...rest})
 f.driver.observeAssistantStream(f.session.id,frame('start'))
 f.driver.observeAssistantStream(f.session.id,frame('chunk',{index:0,time:Date.now(),chunk:{type:'reasoning-delta',index:0,text:'私密推理，不能预合成。'}}))
 f.driver.observeAssistantStream(f.session.id,frame('chunk',{index:1,time:Date.now(),chunk:{type:'text-delta',index:1,text:'这是正式的首句，后面仍在生成。'}}))
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(f.prepared.length,1);assert.equal((f.prepared[0] as any).text,'这是正式的首句，')
 assert.equal(f.spoken.length,0);assert.equal(f.calls.get(f.owner,{callId:f.call.id}).playbackGeneration,0)
 f.driver.observeAssistantStream(f.session.id,frame('end',{index:2,outcome:{kind:'abandoned'}}))
 assert.equal(f.discarded,1)
 f.driver.observeAssistantStream(f.session.id,frame('start',{turn:1}))
 f.driver.observeAssistantStream(f.session.id,frame('chunk',{index:0,time:Date.now(),chunk:{type:'text-delta',index:0,text:'这是错误轮次，不能预合成。'}}))
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.prepared.length,1)
 f.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'本人新追加'}]}),{surfaceOp:'append'})
 f.driver.observeAssistantStream(f.session.id,frame('start'))
 f.driver.observeAssistantStream(f.session.id,frame('chunk',{index:0,time:Date.now(),chunk:{type:'text-delta',index:0,text:'这是旧输入的内容，不能采用。'}}))
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.prepared.length,1)
 f.driver.dispose();await f.calls.end(f.owner,{callId:f.call.id})
})

test('简短回答和顿号列举在首个自然停顿准备，不等待六字或整份清单',async()=>{
 for(const text of ['可以。后面仍在生成。','我能整理资料、查信息、写文档。']){
  const f=await fixture();await f.driver.submit(f.commit)
  f.driver.observeAssistantStream(f.session.id,{type:'start',attemptId:'prefix',revision:0,turn:0,step:0} as any)
  f.driver.observeAssistantStream(f.session.id,{type:'chunk',attemptId:'prefix',revision:1,turn:0,step:0,index:0,time:Date.now(),chunk:{type:'text-delta',index:0,text}} as any)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.prepared.length,1);assert.equal((f.prepared[0] as any).text,text.startsWith('可以')?'可以。':'我能整理资料、')
  assert.equal(f.spoken.length,0)
  f.driver.dispose();await f.calls.end(f.owner,{callId:f.call.id})
 }
})

test('原模型等待保持thinking，正式文本与完成时间来自持久流且诊断不携带内容',async()=>{
 const f=await fixture();await f.driver.submit(f.commit)
 assert.equal(f.states.at(-1)?.state,'waiting')
 const at=Date.now(),formalText='最终可播报内容',privateReason='私有推理不得写入诊断'
 f.reply(formalText,false,[{type:'reasoning-chunks',time0:at-200,index:0,dt:[],texts:[privateReason]},{type:'text-chunks',time0:at-100,index:1,dt:[10],texts:['',formalText]}])
 f.end();await f.driver.observeSession(f.session.id);await f.driver.reconcile(f.commit.id)
 assert.equal(f.timings.filter(event=>event.stage==='model-submit').length,1)
 assert.equal(f.timings.find(event=>event.stage==='final-response-first-text')?.at,at-90)
 assert.equal(f.timings.find(event=>event.stage==='model-completed')?.at,f.session.snapshotEvents().at(-1)!.time)
 assert.equal(f.timings.filter(event=>event.stage==='final-response-first-text').length,1,'重复事件不能重复记录同一首段')
 assert.ok(f.timings.every(event=>event.callId===f.call.id&&event.callGeneration===f.call.callGeneration&&event.turnId===f.commit.turnId&&event.requestId===f.commit.id))
 assert.ok(!JSON.stringify(f.timings).includes(formalText));assert.ok(!JSON.stringify(f.timings).includes(privateReason))
 assert.equal(f.spoken.length,1)
 f.driver.dispose();await f.calls.end(f.owner,{callId:f.call.id})
})

test('工具前正文与最终回复分开计时，不把最终可播报首段冒称模型首文本',async()=>{
 const f=await fixture();await f.driver.submit(f.commit)
 const at=Date.now()
 f.reply('先核对资料。',false,[{type:'text-chunks',time0:at-5000,index:0,dt:[],texts:['先核对资料。']}])
 await f.driver.observeSession(f.session.id);assert.equal(f.spoken.length,0)
 f.reply('核对后的最终答案。',false,[{type:'text-chunks',time0:at,index:0,dt:[],texts:['核对后的最终答案。']}])
 f.end();await f.driver.observeSession(f.session.id)
 assert.equal(f.timings.some(event=>event.stage==='model-first-text'),false,'最终回复首段不能冒称为整轮模型首个文本')
 assert.equal(f.timings.find(event=>event.stage==='final-response-first-text')?.at,at)
 assert.equal(f.spoken.length,1);assert.equal((f.spoken[0] as any).text,'核对后的最终答案。')
 f.driver.dispose();await f.calls.end(f.owner,{callId:f.call.id})
})

test('只受理service自产commit一次，未知回执只读稳定原请求与真实本人消息身份',async()=>{
 const f=await fixture()
 await assert.rejects(f.driver.submit({...f.commit}),{code:'teloa/forbidden'});assert.equal(f.prompts,0)
 f.loseReceipt=true
 const unknown=await f.driver.submit(f.commit)
 assert.equal(unknown.state,'unknown');assert.equal(unknown.requestId,f.commit.id);assert.equal(f.prompts,1)
 f.unreadable=false
 const recovered=await f.driver.submit(f.commit),read=await f.driver.reconcile(f.commit.id)
 assert.equal(recovered.state,'active');assert.deepEqual(read.message,{id:f.promptedMessage!.id,seq:1})
 assert.equal(f.prompts,1);assert.equal(f.promptedSignal,f.work.signal)
 f.driver.dispose();await f.calls.end(f.owner,{callId:f.call.id})
})

test('持久候选或interrupted前缀不播报，只有该轮completed后最终模型文本进入一次宿主播报',async()=>{
 const f=await fixture();await f.driver.submit(f.commit)
 f.reply('中断前缀',true);await f.driver.observeSession(f.session.id);assert.equal(f.spoken.length,0)
 const final=f.reply('这是最终回答。');await f.driver.observeSession(f.session.id);assert.equal(f.spoken.length,0)
 f.end();await f.driver.observeSession(f.session.id)
 const receipt=await f.driver.reconcile(f.commit.id)
 assert.equal(receipt.state,'ended');assert.equal(receipt.reason,'completed');assert.deepEqual(receipt.reply,{messageId:final.id,messageSeq:3,text:'这是最终回答。',endSeq:4})
 assert.equal(f.spoken.length,1);assert.equal((f.spoken[0] as any).text,'这是最终回答。')
 await f.driver.observeSession(f.session.id);assert.equal(f.spoken.length,1)
 f.driver.dispose();await f.calls.end(f.owner,{callId:f.call.id})
})

test('挂断/插话后旧回复不播放，宿主受理的DSH输入继续且没有Task stop或媒体signal传入',async()=>{
 for(const action of ['interrupt','end'] as const){
  const f=await fixture()
  // 受理后模型回复迟到；驱动停播不控制原 DSH 工作信号。
  await f.driver.submit(f.commit)
  await f.calls[action](f.owner,{callId:f.call.id})
  assert.equal(f.work.signal.aborted,false);assert.equal(f.promptedSignal,f.work.signal)
  f.reply('工作仍在原会话完成。');f.end();await f.driver.observeSession(f.session.id)
  const receipt=await f.driver.reconcile(f.commit.id)
  assert.equal(receipt.state,'ended');assert.equal(receipt.speech,'suppressed');assert.equal(f.spoken.length,0);assert.equal(f.prompts,1)
  f.driver.dispose();assert.equal(f.work.signal.aborted,false)
  await f.calls.end(f.owner,{callId:f.call.id})
 }
})

test('无模型回复的真实终态可纯读，媒体轮询不再次派发或等待供应商',async()=>{
 const f=await fixture();await f.driver.submit(f.commit);f.end();await f.driver.observeSession(f.session.id)
 const receipt=f.driver.receipt(f.commit.id)
 assert.equal(receipt.state,'ended');assert.equal(receipt.reply,null);assert.equal(receipt.reason,'completed')
 assert.equal(f.prompts,1);assert.equal(f.spoken.length,0)
 f.driver.dispose();await f.calls.end(f.owner,{callId:f.call.id})
})

test('采集时已固定播报代次，ASR 迟到不能借后一句的代次播放旧回复',async()=>{
 const f=await fixture(),captureGeneration=f.call.playbackGeneration
 await f.calls.interrupt(f.owner,{callId:f.call.id})
 await f.driver.submit(f.commit,captureGeneration)
 f.reply('这是前一句的迟到回复。');f.end();await f.driver.observeSession(f.session.id)
 assert.equal(f.driver.receipt(f.commit.id).speech,'suppressed')
 assert.equal(f.spoken.length,0);assert.equal(f.prompts,1,'停止旧播报不撤销已经受理的工作')
 await assert.rejects(f.driver.submit(f.commit,captureGeneration+1),{code:'teloa/forbidden'})
 f.driver.dispose();await f.calls.end(f.owner,{callId:f.call.id})
})

test('同轮原生 steer 只让最后一条本人输入取得最终回复，前条不能冒领',()=>{
 const session=Session.create(SessionId('voice-steer-'+randomUUID()))
 const original={id:'request-original',text:'先按旧要求做。'},steer={id:'request-steer',text:'请改成新要求。'}
 session.append('turn/start',{turn:0})
 for(const input of [original,steer])session.append('user/message',createUserMessage({source:{kind:'user',rpcId:input.id},content:[{type:'text',text:input.text}]}),{surfaceOp:'append'})
 session.append('assistant/message',{turn:0,step:1,message:createAssistantMessage({source:{provider:'local-fixture',model:'script'},content:[{type:'text',text:'已经按新要求完成。'}]}),stream:[]},{surfaceOp:'append'})
 session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 const snapshot={ownerId:'owner',sessionId:String(session.id),inheritedEventCount:0,events:session.snapshotEvents()}
 assert.equal(feature.observeNativeRequest(original,snapshot).reply,null)
 assert.equal(feature.observeNativeRequest(steer,snapshot).reply?.text,'已经按新要求完成。')
})
