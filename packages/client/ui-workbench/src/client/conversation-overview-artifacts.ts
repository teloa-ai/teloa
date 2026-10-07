import {isArtifactFile} from '@teloa/contract'
import {artifactMarkdown,type Artifact,type ArtifactSourceRef} from './artifact-preview.ts'
import {fileBytes,fileText,fileImageType,type ArtifactFile} from './artifact-files.ts'
import type {ArtifactApi} from './artifact-api.ts'
import type {ConversationOverviewArtifact} from './conversation-overview-model.js'
import type {TeloaTranslate} from './i18n/index.js'

type ReferenceBase=Readonly<{row:ConversationOverviewArtifact;artifactId?:string;version?:number;sessionId:string;source:ArtifactSourceRef;bytes:Uint8Array<ArrayBuffer>;downloadName:string;mimeType:string}>
export type ConversationOverviewRegisteredArtifactRef=
 |(ReferenceBase&Readonly<{kind:'markdown';markdown:string;text:string;previewKind:'markdown';imageType:null}>)
 |(ReferenceBase&Readonly<{kind:'file';file:ArtifactFile;text:string|null;previewKind:'markdown'|'text'|'image'|'download-only';imageType:string|null}>)
export type ConversationOverviewRegisteredArtifacts=Readonly<{rows:readonly ConversationOverviewArtifact[];references:ReadonlyMap<string,ConversationOverviewRegisteredArtifactRef>}>
export type ConversationOverviewArtifactReference=ConversationOverviewRegisteredArtifactRef
const invalid=(message:string,code='teloa/invalid-input')=>Object.assign(Error(message),{code})
const downloadName=(name:string)=>name.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_')||'artifact'
function snapshotFile(file:ArtifactFile):Pick<Extract<ConversationOverviewRegisteredArtifactRef,{kind:'file'}>,'file'|'bytes'|'imageType'|'text'|'previewKind'|'downloadName'|'mimeType'>{
 if(!isArtifactFile(file))throw invalid('成果文件快照格式不正确。')
 const snapshot=Object.freeze(structuredClone(file)),bytes=fileBytes(snapshot),imageType=fileImageType(bytes),text=imageType?null:fileText(bytes),name=snapshot.path.split('/').at(-1)!
 const markdownFile=/\.(?:md|markdown|mdown)$/i.test(name),unsupported=/\.(?:html?|svg|pdf|docx?|xlsx?|pptx?|zip|gz|tar|7z|rar)$/i.test(name)
 const previewKind=imageType?'image':text===null||unsupported?'download-only':markdownFile?'markdown':'text'
 return {file:snapshot,bytes,imageType,text,previewKind,downloadName:downloadName(name),mimeType:imageType??(markdownFile&&text!==null?'text/markdown;charset=utf-8':previewKind==='text'?'text/plain;charset=utf-8':'application/octet-stream')}
}

/** 仅转换已注册成果。每份引用保存自己的版本内容，不再读取实时文件。 */
export function projectConversationOverviewArtifacts(sessionId:string,artifacts:readonly Artifact[],t:TeloaTranslate):ConversationOverviewRegisteredArtifacts{
 const rows:ConversationOverviewArtifact[]=[],references=new Map<string,ConversationOverviewRegisteredArtifactRef>(),seen=new Set<string>()
 for(const input of artifacts){
  if(input.storage!=='persistent')continue
  if(input.source.kind!=='session'||input.source.id!==sessionId)throw invalid('成果不属于来源会话。','teloa/forbidden')
  if(seen.has(input.id)||!input.versions.length)throw invalid('成果身份或版本目录不正确。')
  seen.add(input.id)
  const artifact=structuredClone(input),numbers=artifact.versions.map(version=>version.number)
  if(numbers.some(number=>!Number.isSafeInteger(number)||number<1)||new Set(numbers).size!==numbers.length)throw invalid('成果版本身份不正确。')
  const latest=Math.max(...numbers)
  for(const version of [...artifact.versions].sort((left,right)=>right.number-left.number)){
   if(version.source.ref.kind!=='session'||version.source.ref.id!==sessionId)throw invalid('成果版本不属于来源会话。','teloa/forbidden')
   const isHistorical=version.number!==latest,source=Object.freeze({...version.source.ref}),markdown=artifactMarkdown(artifact,version.number,t)
   const exportName=downloadName('teloa-'+artifact.id+'-v'+version.number+'.md')
   const row:ConversationOverviewArtifact=Object.freeze({id:JSON.stringify(['registered',sessionId,artifact.id,version.number,'markdown']),sessionId,path:exportName,label:version.title+'.md',kind:'Markdown',status:'unknown',version:'v'+version.number,isHistorical})
   rows.push(row);references.set(row.id,Object.freeze({kind:'markdown',row,artifactId:artifact.id,version:version.number,sessionId,source,markdown,text:markdown,previewKind:'markdown',imageType:null,bytes:new TextEncoder().encode(markdown),downloadName:exportName,mimeType:'text/markdown;charset=utf-8'}))
   const fileIds=new Set<string>()
   for(const file of version.files??[]){
    if(!isArtifactFile(file))throw invalid('成果文件快照格式不正确。')
    if(file.sessionId!==sessionId)throw invalid('成果文件不属于来源会话。','teloa/forbidden')
    const id=JSON.stringify(['registered',sessionId,artifact.id,version.number,'file',file.id,file.sha256])
    if(fileIds.has(id))throw invalid('同一成果版本重复引用文件。')
    fileIds.add(id)
    const snapshot=snapshotFile(file),name=file.path.split('/').at(-1)!,extension=name.split('.').at(-1)?.toLowerCase(),markdownFile=/\.(?:md|markdown|mdown)$/i.test(name)
    const fileRow:ConversationOverviewArtifact=Object.freeze({id,sessionId:file.sessionId,path:file.path,label:name,kind:markdownFile?'Markdown':extension&&name.includes('.')?extension.toUpperCase():t('artifactFiles.file'),status:'unknown',version:'v'+version.number,isHistorical})
    rows.push(fileRow);references.set(id,Object.freeze({kind:'file',row:fileRow,artifactId:artifact.id,version:version.number,sessionId:file.sessionId,source,...snapshot}))
   }
  }
 }
 return {rows:Object.freeze(rows),references}
}

/** 显式交付文件的授权读取快照；不以当前文件内容冒充注册成果或历史版本。 */
export function conversationOverviewFileReference(row:ConversationOverviewArtifact,file:ArtifactFile):ConversationOverviewArtifactReference{
 if(row.sessionId!==file.sessionId||row.path!==file.path)throw invalid('文件快照与交付来源不一致。','teloa/forbidden')
 if(row.isHistorical)throw invalid('当前文件读取不能替代历史版本快照。','teloa/forbidden')
 const snapshotRow={...row};delete snapshotRow.version;delete snapshotRow.isHistorical
 return Object.freeze({kind:'file',row:Object.freeze(snapshotRow),sessionId:file.sessionId,source:Object.freeze({kind:'session' as const,id:file.sessionId}),...snapshotFile(file)})
}

export async function loadConversationOverviewArtifacts(api:Pick<ArtifactApi,'list'>,sessionId:string,t:TeloaTranslate):Promise<ConversationOverviewRegisteredArtifacts>{
 return projectConversationOverviewArtifacts(sessionId,await api.list(sessionId),t)
}
/** 预览与下载都取同一份引用；下载返回副本，避免调用方修改存档中的内容。 */
export function conversationOverviewArtifactDownload(reference:ConversationOverviewRegisteredArtifactRef){
 return {name:reference.downloadName,type:reference.mimeType,bytes:reference.bytes.slice()}
}
