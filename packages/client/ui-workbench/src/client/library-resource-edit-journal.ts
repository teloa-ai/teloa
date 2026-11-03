import {isRecord,resourceId,type WorkResource,type KnowledgeResourceReviseInput,type KnowledgeResourceRestoreInput} from '@teloa/contract'
import type {ResourceApi} from './resource-api.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'
export type LibraryResourceEditPending={kind:'revise';input:KnowledgeResourceReviseInput}|{kind:'restore';input:KnowledgeResourceRestoreInput}
export type LibraryResourceEditDraft={knowledgeId:string;baseKnowledgeVersion:number;markdown:string;requestId:string;pending?:LibraryResourceEditPending}
const memory=new WeakMap<ResourceApi,Map<string,LibraryResourceEditDraft>>()
/** 资料引用与知识正文各有版本；草稿和未知回执始终固定这两份原始身份。 */
export function libraryResourceEditJournal(api:ResourceApi,resource:WorkResource,knowledgeId:string,storage:WorkbenchNavigationStorage|undefined){
 const key='teloa.library-resource-edit/v1/'+encodeURIComponent(resource.ownerId)+'/'+resource.id+'/'+resource.version+'/'+resource.sourceVersion
 let rows=memory.get(api);if(!rows){rows=new Map();memory.set(api,rows)}
 const parse=(raw:string):LibraryResourceEditDraft=>{
  const value:unknown=JSON.parse(raw)
  if(!isRecord(value)||Object.keys(value).some(k=>!['knowledgeId','baseKnowledgeVersion','markdown','requestId','pending'].includes(k))||value.knowledgeId!==knowledgeId||!Number.isSafeInteger(value.baseKnowledgeVersion)||Number(value.baseKnowledgeVersion)<1||typeof value.markdown!=='string'||new TextEncoder().encode(value.markdown).byteLength>2*1024*1024||!resourceId(value.requestId))throw Error('Invalid library edit draft')
  if(value.pending){const p=value.pending;if(!isRecord(p)||!['revise','restore'].includes(String(p.kind))||!isRecord(p.input)||Object.keys(p).length!==2||Object.keys(p.input).length!==6||Object.keys(p.input).some(k=>!['requestId','knowledgeId','expectedKnowledgeVersion','resourceId','expectedResourceVersion',p.kind==='revise'?'markdown':'restoreVersion'].includes(k))||p.input.requestId!==value.requestId||p.input.knowledgeId!==knowledgeId||p.input.resourceId!==resource.id||p.input.expectedResourceVersion!==resource.version||p.input.expectedKnowledgeVersion!==value.baseKnowledgeVersion||p.kind==='revise'&&p.input.markdown!==value.markdown||p.kind==='restore'&&(!Number.isSafeInteger(p.input.restoreVersion)||Number(p.input.restoreVersion)<1||Number(p.input.restoreVersion)>Number(value.baseKnowledgeVersion)))throw Error('Invalid library edit request')}
  return value as LibraryResourceEditDraft
 }
 const read=()=>{const raw=storage?.getItem(key);return raw?parse(raw):rows.get(key)}
 return {read,write(value:LibraryResourceEditDraft){const raw=JSON.stringify(value);parse(raw);rows.set(key,value);storage?.setItem(key,raw)},clear(requestId:string){if(read()?.requestId!==requestId)return;rows.delete(key);storage?.removeItem(key)}}
}
