import {artifactInput} from './artifacts.ts'
import {WorkError} from './index.ts'
export type SavedArtifactImage={blockIndex:number;attachment:{attachmentId:string;mediaType:'image/png'|'image/jpeg'|'image/webp'|'image/gif';bytes:number;width:number;height:number;name?:string}}
export type SavedArtifactMessage={sessionId:string;messageId:string;seq:number;role:'user'|'assistant';at:string;text:string;interrupted:boolean;omittedBlocks:number;images:SavedArtifactImage[]}
const fail=():never=>{throw new WorkError('teloa/invalid-input','原消息或图片引用格式不正确。')}
const integer=(value:unknown,min=0):number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min?value:fail()
const string=(value:unknown,max:number):string=>typeof value==='string'&&!!value.trim()&&value.length<=max?value:fail()
/** 固定正文与持久附件身份，不接受浏览器 URL，不规范化原正文。 */
export function savedArtifactMessage(value:unknown):SavedArtifactMessage{
 const row=artifactInput(value,['sessionId','messageId','seq','role','at','text','interrupted','omittedBlocks','images'])
 if(typeof row.text!=='string'||row.text.length>16000||typeof row.interrupted!=='boolean'||!['user','assistant'].includes(row.role as string)||!Array.isArray(row.images)||row.images.length>20)fail()
 const images=(row.images as unknown[]).map(value=>{
  const image=artifactInput(value,['blockIndex','attachment']),ref=artifactInput(image.attachment,['attachmentId','mediaType','bytes','width','height','name'])
  const attachmentId=string(ref.attachmentId,512)
  if(/^(blob:|data:|https?:|file:)/i.test(attachmentId)||!['image/png','image/jpeg','image/webp','image/gif'].includes(ref.mediaType as string))fail()
  return {blockIndex:integer(image.blockIndex),attachment:{attachmentId,mediaType:ref.mediaType as SavedArtifactImage['attachment']['mediaType'],bytes:integer(ref.bytes,1),width:integer(ref.width,1),height:integer(ref.height,1),...(ref.name!==undefined?{name:string(ref.name,1024)}:{})}}
 })
 const at=string(row.at,100),sessionId=string(row.sessionId,128),messageId=string(row.messageId,512)
 if(!Number.isFinite(Date.parse(at))||!(/^[\w-]+$/).test(sessionId)||new Set(images.map(image=>image.blockIndex)).size!==images.length||(!(row.text as string).trim()&&!images.length))fail()
 return {sessionId,messageId,seq:integer(row.seq),role:row.role as 'user'|'assistant',at,text:row.text as string,interrupted:row.interrupted as boolean,omittedBlocks:integer(row.omittedBlocks),images}
}
