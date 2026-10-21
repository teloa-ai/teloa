import {isRecord,resourceId,resourceVersion} from './resources.ts'
export type ResourceUsageTarget={kind:'conversation'|'task'|'project'|'employee';id:string;scope?:string}
export type ResourceUsageItem={sessionId:string;title:string;messageId:string;at:string;version:number}
export type ResourceUsagePage={resourceId:string;version:number;items:ResourceUsageItem[];scanned:number;unavailable:number;nextCursor:string|null;related:Array<ResourceUsageTarget&{title:string}>;relatedMore:boolean}
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
export function isResourceUsagePage(value:unknown):value is ResourceUsagePage{
 if(!isRecord(value)||!resourceId(value.resourceId)||!resourceVersion(value.version)||!Array.isArray(value.items)||value.items.length>20||!Number.isInteger(value.scanned)||Number(value.scanned)<0||Number(value.scanned)>20||!Number.isInteger(value.unavailable)||Number(value.unavailable)<0||Number(value.unavailable)>Number(value.scanned)||!(value.nextCursor===null||id(value.nextCursor)))return false
 if(!Array.isArray(value.related)||value.related.length>20||typeof value.relatedMore!=='boolean'||value.related.some(item=>!isRecord(item)||!['task','project','employee'].includes(String(item.kind))||!resourceId(item.id)||typeof item.title!=='string'||!item.title.trim()||(item.scope!==undefined&&(typeof item.scope!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(item.scope)))))return false
 const seen=new Set<string>()
 return value.items.every(item=>{if(!isRecord(item)||!id(item.sessionId)||typeof item.title!=='string'||!item.title.trim()||!id(item.messageId)||typeof item.at!=='string'||!Number.isFinite(Date.parse(item.at))||!resourceVersion(item.version)||seen.has(item.sessionId))return false;seen.add(item.sessionId);return true})
}
