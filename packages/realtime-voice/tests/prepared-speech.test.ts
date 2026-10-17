import test from 'node:test'
import assert from 'node:assert/strict'
import {prepareSpeechPrefix} from '../src/prepared-speech.ts'
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))

test('候选最多持有一包，正式采用后首包立即放行，无需等整句合成结束',async()=>{
 const control=new AbortController();let finish!:()=>void,finished=false
 const tail=new Promise<void>(resolve=>{finish=resolve}),sent:number[]=[]
 const audio=prepareSpeechPrefix({text:'先说这句。',signal:control.signal,async synthesize(_text,_signal,onAudio){await onAudio(Uint8Array.of(1,0));await tail;await onAudio(Uint8Array.of(2,0));finished=true}})
 await tick();assert.deepEqual(sent,[])
 const pending=audio.consume(control.signal,async bytes=>{sent.push(bytes[0]!)})
 await tick();assert.deepEqual(sent,[1]);assert.equal(finished,false)
 audio.discard();finish();await pending;assert.deepEqual(sent,[1,2])
})

test('放弃、预先取消和超过候选音频上限都结算，不泄漏阻塞的首包',async()=>{
 for(const action of ['discard','cancel','limit'] as const){
  const control=new AbortController(),audio=prepareSpeechPrefix({text:'候选内容。',signal:control.signal,async synthesize(_text,_signal,onAudio){await onAudio(new Uint8Array(action==='limit'?512*1024+2:2))}})
  await tick()
  if(action==='discard')audio.discard()
  if(action==='cancel')control.abort()
  let sent=0
  await assert.rejects(audio.consume(control.signal,async()=>{sent++}))
  assert.equal(sent,0)
 }
})
