import { artifactFileTotalBytes,isArtifactFile,isArtifactFileDirectory,type ArtifactFile,type ArtifactFileDirectory } from '@teloa/contract'
import type { ArtifactSourceRef } from './artifact-preview.ts'
import type {TeloaTranslate} from './i18n/index.ts'
export type { ArtifactFile } from '@teloa/contract'
export type ArtifactFileApi={write?:(file:ArtifactFile,text:string,signal:AbortSignal)=>Promise<ArtifactFile>;list:(sessionId:string,query:string,signal:AbortSignal)=>Promise<ArtifactFileDirectory>;read:(sessionId:string,path:string,signal:AbortSignal)=>Promise<ArtifactFile>}
export type ArtifactFileForm={query:string;candidate:ArtifactFile|null;edit?:{file:ArtifactFile;text:string}|undefined}
export type ArtifactFileDraft={files:ArtifactFile[];form:ArtifactFileForm;note:string;stamp:string}
export const fileSetKey=(files:ArtifactFile[])=>JSON.stringify(files.map(file=>[file.sessionId,file.id,file.path,file.sha256]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))
export function copyArtifactFiles(files:ArtifactFile[],source:ArtifactSourceRef):ArtifactFile[]{
  if(files.length>10||files.reduce((sum,file)=>sum+file.bytes,0)>artifactFileTotalBytes)throw Error('每份工作成果最多 10 个文件，总计不能超过 32 MiB。')
  if(files.some(file=>!isArtifactFile(file)))throw Error('文件快照格式不正确。')
  if(files.length&&source.kind!=='task'&&(source.kind!=='session'||files.some(file=>file.sessionId!==source.id)))throw Error('文件与产物来源会话不一致。')
  if(new Set(files.map(file=>JSON.stringify([file.sessionId,file.id]))).size!==files.length||new Set(files.map(file=>JSON.stringify([file.sessionId,file.path]))).size!==files.length)throw Error('同一文件不能重复引用。')
  return structuredClone(files)
}
export const artifactFilesMarkdown=(files:ArtifactFile[],t:TeloaTranslate)=>!files.length?[]:['',`## ${t('artifact.export.files.heading')}`,'',t('artifactFiles.description'),...files.flatMap(file=>['',t('artifactFiles.fileId',{id:file.path}),`${t('artifactFiles.sessionId',{id:file.sessionId})} · ${t('artifactFiles.fileId',{id:file.id})}`,`SHA-256: ${file.sha256}`,t('artifactFiles.snapshotMeta',{bytes:file.bytes,at:file.capturedAt})])]
export function fileBytes(file:ArtifactFile):Uint8Array<ArrayBuffer>{
  const raw=atob(file.contentBase64),bytes=new Uint8Array(raw.length)
  for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i)
  return bytes
}
export function fileText(bytes:Uint8Array):string|null{
  try{const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);return /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)?null:text}catch{return null}
}
// 只为已知栅格格式生成图片预览；文件名不能把 HTML/SVG 变成活动文档。
export function fileImageType(bytes:Uint8Array):string|null{
  const starts=(values:number[])=>values.every((value,index)=>bytes[index]===value)
  if(starts([137,80,78,71,13,10,26,10]))return 'image/png'
  if(starts([255,216,255]))return 'image/jpeg'
  const prefix=new TextDecoder('ascii').decode(bytes.subarray(0,12))
  if(prefix.startsWith('GIF87a')||prefix.startsWith('GIF89a'))return 'image/gif'
  if(prefix.startsWith('RIFF')&&prefix.slice(8,12)==='WEBP')return 'image/webp'
  return null
}
export function createArtifactFileApi(call:(endpoint:string,payload:unknown,signal:AbortSignal)=>Promise<unknown>,assertSession:(id:string)=>void):ArtifactFileApi{
  return {
    async write(file,text,signal){
      assertSession(file.sessionId)
      const result=await call('artifacts/files/write',{sessionId:file.sessionId,path:file.path,expectedId:file.id,expectedSha256:file.sha256,text},signal)
      signal.throwIfAborted();assertSession(file.sessionId)
      if(!isArtifactFile(result)||result.id!==file.id||result.sessionId!==file.sessionId||result.path!==file.path)throw Error('文件写入响应身份不一致，请保留草稿并核对原文件。')
      const bytes=fileBytes(result),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('')
      if(bytes.length!==result.bytes||digest!==result.sha256||new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)!==text)throw Error('文件写入内容待核对，请保留草稿。')
      return result
    },
    async list(sessionId,query,signal){
      assertSession(sessionId)
      const result=await call('artifacts/files/list',{sessionId,query},signal)
      signal.throwIfAborted();assertSession(sessionId)
      if(!isArtifactFileDirectory(result)||result.sessionId!==sessionId||result.query!==query)throw Error('文件目录与目标会话或查询不一致。')
      return result
    },
    async read(sessionId,path,signal){
      assertSession(sessionId)
      const result=await call('artifacts/files/read',{sessionId,path},signal)
      signal.throwIfAborted();assertSession(sessionId)
      if(!isArtifactFile(result)||result.sessionId!==sessionId||result.path!==path)throw Error('文件快照与当前会话或路径不一致。')
      const bytes=fileBytes(result),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('')
      signal.throwIfAborted();assertSession(sessionId)
      if(bytes.length!==result.bytes||digest!==result.sha256)throw Error('文件内容校验失败，请重新读取；未保存损坏快照。')
      return result
    },
  }
}
