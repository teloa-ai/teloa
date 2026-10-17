import test from 'node:test'
import assert from 'node:assert/strict'
import {createNeuralPcmTurns} from '../src/neural-pcm-turns.ts'

function fixture(onPreview?:(pcm:Uint8Array|null)=>void){
 let probability=0,resets=0
 const turns=createNeuralPcmTurns({predict:async()=>probability,reset(){resets++},async close(){}},onPreview)
 async function push(ms:number,p:number,amplitude=2000){probability=p;const results=[];for(let at=0;at<ms;at+=32){const bytes=new Uint8Array(1024),view=new DataView(bytes.buffer);for(let n=0;n<512;n++)view.setInt16(n*2,amplitude,true);await turns.push(bytes.subarray(0,640));results.push(await turns.push(bytes.subarray(640)))}return results}
 return {turns,push,get resets(){return resets}}
}
test('大音量非人声不打断，低音量连续人声能确认，半秒停顿不拆句',async()=>{
 const f=fixture()
 assert.ok((await f.push(1024,.01,16000)).every(r=>!r.started&&!r.turn))
 assert.ok((await f.push(160,.95,100)).every(r=>!r.started))
 assert.equal((await f.push(32,.95,100)).at(-1)?.started,true)
 assert.ok((await f.push(576,.01)).every(r=>!r.turn))
 await f.push(256,.8,100)
 const result=(await f.push(608,.01)).at(-1)!
 assert.ok(result.turn);assert.equal(f.turns.active,false)
 assert.ok(result.turn.length<32*(320+192+576+256+608),'尾静音只保留192ms')
 assert.equal(await f.turns.flush(),null)
})
test('192ms候选与最终音频逐字节相同，续说与重置撤销候选，不提前封口',async()=>{
 const previews:Array<Uint8Array|null>=[],f=fixture(pcm=>previews.push(pcm))
 await f.push(320,.9);await f.push(192,.01)
 assert.equal(previews.length,1);assert.ok(previews[0]);assert.equal(f.turns.active,true)
 const ended=(await f.push(416,.01)).at(-1)!.turn
 assert.deepEqual(ended,previews[0]);assert.equal(previews.length,1)
 await f.push(320,.9);await f.push(192,.01);await f.push(32,.9)
 assert.equal(previews.at(-1),null)
 assert.equal(f.turns.active,true)
 await f.push(608,.01);assert.ok(previews.at(-1));f.turns.reset();assert.equal(previews.at(-1),null)
})
test('reset使等待中的概率失效，静音前的残留首音不能进入新段',async()=>{
 let release!:(n:number)=>void
 const turns=createNeuralPcmTurns({predict:()=>new Promise(resolve=>{release=resolve}),reset(){},async close(){}})
 await turns.push(new Uint8Array(640));const held=turns.push(new Uint8Array(384))
 turns.reset();release(.99)
 assert.deepEqual(await held,{started:false,turn:null});assert.equal(await turns.flush(),null)
})
