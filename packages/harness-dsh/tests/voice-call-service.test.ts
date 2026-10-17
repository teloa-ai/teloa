import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError,type VoiceCall,type VoiceTranscriptSeal} from '@teloa/contract'
import {VoiceCallService} from '../src/voice-call-service.ts'
import {createUnavailableVoiceTransport,VoiceTransportFailure,type VoiceTransport,type VoiceTransportConnectInput,type VoiceConnection,type VoiceTransportEvent} from '../src/voice-transport.ts'

const owner='owner',roleId='20000000-0000-4000-8000-000000000001',requestId='10000000-0000-4000-8000-000000000001',otherRequest='10000000-0000-4000-8000-000000000002'
const input={requestId,roleId,expectedRoleVersion:2,sessionId:'role-session'}
const unavailable={code:'teloa/unavailable'},forbidden={code:'teloa/forbidden'},conflict={code:'teloa/conflict'}
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}
const until=async(check:()=>boolean)=>{for(let count=0;count<50&&!check();count++)await new Promise<void>(resolve=>setImmediate(resolve));assert.ok(check(),'有界等待未进入预期边界')}

// 仅替换外部媒体边界；真实 service 掌管 signal、世代、转写状态和回执。
function fixture(options:{transport?:VoiceTransport;delayed?:boolean;kind?:'employee'|'twin';readSeal?:(receipt:string)=>Promise<unknown|null>;admissionWait?:Promise<void>;onChange?:(call:VoiceCall)=>void;mute?:(input:{muted:boolean;callGeneration:string})=>Promise<void>}={}){
 let valid=true,connectCount=0,closeCount=0,interruptCount=0,capture=false,queue=0
 let connectInput:VoiceTransportConnectInput|undefined,connectFailure:unknown,closeFailure:unknown
 const waiting=deferred<VoiceConnection>(),seals=new Map<string,unknown>()
 const connection:VoiceConnection={async interruptPlayback(){interruptCount++;queue=0},async close(){closeCount++;capture=false;queue=0;if(closeFailure)throw closeFailure},...(options.mute?{setMuted:options.mute}:{})}
 const transport:VoiceTransport=options.transport??{
  async readiness(){return {status:'ready',providerId:'test-relay'}},
  async connect(next){connectCount++;connectInput=next;capture=true;next.signal.addEventListener('abort',()=>{capture=false;queue=0},{once:true});if(connectFailure)throw connectFailure;return options.delayed?waiting.promise:connection},
 }
 const service=new VoiceCallService({transport,...(options.onChange?{onChange:options.onChange}:{}),async resolveContext(requestOwner,request){if(request.target==='assistant')throw Error('此fixture仅模拟员工目标');await options.admissionWait;return {context:{ownerId:requestOwner,roleId:request.roleId,roleKind:options.kind??'employee',roleVersion:request.expectedRoleVersion,sessionId:request.sessionId,scope:'general'},assertCurrent(){if(!valid)throw new WorkError('teloa/forbidden','委托已撤销。')}}},async readTranscriptSeal(receipt){return options.readSeal?options.readSeal(receipt):seals.get(receipt)??null}})
 const emit=(event:VoiceTransportEvent)=>connectInput?.onEvent(event)
 return {service,seals,waiting,connection,emit,get connectInput(){return connectInput},get connectCount(){return connectCount},get closeCount(){return closeCount},get interruptCount(){return interruptCount},get capture(){return capture},get queue(){return queue},enqueue(){queue++},revoke(){valid=false},failConnect(error:unknown){connectFailure=error},failClose(error:unknown){closeFailure=error}}
}
const seal=(call:VoiceCall,changes:Record<string,unknown>={}):VoiceTranscriptSeal=>{if(call.target==='assistant')throw Error('此fixture仅封口员工目标');return ({ownerId:call.ownerId,roleId:call.roleId,roleKind:call.roleKind,roleVersion:call.roleVersion,sessionId:call.sessionId,scope:call.scope,callId:call.id,callGeneration:call.callGeneration,turnId:'turn-1',speaker:'owner',revision:2,text:'hello',closed:true,complete:true,producerReceipt:'receipt-1',source:{kind:'sealed-audio-stt',providerId:'local-stt',audioSha256:'a'.repeat(64),sealReceiptId:'seal-1',sttReceiptId:'stt-1'},...changes})}
const commitInput=(call:VoiceCall,changes:Record<string,unknown>={})=>({callId:call.id,turnId:'turn-1',revision:2,producerReceipt:'receipt-1',...changes})

test('进度只读原call最近50自产封口，候选不展示，挂断不生成新封口或关闭工作',async()=>{
 const f=fixture(),call=await f.service.start(owner,input),service=f.service as VoiceCallService&{progressTranscripts:(owner:string,input:{callId:string})=>readonly unknown[]}
 assert.equal(typeof service.progressTranscripts,'function','须提供原通话真实封口的纯读口')
 f.emit({type:'transcript-candidate',callGeneration:call.callGeneration,sessionId:call.sessionId,turnId:'candidate-only',revision:1,text:'候选不能算封口'})
 assert.deepEqual(service.progressTranscripts(owner,{callId:call.id}),[])
 const commits=[]
 for(let index=0;index<52;index++){const turnId='turn-'+index,producerReceipt='receipt-'+index;f.seals.set(producerReceipt,seal(call,{turnId,producerReceipt}));commits.push(await service.commitTranscript(owner,commitInput(call,{turnId,producerReceipt})))}
 assert.deepEqual(service.progressTranscripts(owner,{callId:call.id}),commits.slice(-50))
 await service.end(owner,{callId:call.id});f.revoke()
 assert.deepEqual(service.progressTranscripts(owner,{callId:call.id}),commits.slice(-50));assert.equal(f.connectCount,1);assert.equal(f.closeCount,1)
 assert.throws(()=>service.progressTranscripts('other',{callId:call.id}),forbidden)
})

test('未开始与只读就绪不打开媒体；未配置 start 返回诚实失败',async()=>{
 const f=fixture({transport:createUnavailableVoiceTransport()})
 assert.deepEqual(await f.service.readiness(),{status:'unavailable',providerId:null,reason:'provider-unconfigured'})
 assert.equal(f.connectCount,0)
 const call=await f.service.start(owner,input)
 assert.equal(call.state,'failed');assert.equal(call.failure,'provider-unconfigured');assert.equal(call.readiness.status,'unavailable')
 assert.equal(f.connectCount,0)
})

for(const kind of ['employee','twin'] as const)test(`${kind} 开始固定身份；重复请求不回拨且不同参数冲突`,async()=>{
 const f=fixture({kind}),call=await f.service.start(owner,input)
 assert.ok(call.target!=='assistant');assert.equal(call.state,'connected');assert.equal(call.roleKind,kind);assert.equal(call.ownerId,owner);assert.equal(call.roleVersion,2);assert.equal(call.scope,'general')
 assert.equal(f.connectInput?.roleContext.sessionId,'role-session');assert.ok(Object.isFrozen(f.connectInput?.roleContext))
 assert.equal((await f.service.start(owner,input)).id,call.id);assert.equal(f.connectCount,1)
 await assert.rejects(()=>f.service.start(owner,{...input,sessionId:'another-session'}),conflict)
 await f.service.end(owner,{callId:call.id})
 assert.equal((await f.service.start(owner,input)).state,'ended');assert.equal(f.connectCount,1)
})

test('挂断与插话只释放媒体，跨账号不能读或操作原通话',async()=>{
 const f=fixture(),call=await f.service.start(owner,input)
 assert.throws(()=>f.service.get('other',{callId:call.id}),forbidden)
 await assert.rejects(()=>f.service.end('other',{callId:call.id}),forbidden)
 await assert.rejects(()=>f.service.interrupt('other',{callId:call.id}),forbidden)
 f.enqueue();assert.equal(f.queue,1)
 const interrupted=await f.service.interrupt(owner,{callId:call.id})
 assert.equal(interrupted.state,'connected');assert.equal(interrupted.playbackGeneration,1);assert.equal(f.interruptCount,1);assert.equal(f.queue,0);assert.equal(f.capture,true)
 const ended=await f.service.end(owner,{callId:call.id})
 assert.equal(ended.state,'ended');assert.equal(f.capture,false);assert.equal(f.closeCount,1);assert.equal(f.connectInput?.signal.aborted,true)
 assert.equal((await f.service.end(owner,{callId:call.id})).state,'ended');assert.equal(f.closeCount,1)
})

test('插话清理后拒绝旧播放世代，挂断后迟到事件不能复活',async()=>{
 const f=fixture(),call=await f.service.start(owner,input)
 f.emit({type:'playback',callGeneration:call.callGeneration,playbackGeneration:0,state:'playing'})
 assert.equal(f.service.get(owner,{callId:call.id}).playback,'playing')
 await f.service.interrupt(owner,{callId:call.id})
 f.emit({type:'playback',callGeneration:call.callGeneration,playbackGeneration:0,state:'playing'})
 assert.equal(f.service.get(owner,{callId:call.id}).playback,'idle')
 await f.service.end(owner,{callId:call.id})
 f.emit({type:'playback',callGeneration:call.callGeneration,playbackGeneration:1,state:'playing'})
 assert.equal(f.service.get(owner,{callId:call.id}).state,'ended');assert.equal(f.service.get(owner,{callId:call.id}).playback,'idle')
})

test('连接等待期间挂断，晚到连接关闭且不会重新接通',async()=>{
 const f=fixture({delayed:true}),start=f.service.start(owner,input)
 await until(()=>!!f.connectInput)
 const callId=f.connectInput!.callId
 await f.service.end(owner,{callId})
 assert.equal(f.capture,false)
 f.waiting.resolve(f.connection)
 assert.equal((await start).state,'ended');assert.equal(f.closeCount,1)
})

test('连接前后复验角色/consent；连接后撤权立即释放媒体',async()=>{
 const f=fixture({delayed:true}),start=f.service.start(owner,input)
 await until(()=>!!f.connectInput)
 f.revoke();f.waiting.resolve(f.connection)
 assert.equal((await start).failure,'authorization-changed');assert.equal(f.capture,false);assert.equal(f.closeCount,1)
 const before=fixture();before.revoke()
 await assert.rejects(()=>before.service.start(owner,input),forbidden);assert.equal(before.connectCount,0)
})

test('麦克风拒绝与断线是脱敏失败，不自动重连',async()=>{
 const denied=fixture();denied.failConnect(new VoiceTransportFailure('microphone-denied'))
 const rejected=await denied.service.start(owner,input)
 assert.equal(rejected.state,'failed');assert.equal(rejected.failure,'microphone-denied');assert.equal(denied.capture,false)
 const f=fixture(),call=await f.service.start(owner,input)
 f.emit({type:'disconnected',callGeneration:call.callGeneration})
 await until(()=>f.closeCount===1)
 assert.equal(f.service.get(owner,{callId:call.id}).failure,'connection-lost');assert.equal(f.capture,false);assert.equal(f.connectCount,1)
 const next=await f.service.start(owner,{...input,requestId:otherRequest})
 assert.notEqual(next.callGeneration,call.callGeneration);assert.equal(f.connectCount,2)
 f.emit({type:'disconnected',callGeneration:call.callGeneration})
 assert.equal(f.service.get(owner,{callId:next.id}).state,'connected')
})

test('新 service 不恢复媒体；关闭错误保留结束状态并显示清理失败',async()=>{
 const f=fixture(),call=await f.service.start(owner,input)
 f.failClose(new Error('private credentials'))
 const ended=await f.service.end(owner,{callId:call.id})
 assert.equal(ended.state,'ended');assert.equal(ended.failure,'media-close-failed');assert.equal(f.capture,false)
 const restarted=fixture()
 assert.equal(restarted.connectCount,0);assert.throws(()=>restarted.service.get(owner,{callId:call.id}),{code:'teloa/not-found'})
})
test('connect拒绝但物理close失败时本人沿原call世代重试，不假接通',async()=>{
 let fixed:VoiceTransportConnectInput|undefined,closeFails=true,connectFails=true,connected=0
 const addresses:{callId:string;callGeneration:string}[]=[],states:string[]=[]
 const transport:VoiceTransport&{closePending:(address:{callId:string;callGeneration:string})=>Promise<void>}={
  async readiness(){return {status:'ready',providerId:'test-relay'}},
  async connect(next){fixed=next;connected++;if(connectFails)throw new VoiceTransportFailure('connection-failed');return {async close(){},async interruptPlayback(){}}},
  async closePending(address){assert.deepEqual(address,{callId:fixed!.callId,callGeneration:fixed!.callGeneration});addresses.push(address);if(closeFails)throw new VoiceTransportFailure('media-close-failed')},
 }
 const f=fixture({transport,onChange:call=>states.push(call.state)}),call=await f.service.start(owner,input)
 assert.equal(call.state,'failed');assert.equal(call.failure,'media-close-failed');assert.equal(connected,1);assert.equal(addresses.length,1)
 await assert.rejects(f.service.end('other',{callId:call.id}),forbidden);assert.equal(addresses.length,1)
 const failed=await f.service.end(owner,{callId:call.id});assert.equal(failed.failure,'media-close-failed');assert.equal(addresses.length,2)
 closeFails=false
 const retried=await f.service.end(owner,{callId:call.id});assert.equal(retried.failure,'connection-failed');assert.equal(retried.state,'failed');assert.equal(addresses.length,3)
 await f.service.end(owner,{callId:call.id});assert.equal(addresses.length,3);assert.equal(states.includes('connected'),false)
 connectFails=false
 const next=await f.service.start(owner,{...input,requestId:otherRequest});assert.equal(next.state,'connected');assert.notEqual(next.callGeneration,call.callGeneration);assert.equal(connected,2)
 await f.service.end(owner,{callId:next.id})
})
test('准备期间取消用原世代closePending，关闭失败可重试且晚到连接不接通',async()=>{
 const waiting=deferred<VoiceConnection>(),states:string[]=[],addresses:{callId:string;callGeneration:string}[]=[]
 let fixed:VoiceTransportConnectInput|undefined,closeFails=true,physicalClose=0
 const transport:VoiceTransport={async readiness(){return {status:'ready',providerId:'test-relay'}},async connect(value){fixed=value;return waiting.promise},async closePending(address){assert.deepEqual(address,{callId:fixed!.callId,callGeneration:fixed!.callGeneration});addresses.push(address);if(closeFails)throw new VoiceTransportFailure('media-close-failed')}}
 const f=fixture({transport,onChange:call=>states.push(call.state)}),started=f.service.start(owner,input)
 await until(()=>!!fixed)
 assert.equal((await f.service.end(owner,{callId:fixed!.callId})).failure,'media-close-failed');assert.equal(addresses.length,1)
 closeFails=false
 assert.equal((await f.service.end(owner,{callId:fixed!.callId})).failure,null);assert.equal(addresses.length,2)
 waiting.resolve({async close(){physicalClose++},async interruptPlayback(){}})
 assert.equal((await started).state,'ended');assert.equal(physicalClose,1);assert.equal(states.includes('connected'),false)
})

test('旧媒体未确认关闭时不打开新通话，真实收尾后本人可重新拨号',async()=>{
 const failed=fixture(),first=await failed.service.start(owner,input)
 failed.failClose(Error('cannot close'))
 await failed.service.end(owner,{callId:first.id})
 await assert.rejects(()=>failed.service.start(owner,{...input,requestId:otherRequest}),unavailable)
 assert.equal(failed.connectCount,1)
 failed.failClose(undefined)
 const next=await failed.service.start(owner,{...input,requestId:'10000000-0000-4000-8000-000000000003'})
 assert.equal(next.state,'connected');assert.equal(failed.connectCount,2)
 await failed.service.end(owner,{callId:next.id})
 const pending=fixture({delayed:true}),original=pending.service.start(owner,input)
 await until(()=>!!pending.connectInput)
 await pending.service.end(owner,{callId:pending.connectInput!.callId})
 await assert.rejects(()=>pending.service.start(owner,{...input,requestId:otherRequest}),conflict)
 assert.equal(pending.connectCount,1)
 pending.waiting.resolve(pending.connection)
 assert.equal((await original).state,'ended');assert.equal(pending.closeCount,1)
})

test('候选版本单调，delta/delegation 与无宿主封口回执不能生成 commit',async()=>{
 const f=fixture(),call=await f.service.start(owner,input)
 const event={type:'transcript-candidate' as const,callGeneration:call.callGeneration,sessionId:call.sessionId,turnId:'turn-1',revision:2,text:'hel'}
 f.emit(event);f.emit({...event,revision:1,text:'old'});f.emit({...event,text:'duplicate mismatch'});f.emit({...event,revision:3,callGeneration:'old-generation',text:'foreign'})
 assert.equal(f.service.getTranscriptCandidate(owner,{callId:call.id,turnId:'turn-1'})?.text,'hel')
 await assert.rejects(()=>f.service.commitTranscript(owner,commitInput(call)),unavailable)
 f.seals.set('receipt-1',{type:'session.delegation.created',delegation:{id:'delegation'}})
 await assert.rejects(()=>f.service.commitTranscript(owner,commitInput(call)),{code:'teloa/invalid-host-response'})
 f.seals.set('receipt-1',seal(call,{closed:false,complete:false}))
 await assert.rejects(()=>f.service.commitTranscript(owner,commitInput(call)),{code:'teloa/invalid-host-response'})
})

test('完整宿主 STT 封口生成固定 hash 回执，迟到候选与重复提交不改正文',async()=>{
 const f=fixture(),call=await f.service.start(owner,input)
 f.seals.set('receipt-1',seal(call))
 const committed=await f.service.commitTranscript(owner,commitInput(call))
 assert.equal(committed.text,'hello');assert.equal(committed.contentSha256,'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');assert.ok(Object.isFrozen(committed.source))
 f.service.assertTranscriptCommitCurrent(owner,committed)
 assert.throws(()=>f.service.assertTranscriptCommitCurrent(owner,{...committed}),forbidden)
 assert.throws(()=>f.service.assertTranscriptCommitCurrent('other',committed),forbidden)
 f.emit({type:'transcript-candidate',callGeneration:call.callGeneration,sessionId:call.sessionId,turnId:'turn-1',revision:99,text:'late changed'})
 f.seals.set('receipt-1',seal(call,{text:'changed'}))
 assert.equal((await f.service.commitTranscript(owner,commitInput(call))).id,committed.id)
 assert.equal(f.service.getTranscriptCommit(owner,{callId:call.id,commitId:committed.id}).text,'hello')
 await assert.rejects(()=>f.service.commitTranscript(owner,commitInput(call,{revision:3})),conflict)
})

test('封口来源绑定身份和世代，回读期间撤权/挂断都不得接纳',async()=>{
 for(const changed of [{ownerId:'other'},{roleVersion:1},{scope:'foreign'},{sessionId:'foreign-session'},{callGeneration:'60000000-0000-4000-8000-000000000001'},{revision:1},{producerReceipt:'foreign-receipt'}]){
  const f=fixture(),call=await f.service.start(owner,input)
  f.seals.set('receipt-1',seal(call,changed))
  await assert.rejects(()=>f.service.commitTranscript(owner,commitInput(call)),conflict)
 }
 const f=fixture(),call=await f.service.start(owner,input)
 f.seals.set('receipt-1',seal(call));f.revoke()
 await assert.rejects(()=>f.service.commitTranscript(owner,commitInput(call)),forbidden)
 await f.service.end(owner,{callId:call.id})
 assert.equal(f.service.get(owner,{callId:call.id}).state,'ended')
})

test('就绪通知期间本人挂断，不能随后打开已经取消的媒体',async()=>{
 let service!:VoiceCallService,connected=0
 service=new VoiceCallService({
  transport:{async readiness(){return {status:'ready',providerId:'test-relay'}},async connect(){connected++;return {async close(){},async interruptPlayback(){}}}},
  async resolveContext(){return {context:{ownerId:owner,roleId,roleKind:'employee',roleVersion:2,sessionId:'role-session',scope:'general'},assertCurrent(){}}},
  async readTranscriptSeal(){return null},
  onChange(call){if(call.state==='connecting'&&call.readiness.status==='ready')void service.end(owner,{callId:call.id})},
 })
 const call=await service.start(owner,input)
 assert.equal(call.state,'ended');assert.equal(connected,0)
})

for(const action of ['revoke','end'] as const)test(`宿主最终 STT 回读等待期间 ${action}，迟到完整记录不能成为新 commit`,async()=>{
 const receipt=deferred<unknown>(),entered=deferred<void>(),f=fixture({async readSeal(){entered.resolve();return receipt.promise}}),call=await f.service.start(owner,input)
 const pending=f.service.commitTranscript(owner,commitInput(call))
 await entered.promise
 if(action==='revoke')f.revoke();else await f.service.end(owner,{callId:call.id})
 receipt.resolve(seal(call))
 await assert.rejects(()=>pending,action==='revoke'?forbidden:conflict)
})

test('同请求并发只连接一次；最终版本落后于候选时拒绝封口',async()=>{
 const f=fixture({delayed:true}),first=f.service.start(owner,input),second=f.service.start(owner,input)
 await until(()=>!!f.connectInput)
 assert.equal(f.connectCount,1);f.waiting.resolve(f.connection)
 const [call,duplicate]=await Promise.all([first,second]);assert.equal(call.id,duplicate.id)
 f.emit({type:'transcript-candidate',callGeneration:call.callGeneration,sessionId:call.sessionId,turnId:'turn-1',revision:3,text:'new correction'})
 f.seals.set('receipt-1',seal(call))
 await assert.rejects(()=>f.service.commitTranscript(owner,commitInput(call)),conflict)
})

test('等待连接的原请求已挂断时，重复 start 立即返回原结束状态',async()=>{
 const f=fixture({delayed:true}),pending=f.service.start(owner,input)
 await until(()=>!!f.connectInput)
 await f.service.end(owner,{callId:f.connectInput!.callId})
 let returned:VoiceCall|undefined
 void f.service.start(owner,input).then(call=>{returned=call})
 try{
  await new Promise<void>(resolve=>setImmediate(resolve))
  assert.equal(returned?.state,'ended');assert.equal(f.connectCount,1)
 }finally{f.waiting.resolve(f.connection);await pending}
})
test('按请求纯读和提前取消不打开媒体，准备取消后迟到start也不能接通或改换身份',async()=>{
 const ready=deferred<void>(),f=fixture({admissionWait:ready.promise})
 assert.equal(typeof f.service.getByRequest,'function')
 assert.equal(f.service.getByRequest(owner,{requestId}),null);assert.equal(f.connectCount,0)
 const pending=f.service.start(owner,input),rejected=assert.rejects(pending,conflict)
 assert.deepEqual(await f.service.endByRequest(owner,{requestId}),{requestId,cancelled:true,call:null})
 assert.deepEqual(await f.service.endByRequest(owner,{requestId}),{requestId,cancelled:true,call:null})
 ready.resolve();await rejected
 assert.equal(f.connectCount,0);assert.equal(f.service.getByRequest(owner,{requestId}),null)
 await assert.rejects(f.service.start(owner,input),conflict)
 await assert.rejects(f.service.start(owner,{...input,sessionId:'different-session'}),conflict)
 const before=fixture()
 await before.service.endByRequest(owner,{requestId})
 await assert.rejects(before.service.start(owner,input),conflict);assert.equal(before.connectCount,0)
 assert.equal(before.service.getByRequest('other',{requestId}),null)
})
test('回执丢失时按本人请求找回并挂断，撤权后仍可取消，晚到连接立即关闭',async()=>{
 const f=fixture({delayed:true}),pending=f.service.start(owner,input)
 await until(()=>!!f.connectInput)
 const current=f.service.getByRequest(owner,{requestId});assert.equal(current?.state,'connecting')
 assert.equal(f.service.getByRequest('other',{requestId}),null)
 assert.deepEqual(await f.service.endByRequest('other',{requestId}),{requestId,cancelled:true,call:null})
 assert.equal(f.capture,true,'其他本人相同requestId不能关闭本人的连接')
 f.revoke();const cancelled=await f.service.endByRequest(owner,{requestId})
 assert.equal(cancelled.cancelled,true);assert.equal(cancelled.call?.id,current?.id);assert.equal(cancelled.call?.state,'ended');assert.equal(f.capture,false)
 assert.deepEqual(await f.service.endByRequest(owner,{requestId}),cancelled)
 f.waiting.resolve(f.connection)
 assert.equal((await pending).state,'ended');assert.equal(f.closeCount,1)
 assert.equal((await f.service.start(owner,input)).state,'ended');assert.equal(f.connectCount,1)
})
test('真实媒体关闭失败后再次挂断重新close，同连接成功后清除清理失败',async()=>{
 const f=fixture(),call=await f.service.start(owner,input)
 f.failClose(Error('close failed'))
 assert.equal((await f.service.end(owner,{callId:call.id})).failure,'media-close-failed');assert.equal(f.closeCount,1)
 f.failClose(undefined)
 const retried=await f.service.end(owner,{callId:call.id})
 assert.equal(f.closeCount,2);assert.equal(retried.failure,null);assert.equal(retried.state,'ended')
 await f.service.end(owner,{callId:call.id});assert.equal(f.closeCount,2)
 const lost=fixture(),failed=await lost.service.start(owner,input)
 lost.failClose(Error('close failed'));lost.emit({type:'disconnected',callGeneration:failed.callGeneration})
 await until(()=>lost.service.get(owner,{callId:failed.id}).failure==='media-close-failed')
 lost.failClose(undefined)
 assert.equal((await lost.service.end(owner,{callId:failed.id})).failure,'connection-lost');assert.equal(lost.closeCount,2)
})
test('静音仅依据实际连接端口回执，拒绝旧世代、缺端口和关闭期间迟到的成功',async()=>{
 const calls:{muted:boolean;callGeneration:string}[]=[],wait=deferred<void>(),f=fixture({async mute(value){calls.push(value);if(!value.muted)await wait.promise}}),call=await f.service.start(owner,input)
 assert.equal(typeof f.service.setMuted,'function')
 const request={callId:call.id,callGeneration:call.callGeneration,muted:true}
 await assert.rejects(f.service.setMuted('other',request),forbidden)
 await assert.rejects(f.service.setMuted(owner,{...request,callGeneration:otherRequest}),conflict)
 assert.equal(calls.length,0)
 assert.deepEqual(await f.service.setMuted(owner,request),request);assert.deepEqual(calls,[{muted:true,callGeneration:call.callGeneration}])
 const pending=f.service.setMuted(owner,{...request,muted:false}),rejected=assert.rejects(pending,conflict)
 await until(()=>calls.length===2);await f.service.end(owner,{callId:call.id});wait.resolve();await rejected
 const missing=fixture(),missingCall=await missing.service.start(owner,input)
 await assert.rejects(missing.service.setMuted(owner,{callId:missingCall.id,callGeneration:missingCall.callGeneration,muted:true}),unavailable)
 const failed=fixture({async mute(){throw Error('private provider credentials')}}),failedCall=await failed.service.start(owner,input)
 await assert.rejects(failed.service.setMuted(owner,{callId:failedCall.id,callGeneration:failedCall.callGeneration,muted:true}),unavailable)
})
