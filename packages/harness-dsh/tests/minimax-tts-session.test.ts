import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter,getEventListeners} from 'node:events'
import WebSocket,{type ClientOptions} from 'ws'
import {createMiniMaxTtsSession} from '../src/minimax-tts-session.ts'

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))

test('供应商不确认取消时800ms内废弃旧连接，不能让下一句挂15秒',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const f=fixture(),{session,socket}=await f.ready()
 const first=session.synthesize('旧句。',new AbortController().signal,()=>{})
 const rejected=assert.rejects(first,{name:'AbortError'})
 const cancel=session.cancel(),expired=assert.rejects(cancel)
 t.mock.timers.tick(800);await expired;await rejected
 assert.equal(socket.terminated,1)
 await assert.rejects(session.synthesize('新句。',new AbortController().signal,()=>{}))
})
class Socket extends EventEmitter{
 readyState:number=WebSocket.CONNECTING
 bufferedAmount=0
 readonly sent:Record<string,unknown>[]=[]
 terminated=0
 pings=0
 send(value:string,callback?:(error?:Error)=>void){this.sent.push(JSON.parse(value) as Record<string,unknown>);callback?.()}
 ping(){this.pings++}
 terminate(){this.terminated++;this.readyState=WebSocket.CLOSED;this.emit('close')}
 open(){this.readyState=WebSocket.OPEN;this.emit('open')}
 receive(value:unknown){this.emit('message',Buffer.from(JSON.stringify(value)),false)}
}
function fixture(){
 const controller=new AbortController(),sockets:Socket[]=[],requests:{url:string;options:ClientOptions}[]=[]
 const pending=createMiniMaxTtsSession({key:async()=> 'test-secret',voice:{model:'speech-2.8-turbo',voiceId:'voice-test'},signal:controller.signal,socketFactory:(url,options)=>{
  const socket=new Socket();sockets.push(socket);requests.push({url,options});return socket as unknown as WebSocket
 }})
 void pending.catch(()=>{})
 const ready=async()=>{
  await tick();const socket=sockets[0];assert.ok(socket)
  socket.open();socket.receive({event:'connected_success',base_resp:{status_code:0}})
  assert.deepEqual(socket.sent[0],{event:'task_start',model:'speech-2.8-turbo',language_boost:'auto',voice_setting:{voice_id:'voice-test',speed:1,vol:1,pitch:0},audio_setting:{sample_rate:24000,format:'pcm',channel:1}})
  socket.receive({event:'task_started',base_resp:{status_code:0}})
  return {session:await pending,socket}
 }
 return {controller,sockets,requests,pending,ready}
}

test('同一连接连续合成两句；is_final不冒充flush完成，PCM配置固定',async t=>{
 const f=fixture(),{session,socket}=await f.ready();t.after(()=>session.close())
 assert.equal(f.requests[0]?.url,'wss://api.minimax.io/ws/v1/t2a_v2_bidi')
 assert.equal(f.requests[0]?.options.headers?.Authorization,'Bearer test-secret')
 assert.equal(f.requests[0]?.options.followRedirects,false)
 assert.notEqual(f.requests[0]?.options.rejectUnauthorized,false)
 const received:number[][]=[]
 let completed=false
 const first=session.synthesize('第一句。',new AbortController().signal,bytes=>{received.push([...bytes])}).then(()=>{completed=true})
 const second=session.synthesize('第二句',new AbortController().signal,bytes=>{received.push([...bytes])})
 assert.deepEqual(socket.sent.slice(1),[{event:'task_continue',text:'第一句。'},{event:'task_flush'}])
 socket.receive({event:'task_continued',data:{audio:'01000200'},is_final:true})
 await tick();assert.equal(completed,false)
 socket.receive({event:'task_flushed'})
 await first;await tick()
 assert.deepEqual(socket.sent.slice(3),[{event:'task_continue',text:'第二句'},{event:'task_flush'}])
 // 官方音频示例不保证event、trace_id或sentence_start，不能据此拒绝合法音频。
 socket.receive({data:{audio:'03000400'}});socket.receive({event:'task_flushed'})
 await second
 assert.deepEqual(received,[[1,0,2,0],[3,0,4,0]])
 assert.equal(f.sockets.length,1);assert.equal(socket.sent.filter(row=>row.event==='task_start').length,1)
})

test('正常长句快速回包与播放背压重叠时不因128个小包误判失败',async()=>{
 const f=fixture(),{session,socket}=await f.ready()
 let release!:()=>void,received=0
 const held=new Promise<void>(resolve=>{release=resolve})
 const pending=session.synthesize('这是一段正常长度的完整语音回答。',new AbortController().signal,async()=>{received++;if(received===1)await held})
 const settled=pending.then(()=>null,error=>error)
 for(let n=0;n<180;n++)socket.receive({data:{audio:'0100'.repeat(1024)}})
 socket.receive({event:'task_flushed'});release()
 assert.equal(await settled,null);assert.equal(received,180)
 await session.close()
})

test('取消等待task_canceled栅栏；迟到音频及旧异步消费不能串入下一句',async t=>{
 const f=fixture(),{session,socket}=await f.ready();t.after(()=>session.close())
 const abort=new AbortController(),old:number[][]=[],next:number[][]=[]
 let release!:()=>void
 const first=session.synthesize('旧句。',abort.signal,async bytes=>{old.push([...bytes]);await new Promise<void>(resolve=>{release=resolve})})
 const rejected=assert.rejects(first,{name:'AbortError'})
 socket.receive({data:{audio:'0100'}});await tick()
 socket.receive({data:{audio:'0200'}})
 abort.abort()
 const canceled=session.cancel()
 const second=session.synthesize('新句。',new AbortController().signal,bytes=>{next.push([...bytes])})
 assert.equal(socket.sent.at(-1)?.event,'task_cancel')
 socket.receive({data:{audio:'0300'}})
 socket.receive({event:'task_flushed'})
 await tick();assert.equal(socket.sent.filter(row=>row.event==='task_continue').length,1)
 socket.receive({event:'task_canceled'});await canceled;await tick()
 release();await tick();await rejected
 assert.equal(socket.sent.filter(row=>row.event==='task_cancel').length,1)
 socket.receive({data:{audio:'0400'}});socket.receive({event:'task_flushed'});await second
 assert.deepEqual(old,[[1,0]]);assert.deepEqual(next,[[4,0]])
})

test('挂断pending握手立即终止socket，迟到握手不得再task_start',async()=>{
 const f=fixture();await tick();const socket=f.sockets[0];assert.ok(socket)
 f.controller.abort()
 await assert.rejects(f.pending,{name:'AbortError'})
 assert.equal(socket.terminated,1)
 socket.open();socket.receive({event:'connected_success'});socket.receive({event:'task_started'})
 assert.deepEqual(socket.sent,[])
 assert.equal(socket.listenerCount('message'),0)
 assert.equal(getEventListeners(f.controller.signal,'abort').length,0)
})

test('等待凭据时挂断不等待key，迟到key不会建立网络连接',async()=>{
 const controller=new AbortController();let release!:(key:string)=>void,created=0
 const pending=createMiniMaxTtsSession({key:()=>new Promise<string>(resolve=>{release=resolve}),voice:{model:'speech-2.8-turbo',voiceId:'voice'},signal:controller.signal,socketFactory:()=>{created++;return new Socket() as unknown as WebSocket}})
 controller.abort();await assert.rejects(pending,{name:'AbortError'})
 release('late-secret');await tick();assert.equal(created,0)
})

test('close与取消并发幂等，活动和排队句子均结束且不发送task_finish',async()=>{
 const f=fixture(),{session,socket}=await f.ready()
 const a=session.synthesize('第一句。',new AbortController().signal,()=>{}),b=session.synthesize('第二句。',new AbortController().signal,()=>{})
 const rejected=Promise.all([assert.rejects(a),assert.rejects(b)])
 const canceled=session.cancel(),cancelRejected=assert.rejects(canceled)
 await Promise.all([session.close(),session.close()]);await rejected;await cancelRejected
 assert.equal(socket.terminated,1);assert.equal(socket.sent.some(row=>row.event==='task_finish'),false)
 await assert.rejects(session.synthesize('已挂断。',new AbortController().signal,()=>{}))
})

test('音频消费必须完成后才完成flush并接纳下一句',async t=>{
 const f=fixture(),{session,socket}=await f.ready();t.after(()=>session.close())
 let release!:()=>void,settled=false
 const first=session.synthesize('第一句。',new AbortController().signal,()=>new Promise<void>(resolve=>{release=resolve})).then(()=>{settled=true})
 const second=session.synthesize('第二句。',new AbortController().signal,()=>{})
 socket.receive({data:{audio:'0100'}});socket.receive({event:'task_flushed'});await tick()
 assert.equal(settled,false);assert.equal(socket.sent.filter(row=>row.event==='task_continue').length,1)
 release();await first;await tick();socket.receive({data:{audio:'0200'}});socket.receive({event:'task_flushed'});await second
})

test('供应商已flush后合法播放背压不占网络等待预算',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']})
 const f=fixture(),{session,socket}=await f.ready();t.after(()=>session.close())
 let release!:()=>void,error:unknown,finished=false
 const spoken=session.synthesize('一段需要缓慢播放的回答。',new AbortController().signal,()=>new Promise<void>(resolve=>{release=resolve})).then(()=>{finished=true},reason=>{error=reason})
 socket.receive({data:{audio:'0100'}});socket.receive({event:'task_flushed'});await tick()
 t.mock.timers.tick(31000);await tick()
 assert.equal(error,undefined,'供应商已交付完成，不能把正常播放等待误判为网络超时')
 assert.equal(finished,false);assert.equal(socket.terminated,0)
 release();await spoken;assert.equal(finished,true)
})

test('拒绝非法PCM及供应商错误，错误不含密钥或供应商原文',async()=>{
 for(const packet of [{data:{audio:'0z00'}},{data:{audio:'0100'},extra_info:{audio_sample_rate:32000}},{event:'task_failed',base_resp:{status_code:1004,status_msg:'test-secret sensitive response'}}]){
  const f=fixture(),{session,socket}=await f.ready()
  const pending=session.synthesize('测试。',new AbortController().signal,()=>{throw Error('不应播放')})
  const failure=assert.rejects(pending,error=>error instanceof Error&&!/test-secret|sensitive response/.test(error.message))
  socket.receive(packet);await failure;assert.equal(socket.terminated,1);await session.close()
 }
})

test('文本与排队数量有界；单条取消排队输入不打断当前句子',async t=>{
 const f=fixture(),{session,socket}=await f.ready();t.after(()=>session.close())
 await assert.rejects(session.synthesize('a'.repeat(10000),new AbortController().signal,()=>{}))
 const one=session.synthesize('第一句。',new AbortController().signal,()=>{}),abort=new AbortController()
 const two=session.synthesize('第二句。',abort.signal,()=>{}),twoRejected=assert.rejects(two,{name:'AbortError'})
 const three=session.synthesize('第三句。',new AbortController().signal,()=>{})
 await assert.rejects(session.synthesize('第四句。',new AbortController().signal,()=>{}))
 abort.abort();await twoRejected;assert.equal(socket.sent.some(row=>row.event==='task_cancel'),false)
 socket.receive({data:{audio:'0100'}});socket.receive({event:'task_flushed'});await one;await tick()
 assert.equal(socket.sent.at(-2)?.text,'第三句。')
 socket.receive({data:{audio:'0200'}});socket.receive({event:'task_flushed'});await three
})

test('握手和取消超时有界，超时关闭连接且不把旧句自动重试',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']})
 const f=fixture();await tick();const socket=f.sockets[0];assert.ok(socket)
 t.mock.timers.tick(15000);await assert.rejects(f.pending);assert.equal(socket.terminated,1)
 const g=fixture(),{session,socket:readySocket}=await g.ready()
 const pending=session.synthesize('取消。',new AbortController().signal,()=>{}),rejected=assert.rejects(pending,{name:'AbortError'})
 const canceled=session.cancel(),timeout=assert.rejects(canceled)
 t.mock.timers.tick(15000);await timeout;await rejected
 assert.equal(readySocket.terminated,1);assert.equal(readySocket.sent.filter(row=>row.event==='task_continue').length,1)
 await session.close()
})

test('持续收到事件仍受30秒合成总时限约束',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval']})
 const f=fixture(),{session,socket}=await f.ready()
 const pending=session.synthesize('不能无限等待。',new AbortController().signal,()=>{}),rejected=assert.rejects(pending)
 for(let index=0;index<3;index++){t.mock.timers.tick(10000);socket.receive({event:'sentence_start'})}
 await rejected;assert.equal(socket.terminated,1);await session.close()
})

test('慢消费者不能导致无界音频积压，断线清理所有输入',async()=>{
 const f=fixture(),{session,socket}=await f.ready();let release!:()=>void
 const pending=session.synthesize('测试有界音频。',new AbortController().signal,()=>new Promise<void>(resolve=>{release=resolve})),rejected=assert.rejects(pending)
 const frame={data:{audio:'00'.repeat(256*1024)}}
 socket.receive(frame);await tick()
 for(let index=0;index<33;index++)socket.receive(frame)
 await rejected;assert.equal(socket.terminated,1);release();await session.close()
 const g=fixture(),{session:other,socket:peer}=await g.ready(),abort=new AbortController()
 const a=other.synthesize('第一句。',abort.signal,()=>{}),b=other.synthesize('第二句。',abort.signal,()=>{})
 const failures=Promise.all([assert.rejects(a),assert.rejects(b)])
 peer.emit('error',Error('test-secret remote detail'));await failures
 assert.equal(getEventListeners(abort.signal,'abort').length,0);await other.close()
})

test('供应商消息长度和PCM总音频长度均有界',async()=>{
 const f=fixture(),{session,socket}=await f.ready()
 const pending=session.synthesize('过长报文。',new AbortController().signal,()=>{}),rejected=assert.rejects(pending)
 socket.receive({data:{audio:'00'.repeat(1024*1024)}});await rejected;assert.equal(socket.terminated,1);await session.close()
 const g=fixture(),{session:other,socket:peer}=await g.ready()
 const total=other.synthesize('总音频不能无限增长。',new AbortController().signal,()=>{}),overflow=assert.rejects(total)
 for(let index=0;index<50&&peer.terminated===0;index++){peer.receive({data:{audio:'00'.repeat(512*1024-100)}});await tick()}
 await overflow;assert.equal(peer.terminated,1);await other.close()
})
