import {WorkError,isRecord,industryUpdateCanonical,readBusinessConfigurationCandidateV2,type BusinessConfigurationCandidateV2} from '@teloa/contract'
import type {BusinessConfigurationCandidate,BusinessObjectTypeDefinition,BusinessObjectTypeDefinitionV2,BusinessTemplateUpgradeImpact} from '@teloa/contract'
import {assertBusinessRecordFieldValue} from './business-record-values.ts'

type Configuration=BusinessConfigurationCandidate|BusinessConfigurationCandidateV2
type ImpactRecord={type:string;id:string;fields:readonly {label:string;value:string|undefined}[]}
/** 与配置采用的历史兼容守卫共享判据；只描述影响，不迁移记录或改变授权。 */
export function inspectBusinessTemplateUpgradeImpact(input:{current:Configuration|undefined;candidate:Configuration;records:readonly ImpactRecord[]}):BusinessTemplateUpgradeImpact{
 type ObjectType=BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2
 const objects=(configuration:Configuration|undefined)=>new Map((configuration?.definitions??[]).filter(row=>row.kind==='object-type').map(row=>[row.definition.id,row.definition as ObjectType]))
 const previous=objects(input.current),next=objects(input.candidate),issues=new Map<string,{row:BusinessTemplateUpgradeImpact['fields'][number];ids:Set<string>}>(),affected=new Set<string>()
 const add=(type:string,field:string,reason:BusinessTemplateUpgradeImpact['fields'][number]['reason'],records:readonly ImpactRecord[])=>{
  const key=JSON.stringify([type,field,reason]);let issue=issues.get(key)
  if(!issue){issue={row:{objectType:type,field,reason,affectedRecords:0},ids:new Set()};issues.set(key,issue)}
  for(const record of records){const id=JSON.stringify([type,record.id]);issue.ids.add(id);affected.add(id)}
 }
 for(const [type,old] of previous){
  const records=input.records.filter(record=>record.type===type),definition=next.get(type)
  if(!definition){add(type,'','removed-object',records);continue}
  if(old.sourceId!==definition.sourceId)add(type,'','changed-source',records)
  for(const field of old.fields){
   const changed=definition.fields.find(row=>row.name===field.name)
   if(!changed)add(type,field.name,'removed-field',records)
   else if(changed.type!==field.type||changed.from!==field.from||('referenceType' in changed?changed.referenceType:undefined)!==('referenceType' in field?field.referenceType:undefined))add(type,field.name,'changed-type',records)
   else if('values' in field&&field.values?.some(value=>!('values' in changed)||!changed.values?.includes(value)))add(type,field.name,'changed-rule',records)
  }
  for(const record of records)for(const field of definition.fields){try{assertBusinessRecordFieldValue(field,record.fields.find(row=>row.label===field.from)?.value)}catch{add(type,field.name,'invalid-existing-value',[record])}}
 }
 for(const record of input.records)if(!previous.has(record.type))add(record.type,'','removed-object',[record])
 return {blocked:affected.size>0,affectedRecords:affected.size,fields:[...issues.values()].map(issue=>({...issue.row,affectedRecords:issue.ids.size})),newSourceRequirements:input.candidate.definitions.filter(row=>row.kind==='source-mapping'&&!input.current?.definitions.some(old=>old.kind===row.kind&&old.definition.id===row.definition.id&&industryUpdateCanonical(old.definition)===industryUpdateCanonical(row.definition))).map(row=>row.definition.id)}
}

export type BusinessDashboardUpgradeChoice='keep-local'|'use-incoming'
export type BusinessDashboardUpgradeConflict={key:string;entity:'definition'|'page'|'home-page';id:string;kind?:string;baseline:unknown;current:unknown;incoming:unknown}
export type BusinessDashboardUpgradeMerge={configuration:BusinessConfigurationCandidateV2|null;conflicts:BusinessDashboardUpgradeConflict[];changed:string[]}
const invalid=(message:string)=>new WorkError('teloa/invalid-input',message)
const same=(left:unknown,right:unknown)=>industryUpdateCanonical(left)===industryUpdateCanonical(right)

/** 三份输入已映射到同一业务。仅合并声明实体，不读取、改写或删除业务记录。 */
export function mergeBusinessDashboardResourceUpgrade(input:{baseline:unknown;current:unknown;candidate:unknown;choices?:unknown}):BusinessDashboardUpgradeMerge{
 if(input.baseline===null||input.baseline===undefined||input.candidate===null||input.candidate===undefined)throw new WorkError('teloa/source-unavailable','看板原固定来源或新候选缺失，不能生成升级基线。')
 const baseline=readBusinessConfigurationCandidateV2(input.baseline),current=readBusinessConfigurationCandidateV2(input.current),candidate=readBusinessConfigurationCandidateV2(input.candidate)
 if(baseline.scope!==current.scope||candidate.scope!==current.scope)throw invalid('看板升级的基线、本地配置和候选必须属于同一目标业务。')
 const choices=input.choices??{}
 if(!isRecord(choices)||Object.values(choices).some(value=>value!=='keep-local'&&value!=='use-incoming'))throw invalid('看板冲突处理只能明确保留本地或采用新来源。')
 const conflicts:BusinessDashboardUpgradeConflict[]=[],conflictKeys=new Set<string>(),changed:string[]=[]
 const merge=<T>(key:string,entity:BusinessDashboardUpgradeConflict['entity'],id:string,base:T|undefined,local:T|undefined,incoming:T|undefined,kind?:string):T|undefined=>{
  let next:T|undefined
  if(same(local,base))next=incoming
  else if(same(incoming,base)||same(local,incoming))next=local
  else{
   conflictKeys.add(key)
   if(choices[key]==='keep-local')next=local
   else if(choices[key]==='use-incoming')next=incoming
   else{conflicts.push({key,entity,id,...(kind?{kind}:{}),baseline:structuredClone(base??null),current:structuredClone(local??null),incoming:structuredClone(incoming??null)});next=local}
  }
  if(!same(next,local))changed.push(key)
  return next
 }
 const definitions=(value:BusinessConfigurationCandidateV2)=>new Map(value.definitions.map(row=>[row.kind+':'+row.definition.id,row]))
 const baseDefinitions=definitions(baseline),localDefinitions=definitions(current),incomingDefinitions=definitions(candidate)
 const nextDefinitions:BusinessConfigurationCandidateV2['definitions']=[]
 for(const identity of new Set([...localDefinitions.keys(),...incomingDefinitions.keys(),...baseDefinitions.keys()])){
  const row=localDefinitions.get(identity)??incomingDefinitions.get(identity)??baseDefinitions.get(identity)!
  const merged=merge('definition:'+identity,'definition',row.definition.id,baseDefinitions.get(identity),localDefinitions.get(identity),incomingDefinitions.get(identity),row.kind)
  if(merged)nextDefinitions.push(merged)
 }
 const pages=(value:BusinessConfigurationCandidateV2)=>new Map(value.pages.map(row=>[row.id,row]))
 const basePages=pages(baseline),localPages=pages(current),incomingPages=pages(candidate),nextPages:BusinessConfigurationCandidateV2['pages']=[]
 for(const id of new Set([...localPages.keys(),...incomingPages.keys(),...basePages.keys()])){
  const merged=merge('page:'+id,'page',id,basePages.get(id),localPages.get(id),incomingPages.get(id))
  if(merged)nextPages.push(merged)
 }
 const homePageId=merge('metadata:homePageId','home-page','homePageId',baseline.homePageId,current.homePageId,candidate.homePageId)
 if(Object.keys(choices).some(key=>!conflictKeys.has(key)))throw invalid('看板冲突处理包含未知或已变化的实体，请重新核对升级差异。')
 if(conflicts.length)return {configuration:null,conflicts,changed}
 // 标题、范围和本地记录来源沿用目标业务；混合结果必须仍是完整闭合配置。
 const {homePageId:_,...target}=current
 const configuration=readBusinessConfigurationCandidateV2({...target,definitions:nextDefinitions,pages:nextPages,...(homePageId===undefined?{}:{homePageId})})
 return {configuration,conflicts,changed}
}
