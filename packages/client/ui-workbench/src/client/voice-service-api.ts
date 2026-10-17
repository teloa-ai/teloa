import {readVoiceServiceSettings,readVoiceServiceProbe,type SpeechProviderId,type VoiceServiceSave,type VoiceServiceProbe,type VoiceServicePreview} from '@teloa/contract'
export type {SpeechProviderId,SpeechRecognitionProviderId,VoiceServiceSettings,VoiceServiceSave,VoiceServiceProbe} from '@teloa/contract'

type Call=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>
const invalid=()=>new Error('语音服务回包不正确，请重试。')
export function createVoiceServiceApi(call:Call){
 return {
  status:async()=>readVoiceServiceSettings(await call('voice-service/settings',{})),
  save:async(input:VoiceServiceSave)=>readVoiceServiceSettings(await call('voice-service/save',input)),
  async test(providerId:SpeechProviderId,signal:AbortSignal,voice?:VoiceServicePreview):Promise<VoiceServiceProbe>{
   const value=readVoiceServiceProbe(await call('voice-service/test',{providerId,...voice},signal))
   if(value.providerId!==providerId||value.audio.length>28*1024*1024)throw invalid()
   return value
  },
 }
}
export type VoiceServiceApi=ReturnType<typeof createVoiceServiceApi>
