import {createHash,randomUUID} from 'node:crypto'
import {WorkError,isRecord} from '@teloa/contract'
import type SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import type {SpeechProviderId} from '@deepseek-ai/dsh-experimental-speech-to-text'
import {validateWave} from '@deepseek-ai/dsh-experimental-speech-to-text/wave'
import type {MiniMaxTranscript} from './minimax-speech.ts'

type Registry=Pick<SpeechToText,'snapshot'|'resolve'|'transcribe'|'prepare'>
const providerId='sensevoice-local' as SpeechProviderId
const maxAudioBytes=4*1024*1024,maxDurationSeconds=120
const unavailable=()=>new WorkError('teloa/unavailable','本机语音识别暂不可用，请先完成本地语音准备或稍后重试。')
const invalid=()=>new WorkError('teloa/invalid-input','语音识别需要有效的有界单声道 WAV 音频。')

function prepared(registry:Registry):boolean{
 const snapshot:unknown=registry.snapshot()
 if(!isRecord(snapshot)||!Array.isArray(snapshot.providers))return false
 const provider=snapshot.providers.find(row=>isRecord(row)&&row.id===providerId)
 if(!isRecord(provider)||provider.location!=='host-local'||!isRecord(provider.preparation))return false
 const phase=provider.preparation.phase
 return phase==='ready'||phase==='standby'||phase==='waking'
}

/** 固定使用本机已准备的 SenseVoice；不更改默认识别服务、不触发下载，也不回退到云端。 */
export function createLocalVoiceRecognition(read:()=>Registry|undefined){
 const transcribe=async(audio:Uint8Array,format:'wav'|'mp3',signal:AbortSignal):Promise<MiniMaxTranscript|null>=>{
   signal.throwIfAborted()
   if(format!=='wav'||audio.byteLength>maxAudioBytes)throw invalid()
   const bytes=Uint8Array.from(audio)
   try{validateWave(bytes,maxDurationSeconds)}catch{throw invalid()}
   const audioSha256=createHash('sha256').update(bytes).digest('hex')
   try{
    const registry=read();signal.throwIfAborted()
    if(!registry||!prepared(registry))throw unavailable()
    const spec=registry.resolve({audio:bytes,providerId,language:'auto'})
    if(spec.provider.info.id!==providerId||spec.provider.info.location!=='host-local'||spec.audio!==bytes||spec.language!=='auto')throw unavailable()
    // 注册表负责取消并等待本机进程清理；不以竞速超时丢弃尚在运行的识别。
    const result=await registry.transcribe(spec,signal);signal.throwIfAborted()
    if(typeof result.text!=='string'||result.text.length>65536||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result.text))throw unavailable()
    const text=result.text.trim();if(!text)return null
    // 官方结果没有厂商 trace；此回执仅代表宿主观察到的真实本机识别结果。
    return Object.freeze({text,providerId:'sensevoice-local',audioSha256,receiptId:'local-stt:'+randomUUID()})
   }catch{signal.throwIfAborted();throw unavailable()}
 }
 return Object.freeze({
  configured:()=>{try{const registry=read();return registry!==undefined&&prepared(registry)}catch{return false}},
  transcribe,
  async warm(signal:AbortSignal):Promise<void>{
   // 用静音提前唤醒已验证的本机运行时；仍经 transcribe 准入，绝不触发 prepare/下载。
   const audio=Buffer.alloc(44+10240)
   audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16)
   audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(16000,24);audio.writeUInt32LE(32000,28)
   audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(audio.length-44,40)
   await transcribe(audio,'wav',signal)
  },
 })
}
