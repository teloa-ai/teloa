import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createVoiceServiceApi} from '../src/client/voice-service-api.ts'

const providers=[{id:'minimax',name:'MiniMax',configured:true,model:'speech-2.8-turbo',voiceId:'male-qn-qingse'},{id:'openai',name:'OpenAI',configured:true,model:'gpt-4o-mini-tts',voiceId:'alloy'},{id:'elevenlabs',name:'ElevenLabs',configured:false,model:'eleven_multilingual_v2',voiceId:'JBFqnCBsd6RMkjVDRZzb'}]
const status={providerId:'openai',configured:true,writable:true,secure:true,model:'gpt-4o-mini-tts',voiceId:'alloy',providers,asr:{providerId:'minimax',configured:true}}

test('语音凭据只写不读；配置不能冒充实时通话已连接',async()=>{
 const requests:{endpoint:string;payload:unknown}[]=[]
 const api=createVoiceServiceApi(async(endpoint,payload)=>{requests.push({endpoint,payload});return status})
 const input={providerId:'openai' as const,model:'gpt-4o-mini-tts',voiceId:'alloy',apiKey:'test-key'}
 assert.equal((await api.status()).providerId,'openai');await api.save(input)
 assert.deepEqual(requests,[{endpoint:'voice-service/settings',payload:{}},{endpoint:'voice-service/save',payload:input}])
 for(const bad of [{...status,apiKey:'leaked'},{...status,providers:[providers[0],providers[0],providers[2]]},{...status,model:'wrong-model'},{...status,asr:{providerId:'openai',configured:true}},{...status,providers:providers.map(p=>({...p,apiKey:'leaked'}))}])await assert.rejects(createVoiceServiceApi(async()=>bad).status())
})
test('试听按所选 TTS 厂商请求，不要求识别服务；拒绝错厂商、不完整音频和不可信 URL',async()=>{
 const requests:unknown[]=[],signal=new AbortController().signal
 const receipt={providerId:'elevenlabs',tts:true,mime:'audio/mpeg',audio:Buffer.from('ID3audio').toString('base64')}
 const api=createVoiceServiceApi(async(endpoint,payload,receivedSignal)=>{requests.push({endpoint,payload});assert.equal(receivedSignal,signal);return receipt})
 assert.equal((await api.test('elevenlabs',signal)).providerId,'elevenlabs')
 assert.deepEqual(requests,[{endpoint:'voice-service/test',payload:{providerId:'elevenlabs'}}])
 for(const invalid of [{...receipt,providerId:'openai'},{...receipt,tts:false},{...receipt,audio:'https://example.com/private'},{...receipt,audio:''},{...receipt,apiKey:'leaked'}])await assert.rejects(createVoiceServiceApi(async()=>invalid).test('elevenlabs',signal))
})
test('本机识别设置透传来源选择，接收独立就绪状态而不读取模型路径或凭据',async()=>{
 const requests:unknown[]=[],local={...status,providers:providers.map(p=>p.id==='minimax'?{...p,configured:false}:p),asr:{providerId:'sensevoice-local',configured:true}}
 const api=createVoiceServiceApi(async(endpoint,payload)=>{requests.push({endpoint,payload});return local})
 const input={asrProviderId:'sensevoice-local' as const}
 assert.equal((await api.save(input)).asr.providerId,'sensevoice-local')
 assert.equal((await api.status()).asr.configured,true)
 assert.deepEqual(requests,[{endpoint:'voice-service/save',payload:input},{endpoint:'voice-service/settings',payload:{}}])
 await assert.rejects(createVoiceServiceApi(async()=>({...local,asr:{...local.asr,modelPath:'/private/model'}})).status())
})

test('列表试听透传临时音色和示例语言，不混入保存；选用只提交音色',async()=>{
 const requests:unknown[]=[],receipt={providerId:'minimax',tts:true,mime:'audio/mpeg',audio:Buffer.from('ID3audio').toString('base64')},signal=new AbortController().signal
 const api=createVoiceServiceApi(async(endpoint,payload)=>{requests.push({endpoint,payload});return endpoint.endsWith('/test')?receipt:status})
 const voice={model:'speech-2.8-turbo',voiceId:'English_CalmWoman',sampleLanguage:'en' as const}
 await api.test('minimax',signal,voice);await api.save({providerId:'minimax',voiceId:voice.voiceId})
 assert.deepEqual(requests,[{endpoint:'voice-service/test',payload:{providerId:'minimax',...voice}},{endpoint:'voice-service/save',payload:{providerId:'minimax',voiceId:voice.voiceId}}])
})
