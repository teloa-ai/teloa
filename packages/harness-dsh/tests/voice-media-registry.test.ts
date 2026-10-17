import test from 'node:test'
import assert from 'node:assert/strict'
import {createVoiceMediaRegistry,type VoiceMediaAdapter} from '../src/voice-media-registry.ts'

function adapter(id:string){
 const closed:string[]=[],snapshots:string[]=[]
 const media:VoiceMediaAdapter={
  transport:{async readiness(){return {status:'ready',providerId:id}},async connect(input){closed.push('connect:'+input.callId);return {async close(){closed.push(input.callId)},async interruptPlayback(){}}}},
  snapshot(value){snapshots.push(String((value as {callId:string}).callId));return {token:id,closing:false,muted:false,playbackGeneration:0,speech:null}},
  ready(){},closed(){},playback(){},async transcribe(){return null},async readTranscriptSeal(){return null},inactiveCalls(){return []},dispose(){closed.push('dispose')},
 }
 return {media,closed,snapshots}
}

test('插件加载不迁移正在连接的原媒体；新通话使用插件，卸载不能换绑原call',async()=>{
 const legacy=adapter('legacy'),plugin=adapter('plugin'),registry=createVoiceMediaRegistry(legacy.media)
 const context={ownerId:'owner',target:'assistant' as const,contextVersion:1,sessionId:'s',scope:'general' as const}
 const input=(callId:string)=>({callId,callGeneration:callId,roleContext:context,signal:new AbortController().signal,onEvent(){}})
 await registry.transport.connect(input('old'))
 const off=registry.attach(plugin.media)
 assert.equal((await registry.transport.readiness()).providerId,'plugin')
 await registry.transport.connect(input('new'))
 registry.snapshot({callId:'old'});registry.snapshot({callId:'new'})
 assert.deepEqual(legacy.snapshots,['old']);assert.deepEqual(plugin.snapshots,['new'])
 off()
 assert.equal((await registry.transport.readiness()).providerId,'legacy')
 registry.snapshot({callId:'new'});assert.deepEqual(plugin.snapshots,['new','new'])
 registry.dispose();assert.equal(legacy.closed.at(-1),'dispose');assert.equal(plugin.closed.at(-1),'dispose')
})

test('拒绝同一媒体注册多次与伪造call；封口只从实际连接的适配器读取',async()=>{
 const legacy=adapter('legacy'),plugin=adapter('plugin'),registry=createVoiceMediaRegistry(legacy.media)
 registry.attach(plugin.media)
 assert.throws(()=>registry.attach(plugin.media),/已|冲突/)
 assert.equal(registry.snapshot({callId:'unknown'}),null)
 assert.equal(await registry.readTranscriptSeal('browser-made-up'),null)
 registry.dispose()
 await assert.rejects(registry.transport.readiness(),/关闭/)
})
