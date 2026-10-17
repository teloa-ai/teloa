import test from 'node:test'
import assert from 'node:assert/strict'
import {createEmployeeVoiceApi} from '../src/client/employee-voice-api.ts'
const identity={callId:'30000000-0000-4000-8000-000000000001',callGeneration:'40000000-0000-4000-8000-000000000001'}
const snapshot={token:'50000000-0000-4000-8000-000000000001',closing:false,muted:false,playbackGeneration:0,speech:null}
const realtime={path:'/teloa-voice/stream',protocol:'teloa.voice.pcm.v1'}
test('媒体快照精确接受实时媒体能力，同时保持旧 WAV 回包兼容',async()=>{
 for(const value of [snapshot,{...snapshot,realtime}]){
  const seen:unknown[]=[];const api=createEmployeeVoiceApi(async(endpoint,payload)=>{seen.push({endpoint,payload});return value})
  assert.deepEqual(await api.media(identity),value);assert.deepEqual(seen,[{endpoint:'voice-calls/media',payload:identity}])
 }
})
test('实时媒体不接受跨源地址、未知协议、额外字段或混合轮询音频',async()=>{
 const speech={utteranceId:'60000000-0000-4000-8000-000000000001',playbackGeneration:0,audio:'AAA='}
 for(const value of [
  {...snapshot,realtime:{...realtime,path:'https://external.test/voice'}},
  {...snapshot,realtime:{...realtime,path:'//external.test/voice'}},
  {...snapshot,realtime:{...realtime,path:'/other'}},
  {...snapshot,realtime:{...realtime,protocol:'other'}},
  {...snapshot,realtime:{...realtime,token:'injected'}},
  {...snapshot,realtime:null},{...snapshot,realtime:undefined},{...snapshot,realtime,speech},
  {...snapshot,realtime,extra:true},{...snapshot,wrong:realtime},
 ])await assert.rejects(createEmployeeVoiceApi(async()=>value).media(identity))
})
