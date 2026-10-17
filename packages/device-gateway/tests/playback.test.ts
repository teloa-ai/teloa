import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createPlaybackChannel} from '../src/playback.ts'
import {createAudioReceiver,type HostControl} from '../src/protocol.ts'

const captureId='4c35115b-5dad-4d18-a5f3-c8ed8884e404'
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))
function fixture(){
 const messages:HostControl[]=[],frames:Uint8Array[]=[],life=new AbortController()
 let stream=0
 const channel=createPlaybackChannel({connectionGeneration:7,allocateStream:()=>++stream,assertCurrent:()=>life.signal.throwIfAborted(),signal:life.signal,
  sendControl:message=>{messages.push(message)},sendAudio:async bytes=>{frames.push(bytes)}})
 return {channel,messages,frames,life}
}
test('播放等待设备就绪、仅提前两秒，并等待真正播完回执',async()=>{
 const f=fixture();let produced=0
 async function* packets(){for(let n=0;n<35;n++){produced++;yield Uint8Array.of(0xf8,0xff,0xfe)}}
 const playing=f.channel.play({captureId,text:'真实结果',packets:()=>packets()})
 await tick();assert.equal(produced,0);assert.equal(f.frames.length,0)
 f.channel.accept({type:'playback.ready',streamId:1});await tick()
 assert.equal(f.frames.length,33);assert.ok(produced<=34)
 f.channel.accept({type:'playback.progress',streamId:1,sequence:1});await tick()
 assert.equal(f.frames.length,35)
 assert.deepEqual(f.messages.at(-1),{type:'playback.end',streamId:1,lastSequence:34})
 const receiver=createAudioReceiver({kind:2,connectionGeneration:7,streamId:1})
 f.frames.forEach(frame=>assert.deepEqual(receiver.accept(frame),Uint8Array.of(0xf8,0xff,0xfe)))
 let completed=false;void playing.then(()=>{completed=true});await tick();assert.equal(completed,false)
 f.channel.accept({type:'playback.played',streamId:1,lastSequence:34});await playing;assert.equal(completed,true)
})
test('打断释放背压等待，迟到就绪/播完不能复活旧流',async()=>{
 const f=fixture();let closed=false
 async function* packets(){try{for(let n=0;n<40;n++)yield Uint8Array.of(1)}finally{closed=true}}
 const playing=f.channel.play({captureId,text:'结果',packets:()=>packets()});void playing.catch(()=>{})
 f.channel.accept({type:'playback.ready',streamId:1});await tick();assert.equal(f.frames.length,33)
 f.channel.interrupt();await assert.rejects(playing)
 await tick();assert.equal(closed,true)
 assert.equal(f.channel.accept({type:'playback.ready',streamId:1}),false)
 assert.equal(f.channel.accept({type:'playback.played',streamId:1,lastSequence:32}),false)
 assert.equal(f.frames.length,33)
})
test('伪造进度、提前播完和另一条流回执被拒绝',async()=>{
 const f=fixture();async function* packets(){yield Uint8Array.of(1)}
 const playing=f.channel.play({captureId,text:'结果',packets:()=>packets()});void playing.catch(()=>{})
 assert.throws(()=>f.channel.accept({type:'playback.played',streamId:1,lastSequence:0}))
 assert.throws(()=>f.channel.accept({type:'playback.ready',streamId:2}))
 f.channel.accept({type:'playback.ready',streamId:1});await tick()
 assert.throws(()=>f.channel.accept({type:'playback.progress',streamId:1,sequence:1}))
 f.channel.interrupt();await assert.rejects(playing)
})
test('撤销时中止未就绪或卡住的输出，不再发送媒体',async()=>{
 const f=fixture();async function* packets(){await new Promise(()=>{});yield Uint8Array.of(1)}
 const playing=f.channel.play({captureId,text:'结果',packets:()=>packets()});void playing.catch(()=>{})
 f.channel.accept({type:'playback.ready',streamId:1});await tick();f.life.abort()
 await assert.rejects(playing);assert.equal(f.frames.length,0)
})
test('部分音频发出后合成源失败，设备必须收到中断',async()=>{
 const f=fixture();async function* packets(){yield Uint8Array.of(1);throw new Error('source')}
 const playing=f.channel.play({captureId,text:'结果',packets:()=>packets()});void playing.catch(()=>{})
 f.channel.accept({type:'playback.ready',streamId:1});await assert.rejects(playing)
 assert.equal(f.frames.length,1)
 assert.deepEqual(f.messages.at(-1),{type:'playback.interrupted',streamId:1})
 assert.equal(f.channel.active,false)
})
