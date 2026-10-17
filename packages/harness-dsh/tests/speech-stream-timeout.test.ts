import test from 'node:test'
import assert from 'node:assert/strict'
import {createSpeechProviders} from '../src/speech-providers.ts'

const ids=['minimax','openai','elevenlabs'] as const
const voice={model:'test-model',voiceId:'test-voice'}
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}
const frame=(status:number,audio='')=>'data: '+JSON.stringify({base_resp:{status_code:0},data:{status,audio}})+'\n\n'
function fakeNetworkClock(t:import('node:test').TestContext){
 t.mock.timers.enable({apis:['setTimeout']})
 // Node 的原生 AbortSignal.timeout 不使用 mock 时钟；只替换其时钟来源，保留真实取消信号。
 t.mock.method(AbortSignal,'timeout',(milliseconds:number)=>{
  const controller=new AbortController()
  setTimeout(()=>controller.abort(new DOMException('Network timed out','TimeoutError')),milliseconds)
  return controller.signal
 })
}

for(const id of ids){
 test(id+' 的播放背压超过网络空闲上限仍完整输出后续音频',async t=>{
  fakeNetworkClock(t)
  const entered=gate(),release=gate(),parts:Uint8Array[]=[]
  const providers=createSpeechProviders({key:async()=> 'synthetic-only-key',fetch:async()=>id==='minimax'
   ?new Response(frame(1,'0100')+frame(1,'0200')+frame(2),{headers:{'content-type':'text/event-stream'}})
   :new Response(new ReadableStream({start(controller){controller.enqueue(Uint8Array.of(1,0));controller.enqueue(Uint8Array.of(2,0));controller.close()}}),{headers:{'content-type':'audio/pcm'}})})
  const pending=providers[id].speakPcm('合成回复。',voice,new AbortController().signal,async bytes=>{
   parts.push(Uint8Array.from(bytes))
   if(parts.length===1){entered.resolve();await release.promise}
  })
  void pending.catch(()=>{})
  await entered.promise
  t.mock.timers.tick(61000)
  release.resolve()
  await assert.doesNotReject(pending)
  assert.deepEqual(Buffer.concat(parts),Buffer.from([1,0,2,0]))
 })

 test(id+' 的真实网络空闲仍超时并停止读取',async t=>{
  fakeNetworkClock(t)
  let cancelled=false
  const entered=gate(),output:Uint8Array[]=[]
  const providers=createSpeechProviders({key:async()=> 'synthetic-only-key',fetch:async()=>{
   entered.resolve()
   return new Response(new ReadableStream({cancel(){cancelled=true}}),{headers:{'content-type':id==='minimax'?'text/event-stream':'audio/pcm'}})
  }})
  const pending=providers[id].speakPcm('合成回复。',voice,new AbortController().signal,bytes=>{output.push(bytes)})
  void pending.catch(()=>{})
  await entered.promise;await new Promise(resolve=>setImmediate(resolve))
  t.mock.timers.tick(60000)
  await assert.rejects(pending,/语音服务暂不可用/)
  assert.equal(cancelled,true);assert.deepEqual(output,[])
 })

 test(id+' 等待响应头时超时与本人取消均中止原请求',async t=>{
  fakeNetworkClock(t)
  for(const cancel of [false,true]){
   const entered=gate(),control=new AbortController(),reason=Error('owner stopped media')
   let requestSignal:AbortSignal|undefined
   const providers=createSpeechProviders({key:async()=> 'synthetic-only-key',fetch:async(_url,init)=>{
    requestSignal=init?.signal as AbortSignal;entered.resolve()
    return new Promise((_resolve,reject)=>requestSignal!.addEventListener('abort',()=>reject(requestSignal!.reason),{once:true}))
   }})
   const pending=providers[id].speakPcm('合成回复。',voice,control.signal,()=>assert.fail('未收到响应头不能输出音频'))
   void pending.catch(()=>{})
   await entered.promise
   if(cancel)control.abort(reason);else t.mock.timers.tick(60000)
   await assert.rejects(pending,error=>cancel?error===reason:error instanceof Error&&/语音服务暂不可用/.test(error.message))
   assert.equal(requestSignal?.aborted,true)
  }
 })
}
