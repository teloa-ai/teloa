import test from 'node:test'
import assert from 'node:assert/strict'
import {encodeAudioFrame,createAudioReceiver,readDeviceControl} from '../src/protocol.ts'

const binding={kind:1 as const,connectionGeneration:7,streamId:9}
const packet=(sequence=0)=>encodeAudioFrame({...binding,sequence,payload:Uint8Array.from([0xf8,0xff,0xfe])})

test('设备音频固定为网络字节序的 16 字节头，按连接和流顺序接收',()=>{
 assert.equal(Buffer.from(packet()).toString('hex'),'01010000000000070000000900000000f8fffe')
 const receiver=createAudioReceiver(binding)
 assert.deepEqual([...receiver.accept(packet())],[0xf8,0xff,0xfe])
 assert.deepEqual([...receiver.accept(packet(1))],[0xf8,0xff,0xfe])
 receiver.close()
 assert.throws(()=>receiver.accept(packet(2)))
})

test('重复、跳号、旧连接及错误方向的包拒绝，不能串入下一轮',()=>{
 for(const [offset,value]of [[0,2],[1,2],[2,1],[7,8],[11,10],[15,1]]){
  const data=packet();data[offset!]=value!
  assert.throws(()=>createAudioReceiver(binding).accept(data))
 }
 const receiver=createAudioReceiver(binding)
 receiver.accept(packet())
 assert.throws(()=>receiver.accept(packet()))
})

test('空载荷、超量及溢出字段在音频处理前拒绝',()=>{
 assert.throws(()=>createAudioReceiver(binding).accept(packet().slice(0,16)))
 assert.throws(()=>createAudioReceiver(binding).accept(new Uint8Array(16+4097)))
 for(const field of ['streamId','connectionGeneration','sequence'])for(const value of [-1,1.5,0xffffffff]){
  assert.throws(()=>encodeAudioFrame({...binding,sequence:0,[field]:value,payload:new Uint8Array([1])}))
 }
})

test('控制消息严格限定已知设备动作，不能携带 owner、session、URL 或审批结论',()=>{
 const captureId='93ad3ad6-cb03-4366-babf-af71df380e04'
 const read=(value:unknown)=>readDeviceControl(Buffer.from(JSON.stringify(value)))
 assert.deepEqual(read({type:'listen.start',captureId}),{type:'listen.start',captureId})
 assert.deepEqual(read({type:'request.status',captureId}),{type:'request.status',captureId})
 for(const extra of [{ownerId:'foreign'},{sessionId:'foreign'},{url:'https://other'},{approved:true}])assert.throws(()=>read({type:'listen.start',captureId,...extra}))
 for(const value of [{type:'shell',command:'ls'},{type:'listen.start',captureId:'bad'},{type:'playback.ready',streamId:0},{type:'abort',captureId}])assert.throws(()=>read(value))
 assert.throws(()=>readDeviceControl(new Uint8Array(16385)))
 assert.throws(()=>readDeviceControl(Uint8Array.from([0xff])))
})

test('hello 固定 Teloa 协议和 Opus 参数，不兼容时不能回退官方服务',()=>{
 const hello={type:'hello',protocol:'teloa-device/v1',audio:{uplink:{format:'opus',sampleRate:16000,channels:1,frameDurationMs:60},downlink:{format:'opus',sampleRate:24000,channels:1,frameDurationMs:60}}}
 const read=(value:unknown)=>readDeviceControl(Buffer.from(JSON.stringify(value)))
 assert.deepEqual(read(hello),hello)
 assert.throws(()=>read({...hello,protocol:'xiaozhi'}))
 assert.throws(()=>read({...hello,audio:{...hello.audio,uplink:{...hello.audio.uplink,sampleRate:24000}}}))
})
