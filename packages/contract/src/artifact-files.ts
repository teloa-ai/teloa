import { isRecord } from './resources.ts'
export const artifactFileMaxBytes=8*1024*1024
export const artifactFileTotalBytes=32*1024*1024
export type ArtifactFile={schema:'teloa.file-snapshot/v1';sessionId:string;id:string;path:string;sha256:string;bytes:number;capturedAt:string;contentBase64:string}
export type ArtifactFileDirectory={sessionId:string;query:string;items:{path:string;kind:'file'|'directory'}[]}
export function artifactFilePath(value:unknown,allowEmpty=false):value is string{
  return typeof value==='string'&&(allowEmpty||!!value)&&value.length<=1024&&!/[\\\x00-\x1f\x7f]/.test(value)&&!value.startsWith('/')&&!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)&&!value.split('/').some(part=>part==='..'||part.toLowerCase()==='.runtime'||part.toLowerCase()==='.git')
}
export function isArtifactFile(value:unknown):value is ArtifactFile{
  if(!isRecord(value)||value.schema!=='teloa.file-snapshot/v1'||typeof value.sessionId!=='string'||!/^[\w-]{1,128}$/.test(value.sessionId)||!artifactFilePath(value.path)||value.path.endsWith('/')||typeof value.id!=='string'||!/^[a-f0-9]{64}$/.test(value.id)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||typeof value.bytes!=='number'||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>artifactFileMaxBytes||typeof value.capturedAt!=='string'||!Number.isFinite(Date.parse(value.capturedAt))||typeof value.contentBase64!=='string')return false
  const content=value.contentBase64
  return content.length===4*Math.ceil(value.bytes/3)&&content.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(content)&&content.length/4*3-(content.endsWith('==')?2:content.endsWith('=')?1:0)===value.bytes
}
export function isArtifactFileDirectory(value:unknown):value is ArtifactFileDirectory{
  return isRecord(value)&&typeof value.sessionId==='string'&&artifactFilePath(value.query,true)&&Array.isArray(value.items)&&value.items.length<=100&&value.items.every(item=>isRecord(item)&&artifactFilePath(item.path)&&(item.kind==='file'||item.kind==='directory'))
}
