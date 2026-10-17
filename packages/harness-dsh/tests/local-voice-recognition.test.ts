import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {WorkError} from '@teloa/contract'
import type SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import type {SpeechProvider,SpeechProviderId,SpeechSnapshot} from '@deepseek-ai/dsh-experimental-speech-to-text'
import {createLocalVoiceRecognition} from '../src/local-voice-recognition.ts'

type Registry=Pick<SpeechToText,'snapshot'|'resolve'|'transcribe'|'prepare'>
const providerId='sensevoice-local' as SpeechProviderId
const provider:SpeechProvider={info:{id:providerId,name:'SenseVoiceSmall (INT8)',location:'host-local',languages:['auto','zh','en','yue','ja','ko']},async transcribe(){throw Error('识别只经注册表')}}
const snapshot=(phase='ready',id='sensevoice-local',location='host-local')=>({providers:[{...provider.info,id,location,preparation:{phase}}],selection:{providerId:'cloud-default',language:'unsupported-default'}}) as unknown as SpeechSnapshot
const wav=(seconds=1)=>{
 const bytes=Buffer.alloc(44+seconds*32000)
 bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16)
 bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28)
 bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40)
 return bytes
}
const registry=(overrides:Partial<Registry>={}):Registry=>({
 snapshot:()=>snapshot(),
 resolve:request=>({audio:request.audio,language:request.language!,provider}),
 async transcribe(){return {text:' 请核对报告。 ',audioSeconds:1,inferenceSeconds:.1}},
 prepare(){throw Error('识别不得自动准备或下载模型')},
 ...overrides,
})
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}
const unavailable=(error:unknown)=>error instanceof WorkError&&error.code==='teloa/unavailable'&&!error.message.includes('private-secret')

test('只有精确本机 provider 的可识别状态准入，不跟随默认云服务',()=>{
 for(const [phase,want] of [['ready',true],['standby',true],['waking',true],['unprepared',false],['checking',false],['downloading',false],['loading',false],['failed',false],['cancelled',false],['cancelling',false],['invented',false]] as const){
  assert.equal(createLocalVoiceRecognition(()=>registry({snapshot:()=>snapshot(phase)})).configured(),want,phase)
 }
 for(const value of [snapshot('ready','other-local'),snapshot('ready','sensevoice-local','cloud'),snapshot({toString:()=> 'ready'} as unknown as string),{providers:[]},{},null]){
  assert.equal(createLocalVoiceRecognition(()=>registry({snapshot:()=>value as SpeechSnapshot})).configured(),false)
 }
 assert.equal(createLocalVoiceRecognition(()=>undefined).configured(),false)
 assert.equal(createLocalVoiceRecognition(()=>{throw Error('private-secret')}).configured(),false)
})

test('固定本机与 auto，真实识别后绑定原音频摘要并签发本地回执',async()=>{
 const audio=wav(),expectedHash=createHash('sha256').update(audio).digest('hex')
 const result=await createLocalVoiceRecognition(()=>registry({
  resolve(request){
   assert.equal(request.providerId,'sensevoice-local');assert.equal(request.language,'auto')
   assert.notEqual(request.audio,audio);assert.deepEqual(request.audio,Uint8Array.from(audio))
   return {audio:request.audio,language:'auto',provider}
  },
  async transcribe(spec,signal){assert.equal(spec.provider,provider);assert.equal(signal.aborted,false);return {text:' 请核对报告。 ',audioSeconds:1,inferenceSeconds:.1}},
 })).transcribe(audio,'wav',new AbortController().signal)
 assert.deepEqual({...result,receiptId:'local-receipt'},{text:'请核对报告。',providerId:'sensevoice-local',audioSha256:expectedHash,receiptId:'local-receipt'})
 assert.match(result!.receiptId,/^local-stt:[a-f0-9-]{36}$/)
})

test('通话预热只用短静音唤醒已验证本机模型，结果不进入正式输入，也不触发下载',async()=>{
 let calls=0
 const speech=createLocalVoiceRecognition(()=>registry({snapshot:()=>snapshot('standby'),async transcribe(spec){
  calls++;assert.equal(spec.provider,provider)
  assert.deepEqual(spec.audio,Uint8Array.from(wav(.32)))
  return {text:'忽略预热输出',audioSeconds:.32,inferenceSeconds:.01}
 }}))
 assert.equal(await speech.warm(new AbortController().signal),undefined)
 assert.equal(calls,1)
 await assert.rejects(createLocalVoiceRecognition(()=>registry({snapshot:()=>snapshot('unprepared'),async transcribe(){throw Error('未准备不得触达')}})).warm(new AbortController().signal),unavailable)
})

test('等待期间调用者修改原音频不改变送入识别的数据和摘要',{timeout:2000},async()=>{
 const input=wav(),original=Buffer.from(input),entered=deferred<void>(),finish=deferred<void>()
 const speech=createLocalVoiceRecognition(()=>registry({async transcribe(spec){entered.resolve();await finish.promise;assert.deepEqual(spec.audio,Uint8Array.from(original));return {text:'本机结果',audioSeconds:1,inferenceSeconds:.1}}}))
 const pending=speech.transcribe(input,'wav',new AbortController().signal)
 await entered.promise;input.fill(0);finish.resolve()
 assert.equal((await pending)!.audioSha256,createHash('sha256').update(original).digest('hex'))
})

test('坏 WAV、非 PCM16/16kHz/单声道、超时长和 mp3 在触达识别前拒绝',async()=>{
 let calls=0
 const speech=createLocalVoiceRecognition(()=>registry({resolve(){calls++;throw Error('不得触达识别')}}))
 const invalid=[Buffer.from('RIFF0000WAVE'),wav(121),Buffer.alloc(4*1024*1024+1)]
 for(const [offset,value] of [[4,0],[16,18],[20,3],[22,2],[24,8000],[28,16000],[32,4],[34,8],[40,2]]){const bytes=wav();bytes.writeUInt32LE(value!,offset);invalid.push(bytes)}
 for(const bytes of invalid)await assert.rejects(speech.transcribe(bytes,'wav',new AbortController().signal),error=>error instanceof WorkError&&error.code==='teloa/invalid-input')
 await assert.rejects(speech.transcribe(wav(),'mp3',new AbortController().signal),error=>error instanceof WorkError&&error.code==='teloa/invalid-input')
 assert.equal(calls,0)
})

test('服务缺失、未准备及解析后身份被替换均拒绝，不回云、不自动准备',async()=>{
 const audio=wav()
 for(const read of [()=>undefined,()=>registry({snapshot:()=>snapshot('unprepared')}),()=>registry({resolve:request=>({audio:request.audio,language:'auto',provider:{...provider,info:{...provider.info,id:'cloud' as SpeechProviderId}}})}),()=>registry({resolve:request=>({audio:request.audio,language:'auto',provider:{...provider,info:{...provider.info,location:'cloud'}}})}),()=>registry({resolve:request=>({audio:request.audio,language:'zh',provider})}),()=>registry({resolve:()=>({audio:wav(2),language:'auto',provider})})]){
  let recognized=false
  const speech=createLocalVoiceRecognition(()=>{const found=read();return found&&{...found,async transcribe(){recognized=true;throw Error('不得识别')}}})
  await assert.rejects(speech.transcribe(audio,'wav',new AbortController().signal),unavailable)
  assert.equal(recognized,false)
 }
})

test('空白识别不形成回执，超长和控制字符结果拒绝',async()=>{
 for(const text of ['','  \n '])assert.equal(await createLocalVoiceRecognition(()=>registry({async transcribe(){return {text,audioSeconds:1,inferenceSeconds:.1}}})).transcribe(wav(),'wav',new AbortController().signal),null)
 for(const text of ['a'.repeat(65537),'结果\u0000'])await assert.rejects(createLocalVoiceRecognition(()=>registry({async transcribe(){return {text,audioSeconds:1,inferenceSeconds:.1}}})).transcribe(wav(),'wav',new AbortController().signal),unavailable)
})

test('注册表读、解析、识别的原始异常不泄漏路径或凭据',async()=>{
 const failure=()=>{throw new WorkError('teloa/unavailable','private-secret /Users/person/private-model')}
 for(const read of [failure,()=>registry({snapshot:failure}),()=>registry({resolve:failure}),()=>registry({transcribe:failure})])await assert.rejects(createLocalVoiceRecognition(read).transcribe(wav(),'wav',new AbortController().signal),unavailable)
})

test('取消保留原原因且等待真实识别清理后结算，不签发迟到回执',{timeout:2000},async()=>{
 const abort=new AbortController(),entered=deferred<void>(),cleanup=deferred<void>(),reason=Error('caller-cancelled')
 let settled=false,finished=false
 const speech=createLocalVoiceRecognition(()=>registry({async transcribe(_spec,signal){entered.resolve();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));await cleanup.promise;finished=true;signal.throwIfAborted();throw Error('不可到达')}}))
 const pending=speech.transcribe(wav(),'wav',abort.signal);void pending.then(()=>{settled=true},()=>{settled=true})
 await entered.promise;abort.abort(reason);await tick();assert.equal(settled,false);assert.equal(finished,false)
 cleanup.resolve();await assert.rejects(pending,error=>error===reason);assert.equal(finished,true)
 const preAborted=new AbortController();preAborted.abort(reason)
 await assert.rejects(createLocalVoiceRecognition(()=>{throw Error('已取消不能读取服务')}).transcribe(wav(),'wav',preAborted.signal),error=>error===reason)
})

test('识别器取消后仍返回成功时不采用迟到结果',{timeout:2000},async()=>{
 const abort=new AbortController(),entered=deferred<void>(),finish=deferred<void>(),reason=Error('caller-cancelled')
 const speech=createLocalVoiceRecognition(()=>registry({async transcribe(){entered.resolve();await finish.promise;return {text:'迟到结果',audioSeconds:1,inferenceSeconds:.1}}}))
 const pending=speech.transcribe(wav(),'wav',abort.signal)
 await entered.promise;abort.abort(reason);finish.resolve()
 await assert.rejects(pending,error=>error===reason)
})
