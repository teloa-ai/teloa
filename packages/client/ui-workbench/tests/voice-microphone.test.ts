import test from 'node:test'
import assert from 'node:assert/strict'
import {encodeVoiceWav} from '../src/client/voice-microphone.ts'
test('实际采样降到 16k 单声道 WAV，长度有界且不生成空音频',()=>{
 const input=new Float32Array(48000).fill(.5),audio=encodeVoiceWav([input],48000),view=new DataView(audio.buffer)
 assert.equal(Buffer.from(audio).toString('ascii',0,4),'RIFF');assert.equal(view.getUint32(24,true),16000);assert.equal(audio.byteLength,32044);assert.equal(view.getInt16(44,true),16383)
 assert.throws(()=>encodeVoiceWav([],48000));assert.throws(()=>encodeVoiceWav([new Float32Array(48000*17)],48000))
})
