import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {createBrowserVoiceMedia} from '../src/browser-voice-media.ts'
const owner='owner',context={ownerId:owner,roleId:randomUUID(),roleKind:'employee' as const,roleVersion:1,sessionId:'original',scope:'general'}
const fixture=(providerId?:'minimax'|'sensevoice-local')=>{
 let transcriptions=0,spoken=0
 const media=createBrowserVoiceMedia({configured:async()=>true,speech:{async transcribe(audio){transcriptions++;return {text:'你好',audioSha256:createHash('sha256').update(audio).digest('hex'),receiptId:'supplier-receipt',...(providerId?{providerId}:{})}},async speak(_text,_signal,audio){spoken++;await audio(new Uint8Array([255,251,1,2]))}}})
 const abort=new AbortController(),events:unknown[]=[],input={callId:randomUUID(),callGeneration:randomUUID(),roleContext:context,signal:abort.signal,onEvent:(event:unknown)=>events.push(event)}
 const pending=media.transport.connect(input),identity={callId:input.callId,callGeneration:input.callGeneration}
 const snapshot=media.snapshot(identity)!,bound={...identity,token:snapshot.token}
 return {media,abort,pending,events,bound,input,get transcriptions(){return transcriptions},get spoken(){return spoken}}
}
test('真实浏览器握手前不接通；错世代与令牌不能确认或上传',async()=>{
 const f=fixture();let connected=false;void f.pending.then(()=>connected=true)
 await Promise.resolve();assert.equal(connected,false)
 assert.throws(()=>f.media.ready({...f.bound,token:randomUUID()}))
 assert.throws(()=>f.media.ready({...f.bound,callGeneration:randomUUID()}))
 f.media.ready(f.bound);const connection=await f.pending;assert.equal(connected,true)
 f.media.closed(f.bound);await connection.close();f.media.dispose()
})
test('宿主自产转写封口，重复轮次只识别一次；改音频拒绝；静音不上传',async()=>{
 const f=fixture();f.media.ready(f.bound);const connection=await f.pending
 const turn={...f.bound,turnId:randomUUID(),audio:Buffer.from('wave').toString('base64')}
 const seal=await f.media.transcribe(turn);assert.equal(seal?.source.sttReceiptId,'supplier-receipt');assert.equal(seal?.sessionId,'original');assert.equal(f.transcriptions,1)
 assert.equal(await f.media.transcribe(turn),seal);assert.equal(f.transcriptions,1)
 await assert.rejects(f.media.transcribe({...turn,audio:Buffer.from('changed').toString('base64')}))
 await connection.setMuted!({muted:true,callGeneration:f.bound.callGeneration})
 await assert.rejects(f.media.transcribe({...turn,turnId:randomUUID()}));assert.equal(f.transcriptions,1)
 f.media.closed(f.bound);await connection.close();f.media.dispose()
})
test('本机识别封口如实记录来源，不冒充MiniMax云端回执',async()=>{
 const f=fixture('sensevoice-local');f.media.ready(f.bound);const connection=await f.pending
 try{const seal=await f.media.transcribe({...f.bound,turnId:randomUUID(),audio:Buffer.from('wave').toString('base64')});assert.equal(seal?.source.providerId,'sensevoice-local')}
 finally{f.media.closed(f.bound);await connection.close();f.media.dispose()}
})
test('播报只在实际播放回执后标 playing，插话取消旧音频；关闭必须有浏览器回执',async()=>{
 const f=fixture();f.media.ready(f.bound);const connection=await f.pending
 await connection.enqueueSpeech!({utteranceId:randomUUID(),text:'原回复',callGeneration:f.bound.callGeneration,playbackGeneration:1})
 assert.equal(f.events.length,0);assert.equal(f.media.snapshot({callId:f.bound.callId,callGeneration:f.bound.callGeneration})!.speech?.audio,Buffer.from([255,251,1,2]).toString('base64'))
 f.media.playback({...f.bound,playbackGeneration:1,state:'playing'});assert.equal(f.events.length,1)
 await connection.interruptPlayback({playbackGeneration:2});assert.equal(f.media.snapshot({callId:f.bound.callId,callGeneration:f.bound.callGeneration})!.speech,null)
 f.media.playback({...f.bound,playbackGeneration:1,state:'playing'});assert.equal(f.events.length,1)
 let closed=false;const pending=connection.close().then(()=>{closed=true});await Promise.resolve();assert.equal(closed,false)
 f.media.closed(f.bound);await pending;assert.equal(closed,true);f.media.dispose()
})

test('媒体尚在准备时返回空快照，不能把预约与浏览器绑定间的间隙判成断线',()=>{
 const media=createBrowserVoiceMedia({configured:async()=>true,speech:{async transcribe(){return null},async speak(){}}})
 assert.equal(media.snapshot({callId:randomUUID(),callGeneration:randomUUID()}),null)
 media.dispose()
})

test('浏览器已确认停止录音而结束 RPC 丢失时，只回收已关闭媒体，不能抢占活跃通话',async()=>{
 const f=fixture();f.media.ready(f.bound);const connection=await f.pending
 assert.deepEqual(f.media.inactiveCalls(),[])
 f.media.closed(f.bound)
 assert.deepEqual(f.media.inactiveCalls(),[{callId:f.bound.callId,callGeneration:f.bound.callGeneration}])
 await assert.rejects(f.media.transcribe({...f.bound,turnId:randomUUID(),audio:Buffer.from('wave').toString('base64')}))
 await connection.close();f.media.dispose()
})

test('失活租约终止宿主 IO 并允许旧关闭重试；不能误回收仍在心跳的媒体',async()=>{
 const f=fixture();f.media.ready(f.bound);const connection=await f.pending
 const now=Date.now
 try{
  Date.now=()=>now()+20000
  await new Promise<void>(resolve=>setTimeout(resolve,2100))
  assert.equal(f.media.inactiveCalls().length,1)
  await assert.rejects(f.media.transcribe({...f.bound,turnId:randomUUID(),audio:Buffer.from('wave').toString('base64')}))
  await connection.close()
 }finally{Date.now=now;f.media.dispose()}
 const active=fixture();active.media.ready(active.bound);const live=await active.pending
 assert.equal(active.media.inactiveCalls().length,0);active.media.closed(active.bound);await live.close();active.media.dispose()
})
