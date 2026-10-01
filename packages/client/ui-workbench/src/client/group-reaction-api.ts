import {groupReactionListInput,groupReactionToggleInput,isGroupReactionSummary,type GroupReactionEmoji,type GroupReactionSummary,type GroupReactionToggleInput} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
export type GroupReactionRequestJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}

const journalSchema='teloa.group-reaction/v1'
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right)
const clone=<T>(value:T):T=>structuredClone(value)
const deterministic=(error:unknown)=>!!error&&typeof error==='object'&&'rejected' in error&&(error as {rejected?:unknown}).rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(String((error as {code?:unknown}).code))
const exact=(value:unknown,keys:readonly string[],label:string):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw Error(label)
 return value as Record<string,unknown>
}

function summaries(value:unknown,allowed:ReadonlySet<string>,label:string):GroupReactionSummary[]{
 if(!Array.isArray(value))throw Error(label)
 return value.map(item=>{
  if(!isGroupReactionSummary(item)||!allowed.has(item.messageId))throw Error(label)
  return clone(item)
 })
}

export type GroupReactionApi=ReturnType<typeof createGroupReactionApi>
/**
 * toggle 幂等照 web-access-api.ts 先例：同一次未核对完成的请求原样重用 requestId 重放，
 * 不会因为断线重试而在服务端产生第二次翻转（服务端按 owner+request_id 去重落一行）。
 */
export function createGroupReactionApi(call:Call,journal?:GroupReactionRequestJournal,newId:()=>string=()=>crypto.randomUUID()){
 let pending:GroupReactionToggleInput|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 try{
  const raw=journal?.read()
  if(raw){
   const saved=exact(JSON.parse(raw),['schema','request'],'群表情恢复记录不可读取或已损坏，写入已暂停。')
   if(saved.schema!==journalSchema)throw Error()
   pending=groupReactionToggleInput(saved.request)
  }
 }catch{recoveryError=recoveryStorageError()}
 const send=async():Promise<GroupReactionSummary[]>=>{
  if(recoveryError)throw recoveryError
  if(!pending)throw Error('没有待核对的群表情请求。')
  if(busy)throw Error('群表情请求正在核对。')
  busy=true
  try{
   journal?.write(JSON.stringify({schema:journalSchema,request:pending}))
   const current=pending
   const row=exact(await call('groups/reactions/toggle',current),['messageId','items'],'群表情回执格式不正确。')
   if(row.messageId!==current.messageId)throw Error('群表情回执与原请求不一致。')
   const items=summaries(row.items,new Set([current.messageId]),'群表情回执格式不正确。')
   journal?.clear();pending=undefined
   return items
  }catch(error){if(deterministic(error)){journal?.clear();pending=undefined}throw error}finally{busy=false}
 }
 return {
  pending:()=>pending?{...pending}:undefined,
  recoveryMessage:()=>recoveryError,
  /** 丢弃只清本地恢复记录，不通知服务端（与 web-access-api 同口径）。 */
  discard(){const had=pending!==undefined||recoveryError!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;recoveryError=undefined;return had},
  recover:send,
  async list(groupId:string,messageIds:string[]):Promise<GroupReactionSummary[]>{
   const request=groupReactionListInput({groupId,messageIds})
   const row=exact(await call('groups/reactions/list',request),['items'],'群表情目录格式不正确。')
   return summaries(row.items,new Set(request.messageIds),'群表情目录格式不正确。')
  },
  async toggle(groupId:string,messageId:string,emoji:GroupReactionEmoji):Promise<GroupReactionSummary[]>{
   if(recoveryError)throw recoveryError
   const reuse=pending!==undefined&&pending.groupId===groupId&&pending.messageId===messageId&&pending.emoji===emoji
   const next=groupReactionToggleInput({requestId:reuse?pending!.requestId:newId(),groupId,messageId,emoji})
   if(pending&&!same(pending,next))throw Error('请先核对未完成的群表情请求，不能覆盖为其他操作。')
   pending??=next
   return send()
  },
 }
}
