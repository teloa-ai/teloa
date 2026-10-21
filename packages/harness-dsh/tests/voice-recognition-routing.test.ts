import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import type {SpeechSnapshot,SpeechProviderId} from '@deepseek-ai/dsh-experimental-speech-to-text'
import {brandString} from '@deepseek-ai/dsh-brand'
import {createVoiceServiceConfig} from '../src/voice-service-config.ts'
import {createVoiceService} from '../src/voice-service.ts'
import {createLocalVoiceRecognition} from '../src/local-voice-recognition.ts'

async function fixture(t:{after:(callback:()=>Promise<void>)=>void},local=true){
 const dir=await mkdtemp(join(tmpdir(),'teloa-local-call-')),config=createVoiceServiceConfig(join(dir,'voice.json'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const keys=new Map<string,string>(),calls:string[]=[],audio=Uint8Array.from([1,2,3]),signal=new AbortController().signal
 let ready=true
 const localRecognition={configured:()=>ready,transcribe:async(bytes:Uint8Array)=>{calls.push('local');return {text:'本机结果',audioSha256:createHash('sha256').update(bytes).digest('hex'),receiptId:'local-stt:test',providerId:'sensevoice-local' as const}}}
 const service=createVoiceService({config,secure:()=>true,credentials:{describe:async id=>({configured:keys.has(id),writable:true}),set:async(id,key)=>{keys.set(id,key)},resolve:async id=>{calls.push('key:'+id);return keys.get(id)}},fetch:(async()=>{calls.push('network');throw Error('unexpected cloud audio')}) as typeof fetch,transcribe:async()=>{calls.push('cloud');return null},...(local?{localRecognition}:{})})
 const save=(asrProviderId:'minimax'|'sensevoice-local')=>service.handler('voice-service/save',{providerId:'minimax',model:'speech-2.8-turbo',voiceId:'male-qn-qingse',setDefault:false,asrProviderId})
 return {config,service,keys,calls,audio,signal,save,setReady:(value:boolean)=>{ready=value},dir}
}

test('新安装默认本机识别，未准备时不自动下载或回退云端',async t=>{
 const f=await fixture(t),calls:string[]=[]
 assert.equal((await f.config.read()).asrProviderId,'sensevoice-local')
 const providerId=brandString<SpeechProviderId>('sensevoice-local')
 const localRecognition=createLocalVoiceRecognition(()=>({
  snapshot:():SpeechSnapshot=>({selection:{providerId,language:'auto'},providers:[{id:providerId,name:'SenseVoice',languages:['auto'],location:'host-local',preparation:{phase:'unprepared'}}]}),
  prepare(){calls.push('download');throw Error('不应自动下载')},
  resolve(){calls.push('resolve');throw Error('未准备不得识别')},
  async transcribe(){calls.push('local');throw Error('未准备不得识别')},
 }))
 const service=createVoiceService({config:f.config,secure:()=>true,localRecognition,credentials:{describe:async()=>({configured:true,writable:true}),set:async()=>{throw Error('不应写凭据')},resolve:async()=>{calls.push('key');return 'test-key'}},fetch:async()=>{calls.push('network');throw Error('不应请求云端')},transcribe:async()=>{calls.push('cloud');return null}})
 const status=await service.handler('voice-service/settings',{})
 assert.deepEqual(status.asr,{providerId:'sensevoice-local',configured:false});assert.equal(await service.configured(),false)
 await assert.rejects(service.speech.warm!(f.signal),/本机|识别/)
 await assert.rejects(service.speech.transcribe(f.audio,'wav',f.signal),/本机|识别/)
 assert.deepEqual(calls,[])
})

test('旧配置缺识别字段及已保存云端选择保持MiniMax，保存播报不改变识别来源',async t=>{
 const f=await fixture(t),initial=await f.config.read()
 const {asrProviderId:_asr,...legacy}=initial
 for(const saved of [legacy,{...initial,asrProviderId:'minimax'}]){
  await writeFile(join(f.dir,'voice.json'),JSON.stringify({schema:'teloa.voice-service/v1',...saved}))
  assert.equal((await f.config.read()).asrProviderId,'minimax')
  await f.service.handler('voice-service/save',{providerId:'minimax',model:'speech-2.8-hd',voiceId:'female-shaonv',setDefault:false})
  assert.equal((await f.config.read()).asrProviderId,'minimax')
 }
})

test('显式本机选择持久化且损坏来源拒绝',async t=>{
 const f=await fixture(t)
 await f.save('sensevoice-local');assert.equal((await f.config.read()).asrProviderId,'sensevoice-local')
 const stored=await f.config.read();await writeFile(join(f.dir,'voice.json'),JSON.stringify({schema:'teloa.voice-service/v1',...stored,asrProviderId:'browser-google'}))
 await assert.rejects(f.config.read(),/损坏/)
})

test('本机ASR无需MiniMax识别凭据，播报仍要单独就绪；调用不取云密钥或发网络',async t=>{
 const f=await fixture(t),status=await f.save('sensevoice-local')
 assert.deepEqual(status.asr,{providerId:'sensevoice-local',configured:true})
 assert.equal(status.providerId,'minimax');assert.equal(status.configured,false);assert.equal(await f.service.configured(),false)
 f.keys.set('minimax','test-key');assert.equal(await f.service.configured(),true)
 const result=await f.service.speech.transcribe(f.audio,'wav',f.signal)
 assert.equal(result?.providerId,'sensevoice-local');assert.equal(result?.text,'本机结果');assert.deepEqual(f.calls,['local'])
})

test('普通播报设置及旧客户端密钥保存保留新安装的本机识别默认',async t=>{
 const f=await fixture(t)
 await f.service.handler('voice-service/save',{apiKey:'test-key'})
 await f.service.handler('voice-service/save',{providerId:'minimax',model:'speech-2.8-turbo',voiceId:'female-shaonv'})
 const status=await f.service.handler('voice-service/settings',{})
 assert.deepEqual(status.asr,{providerId:'sensevoice-local',configured:true});assert.equal(status.voiceId,'female-shaonv')
 assert.equal((await f.config.read()).asrProviderId,'sensevoice-local')
})

test('本机插件缺失或撤下就绪时闭门失败，不回落云端识别',async t=>{
 const f=await fixture(t,false);f.keys.set('minimax','test-key');const saved=await f.save('sensevoice-local')
 assert.deepEqual(saved.asr,{providerId:'sensevoice-local',configured:false});assert.equal(await f.service.configured(),false)
 await assert.rejects(f.service.speech.transcribe(f.audio,'wav',f.signal),/本机|识别/);assert.deepEqual(f.calls,[])
 const g=await fixture(t);g.keys.set('minimax','test-key');await g.save('sensevoice-local');g.setReady(false)
 assert.equal(await g.service.configured(),false);await assert.rejects(g.service.speech.transcribe(g.audio,'wav',g.signal),/本机|识别/);assert.deepEqual(g.calls,[])
})

test('每次转写重新读已保存来源，显式切回MiniMax后才使用云识别',async t=>{
 const f=await fixture(t);await f.save('sensevoice-local');await f.service.speech.transcribe(f.audio,'wav',f.signal)
 await f.save('minimax');await f.service.speech.transcribe(f.audio,'wav',f.signal)
 assert.deepEqual(f.calls,['local','cloud'])
})

test('独立ASR保存只改识别来源，不覆盖其他窗口最新播报音色或写凭据',async t=>{
 const f=await fixture(t);f.keys.set('minimax','test-key')
 await f.service.handler('voice-service/save',{providerId:'minimax',model:'speech-2.8-hd',voiceId:'female-shaonv'})
 const before=await f.config.read(),saved=await f.service.handler('voice-service/save',{asrProviderId:'sensevoice-local'})
 assert.equal(saved.model,'speech-2.8-hd');assert.equal(saved.voiceId,'female-shaonv');assert.deepEqual((await f.config.read()).providers,before.providers)
 assert.deepEqual(saved.asr,{providerId:'sensevoice-local',configured:true});assert.deepEqual([...f.keys.entries()],[['minimax','test-key']]);assert.deepEqual(f.calls,[])
})
