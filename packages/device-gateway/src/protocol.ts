export const deviceProtocol='teloa-device/v1'
export const audioHeaderBytes=16,maxOpusBytes=4096,maxControlBytes=16384
export type AudioBinding=Readonly<{kind:1|2;connectionGeneration:number;streamId:number}>
type AudioFrame=AudioBinding&Readonly<{sequence:number;payload:Uint8Array}>
const invalid=()=>new Error('设备协议不兼容或媒体流已经失效。')
const uint=(value:unknown,minimum=0):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=minimum&&value<0xffffffff
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const exact=(value:Record<string,unknown>,fields:readonly string[])=>Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key))
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

export function encodeAudioFrame(frame:AudioFrame):Uint8Array{
 if(![1,2].includes(frame.kind)||!uint(frame.connectionGeneration,1)||!uint(frame.streamId,1)||!uint(frame.sequence)||!(frame.payload instanceof Uint8Array)||frame.payload.byteLength<1||frame.payload.byteLength>maxOpusBytes)throw invalid()
 const bytes=new Uint8Array(audioHeaderBytes+frame.payload.byteLength),view=new DataView(bytes.buffer)
 view.setUint8(0,1);view.setUint8(1,frame.kind)
 view.setUint32(4,frame.connectionGeneration);view.setUint32(8,frame.streamId);view.setUint32(12,frame.sequence)
 bytes.set(frame.payload,audioHeaderBytes)
 return bytes
}

/** 一次绑定只消费一条有序流；关闭、重复或错误帧后不再恢复这条流。 */
export function createAudioReceiver(binding:AudioBinding){
 if(![1,2].includes(binding.kind)||!uint(binding.connectionGeneration,1)||!uint(binding.streamId,1))throw invalid()
 let sequence=0,closed=false
 return Object.freeze({
  close(){closed=true},
  accept(bytes:Uint8Array):Uint8Array{
   const reject=():never=>{closed=true;throw invalid()}
   if(closed||!(bytes instanceof Uint8Array)||bytes.byteLength<=audioHeaderBytes||bytes.byteLength>audioHeaderBytes+maxOpusBytes)return reject()
   const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)
   if(view.getUint8(0)!==1||view.getUint8(1)!==binding.kind||view.getUint16(2)!==0||view.getUint32(4)!==binding.connectionGeneration||view.getUint32(8)!==binding.streamId||view.getUint32(12)!==sequence||!uint(sequence))return reject()
   sequence++
   return bytes.slice(audioHeaderBytes)
  },
 })
}

type CaptureControl=Readonly<{type:'listen.start'|'listen.stop'|'request.status'|'playback.repeat';captureId:string}>
type OpusFormat=Readonly<{format:'opus';sampleRate:16000|24000;channels:1;frameDurationMs:60}>
export type DeviceControl=CaptureControl|Readonly<{type:'approval.list';index:number}>|Readonly<{type:'approval.decide';ticket:string;digest:string;decision:'approve'|'reject'}>|Readonly<{type:'abort'}>|Readonly<{type:'playback.ready';streamId:number}>|Readonly<{type:'playback.progress';streamId:number;sequence:number}>|Readonly<{type:'playback.played';streamId:number;lastSequence:number}>|Readonly<{type:'hello';protocol:typeof deviceProtocol;audio:Readonly<{uplink:OpusFormat;downlink:OpusFormat}>}>
const format=(value:unknown,rate:number)=>object(value)&&exact(value,['format','sampleRate','channels','frameDurationMs'])&&value.format==='opus'&&value.sampleRate===rate&&value.channels===1&&value.frameDurationMs===60

/** 此处只校验有限设备协议；身份、绑定与授权由网关和宿主决定。 */
export function readDeviceControl(bytes:Uint8Array):DeviceControl{
 if(!(bytes instanceof Uint8Array)||bytes.byteLength<1||bytes.byteLength>maxControlBytes)throw invalid()
 let value:unknown
 try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw invalid()}
 if(!object(value))throw invalid()
 if(['listen.start','listen.stop','request.status','playback.repeat'].includes(String(value.type))&&exact(value,['type','captureId'])&&uuid(value.captureId))return value as CaptureControl
 if(value.type==='abort'&&exact(value,['type']))return {type:'abort'}
 if(value.type==='approval.list'&&exact(value,['type','index'])&&uint(value.index)&&value.index<20)return {type:'approval.list',index:value.index}
 if(value.type==='approval.decide'&&exact(value,['type','ticket','digest','decision'])&&uuid(value.ticket)&&typeof value.digest==='string'&&/^[a-f0-9]{64}$/.test(value.digest)&&(value.decision==='approve'||value.decision==='reject'))return value as Extract<DeviceControl,{type:'approval.decide'}>
 if(value.type==='playback.ready'&&exact(value,['type','streamId'])&&uint(value.streamId,1))return {type:'playback.ready',streamId:value.streamId}
 if(value.type==='playback.progress'&&exact(value,['type','streamId','sequence'])&&uint(value.streamId,1)&&uint(value.sequence))return {type:'playback.progress',streamId:value.streamId,sequence:value.sequence}
 if(value.type==='playback.played'&&exact(value,['type','streamId','lastSequence'])&&uint(value.streamId,1)&&uint(value.lastSequence))return {type:'playback.played',streamId:value.streamId,lastSequence:value.lastSequence}
 if(value.type==='hello'&&exact(value,['type','protocol','audio'])&&value.protocol===deviceProtocol&&object(value.audio)&&exact(value.audio,['uplink','downlink'])&&format(value.audio.uplink,16000)&&format(value.audio.downlink,24000))return value as DeviceControl
 throw invalid()
}

/** 宿主下行也限定为固定控制消息，不能由模型传入 URL 或任意 RPC。 */
export type HostControl=
 |Readonly<{type:'approval.card';ticket:string;digest:string;text:string;canDecide:boolean;index:number;total:number}>
 |Readonly<{type:'approval.ack';ticket:string;state:'submitted'|'stale'}>
 |Readonly<{type:'hello';protocol:typeof deviceProtocol;connectionGeneration:number}>
 |Readonly<{type:'listen.ready';captureId:string;streamId:number}>
 |Readonly<{type:'listen.sealed';captureId:string;reason:'silence'|'stop'|'limit'}>
 |Readonly<{type:'transcript';captureId:string;text:string}>
 |Readonly<{type:'request.receipt';captureId:string;state:'pending'|'needs_approval'|'completed'|'unknown'|'rejected';text:string}>
 |Readonly<{type:'playback.start';captureId:string;streamId:number;sampleRate:24000;frameDurationMs:60}>
 |Readonly<{type:'playback.text';streamId:number;text:string}>
 |Readonly<{type:'playback.end';streamId:number;lastSequence:number}>
 |Readonly<{type:'playback.interrupted';streamId:number}>
 |Readonly<{type:'error';code:'busy'|'unavailable'|'no-speech'|'capture-rejected'|'playback-failed'}>

export function encodeHostControl(value:HostControl):Uint8Array{
 const row=value as unknown as Record<string,unknown>,type=row.type
 const text=(maximum:number)=>typeof row.text==='string'&&Array.from(row.text).length<=maximum&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(row.text)
 const stream=()=>uint(row.streamId,1),capture=()=>uuid(row.captureId)
 const valid=
  type==='approval.card'&&exact(row,['type','ticket','digest','text','canDecide','index','total'])&&uuid(row.ticket)&&typeof row.digest==='string'&&/^[a-f0-9]{64}$/.test(row.digest)&&text(4000)&&typeof row.canDecide==='boolean'&&uint(row.index)&&Number(row.index)<20&&uint(row.total)&&Number(row.total)<=20||
  type==='approval.ack'&&exact(row,['type','ticket','state'])&&uuid(row.ticket)&&['submitted','stale'].includes(String(row.state))||
  type==='hello'&&exact(row,['type','protocol','connectionGeneration'])&&row.protocol===deviceProtocol&&uint(row.connectionGeneration,1)||
  type==='listen.ready'&&exact(row,['type','captureId','streamId'])&&capture()&&stream()||
  type==='listen.sealed'&&exact(row,['type','captureId','reason'])&&capture()&&['silence','stop','limit'].includes(String(row.reason))||
  type==='transcript'&&exact(row,['type','captureId','text'])&&capture()&&text(4000)||
  type==='request.receipt'&&exact(row,['type','captureId','state','text'])&&capture()&&['pending','needs_approval','completed','unknown','rejected'].includes(String(row.state))&&text(1200)||
  type==='playback.start'&&exact(row,['type','captureId','streamId','sampleRate','frameDurationMs'])&&capture()&&stream()&&row.sampleRate===24000&&row.frameDurationMs===60||
  type==='playback.text'&&exact(row,['type','streamId','text'])&&stream()&&text(240)||
  type==='playback.end'&&exact(row,['type','streamId','lastSequence'])&&stream()&&uint(row.lastSequence)||
  type==='playback.interrupted'&&exact(row,['type','streamId'])&&stream()||
  type==='error'&&exact(row,['type','code'])&&['busy','unavailable','no-speech','capture-rejected','playback-failed'].includes(String(row.code))
 if(!valid)throw invalid()
 const bytes=new TextEncoder().encode(JSON.stringify(row))
 if(bytes.byteLength>maxControlBytes)throw invalid()
 return bytes
}
