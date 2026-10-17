import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFile} from 'node:fs/promises'
import OpusScript from 'opusscript'
import {createDeviceAudioCapture} from '../src/capture.ts'
import type {SealedPcmTurn} from '../src/audio-turn.ts'

const modelPath=process.env.TELOA_SILERO_MODEL,audioPath=process.env.TELOA_SILERO_TEST_WAV
const real={skip:!modelPath||!audioPath?'指定固定模型及许可语音后运行 Opus→VAD→WAV 集成':false}
test('真实上行 Opus 依次解码、自然封口，丢弃同批迟到余音',real,async()=>{
 const source=await readFile(audioPath!),encoder=new OpusScript(16000,1,OpusScript.Application.VOIP),sealed:SealedPcmTurn[]=[],discarded:string[]=[]
 const capture=await createDeviceAudioCapture({captureId:'e12c88ac-2773-4527-aeb0-be806ac10a58',modelPath:modelPath!,signal:new AbortController().signal,onSealed:turn=>sealed.push(turn),onDiscard:reason=>discarded.push(reason)})
 try{
  for(let offset=44;offset+1920<=source.length&&sealed.length===0;offset+=1920)await capture.push(encoder.encode(source.subarray(offset,offset+1920),960))
  assert.equal(sealed.length,1);assert.equal(sealed[0]!.reason,'silence');assert.equal(discarded.length,0)
  assert.ok(sealed[0]!.wav.length>44&&sealed[0]!.wav.length<=480044)
  await capture.push(Uint8Array.of(0));await capture.stop();assert.equal(sealed.length,1)
 }finally{encoder.delete();await capture.close()}
})
test('断线取消真实媒体初始化后的半句，无封口或转写回调',real,async()=>{
 const signal=new AbortController(),sealed:SealedPcmTurn[]=[],discarded:string[]=[]
 const capture=await createDeviceAudioCapture({captureId:'e12c88ac-2773-4527-aeb0-be806ac10a58',modelPath:modelPath!,signal:signal.signal,onSealed:turn=>sealed.push(turn),onDiscard:reason=>discarded.push(reason)})
 const encoder=new OpusScript(16000,1,OpusScript.Application.VOIP)
 try{
  const source=await readFile(audioPath!);await capture.push(encoder.encode(source.subarray(44,44+1920),960))
  signal.abort();await capture.stop();assert.deepEqual(sealed,[]);assert.deepEqual(discarded,[])
 }finally{encoder.delete();await capture.close()}
})
test('损坏 Opus 在原生 ASR 之前终止整句',real,async()=>{
 let sealed=0,discarded=0
 const capture=await createDeviceAudioCapture({captureId:'e12c88ac-2773-4527-aeb0-be806ac10a58',modelPath:modelPath!,signal:new AbortController().signal,onSealed:()=>sealed++,onDiscard:()=>discarded++})
 try{await assert.rejects(capture.push(Uint8Array.of(0)));await capture.stop();assert.equal(sealed,0);assert.equal(discarded,0)}finally{await capture.close()}
})
