import {WorkError,isRecord} from '@teloa/contract'
import type {PlanSkipHistoryCursor,PlanSkipHistoryPage} from '@teloa/backend'

export type PlanSkipHistoryInput={planId:string;limit:number;cursor?:PlanSkipHistoryCursor}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const timestamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const occurrence=(value:unknown):value is string=>typeof value==='string'&&value.length<=100&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\[(?:Asia\/Singapore|Asia\/Shanghai|UTC)\]$/.test(value)
const invalid=()=>new WorkError('teloa/invalid-input','跳过历史查询的计划或分页格式不正确。')
const corrupt=()=>new WorkError('teloa/invalid-host-response','跳过历史返回了无效身份、原因或分页依据。')
const exact=(value:unknown,keys:readonly string[],fail:()=>Error):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw fail();return value}
function cursor(value:unknown,fail:()=>Error):PlanSkipHistoryCursor{
 const row=exact(value,['skippedAt','configVersion','occurrenceId'],fail)
 if(!timestamp(row.skippedAt)||!positive(row.configVersion)||row.configVersion>2147483647||!occurrence(row.occurrenceId))throw fail()
 return {skippedAt:row.skippedAt,configVersion:row.configVersion,occurrenceId:row.occurrenceId}
}
const compare=(a:PlanSkipHistoryCursor,b:PlanSkipHistoryCursor)=>a.skippedAt<b.skippedAt?-1:a.skippedAt>b.skippedAt?1:a.configVersion-b.configVersion||(a.occurrenceId<b.occurrenceId?-1:a.occurrenceId>b.occurrenceId?1:0)
const identity=(row:PlanSkipHistoryCursor)=>JSON.stringify([row.configVersion,row.occurrenceId])

export function planSkipHistoryInput(value:unknown):PlanSkipHistoryInput{
 const row=exact(value,['planId','limit','cursor'],invalid)
 if(!uuid(row.planId)||!positive(row.limit)||row.limit>50)throw invalid()
 return {planId:row.planId,limit:row.limit,...('cursor' in row?{cursor:cursor(row.cursor,invalid)}:{})}
}
export function planSkipHistoryResponse(value:unknown,input:PlanSkipHistoryInput):PlanSkipHistoryPage{
 const page=exact(value,['items','errors','cursor'],corrupt)
 if(!Array.isArray(page.items)||'errors' in page&&!Array.isArray(page.errors))throw corrupt()
 const errors=(page.errors??[]) as unknown[]
 if(page.items.length+errors.length>input.limit)throw corrupt()
 const positions=new Map<string,PlanSkipHistoryCursor>()
 let previous=input.cursor
 for(const value of page.items){
  const row=exact(value,['planId','planVersion','configVersion','occurrenceId','scheduledAt','skippedAt','reason','blockingClaimId','taskId'],corrupt)
  const position=cursor({skippedAt:row.skippedAt,configVersion:row.configVersion,occurrenceId:row.occurrenceId},corrupt),key=identity(position)
  if(row.planId!==input.planId||!positive(row.planVersion)||!timestamp(row.scheduledAt)||position.skippedAt<row.scheduledAt||!uuid(row.blockingClaimId)||positions.has(key)||previous&&compare(position,previous)>=0)throw corrupt()
  if(row.reason==='previous-pending'?row.taskId!==null:row.reason==='previous-task-unfinished'?!uuid(row.taskId):true)throw corrupt()
  positions.set(key,position);previous=position
 }
 for(const value of errors){
  const row=exact(value,['skippedAt','configVersion','occurrenceId','code'],corrupt)
  const position=cursor({skippedAt:row.skippedAt,configVersion:row.configVersion,occurrenceId:row.occurrenceId},corrupt),key=identity(position)
  if(row.code!=='teloa/storage-corrupt'||positions.has(key)||input.cursor&&compare(position,input.cursor)>=0)throw corrupt()
  positions.set(key,position)
 }
 if('cursor' in page){
  const next=cursor(page.cursor,corrupt),known=positions.get(identity(next))
  if(positions.size!==input.limit||!known||compare(next,known)!==0||input.cursor&&compare(next,input.cursor)>=0||[...positions.values()].some(position=>compare(next,position)>0))throw corrupt()
 }
 return page as unknown as PlanSkipHistoryPage
}
