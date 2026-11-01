import {WorkError} from './work-error.ts'
import {taskInput} from './tasks.ts'
import {isGroupMessage,type GroupMessage} from './collaboration.ts'

/** 来源导航只读；它不是 MessageReference，也不授予资料或执行权限。 */
export const groupMessageSourcesEndpoint={name:'groups/messages/sources',writing:false} as const
export type GroupMessageSourceItem={message:GroupMessage;rootId:string|null;sha256:string}
export type GroupMessageSources={schema:'teloa.group-message-sources/v1';groupId:string;messageId:string;runId:string|null;items:GroupMessageSourceItem[];unavailableCount:number}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const invalid=():never=>{throw new WorkError('teloa/invalid-input','群消息引用来源格式不正确。')}

/** 只识别正文明确称为消息编号的引用；代码、转义及普通 UUID 都不是引用。 */
export function citedGroupMessageIds(text:string):string[]{
 const prose:string[]=[];let fence:{char:string;length:number}|undefined
 for(const line of text.split('\n')){
  const marker=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if(fence){if(marker&&marker[1]![0]===fence.char&&marker[1]!.length>=fence.length&&!marker[2]!.trim())fence=undefined;continue}
  if(marker&&(marker[1]![0]!=='`'||!marker[2]!.includes('`'))){fence={char:marker[1]![0]!,length:marker[1]!.length};continue}
  if(!/^(?: {4}|\t)/.test(line))prose.push(line)
 }
 // 代码整句不是引用；独立编号或规范字段标签可由外部明确的消息标识绑定。
 const visible=prose.join('\n').replace(/(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g,(_span,_ticks,content:string)=>{const token=content.trim();return uuid(token)||/^messageId$/i.test(token)?token:''}).replace(/\\./g,'')
 const result=new Set<string>()
 for(const match of visible.matchAll(/(?:消息(?:编号|ID)|訊息(?:編號|ID)|message(?:\s+ids?|Ids?)\b)\s*[:：#]?\s*([^\n)）]+)/gi)){
  for(const id of match[1]!.match(/\b[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\b/gi)??[])result.add(id.toLowerCase())
 }
 return [...result]
}

export function readGroupMessageSources(value:unknown):GroupMessageSources{
 const row=taskInput(value,['schema','groupId','messageId','runId','items','unavailableCount'])
 if(row.schema!=='teloa.group-message-sources/v1'||!uuid(row.groupId)||!uuid(row.messageId)||row.runId!==null&&!uuid(row.runId)||!Array.isArray(row.items)||!Number.isSafeInteger(row.unavailableCount)||Number(row.unavailableCount)<0)invalid()
 const groupId=row.groupId as string,items=(row.items as unknown[]).map(value=>{
  const item=taskInput(value,['message','rootId','sha256']),message=item.message
  if(!isGroupMessage(message))return invalid()
  if(message.groupId!==groupId||item.rootId!==null&&!uuid(item.rootId)||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))invalid()
  if(item.rootId!==null&&message.rootId!==item.rootId||item.rootId===null&&message.rootId!==null&&(!('runId'in message)||message.contextMode!=='main'))invalid()
  if('runId'in message&&message.fullText&&message.fullText.sha256!==item.sha256)invalid()
  return {message:structuredClone(message),rootId:item.rootId as string|null,sha256:item.sha256 as string}
 })
 if(new Set(items.map(item=>item.message.id)).size!==items.length||items.some(item=>item.message.id===row.messageId)||row.runId===null&&items.length)invalid()
 return {schema:'teloa.group-message-sources/v1',groupId,messageId:row.messageId as string,runId:row.runId as string|null,items,unavailableCount:Number(row.unavailableCount)}
}
