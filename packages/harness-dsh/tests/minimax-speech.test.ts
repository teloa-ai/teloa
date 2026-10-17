import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createMiniMaxSpeech} from '../src/minimax-speech.ts'

const stream=(parts:string[])=>new Response(new ReadableStream({start(controller){for(const part of parts)controller.enqueue(new TextEncoder().encode(part));controller.close()}}),{headers:{'content-type':'text/event-stream'}})
const frame=(status:number,audio='')=>'data: '+JSON.stringify({base_resp:{status_code:0},data:{status,audio}})+'\r\n\r\n'
test('ASR 只上传实际音频，宿主取凭据，返回可追溯识别文本',async()=>{
 const wav=Buffer.alloc(48);wav.write('RIFF');wav.write('WAVE',8)
 const speech=createMiniMaxSpeech({key:async()=> 'test-secret',fetch:async(url,options)=>{
  assert.equal(String(url),'https://api.minimax.io/v1/speech_to_text');assert.equal(new Headers(options?.headers).get('authorization'),'Bearer test-secret')
  const form=options?.body as FormData;assert.equal(form.get('model'),'asr-1.0');assert.equal(form.get('text'),null)
  assert.deepEqual(Buffer.from(await (form.get('file') as File).arrayBuffer()),wav)
  return Response.json({text:'你好。',duration:1,trace_id:'receipt-1'})
 }})
 const result=await speech.transcribe(wav,'wav',new AbortController().signal)
 assert.ok(result,'有效识别响应应返回可追溯转写')
 assert.equal(result.text,'你好。');assert.match(result.audioSha256,/^[a-f0-9]{64}$/);assert.equal(result.receiptId,'receipt-1')
})
test('流式 TTS 处理跨网络分块 SSE，只播放增量，必须收到完成帧',async()=>{
 const wire=frame(1,'010203')+frame(1,'0405')+frame(2)
 const speech=createMiniMaxSpeech({key:async()=> 'test-secret',fetch:async(url,options)=>{
  assert.equal(String(url),'https://api.minimax.io/v1/t2a_v2')
  const request=JSON.parse(String(options?.body));assert.equal(request.stream_options.exclude_aggregated_audio,true);assert.equal(request.stream,true)
  return stream([wire.slice(0,11),wire.slice(11,93),wire.slice(93)])
 }})
 const chunks:Buffer[]=[];await speech.speak('你好。',new AbortController().signal,bytes=>{chunks.push(Buffer.from(bytes))})
 assert.deepEqual(Buffer.concat(chunks),Buffer.from([1,2,3,4,5]));assert.equal(chunks.length,2)
})
test('截断、供应商异常与坏音频不能被当作播报完成，也不泄漏原始响应',async()=>{
 for(const response of [()=>stream([frame(1,'01')]),()=>stream(['data: {"base_resp":{"status_code":1004,"status_msg":"test-secret"}}\n\n']),()=>stream([frame(1,'zz')+frame(2)]),()=>new Response('test-secret',{status:401})]){
  const speech=createMiniMaxSpeech({key:async()=> 'test-secret',fetch:async()=>response()})
  await assert.rejects(speech.speak('测试',new AbortController().signal,()=>{}),error=>error instanceof Error&&!error.message.includes('test-secret'))
 }
})
test('取消或未配置凭据不发请求；音频类型与长度不能由输入绕过',async()=>{
 let calls=0;const speech=createMiniMaxSpeech({key:async()=> undefined,fetch:async()=>{calls++;throw Error()}})
 await assert.rejects(speech.speak('测试',new AbortController().signal,()=>{}))
 await assert.rejects(speech.transcribe(Buffer.from('bad'),'wav',new AbortController().signal))
 const abort=new AbortController();abort.abort();await assert.rejects(speech.speak('测试',abort.signal,()=>{}));assert.equal(calls,0)
})
test('取消等待中的音频流立即释放读取器，不播报迟到内容',async()=>{
 let cancelled=false,opened!:()=>void
 const ready=new Promise<void>(resolve=>{opened=resolve}),abort=new AbortController()
 const speech=createMiniMaxSpeech({key:async()=> 'test-secret',fetch:async()=>{opened();return new Response(new ReadableStream({cancel(){cancelled=true}}),{headers:{'content-type':'text/event-stream'}})}})
 const output:Uint8Array[]=[];const pending=speech.speak('测试',abort.signal,bytes=>{output.push(bytes)})
 await ready;await new Promise(resolve=>setImmediate(resolve));abort.abort()
 await assert.rejects(pending);assert.equal(cancelled,true);assert.deepEqual(output,[])
})
