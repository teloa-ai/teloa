import {WorkError,isRecord,readScheduleTrigger,taskInput} from '@teloa/contract'
import type {IndustryPlanSnapshot,IndustryPlanRecord} from '@teloa/backend'
import {readIndustryWorkSnapshot} from './industry-tasks.ts'
import {readPlanResponse} from './plans.ts'
type Ports={preview:(owner:string,input:unknown)=>Promise<unknown>;create:(owner:string,input:unknown)=>Promise<unknown>;source:(owner:string,input:unknown)=>Promise<unknown>;list:(owner:string,input:unknown)=>Promise<unknown>}
export const industryPlanEndpoints=['industry-plans/preview','industry-plans/create','industry-plans/source','industry-plans/list'] as const
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim()&&v.length<=max
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const local=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(v)
const semver=(v:unknown)=>text(v,80)&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v)
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v
const notificationPolicy=(v:unknown):v is 'always'|'attention'|'failure'|'silent'=>typeof v==='string'&&['always','attention','failure','silent'].includes(v)
const invalid=()=>new WorkError('teloa/invalid-host-response','行业计划回包的固定来源或计划身份不一致。')
const exact=(v:unknown,keys:string[])=>{if(!isRecord(v)||Object.keys(v).some(key=>!keys.includes(key)))throw invalid();return v}
const snapshotKeys=['loadId','itemInstanceId','itemLocalId','contentId','contentHash','planVersion','planFileHash','title','work','dataScope','trigger','scope']
function schedule(v:unknown){try{return readScheduleTrigger(v)}catch{throw invalid()}}
function snapshot(v:unknown,extras:string[]=[]):IndustryPlanSnapshot{
 const row=exact(v,[...snapshotKeys,...extras])
 if(!uuid(row.loadId)||!uuid(row.itemInstanceId)||!local(row.itemLocalId)||!uuid(row.contentId)||!hash(row.contentHash)||!semver(row.planVersion)||!hash(row.planFileHash)||!text(row.title,120)||!text(row.dataScope,8000)||!text(row.scope,80))throw invalid()
 schedule(row.trigger);const work=readIndustryWorkSnapshot(row.work)
 if(work.loadId!==row.loadId||work.scope!==row.scope||work.contentId!==row.contentId||work.contentHash!==row.contentHash||work.itemInstanceId===row.itemInstanceId)throw invalid()
 return row as unknown as IndustryPlanSnapshot
}
function record(v:unknown,owner:string,requirePolicy=false):IndustryPlanRecord{
 const row=snapshot(v,['planId','ownerId','requestId','goal','delivery','notificationPolicy','createdRole','createdAt','selectedTrigger']) as IndustryPlanRecord
 const hasPolicy=Object.hasOwn(row,'notificationPolicy')
 if(!uuid(row.planId)||row.ownerId!==owner||!uuid(row.requestId)||!text(row.goal,8000)||!text(row.delivery,8000)||(hasPolicy?!notificationPolicy(row.notificationPolicy):requirePolicy)||!stamp(row.createdAt))throw invalid()
 const role=exact(row.createdRole,['roleId','roleVersion']);if(!uuid(role.roleId)||!integer(role.roleVersion))throw invalid();schedule(row.selectedTrigger);return row
}
export function createIndustryPlansHandler(owner:string,get:()=>Promise<Ports>){
 return async(method:string,payload:unknown):Promise<unknown>=>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  if(method==='industry-plans/list'){
   const input=taskInput(payload,['loadId']);if(input.loadId!==undefined&&!uuid(input.loadId))throw new WorkError('teloa/invalid-input','加载身份不正确。')
   const response=exact(await(await get()).list(owner,payload),['items']);if(!Array.isArray(response.items))throw invalid();const items=response.items.map(item=>record(item,owner)),ids=new Set<string>(),requests=new Set<string>()
   for(const item of items){if(input.loadId!==undefined&&item.loadId.toLowerCase()!==(input.loadId as string).toLowerCase()||ids.has(item.planId.toLowerCase())||requests.has(item.requestId.toLowerCase()))throw invalid();ids.add(item.planId.toLowerCase());requests.add(item.requestId.toLowerCase())}return {items}
  }
  if(method==='industry-plans/source'){
   const input=taskInput(payload,['planId']);if(!uuid(input.planId))throw new WorkError('teloa/invalid-input','需要真实计划身份。')
   const response=await(await get()).source(owner,payload);if(response===null)return null;const result=record(response,owner);if(result.planId.toLowerCase()!==input.planId.toLowerCase())throw invalid();return result
  }
  if(method!=='industry-plans/preview'&&method!=='industry-plans/create')throw new WorkError('teloa/invalid-input','不支持的行业计划操作。')
  const input=taskInput(payload,method==='industry-plans/preview'?['loadId','itemInstanceId']:['requestId','loadId','itemInstanceId','goal','delivery','notificationPolicy','trigger','roleId','expectedRoleVersion'])
  if(!uuid(input.loadId)||!uuid(input.itemInstanceId))throw new WorkError('teloa/invalid-input','需要真实行业加载项身份。')
  if(method==='industry-plans/preview'){
   const result=snapshot(await(await get()).preview(owner,payload));if(result.loadId.toLowerCase()!==input.loadId.toLowerCase()||result.itemInstanceId.toLowerCase()!==input.itemInstanceId.toLowerCase())throw invalid();return result
  }
  if(!uuid(input.requestId)||!uuid(input.roleId)||!integer(input.expectedRoleVersion)||typeof input.goal!=='string'||!input.goal.trim()||input.goal.length>8000||typeof input.delivery!=='string'||!input.delivery.trim()||input.delivery.length>8000||!notificationPolicy(input.notificationPolicy))throw new WorkError('teloa/invalid-input','计划目标、交付、通知策略和负责员工不完整。')
  let trigger:ReturnType<typeof readScheduleTrigger>
  try{trigger=readScheduleTrigger(input.trigger)}catch{throw new WorkError('teloa/invalid-input','日程配置无效。')}
  const response=exact(await(await get()).create(owner,payload),['plan','source']),plan=readPlanResponse(response.plan,owner),source=record(response.source,owner,true)
  if(source.loadId.toLowerCase()!==input.loadId.toLowerCase()||source.itemInstanceId.toLowerCase()!==input.itemInstanceId.toLowerCase()||source.requestId.toLowerCase()!==input.requestId.toLowerCase()||source.goal!==input.goal.trim()||source.delivery!==input.delivery.trim()||source.notificationPolicy!==input.notificationPolicy||source.createdRole.roleId.toLowerCase()!==input.roleId.toLowerCase()||source.createdRole.roleVersion!==input.expectedRoleVersion||JSON.stringify(schedule(source.selectedTrigger))!==JSON.stringify(trigger))throw invalid()
  const fixed=exact(plan.source,['kind','contentId','contentHash','resourceId','resourceVersion'])
  if(plan.id!==source.planId||plan.scope!==source.scope||plan.title!==source.title||plan.goal!==source.goal||plan.delivery!==source.delivery||plan.dataScope!==source.dataScope||plan.notificationPolicy!==source.notificationPolicy||plan.roleId!==source.createdRole.roleId||plan.roleVersion!==source.createdRole.roleVersion||JSON.stringify(schedule(plan.trigger))!==JSON.stringify(schedule(source.selectedTrigger))||fixed.kind!=='market-content'||fixed.contentId!==source.contentId||fixed.contentHash!==source.contentHash||fixed.resourceId!==source.itemLocalId||fixed.resourceVersion!==source.planVersion)throw invalid()
  return {plan,source}
 }
}
