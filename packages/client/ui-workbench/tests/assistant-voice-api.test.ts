import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createEmployeeVoiceApi} from '../src/client/employee-voice-api.ts'
const input={requestId:'20000000-0000-4000-8000-000000000001',sessionId:'assistant-session',expectedContextVersion:2,audio:'UklGRg=='}
test('语音留言只检查识别凭据，所选 TTS 尚未配置不阻塞录制',async()=>{
 const calls:unknown[]=[]
 const status={providerId:'openai',configured:false,writable:true,secure:true,model:'gpt-4o-mini-tts',voiceId:'alloy',providers:[{id:'minimax',name:'MiniMax',configured:true,model:'speech-2.8-turbo',voiceId:'male-qn-qingse'},{id:'openai',name:'OpenAI',configured:false,model:'gpt-4o-mini-tts',voiceId:'alloy'},{id:'elevenlabs',name:'ElevenLabs',configured:false,model:'eleven_multilingual_v2',voiceId:'JBFqnCBsd6RMkjVDRZzb'}],asr:{providerId:'minimax',configured:true}}
 const api=createEmployeeVoiceApi(async(endpoint,payload)=>{calls.push({endpoint,payload});return status})
 assert.deepEqual(await api.recognitionReadiness(),{status:'ready',providerId:'minimax'})
 assert.deepEqual(calls,[{endpoint:'voice-service/settings',payload:{}}])
})
test('留言 ASR 传递取消信号，严格核对原会话与上下文，不创建通话或发送消息',async()=>{
 const abort=new AbortController(),calls:unknown[]=[]
 const api=createEmployeeVoiceApi(async(endpoint,payload,signal)=>{calls.push({endpoint,payload,signal});return {requestId:input.requestId,sessionId:input.sessionId,contextVersion:2,text:'核对最新报告'}})
 assert.deepEqual(await api.transcribe(input,abort.signal),{requestId:input.requestId,sessionId:input.sessionId,contextVersion:2,text:'核对最新报告'})
 assert.deepEqual(calls,[{endpoint:'voice-input/transcribe',payload:input,signal:abort.signal}])
 for(const patch of [{sessionId:'other-session'},{contextVersion:3},{requestId:'20000000-0000-4000-8000-000000000002'},{extra:true},{text:42}]){
  const bad=createEmployeeVoiceApi(async()=>({...{requestId:input.requestId,sessionId:input.sessionId,contextVersion:2,text:'核对最新报告'},...patch}))
  await assert.rejects(bad.transcribe(input))
 }
})
