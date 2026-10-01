import {savedArtifactMessage,type SavedArtifactMessage,type SavedArtifactImage} from '@teloa/contract'
import type { ArtifactSourceRef } from './artifact-preview.ts'
import type {TeloaTranslate} from './i18n/index.ts'
export type ArtifactImage=SavedArtifactImage
export type ArtifactMessage=SavedArtifactMessage
export type NativeArtifactPage={sessionId:string;items:ArtifactMessage[];nextBeforeSeq:number|null}
export type NativeArtifactApi={read:(sessionId:string,beforeSeq?:number)=>Promise<NativeArtifactPage>;imageUrl:(message:ArtifactMessage,image:ArtifactImage)=>Promise<string>}
export const artifactMessageKey=(message:ArtifactMessage)=>JSON.stringify([message.sessionId,message.messageId,message.seq])

/** 原生附件只在浏览器成功解码后允许改变预览尺寸。 */
export function nativeImagePreviewControl(decoded:boolean,expanded:boolean):{label:string;expanded:boolean}|null{
  if(!decoded)return null
  return expanded?{label:'收起图片预览',expanded:false}:{label:'放大图片预览',expanded:true}
}

// 产物只保存持久身份与选定正文，浏览器 URL 由 DSH 按会话生命周期管理。
export function copyArtifactMessages(messages:ArtifactMessage[],source:ArtifactSourceRef):ArtifactMessage[]{
  if(!messages.length)return []
  if(messages.length>20)throw Error('一份工作成果最多选取 20 条原消息。')
  if(source.kind!=='task'&&(source.kind!=='session'||messages.some(item=>item.sessionId!==source.id)))throw Error('原消息与工作成果的来源会话不一致。')
  if(new Set(messages.map(artifactMessageKey)).size!==messages.length)throw Error('不能重复选取同一条原消息。')
  const checked=messages.map(savedArtifactMessage)
  if(messages.reduce((sum,item)=>sum+item.text.length,0)>64000)throw Error('选取的原消息正文总量不能超过 64000 字。')
  return checked
}
export function artifactMessagesMarkdown(messages:ArtifactMessage[],t:TeloaTranslate):string[]{
  if(!messages.length)return []
  return ['',`## ${t('artifact.export.messages.heading')}`,'',t('nativeArtifact.referencesDescription'),...messages.flatMap(message=>[
    '',`### ${t(message.role==='user'?'nativeArtifact.userMessage':'nativeArtifact.modelReply')} · ${message.messageId}`,
    t('artifact.export.messages.source',{session:message.sessionId,seq:message.seq,at:message.at}),
    t('artifact.export.messages.identity'),
    ...(message.interrupted?[t('nativeArtifact.interrupted')]:[]),
    ...(message.omittedBlocks?[t('nativeArtifact.omitted',{count:message.omittedBlocks})]:[]),
    '',...message.text.split('\n').map(line=>'> '+line),
    ...message.images.map(image=>t('artifact.export.messages.image',{name:image.attachment.name||t('nativeArtifact.unnamedImage'),type:image.attachment.mediaType,width:image.attachment.width,height:image.attachment.height,bytes:image.attachment.bytes,id:image.attachment.attachmentId,index:image.blockIndex})),
  ])]
}
