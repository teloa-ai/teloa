import {WorkError} from './work-error.ts'
import {taskInput} from './tasks.ts'
import {isRecord} from './resources.ts'

export type GroupReadingTarget={groupId:string;rootId?:string}
export type GroupReadCursor={messageId:string;createdAt:string}
export type GroupReadingState={schema:'teloa.group-reading/v1';groupId:string;rootId:string|null;cursor:GroupReadCursor|null;latest:GroupReadCursor|null;unreadCount:number}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const invalid=()=>new WorkError('teloa/invalid-input','群阅读位置格式不正确。')
export function groupReadingInput(value:unknown):GroupReadingTarget{
 const row=taskInput(value,['groupId','rootId'])
 if(!uuid(row.groupId)||row.rootId!==undefined&&!uuid(row.rootId))throw invalid()
 return {groupId:row.groupId,...(row.rootId===undefined?{}:{rootId:row.rootId})}
}
export function groupMarkReadInput(value:unknown):GroupReadingTarget&{messageId:string}{
 const row=taskInput(value,['groupId','rootId','messageId'])
 if(!uuid(row.messageId))throw invalid()
 return {...groupReadingInput({groupId:row.groupId,...(row.rootId===undefined?{}:{rootId:row.rootId})}),messageId:row.messageId}
}
export function readGroupReadingState(value:unknown):GroupReadingState{
 const row=taskInput(value,['schema','groupId','rootId','cursor','latest','unreadCount'])
 const cursor=(v:unknown):GroupReadCursor|null=>{
  if(v===null)return null
  if(!isRecord(v)||Object.keys(v).length!==2||!uuid(v.messageId)||typeof v.createdAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.createdAt)||!Number.isFinite(Date.parse(v.createdAt))||new Date(v.createdAt).toISOString()!==v.createdAt)throw invalid()
  return {messageId:v.messageId,createdAt:v.createdAt}
 }
 if(row.schema!=='teloa.group-reading/v1'||!uuid(row.groupId)||row.rootId!==null&&!uuid(row.rootId)||!Number.isSafeInteger(row.unreadCount)||Number(row.unreadCount)<0)throw invalid()
 const read=cursor(row.cursor),latest=cursor(row.latest)
 if(read&&(!latest||read.createdAt>latest.createdAt||read.createdAt===latest.createdAt&&read.messageId>latest.messageId))throw invalid()
 return {schema:row.schema,groupId:row.groupId,rootId:row.rootId as string|null,cursor:read,latest,unreadCount:row.unreadCount as number}
}
