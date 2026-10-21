import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {readVoiceServiceProbe,readVoiceServiceSettings,type SpeechProviderId} from '@teloa/contract'
import {createSpeechProviders,splitSpeechText} from '../src/speech-providers.ts'
import {createVoiceServiceConfig} from '../src/voice-service-config.ts'
import {createVoiceService} from '../src/voice-service.ts'
import {createBrowserVoiceMedia} from '../src/browser-voice-media.ts'

// N34：多厂商语音播报。三家都按官方协议发真实形状的请求（只用本地替身 fetch，不发生收费调用）；
// 各厂商凭据独立、不复用模型密钥；模型与音色按厂商持久化；云端识别用例显式选择 MiniMax。
type Call={url:string;init:RequestInit&{headers:Record<string,string>}}
const mp3=Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000fake-mp3-frame')
const audioResponse=(bytes:Uint8Array=mp3,type='audio/mpeg')=>new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,5));controller.enqueue(bytes.subarray(5));controller.close()}}),{status:200,headers:{'content-type':type}})
const miniMaxResponse=()=>new Response(new ReadableStream({start(controller){const encoder=new TextEncoder();controller.enqueue(encoder.encode('data: '+JSON.stringify({base_resp:{status_code:0},data:{status:1,audio:mp3.toString('hex')}})+'\n\n'));controller.enqueue(encoder.encode('data: '+JSON.stringify({base_resp:{status_code:0},data:{status:2}})+'\n\n'));controller.close()}}),{status:200,headers:{'content-type':'text/event-stream'}})
const keys:Record<SpeechProviderId,string>={minimax:'secret-minimax-voice',openai:'secret-openai-voice',elevenlabs:'secret-eleven-voice'}
function recorder(respond:(call:Call)=>Response|Promise<Response>=call=>call.url.includes('minimax')?miniMaxResponse():audioResponse()){
 const calls:Call[]=[]
 const fetch=(async(url:string|URL,init:RequestInit={})=>{const call={url:String(url),init:init as Call['init']};calls.push(call);return respond(call)}) as typeof globalThis.fetch
 return {calls,fetch}
}
const collect=async(run:(onAudio:(bytes:Uint8Array)=>void)=>Promise<void>)=>{const parts:Uint8Array[]=[];await run(bytes=>{parts.push(Uint8Array.from(bytes))});return Buffer.concat(parts)}

test('三家播报按官方协议请求：固定官方域名、各自鉴权头与可配置的模型音色',async()=>{
 const {calls,fetch}=recorder(),providers=createSpeechProviders({key:async id=>keys[id],fetch})
 const signal=new AbortController().signal
 assert.deepEqual(await collect(on=>providers.openai.speak('你好，我是 Teloa。',{model:'gpt-4o-mini-tts',voiceId:'coral'},signal,on)),mp3)
 assert.deepEqual(await collect(on=>providers.elevenlabs.speak('你好，我是 Teloa。',{model:'eleven_multilingual_v2',voiceId:'JBFqnCBsd6RMkjVDRZzb'},signal,on)),mp3)
 assert.deepEqual(await collect(on=>providers.minimax.speak('你好，我是 Teloa。',{model:'speech-02-hd',voiceId:'female-shaonv'},signal,on)),mp3)
 const [openai,eleven,minimax]=calls
 assert.equal(openai!.url,'https://api.openai.com/v1/audio/speech');assert.equal(openai!.init.method,'POST');assert.equal(openai!.init.redirect,'error')
 assert.equal(openai!.init.headers.Authorization,'Bearer '+keys.openai);assert.equal(openai!.init.headers['Content-Type'],'application/json')
 assert.deepEqual(JSON.parse(String(openai!.init.body)),{model:'gpt-4o-mini-tts',voice:'coral',input:'你好，我是 Teloa。',response_format:'mp3',stream_format:'audio'})
 assert.equal(eleven!.url,'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=mp3_44100_128');assert.equal(eleven!.init.method,'POST');assert.equal(eleven!.init.redirect,'error')
 assert.equal(eleven!.init.headers['xi-api-key'],keys.elevenlabs);assert.equal(eleven!.init.headers.Authorization,undefined)
 assert.deepEqual(JSON.parse(String(eleven!.init.body)),{text:'你好，我是 Teloa。',model_id:'eleven_multilingual_v2'})
 assert.equal(minimax!.url,'https://api.minimax.io/v1/t2a_v2');assert.equal(minimax!.init.headers.Authorization,'Bearer '+keys.minimax)
 const body=JSON.parse(String(minimax!.init.body));assert.equal(body.model,'speech-02-hd');assert.equal(body.voice_setting.voice_id,'female-shaonv');assert.equal(body.stream,true)
 // OpenAI 自定义音色按官方对象形式发送
 await collect(on=>providers.openai.speak('好。',{model:'gpt-4o-mini-tts',voiceId:'voice_1234'},signal,on));assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)).voice,{id:'voice_1234'})
})

test('凭据按厂商隔离：缺少该厂商凭据即失败且不发请求，不借用其他厂商或模型密钥',async()=>{
 const {calls,fetch}=recorder(),providers=createSpeechProviders({key:async id=>id==='minimax'?keys.minimax:undefined,fetch})
 for(const id of ['openai','elevenlabs'] as const)await assert.rejects(providers[id].speak('你好。',{model:'m',voiceId:'v'},new AbortController().signal,()=>{}),error=>error instanceof Error&&!/secret/.test(error.message))
 assert.equal(calls.length,0)
 await providers.minimax.speak('你好。',{model:'speech-2.8-turbo',voiceId:'male-qn-qingse'},new AbortController().signal,()=>{})
 assert.deepEqual(calls.map(call=>call.init.headers.Authorization),['Bearer '+keys.minimax])
})

test('OpenAI 单次输入上限 4096：按句切段逐段请求、全文不丢；单句超限明确失败',async()=>{
 const sentence='这是一句用于验证分段播报的较长测试句子，内容不能被截断或丢弃。'
 const text=Array.from({length:260},(_,index)=>sentence+index+'。').join('')
 assert.ok(text.length>8192)
 const segments=splitSpeechText(text,4096);assert.ok(segments.length>=3);assert.equal(segments.join(''),text);assert.ok(segments.every(part=>part.length<=4096))
 const {calls,fetch}=recorder(),providers=createSpeechProviders({key:async id=>keys[id],fetch})
 const audio=await collect(on=>providers.openai.speak(text,{model:'gpt-4o-mini-tts',voiceId:'alloy'},new AbortController().signal,on))
 assert.equal(calls.length,segments.length);assert.deepEqual(calls.map(call=>JSON.parse(String(call.init.body)).input),segments)
 assert.equal(audio.length,mp3.length*segments.length)
 const before=calls.length
 await assert.rejects(providers.openai.speak('长'.repeat(5000),{model:'gpt-4o-mini-tts',voiceId:'alloy'},new AbortController().signal,()=>{}),/过长|无法分段/)
 assert.equal(calls.length,before,'无法按句切分时不发请求、不静默截断')
})

test('取消、超限音频、非音频回包与流错误都失败且不泄露凭据',async()=>{
 const aborted=new AbortController();aborted.abort()
 const idle=recorder(),providers=createSpeechProviders({key:async id=>keys[id],fetch:idle.fetch})
 for(const id of ['openai','elevenlabs'] as const)await assert.rejects(providers[id].speak('你好。',{model:'m',voiceId:'v'},aborted.signal,()=>{}))
 assert.equal(idle.calls.length,0,'已取消不发请求')
 const failures:Array<()=>Response>=[
  ()=>new Response(JSON.stringify({error:{message:'invalid key '+keys.openai}}),{status:401,headers:{'content-type':'application/json'}}),
  ()=>new Response('{"detail":"oops"}',{status:200,headers:{'content-type':'application/json'}}),
  ()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(4));controller.error(new Error('stream reset '+keys.openai))}}),{status:200,headers:{'content-type':'audio/mpeg'}}),
  ()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024*1024).fill(255))}}),{status:200,headers:{'content-type':'audio/mpeg'}}),
 ]
 for(const respond of failures)for(const id of ['openai','elevenlabs'] as const){
  const broken=createSpeechProviders({key:async provider=>keys[provider],fetch:recorder(respond).fetch})
  await assert.rejects(broken[id].speak('你好。',{model:'m',voiceId:'v'},new AbortController().signal,()=>{}),error=>error instanceof Error&&!Object.values(keys).some(key=>error.message.includes(key)))
 }
 // 进行中取消：中止读取并以取消结束
 let cancelled=false
 const stalled=createSpeechProviders({key:async id=>keys[id],fetch:recorder(()=>new Response(new ReadableStream({start(controller){controller.enqueue(mp3)},cancel(){cancelled=true}}),{status:200,headers:{'content-type':'audio/mpeg'}})).fetch})
 const control=new AbortController(),pending=stalled.elevenlabs.speak('你好。',{model:'m',voiceId:'v'},control.signal,()=>{control.abort()})
 await assert.rejects(pending);assert.equal(cancelled,true)
})

async function harness(){
 const dir=await mkdtemp(join(tmpdir(),'teloa-voice-service-'))
 const stored=new Map<SpeechProviderId,string>(),events:string[]=[]
 const credentials={describe:async(id:SpeechProviderId)=>({configured:stored.has(id),writable:true}),set:async(id:SpeechProviderId,value:string)=>{events.push('set:'+id);stored.set(id,value)},resolve:async(id:SpeechProviderId)=>stored.get(id)}
 const {calls,fetch}=recorder()
 const transcriptions:number[]=[]
 const make=()=>createVoiceService({credentials,secure:()=>true,config:createVoiceServiceConfig(join(dir,'voice-service.json')),fetch,transcribe:async()=>{transcriptions.push(1);return null}})
 return {dir,stored,events,calls,transcriptions,make,dispose:()=>rm(dir,{recursive:true,force:true})}
}

test('接通预热仅唤醒已选择的本机识别，不调用云端或改变识别设置',async t=>{
 const h=await harness();t.after(h.dispose)
 const config=createVoiceServiceConfig(join(h.dir,'voice-service.json'));let warmed=0,previews=0
 await config.update(current=>({...current,asrProviderId:'minimax'}))
 const service=createVoiceService({credentials:{describe:async()=>({configured:true,writable:true}),set:async()=>{},resolve:async()=>{throw Error('预热不能解析云凭据')}},secure:()=>true,config,fetch:async()=>{throw Error('预热不能请求云端')},localRecognition:{configured:()=>true,transcribe:async()=>{previews++;return null},async warm(signal){signal.throwIfAborted();warmed++}}})
 await service.speech.warm!(new AbortController().signal);assert.equal(warmed,0)
 await service.speech.prepareRecognition!(new Uint8Array(),'wav',new AbortController().signal);assert.equal(previews,0)
 await config.update(current=>({...current,asrProviderId:'sensevoice-local'}))
 await service.speech.warm!(new AbortController().signal);assert.equal(warmed,1)
 await service.speech.prepareRecognition!(new Uint8Array(),'wav',new AbortController().signal);assert.equal(previews,1)
 assert.equal((await config.read()).asrProviderId,'sensevoice-local')
 const aborted=new AbortController();aborted.abort()
 await assert.rejects(service.speech.warm!(aborted.signal));assert.equal(warmed,1)
})

test('设置：新装本机识别可显式选择 MiniMax；重开保留厂商、模型与音色；凭据只写不读',async t=>{
 const h=await harness();t.after(h.dispose)
 let service=h.make()
 const initial=readVoiceServiceSettings(await service.handler('voice-service/settings',{}))
 assert.equal(initial.providerId,'minimax');assert.equal(initial.configured,false);assert.equal(initial.model,'speech-2.8-turbo');assert.equal(initial.voiceId,'male-qn-qingse');assert.equal(initial.asr.configured,false)
 assert.equal(initial.asr.providerId,'sensevoice-local')
 await service.handler('voice-service/save',{asrProviderId:'minimax'})
 // 旧客户端只送 {apiKey}：写入 MiniMax 凭据，不改当前播报厂商
 const legacy=readVoiceServiceSettings(await service.handler('voice-service/save',{apiKey:keys.minimax}))
 assert.equal(legacy.providerId,'minimax');assert.equal(legacy.configured,true);assert.equal(legacy.asr.configured,true);assert.equal(h.stored.get('minimax'),keys.minimax)
 // 独立 ASR 配置：setDefault:false 只保存该厂商
 const eleven=readVoiceServiceSettings(await service.handler('voice-service/save',{providerId:'elevenlabs',model:'eleven_flash_v2_5',voiceId:'21m00Tcm4TlvDq8ikWAM',apiKey:keys.elevenlabs,setDefault:false}))
 assert.equal(eleven.providerId,'minimax');assert.deepEqual(eleven.providers.find(row=>row.id==='elevenlabs'),{id:'elevenlabs',name:'ElevenLabs',configured:true,model:'eleven_flash_v2_5',voiceId:'21m00Tcm4TlvDq8ikWAM'})
 const openai=readVoiceServiceSettings(await service.handler('voice-service/save',{providerId:'openai',model:'gpt-4o-mini-tts',voiceId:'coral',apiKey:keys.openai}))
 assert.equal(openai.providerId,'openai');assert.equal(openai.configured,true);assert.equal(openai.model,'gpt-4o-mini-tts');assert.equal(openai.voiceId,'coral')
 for(const value of [initial,legacy,eleven,openai])assert.equal(Object.values(keys).some(key=>JSON.stringify(value).includes(key)),false,'回包不含凭据')
 const file=await readFile(join(h.dir,'voice-service.json'),'utf8');assert.equal(Object.values(keys).some(key=>file.includes(key)),false,'非秘密配置文件不含凭据')
 service=h.make()
 const reopened=readVoiceServiceSettings(await service.handler('voice-service/settings',{}))
 assert.deepEqual(reopened,openai,'重开后读到同一选择')
 // 只改模型音色、不带新密钥：保留原凭据
 const retuned=readVoiceServiceSettings(await service.handler('voice-service/save',{providerId:'openai',model:'tts-1-hd',voiceId:'nova'}))
 assert.equal(retuned.model,'tts-1-hd');assert.equal(retuned.voiceId,'nova');assert.equal(h.stored.get('openai'),keys.openai)
})

test('设置失败边界：无凭据不能设为当前厂商、存储不安全不写密钥、任意参数与未知厂商被拒',async t=>{
 const h=await harness();t.after(h.dispose)
 const service=h.make()
 await assert.rejects(service.handler('voice-service/save',{providerId:'openai',model:'gpt-4o-mini-tts',voiceId:'alloy'}),/凭据|API Key/)
 await assert.rejects(service.handler('voice-service/save',{providerId:'azure',model:'m',voiceId:'v',apiKey:'k'}))
 await assert.rejects(service.handler('voice-service/save',{providerId:'openai',model:'https://evil.example',voiceId:'alloy',apiKey:keys.openai}))
 await assert.rejects(service.handler('voice-service/save',{providerId:'openai',model:'gpt-4o-mini-tts',voiceId:'alloy',apiKey:keys.openai,url:'https://evil.example'}))
 await assert.rejects(service.handler('voice-service/settings',{providerId:'openai'}))
 await assert.rejects(service.handler('voice-service/test',{}))
 assert.equal(h.stored.size,0)
 const insecure=createVoiceService({credentials:{describe:async()=>({configured:false,writable:true}),set:async()=>{throw Error('should not write')},resolve:async()=>undefined},secure:()=>false,config:createVoiceServiceConfig(join(h.dir,'other.json')),fetch:recorder().fetch,transcribe:async()=>null})
 await assert.rejects(insecure.handler('voice-service/save',{providerId:'openai',model:'gpt-4o-mini-tts',voiceId:'alloy',apiKey:keys.openai}),error=>error instanceof Error&&!error.message.includes(keys.openai))
 // 已取消的保存不落盘
 const aborted=new AbortController();aborted.abort()
 await assert.rejects(service.handler('voice-service/save',{providerId:'openai',model:'gpt-4o-mini-tts',voiceId:'alloy',apiKey:keys.openai},aborted.signal));assert.equal(h.stored.size,0)
 // 损坏的配置文件不静默改回默认厂商
 await writeFile(join(h.dir,'voice-service.json'),'{not json')
 await assert.rejects(h.make().handler('voice-service/settings',{}))
})

test('试听只走所选厂商 TTS、使用该厂商已保存的模型音色，不做 ASR 回环；未配置或并发试听失败',async t=>{
 const h=await harness();t.after(h.dispose)
 const service=h.make()
 await assert.rejects(service.handler('voice-service/test',{providerId:'openai'}),/尚未配置/)
 assert.equal(h.calls.length,0)
 await service.handler('voice-service/save',{providerId:'openai',model:'gpt-4o-mini-tts',voiceId:'sage',apiKey:keys.openai,setDefault:false})
 const probe=readVoiceServiceProbe(await service.handler('voice-service/test',{providerId:'openai'}))
 assert.equal(probe.providerId,'openai');assert.deepEqual(Buffer.from(probe.audio,'base64'),mp3)
 assert.equal(h.calls.length,1);assert.equal(JSON.parse(String(h.calls[0]!.init.body)).voice,'sage');assert.deepEqual(h.transcriptions,[],'试听不再强制 ASR 回环')
 const slow=createVoiceService({credentials:{describe:async()=>({configured:true,writable:true}),set:async()=>{},resolve:async()=>keys.openai},secure:()=>true,config:createVoiceServiceConfig(join(h.dir,'slow.json')),fetch:(async()=>{await new Promise(resolve=>setTimeout(resolve,50));return audioResponse()}) as typeof fetch,transcribe:async()=>null})
 const first=slow.handler('voice-service/test',{providerId:'openai'});await assert.rejects(slow.handler('voice-service/test',{providerId:'openai'}),/正在测试/);await first
})

test('临时中英文试听不写配置或凭据、不改通话签名；选用音色保留最新模型及本机识别',async t=>{
 const h=await harness();t.after(h.dispose)
 const service=h.make(),config=createVoiceServiceConfig(join(h.dir,'voice-service.json'))
 await service.handler('voice-service/save',{apiKey:keys.minimax})
 await service.handler('voice-service/save',{asrProviderId:'sensevoice-local'})
 const before=await readFile(join(h.dir,'voice-service.json'),'utf8'),signature=await service.speech.signature!(),writes=[...h.events]
 for(const [sampleLanguage,voiceId] of [['zh','Chinese (Mandarin)_Gentleman'],['en','English_CalmWoman']] as const){
  await service.handler('voice-service/test',{providerId:'minimax',model:'speech-2.8-turbo',voiceId,sampleLanguage})
  const body=JSON.parse(String(h.calls.at(-1)!.init.body))
  assert.equal(body.voice_setting.voice_id,voiceId);assert.equal(body.model,'speech-2.8-turbo')
  assert.equal(body.text,sampleLanguage==='en'?'Hello, I’m Teloa. How can I help you today?':'你好，我是 Teloa。今天有什么可以帮你？')
 }
 assert.equal(await readFile(join(h.dir,'voice-service.json'),'utf8'),before)
 assert.equal(await service.speech.signature!(),signature);assert.deepEqual(h.events,writes);assert.deepEqual(h.transcriptions,[])
 await config.update(latest=>({...latest,providers:{...latest.providers,minimax:{...latest.providers.minimax,model:'speech-2.8-hd'}}}))
 const result=readVoiceServiceSettings(await service.handler('voice-service/save',{providerId:'minimax',voiceId:'English_CalmWoman'}))
 assert.equal(result.model,'speech-2.8-hd');assert.equal(result.voiceId,'English_CalmWoman');assert.equal(result.asr.providerId,'sensevoice-local')
 assert.deepEqual(h.events,writes);assert.equal(h.stored.get('minimax'),keys.minimax)
 await service.speech.speak('下一句。',new AbortController().signal,()=>{})
 assert.equal(JSON.parse(String(h.calls.at(-1)!.init.body)).voice_setting.voice_id,'English_CalmWoman')
})

test('实际播报复用同一路由：就绪需 ASR 与所选 TTS 都已配置，更换厂商后下一句即生效且不重启通话',async t=>{
 const h=await harness();t.after(h.dispose)
 const service=h.make()
 await service.handler('voice-service/save',{asrProviderId:'minimax'})
 const media=createBrowserVoiceMedia({configured:service.configured,providerId:service.providerId,speech:service.speech})
 t.after(()=>media.dispose())
 assert.deepEqual(await media.transport.readiness(),{status:'unavailable',providerId:'minimax',reason:'provider-unconfigured'})
 await service.handler('voice-service/save',{providerId:'openai',model:'gpt-4o-mini-tts',voiceId:'alloy',apiKey:keys.openai})
 assert.deepEqual(await media.transport.readiness(),{status:'unavailable',providerId:'openai',reason:'provider-unconfigured'},'缺少 MiniMax ASR 凭据时不就绪')
 await service.handler('voice-service/save',{apiKey:keys.minimax})
 assert.deepEqual(await media.transport.readiness(),{status:'ready',providerId:'openai'})
 const audio=await collect(on=>service.speech.speak('第一句。',new AbortController().signal,on));assert.deepEqual(audio,mp3)
 assert.equal(h.calls.at(-1)!.url,'https://api.openai.com/v1/audio/speech')
 await service.handler('voice-service/save',{providerId:'elevenlabs',model:'eleven_multilingual_v2',voiceId:'JBFqnCBsd6RMkjVDRZzb',apiKey:keys.elevenlabs})
 await service.speech.speak('第二句。',new AbortController().signal,()=>{})
 assert.equal(h.calls.at(-1)!.url,'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=mp3_44100_128','同一服务实例下一句改走新厂商')
 assert.deepEqual(await media.transport.readiness(),{status:'ready',providerId:'elevenlabs'})
})

test('凭据解析抛出带私密内容的错误：适配器与服务边界都脱敏，取消仍按取消结束',async t=>{
 const leak='resolver-exposed-'+keys.openai
 const {calls,fetch}=recorder(),throwing=createSpeechProviders({key:async()=>{throw new Error(leak)},fetch})
 const clean=(error:unknown)=>error instanceof Error&&!error.message.includes(leak)&&!Object.values(keys).some(key=>error.message.includes(key))
 for(const id of ['minimax','openai','elevenlabs'] as const)await assert.rejects(throwing[id].speak('你好。',{model:'m',voiceId:'v'},new AbortController().signal,()=>{}),clean)
 assert.equal(calls.length,0,'凭据解析失败不发请求')
 // 解析等待中取消：保留取消，而不是被改写成普通不可用
 const control=new AbortController()
 const waiting=createSpeechProviders({key:()=>new Promise((_,reject)=>control.signal.addEventListener('abort',()=>reject(new Error(leak)),{once:true})),fetch})
 const pending=waiting.openai.speak('你好。',{model:'m',voiceId:'v'},control.signal,()=>{});control.abort()
 await assert.rejects(pending,error=>error instanceof Error&&error.name==='AbortError')
 // 服务层：试听、实际播报与就绪都不带出原始错误
 const dir=await mkdtemp(join(tmpdir(),'teloa-voice-leak-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const service=createVoiceService({credentials:{describe:async()=>({configured:true,writable:true}),set:async()=>{},resolve:async()=>{throw new Error(leak)}},secure:()=>true,config:createVoiceServiceConfig(join(dir,'voice-service.json')),fetch,transcribe:async()=>null})
 await assert.rejects(service.handler('voice-service/test',{providerId:'openai'}),clean)
 await assert.rejects(service.speech.speak('你好。',new AbortController().signal,()=>{}),clean)
 const broken=createVoiceService({credentials:{describe:async()=>{throw new Error(leak)},set:async()=>{},resolve:async()=>undefined},secure:()=>true,config:createVoiceServiceConfig(join(dir,'other.json')),fetch,transcribe:async()=>null})
 assert.equal(await broken.configured(),false,'凭据存储异常按未就绪处理')
 await assert.rejects(broken.handler('voice-service/settings',{}),clean)
 const media=createBrowserVoiceMedia({configured:broken.configured,providerId:broken.providerId,speech:broken.speech})
 try{const readiness=await media.transport.readiness();assert.equal(readiness.status,'unavailable');assert.equal(JSON.stringify(readiness).includes(leak),false)}finally{media.dispose()}
})

test('迁入原 MiniMax 设置行为：供应商失败不伪造试听成功、不泄露密钥',async t=>{
 const h=await harness();t.after(h.dispose)
 await h.make().handler('voice-service/save',{apiKey:keys.minimax})
 const failing=createVoiceService({credentials:{describe:async()=>({configured:true,writable:true}),set:async()=>{},resolve:async id=>keys[id]},secure:()=>true,config:createVoiceServiceConfig(join(h.dir,'voice-service.json')),fetch:(async()=>{throw new Error('upstream exposed '+keys.minimax)}) as typeof fetch,transcribe:async()=>null})
 await assert.rejects(failing.handler('voice-service/test',{providerId:'minimax'}),error=>error instanceof Error&&!error.message.includes(keys.minimax))
})
