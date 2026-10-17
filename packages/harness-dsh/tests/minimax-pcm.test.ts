import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createMiniMaxSpeech} from '../src/minimax-speech.ts'

const frame=(status:number,audio='')=>'data: '+JSON.stringify({base_resp:{status_code:0},data:{status,audio}})+'\r\n\r\n'
const stream=(parts:string[])=>new Response(new ReadableStream({start(controller){for(const part of parts)controller.enqueue(new TextEncoder().encode(part));controller.close()}}),{headers:{'content-type':'text/event-stream'}})

test('PCM合成请求固定24kHz单声道并逐块输出，原MP3请求保持不变',async()=>{
 const requests:Record<string,unknown>[]=[]
 const wire=frame(1,'01020304')+frame(1,'0506')+frame(2)
 const speech=createMiniMaxSpeech({key:async()=> 'test-secret',fetch:async(url,options)=>{
  assert.equal(String(url),'https://api.minimax.io/v1/t2a_v2')
  assert.equal(new Headers(options?.headers).get('authorization'),'Bearer test-secret')
  requests.push(JSON.parse(String(options?.body)))
  return stream([wire.slice(0,29),wire.slice(29,130),wire.slice(130)])
 }})
 const chunks:Uint8Array[]=[]
 await speech.speakPcm('你好。',new AbortController().signal,bytes=>{chunks.push(Uint8Array.from(bytes))},{model:'speech-2.8-hd',voiceId:'Chinese (Mandarin)_Warm_Bestie'})
 assert.deepEqual(Buffer.concat(chunks),Buffer.from([1,2,3,4,5,6]));assert.equal(chunks.length,2)
 assert.deepEqual(requests[0]?.audio_setting,{format:'pcm',sample_rate:24000,channel:1})
 assert.equal(requests[0]?.model,'speech-2.8-hd');assert.deepEqual(requests[0]?.stream_options,{exclude_aggregated_audio:true})
 await speech.speak('你好。',new AbortController().signal,()=>{})
 assert.deepEqual(requests[1]?.audio_setting,{sample_rate:32000,bitrate:128000,format:'mp3',channel:1})
})
test('PCM与MP3共享完成校验、帧限额和供应商错误脱敏',async()=>{
 for(const response of [()=>stream([frame(1,'0102')]),()=>stream([frame(1,'zz')+frame(2)]),()=>stream([frame(2,'0102')]),()=>stream(['data: '+JSON.stringify({base_resp:{status_code:1004,status_msg:'test-secret'},data:{status:1}})+'\n\n']),()=>stream(['data: '+ 'x'.repeat(1024*1024)+'\n\n']),()=>new Response('test-secret',{status:401})]){
  const speech=createMiniMaxSpeech({key:async()=> 'test-secret',fetch:async()=>response()})
  await assert.rejects(speech.speakPcm('测试',new AbortController().signal,()=>{}),error=>error instanceof Error&&!error.message.includes('test-secret'))
 }
})
test('PCM取消等待中的流立即关闭读取器且不播放迟到音频',async()=>{
 let opened!:()=>void,cancelled=false
 const ready=new Promise<void>(resolve=>{opened=resolve}),abort=new AbortController(),output:Uint8Array[]=[]
 const speech=createMiniMaxSpeech({key:async()=> 'test-secret',fetch:async()=>{opened();return new Response(new ReadableStream({cancel(){cancelled=true}}),{headers:{'content-type':'text/event-stream'}})}})
 const pending=speech.speakPcm('测试',abort.signal,bytes=>{output.push(bytes)})
 await ready;await new Promise(resolve=>setImmediate(resolve));abort.abort()
 await assert.rejects(pending);assert.equal(cancelled,true);assert.deepEqual(output,[])
})
test('PCM合成缺少凭据、预先取消及超长文本均不发请求',async()=>{
 let calls=0
 const speech=createMiniMaxSpeech({key:async()=>undefined,fetch:async()=>{calls++;throw Error()}}),abort=new AbortController();abort.abort()
 await assert.rejects(speech.speakPcm('测试',new AbortController().signal,()=>{}))
 await assert.rejects(speech.speakPcm('测试',abort.signal,()=>{}))
 await assert.rejects(speech.speakPcm('x'.repeat(10000),new AbortController().signal,()=>{}))
 assert.equal(calls,0)
})
