import {WorkError} from './work-error.ts'
import {taskInput} from './tasks.ts'
import {groupReadingInput,type GroupReadingTarget} from './group-reading.ts'
import {isGroupMessage,type GroupMessage} from './collaboration.ts'

export type GroupMessagePageInput=GroupReadingTarget&{limit:number;before?:string;after?:string;around?:string;topicRoots?:string[]}
export type GroupTopicSummary={rootId:string;count:number;participants:number;replies:GroupMessage[]}
export type GroupMessagePage={schema:'teloa.group-message-page/v1';groupId:string;rootId:string|null;items:GroupMessage[];older:string|null;newer:string|null;topics:GroupTopicSummary[]}
export type GroupMessageSearchInput=GroupReadingTarget&{query:string;limit:number;before?:string}
export type GroupMessageSearchResult={schema:'teloa.group-message-search/v1';groupId:string;rootId:string|null;query:string;items:Array<{message:GroupMessage;rootId:string|null;excerpt:string}>;next:string|null}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const invalid=():never=>{throw new WorkError('teloa/invalid-input','群消息分页或检索格式不正确。')}
const target=(row:Record<string,unknown>)=>groupReadingInput({groupId:row.groupId,...(row.rootId===undefined?{}:{rootId:row.rootId})})
const limit=(value:unknown)=>value===undefined?50:Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=100?Number(value):invalid()
export function groupMessagePageInput(value:unknown):GroupMessagePageInput{
 const row=taskInput(value,['groupId','rootId','limit','before','after','around','topicRoots']),cursors=['before','after','around'].filter(key=>row[key]!==undefined)
 if(cursors.length>1||cursors.some(key=>!uuid(row[key])))invalid()
 if(row.topicRoots!==undefined&&(!Array.isArray(row.topicRoots)||row.topicRoots.length>50||!row.topicRoots.every(uuid)||new Set(row.topicRoots).size!==row.topicRoots.length||row.rootId!==undefined))invalid()
 return {...target(row),limit:limit(row.limit),...Object.fromEntries(cursors.map(key=>[key,row[key]])),...(row.topicRoots===undefined?{}:{topicRoots:[...row.topicRoots as string[]]})}
}
export function groupMessageSearchInput(value:unknown):GroupMessageSearchInput{
 const row=taskInput(value,['groupId','rootId','query','limit','before'])
 if(typeof row.query!=='string'||!row.query.trim()||row.query.trim().length>240||/[\x00-\x1f\x7f]/.test(row.query)||row.before!==undefined&&!uuid(row.before))invalid()
 return {...target(row),query:(row.query as string).trim(),limit:limit(row.limit),...(row.before===undefined?{}:{before:row.before as string})}
}
const message=(value:unknown,groupId:string):GroupMessage=>{
 if(!isGroupMessage(value)||value.groupId!==groupId||!Number.isFinite(Date.parse(value.createdAt))||new Date(value.createdAt).toISOString()!==value.createdAt)invalid()
 return structuredClone(value as GroupMessage)
}
const cursor=(value:unknown)=>value===null?null:uuid(value)?value:invalid()
const order=(left:GroupMessage,right:GroupMessage)=>left.createdAt.localeCompare(right.createdAt)||left.id.localeCompare(right.id)
export function readGroupMessagePage(value:unknown):GroupMessagePage{
 const row=taskInput(value,['schema','groupId','rootId','items','older','newer','topics'])
 if(row.schema!=='teloa.group-message-page/v1'||!uuid(row.groupId)||row.rootId!==null&&!uuid(row.rootId)||!Array.isArray(row.items)||row.items.length>101||!Array.isArray(row.topics)||row.topics.length>150)invalid()
 const groupId=row.groupId as string,rootId=row.rootId as string|null,items=(row.items as unknown[]).map(value=>message(value,groupId)),rows=rootId?items.slice(1):items
 if(new Set(items.map(row=>row.id)).size!==items.length||rows.some((row,index)=>index>0&&order(rows[index-1]!,row)>=0))invalid()
 if(rootId?(items[0]?.id!==rootId||items[0]?.rootId!==null||rows.some(row=>row.rootId!==rootId)):items.some(row=>row.rootId!==null&&(!('runId'in row)||row.contextMode!=='main')))invalid()
 const older=cursor(row.older),newer=cursor(row.newer)
 if(older!==null&&older!==rows[0]?.id||newer!==null&&newer!==rows.at(-1)?.id)invalid()
 const topics=(row.topics as unknown[]).map(value=>{
  const item=taskInput(value,['rootId','count','participants','replies'])
  if(rootId&&item.rootId!==rootId||!uuid(item.rootId)||!Number.isSafeInteger(item.count)||Number(item.count)<0||!Number.isSafeInteger(item.participants)||Number(item.participants)<0||Number(item.participants)>Number(item.count)||!Array.isArray(item.replies)||item.replies.length>3)invalid()
  const replies=(item.replies as unknown[]).map(value=>message(value,groupId))
  if(replies.some(row=>row.rootId!==item.rootId)||new Set(replies.map(row=>row.authorId)).size!==replies.length||replies.length>Number(item.participants))invalid()
  return {rootId:item.rootId as string,count:Number(item.count),participants:Number(item.participants),replies}
 })
 if(new Set(topics.map(row=>row.rootId)).size!==topics.length)invalid()
 return {schema:'teloa.group-message-page/v1',groupId,rootId,items,older,newer,topics}
}
export function readGroupMessageSearchResult(value:unknown):GroupMessageSearchResult{
 const row=taskInput(value,['schema','groupId','rootId','query','items','next']),input=groupMessageSearchInput({groupId:row.groupId,...(row.rootId===null?{}:{rootId:row.rootId}),query:row.query,limit:100})
 if(row.schema!=='teloa.group-message-search/v1'||row.rootId!==null&&!uuid(row.rootId)||input.query!==row.query||!Array.isArray(row.items)||row.items.length>100)invalid()
 const items=(row.items as unknown[]).map(value=>{const item=taskInput(value,['message','rootId','excerpt']),saved=message(item.message,input.groupId),rootId=cursor(item.rootId)
  if(typeof item.excerpt!=='string'||!item.excerpt.length||item.excerpt.length>800)invalid()
  if(input.rootId&&saved.id!==input.rootId&&saved.rootId!==input.rootId||rootId!==null&&saved.rootId!==rootId||rootId===null&&saved.rootId!==null&&(!('runId'in saved)||saved.contextMode!=='main'))invalid()
  return {message:saved,rootId,excerpt:item.excerpt as string}
 })
 if(new Set(items.map(row=>row.message.id)).size!==items.length||items.some((row,index)=>index>0&&order(items[index-1]!.message,row.message)<=0))invalid()
 const next=cursor(row.next);if(next!==null&&next!==items.at(-1)?.message.id)invalid()
 return {schema:'teloa.group-message-search/v1',groupId:input.groupId,rootId:input.rootId??null,query:input.query,items,next}
}
