import {isLocalKnowledgeCopyPreview,isRecord,resourceId,type LocalKnowledgeCopyPreview,type LocalKnowledgeCopyInput,type WorkResource} from '@teloa/contract'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'
export type LibraryLocalCopyDraft={preview:LocalKnowledgeCopyPreview;title:string;markdown:string;requestId:string;pending:boolean}
/** 本机副本独立于分享包许可。原文件/资料版本、路径、范围与 nonce 一并固定。 */
export function libraryLocalCopyJournal(storage:WorkbenchNavigationStorage|undefined,resource:WorkResource){
 const key='teloa.local-knowledge-copy/v1/'+encodeURIComponent(resource.ownerId)+'/'+resource.id+'/'+resource.sourceVersion
 const parse=(value:unknown):LibraryLocalCopyDraft=>{
  if(!isRecord(value)||Object.keys(value).length!==5||!isLocalKnowledgeCopyPreview(value.preview)||value.preview.origin.resourceId!==resource.id||value.preview.origin.resourceVersion>resource.version||value.preview.origin.sourceId!==resource.sourceId||value.preview.origin.sourceVersion!==resource.sourceVersion||JSON.stringify(value.preview.scopeIds)!==JSON.stringify(resource.scopeIds)||!resourceId(value.requestId)||typeof value.pending!=='boolean'||typeof value.title!=='string'||value.title.length>200||typeof value.markdown!=='string'||new TextEncoder().encode(value.markdown).byteLength>2*1024*1024)throw Error('Invalid local knowledge copy draft')
  return value as LibraryLocalCopyDraft
 }
 return {
  read():LibraryLocalCopyDraft|undefined{if(!storage)throw Error('Local draft storage unavailable');const raw=storage.getItem(key);return raw?parse(JSON.parse(raw)):undefined},
  write(value:LibraryLocalCopyDraft){if(!storage)throw Error('Local draft storage unavailable');storage.setItem(key,JSON.stringify(parse(value)))},
  clear(requestId:string){if(!storage)throw Error('Local draft storage unavailable');const raw=storage.getItem(key);if(raw&&parse(JSON.parse(raw)).requestId===requestId)storage.removeItem(key)},
  input(value:LibraryLocalCopyDraft):LocalKnowledgeCopyInput{return {resourceId:value.preview.origin.resourceId,expectedResourceVersion:value.preview.origin.resourceVersion,sourceVersion:value.preview.origin.sourceVersion,requestId:value.requestId,title:value.title,markdown:value.markdown}},
 }
}
