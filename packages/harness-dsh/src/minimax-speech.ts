import {createHash} from 'node:crypto'
import {WorkError,speechProviderDefaults} from '@teloa/contract'
import {createSpeechStreamTimeout} from './speech-stream-timeout.ts'

type Ports=Readonly<{key:()=>Promise<string|undefined>;fetch?:typeof fetch}>
/** providerId 可省略以兼容已有受信媒体插件；宿主内置识别器始终返回真实来源。 */
export type MiniMaxTranscript=Readonly<{text:string;audioSha256:string;receiptId:string;providerId?:'minimax'|'sensevoice-local'}>
const unavailable=()=>new WorkError('teloa/unavailable','MiniMax 语音服务暂不可用，请检查凭据或稍后重试。')
const invalid=()=>new WorkError('teloa/invalid-input','语音内容或格式不正确。')
const maxAudio=20*1024*1024,maxFrame=1024*1024
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
async function readJson(response:Response,signal:AbortSignal){
 if(!response.body)throw unavailable()
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0
 const cancel=()=>{void reader.cancel().catch(()=>{})};signal.addEventListener('abort',cancel,{once:true})
 try{signal.throwIfAborted();while(true){const next=await reader.read();signal.throwIfAborted();if(next.done)break;size+=next.value.byteLength;if(size>maxFrame)throw unavailable();parts.push(next.value)}return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown}
 finally{signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock()}
}
/** 固定供应商端点，密钥只由宿主提供；不接受任意 URL、自填转写或模型凭据。 */
export function createMiniMaxSpeech(ports:Ports){
 const request=ports.fetch??fetch
 const headers=async(signal:AbortSignal)=>{
  signal.throwIfAborted();const key=await ports.key();signal.throwIfAborted()
  if(!key)throw new WorkError('teloa/unavailable','尚未配置 MiniMax 语音凭据。')
  return {Authorization:'Bearer '+key}
 }
 const synthesize=async(text:string,signal:AbortSignal,onAudio:(bytes:Uint8Array)=>void|Promise<void>,voice:Readonly<{model:string;voiceId:string}>,format:'mp3'|'pcm'):Promise<void>=>{
   signal.throwIfAborted();if(typeof text!=='string'||!text.trim()||text.length>=10000)throw invalid()
   let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
   const network=createSpeechStreamTimeout(signal),requestSignal=network.signal,cancel=()=>{void reader?.cancel().catch(()=>{})}
   try{
    const auth=await headers(signal)
    const response=await network.wait(()=>request('https://api.minimax.io/v1/t2a_v2',{method:'POST',headers:{...auth,'Content-Type':'application/json'},redirect:'error',signal:requestSignal,body:JSON.stringify({model:voice.model,text,stream:true,stream_options:{exclude_aggregated_audio:true},language_boost:'auto',voice_setting:{voice_id:voice.voiceId,speed:1,vol:1,pitch:0},audio_setting:format==='pcm'?{format:'pcm',sample_rate:24000,channel:1}:{sample_rate:32000,bitrate:128000,format:'mp3',channel:1}})}))
    if(!response.ok||!response.headers.get('content-type')?.startsWith('text/event-stream')||!response.body)throw unavailable()
    reader=response.body.getReader();requestSignal.addEventListener('abort',cancel,{once:true});requestSignal.throwIfAborted();const decoder=new TextDecoder();let pending='',finished=false,total=0
    const frame=async(value:string)=>{
     const data=value.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')
     if(!data)return
     const result:unknown=JSON.parse(data)
     if(!object(result)||!object(result.base_resp)||result.base_resp.status_code!==0||!object(result.data)||![1,2].includes(Number(result.data.status)))throw unavailable()
     const row=result.data,audio=row.audio
     // 已要求排除聚合音频，结束帧再给音频属于不能安全播放的回包。
     if(finished||row.status===2&&audio)throw unavailable()
     if(audio!==undefined&&audio!==''){
      if(typeof audio!=='string'||audio.length%2||!/^[a-fA-F0-9]+$/.test(audio))throw unavailable()
      const bytes=Buffer.from(audio,'hex');total+=bytes.length;if(total>maxAudio)throw unavailable()
      signal.throwIfAborted();await onAudio(bytes);signal.throwIfAborted()
     }
     if(row.status===2)finished=true
    }
    while(true){
     requestSignal.throwIfAborted();const next=await network.wait(()=>reader!.read());requestSignal.throwIfAborted();pending+=next.done?decoder.decode():decoder.decode(next.value,{stream:true})
     let match:RegExpExecArray|null
     while((match=/\r?\n\r?\n/.exec(pending))){const value=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);if(value.length>maxFrame)throw unavailable();await frame(value)}
     if(pending.length>maxFrame)throw unavailable()
     if(next.done){if(pending.trim())await frame(pending);break}
    }
    if(!finished||!total)throw unavailable()
   }catch(error){signal.throwIfAborted();if(error instanceof WorkError)throw error;throw unavailable()}
   finally{requestSignal.removeEventListener('abort',cancel);await reader?.cancel().catch(()=>{});reader?.releaseLock()}
 }
 return Object.freeze({
  async transcribe(audio:Uint8Array,format:'wav'|'mp3',signal:AbortSignal):Promise<MiniMaxTranscript|null>{
   signal.throwIfAborted()
   const bytes=Buffer.from(audio),wav=bytes.length>=44&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE',mp3=bytes.length>=4&&(bytes.toString('ascii',0,3)==='ID3'||bytes[0]===255&&(bytes[1]!&224)===224)
   if(bytes.length>maxAudio||format!=='wav'&&format!=='mp3'||!(format==='wav'?wav:mp3))throw invalid()
   try{
    const auth=await headers(signal),form=new FormData()
    form.set('model','asr-1.0');form.set('response_format','json');form.set('stream','false')
    form.set('file',new Blob([Uint8Array.from(bytes)],{type:format==='wav'?'audio/wav':'audio/mpeg'}),'utterance.'+format)
    const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(60000)])
    const response=await request('https://api.minimax.io/v1/speech_to_text',{method:'POST',headers:auth,body:form,redirect:'error',signal:requestSignal})
    if(!response.ok)throw unavailable()
    const result=await readJson(response,requestSignal);signal.throwIfAborted()
    if(!object(result)||object(result.base_resp)&&result.base_resp.status_code!==0||typeof result.text!=='string'||result.text.length>65536)throw unavailable()
    const text=result.text.trim();if(!text)return null
    if(typeof result.trace_id!=='string'||!/^[a-zA-Z0-9_:-]{1,256}$/.test(result.trace_id))throw unavailable()
    return Object.freeze({text,audioSha256:createHash('sha256').update(bytes).digest('hex'),receiptId:result.trace_id,providerId:'minimax'})
   }catch(error){signal.throwIfAborted();if(error instanceof WorkError)throw error;throw unavailable()}
  },
  speak(text:string,signal:AbortSignal,onAudio:(bytes:Uint8Array)=>void|Promise<void>,voice:Readonly<{model:string;voiceId:string}>=speechProviderDefaults.minimax):Promise<void>{return synthesize(text,signal,onAudio,voice,'mp3')},
  speakPcm(text:string,signal:AbortSignal,onAudio:(bytes:Uint8Array)=>void|Promise<void>,voice:Readonly<{model:string;voiceId:string}>=speechProviderDefaults.minimax):Promise<void>{return synthesize(text,signal,onAudio,voice,'pcm')},
 })
}
