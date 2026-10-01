import {isIndustryManifest} from './industry-manifest.ts'
import {compareIndustryUpdateCore,industryUpdateCanonical as canonical,type IndustryUpdateCoreDiff,type IndustryUpdateSide} from '@teloa/contract'
import type { MarketItem } from './market-preview.ts'
import type { IndustryLoadRecord } from './industry-load-api.ts'
import type { IndustryRoleInstance } from './industry-role-api.ts'
import type { PreviewTask } from './task-preview.ts'
import type { ContinuousPlan } from './continuous-preview.ts'
/** 比较所需的页面外事实：持久化的岗位实例（真实岗位由它带出）与本人的任务、计划。加载记录由调用方按身份给出。 */
export type IndustryUpdateContext={industryRoles:readonly IndustryRoleInstance[];tasks:readonly PreviewTask[];plans:readonly ContinuousPlan[]}
import { inspectIndustryContent, type IndustryInspection } from './industry-content.ts'
export type IndustryResourceDiff=IndustryUpdateCoreDiff['resources'][number]&{before:IndustryInspection|undefined;after:IndustryInspection|undefined}
export type IndustryLinkChange=IndustryUpdateCoreDiff['relationChanges'][number]
/**
 * `id` 是加载项身份（升级选择就按它记），`roleId` 是真实岗位身份（打开岗位与关联工作按它找）。
 * `kindChanged` 表示候选模板改了这个岗位的身份类型：已建立的岗位不能变更身份类型，因此不能采用模板定义。
 */
export type IndustryLocalRole={id:string;roleId:string|undefined;name:string;fields:string[];state:string;kindChanged:boolean}
export type IndustryUpdateDiff=Omit<IndustryUpdateCoreDiff,'resources'>&{resources:IndustryResourceDiff[];localRoles:IndustryLocalRole[];tasks:PreviewTask[];plans:ContinuousPlan[];blockers:string[];pending:string[];sameContent:boolean}
/** 页面读到的固定内容切面；比较规则本身在 contract，客户端与服务端共用同一份。 */
const side=(item:MarketItem):IndustryUpdateSide=>{
 const manifest=item.manifest,content=item.packageContent!
 if(!isIndustryManifest(manifest))throw Error('比较前需读取两份完整行业模板。')
 return {manifest,manifestPath:content.manifestPath,files:content.files,...(content.resolved?{resolved:content.resolved}:{})}
}
/**
 * 比较固定模板基线与候选，空间实例只读，不覆盖本地配置或历史快照。
 * `load` 是宿主里的持久化加载记录：基线必须正是它固定的那份内容（内容身份与摘要都对得上）。
 */
export function compareIndustryUpdate(context:IndustryUpdateContext,load:IndustryLoadRecord,baseline:MarketItem,candidate:MarketItem):IndustryUpdateDiff{
 const before=baseline.manifest,after=candidate.manifest
 if(load.contentId!==baseline.contentStorage?.contentId||load.contentHash!==baseline.packageContent?.hash)throw Error('加载基线不存在或内容不匹配。')
 if(!isIndustryManifest(before)||!isIndustryManifest(after)||!candidate.packageContent)throw Error('比较前需读取两份完整行业模板。')
 if(before.id!==after.id||before.domain!==after.domain||before.scope!==after.scope)throw Error('模板身份、行业定位或业务范围不同，不能作为同一模板更新。')
 const core=compareIndustryUpdateCore(side(baseline),side(candidate))
 const oldInspections=new Map(inspectIndustryContent(before,baseline.packageContent).map(row=>[row.id,row]))
 const newInspections=new Map(inspectIndustryContent(after,candidate.packageContent).map(row=>[row.id,row]))
 const resources=core.resources.map((row):IndustryResourceDiff=>({...row,before:oldInspections.get(row.id),after:newInspections.get(row.id)}))
 // 本地修改按「实例化当时冻结的那份定义」比对真实岗位：空间范围恒为本加载的空间，能力声明恒为空，
 // 知识恒为岗位实例记下的那几份资料——这三项由加载现场决定，与服务端 `IndustryRoleService` 的构造一致。
 const localRoles=load.items.filter(item=>item.kind==='role').flatMap((item):IndustryLocalRole[]=>{
  const definition=oldInspections.get(item.localId)?.definition
  if(definition?.kind!=='role')return []
  const next=newInspections.get(item.localId)?.definition
  const kindChanged=next?.kind==='role'&&next.fields.kind!==definition.fields.kind
  const instance=context.industryRoles.find(row=>row.loadId===load.id&&row.itemInstanceId===item.instanceId)
  const role=instance?.role
  if(!instance||!role)return [{id:item.instanceId,roleId:undefined,name:item.title,fields:['missing'],state:'missing',kindChanged}]
  const expected={...definition.fields,scopes:[load.space.scope],skills:[],knowledge:instance.knowledge.map(row=>row.resourceId)}
  const fields=Object.entries(expected).filter(([key,value])=>canonical(value)!==canonical(role[key as keyof typeof role])).map(([key])=>key)
  return [{id:item.instanceId,roleId:role.id,name:role.name,fields,state:role.state,kindChanged}]
 })
 const roleIds=new Set(localRoles.flatMap(row=>row.roleId?[row.roleId]:[])),pending:string[]=[]
 const blocked=core.kindChanges.map(row=>row.title+'：同一资源 ID 类型变化（'+row.before+' 改为 '+row.after+'），需使用新资源 ID 并单独安排迁移。')
 for(const resource of after.resources){
  const inspection=newInspections.get(resource.id)!
  if(resource.required&&['invalid','missing'].includes(inspection.state))blocked.push(resource.title+'：'+inspection.message)
  else if(inspection.state!=='parsed')pending.push(resource.title+'：'+inspection.message)
 }
 return {resources,relationChanges:core.relationChanges,entrypointChanges:core.entrypointChanges,kindChanges:core.kindChanges,relationsChanged:core.relationsChanged,entrypointsChanged:core.entrypointsChanged,positioningChanged:core.positioningChanged,localRoles,
 tasks:context.tasks.filter(task=>task.industrySource?.loadId===load.id||roleIds.has(task.assigneeId)),plans:context.plans.filter(plan=>plan.template?.industry?.loadId===load.id||roleIds.has(plan.fields.roleId)),blockers:blocked,pending,sameContent:load.contentHash===candidate.packageContent.hash}
}
