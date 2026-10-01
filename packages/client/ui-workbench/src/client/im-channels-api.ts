import {
 taskInput,readImChannelSummary,rejectSecretKeys,
 imChannelSaveInput,imChannelIdInput,imBindingRemoveInput,imBindingChangeInput,imGroupBindInput,imGroupUnbindInput,
 type ImChannelKind,type ImChannelSummary,type ImBindingSummary,type ImGroupBindingSummary,type ImPairingCode,type ImDefaultTarget,
} from '@teloa/contract'
import type {RoleRequestJournal} from './role-api.ts'
import {recoveryStorageError} from './recovery-error.ts'

const journalSchema='teloa.im-channels/v1'
const deterministic=(error:unknown)=>!!error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict','teloa/not-found'].includes(String(error.code))
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const keys=(value:Record<string,unknown>,expected:readonly string[])=>Object.keys(value).length===expected.length&&expected.every(key=>key in value)
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))
const malformed=():never=>{throw Error('IM 通道返回格式不正确。')}

/** 读侧逐条校验；凭据键在任何层级出现即由 rejectSecretKeys 拒收。 */
function target(value:unknown):ImDefaultTarget{
 if(!record(value))return malformed()
 if(value.kind==='assistant'&&keys(value,['kind']))return {kind:'assistant'}
 if(value.kind==='role'&&keys(value,['kind','roleId'])&&text(value.roleId))return {kind:'role',roleId:value.roleId}
 return malformed()
}
function binding(value:unknown):ImBindingSummary{
 rejectSecretKeys(value)
 if(!record(value)||!keys(value,['channelId','imUserId','displayName','boundAt','target'])||!text(value.channelId)||!text(value.imUserId)||typeof value.displayName!=='string'||!stamp(value.boundAt))return malformed()
 return {channelId:value.channelId,imUserId:value.imUserId,displayName:value.displayName,boundAt:value.boundAt,target:target(value.target)}
}
function groupBinding(value:unknown):ImGroupBindingSummary{
 rejectSecretKeys(value)
 if(!record(value)||!keys(value,['channelId','chatId','groupId','boundAt'])||!text(value.channelId)||!text(value.chatId)||!text(value.groupId)||!stamp(value.boundAt))return malformed()
 return {channelId:value.channelId,chatId:value.chatId,groupId:value.groupId,boundAt:value.boundAt}
}
function pairing(value:unknown):ImPairingCode{
 rejectSecretKeys(value)
 if(!record(value)||!keys(value,['code','expiresAt'])||typeof value.code!=='string'||!/^\d{6}$/.test(value.code)||!stamp(value.expiresAt))return malformed()
 return {code:value.code,expiresAt:value.expiresAt}
}
function removed(value:unknown):void{
 if(!record(value)||!keys(value,['removed'])||value.removed!==true)malformed()
}
const list=<T>(value:unknown,read:(row:unknown)=>T):T[]=>{rejectSecretKeys(value);if(!Array.isArray(value))return malformed();return value.map(read)}

/**
 * 可恢复的写命令（im/channels/save 除外：携带凭据原值，不进本机恢复记录，按 channelId 覆盖保存天然幂等）。
 * 恢复记录只含 requestId 与标识字段，由对应契约输入函数重新校验。
 */
const writes={
 'im/channels/enable':{input:imChannelIdInput,read:readImChannelSummary},
 'im/channels/disable':{input:imChannelIdInput,read:readImChannelSummary},
 'im/channels/remove':{input:imChannelIdInput,read:removed},
 'im/pairing/create':{input:imChannelIdInput,read:pairing},
 'im/bindings/remove':{input:imBindingRemoveInput,read:removed},
 'im/bindings/change':{input:imBindingChangeInput,read:binding},
 'im/groups/bind':{input:imGroupBindInput,read:groupBinding},
 'im/groups/unbind':{input:imGroupUnbindInput,read:removed},
} as const
type WriteEndpoint=keyof typeof writes
type Pending={endpoint:WriteEndpoint;request:Record<string,unknown>}

export type ImChannelsApi=ReturnType<typeof createImChannelsApi>
export function createImChannelsApi(call:(endpoint:string,payload:unknown)=>Promise<unknown>,journal:RoleRequestJournal,newId=()=>crypto.randomUUID()){
 let pending:Pending|undefined,error:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 try{
  const raw=journal.read()
  if(raw){
   const row=taskInput(JSON.parse(raw),['schema','endpoint','request'])
   if(row.schema!==journalSchema||typeof row.endpoint!=='string'||!Object.hasOwn(writes,row.endpoint))throw Error()
   const endpoint=row.endpoint as WriteEndpoint
   pending={endpoint,request:writes[endpoint].input(row.request) as Record<string,unknown>}
  }
 }catch{error=recoveryStorageError()}
 const send=async():Promise<unknown>=>{
  if(error)throw error
  if(busy||!pending)throw Error('没有可核对的 IM 通道请求，或正在处理。')
  busy=true
  const current=pending
  try{
   journal.write(JSON.stringify({schema:journalSchema,endpoint:current.endpoint,request:current.request}))
   const result=writes[current.endpoint].read(await call(current.endpoint,current.request))
   journal.clear();pending=undefined;return result
  }catch(e){if(deterministic(e)){journal.clear();pending=undefined}throw e}finally{busy=false}
 }
 const write=async<E extends WriteEndpoint>(endpoint:E,fields:Record<string,unknown>)=>{
  if(error)throw error
  if(pending)throw Error('请先核对未完成的 IM 通道操作。')
  pending={endpoint,request:writes[endpoint].input({requestId:newId(),...fields}) as Record<string,unknown>}
  return await send() as ReturnType<(typeof writes)[E]['read']>
 }
 return {
  pending:()=>pending?{endpoint:pending.endpoint}:undefined,
  recoveryMessage:()=>error,
  /** 丢弃只清本地恢复记录，不通知服务端（与 role-tools 同口径）。 */
  discard(){const had=pending!==undefined||error!==undefined;try{journal.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;error=undefined;return had},
  recover:send,
  async channels():Promise<ImChannelSummary[]>{return list(await call('im/channels/list',{}),readImChannelSummary)},
  /** 凭据只随本次请求发出：不进恢复记录、不留引用；回包只含「已保存」摘要。 */
  async save(input:{kind:ImChannelKind;credentials:Record<string,string>}):Promise<ImChannelSummary>{
   return readImChannelSummary(await call('im/channels/save',imChannelSaveInput({requestId:newId(),channelId:input.kind,kind:input.kind,credentials:{...input.credentials}})))
  },
  enable:(channelId:string)=>write('im/channels/enable',{channelId}),
  disable:(channelId:string)=>write('im/channels/disable',{channelId}),
  remove:async(channelId:string):Promise<void>=>{await write('im/channels/remove',{channelId})},
  createPairing:(channelId:string)=>write('im/pairing/create',{channelId}),
  async bindings():Promise<ImBindingSummary[]>{return list(await call('im/bindings/list',{}),binding)},
  removeBinding:async(channelId:string,imUserId:string):Promise<void>=>{await write('im/bindings/remove',{channelId,imUserId})},
  changeTarget:(channelId:string,imUserId:string,value:ImDefaultTarget)=>write('im/bindings/change',{channelId,imUserId,target:value}),
  async groups():Promise<ImGroupBindingSummary[]>{return list(await call('im/groups/list',{}),groupBinding)},
  bindGroup:(channelId:string,chatId:string,groupId:string)=>write('im/groups/bind',{channelId,chatId,groupId}),
  unbindGroup:async(channelId:string,chatId:string):Promise<void>=>{await write('im/groups/unbind',{channelId,chatId})},
 }
}
