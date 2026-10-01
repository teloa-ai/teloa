import {WorkError,isRecord,readScheduleTrigger,taskDefinition} from '@teloa/contract'

export const planEndpoints=['plans/list','plans/get','plans/create','plans/change','plans/trigger'] as const
export type PlanOperations={
 list:(owner:string,input:unknown)=>Promise<unknown>
 get:(owner:string,input:unknown)=>Promise<unknown>
 create:(owner:string,input:unknown)=>Promise<unknown>
 change:(owner:string,input:unknown)=>Promise<unknown>
 trigger?:(owner:string,input:unknown,signal:AbortSignal)=>Promise<unknown>
}

const invalid=()=>new WorkError('teloa/invalid-input','持续计划传输格式不正确或包含未知字段。')
const invalidResponse=()=>new WorkError('teloa/invalid-host-response','持续计划服务返回了无效或跨本人的结果。')
const object=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}
const response=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalidResponse();return value}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const stableId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const semver=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const timestamp=(value:unknown):value is string=>{if(typeof value!=='string')return false;const parsed=new Date(value);return Number.isFinite(parsed.getTime())&&parsed.toISOString()===value}
const notificationPolicy=(value:unknown):value is 'always'|'attention'|'failure'|'silent'=>typeof value==='string'&&['always','attention','failure','silent'].includes(value)

/**
 * 计划来源三种：manual / market-content / system-digest（Auto Dream 系统计划，与后端 plans.ts 的 source() 同口径）。
 * system-digest 只在读回包（stored=true）时接受——它由服务端随员工在岗自动建出，客户端不得经 plans/create 提交。
 */
function source(value:unknown,stored:boolean):void{
 const row=object(value,['kind','contentId','contentHash','resourceId','resourceVersion','roleId'])
 if(row.kind==='manual'){if(Object.keys(row).length!==1)throw invalid();return}
 if(row.kind==='system-digest'){if(!stored||Object.keys(row).length!==2||!uuid(row.roleId))throw invalid();return}
 if(row.kind!=='market-content'||Object.keys(row).length!==5||!uuid(row.contentId)||!hash(row.contentHash)||!stableId(row.resourceId)||!semver(row.resourceVersion))throw invalid()
}
function fields(value:unknown,creating:boolean):void{
 const keys=['title','goal','scope','dataScope','delivery','roleId','trigger','notificationPolicy',...(creating?['expectedRoleVersion']:[])]
 const row=object(value,keys)
 try{
  const normalized=taskDefinition({title:row.title,goal:row.goal,scope:row.scope})
  if(normalized.title!==row.title||normalized.goal!==row.goal||normalized.scope!==row.scope)throw Error()
  readScheduleTrigger(row.trigger)
 }catch{throw invalid()}
 if(!text(row.dataScope,8000)||row.dataScope.trim()!==row.dataScope||!text(row.delivery,8000)||row.delivery.trim()!==row.delivery||!uuid(row.roleId)||creating&&!positive(row.expectedRoleVersion)||creating&&!notificationPolicy(row.notificationPolicy)||!creating&&row.notificationPolicy!==undefined&&!notificationPolicy(row.notificationPolicy))throw invalid()
}
function createInput(value:unknown):void{
 const row=object(value,['requestId','fields','source'])
 if(!uuid(row.requestId))throw invalid();fields(row.fields,true);source(row.source,false)
}
function updateFields(value:unknown):void{
 const row=object(value,['title','goal','dataScope','delivery','trigger','notificationPolicy'])
 try{taskDefinition({title:row.title,goal:row.goal,scope:'general'});readScheduleTrigger(row.trigger)}catch{throw invalid()}
 if(!text(row.dataScope,8000)||row.dataScope.trim()!==row.dataScope||!text(row.delivery,8000)||row.delivery.trim()!==row.delivery||!notificationPolicy(row.notificationPolicy))throw invalid()
}
function changeInput(value:unknown):void{
 const row=object(value,['planId','requestId','expectedVersion','expectedConfigVersion','action','note','fields'])
 if(!uuid(row.planId)||!uuid(row.requestId)||!positive(row.expectedVersion)||!['enable','pause','archive','update'].includes(String(row.action)))throw invalid()
 if(row.action==='archive'){if(!text(row.note,4000))throw invalid()}
 else if(Object.hasOwn(row,'note'))throw invalid()
 if(row.action==='update'){if(!positive(row.expectedConfigVersion))throw invalid();updateFields(row.fields)}
 else if(Object.hasOwn(row,'expectedConfigVersion')||Object.hasOwn(row,'fields'))throw invalid()
}
function triggerInput(value:unknown):void{
 const row=object(value,['planId','requestId','expectedVersion','expectedConfigVersion','now'])
 if(!uuid(row.planId)||!uuid(row.requestId)||!positive(row.expectedVersion)||!positive(row.expectedConfigVersion)||!timestamp(row.now))throw invalid()
}
function plan(value:unknown,owner:string):Record<string,unknown>{
 try{
  const row=object(value,['id','ownerId','title','goal','scope','dataScope','delivery','roleId','roleVersion','trigger','notificationPolicy','source','version','configVersion','state','archivedReason','archivedAt','createdAt','updatedAt'])
  fields({title:row.title,goal:row.goal,scope:row.scope,dataScope:row.dataScope,delivery:row.delivery,roleId:row.roleId,trigger:row.trigger,...(Object.hasOwn(row,'notificationPolicy')?{notificationPolicy:row.notificationPolicy}:{})},false);source(row.source,true)
  if(!uuid(row.id)||row.ownerId!==owner||!positive(row.roleVersion)||!positive(row.version)||!positive(row.configVersion)||!['paused','active','archived'].includes(String(row.state))||!timestamp(row.createdAt)||!timestamp(row.updatedAt))throw Error()
  const archived=row.state==='archived'
  if(archived?(!text(row.archivedReason,4000)||!timestamp(row.archivedAt)):(row.archivedReason!==null||row.archivedAt!==null))throw Error()
  return row
 }catch{throw invalidResponse()}
}
/** 立即运行回包里的 task/run 是完整的任务与运行对象（后端原样回传），这里只取用到的字段做归属核对，多余键不算格式错误。 */
const pick=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value))throw invalidResponse();return Object.fromEntries(keys.map(key=>[key,value[key]]))}
function triggerResult(value:unknown,owner:string,request:Record<string,unknown>):Record<string,unknown>{
 try{
  const row=response(value,['occurrence','task','run']),occurrence=response(row.occurrence,['id','ownerId','planId','planVersion','configVersion','occurrenceId','scheduledAt','claimedAt','taskRequestId','fields','source','roleVersion','invalidated','taskRequest']),task=pick(row.task,['id','ownerId']),run=pick(row.run,['id','taskId'])
  if(occurrence.ownerId!==owner||occurrence.planId!==request.planId||occurrence.taskRequestId!==request.requestId||!uuid(occurrence.id)||!positive(occurrence.planVersion)||occurrence.planVersion!==request.expectedVersion||!positive(occurrence.configVersion)||occurrence.configVersion!==request.expectedConfigVersion||!uuid(task.id)||task.ownerId!==owner||!uuid(run.id)||run.taskId!==task.id)throw Error()
  return {planId:occurrence.planId,claimId:occurrence.id,taskId:task.id,runId:run.id}
 }catch{throw invalidResponse()}
}

/** 工作台 RPC 与已验证会话身份的计划工具共用；保存不代表计划已开始调度。 */
export function createPlanHandler(owner:string,get:()=>Promise<PlanOperations>){
 return async(endpoint:string,payload:unknown,signal=new AbortController().signal):Promise<unknown>=>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的宿主本人身份。')
  if(!planEndpoints.includes(endpoint as typeof planEndpoints[number]))throw new WorkError('teloa/not-found','未提供此持续计划接口。')
  if(endpoint==='plans/list')object(payload,[])
  else if(endpoint==='plans/get'){const row=object(payload,['planId']);if(!uuid(row.planId))throw invalid()}
  else if(endpoint==='plans/create')createInput(payload)
  else if(endpoint==='plans/trigger')triggerInput(payload)
  else changeInput(payload)
  const service=await get()
  if(endpoint==='plans/trigger'&&!service.trigger)throw new WorkError('teloa/dependency-unavailable','持续计划立即运行服务尚未接入。')
  const result=endpoint==='plans/list'?await service.list(owner,payload):endpoint==='plans/get'?await service.get(owner,payload):endpoint==='plans/create'?await service.create(owner,payload):endpoint==='plans/trigger'?await service.trigger!(owner,payload,signal):await service.change(owner,payload)
  if(endpoint==='plans/trigger')return triggerResult(result,owner,payload as Record<string,unknown>)
  if(endpoint!=='plans/list')return plan(result,owner)
  if(!Array.isArray(result))throw invalidResponse()
  const items=result.map(item=>plan(item,owner)),ids=items.map(item=>item.id)
  if(new Set(ids).size!==ids.length)throw invalidResponse()
  return items
 }
}

export {plan as readPlanResponse}
