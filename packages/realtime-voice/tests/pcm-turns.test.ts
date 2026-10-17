import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createPcmTurns,encodePcmWav} from '../src/pcm-turns.ts'

function pcm(ms:number,amplitude=0):Uint8Array{
 const bytes=new Uint8Array(ms*32),view=new DataView(bytes.buffer)
 for(let offset=0;offset<bytes.length;offset+=2)view.setInt16(offset,amplitude,true)
 return bytes
}
function append(turns:ReturnType<typeof createPcmTurns>,audio:Uint8Array,frameBytes=640):Uint8Array[]{
 const output:Uint8Array[]=[]
 for(let offset=0;offset<audio.length;offset+=frameBytes){const result=turns.push(audio.subarray(offset,offset+frameBytes));if(result.turn)output.push(result.turn)}
 return output
}

test('不足提交长度的短突发不能确认插话，有效起音只确认一次且不丢首音',()=>{
 const turns=createPcmTurns()
 for(const ms of [20,180]){
  for(let elapsed=0;elapsed<ms;elapsed+=20)assert.equal(turns.push(pcm(20,2000)).started,false)
  assert.deepEqual(append(turns,pcm(600)),[])
  assert.equal(turns.flush(),null)
 }
 for(let elapsed=0;elapsed<180;elapsed+=20)assert.equal(turns.push(pcm(20,1000)).started,false)
 assert.equal(turns.push(pcm(20,1000)).started,true)
 assert.equal(turns.push(pcm(20,1000)).started,false)
 assert.deepEqual(turns.flush(),pcm(220,1000))
})

test('持续采集仅保留200ms前滚，并在600ms尾静音后封口真实PCM',()=>{
 const turns=createPcmTurns()
 assert.deepEqual(append(turns,pcm(30000)),[])
 assert.equal(turns.active,false)
 assert.deepEqual(turns.push(pcm(20,1000)),{started:false,turn:null})
 assert.equal(turns.active,true)
 append(turns,pcm(180,1000));append(turns,pcm(580))
 assert.equal(turns.active,true)
 const result=turns.push(pcm(20))
 assert.equal(result.started,false);assert.ok(result.turn)
 assert.deepEqual(result.turn,Uint8Array.from(Buffer.concat([pcm(200),pcm(200,1000),pcm(600)])))
 assert.equal(turns.active,false);assert.equal(turns.flush(),null)
})
test('低于RMS阈值的背景与不足200ms发声不产生可提交片段',()=>{
 const turns=createPcmTurns()
 assert.deepEqual(append(turns,pcm(1000,400)),[])
 assert.equal(turns.active,false)
 assert.deepEqual(append(turns,Buffer.concat([pcm(180,600),pcm(600)])),[])
 assert.equal(turns.flush(),null);assert.equal(turns.active,false)
 append(turns,pcm(200,600));assert.equal(turns.flush()?.length,6400)
})
test('不同网络分块不改变分段内容，输入视图修改不改已采集音频',()=>{
 const audio=Buffer.concat([pcm(300),pcm(240,1000),pcm(600)])
 const whole=createPcmTurns(),fragmented=createPcmTurns()
 assert.deepEqual(append(whole,audio),append(fragmented,audio,194))
 const turns=createPcmTurns(),input=pcm(200,1000)
 turns.push(input);input.fill(0)
 assert.deepEqual(turns.flush(),pcm(200,1000))
})
test('15秒持续发声分段后继续采集，flush与reset不会重播旧段',()=>{
 const turns=createPcmTurns(),completed=append(turns,pcm(16000,1000))
 assert.equal(completed.length,1);assert.equal(completed[0]?.length,480000)
 assert.equal(turns.active,true);assert.deepEqual(turns.flush(),pcm(1000,1000));assert.equal(turns.flush(),null)
 append(turns,pcm(200,1000));turns.reset();assert.equal(turns.active,false);assert.equal(turns.flush(),null)
})
test('一个网络包内的多段话逐次取出，不因后续段覆盖前段',()=>{
 const turns=createPcmTurns(),result=turns.push(Buffer.concat([pcm(200,1000),pcm(600),pcm(200,2000),pcm(600)]))
 assert.equal(result.started,true)
 assert.deepEqual(result.turn,Uint8Array.from(Buffer.concat([pcm(200,1000),pcm(600)])))
 assert.deepEqual(turns.flush(),Uint8Array.from(Buffer.concat([pcm(200,2000),pcm(600)])))
 assert.equal(turns.flush(),null)
})
test('拒绝奇字节和超限网络包，拒绝累积超过16秒的未取出片段',()=>{
 const turns=createPcmTurns()
 assert.throws(()=>turns.push(new Uint8Array(3)),RangeError)
 assert.throws(()=>turns.push(new Uint8Array(65538)),RangeError)
 assert.throws(()=>turns.push('文字' as unknown as Uint8Array),RangeError)
 assert.equal(turns.active,false)
 const repeated=Buffer.concat([pcm(200,1000),pcm(600),pcm(200,1000),pcm(600)])
 assert.throws(()=>{for(let i=0;i<30;i++)turns.push(repeated)},RangeError)
})
test('WAV头声明16kHz单声道PCM16且保留精确音频字节',()=>{
 const input=Uint8Array.from([0,0,255,127,0,128]),wav=encodePcmWav(input),bytes=Buffer.from(wav)
 assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.readUInt32LE(4),42)
 assert.equal(bytes.toString('ascii',8,16),'WAVEfmt ');assert.equal(bytes.readUInt32LE(16),16)
 assert.equal(bytes.readUInt16LE(20),1);assert.equal(bytes.readUInt16LE(22),1)
 assert.equal(bytes.readUInt32LE(24),16000);assert.equal(bytes.readUInt32LE(28),32000)
 assert.equal(bytes.readUInt16LE(32),2);assert.equal(bytes.readUInt16LE(34),16)
 assert.equal(bytes.toString('ascii',36,40),'data');assert.equal(bytes.readUInt32LE(40),6)
 assert.deepEqual(wav.subarray(44),input)
 for(const invalid of [new Uint8Array(0),new Uint8Array(1),new Uint8Array(512002)])assert.throws(()=>encodePcmWav(invalid),RangeError)
})
