const sampleRate=16000,bytesPerSecond=sampleRate*2
const windowBytes=640,preRollBytes=6400,tailSilenceBytes=19200,minVoiceBytes=6400
const maxTurnBytes=15*bytesPerSecond,maxBufferedBytes=16*bytesPerSecond,maxFrameBytes=64*1024
const invalid=()=>new RangeError('PCM 音频格式或长度不正确。')
const join=(parts:readonly Uint8Array[],length:number)=>{
 const bytes=new Uint8Array(length);let offset=0
 for(const part of parts){bytes.set(part,offset);offset+=part.byteLength}
 return bytes
}
function valid(bytes:Uint8Array,limit:number):void{
 if(!(bytes instanceof Uint8Array)||bytes.byteLength%2||bytes.byteLength>limit)throw invalid()
}
function voiced(bytes:Uint8Array):boolean{
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let squares=0
 for(let offset=0;offset<bytes.byteLength;offset+=2){const sample=view.getInt16(offset,true)/32768;squares+=sample*sample}
 return Math.sqrt(squares/(bytes.byteLength/2))>=0.015
}

/** 固定16k单声道PCM16；采集和分段不依赖推理或播放状态。 */
export function createPcmTurns(){
 let carry=new Uint8Array(0),preRoll=new Uint8Array(0),parts:Uint8Array[]=[],length=0,voiceBytes=0,silenceBytes=0,confirmed=false
 const completed:Uint8Array[]=[]
 let completedBytes=0,first:Uint8Array|null=null,started=false
 const clearActive=()=>{parts=[];length=0;voiceBytes=0;silenceBytes=0;confirmed=false}
 const reset=()=>{clearActive();carry=new Uint8Array(0);preRoll=new Uint8Array(0);completed.length=0;completedBytes=0;first=null;started=false}
 const finish=()=>{
  if(voiceBytes>=minVoiceBytes){
   const turn=join(parts,length)
   if(first===null)first=turn
   else{completed.push(turn);completedBytes+=turn.byteLength}
  }
  clearActive();preRoll=new Uint8Array(0)
 }
 const consume=(window:Uint8Array)=>{
  const speaking=voiced(window)
  if(!length&&!speaking){
   const next=join([preRoll,window],preRoll.byteLength+window.byteLength)
   preRoll=next.slice(Math.max(0,next.byteLength-preRollBytes));return
  }
  if(!length){
   if(preRoll.byteLength){parts.push(preRoll);length=preRoll.byteLength;preRoll=new Uint8Array(0)}
  }
  parts.push(window);length+=window.byteLength
  if(speaking){voiceBytes+=window.byteLength;silenceBytes=0}else silenceBytes+=window.byteLength
  // 先保留候选起音，达到同一段的最低可提交发声量后才撤销原播报。
  // 否则一个会被封口丢弃的短噪声，也会永久废弃正在生成的回答。
  if(!confirmed&&voiceBytes>=minVoiceBytes){confirmed=true;started=true}
  if(silenceBytes>=tailSilenceBytes||length>=maxTurnBytes)finish()
  if(completedBytes+length+preRoll.byteLength+carry.byteLength>maxBufferedBytes){reset();throw invalid()}
 }
 const take=()=>{const turn=completed.shift()??null;if(turn)completedBytes-=turn.byteLength;return turn}
 return Object.freeze({
  push(bytes:Uint8Array):{started:boolean;turn:Uint8Array|null}{
   valid(bytes,maxFrameBytes);first=take();started=false
   const input=join([carry,bytes],carry.byteLength+bytes.byteLength)
   const complete=input.byteLength-input.byteLength%windowBytes
   carry=input.slice(complete)
   for(let offset=0;offset<complete;offset+=windowBytes)consume(input.slice(offset,offset+windowBytes))
   const turn=first;first=null
   return {started,turn}
  },
  flush():Uint8Array|null{
   first=take();started=false
   if(carry.byteLength){const window=carry;carry=new Uint8Array(0);consume(window)}
   if(length)finish()
   preRoll=new Uint8Array(0)
   const turn=first;first=null;return turn
  },
  reset,
  get active(){return length>0},
 })
}

/** 只封装已采集的PCM字节，WAV头不改变采样内容。 */
export function encodePcmWav(pcm:Uint8Array):Uint8Array{
 valid(pcm,maxBufferedBytes);if(!pcm.byteLength)throw invalid()
 const wav=new Uint8Array(44+pcm.byteLength),view=new DataView(wav.buffer)
 const ascii=(offset:number,value:string)=>{for(let index=0;index<value.length;index++)wav[offset+index]=value.charCodeAt(index)}
 ascii(0,'RIFF');view.setUint32(4,36+pcm.byteLength,true);ascii(8,'WAVE');ascii(12,'fmt ')
 view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true)
 view.setUint32(24,sampleRate,true);view.setUint32(28,bytesPerSecond,true);view.setUint16(32,2,true);view.setUint16(34,16,true)
 ascii(36,'data');view.setUint32(40,pcm.byteLength,true);wav.set(pcm,44);return wav
}
