import {isRecord} from '@teloa/contract'
import type {PlanScheduleSkip} from './plan-schedule-summary.ts'

export type PlanSkipHistoryCursor={skippedAt:string;configVersion:number;occurrenceId:string}
export type PlanSkipHistoryError=PlanSkipHistoryCursor&{code:'teloa/storage-corrupt'}
export type PlanSkipHistoryPage={items:PlanScheduleSkip[];errors?:PlanSkipHistoryError[];cursor?:PlanSkipHistoryCursor}
export type PlanSkipHistoryReadOptions={limit:number;cursor?:PlanSkipHistoryCursor}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const timestamp=(value:unknown):value is string=>{if(typeof value!=='string')return false;const parsed=new Date(value);return Number.isFinite(parsed.getTime())&&parsed.toISOString()===value}
const occurrence=(value:unknown):value is string=>typeof value==='string'&&value.length<=100&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\[(?:Asia\/Singapore|Asia\/Shanghai|UTC)\]$/.test(value)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error();return value}
const identity=(value:PlanSkipHistoryCursor)=>`${value.configVersion}\0${value.occurrenceId}`
const before=(candidate:PlanSkipHistoryCursor,previous:PlanSkipHistoryCursor)=>candidate.skippedAt<previous.skippedAt||candidate.skippedAt===previous.skippedAt&&(candidate.configVersion<previous.configVersion||candidate.configVersion===previous.configVersion&&candidate.occurrenceId<previous.occurrenceId)

function readCursor(value:unknown):PlanSkipHistoryCursor{
 const row=exact(value,['skippedAt','configVersion','occurrenceId'])
 if(!timestamp(row.skippedAt)||!positive(row.configVersion)||!occurrence(row.occurrenceId))throw Error()
 return {skippedAt:row.skippedAt,configVersion:row.configVersion,occurrenceId:row.occurrenceId}
}
function readItem(value:unknown,planId:string):PlanScheduleSkip{
 const row=exact(value,['planId','planVersion','configVersion','occurrenceId','scheduledAt','skippedAt','reason','blockingClaimId','taskId'])
 if(row.planId!==planId||!positive(row.planVersion)||!positive(row.configVersion)||!occurrence(row.occurrenceId)||!timestamp(row.scheduledAt)||!timestamp(row.skippedAt)||row.skippedAt<row.scheduledAt||!uuid(row.blockingClaimId)||typeof row.reason!=='string'||!['previous-pending','previous-task-unfinished'].includes(row.reason))throw Error()
 if(row.reason==='previous-pending'?row.taskId!==null:!uuid(row.taskId))throw Error()
 return {planId:row.planId,planVersion:row.planVersion,configVersion:row.configVersion,occurrenceId:row.occurrenceId,scheduledAt:row.scheduledAt,skippedAt:row.skippedAt,reason:row.reason as PlanScheduleSkip['reason'],blockingClaimId:row.blockingClaimId,taskId:row.taskId as string|null}
}

export function readPlanSkipHistoryPage(value:unknown,planId:string,options?:PlanSkipHistoryReadOptions):PlanSkipHistoryPage{
 try{
  if(!uuid(planId))throw Error()
  const row=exact(value,['items','errors','cursor']);if(!Array.isArray(row.items))throw Error()
  const items=row.items.map(value=>readItem(value,planId)),seen=new Set<string>()
  for(let index=0;index<items.length;index++){const key=identity(items[index]!);if(seen.has(key)||index>0&&!before(items[index]!,items[index-1]!))throw Error();seen.add(key)}
  let errors:PlanSkipHistoryError[]|undefined
  if(row.errors!==undefined){if(!Array.isArray(row.errors))throw Error();errors=row.errors.map(value=>{const item=exact(value,['skippedAt','configVersion','occurrenceId','code']),cursor=readCursor({skippedAt:item.skippedAt,configVersion:item.configVersion,occurrenceId:item.occurrenceId});if(item.code!=='teloa/storage-corrupt'||seen.has(identity(cursor)))throw Error();seen.add(identity(cursor));return {...cursor,code:'teloa/storage-corrupt'}})}
  const cursor=row.cursor===undefined?undefined:readCursor(row.cursor),entries:PlanSkipHistoryCursor[]=[...items,...(errors??[])]
  if(cursor&&entries.filter(entry=>identity(entry)===identity(cursor)&&entry.skippedAt===cursor.skippedAt).length!==1||cursor&&entries.some(entry=>entry.skippedAt!==cursor.skippedAt||identity(entry)!==identity(cursor)?!before(cursor,entry):false))throw Error()
  if(options){const count=items.length+(errors?.length??0);if(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>50||count>options.limit||cursor&&count!==options.limit)throw Error();if(options.cursor){const boundary=readCursor(options.cursor);if(entries.some(entry=>!before(entry,boundary))||cursor&&!before(cursor,boundary))throw Error()}}
  return {items,...(errors?{errors}:{}),...(cursor?{cursor}:{})}
 }catch{throw Error('持续计划跳过记录格式不正确。')}
}

export function appendPlanSkipHistory(current:PlanSkipHistoryPage,next:PlanSkipHistoryPage):PlanSkipHistoryPage{
 try{
  if(!current.cursor)throw Error()
  const seen=new Set([...current.items.map(identity),...(current.errors??[]).map(identity)]),boundary=current.cursor
  for(const item of next.items){const key=identity(item);if(seen.has(key)||!before(item,boundary))throw Error();seen.add(key)}
  for(const error of next.errors??[]){const key=identity(error);if(seen.has(key)||!before(error,boundary))throw Error();seen.add(key)}
  if(next.cursor&&!before(next.cursor,boundary))throw Error()
  const errors=[...(current.errors??[]),...(next.errors??[])]
  return {items:[...current.items,...next.items],...(errors.length?{errors}:{}),...(next.cursor?{cursor:next.cursor}:{})}
 }catch{throw Error('持续计划跳过记录分页顺序不正确。')}
}
