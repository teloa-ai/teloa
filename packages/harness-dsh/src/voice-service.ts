import {WorkError,readVoiceServiceSave,readVoiceServiceTestInput,speechProviderIds,speechProviderNames,type SpeechProviderId,type VoiceServiceProbe,type VoiceServiceSettings} from '@teloa/contract'
import {createMiniMaxSpeech} from './minimax-speech.ts'
import {createSpeechProviders} from './speech-providers.ts'
import type {createVoiceServiceConfig} from './voice-service-config.ts'
import {createMiniMaxTtsSession,type MiniMaxTtsSession} from './minimax-tts-session.ts'

export const voiceServiceEndpoints=['voice-service/settings','voice-service/save','voice-service/test'] as const
export type VoiceCredentials=Readonly<{describe:(id:SpeechProviderId)=>Promise<{configured:boolean;writable:boolean}>;set:(id:SpeechProviderId,value:string)=>Promise<void>;resolve:(id:SpeechProviderId)=>Promise<string|undefined>}>
type MiniMaxSpeech=ReturnType<typeof createMiniMaxSpeech>
type Ports=Readonly<{credentials:VoiceCredentials;secure:()=>boolean;config:ReturnType<typeof createVoiceServiceConfig>;fetch?:typeof fetch;transcribe?:MiniMaxSpeech['transcribe'];localRecognition?:Readonly<{configured:()=>boolean;transcribe:MiniMaxSpeech['transcribe'];warm?:(signal:AbortSignal)=>Promise<void>}>;openMiniMaxPcmSession?:typeof createMiniMaxTtsSession}>
export type VoicePcmSession=MiniMaxTtsSession
/** 媒体与语音留言共用的语音端口：识别与播报分别读取本人已保存选择。 */
export type VoiceSpeech=Readonly<{speak:(text:string,signal:AbortSignal,onAudio:(bytes:Uint8Array)=>void|Promise<void>)=>Promise<void>;transcribe:MiniMaxSpeech['transcribe'];prepareRecognition?:MiniMaxSpeech['transcribe'];warm?:(signal:AbortSignal)=>Promise<void>;signature?:()=>Promise<string>}>

const invalid=()=>new WorkError('teloa/invalid-input','语音设置请求不正确。')
const empty=(value:unknown)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length)throw invalid()}

/** 只经本人连接装配，不进入工具分发或待恢复写命令；凭据只写不读，回包与错误都不带凭据值。 */
export function createVoiceService(ports:Ports){
 const providers=createSpeechProviders({key:id=>ports.credentials.resolve(id),...(ports.fetch?{fetch:ports.fetch}:{})})
 const miniMax=createMiniMaxSpeech({key:()=>ports.credentials.resolve('minimax'),...(ports.fetch?{fetch:ports.fetch}:{})})
 let probing=false,saving:Promise<unknown>=Promise.resolve()
 const status=async():Promise<VoiceServiceSettings>=>{
  const config=await ports.config.read()
  const described=await Promise.all(speechProviderIds.map(async id=>({id,...await ports.credentials.describe(id)})))
  const rows=described.map(row=>Object.freeze({id:row.id,name:speechProviderNames[row.id],configured:row.configured,...config.providers[row.id]}))
  const current=rows.find(row=>row.id===config.providerId)!,writable=described.find(row=>row.id===config.providerId)!.writable
  const asrProviderId=config.asrProviderId??'minimax',asrConfigured=asrProviderId==='sensevoice-local'?ports.localRecognition?.configured()===true:rows[0]!.configured
  return Object.freeze({providerId:config.providerId,configured:current.configured,writable,secure:ports.secure(),model:current.model,voiceId:current.voiceId,providers:Object.freeze(rows),asr:Object.freeze({providerId:asrProviderId,configured:asrConfigured})})
 }
 const save=async(value:unknown,signal:AbortSignal)=>{
  signal.throwIfAborted()
  const current=await ports.config.read(),input=readVoiceServiceSave(value,current.providers.minimax)
  if(!('providerId' in input)){
   signal.throwIfAborted()
   await ports.config.update(latest=>({...latest,asrProviderId:input.asrProviderId}))
   return await status()
  }
  if(!('model'in input)){
   if(!(await ports.credentials.describe(input.providerId)).configured)throw new WorkError('teloa/unavailable','请先配置语音凭据。')
   signal.throwIfAborted()
   // 选用只更新音色及当前播报厂商，保留最新模型、识别来源和凭据。
   await ports.config.update(latest=>({...latest,providerId:input.providerId,providers:{...latest.providers,[input.providerId]:{...latest.providers[input.providerId],voiceId:input.voiceId}}}))
   return await status()
  }
  if(input.apiKey!==undefined&&!ports.secure())throw new WorkError('teloa/unavailable','当前凭据存储尚未就绪，暂不能保存语音密钥。')
  if(input.setDefault&&input.apiKey===undefined&&!(await ports.credentials.describe(input.providerId)).configured)throw new WorkError('teloa/unavailable','请先填写 '+speechProviderNames[input.providerId]+' API Key，尚未配置该厂商的语音凭据。')
  // 最后一次取消检查之后才产生副作用；凭据与配置在同一串行段内写入。
  signal.throwIfAborted()
  if(input.apiKey!==undefined)await ports.credentials.set(input.providerId,input.apiKey)
  await ports.config.update(latest=>({providerId:input.setDefault?input.providerId:latest.providerId,asrProviderId:input.asrProviderId??latest.asrProviderId??'minimax',providers:{...latest.providers,[input.providerId]:{model:input.model,voiceId:input.voiceId}}}))
  return await status()
 }
 const probe=async(value:unknown,signal:AbortSignal):Promise<VoiceServiceProbe>=>{
  const input=readVoiceServiceTestInput(value),{providerId}=input
  if(probing)throw new WorkError('teloa/conflict','语音服务正在测试，请稍候。')
  probing=true
  try{
   if(!(await ports.credentials.describe(providerId)).configured)throw new WorkError('teloa/unavailable','尚未配置 '+speechProviderNames[providerId]+' 语音凭据。')
   const config=await ports.config.read(),parts:Uint8Array[]=[]
   // 临时试听不保存、不打开通话或识别器，也不占用通话的 PCM 会话。
   const voice=input.model&&input.voiceId?{model:input.model,voiceId:input.voiceId}:config.providers[providerId]
   await providers[providerId].speak(input.sampleLanguage==='en'?'Hello, I’m Teloa. How can I help you today?':'你好，我是 Teloa。今天有什么可以帮你？',voice,signal,bytes=>{parts.push(Uint8Array.from(bytes))})
   signal.throwIfAborted()
   return Object.freeze({providerId,tts:true,mime:'audio/mpeg',audio:Buffer.concat(parts).toString('base64')})
  }finally{probing=false}
 }
 const handler=async(endpoint:string,value:unknown,signal:AbortSignal=new AbortController().signal):Promise<Record<string,unknown>>=>{
  signal.throwIfAborted()
  try{
   if(endpoint==='voice-service/settings'){empty(value);return await status()}
   if(endpoint==='voice-service/save'){const next=saving.then(()=>save(value,signal));saving=next.catch(()=>{});return await next}
   if(endpoint==='voice-service/test')return await probe(value,signal)
   throw new WorkError('teloa/not-found','未提供此语音设置接口。')
  }catch(error){signal.throwIfAborted();if(error instanceof WorkError)throw error;throw new WorkError('teloa/unavailable','语音服务配置暂不可用，请重试。')}
 }
 const speech:VoiceSpeech=Object.freeze({
  async prepareRecognition(audio,format,signal){
   signal.throwIfAborted()
   const config=await ports.config.read();signal.throwIfAborted()
   if(config.asrProviderId!=='sensevoice-local'||!ports.localRecognition?.configured())return null
   return ports.localRecognition.transcribe(audio,format,signal)
  },
  async signature(){const config=await ports.config.read();return JSON.stringify([config.providerId,config.providers[config.providerId]])},
  async warm(signal){
   signal.throwIfAborted()
   const config=await ports.config.read();signal.throwIfAborted()
   if(config.asrProviderId==='sensevoice-local')await ports.localRecognition?.warm?.(signal)
  },
  async speak(text,signal,onAudio){
   // 每句播报都读取当前设置：更换厂商、模型或音色后下一句生效，不重启通话或员工任务。
   try{
    const config=await ports.config.read();signal.throwIfAborted()
    await providers[config.providerId].speak(text,config.providers[config.providerId],signal,onAudio)
   }catch(error){signal.throwIfAborted();if(error instanceof WorkError)throw error;throw new WorkError('teloa/unavailable','语音播报暂不可用，请重试。')}
  },
  async transcribe(audio,format,signal){
   signal.throwIfAborted()
   const config=await ports.config.read();signal.throwIfAborted()
   if(config.asrProviderId==='sensevoice-local'){
    if(!ports.localRecognition?.configured())throw new WorkError('teloa/unavailable','本机语音识别尚未就绪，请在语音输入设置准备本机模型。')
    return await ports.localRecognition.transcribe(audio,format,signal)
   }
   return await (ports.transcribe??miniMax.transcribe)(audio,format,signal)
  },
 })
 return Object.freeze({
  handler,speech,
  async openPcmSession(signal:AbortSignal):Promise<VoicePcmSession|null>{
   signal.throwIfAborted()
   if((await ports.config.read()).providerId!=='minimax')return null
   const controller=new AbortController(),mediaSignal=AbortSignal.any([signal,controller.signal])
   let current:MiniMaxTtsSession|undefined,signature='',credentialValue:string|undefined,closing:Promise<void>|undefined
   let preparing:Promise<unknown>=Promise.resolve()
   const close=()=>{
    if(closing)return closing
    controller.abort();signal.removeEventListener('abort',onAbort)
    const held=current;current=undefined;credentialValue=undefined
    closing=held?.close()??Promise.resolve()
    return closing
   }
   const onAbort=()=>{void close().catch(()=>{})}
   signal.addEventListener('abort',onAbort,{once:true})
   const resolveCurrent=async()=>{
    mediaSignal.throwIfAborted()
    const config=await ports.config.read();mediaSignal.throwIfAborted()
    const next=JSON.stringify([config.providerId,config.providers[config.providerId]])
    // 每句重读宿主凭据，外部轮换同样生效；值仅留在宿主闭包中比较。
    const secret=config.providerId==='minimax'?await ports.credentials.resolve('minimax'):undefined
    mediaSignal.throwIfAborted()
    if(next!==signature||secret!==credentialValue){
     const old=current;current=undefined;signature='';await old?.close();mediaSignal.throwIfAborted()
     if(config.providerId==='minimax'){
      const session=await (ports.openMiniMaxPcmSession??createMiniMaxTtsSession)({key:async()=>secret,voice:config.providers.minimax,signal:mediaSignal})
      if(mediaSignal.aborted){await session.close();mediaSignal.throwIfAborted()}
      current=session
     }
     signature=next;credentialValue=secret
    }
    return {config,session:current}
   }
   const prepare=()=>{
    // 插话可与前句准备重叠；只串行建连，返回本次固定快照，避免覆盖和漏关。
    const pending=preparing.catch(()=>{}).then(resolveCurrent)
    preparing=pending
    return pending
   }
   try{await prepare()}catch{await close().catch(()=>{});signal.throwIfAborted();throw new WorkError('teloa/unavailable','MiniMax 语音连接暂不可用，请稍后重试。')}
   return Object.freeze({
    async synthesize(text:string,turnSignal:AbortSignal,onAudio:(bytes:Uint8Array)=>void|Promise<void>){
     const linked=AbortSignal.any([mediaSignal,turnSignal]);linked.throwIfAborted()
     try{
      const prepared=await prepare();linked.throwIfAborted()
      if(prepared.session)await prepared.session.synthesize(text,linked,onAudio)
      else await providers[prepared.config.providerId].speakPcm(text,prepared.config.providers[prepared.config.providerId],linked,onAudio)
     }catch{linked.throwIfAborted();throw new WorkError('teloa/unavailable','语音播报暂不可用，请重试。')}
    },
    async cancel(){mediaSignal.throwIfAborted();await current?.cancel()},
    close,
   })
  },
  async speakPcm(text:string,signal:AbortSignal,onAudio:(bytes:Uint8Array)=>void|Promise<void>){
   try{const config=await ports.config.read();signal.throwIfAborted();await providers[config.providerId].speakPcm(text,config.providers[config.providerId],signal,onAudio)}
   catch(error){signal.throwIfAborted();if(error instanceof WorkError)throw error;throw new WorkError('teloa/unavailable','语音播报暂不可用，请重试。')}
  },
  providerId:async()=>{try{return (await ports.config.read()).providerId}catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/unavailable','语音服务配置暂不可用，请重试。')}},
  /** 就绪需要已选识别器可用，且当前播报厂商已配置；本机不可用不转发云端。 */
  configured:async()=>{
   // 读取失败按未就绪处理，不把凭据存储的原始错误带到媒体就绪回包。
   try{const config=await ports.config.read();const [asr,tts]=await Promise.all([config.asrProviderId==='sensevoice-local'?Promise.resolve({configured:ports.localRecognition?.configured()===true}):ports.credentials.describe('minimax'),ports.credentials.describe(config.providerId)]);return asr.configured&&tts.configured}catch{return false}
  },
 })
}
