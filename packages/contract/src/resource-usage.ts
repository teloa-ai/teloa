import {isRecord,resourceId,resourceVersion} from './resources.ts'
/** 会话定位保留原消息；当前关联工作与群不冒充历史消息引用。 */
export type ResourceUsageTarget=
 |{kind:'conversation';id:string;scope?:string;messageId?:string}
 |{kind:'group';id:string;scope?:string;messageId?:string;rootId?:string|null}
 |{kind:'task'|'project'|'employee';id:string;scope?:string;messageId?:never}
export type ResourceUsageRelated=
 |{kind:'task'|'project'|'employee';id:string;title:string;scope?:string}
 |{kind:'group';id:string;title:string;scope:string;messageId:string;rootId:string|null;version:number;count:number}
export type ResourceUsageItem={sessionId:string;title:string;messageId:string;at:string;version:number}
export type ResourceUsagePage={resourceId:string;version:number;items:ResourceUsageItem[];scanned:number;unavailable:number;nextCursor:string|null;related:ResourceUsageRelated[];relatedMore:boolean}
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
export function isResourceUsagePage(value:unknown):value is ResourceUsagePage{
 if(!isRecord(value)||!resourceId(value.resourceId)||!resourceVersion(value.version)||!Array.isArray(value.items)||value.items.length>20||!Number.isInteger(value.scanned)||Number(value.scanned)<0||Number(value.scanned)>20||!Number.isInteger(value.unavailable)||Number(value.unavailable)<0||Number(value.unavailable)>Number(value.scanned)||!(value.nextCursor===null||id(value.nextCursor)))return false
 if(!Array.isArray(value.related)||value.related.length>20||typeof value.relatedMore!=='boolean'||value.related.some(item=>{
  if(!isRecord(item)||!resourceId(item.id)||typeof item.title!=='string'||!item.title.trim()||item.scope!==undefined&&(typeof item.scope!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(item.scope)))return true
  if(item.kind==='group')return Object.keys(item).length!==8||typeof item.scope!=='string'||!id(item.messageId)||!(item.rootId===null||id(item.rootId))||!resourceVersion(item.version)||!resourceVersion(item.count)
  return !['task','project','employee'].includes(String(item.kind))||['messageId','rootId','version','count'].some(key=>item[key]!==undefined)
 }))return false
 const seen=new Set<string>()
 return value.items.every(item=>{if(!isRecord(item)||!id(item.sessionId)||typeof item.title!=='string'||!item.title.trim()||!id(item.messageId)||typeof item.at!=='string'||!Number.isFinite(Date.parse(item.at))||!resourceVersion(item.version)||seen.has(item.sessionId))return false;seen.add(item.sessionId);return true})
}
