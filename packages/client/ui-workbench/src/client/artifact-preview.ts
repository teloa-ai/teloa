import { copyArtifactMessages,artifactMessagesMarkdown,type ArtifactMessage } from './artifact-native.ts'
import { copyArtifactFiles,artifactFilesMarkdown,fileSetKey,type ArtifactFile } from './artifact-files.ts'
import type {TeloaTranslate} from './i18n/index.ts'
export type ArtifactSourceRef=
  |{kind:'task';id:string}|{kind:'run';id:string}|{kind:'session';id:string}
  |{kind:'analysis';id:string;scope:string}
  |{kind:'object';id:string;scope:string;objectType:string}
export type ArtifactSource={ref:ArtifactSourceRef;title:string;scope:string;version:string;author:string;evidence:string[];private:boolean}
export type ArtifactRef={id:string;version:number}
export type ArtifactSection={id:string;title:string;text:string}
export type ArtifactVersion={number:number;title:string;sections:ArtifactSection[];source:ArtifactSource;note:string;author:string;at:string;feedbackId?:string;messages?:ArtifactMessage[];files?:ArtifactFile[]}
export type ArtifactFeedback={id:string;version:number;sectionId:string;text:string;author:string;at:string}
export type Artifact={storage?:'persistent';links:{object:Extract<ArtifactSourceRef,{kind:'object'}>;objectVersion:string;artifactVersion:number;at:string}[];id:string;source:ArtifactSourceRef;primary:boolean;versions:ArtifactVersion[];feedback:ArtifactFeedback[]}
export type ArtifactChange=(
  |{type:'feedback';id:string;version:number;sectionId:string;text:string}
  |{type:'revise';expectedVersion:number;sectionId:string;text:string;note:string;feedbackId?:string}
  |{type:'files';expectedVersion:number;files:ArtifactFile[];note:string}
)&{now:string}
const text=(value:string,label:string,max=16000)=>{const result=value.trim();if(!result||result.length>max)throw Error(label+'不能为空且不能超过 '+max+' 字。');return result}
const time=(now:string)=>{if(!Number.isFinite(Date.parse(now)))throw Error('时间无效。')}
export function sourceKey(ref:ArtifactSourceRef):string{return JSON.stringify([ref.kind,'scope' in ref?ref.scope:'','objectType' in ref?ref.objectType:'',ref.id])}
export function sourceStamp(source:ArtifactSource):string{return JSON.stringify(source)}
export function createArtifact(input:{id:string;source:ArtifactSource;title:string;sections:ArtifactSection[];note:string;now:string;primary?:boolean;messages?:ArtifactMessage[];files?:ArtifactFile[]}):Artifact{
  time(input.now)
  if(!input.sections.length||input.sections.length>40)throw Error('正文须包含 1 至 40 个段落。')
  const sections=input.sections.map(section=>({id:text(section.id,'段落编号',240),title:text(section.title,'段落标题',200),text:text(section.text,'段落正文')}))
  if(new Set(sections.map(section=>section.id)).size!==sections.length)throw Error('段落编号重复。')
  const messages=input.messages?copyArtifactMessages(input.messages,input.source.ref):undefined
  const files=input.files?copyArtifactFiles(input.files,input.source.ref):undefined
  return {links:[],id:text(input.id,'产物编号',500),source:structuredClone(input.source.ref),primary:!!input.primary,versions:[{number:1,title:text(input.title,'产物名称',200),sections,source:structuredClone(input.source),note:text(input.note,'保存说明',4000),author:'本人',at:input.now,...(messages?{messages}:{}),...(files?{files}:{})}],feedback:[]}
}
export function changeArtifact(artifact:Artifact,change:ArtifactChange,source:ArtifactSource):Artifact{
  time(change.now)
  if(sourceKey(artifact.source)!==sourceKey(source.ref))throw Error('产物来源不一致。')
  if(change.type==='feedback'){
    const version=artifact.versions.find(version=>version.number===change.version)
    if(!version)throw Error('反馈版本不存在。')
    if(!version.sections.some(section=>section.id===change.sectionId))throw Error('反馈段落不存在。')
    const value=text(change.text,'反馈',4000),id=text(change.id,'反馈编号',240)
    const existing=artifact.feedback.find(item=>item.id===id)
    if(existing){if(existing.version===change.version&&existing.sectionId===change.sectionId&&existing.text===value)return artifact;throw Error('反馈编号冲突。')}
    return {...artifact,feedback:[...artifact.feedback,{id,version:version.number,sectionId:change.sectionId,text:value,author:'本人',at:change.now}]}
  }
  const latest=artifact.versions.at(-1)!
  if(latest.number!==change.expectedVersion)throw Error('产物版本已变化，请从最新版重新核对草稿。')
  if(change.type==='files'){
    const files=copyArtifactFiles(change.files,source.ref)
    if(fileSetKey(files)===fileSetKey(latest.files||[]))throw Error('文件内容与引用未变化，无需生成新版本。')
    const next:ArtifactVersion={...structuredClone(latest),number:latest.number+1,source:structuredClone(source),files,note:text(change.note,'文件修改说明',4000),at:change.now,author:'本人'}
    delete next.feedbackId
    return {...artifact,versions:[...artifact.versions,next]}
  }
  if(!latest.sections.some(section=>section.id===change.sectionId))throw Error('修改段落不存在。')
  if(change.feedbackId){const feedback=artifact.feedback.find(item=>item.id===change.feedbackId);if(!feedback||feedback.version!==latest.number||feedback.sectionId!==change.sectionId)throw Error('反馈不属于本版本的这个段落。')}
  const body=text(change.text,'段落正文'),note=text(change.note,'修改说明',4000)
  if(latest.sections.find(section=>section.id===change.sectionId)!.text===body)throw Error('正文未变化，无需产生新版本。')
  const next:ArtifactVersion={number:latest.number+1,title:latest.title,sections:latest.sections.map(section=>({...section,...(section.id===change.sectionId?{text:body}:{})})),source:structuredClone(source),note,author:'本人',at:change.now,...(change.feedbackId?{feedbackId:change.feedbackId}:{})}
  if(latest.messages)next.messages=copyArtifactMessages(latest.messages,source.ref)
  if(latest.files)next.files=copyArtifactFiles(latest.files,source.ref)
  return {...artifact,versions:[...artifact.versions,next]}
}
export function artifactMarkdown(artifact:Artifact,number:number,t:TeloaTranslate):string{
  const version=artifact.versions.find(version=>version.number===number)
  if(!version)throw Error('导出版本不存在。')
  const source=version.source
  const native=[...artifactMessagesMarkdown(version.messages||[],t),...artifactFilesMarkdown(version.files||[],t)]
  return ['# '+version.title,'','> '+t(artifact.storage==='persistent'?'artifact.export.status.persistent':'artifact.export.status.preview'),'',t('artifact.export.version',{version:number,author:version.author,at:version.at}),'',...version.sections.flatMap(section=>['## '+section.title,'',section.text,'']),`## ${t('artifact.export.source.heading')}`,'',t('artifact.export.source.identity',{title:source.title,kind:source.ref.kind,id:source.ref.id,version:source.version}),t('artifact.export.source.meta',{scope:source.scope,author:source.author}),t(source.private?'artifact.export.source.private':'artifact.export.source.shared'),...source.evidence.map(value=>'- '+value),...native,'',`## ${t('artifact.export.revision.heading')}`,'',version.note,'',...(version.feedbackId?[t('artifact.export.feedback',{id:version.feedbackId}),'']:[])].join('\n')
}
