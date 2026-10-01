import type { PlanSource } from './plan-api.ts'
import type { IndustryLoad } from './industry-load.ts'
import { collaborationScopes } from './collaboration-preview.ts'
import { sourceLabel, type MarketItem, type MarketState } from './market-preview.ts'
import type { PlanFields } from './continuous-preview.ts'

export type PlanTemplate={industry?:{loadId:string;resourceId:string;localId:string;version:string};key:string;itemId:string;templateId:string;title:string;version:string;scope:string;hash:string|null;example:boolean;source:string;author:string;license:string;description:string;requirements:string[];output:string;skills:{id:string;title:string;version:string}[]}
export type TemplatePlanSeed={template:PlanTemplate;fields:PlanFields;source?:PlanSource}

export function planTemplate(item:MarketItem):PlanTemplate{
  if(item.kind!=='template')throw Error('只有任务模板可以创建持续计划。')
  const manifest=item.manifest,example=item.source.kind==='builtin'&&!manifest&&!item.hash
  if(!example&&(!manifest||manifest.format!=='teloa.work-template/v1'||!item.hash||!/^[a-f0-9]{64}$/.test(item.hash)))throw Error('模板来源尚未解析并固定，请先读取清单。')
  if(manifest&&(manifest.version!==item.version||manifest.domain!==item.scope))throw Error('模板目录与原清单版本不一致，请重新核对来源。')
  const snapshot={itemId:item.id,templateId:manifest?.id||item.id,title:manifest?.title||item.title,version:manifest?.version||item.version,scope:manifest?.domain||item.scope,hash:item.hash||null,example,source:sourceLabel(item.source),author:item.author,license:item.license,description:manifest?.description||item.summary,requirements:[...((manifest?.format==='teloa.work-template/v1'?manifest.requirements:item.requirements))],output:(manifest?.format==='teloa.work-template/v1'?manifest.output:item.output),skills:manifest?.format==='teloa.work-template/v1'?manifest.skills.map(skill=>({...skill})):[]}
  // 语义比较键，不冒充第三方内容摘要；真实摘要只采用解析器读取原文所得的 hash。
  return {...snapshot,key:JSON.stringify(snapshot)}
}
export function templatePlanFields(template:PlanTemplate,scopes:Readonly<Record<string,string>>=collaborationScopes):PlanFields{
  if(!Object.hasOwn(scopes,template.scope))throw Error('模板所属业务尚未注册，请先配置该业务；不能自动改成通用。')
  return {title:template.title,scope:template.scope as PlanFields['scope'],goal:template.description,dataScope:'请按模板输入要求，填写本次获准资料与范围。',delivery:template.output,roleId:'',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}}
}
export function verifyPlanTemplate(expected:PlanTemplate,market?:MarketState,loads:readonly IndustryLoad[]=[]):PlanTemplate{
  if(expected.industry){
    const current=industryPlanTemplate(loads,expected.industry.loadId,expected.industry.resourceId)
    if(JSON.stringify(current)!==JSON.stringify(expected))throw Error('行业模板来源或内容已变化，请重新核对。')
    return current
  }
  const item=market?.items.find(item=>item.id===expected.itemId)
  if(!item)throw Error('原模板来源不存在，请返回市场重新核对。')
  const current=planTemplate(item)
  if(current.key!==expected.key||JSON.stringify(current)!==JSON.stringify(expected))throw Error('模板来源或内容已变化，未保存旧表单；请返回市场重新选择。')
  return current
}

export function industryPlanTemplate(loads:readonly IndustryLoad[],loadId:string,resourceId:string):PlanTemplate{
  const load=loads.find(row=>row.id===loadId),resource=load?.resources.find(row=>row.id===resourceId),definition=resource?.inspection.definition
  if(!load||!resource||!definition||(!load.entrypoints.includes(resourceId)&&definition.kind!=='plan')||(definition.kind!=='work-template'&&definition.kind!=='plan'))throw Error('行业任务模板来源不存在或尚未解析。')
  const workDefinition=definition.kind==='plan'?load.resources.find(row=>row.localId===definition.workTemplate)?.inspection.definition:definition
  if(workDefinition?.kind!=='work-template')throw Error('计划引用的任务模板不存在或未解析。')
  const work=workDefinition.manifest
  const snapshot={industry:{loadId,resourceId,localId:resource.localId,version:resource.version},itemId:load.itemId,templateId:work.id,title:work.title,version:work.version,scope:load.spaceId,hash:load.sourceHash,example:false,source:load.title+' · '+load.version,author:'行业模板',license:'以原模板许可为准',description:work.description,requirements:[...work.requirements],output:work.output,skills:work.skills.map(row=>({...row}))}
  return {...snapshot,key:JSON.stringify(snapshot)}
}

/** 只使用已保存且已读取的内容身份，不从目录ID猜测数据库身份。 */
export function fixedPlanSource(template:PlanTemplate,item:MarketItem):Extract<PlanSource,{kind:'market-content'}>{
  const contentHash=template.industry?item.packageContent?.hash:item.hash
  if(item.id!==template.itemId||!template.hash||contentHash!==template.hash)throw Error('计划模板与市场来源不一致，请重新核对。')
  if(template.example||!item.contentStorage?.loaded)throw Error('模板尚未固定保存，请先保存并读取原始内容。')
  return {kind:'market-content',contentId:item.contentStorage.contentId,contentHash:template.hash,resourceId:template.industry?.localId??template.templateId,resourceVersion:template.industry?.version??template.version}
}
