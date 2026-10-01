import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {isBusinessScopeKey} from './business-scopes.ts'
import {businessDefinitionCanonicalBody,readBusinessDefinitionBody,type BusinessDefinitionKind,type BusinessObjectTypeDefinition,type BusinessViewDefinition} from './business-definitions.ts'
import {type BusinessWidgetDefinition,type BusinessDashboardDefinition} from './business-dashboards.ts'
import type {BusinessSourceMappingDefinition} from './business-source-mapping.ts'
import {industryUpdateCanonical} from './industry-update-compare.ts'

export const businessConfigurationLimits={canonicalBytes:2_097_152,definitions:256,pages:24,sources:16,pendingDraftsPerOwner:16} as const
export const businessConfigurationFormat='teloa.business-configuration/v1' as const
export const businessConfigurationDefinitionKinds=['object-type','view','source-mapping','widget','dashboard'] as const
export type BusinessConfigurationDefinitionKind=typeof businessConfigurationDefinitionKinds[number]
export type BusinessConfigurationDefinitionBody=BusinessObjectTypeDefinition|BusinessViewDefinition|BusinessSourceMappingDefinition|BusinessWidgetDefinition|BusinessDashboardDefinition
export type BusinessConfigurationCandidateDefinition={kind:BusinessConfigurationDefinitionKind;definition:BusinessConfigurationDefinitionBody}
export type BusinessConfigurationDefinitionReference={kind:BusinessConfigurationDefinitionKind;localId:string;version:number;definitionHash:string}
export type BusinessConfigurationSource={sourceId:string;kind:'local-records'}
export type BusinessConfigurationPage=
 |{id:string;title:string;kind:'records';objectType:string;fields:string[];allowCreate:boolean;allowEdit:boolean;allowArchive:boolean}
 |{id:string;title:string;kind:'dashboard';dashboardId:string}
type Shared={format:typeof businessConfigurationFormat;scope:string;title:string;sources:BusinessConfigurationSource[];pages:BusinessConfigurationPage[];homePageId?:string}
export type BusinessConfigurationCandidate=Shared&{definitions:BusinessConfigurationCandidateDefinition[]}
export type BusinessConfigurationManifest=Shared&{definitions:BusinessConfigurationDefinitionReference[]}
export type BusinessConfigurationPatch={title?:string;homePageId?:string;upsertDefinitions?:BusinessConfigurationCandidateDefinition[];removeDefinitions?:Array<{kind:BusinessConfigurationDefinitionKind;localId:string}>;upsertPages?:BusinessConfigurationPage[];removePageIds?:string[];pageOrder?:string[]}

const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
const localId=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
const fieldName=/^[a-z0-9][a-z0-9_-]{0,62}$/
const hash=/^[a-f0-9]{64}$/
const title=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=80&&!/[\x00-\x08\x0a-\x1f\x7f]/.test(value)
const identity=(kind:BusinessConfigurationDefinitionKind,id:string)=>kind+'\0'+id

function exact(value:unknown,required:readonly string[],optional:readonly string[],message:string):Record<string,unknown>{
 if(!isRecord(value)||required.some(key=>!(key in value))||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))throw bad(message)
 return value
}
function identifier(value:unknown,message:string):string{
 if(typeof value!=='string'||!localId.test(value))throw bad(message)
 return value
}
function kind(value:unknown):BusinessConfigurationDefinitionKind{
 if(!(businessConfigurationDefinitionKinds as readonly unknown[]).includes(value))throw bad('配置定义类型不在首片白名单内。')
 return value as BusinessConfigurationDefinitionKind
}
function unique<T>(items:T[],key:(item:T)=>string,message:string):T[]{
 if(new Set(items.map(key)).size!==items.length)throw bad(message)
 return items
}
function bounded(value:unknown,max:number,message:string):unknown[]{
 if(!Array.isArray(value)||value.length>max)throw bad(message)
 return value
}
function source(value:unknown):BusinessConfigurationSource{
 const row=exact(value,['sourceId','kind'],[],'配置来源格式不正确。')
 if(row.kind!=='local-records')throw bad('配置来源类型只允许 local-records。')
 return {sourceId:identifier(row.sourceId,'配置来源标识不合法。'),kind:'local-records'}
}
export function readBusinessConfigurationPage(value:unknown):BusinessConfigurationPage{
 if(!isRecord(value))throw bad('配置页面格式不正确。')
 if(value.kind==='records'){
  const row=exact(value,['id','title','kind','objectType','fields','allowCreate','allowEdit','allowArchive'],[],'记录页面格式不正确。')
  if(!title(row.title))throw bad('页面标题不合法。')
  const fields=bounded(row.fields,50,'记录页面字段超过上限。').map(value=>{
   if(typeof value!=='string'||!fieldName.test(value))throw bad('记录页面字段须使用字段 name。')
   return value
  })
  if(!fields.length)throw bad('记录页面至少声明一个字段。')
  unique(fields,value=>value,'记录页面字段重复。')
  if(typeof row.allowCreate!=='boolean'||typeof row.allowEdit!=='boolean'||typeof row.allowArchive!=='boolean')throw bad('记录页面操作开关须为布尔值。')
  return {id:identifier(row.id,'页面标识不合法。'),title:row.title,kind:'records',objectType:identifier(row.objectType,'记录页面对象类型标识不合法。'),fields,allowCreate:row.allowCreate,allowEdit:row.allowEdit,allowArchive:row.allowArchive}
 }
 if(value.kind==='dashboard'){
  const row=exact(value,['id','title','kind','dashboardId'],[],'看板页面格式不正确。')
  if(!title(row.title))throw bad('页面标题不合法。')
  return {id:identifier(row.id,'页面标识不合法。'),title:row.title,kind:'dashboard',dashboardId:identifier(row.dashboardId,'看板页面绑定标识不合法。')}
 }
 throw bad('配置页面类型不在首片白名单内。')
}
function candidateDefinition(value:unknown):BusinessConfigurationCandidateDefinition{
 const row=exact(value,['kind','definition'],[],'配置定义格式不正确。')
 const selected=kind(row.kind)
 const definition=readBusinessDefinitionBody(selected as BusinessDefinitionKind,row.definition) as BusinessConfigurationDefinitionBody
 businessDefinitionCanonicalBody(definition)
 return {kind:selected,definition}
}
function reference(value:unknown):BusinessConfigurationDefinitionReference{
 const row=exact(value,['kind','localId','version','definitionHash'],[],'配置定义引用格式不正确。')
 const selected=kind(row.kind)
 if(!Number.isSafeInteger(row.version)||Number(row.version)<=0)throw bad('配置定义引用版本必须为正整数。')
 if(typeof row.definitionHash!=='string'||!hash.test(row.definitionHash))throw bad('配置定义引用哈希必须为 sha256。')
 return {kind:selected,localId:identifier(row.localId,'配置定义引用标识不合法。'),version:row.version as number,definitionHash:row.definitionHash}
}
function common(value:unknown):Shared&{definitions:unknown}{
 const row=exact(value,['format','scope','title','sources','definitions','pages'],['homePageId'],'配置格式不正确。')
 if(row.format!==businessConfigurationFormat)throw bad('配置格式版本不支持。')
 if(!isBusinessScopeKey(row.scope)||row.scope==='general')throw bad('配置业务范围不合法。')
 if(!title(row.title))throw bad('配置标题不合法。')
 const sources=bounded(row.sources,businessConfigurationLimits.sources,'配置来源超过上限。').map(source)
 if(sources.length!==1)throw bad('首片配置须有一个平台分配的本地记录来源。')
 unique(sources,item=>item.sourceId,'配置来源标识重复。')
 const pages=unique(bounded(row.pages,businessConfigurationLimits.pages,'配置页面超过上限。').map(readBusinessConfigurationPage),item=>item.id,'配置页面标识重复。')
 const homePageId=row.homePageId===undefined?undefined:identifier(row.homePageId,'配置首页标识不合法。')
 if(pages.length?homePageId===undefined||!pages.some(item=>item.id===homePageId):homePageId!==undefined)throw bad('配置首页必须绑定现有页面；空草案不得指定首页。')
 return {format:businessConfigurationFormat,scope:row.scope,title:row.title,sources,pages,...(homePageId===undefined?{}:{homePageId}),definitions:row.definitions}
}
function checkSize(value:unknown):void{
 if(new TextEncoder().encode(industryUpdateCanonical(value)).byteLength>businessConfigurationLimits.canonicalBytes)throw bad('配置规范 JSON 超过 2 MiB。')
}
function checkPageBindings(pages:BusinessConfigurationPage[],keys:Set<string>):void{
 for(const page of pages){
  const target=page.kind==='records'?identity('object-type',page.objectType):identity('dashboard',page.dashboardId)
  if(!keys.has(target))throw bad('页面绑定的定义不存在：'+page.id+'。')
 }
}

export function readBusinessConfigurationCandidate(value:unknown):BusinessConfigurationCandidate{
 const row=common(value)
 const definitions=unique(bounded(row.definitions,businessConfigurationLimits.definitions,'配置定义超过上限。').map(candidateDefinition),item=>identity(item.kind,item.definition.id),'配置定义身份重复。')
 for(const item of definitions)if(item.definition.domain!==row.scope)throw bad('配置定义所属业务范围与配置不一致。')
 const result={...row,definitions}
 checkPageBindings(result.pages,new Set(definitions.map(item=>identity(item.kind,item.definition.id))))
 checkSize(result)
 return result
}

export function readBusinessConfigurationManifest(value:unknown):BusinessConfigurationManifest{
 const row=common(value)
 const definitions=unique(bounded(row.definitions,businessConfigurationLimits.definitions,'配置定义超过上限。').map(reference),item=>identity(item.kind,item.localId),'配置定义身份重复。')
 if(!row.pages.length)throw bad('正式配置至少须有一页。')
 const result={...row,definitions}
 checkPageBindings(result.pages,new Set(definitions.map(item=>identity(item.kind,item.localId))))
 checkSize(result)
 return result
}

export function readBusinessConfigurationPatch(value:unknown):BusinessConfigurationPatch{
 const row=exact(value,[],['title','homePageId','upsertDefinitions','removeDefinitions','upsertPages','removePageIds','pageOrder'],'配置修改格式不正确。')
 const result:BusinessConfigurationPatch={}
 if('title' in row){if(!title(row.title))throw bad('配置标题不合法。');result.title=row.title}
 if('homePageId' in row)result.homePageId=identifier(row.homePageId,'配置首页标识不合法。')
 if('upsertDefinitions' in row)result.upsertDefinitions=unique(bounded(row.upsertDefinitions,businessConfigurationLimits.definitions,'配置定义变更超过上限。').map(candidateDefinition),item=>identity(item.kind,item.definition.id),'配置定义增改身份重复。')
 if('removeDefinitions' in row)result.removeDefinitions=unique(bounded(row.removeDefinitions,businessConfigurationLimits.definitions,'配置定义移除超过上限。').map(value=>{
  const item=exact(value,['kind','localId'],[],'配置定义移除格式不正确。')
  return {kind:kind(item.kind),localId:identifier(item.localId,'配置定义移除标识不合法。')}
 }),item=>identity(item.kind,item.localId),'配置定义移除身份重复。')
 if('upsertPages' in row)result.upsertPages=unique(bounded(row.upsertPages,businessConfigurationLimits.pages,'配置页面增改超过上限。').map(readBusinessConfigurationPage),item=>item.id,'配置页面增改标识重复。')
 if('removePageIds' in row)result.removePageIds=unique(bounded(row.removePageIds,businessConfigurationLimits.pages,'配置页面移除超过上限。').map(value=>identifier(value,'配置页面移除标识不合法。')),item=>item,'配置页面移除标识重复。')
 if('pageOrder' in row)result.pageOrder=unique(bounded(row.pageOrder,businessConfigurationLimits.pages,'配置页面排序超过上限。').map(value=>identifier(value,'配置页面排序标识不合法。')),item=>item,'配置页面排序标识重复。')
 const upsertDefinitions=new Set(result.upsertDefinitions?.map(item=>identity(item.kind,item.definition.id)))
 if(result.removeDefinitions?.some(item=>upsertDefinitions.has(identity(item.kind,item.localId))))throw bad('同一配置定义不能同时增改和移除。')
 const upsertPages=new Set(result.upsertPages?.map(item=>item.id))
 if(result.removePageIds?.some(id=>upsertPages.has(id)))throw bad('同一页面不能同时增改和移除。')
 checkSize(result)
 return result
}
