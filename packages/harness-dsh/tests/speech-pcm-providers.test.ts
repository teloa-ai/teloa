import test from 'node:test'
import assert from 'node:assert/strict'
import {createSpeechProviders} from '../src/speech-providers.ts'

test('OpenAI、ElevenLabs 按官方格式输出 24k PCM，分块保持原始字节',async()=>{
 for(const id of ['openai','elevenlabs'] as const){
  const calls:Array<{url:string;body:Record<string,unknown>}> = []
  const providers=createSpeechProviders({key:async provider=>provider===id?'test-only-key':undefined,fetch:(async(url,init)=>{
   calls.push({url:String(url),body:JSON.parse(String(init?.body))})
   return new Response(new ReadableStream({start(controller){controller.enqueue(Uint8Array.of(1,2,3));controller.enqueue(Uint8Array.of(4));controller.close()}}),{headers:{'content-type':'audio/pcm'}})
  }) as typeof fetch})
  const parts:Uint8Array[]=[]
  await providers[id].speakPcm('你好。',{model:id==='openai'?'gpt-4o-mini-tts':'eleven_flash_v2_5',voiceId:'coral'},new AbortController().signal,bytes=>{parts.push(bytes)})
  assert.deepEqual(Buffer.concat(parts),Buffer.from([1,2,3,4]))
  if(id==='openai')assert.deepEqual(calls[0]?.body,{model:'gpt-4o-mini-tts',voice:'coral',input:'你好。',response_format:'pcm',stream_format:'audio'})
  else assert.equal(new URL(calls[0]!.url).searchParams.get('output_format'),'pcm_24000')
 }
})

test('PCM 拒绝 JSON 错误、空音频、半个采样和超过上限；取消不吞掉',async()=>{
 for(const [type,size] of [['application/json',4],['audio/pcm',0],['audio/pcm',3],['audio/pcm',20*1024*1024+2]] as const){
  const providers=createSpeechProviders({key:async()=>'test-only-key',fetch:(async()=>new Response(new Uint8Array(size),{headers:{'content-type':type}})) as typeof fetch})
  await assert.rejects(providers.openai.speakPcm('你好。',{model:'gpt-4o-mini-tts',voiceId:'coral'},new AbortController().signal,()=>{}),/语音服务暂不可用/)
 }
 const control=new AbortController(),reason=Error('cancelled by owner')
 const providers=createSpeechProviders({key:async()=>'test-only-key',fetch:(async()=>new Response(Uint8Array.of(1,2),{headers:{'content-type':'audio/pcm'}})) as typeof fetch})
 await assert.rejects(providers.elevenlabs.speakPcm('你好。',{model:'eleven_flash_v2_5',voiceId:'coral'},control.signal,()=>control.abort(reason)),error=>error===reason)
})
