import {isRecord,WorkError} from './index.ts'
import {projectUuid} from './projects.ts'

/** 群关联原工作的身份索引；不复制对象，不授予资料权限，也不自动注入 Agent 上下文。 */
export type GroupWorkLink={kind:'task'|'project';scope:string;id:string}|{kind:'business';scope:string;type:string;id:string}
export type GroupWorkLinkItem=GroupWorkLink&{available:boolean;title:string|null;state:string|null;objectVersion:number|null}
export type GroupWorkLinks={groupId:string;groupVersion:number;version:number;items:GroupWorkLinkItem[];projectLinks?:GroupWorkLinkItem[]}
export type GroupWorkLinksChangeInput={requestId:string;groupId:string;expectedGroupVersion:number;expectedVersion:number;links:GroupWorkLink[]}
const bad=()=>new WorkError('teloa/invalid-input','群关联工作格式不正确。')
const exact=(value:unknown,keys:readonly string[])=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw bad();return value}
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value)
export const groupWorkLinkKey=(link:GroupWorkLink)=>JSON.stringify([link.kind,link.scope,link.kind==='business'?link.type:null,link.id])
export function readGroupWorkLink(value:unknown):GroupWorkLink{
 const row=exact(value,['kind','scope','id',...(isRecord(value)&&value.kind==='business'?['type']:[])])
 if(!text(row.scope,64)||!/^[a-zA-Z0-9_-]+$/.test(row.scope))throw bad()
 if(row.kind==='business'){
  if(row.scope==='general'||!text(row.type,80)||!text(row.id,200)||!/^[\p{L}\p{N}][\p{L}\p{N}._:@/+ -]*$/u.test(row.id))throw bad()
  return {kind:'business',scope:row.scope,type:row.type,id:row.id}
 }
 if(!['task','project'].includes(String(row.kind))||!projectUuid(row.id))throw bad()
 return {kind:row.kind as 'task'|'project',scope:row.scope,id:row.id.toLowerCase()}
}
function list(value:unknown):GroupWorkLink[]{
 if(!Array.isArray(value)||value.length>100)throw bad()
 const links=value.map(readGroupWorkLink).sort((a,b)=>groupWorkLinkKey(a).localeCompare(groupWorkLinkKey(b)))
 if(new Set(links.map(groupWorkLinkKey)).size!==links.length)throw bad()
 return links
}
export function groupWorkLinksGetInput(value:unknown):{groupId:string}{const row=exact(value,['groupId']);if(!projectUuid(row.groupId))throw bad();return {groupId:row.groupId.toLowerCase()}}
export function groupWorkLinksChangeInput(value:unknown):GroupWorkLinksChangeInput{
 const row=exact(value,['requestId','groupId','expectedGroupVersion','expectedVersion','links'])
 if(!projectUuid(row.requestId)||!projectUuid(row.groupId)||!positive(row.expectedGroupVersion)||!Number.isSafeInteger(row.expectedVersion)||Number(row.expectedVersion)<0)throw bad()
 return {requestId:row.requestId.toLowerCase(),groupId:row.groupId.toLowerCase(),expectedGroupVersion:row.expectedGroupVersion,expectedVersion:Number(row.expectedVersion),links:list(row.links)}
}
export function groupWorkLinksCandidatesInput(value:unknown):{groupId:string;scope:string;kind:GroupWorkLink['kind'];query:string}{
 const row=exact(value,['groupId','scope','kind','query']);groupWorkLinksGetInput({groupId:row.groupId})
 if(!text(row.scope,64)||!/^[a-zA-Z0-9_-]+$/.test(row.scope)||!['task','project','business'].includes(String(row.kind))||typeof row.query!=='string'||row.query.length>120)throw bad()
 return {groupId:row.groupId as string,scope:row.scope,kind:row.kind as GroupWorkLink['kind'],query:row.query.trim()}
}
export function readGroupWorkLinkItem(value:unknown):GroupWorkLinkItem{
 const row=exact(value,['kind','scope','id','type','available','title','state','objectVersion'])
 const link=readGroupWorkLink({kind:row.kind,scope:row.scope,id:row.id,...(row.kind==='business'?{type:row.type}:{})})
 if(row.kind!=='business'&&Object.hasOwn(row,'type')||typeof row.available!=='boolean')throw bad()
 if(row.available){if(!text(row.title,240)||!text(row.state,120)||!positive(row.objectVersion))throw bad()}
 else if(row.title!==null||row.state!==null||row.objectVersion!==null)throw bad()
 return {...link,available:row.available,title:row.title as string|null,state:row.state as string|null,objectVersion:row.objectVersion as number|null}
}
export function readGroupWorkLinks(value:unknown):GroupWorkLinks{
 const row=exact(value,['groupId','groupVersion','version','items','projectLinks']);groupWorkLinksGetInput({groupId:row.groupId})
 if(!positive(row.groupVersion)||!Number.isSafeInteger(row.version)||Number(row.version)<0||!Array.isArray(row.items)||row.items.length>100)throw bad()
 const items=row.items.map(readGroupWorkLinkItem)
 if(new Set(items.map(groupWorkLinkKey)).size!==items.length)throw bad()
 const base={groupId:row.groupId as string,groupVersion:row.groupVersion,version:Number(row.version),items}
 // 存量不可变保存回执没有此投影；不把缺失字段改写为新的原请求结果。
 if(row.projectLinks===undefined)return base
 if(!Array.isArray(row.projectLinks)||row.projectLinks.length>10000)throw bad()
 const projectLinks=row.projectLinks.map(readGroupWorkLinkItem)
 if(projectLinks.some(item=>item.kind!=='project')||new Set(projectLinks.map(groupWorkLinkKey)).size!==projectLinks.length)throw bad()
 return {...base,projectLinks}
}
