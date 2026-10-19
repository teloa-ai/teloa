import {isRecord,WorkError} from './index.ts'
export type SavedArtifactSource={kind:'session'|'task'|'run'|'analysis'|'object';id:string;scope:string;version:string;title:string;objectType?:string}
export type ArtifactContent={title:string;sections:{id:string;title:string;text:string}[];snapshotIds:string[];messageSnapshotIds?:string[];note:string;feedbackId?:string}
export type SavedArtifactVersion={artifactId:string;ownerId:string;number:number;source:SavedArtifactSource;content:ArtifactContent;createdAt:string}
export type SavedArtifactFeedback={id:string;artifactId:string;ownerId:string;version:number;sectionId:string;text:string;createdAt:string}
/** 员工工作成果目录的一条只读引用：只带当前版本的元数据，正文按需再读。attribution 记录按哪条真实记录归给该员工。 */
export type RoleArtifactSummary={artifactId:string;number:number;title:string;source:SavedArtifactSource;createdAt:string;updatedAt:string;attribution:'run'|'task'|'session'}
export function roleArtifactSummary(value:unknown):RoleArtifactSummary{
 const row=artifactInput(value,['artifactId','number','title','source','createdAt','updatedAt','attribution'])
 if(typeof row.artifactId!=='string'||!/^[a-f0-9-]{36}$/i.test(row.artifactId)||!Number.isSafeInteger(row.number)||(row.number as number)<1||![row.createdAt,row.updatedAt].every(time=>typeof time==='string'&&Number.isFinite(Date.parse(time)))||!['run','task','session'].includes(row.attribution as string))throw new WorkError('teloa/invalid-input','员工成果目录条目不正确。')
 return {artifactId:row.artifactId,number:row.number as number,title:text(row.title,200),source:savedArtifactSource(row.source),createdAt:row.createdAt as string,updatedAt:row.updatedAt as string,attribution:row.attribution as RoleArtifactSummary['attribution']}
}
export function savedArtifactFeedback(value:unknown):SavedArtifactFeedback{
 const row=artifactInput(value,['id','artifactId','ownerId','version','sectionId','text','createdAt'])
 if(![row.id,row.artifactId].every(id=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id))||!Number.isSafeInteger(row.version)||(row.version as number)<1||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt)))throw new WorkError('teloa/invalid-input','成果反馈身份或时间不正确。')
 return {id:row.id as string,artifactId:row.artifactId as string,ownerId:text(row.ownerId,128),version:row.version as number,sectionId:text(row.sectionId,240),text:text(row.text,4000),createdAt:row.createdAt}
}
export function artifactInput(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new WorkError('teloa/invalid-input','成果请求格式或字段不正确。')
 return value
}
function text(value:unknown,max:number):string{if(typeof value!=='string'||!value.trim()||value.length>max)throw new WorkError('teloa/invalid-input','成果字段为空或超过长度限制。');return value.trim()}
export function savedArtifactSource(value:unknown):SavedArtifactSource{
 const row=artifactInput(value,['kind','id','scope','version','title','objectType'])
 if(typeof row.kind!=='string'||!['session','task','run','analysis','object'].includes(row.kind))throw new WorkError('teloa/invalid-input','成果来源类型不正确。')
 if(row.kind!=='object'&&row.objectType!==undefined)throw new WorkError('teloa/invalid-input','此来源不能包含对象类型。')
 return {kind:row.kind as SavedArtifactSource['kind'],id:text(row.id,128),scope:text(row.scope,128),version:text(row.version,2000),title:text(row.title,200),...(row.kind==='object'?{objectType:text(row.objectType,128)}:{})}
}
export function artifactContent(value:unknown):ArtifactContent{
 const row=artifactInput(value,['title','sections','snapshotIds','note','feedbackId','messageSnapshotIds'])
 const messages=row.messageSnapshotIds??[]
 if(!Array.isArray(messages)||messages.length>20||messages.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))||new Set(messages).size!==messages.length)throw new WorkError('teloa/invalid-input','成果消息引用不正确。')
 if(row.feedbackId!==undefined&&(typeof row.feedbackId!=='string'||!/^[a-f0-9-]{36}$/i.test(row.feedbackId)))throw new WorkError('teloa/invalid-input','反馈关联身份不正确。')
 if(!Array.isArray(row.sections)||row.sections.length>40||!Array.isArray(row.snapshotIds)||row.snapshotIds.length>10||row.snapshotIds.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw new WorkError('teloa/invalid-input','成果段落或文件引用不正确。')
 const sections=row.sections.map(value=>{const section=artifactInput(value,['id','title','text']);return {id:text(section.id,240),title:text(section.title,200),text:text(section.text,16000)}})
 if((!sections.length&&!row.snapshotIds.length&&!messages.length)||new Set(sections.map(s=>s.id)).size!==sections.length||new Set(row.snapshotIds).size!==row.snapshotIds.length||sections.reduce((total,s)=>total+s.text.length,0)>64000)throw new WorkError('teloa/invalid-input','成果为空、包含重复引用或正文总量超过限制。')
 return {title:text(row.title,200),sections,snapshotIds:[...row.snapshotIds] as string[],note:text(row.note,4000),...(messages.length?{messageSnapshotIds:[...messages] as string[]} : {}),...(typeof row.feedbackId==='string'?{feedbackId:row.feedbackId}:{})}
}
