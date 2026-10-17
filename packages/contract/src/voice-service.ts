import {WorkError} from './work-error.ts'

/** 语音播报（TTS）厂商；凭据只在宿主保存，从不回包。 */
export const speechProviderIds=['minimax','openai','elevenlabs'] as const
export type SpeechProviderId=typeof speechProviderIds[number]
export const speechRecognitionProviderIds=['minimax','sensevoice-local'] as const
export type SpeechRecognitionProviderId=typeof speechRecognitionProviderIds[number]
export const speechProviderNames:Readonly<Record<SpeechProviderId,string>>=Object.freeze({minimax:'MiniMax',openai:'OpenAI',elevenlabs:'ElevenLabs'})
/** 各厂商官方文档的默认模型与音色；本人可按厂商分别修改。 */
export const speechProviderDefaults:Readonly<Record<SpeechProviderId,Readonly<{model:string;voiceId:string}>>>=Object.freeze({
 minimax:Object.freeze({model:'speech-2.8-turbo',voiceId:'male-qn-qingse'}),
 openai:Object.freeze({model:'gpt-4o-mini-tts',voiceId:'alloy'}),
 elevenlabs:Object.freeze({model:'eleven_multilingual_v2',voiceId:'JBFqnCBsd6RMkjVDRZzb'}),
})
export type VoiceServiceProvider=Readonly<{id:SpeechProviderId;name:string;configured:boolean;model:string;voiceId:string}>
export type VoiceServiceSettings=Readonly<{providerId:SpeechProviderId;configured:boolean;writable:boolean;secure:boolean;model:string;voiceId:string;providers:readonly VoiceServiceProvider[];asr:Readonly<{providerId:SpeechRecognitionProviderId;configured:boolean}>}>
/** setDefault 缺省为 true；false 不改变当前播报厂商。asrProviderId 缺省时保留当前识别来源。 */
export type VoiceServiceProfileSave=Readonly<{providerId:SpeechProviderId;model:string;voiceId:string;apiKey?:string;setDefault?:boolean;asrProviderId?:SpeechRecognitionProviderId}>
/** 识别来源可独立更新，不携带或写入播报配置。 */
export type VoiceServiceSave=VoiceServiceProfileSave|Readonly<{asrProviderId:SpeechRecognitionProviderId}>|Readonly<{providerId:SpeechProviderId;voiceId:string}>
/** 试听可临时指定音色与语言，不写入配置；模型与音色必须成对出现。 */
export type VoiceServicePreview=Readonly<{model:string;voiceId:string;sampleLanguage?:'zh'|'en'}>
export type VoiceServiceTestInput=Readonly<{providerId:SpeechProviderId}>&Partial<VoiceServicePreview>
export type VoiceServiceProbe=Readonly<{providerId:SpeechProviderId;tts:true;mime:'audio/mpeg';audio:string}>

const invalid=(message='语音设置请求不正确。')=>new WorkError('teloa/invalid-input',message)
const hostError=()=>new WorkError('teloa/invalid-host-response','语音设置回包格式不正确。')
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const keysOf=(value:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[])=>required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key))
export const isSpeechProviderId=(value:unknown):value is SpeechProviderId=>typeof value==='string'&&(speechProviderIds as readonly string[]).includes(value)
export const isSpeechRecognitionProviderId=(value:unknown):value is SpeechRecognitionProviderId=>typeof value==='string'&&(speechRecognitionProviderIds as readonly string[]).includes(value)
/** 模型名与音色标识只允许厂商标识字符，不接受 URL、路径或换行。 */
export const isSpeechModel=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
export const isSpeechVoiceId=(value:unknown):value is string=>typeof value==='string'&&value===value.trim()&&/^[A-Za-z0-9][A-Za-z0-9._:() -]{0,127}$/.test(value)
const apiKey=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=4096&&!/[\r\n\x00]/.test(value)

/** 宿主与页面共用的保存请求校验；旧客户端只送 {apiKey} 时按 MiniMax 凭据处理、不改当前播报厂商与模型音色。 */
export function readVoiceServiceSave(value:unknown,legacyMiniMax?:Readonly<{model:string;voiceId:string}>):VoiceServiceSave{
 if(!record(value))throw invalid()
 if(keysOf(value,['asrProviderId'])){
  if(!isSpeechRecognitionProviderId(value.asrProviderId))throw invalid()
  return Object.freeze({asrProviderId:value.asrProviderId})
 }
 if(keysOf(value,['providerId','voiceId'])){
  if(!isSpeechProviderId(value.providerId)||!isSpeechVoiceId(value.voiceId))throw invalid()
  return Object.freeze({providerId:value.providerId,voiceId:value.voiceId})
 }
 if(legacyMiniMax&&keysOf(value,['apiKey'])){
  if(!apiKey(value.apiKey))throw invalid('请填写有效的 MiniMax API Key。')
  return Object.freeze({providerId:'minimax',model:legacyMiniMax.model,voiceId:legacyMiniMax.voiceId,apiKey:value.apiKey.trim(),setDefault:false})
 }
 if(!keysOf(value,['providerId','model','voiceId'],['apiKey','setDefault','asrProviderId'])||!isSpeechProviderId(value.providerId))throw invalid()
 if(!isSpeechModel(value.model))throw invalid('请填写有效的语音模型名称。')
 if(!isSpeechVoiceId(value.voiceId))throw invalid('请填写有效的音色标识。')
 if(value.apiKey!==undefined&&!apiKey(value.apiKey))throw invalid('请填写有效的 '+speechProviderNames[value.providerId]+' API Key。')
 if(value.setDefault!==undefined&&typeof value.setDefault!=='boolean')throw invalid()
 if(value.asrProviderId!==undefined&&!isSpeechRecognitionProviderId(value.asrProviderId))throw invalid()
 return Object.freeze({providerId:value.providerId,model:value.model,voiceId:value.voiceId,...(value.apiKey!==undefined?{apiKey:(value.apiKey as string).trim()}:{}),setDefault:value.setDefault!==false,...(value.asrProviderId!==undefined?{asrProviderId:value.asrProviderId as SpeechRecognitionProviderId}:{})})
}
export function readVoiceServiceTestInput(value:unknown):VoiceServiceTestInput{
 if(!record(value)||!keysOf(value,['providerId'],['model','voiceId','sampleLanguage'])||!isSpeechProviderId(value.providerId))throw invalid()
 if(('model'in value)!==('voiceId'in value)||'model'in value&&(!isSpeechModel(value.model)||!isSpeechVoiceId(value.voiceId)))throw invalid()
 if('sampleLanguage'in value&&value.sampleLanguage!=='zh'&&value.sampleLanguage!=='en')throw invalid()
 return Object.freeze({providerId:value.providerId,...('model'in value?{model:value.model as string,voiceId:value.voiceId as string}:{}),...('sampleLanguage'in value?{sampleLanguage:value.sampleLanguage as 'zh'|'en'}:{})})
}
function provider(value:unknown):VoiceServiceProvider{
 if(!record(value)||!keysOf(value,['id','name','configured','model','voiceId'])||!isSpeechProviderId(value.id)||value.name!==speechProviderNames[value.id]||typeof value.configured!=='boolean'||!isSpeechModel(value.model)||!isSpeechVoiceId(value.voiceId))throw hostError()
 return Object.freeze({id:value.id,name:value.name,configured:value.configured,model:value.model,voiceId:value.voiceId})
}
/** 严格读取设置回包：不得带出任何凭据字段，当前厂商须与列表一致。 */
export function readVoiceServiceSettings(value:unknown):VoiceServiceSettings{
 if(!record(value)||!keysOf(value,['providerId','configured','writable','secure','model','voiceId','providers','asr'])||!isSpeechProviderId(value.providerId)||typeof value.configured!=='boolean'||typeof value.writable!=='boolean'||typeof value.secure!=='boolean'||!isSpeechModel(value.model)||!isSpeechVoiceId(value.voiceId)||!Array.isArray(value.providers))throw hostError()
 const providers=value.providers.map(provider)
 if(providers.length!==speechProviderIds.length||providers.some((row,index)=>row.id!==speechProviderIds[index]))throw hostError()
 const current=providers.find(row=>row.id===value.providerId)!
 if(current.configured!==value.configured||current.model!==value.model||current.voiceId!==value.voiceId)throw hostError()
 if(!record(value.asr)||!keysOf(value.asr,['providerId','configured'])||!isSpeechRecognitionProviderId(value.asr.providerId)||typeof value.asr.configured!=='boolean'||value.asr.providerId==='minimax'&&value.asr.configured!==providers[0]!.configured)throw hostError()
 return Object.freeze({providerId:value.providerId,configured:value.configured,writable:value.writable,secure:value.secure,model:value.model,voiceId:value.voiceId,providers:Object.freeze(providers),asr:Object.freeze({providerId:value.asr.providerId,configured:value.asr.configured})})
}
export function readVoiceServiceProbe(value:unknown):VoiceServiceProbe{
 if(!record(value)||!keysOf(value,['providerId','tts','mime','audio'])||!isSpeechProviderId(value.providerId)||value.tts!==true||value.mime!=='audio/mpeg'||typeof value.audio!=='string'||!value.audio||value.audio.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(value.audio))throw hostError()
 return Object.freeze({providerId:value.providerId,tts:true,mime:'audio/mpeg',audio:value.audio})
}
