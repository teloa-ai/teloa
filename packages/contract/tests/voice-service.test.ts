import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readVoiceServiceSave,readVoiceServiceSettings} from '../src/voice-service.ts'
import * as voice from '../src/voice-service.ts'

const providers=[{id:'minimax',name:'MiniMax',configured:false,model:'speech-2.8-turbo',voiceId:'male-qn-qingse'},{id:'openai',name:'OpenAI',configured:true,model:'gpt-4o-mini-tts',voiceId:'alloy'},{id:'elevenlabs',name:'ElevenLabs',configured:false,model:'eleven_multilingual_v2',voiceId:'JBFqnCBsd6RMkjVDRZzb'}]
const status={providerId:'openai',configured:true,writable:true,secure:true,model:'gpt-4o-mini-tts',voiceId:'alloy',providers,asr:{providerId:'minimax',configured:false}}
const input={providerId:'openai',model:'gpt-4o-mini-tts',voiceId:'alloy',setDefault:false}

test('仅识别来源的补丁不携带播报配置或默认厂商写入意图',()=>{
 for(const asrProviderId of ['sensevoice-local','minimax'])assert.deepEqual(readVoiceServiceSave({asrProviderId}),{asrProviderId})
 for(const asrProviderId of ['openai',null,undefined,0])assert.throws(()=>readVoiceServiceSave({asrProviderId}),{code:'teloa/invalid-input'})
 for(const extra of [{apiKey:'fixture-key'},{setDefault:false},{voiceId:'alloy'},{modelPath:'/private/model'}])assert.throws(()=>readVoiceServiceSave({asrProviderId:'sensevoice-local',...extra}),{code:'teloa/invalid-input'})
})

test('识别来源可独立保存，不提交时保留旧协议及 MiniMax 凭据兼容语义',()=>{
 assert.deepEqual(readVoiceServiceSave({...input,asrProviderId:'sensevoice-local'}),{...input,asrProviderId:'sensevoice-local'})
 assert.deepEqual(readVoiceServiceSave({...input,asrProviderId:'minimax'}),{...input,asrProviderId:'minimax'})
 assert.deepEqual(readVoiceServiceSave(input),input)
 assert.deepEqual(readVoiceServiceSave({apiKey:'  fixture-key  '},providers[0]),{providerId:'minimax',model:'speech-2.8-turbo',voiceId:'male-qn-qingse',apiKey:'fixture-key',setDefault:false})
 for(const asrProviderId of ['openai','../sensevoice',null,0])assert.throws(()=>readVoiceServiceSave({...input,asrProviderId}),{code:'teloa/invalid-input'})
 assert.throws(()=>readVoiceServiceSave({...input,asrProviderId:'sensevoice-local',modelPath:'/private/model'}),{code:'teloa/invalid-input'})
})

test('本机识别就绪独立于 MiniMax 凭据，云端识别仍严格绑定 MiniMax 凭据状态',()=>{
 for(const configured of [true,false]){
  const local={...status,asr:{providerId:'sensevoice-local',configured}}
  assert.deepEqual(readVoiceServiceSettings(local),local)
 }
 assert.deepEqual(readVoiceServiceSettings(status),status)
 for(const asr of [{providerId:'minimax',configured:true},{providerId:'sensevoice-local',configured:'ready'},{providerId:'sensevoice-local',configured:true,modelPath:'/private/model'},{providerId:'openai',configured:true}])assert.throws(()=>readVoiceServiceSettings({...status,asr}),{code:'teloa/invalid-host-response'})
})

test('宿主仅接受受支持的识别来源，不把播报厂商或路径当作识别来源',()=>{
 const valid=voice.isSpeechRecognitionProviderId
 for(const id of ['minimax','sensevoice-local'])assert.equal(valid(id),true)
 for(const id of ['openai','elevenlabs','/private/model',null,undefined,{}])assert.equal(valid(id),false)
})

test('官方音色支持空格括号，仍拒绝路径、控制字符与过长标识；选用只提交音色',()=>{
 const voiceId='Chinese (Mandarin)_Gentleman'
 assert.deepEqual(readVoiceServiceSave({providerId:'minimax',voiceId}),{providerId:'minimax',voiceId})
 assert.equal(voice.isSpeechVoiceId(voiceId),true)
 for(const id of ['../voice','https://host/voice','voice\\name','voice\nname','voice\tname',' voice','voice ','x'.repeat(129)])assert.equal(voice.isSpeechVoiceId(id),false,id)
 const minimax={...status,providerId:'minimax',configured:false,model:providers[0]!.model,voiceId,providers:providers.map(row=>row.id==='minimax'?{...row,voiceId}:row)}
 assert.equal(readVoiceServiceSettings(minimax).voiceId,voiceId)
})

test('临时试听校验模型音色成对与固定示例语言，旧试听协议保持可用',()=>{
 const read=voice.readVoiceServiceTestInput,base={providerId:'minimax'}
 assert.deepEqual(read(base),base)
 const preview={...base,model:'speech-2.8-turbo',voiceId:'Chinese (Mandarin)_Gentleman',sampleLanguage:'en'}
 assert.deepEqual(read(preview),preview)
 for(const patch of [{model:'speech-2.8-turbo'},{voiceId:'voice'},{model:undefined,voiceId:undefined},{sampleLanguage:'evil'},{text:'arbitrary text'},{apiKey:'secret'},{url:'https://other'}])assert.throws(()=>read({...base,...patch}),{code:'teloa/invalid-input'})
})
