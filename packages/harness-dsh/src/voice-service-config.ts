import {readFile} from 'node:fs/promises'
import {writeFileAtomic} from '@deepseek-ai/dsh-atomic-write'
import {WorkError,isSpeechModel,isSpeechProviderId,isSpeechVoiceId,isSpeechRecognitionProviderId,speechProviderDefaults,speechProviderIds,type SpeechProviderId,type SpeechRecognitionProviderId} from '@teloa/contract'

/** 非秘密语音配置：当前播报厂商与各厂商模型、音色。凭据只在宿主凭据存储，不进此文件。 */
export type VoiceServiceConfig=Readonly<{providerId:SpeechProviderId;asrProviderId?:SpeechRecognitionProviderId;providers:Readonly<Record<SpeechProviderId,Readonly<{model:string;voiceId:string}>>>}>
const schema='teloa.voice-service/v1'
const defaults=():VoiceServiceConfig=>({providerId:'minimax',asrProviderId:'sensevoice-local',providers:{...speechProviderDefaults}})
const broken=()=>new WorkError('teloa/unavailable','语音设置文件已损坏，请重新保存语音设置。')

function parse(text:string):VoiceServiceConfig{
 let value:unknown;try{value=JSON.parse(text)}catch{throw broken()}
 if(!value||typeof value!=='object'||Array.isArray(value))throw broken()
 const row=value as Record<string,unknown>,providers=row.providers as Record<string,unknown>|undefined
 if(row.schema!==schema||!isSpeechProviderId(row.providerId)||row.asrProviderId!==undefined&&!isSpeechRecognitionProviderId(row.asrProviderId)||!providers||typeof providers!=='object'||Array.isArray(providers))throw broken()
 const result={} as Record<SpeechProviderId,{model:string;voiceId:string}>
 for(const id of speechProviderIds){
  const entry=providers[id] as Record<string,unknown>|undefined
  // 旧版本或尚未保存的厂商沿用官方默认值
  if(entry===undefined){result[id]={...speechProviderDefaults[id]};continue}
  if(!entry||typeof entry!=='object'||!isSpeechModel(entry.model)||!isSpeechVoiceId(entry.voiceId))throw broken()
  result[id]={model:entry.model,voiceId:entry.voiceId}
 }
 return {providerId:row.providerId,asrProviderId:row.asrProviderId??'minimax',providers:result}
}

/** 读取每次都取磁盘最新值；写入经同进程串行与原子替换，读者只会看到完整的新旧内容之一。 */
export function createVoiceServiceConfig(path:string){
 let queue:Promise<unknown>=Promise.resolve()
 const read=async():Promise<VoiceServiceConfig>=>{
  let text:string
  try{text=await readFile(path,'utf8')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return defaults();throw broken()}
  return parse(text)
 }
 const update=(change:(current:VoiceServiceConfig)=>VoiceServiceConfig|Promise<VoiceServiceConfig>):Promise<VoiceServiceConfig>=>{
  const next=queue.then(async()=>{
   const value=await change(await read())
   await writeFileAtomic(path,JSON.stringify({schema,providerId:value.providerId,asrProviderId:value.asrProviderId??'minimax',providers:value.providers},null,1)+'\n',{mode:0o600,dirMode:0o700})
   return value
  })
  queue=next.catch(()=>{})
  return next
 }
 return Object.freeze({read,update})
}
