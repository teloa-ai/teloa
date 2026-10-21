import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {isBusinessScopeKey} from './business-scopes.ts'
import {businessTimeRanges,readBusinessDashboardDefinition,readBusinessDashboardPage,type BusinessDashboardDefinition,type BusinessDashboardPage,type BusinessTimeRange,type BusinessWidgetCell} from './business-dashboards.ts'
import {readBusinessConfigurationPageProjectionVersioned,type BusinessConfigurationPageProjectionVersioned} from './business-configuration-page.ts'

export const businessDashboardShareEndpoint='business-dashboards/share-snapshot' as const
export const businessDashboardShareLimits={rows:5000,bytes:8*1024*1024,sections:12} as const
export type BusinessDashboardShareTarget=
 |{kind:'configuration';scope:string;pageId:string;configurationVersion:number;configurationHash:string;timeRange:BusinessTimeRange}
 |{kind:'legacy';scope:string;dashboardId:string;definitionHash:string;timeRange:BusinessTimeRange}
export type BusinessDashboardShareSection={widgetId:string;viewId:string;objectTypeId:string;columns:Array<{key:string;label:string}>;rows:BusinessWidgetCell[][];recordCount:number}
export type BusinessDashboardShareRaw={status:'ready';sections:BusinessDashboardShareSection[]}|{status:'unavailable';reason:'sql-source-lineage-unavailable'}
export type BusinessDashboardShareSnapshot={schema:'teloa.business-dashboard-share/v1';target:BusinessDashboardShareTarget;capturedAt:string;snapshotHash:string;page:{kind:'configuration';projection:BusinessConfigurationPageProjectionVersioned}|{kind:'legacy';page:BusinessDashboardPage};raw:BusinessDashboardShareRaw}
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const fail=(host=false):never=>{throw new WorkError(host?'teloa/invalid-host-response':'teloa/invalid-input',host?'看板分享快照与原业务、版本或范围不一致。':'看板分享目标格式不正确。')}
function exact(value:unknown,keys:string[],host=false):Record<string,unknown>{
 if(!isRecord(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))return fail(host)
 return value
}
export function readBusinessDashboardShareTarget(value:unknown):BusinessDashboardShareTarget{
 if(!isRecord(value))return fail()
 const row=exact(value,value.kind==='configuration'?['kind','scope','pageId','configurationVersion','configurationHash','timeRange']:['kind','scope','dashboardId','definitionHash','timeRange'])
 if(!isBusinessScopeKey(row.scope)||row.scope==='general'||!businessTimeRanges.includes(row.timeRange as BusinessTimeRange))return fail()
 if(row.kind==='configuration'){
  if(!id(row.pageId)||!positive(row.configurationVersion)||!hash(row.configurationHash))return fail()
  return {kind:'configuration',scope:row.scope,pageId:row.pageId,configurationVersion:row.configurationVersion,configurationHash:row.configurationHash,timeRange:row.timeRange as BusinessTimeRange}
 }
 if(row.kind!=='legacy'||!id(row.dashboardId)||!hash(row.definitionHash))return fail()
 return {kind:'legacy',scope:row.scope,dashboardId:row.dashboardId,definitionHash:row.definitionHash,timeRange:row.timeRange as BusinessTimeRange}
}
/** 跨宿主和浏览器使用相同声明顺序；调用方以 SHA-256 绑定当前看板。 */
export const businessDashboardShareDefinitionText=(value:BusinessDashboardDefinition):string=>JSON.stringify(readBusinessDashboardDefinition(value))
/** 对象键递归排序、数组次序保留；摘要覆盖规范后的完整数据，不包含摘要自身。 */
export function businessDashboardShareSnapshotText(value:Omit<BusinessDashboardShareSnapshot,'snapshotHash'>):string{
 const {snapshotHash:_,...read}=readBusinessDashboardShareSnapshot({...value,snapshotHash:'0'.repeat(64)})
 const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):isRecord(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
 return JSON.stringify(canonical(read))
}
function rawOf(value:unknown):BusinessDashboardShareRaw{
 if(!isRecord(value))return fail(true)
 if(value.status==='unavailable'){
  const row=exact(value,['status','reason'],true)
  if(row.reason!=='sql-source-lineage-unavailable')return fail(true)
  return {status:'unavailable',reason:row.reason}
 }
 const row=exact(value,['status','sections'],true)
 if(row.status!=='ready'||!Array.isArray(row.sections)||row.sections.length<1||row.sections.length>businessDashboardShareLimits.sections)return fail(true)
 let total=0
 const sections=row.sections.map(value=>{
  const item=exact(value,['widgetId','viewId','objectTypeId','columns','rows','recordCount'],true)
  if(!id(item.widgetId)||!id(item.viewId)||!id(item.objectTypeId)||!Array.isArray(item.columns)||item.columns.length<1||item.columns.length>60||!Array.isArray(item.rows)||item.recordCount!==item.rows.length)return fail(true)
  const columns=item.columns.map(value=>{
   const column=exact(value,['key','label'],true)
   if(typeof column.key!=='string'||! /^(record|field)\.[a-zA-Z0-9_-]+$/.test(column.key)||typeof column.label!=='string'||!column.label.trim()||column.label.length>240)return fail(true)
   return {key:column.key,label:column.label}
  })
  if(new Set(columns.map(column=>column.key)).size!==columns.length)return fail(true)
  const rows=item.rows.map(value=>{
   if(!Array.isArray(value)||value.length!==columns.length||value.some(cell=>cell!==null&&typeof cell!=='string'&&typeof cell!=='boolean'&&(typeof cell!=='number'||!Number.isFinite(cell))))return fail(true)
   return [...value] as BusinessWidgetCell[]
  })
  total+=rows.length
  if(total>businessDashboardShareLimits.rows)return fail(true)
  return {widgetId:item.widgetId,viewId:item.viewId,objectTypeId:item.objectTypeId,columns,rows,recordCount:rows.length}
 })
 if(new Set(sections.map(section=>section.widgetId)).size!==sections.length)return fail(true)
 return {status:'ready',sections}
}
export function readBusinessDashboardShareSnapshot(value:unknown):BusinessDashboardShareSnapshot{
 try{
  const row=exact(value,['schema','target','capturedAt','snapshotHash','page','raw'],true),target=readBusinessDashboardShareTarget(row.target)
  if(row.schema!=='teloa.business-dashboard-share/v1'||!stamp(row.capturedAt)||!hash(row.snapshotHash))return fail(true)
  let page:BusinessDashboardShareSnapshot['page']
  if(target.kind==='configuration'){
   const wrapped=exact(row.page,['kind','projection'],true),projection=readBusinessConfigurationPageProjectionVersioned(wrapped.projection)
   if(wrapped.kind!=='configuration'||projection.mode!=='saved'||projection.page.kind!=='dashboard'||projection.scope!==target.scope||projection.configurationVersion!==target.configurationVersion||projection.configurationHash!==target.configurationHash||projection.page.definition.id!==target.pageId||projection.page.timeRange!==target.timeRange)return fail(true)
   page={kind:'configuration',projection}
  }else{
   const wrapped=exact(row.page,['kind','page'],true),read=readBusinessDashboardPage(wrapped.page,target.scope)
   if(wrapped.kind!=='legacy'||read.dashboard.id!==target.dashboardId||(read.timeRange?.selected??'all')!==target.timeRange)return fail(true)
   page={kind:'legacy',page:read}
  }
  const raw=rawOf(row.raw),widgets=page.kind==='configuration'&&page.projection.page.kind==='dashboard'?page.projection.page.widgets:page.kind==='legacy'?page.page.widgets:[]
  if(raw.status==='unavailable'&&widgets.every(widget=>widget.kind==='view-ref'))return fail(true)
  if(raw.status==='ready'&&(raw.sections.length!==widgets.length||raw.sections.some((section,index)=>section.widgetId!==widgets[index]?.id||section.viewId!==widgets[index]?.viewRef)))return fail(true)
  const result:BusinessDashboardShareSnapshot={schema:'teloa.business-dashboard-share/v1',target,capturedAt:row.capturedAt,snapshotHash:row.snapshotHash,page,raw}
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>businessDashboardShareLimits.bytes)return fail(true)
  return result
 }catch{return fail(true)}
}
