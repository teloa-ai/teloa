import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {industryUpdateCanonical} from './industry-update-compare.ts'
import {businessDefinitionCanonicalBody} from './business-definitions.ts'
import type {BusinessWidgetDefinition,BusinessDashboardDefinition} from './business-dashboards.ts'
import type {BusinessSourceMappingDefinition} from './business-source-mapping.ts'
import {readBusinessConfigurationCandidate,readBusinessConfigurationManifest,readBusinessConfigurationPatch,businessConfigurationFormat,businessConfigurationLimits,type BusinessConfigurationCandidate,type BusinessConfigurationManifest,type BusinessConfigurationPatch} from './business-configuration.ts'
import {businessObjectTypeV2LegacyShape,readBusinessObjectTypeDefinitionV2,type BusinessObjectTypeDefinitionV2} from './business-definitions-v2.ts'
import {assertBusinessViewV2References,businessViewV2LegacyShape,readBusinessViewDefinitionVersioned,type BusinessViewDefinitionVersioned} from './business-views-v2.ts'

export const businessConfigurationFormatV2='teloa.business-configuration/v2' as const
export type BusinessConfigurationCandidateDefinitionV2=
 |{kind:'object-type';definition:BusinessObjectTypeDefinitionV2}
 |{kind:'view';definition:BusinessViewDefinitionVersioned}
 |{kind:'source-mapping';definition:BusinessSourceMappingDefinition}
 |{kind:'widget';definition:BusinessWidgetDefinition}
 |{kind:'dashboard';definition:BusinessDashboardDefinition}
export type BusinessConfigurationCandidateV2=Omit<BusinessConfigurationCandidate,'format'|'definitions'>&{
 format:typeof businessConfigurationFormatV2
 definitions:BusinessConfigurationCandidateDefinitionV2[]
}
export type BusinessConfigurationManifestV2=Omit<BusinessConfigurationManifest,'format'>&{format:typeof businessConfigurationFormatV2}
export type BusinessConfigurationPatchV2=Omit<BusinessConfigurationPatch,'upsertDefinitions'>&{upsertDefinitions?:BusinessConfigurationCandidateDefinitionV2[]}

const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
const unknownFormat=()=>bad('业务配置格式版本不支持。')

function checkReferences(candidate:BusinessConfigurationCandidateV2):void{
 const objects=new Map(candidate.definitions.filter(item=>item.kind==='object-type').map(item=>[item.definition.id,item.definition]))
 const views=new Map(candidate.definitions.filter(item=>item.kind==='view').map(item=>[item.definition.id,item.definition]))
 const widgets=new Map(candidate.definitions.filter(item=>item.kind==='widget').map(item=>[item.definition.id,item.definition]))
 const sources=new Set(candidate.sources.map(item=>item.sourceId))
 const hasRichFields=[...objects.values()].some(object=>object.fields.some(field=>'format' in field))
 for(const object of objects.values())if(!sources.has(object.sourceId))throw bad('对象类型引用的本地记录来源不存在。')
 for(const view of views.values()){
  const object=objects.get(view.objectType)
  if(!object)throw bad('视图引用的对象类型不存在。')
  assertBusinessViewV2References(view,object)
 }
 for(const widget of widgets.values()){
  // 旧 SQL 组件没有富字段类型语义；未接入官方安全解析前不推断 SQL 是否引用富字段。
  if(hasRichFields&&widget.query!==undefined)throw bad('富字段配置暂不支持 SQL 组件。')
  if(widget.viewRef&&!views.has(widget.viewRef))throw bad('组件引用的视图不存在。')
  if(widget.drilldown){
   const object=objects.get(widget.drilldown.objectType)
   if(!object)throw bad('组件下钻的对象类型不存在。')
   if(widget.drilldown.match){
    const field=object.fields.find(item=>item.name===widget.drilldown!.match!.field)
    if(!field||'format' in field)throw bad('组件下钻字段不存在或尚不支持富字段。')
   }
  }
 }
 for(const item of candidate.definitions)if(item.kind==='dashboard'){
  for(const widget of item.definition.widgets)if(!widgets.has(widget))throw bad('看板引用的组件不存在。')
 }
 for(const page of candidate.pages)if(page.kind==='records'){
  const object=objects.get(page.objectType)
  if(!object||page.fields.some(name=>!object.fields.some(field=>field.name===name)))throw bad('记录页引用的对象类型或字段不存在。')
 }
}

/** 与 v1 类型分开，旧生产调用继续严格拒收 v2。 */
export function readBusinessConfigurationCandidateV2(value:unknown):BusinessConfigurationCandidateV2{
 if(!isRecord(value)||value.format!==businessConfigurationFormatV2||!Array.isArray(value.definitions))throw unknownFormat()
 const objects=new Map<number,BusinessObjectTypeDefinitionV2>()
 const views=new Map<number,BusinessViewDefinitionVersioned>()
 const validationDefinitions=value.definitions.map((item,index)=>{
  if(isRecord(item)&&item.kind==='view'){
   const definition=readBusinessViewDefinitionVersioned(item.definition)
   businessDefinitionCanonicalBody(definition)
   views.set(index,definition)
   return {...item,definition:definition.format==='teloa.business-view/v2'?businessViewV2LegacyShape(definition):definition}
  }
  if(!isRecord(item)||item.kind!=='object-type')return item
  const definition=readBusinessObjectTypeDefinitionV2(item.definition)
  businessDefinitionCanonicalBody(definition)
  objects.set(index,definition)
  return {...item,definition:businessObjectTypeV2LegacyShape(definition)}
 })
 const legacy=readBusinessConfigurationCandidate({...value,format:businessConfigurationFormat,definitions:validationDefinitions})
 const definitions=legacy.definitions.map((item,index)=>objects.has(index)?{kind:'object-type' as const,definition:objects.get(index)!}:views.has(index)?{kind:'view' as const,definition:views.get(index)!}:item) as BusinessConfigurationCandidateDefinitionV2[]
 const candidate:BusinessConfigurationCandidateV2={...legacy,format:businessConfigurationFormatV2,definitions}
 if(new TextEncoder().encode(industryUpdateCanonical(candidate)).byteLength>businessConfigurationLimits.canonicalBytes)throw bad('配置规范 JSON 超过 2 MiB。')
 checkReferences(candidate)
 return candidate
}

export function readBusinessConfigurationManifestV2(value:unknown):BusinessConfigurationManifestV2{
 if(!isRecord(value)||value.format!==businessConfigurationFormatV2)throw unknownFormat()
 const legacy=readBusinessConfigurationManifest({...value,format:businessConfigurationFormat})
 return {...legacy,format:businessConfigurationFormatV2}
}

/** patch 自身无 format；调用方必须传入草案格式，不能按字段形状猜版本。 */
export function readBusinessConfigurationPatchV2(value:unknown):BusinessConfigurationPatchV2{
 const objects=new Map<number,BusinessObjectTypeDefinitionV2>()
 const views=new Map<number,BusinessViewDefinitionVersioned>()
 let validation:unknown=value
 if(isRecord(value)&&Array.isArray(value.upsertDefinitions)){
  const definitions=value.upsertDefinitions.map((item,index)=>{
   if(isRecord(item)&&item.kind==='view'){
    const definition=readBusinessViewDefinitionVersioned(item.definition)
    businessDefinitionCanonicalBody(definition)
    views.set(index,definition)
    return {...item,definition:definition.format==='teloa.business-view/v2'?businessViewV2LegacyShape(definition):definition}
   }
   if(!isRecord(item)||item.kind!=='object-type')return item
   const definition=readBusinessObjectTypeDefinitionV2(item.definition)
   businessDefinitionCanonicalBody(definition)
   objects.set(index,definition)
   return {...item,definition:businessObjectTypeV2LegacyShape(definition)}
  })
  validation={...value,upsertDefinitions:definitions}
 }
 const {upsertDefinitions:oldUpserts,...rest}=readBusinessConfigurationPatch(validation)
 const upsertDefinitions=oldUpserts?.map((item,index)=>objects.has(index)?{kind:'object-type' as const,definition:objects.get(index)!}:views.has(index)?{kind:'view' as const,definition:views.get(index)!}:item as BusinessConfigurationCandidateDefinitionV2)
 const patch:BusinessConfigurationPatchV2={...rest,...(upsertDefinitions===undefined?{}:{upsertDefinitions})}
 if(new TextEncoder().encode(industryUpdateCanonical(patch)).byteLength>businessConfigurationLimits.canonicalBytes)throw bad('配置规范 JSON 超过 2 MiB。')
 return patch
}

export function readBusinessConfigurationPatchVersioned(value:unknown,format:string):BusinessConfigurationPatch|BusinessConfigurationPatchV2{
 if(format===businessConfigurationFormat)return readBusinessConfigurationPatch(value)
 if(format===businessConfigurationFormatV2)return readBusinessConfigurationPatchV2(value)
 throw unknownFormat()
}

export function readBusinessConfigurationCandidateVersioned(value:unknown):BusinessConfigurationCandidate|BusinessConfigurationCandidateV2{
 if(!isRecord(value))throw unknownFormat()
 if(value.format===businessConfigurationFormat)return readBusinessConfigurationCandidate(value)
 if(value.format===businessConfigurationFormatV2)return readBusinessConfigurationCandidateV2(value)
 throw unknownFormat()
}

export function readBusinessConfigurationManifestVersioned(value:unknown):BusinessConfigurationManifest|BusinessConfigurationManifestV2{
 if(!isRecord(value))throw unknownFormat()
 if(value.format===businessConfigurationFormat)return readBusinessConfigurationManifest(value)
 if(value.format===businessConfigurationFormatV2)return readBusinessConfigurationManifestV2(value)
 throw unknownFormat()
}
