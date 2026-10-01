import {WorkError,isRecord,workTaskStates} from '@teloa/contract'
import type {PlanExecutionHistoryCursor,PlanExecutionHistoryPage} from '@teloa/backend'

export type PlanExecutionHistoryInput={planId?:string;limit:number;cursor?:PlanExecutionHistoryCursor;scope?:string;roleId?:string;query?:string;runState?:'prepared'|'submitting'|'accepted'|'active'|'ended'|'withdrawn'|'configuration_failed'|'not-started'}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const timestamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const invalidInput=()=>new WorkError('teloa/invalid-input','执行历史查询的计划或分页格式不正确。')
const invalidResponse=()=>new WorkError('teloa/invalid-host-response','执行历史返回了无效身份、状态或分页依据。')
const exact=(value:unknown,keys:readonly string[],fail:()=>Error):Record<string,unknown>=>{
 if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw fail()
 return value
}
function cursor(value:unknown,fail:()=>Error):PlanExecutionHistoryCursor{
 const row=exact(value,['claimedAt','claimId'],fail)
 if(!timestamp(row.claimedAt)||!uuid(row.claimId))throw fail()
 return {claimedAt:row.claimedAt,claimId:row.claimId}
}
const compare=(a:PlanExecutionHistoryCursor,b:PlanExecutionHistoryCursor)=>a.claimedAt<b.claimedAt?-1:a.claimedAt>b.claimedAt?1:a.claimId.toLowerCase()<b.claimId.toLowerCase()?-1:a.claimId.toLowerCase()>b.claimId.toLowerCase()?1:0
const notificationPolicy=(value:unknown):boolean=>typeof value==='string'&&['always','attention','failure','silent'].includes(value)

export function planExecutionHistoryInput(value:unknown):PlanExecutionHistoryInput{
 const row=exact(value,['planId','limit','cursor','scope','roleId','query','runState'],invalidInput)
 if('planId' in row&&!uuid(row.planId)||!positive(row.limit)||row.limit>50)throw invalidInput()
 if('scope' in row&&(typeof row.scope!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(row.scope)))throw invalidInput()
 if('roleId' in row&&!uuid(row.roleId))throw invalidInput()
 if('query' in row&&(typeof row.query!=='string'||!row.query.trim()||row.query.length>240))throw invalidInput()
 if('runState' in row&&(typeof row.runState!=='string'||!['prepared','submitting','accepted','active','ended','withdrawn','configuration_failed','not-started'].includes(row.runState)))throw invalidInput()
 return {...row,...('query' in row?{query:(row.query as string).trim()}:{}),...('cursor' in row?{cursor:cursor(row.cursor,invalidInput)}:{})} as PlanExecutionHistoryInput
}

/** 导航事实的边界校验；task/run 真实归属由持久读取事务核对，不能从缺失字段猜测。 */
export function planExecutionHistoryResponse(value:unknown,input:PlanExecutionHistoryInput):PlanExecutionHistoryPage{
 const page=exact(value,['items','errors','cursor'],invalidResponse)
 if(!Array.isArray(page.items)||('errors' in page&&!Array.isArray(page.errors)))throw invalidResponse()
 const errors=(page.errors??[]) as unknown[]
 if(page.items.length+errors.length>input.limit)throw invalidResponse()
 const identities=new Set<string>(),positions=new Map<string,PlanExecutionHistoryCursor>()
 let previous=input.cursor
 for(const value of page.items){
  const row=exact(value,['claimId','planId','occurrenceId','planVersion','configVersion','notificationPolicy','scheduledAt','claimedAt','task','run'],invalidResponse)
  if(!uuid(row.claimId)||!uuid(row.planId)||input.planId!==undefined&&row.planId!==input.planId||typeof row.occurrenceId!=='string'||!row.occurrenceId.trim()||row.occurrenceId.length>256||!positive(row.planVersion)||!positive(row.configVersion)||row.notificationPolicy!==undefined&&!notificationPolicy(row.notificationPolicy)||!timestamp(row.scheduledAt)||!timestamp(row.claimedAt))throw invalidResponse()
  const id=row.claimId.toLowerCase(),position={claimId:row.claimId,claimedAt:row.claimedAt}
  if(identities.has(id)||previous&&compare(position,previous)>=0)throw invalidResponse()
  identities.add(id);positions.set(id,position);previous=position
  if(row.task!==null){
   const task=exact(row.task,['id','state'],invalidResponse)
   if(!uuid(task.id)||!workTaskStates.some(state=>state===task.state))throw invalidResponse()
  }
  if(row.run!==null){
   const run=exact(row.run,['id','state','sessionId','createdAt'],invalidResponse)
   if(row.task===null||!uuid(run.id)||typeof run.state!=='string'||!['prepared','submitting','accepted','active','ended','withdrawn','configuration_failed'].includes(run.state)||typeof run.sessionId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(run.sessionId)||!timestamp(run.createdAt))throw invalidResponse()
  }
  if(input.runState!==undefined&&(row.run===null?input.runState!=='not-started':(row.run as Record<string,unknown>).state!==input.runState))throw invalidResponse()
 }
 for(const value of errors){
  const row=exact(value,['claimId','code'],invalidResponse)
  if(!uuid(row.claimId)||row.code!=='teloa/storage-corrupt'||identities.has(row.claimId.toLowerCase()))throw invalidResponse()
  identities.add(row.claimId.toLowerCase())
 }
 if('cursor' in page){
  const next=cursor(page.cursor,invalidResponse),known=positions.get(next.claimId.toLowerCase())
  if(identities.size!==input.limit||!identities.has(next.claimId.toLowerCase())||input.cursor&&compare(next,input.cursor)>=0||previous&&compare(next,previous)>0||known&&compare(next,known)!==0)throw invalidResponse()
 }
 return page as unknown as PlanExecutionHistoryPage
}
