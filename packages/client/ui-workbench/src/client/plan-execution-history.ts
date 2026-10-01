import {isRecord,workTaskStates,type WorkTask} from '@teloa/contract'

export type PlanExecutionHistoryCursor={claimedAt:string;claimId:string}
export type PlanExecutionHistoryItem={
 claimId:string
 planId:string
 occurrenceId:string
 planVersion:number
 configVersion:number
 notificationPolicy?:'always'|'attention'|'failure'|'silent'
 scheduledAt:string
 claimedAt:string
 task:null|{id:string;state:WorkTask['state']}
 run:null|{id:string;state:'prepared'|'submitting'|'accepted'|'active'|'ended'|'withdrawn'|'configuration_failed';sessionId:string;createdAt:string}
}
export type PlanExecutionHistoryPage={items:PlanExecutionHistoryItem[];errors?:Array<{claimId:string;code:'teloa/storage-corrupt'}>;cursor?:PlanExecutionHistoryCursor}
export type PlanExecutionHistoryReadOptions={limit:number;cursor?:PlanExecutionHistoryCursor}
type PlanExecutionDirectoryReadOptions=PlanExecutionHistoryReadOptions&{runState?:'prepared'|'submitting'|'accepted'|'active'|'ended'|'withdrawn'|'configuration_failed'|'not-started'}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const timestamp=(value:unknown):value is string=>{if(typeof value!=='string')return false;const parsed=new Date(value);return Number.isFinite(parsed.getTime())&&parsed.toISOString()===value}
const identity=(value:unknown):value is string=>typeof value==='string'&&value.trim()===value&&/^[-a-zA-Z0-9_:.\[\]/]{1,240}$/.test(value)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error();return value}
const notificationPolicy=(value:unknown):value is NonNullable<PlanExecutionHistoryItem['notificationPolicy']>=>typeof value==='string'&&['always','attention','failure','silent'].includes(value)

function readCursor(value:unknown):PlanExecutionHistoryCursor{
 const row=exact(value,['claimedAt','claimId'])
 if(!timestamp(row.claimedAt)||!uuid(row.claimId))throw Error()
 return {claimedAt:row.claimedAt,claimId:row.claimId}
}

function readItem(value:unknown,expectedPlanId?:string):PlanExecutionHistoryItem{
 const row=exact(value,['claimId','planId','occurrenceId','planVersion','configVersion','notificationPolicy','scheduledAt','claimedAt','task','run'])
 if(!uuid(row.claimId)||!uuid(row.planId)||expectedPlanId!==undefined&&row.planId!==expectedPlanId||!identity(row.occurrenceId)||!positive(row.planVersion)||!positive(row.configVersion)||row.configVersion>row.planVersion||row.notificationPolicy!==undefined&&!notificationPolicy(row.notificationPolicy)||!timestamp(row.scheduledAt)||!timestamp(row.claimedAt)||row.claimedAt<row.scheduledAt)throw Error()
 let task:PlanExecutionHistoryItem['task']=null
 if(row.task!==null){const candidate=exact(row.task,['id','state']);if(!uuid(candidate.id)||!workTaskStates.some(state=>state===candidate.state))throw Error();task={id:candidate.id,state:candidate.state as WorkTask['state']}}
 let run:PlanExecutionHistoryItem['run']=null
 if(row.run!==null){
  if(!task)throw Error()
  const candidate=exact(row.run,['id','state','sessionId','createdAt'])
  if(!uuid(candidate.id)||typeof candidate.state!=='string'||!['prepared','submitting','accepted','active','ended','withdrawn','configuration_failed'].includes(candidate.state)||!identity(candidate.sessionId)||!timestamp(candidate.createdAt))throw Error()
  run={id:candidate.id,state:candidate.state as NonNullable<PlanExecutionHistoryItem['run']>['state'],sessionId:candidate.sessionId,createdAt:candidate.createdAt}
 }
 return {claimId:row.claimId,planId:row.planId,occurrenceId:row.occurrenceId,planVersion:row.planVersion,configVersion:row.configVersion,...(row.notificationPolicy===undefined?{}:{notificationPolicy:row.notificationPolicy}),scheduledAt:row.scheduledAt,claimedAt:row.claimedAt,task,run}
}

/** 严格读取导航事实；不从状态生成结果、标题或业务完成含义。 */
export function readPlanExecutionHistoryPage(value:unknown,expectedPlanId:string,options?:PlanExecutionHistoryReadOptions):PlanExecutionHistoryPage{
 return readPage(value,expectedPlanId,options)
}

/** 跨计划目录只校验合法计划身份；本人边界由服务端查询强制。 */
export function readPlanExecutionDirectoryPage(value:unknown,options?:PlanExecutionDirectoryReadOptions):PlanExecutionHistoryPage{
 const page=readPage(value,undefined,options)
 if(options?.runState&&page.items.some(item=>options.runState==='not-started'?item.run!==null:item.run?.state!==options.runState))throw Error('持续计划执行历史格式不正确。')
 return page
}

function readPage(value:unknown,expectedPlanId:string|undefined,options?:PlanExecutionHistoryReadOptions):PlanExecutionHistoryPage{
 try{
  if(expectedPlanId!==undefined&&!uuid(expectedPlanId))throw Error()
  const row=exact(value,['items','errors','cursor'])
  if(!Array.isArray(row.items))throw Error()
  const items=row.items.map(value=>readItem(value,expectedPlanId)),identities=new Set(items.map(item=>item.claimId))
  if(identities.size!==items.length)throw Error()
  for(let index=1;index<items.length;index++)if(!before(items[index]!,items[index-1]!))throw Error()
  let errors:PlanExecutionHistoryPage['errors']
  if(row.errors!==undefined){
   if(!Array.isArray(row.errors))throw Error()
   errors=row.errors.map(value=>{const error=exact(value,['claimId','code']);if(!uuid(error.claimId)||error.code!=='teloa/storage-corrupt'||identities.has(error.claimId))throw Error();identities.add(error.claimId);return {claimId:error.claimId,code:'teloa/storage-corrupt'}})
  }
  const cursor=row.cursor===undefined?undefined:readCursor(row.cursor)
  if(cursor&&!identities.has(cursor.claimId)||cursor&&items.some(item=>item.claimId===cursor.claimId&&item.claimedAt!==cursor.claimedAt)||cursor&&items.some(item=>item.claimId===cursor.claimId)&&items.at(-1)?.claimId!==cursor.claimId)throw Error()
  if(cursor&&items.length&&cursor.claimId!==items.at(-1)!.claimId&&!before(cursor,items.at(-1)!))throw Error()
  if(cursor&&items.length+(errors?.length??0)===0)throw Error()
  if(options){
   if(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>50||items.length+(errors?.length??0)>options.limit)throw Error()
   if(options.cursor){const boundary=readCursor(options.cursor);if(items.some(item=>!before(item,boundary))||cursor&&!before(cursor,boundary))throw Error()}
  }
  return {items,...(errors?{errors}:{}),...(cursor?{cursor}:{})}
 }catch{throw Error('持续计划执行历史格式不正确。')}
}

const before=(candidate:PlanExecutionHistoryItem|PlanExecutionHistoryCursor,previous:PlanExecutionHistoryItem|PlanExecutionHistoryCursor)=>candidate.claimedAt<previous.claimedAt||candidate.claimedAt===previous.claimedAt&&candidate.claimId<previous.claimId

/** 合并下一页并守住 keyset 的倒序边界；异常时由调用方保留原页。 */
export function appendPlanExecutionHistory(current:PlanExecutionHistoryPage,next:PlanExecutionHistoryPage):PlanExecutionHistoryPage{
 try{
  if(!current.cursor)throw Error()
  const seen=new Set([...current.items.map(item=>item.claimId),...(current.errors??[]).map(error=>error.claimId)])
  let previous:PlanExecutionHistoryItem|PlanExecutionHistoryCursor=current.cursor
  for(const item of next.items){if(seen.has(item.claimId)||!before(item,previous))throw Error();seen.add(item.claimId);previous=item}
  for(const error of next.errors??[]){if(seen.has(error.claimId))throw Error();seen.add(error.claimId)}
  if(next.cursor&&!before(next.cursor,current.cursor))throw Error()
  const errors=[...(current.errors??[]),...(next.errors??[])]
  return {items:[...current.items,...next.items],...(errors.length?{errors}:{}),...(next.cursor?{cursor:next.cursor}:{})}
 }catch{throw Error('持续计划执行历史分页顺序不正确。')}
}

/** 为异步读取分配单调世代，业务 key 回到旧值也不能复活旧请求。 */
export function createPlanExecutionHistoryRequestGate(){
 let generation=0
 return {begin:()=>++generation,current:(request:number)=>request===generation,invalidate:()=>{generation++}}
}
