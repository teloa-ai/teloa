import {WorkError} from './work-error.ts'
import {taskInput} from './tasks.ts'
import {groupMessageSearchInput,readGroupMessageSearchResult,type GroupMessageSearchResult} from './group-messages.ts'

export type GroupAttention={groupId:string;unreadCount:number;mentionCount:number}
export type GroupMentionsInput={groupId:string;rootId?:string;before?:string;limit:number;unreadOnly:boolean}
export type GroupMentionItem=GroupMessageSearchResult['items'][number]&{unread:boolean}
export type GroupMentionsPage={schema:'teloa.group-mentions/v1';groupId:string;rootId:string|null;unreadOnly:boolean;items:GroupMentionItem[];next:string|null}
const invalid=():never=>{throw new WorkError('teloa/invalid-input','群提及记录格式不正确。')}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
export function groupMentionsInput(value:unknown):GroupMentionsInput{
 const row=taskInput(value,['groupId','rootId','before','limit','unreadOnly'])
 if(row.unreadOnly!==undefined&&typeof row.unreadOnly!=='boolean')invalid()
 const {unreadOnly,...target}=row,{query,...input}=groupMessageSearchInput({...target,query:'@self'})
 return {...input,unreadOnly:unreadOnly===true}
}
export function readGroupAttention(value:unknown):{schema:'teloa.group-attention/v1';items:GroupAttention[]}{
 const row=taskInput(value,['schema','items'])
 if(row.schema!=='teloa.group-attention/v1'||!Array.isArray(row.items)||row.items.length>10000)invalid()
 const items=(row.items as unknown[]).map(value=>{const item=taskInput(value,['groupId','unreadCount','mentionCount'])
  if(!uuid(item.groupId)||!Number.isSafeInteger(item.unreadCount)||Number(item.unreadCount)<0||!Number.isSafeInteger(item.mentionCount)||Number(item.mentionCount)<0||Number(item.mentionCount)>Number(item.unreadCount))invalid()
  return {groupId:item.groupId as string,unreadCount:Number(item.unreadCount),mentionCount:Number(item.mentionCount)}
 })
 if(new Set(items.map(item=>item.groupId)).size!==items.length)invalid()
 return {schema:'teloa.group-attention/v1',items}
}
export function readGroupMentionsPage(value:unknown):GroupMentionsPage{
 const row=taskInput(value,['schema','groupId','rootId','unreadOnly','items','next'])
 if(row.schema!=='teloa.group-mentions/v1'||typeof row.unreadOnly!=='boolean'||!Array.isArray(row.items))invalid()
 const items=(row.items as unknown[]).map(value=>{const item=taskInput(value,['message','rootId','excerpt','unread']);if(typeof item.unread!=='boolean')invalid();const {unread,...entry}=item;return {unread:unread as boolean,entry}})
 const {unreadOnly,...page}=row
 const result=readGroupMessageSearchResult({...page,schema:'teloa.group-message-search/v1',query:'@self',items:items.map(item=>item.entry)})
 if(result.items.some(item=>!('runId' in item.message)||item.message.mentionSelf!==true)||unreadOnly&&items.some(item=>!item.unread))invalid()
 return {schema:'teloa.group-mentions/v1',groupId:result.groupId,rootId:result.rootId,unreadOnly:unreadOnly as boolean,items:result.items.map((item,index)=>({...item,unread:items[index]!.unread})),next:result.next}
}
