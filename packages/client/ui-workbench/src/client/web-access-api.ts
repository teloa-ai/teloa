import {taskInput,isWebAccessPolicy,webAccessPolicyChangeInput,type WebAccessPolicy,type WebAccessPolicyChangeInput} from '@teloa/contract'
import type {RoleRequestJournal} from './role-api.ts'
import {recoveryStorageError} from './recovery-error.ts'

const journalSchema='teloa.web-access/v1'
const deterministic=(error:unknown)=>!!error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(String(error.code))

function policy(value:unknown):WebAccessPolicy{
 if(!isWebAccessPolicy(value))throw Error('上网设置返回格式不正确。')
 return value
}

export type WebAccessApi=ReturnType<typeof createWebAccessApi>
export function createWebAccessApi(call:(endpoint:string,payload:unknown)=>Promise<unknown>,journal:RoleRequestJournal){
 let pending:WebAccessPolicyChangeInput|undefined,error:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 try{const raw=journal.read();if(raw){const r=taskInput(JSON.parse(raw),['schema','request']);if(r.schema!==journalSchema)throw Error();pending=webAccessPolicyChangeInput(r.request)}}catch{error=recoveryStorageError()}
 const send=async()=>{
  if(error)throw error;if(busy||!pending)throw Error('没有可核对的上网设置请求，或正在保存。');busy=true
  try{
   journal.write(JSON.stringify({schema:journalSchema,request:pending}))
   const result=policy(await call('web-access/change',pending))
   if(result.version!==pending.expectedVersion+1||result.enabled!==pending.enabled||JSON.stringify(result.blocked)!==JSON.stringify(pending.blocked))throw Error('上网设置结果与原请求不一致。')
   journal.clear();pending=undefined;return result
  }catch(e){if(deterministic(e)){journal.clear();pending=undefined}throw e}finally{busy=false}
 }
 return {
  pending:()=>pending?{...pending,blocked:[...pending.blocked]}:undefined,
  recoveryMessage:()=>error,
  /** 丢弃只清本地恢复记录，不通知服务端（与 role-tools 同口径）。 */
  discard(){const had=pending!==undefined||error!==undefined;try{journal.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;error=undefined;return had},
  recover:send,
  async get(){return policy(await call('web-access/get',{}))},
  async change(value:WebAccessPolicyChangeInput){
   if(error)throw error
   const next=webAccessPolicyChangeInput(value)
   if(pending&&JSON.stringify(next)!==JSON.stringify(pending))throw Error('请先核对未完成的上网设置。')
   pending??=next
   return send()
  },
 }
}
