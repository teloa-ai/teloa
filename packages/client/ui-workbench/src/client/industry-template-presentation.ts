import type {LocalizedMetadataResolution} from '@teloa/contract'
import type {IndustryInspection} from './industry-content.js'
import type {IndustryManifest,IndustryResource} from './industry-manifest.js'
import {resolveMarketLocalizedMetadata} from './market-locale-metadata.ts'

export type IndustryInspectionPresentation={label:string;tone:'neutral'|'ready'|'pending'|'warning'}
export type IndustryResourceDestination={destination:string;count:number}
export type LocalizedIndustryTemplateMetadata={title:LocalizedMetadataResolution;description:LocalizedMetadataResolution}

/**
 * 模板资源到用户可见落点的唯一真源。市场详情和加载确认都从这里读，避免同一种资源在两处被说成
 * 不同去处；三类业务声明共同落到业务台账，而不是被误归入 Skill 或资料。
 */
export const industryResourceDestinationGroups:readonly {key:string;kinds:readonly IndustryResource['kind'][]}[]=[
 {key:'market.industry.destination.roles',kinds:['role']},
 {key:'market.industry.destination.knowledge',kinds:['knowledge']},
 {key:'market.industry.destination.capabilities',kinds:['skill','mcp']},
 {key:'market.industry.resource.plugin',kinds:['plugin']},
 {key:'market.industry.destination.tasks',kinds:['work-template']},
 {key:'market.industry.destination.automation',kinds:['plan']},
 {key:'market.industry.destination.data',kinds:['data-source']},
 {key:'market.industry.destination.execution',kinds:['execution-tool']},
 {key:'market.industry.destination.business',kinds:['object-type','business-view','business-action','business-configuration']},
]

/** 只有声明与来源身份的包不触发安装、授权或外联，因此加载前要把这个边界讲清楚。 */
export function isBusinessDeclarationPackage(resources:readonly Pick<IndustryResource,'kind'>[]):boolean{
 return resources.length>0&&resources.every(resource=>['object-type','business-view','business-action','data-source'].includes(resource.kind))
}

const destinationByKind:Partial<Record<IndustryResource['kind'],string>>={
  role:'员工',
  knowledge:'资料',
  skill:'技能',
  mcp:'技能',
  plugin:'市场 · 扩展',
  'data-source':'业务空间 · 数据',
  'execution-tool':'业务空间 · 执行',
  'work-template':'任务',
  plan:'自动化',
  'object-type':'业务空间 · 台账',
  'business-view':'业务空间 · 台账',
  'business-action':'业务空间 · 台账',
  'business-configuration':'业务空间 · 台账',
}
const resourceDestinations=['员工','资料','技能','市场 · 扩展','任务','自动化','业务空间 · 数据','业务空间 · 执行','业务空间 · 台账'] as const

export function describeIndustryInspection(inspection:Pick<IndustryInspection,'state'|'message'>|undefined):IndustryInspectionPresentation{
  if(!inspection)return {label:'内容待读取',tone:'neutral'}
  switch(inspection.state){
    case 'parsed':return {label:'内容可预览',tone:'ready'}
    case 'pending':return {label:'等待适配',tone:'pending'}
    case 'unresolved':return {label:'引用待核对',tone:'pending'}
    case 'missing':return {label:'缺少内容',tone:'warning'}
    case 'invalid':return {label:'内容有问题',tone:'warning'}
  }
}

export function describeIndustryResourceSource(source:IndustryResource['source']):string{
  return source.kind==='local'?'随模板提供':'引用公共资源 · v'+source.version
}

export function describeIndustryLoadTarget(mode:'new'|'existing',name:string,space:{name:string;version:number}|undefined){
  return mode==='new'
    ?{target:'新建工作空间「'+name.trim()+'」',effect:'登记模板资源与关联关系；员工、技能、连接和计划仍需逐项启用。'}
    :{target:'已有工作空间「'+(space?.name??'未选择')+'」'+(space?'· v'+space.version:''),effect:'把模板资源登记到当前空间；不会覆盖已有员工、任务或计划。'}
}

export function describeIndustryResourceDestinations(resources:readonly IndustryResource[],options:{includeEmpty?:boolean}={}):IndustryResourceDestination[]{
  const counts=new Map<string,number>()
  for(const resource of resources){
    const destination=destinationByKind[resource.kind]
    if(destination===undefined)continue
    counts.set(destination,(counts.get(destination)??0)+1)
  }
  return resourceDestinations.flatMap(destination=>counts.has(destination)||options.includeEmpty?[{destination,count:counts.get(destination)??0}]:[])
}

export function localizedIndustryTemplateMetadata(manifest:Pick<IndustryManifest,'title'|'description'|'localized'>,locale:string):LocalizedIndustryTemplateMetadata{
  return {
    title:resolveMarketLocalizedMetadata(manifest.localized?.title??{original:manifest.title,defaultLocale:'und',locales:{}},locale),
    description:resolveMarketLocalizedMetadata(manifest.localized?.description??{original:manifest.description,defaultLocale:'und',locales:{}},locale),
  }
}

export function localizedIndustryResourceTitle(resource:Pick<IndustryResource,'title'|'localized'>,locale:string):string{
  return resolveMarketLocalizedMetadata(resource.localized?.title??{original:resource.title,defaultLocale:'und',locales:{}},locale).value
}
