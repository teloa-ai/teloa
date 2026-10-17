import type {VoiceActivityDetector} from '@teloa/harness-dsh/voice-plugin'

const frameBytes=1024,maxTurnBytes=480000,preRollBytes=10240
/** 持续采音：192ms 连续人声才打断，608ms 尾静音封口；保留首音和192ms尾音。 */
export function createNeuralPcmTurns(vad:VoiceActivityDetector,onPreview?:(pcm:Uint8Array|null)=>void){
 let carry=new Uint8Array(),ring:Uint8Array[]=[],parts:Uint8Array[]=[],length=0,onset=0,quiet=0,confirmed=false,previewed=false,epoch=0
 const clear=()=>{ring=[];parts=[];length=onset=quiet=0;confirmed=previewed=false}
 const reset=()=>{epoch++;onPreview?.(null);carry=new Uint8Array();clear();vad.reset()}
 const snapshot=()=>{
  const kept=length-Math.max(0,quiet-6144),turn=confirmed?new Uint8Array(kept):null
  if(turn){let at=0;for(const part of parts){const take=Math.min(part.length,kept-at);if(take>0)turn.set(part.subarray(0,take),at);at+=take}}
  return turn
 }
 const finish=()=>{const turn=snapshot();clear();return turn}
 const consume=async(bytes:Uint8Array,current:number)=>{
  const pcm=new Int16Array(512),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)
  for(let at=0;at<bytes.length/2;at++)pcm[at]=view.getInt16(at*2,true)
  const probability=await vad.predict(pcm)
  if(current!==epoch)return {started:false,turn:null}
  if(!Number.isFinite(probability)||probability<0||probability>1)throw Error('Invalid voice activity')
  let started=false
  if(!confirmed){
   ring.push(bytes);while(ring.reduce((sum,part)=>sum+part.length,0)>preRollBytes)ring.shift()
   onset=probability>=.6?onset+bytes.length:0
   if(onset>=6144){confirmed=true;parts=ring;ring=[];length=parts.reduce((sum,part)=>sum+part.length,0);quiet=0;started=true}
  }else{
   if(probability>=.35&&previewed){onPreview?.(null);previewed=false}
   parts.push(bytes);length+=bytes.length;quiet=probability>=.35?0:quiet+bytes.length
  }
  // 本机识别先吃192ms尾音的候选；仍等608ms封口，续说时撤销，绝不提前交办。
  if(onPreview&&confirmed&&!previewed&&quiet>=6144){previewed=true;onPreview(snapshot())}
  return {started,turn:confirmed&&(quiet>=19456||length>=maxTurnBytes)?finish():null}
 }
 return Object.freeze({
  async push(bytes:Uint8Array){
   if(!(bytes instanceof Uint8Array)||bytes.length%2||bytes.length>640)throw RangeError('Invalid PCM window')
   const current=epoch,input=new Uint8Array(carry.length+bytes.length);input.set(carry);input.set(bytes,carry.length)
   if(input.length<frameBytes){carry=input;return {started:false,turn:null}}
   carry=input.slice(frameBytes)
   return consume(input.slice(0,frameBytes),current)
  },
  async flush(){
   const current=epoch
   if(carry.length){const bytes=carry;carry=new Uint8Array();const result=await consume(bytes,current);if(result.turn)return result.turn}
   return current===epoch?finish():null
  },
  reset,
  get active(){return confirmed||onset>0},
 })
}
