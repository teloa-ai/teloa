import {createHash} from 'node:crypto'
import {WorkError,industryUpdateCanonical,readBusinessConfigurationCandidateV2,type BusinessConfigurationCandidateV2,type BusinessDashboardResourceDefinition} from '@teloa/contract'

type Candidate=BusinessConfigurationCandidateV2
const conflict=(message:string)=>new WorkError('teloa/conflict',message)
const key=(kind:string,id:string)=>kind+'\0'+id

/** 只映射声明身份；记录与运行授权不在输入内。已有对象仅在字段结构完全一致时复用。 */
export function mapBusinessDashboardConfiguration(resource:BusinessDashboardResourceDefinition,target:Candidate,objectMapping:Readonly<Record<string,string>>={}):Candidate{
 const source=resource.configuration,objects=source.definitions.filter(row=>row.kind==='object-type')
 const objectIds=new Map(objects.map(row=>[row.definition.id,objectMapping[row.definition.id]??row.definition.id]))
 if(Object.keys(objectMapping).some(id=>!objectIds.has(id))||new Set(objectIds.values()).size!==objectIds.size)throw conflict('对象对应关系不完整或重复，请重新选择。')
 const digest=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,12)
 const prefix='board-'+digest(resource.id)+'-'
 const id=(value:string)=>prefix+value.slice(0,119-prefix.length-13)+'-'+digest(value)
 const objectId=(value:string)=>objectIds.get(value)??value
 if(source.definitions.some(row=>row.kind==='widget'&&row.definition.query!==undefined)&&[...objectIds].some(([old,next])=>old!==next))throw conflict('这个看板的查询使用原对象名称。请保留对象名称，或先在业务中调整查询后重新分享。')
 const incoming=source.definitions.map(row=>{
  if(row.kind==='object-type'){
   const object={...row.definition,id:objectId(row.definition.id),domain:target.scope,sourceId:target.sources[0]!.sourceId,fields:row.definition.fields.map(field=>'referenceType' in field?{...field,referenceType:objectId(field.referenceType)}:field)}
   const existing=target.definitions.find(item=>item.kind==='object-type'&&item.definition.id===object.id)
   if(existing?.kind==='object-type'){
    if(industryUpdateCanonical(existing.definition.fields)!==industryUpdateCanonical(object.fields)||existing.definition.unit!==object.unit||industryUpdateCanonical(existing.definition.constraints??null)!==industryUpdateCanonical(object.constraints??null))throw conflict('现有对象「'+object.id+'」的字段或单位不同，请选择兼容对象或使用新的对象名称。')
    return existing
   }
   return {kind:'object-type' as const,definition:object}
  }
  if(row.kind==='view')return {kind:'view' as const,definition:{...row.definition,id:id(row.definition.id),domain:target.scope,objectType:objectId(row.definition.objectType)}}
  if(row.kind==='widget')return {kind:'widget' as const,definition:{...row.definition,id:id(row.definition.id),domain:target.scope,...(row.definition.viewRef?{viewRef:id(row.definition.viewRef)}:{}),...(row.definition.drilldown?{drilldown:{...row.definition.drilldown,objectType:objectId(row.definition.drilldown.objectType)}}:{})}}
  if(row.kind==='dashboard')return {kind:'dashboard' as const,definition:{...row.definition,id:id(row.definition.id),domain:target.scope,widgets:row.definition.widgets.map(id),layout:row.definition.layout.map(item=>({...item,widget:id(item.widget)}))}}
  throw conflict('业务看板不携带同步绑定，请在目标业务另行准备。')
 })
 const definitions=new Map(target.definitions.map(row=>[key(row.kind,row.definition.id),row]))
 for(const row of incoming){
  const previous=definitions.get(key(row.kind,row.definition.id))
  if(previous&&industryUpdateCanonical(previous)!==industryUpdateCanonical(row))throw conflict('目标业务已有不同的「'+row.definition.title+'」，请先核对修改，不能直接覆盖。')
  definitions.set(key(row.kind,row.definition.id),row)
 }
 const pages=new Map(target.pages.map(page=>[page.id,page]))
 for(const page of source.pages){
  const next=page.kind==='records'?{...page,id:id(page.id),objectType:objectId(page.objectType)}:{...page,id:id(page.id),dashboardId:id(page.dashboardId)}
  const previous=pages.get(next.id)
  if(previous&&industryUpdateCanonical(previous)!==industryUpdateCanonical(next))throw conflict('目标业务已有不同的页面，请先核对，不能直接覆盖。')
  pages.set(next.id,next)
 }
 return readBusinessConfigurationCandidateV2({...target,definitions:[...definitions.values()],pages:[...pages.values()],homePageId:target.homePageId??id(source.homePageId!)})
}
