import {WorkError,speechProviderNames,type SpeechProviderId} from '@teloa/contract'
import {createMiniMaxSpeech} from './minimax-speech.ts'
import {createSpeechStreamTimeout} from './speech-stream-timeout.ts'

export type SpeechVoice=Readonly<{model:string;voiceId:string}>
type Synthesize=(text:string,voice:SpeechVoice,signal:AbortSignal,onAudio:(bytes:Uint8Array)=>void|Promise<void>)=>Promise<void>
export type SpeechAdapter=Readonly<{speak:Synthesize;speakPcm:Synthesize}>
type Ports=Readonly<{key:(id:SpeechProviderId)=>Promise<string|undefined>;fetch?:typeof fetch}>

const maxText=10000,maxAudio=20*1024*1024,openAiInputLimit=4096
const invalid=(message='语音内容或格式不正确。')=>new WorkError('teloa/invalid-input',message)
const unavailable=(id:SpeechProviderId)=>new WorkError('teloa/unavailable',speechProviderNames[id]+' 语音服务暂不可用，请检查凭据或稍后重试。')
const unconfigured=(id:SpeechProviderId)=>new WorkError('teloa/unavailable','尚未配置 '+speechProviderNames[id]+' 语音凭据。')
const checkText=(text:string)=>{if(typeof text!=='string'||!text.trim()||text.length>=maxText)throw invalid()}

/** 按句切段并保持原文逐字不变；单句超过上限时明确失败，不截断、不丢字。 */
export function splitSpeechText(text:string,limit:number):string[]{
 const sentences=text.match(/[^。！？!?；;\n]*[。！？!?；;\n]+|[^。！？!?；;\n]+$/g)??[]
 if(sentences.join('')!==text)throw invalid()
 const segments:string[]=[];let current=''
 for(const sentence of sentences){
  if(sentence.length>limit)throw invalid('播报内容中有一句过长，无法分段，请缩短后重试。')
  if(current.length+sentence.length>limit){segments.push(current);current=''}
  current+=sentence
 }
 if(current)segments.push(current)
 return segments
}
const adapter=(speak:Synthesize,speakPcm:Synthesize):SpeechAdapter=>Object.freeze({speak,speakPcm})
const looksLikeMp3=(bytes:Buffer)=>bytes.toString('ascii',0,3)==='ID3'||bytes[0]===0xff&&((bytes[1]??0)&0xe0)===0xe0

/** 有界读取音频流：MP3 校验文件头，PCM 校验采样字节；取消或超时即中止读取。 */
async function streamAudio(id:SpeechProviderId,request:typeof fetch,url:string,init:RequestInit,signal:AbortSignal,onAudio:(bytes:Uint8Array)=>void|Promise<void>,total:{bytes:number},pcm=false){
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
 const network=createSpeechStreamTimeout(signal),requestSignal=network.signal,cancel=()=>{void reader?.cancel().catch(()=>{})}
 try{
  const response=await network.wait(()=>request(url,{...init,method:'POST',redirect:'error',signal:requestSignal}))
  const type=response.headers.get('content-type')??''
  if(!response.ok||!(pcm?/^(audio\/(pcm|raw|L16)|application\/octet-stream)(;|$)/i.test(type):/^audio\/(mpeg|mp3)\b/i.test(type))||!response.body)throw unavailable(id)
  reader=response.body.getReader();requestSignal.addEventListener('abort',cancel,{once:true});requestSignal.throwIfAborted()
  let head=Buffer.alloc(0),checked=pcm,received=0
  while(true){
   requestSignal.throwIfAborted();const next=await network.wait(()=>reader!.read());requestSignal.throwIfAborted()
   if(next.done)break
   const bytes=Buffer.from(next.value);received+=bytes.length;total.bytes+=bytes.length
   if(total.bytes>maxAudio)throw unavailable(id)
   if(!checked){head=Buffer.concat([head,bytes]);if(head.length<3)continue;if(!looksLikeMp3(head))throw unavailable(id);checked=true;await onAudio(head);signal.throwIfAborted();continue}
   await onAudio(bytes);signal.throwIfAborted()
  }
  if(!checked||!received||pcm&&received%2!==0)throw unavailable(id)
 }catch(error){signal.throwIfAborted();if(error instanceof WorkError)throw error;throw unavailable(id)}
 finally{requestSignal.removeEventListener('abort',cancel);await reader?.cancel().catch(()=>{});reader?.releaseLock()}
}

/** 各厂商只连官方固定域名，凭据按厂商分别由宿主提供，不接受任意 URL，也不复用模型密钥。 */
export function createSpeechProviders(ports:Ports):Readonly<Record<SpeechProviderId,SpeechAdapter>>{
 const request=ports.fetch??fetch
 // 凭据解析失败也在适配器边界脱敏：取消照常抛出，其余一律换成不带原文的不可用错误。
 const key=async(id:SpeechProviderId,signal:AbortSignal)=>{
  signal.throwIfAborted();let value:string|undefined
  try{value=await ports.key(id)}catch{signal.throwIfAborted();throw unavailable(id)}
  signal.throwIfAborted();if(!value)throw unconfigured(id);return value
 }
 const miniMax=createMiniMaxSpeech({key:()=>ports.key('minimax'),...(ports.fetch?{fetch:ports.fetch}:{})})
 const openai=(pcm:boolean):Synthesize=>async(text,voice,signal,onAudio)=>{
   signal.throwIfAborted();checkText(text)
   const segments=splitSpeechText(text,openAiInputLimit),secret=await key('openai',signal),total={bytes:0}
   // 自定义音色按官方对象形式发送；内置音色为名称字符串。
   const voiceValue=voice.voiceId.startsWith('voice_')?{id:voice.voiceId}:voice.voiceId
   for(const input of segments)await streamAudio('openai',request,'https://api.openai.com/v1/audio/speech',{headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({model:voice.model,voice:voiceValue,input,response_format:pcm?'pcm':'mp3',stream_format:'audio'})},signal,onAudio,total,pcm)
 }
 const elevenlabs=(pcm:boolean):Synthesize=>async(text,voice,signal,onAudio)=>{
   signal.throwIfAborted();checkText(text)
   const secret=await key('elevenlabs',signal)
   await streamAudio('elevenlabs',request,'https://api.elevenlabs.io/v1/text-to-speech/'+encodeURIComponent(voice.voiceId)+'/stream?output_format='+(pcm?'pcm_24000':'mp3_44100_128'),{headers:{'xi-api-key':secret,'Content-Type':'application/json'},body:JSON.stringify({text,model_id:voice.model})},signal,onAudio,{bytes:0},pcm)
 }
 return Object.freeze({
  minimax:adapter((text,voice,signal,onAudio)=>miniMax.speak(text,signal,onAudio,voice),(text,voice,signal,onAudio)=>miniMax.speakPcm(text,signal,onAudio,voice)),
  openai:adapter(openai(false),openai(true)),
  elevenlabs:adapter(elevenlabs(false),elevenlabs(true)),
 })
}
