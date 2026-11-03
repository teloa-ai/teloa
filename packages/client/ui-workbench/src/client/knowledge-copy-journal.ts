import {isKnowledgeCopyPreview,isRecord,resourceId,type KnowledgeCopyInput,type KnowledgeCopyPreview,type WorkResource} from '@teloa/contract'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'
export type KnowledgeCopyDraft={preview:KnowledgeCopyPreview;title:string;markdown:string;requestId:string;pending:boolean}
/** 沿宿主隔离的工作台存储，固定本人、原资料及原版本；损坏或无法持久化时不发送。 */
export function knowledgeCopyJournal(storage:WorkbenchNavigationStorage|undefined,resource:WorkResource){
 const key='teloa.knowledge-copy/v1/'+encodeURIComponent(resource.ownerId)+'/'+resource.id+'/'+resource.sourceVersion
 const validate=(value:unknown):KnowledgeCopyDraft=>{
  if(!isRecord(value)||Object.keys(value).length!==5||!isKnowledgeCopyPreview(value.preview)||value.preview.origin.resourceId!==resource.id||value.preview.origin.sourceId!==resource.sourceId||value.preview.origin.resourceVersion>resource.version||value.preview.origin.sourceVersion!==resource.sourceVersion||JSON.stringify(value.preview.scopeIds)!==JSON.stringify(resource.scopeIds)||!resourceId(value.requestId)||typeof value.pending!=='boolean'||typeof value.title!=='string'||value.title.length>200||typeof value.markdown!=='string'||new TextEncoder().encode(value.markdown).byteLength>2*1024*1024)throw Error('副本草稿损坏，请先核对本地草稿。')
  return value as KnowledgeCopyDraft
 }
 return {
  read():KnowledgeCopyDraft|undefined{if(!storage)throw Error('无法保存副本草稿，请恢复本地存储后重试。');const raw=storage.getItem(key);return raw?validate(JSON.parse(raw)):undefined},
  write(value:KnowledgeCopyDraft){if(!storage)throw Error('无法保存副本草稿，请恢复本地存储后重试。');storage.setItem(key,JSON.stringify(validate(value)))},
  clear(requestId:string){if(!storage)throw Error('无法保存副本草稿。');const raw=storage.getItem(key);if(raw&&validate(JSON.parse(raw)).requestId===requestId)storage.removeItem(key)},
  input(value:KnowledgeCopyDraft):KnowledgeCopyInput{return {resourceId:value.preview.origin.resourceId,expectedResourceVersion:value.preview.origin.resourceVersion,sourceVersion:value.preview.origin.sourceVersion,requestId:value.requestId,title:value.title,markdown:value.markdown}},
 }
}
