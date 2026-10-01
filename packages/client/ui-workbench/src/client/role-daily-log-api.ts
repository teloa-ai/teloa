import {isRoleDailyLog,isRoleDailyLogSummary,type RoleDailyLog,type RoleDailyLogSummary} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
type Journal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
type Pending={requestId:string;logId:string;expectedState:'kept'}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const maxJournalCharacters=4096
const object=(value:unknown,keys:readonly string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error('每日日志请求格式不正确。');return value as Record<string,unknown>}
const deterministic=(error:unknown)=>!!error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(String(error.code))
function readLog(value:unknown):RoleDailyLog{const row=object(value,['log']);if(!isRoleDailyLog(row.log))throw Error('每日日志服务响应格式不正确。');return row.log}
function readSummaries(value:unknown):RoleDailyLogSummary[]{
 const row=object(value,['items'])
 if(!Array.isArray(row.items))throw Error('每日日志目录格式不正确。')
 const rows=row.items.map(item=>{if(!isRoleDailyLogSummary(item))throw Error('每日日志目录格式不正确。');return item})
 if(new Set(rows.map(item=>item.id)).size!==rows.length)throw Error('每日日志目录包含重复身份。')
 return rows
}
function readPending(value:unknown):Pending{
 const row=object(value,['requestId','logId','expectedState'])
 if(!uuid(row.requestId)||!uuid(row.logId)||row.expectedState!=='kept')throw Error()
 return {requestId:row.requestId,logId:row.logId,expectedState:'kept'}
}

export type RoleDailyLogApi=ReturnType<typeof createRoleDailyLogApi>
export function createRoleDailyLogApi(call:Call,journal:Journal,newId=()=>crypto.randomUUID()){
 let pending:Pending|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 try{const raw=journal.read();if(raw){if(raw.length>maxJournalCharacters)throw Error();const row=object(JSON.parse(raw),['schema','operation']);if(row.schema!=='teloa.role-daily-log-command/v1')throw Error();pending=readPending(row.operation)}}catch{recoveryError=recoveryStorageError()}
 const send=async():Promise<RoleDailyLog>=>{
  if(recoveryError)throw recoveryError;if(busy)throw Error('每日日志请求正在核对。');if(!pending)throw Error('没有待核对的每日日志请求。')
  busy=true
  try{
   journal.write(JSON.stringify({schema:'teloa.role-daily-log-command/v1',operation:pending}))
   const request=pending
   const result=readLog(await call('role-daily-log/discard',{requestId:request.requestId,logId:request.logId,expectedState:request.expectedState}))
   if(result.id!==request.logId||result.state!=='discarded'||!result.discardedAt)throw Error('每日日志丢弃响应与原请求不一致，请刷新核对。')
   journal.clear();pending=undefined;return result
  }catch(error){if(deterministic(error)){journal.clear();pending=undefined}throw error}finally{busy=false}
 }
 return {
  pending:()=>pending!==undefined,
  recoveryMessage:()=>recoveryError,
  /** 丢弃只清本地恢复记录，不通知服务端（与 role-memory-api.ts 同口径）。 */
  discardPending(){try{journal.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;recoveryError=undefined},
  recover:send,
  async list(roleId:string):Promise<RoleDailyLogSummary[]>{
   if(!uuid(roleId))throw Error('员工身份不正确。')
   return readSummaries(await call('role-daily-log/list',{roleId}))
  },
  async get(roleId:string,logId:string):Promise<RoleDailyLog>{
   if(!uuid(roleId)||!uuid(logId))throw Error('每日日志请求身份不正确。')
   const value=await call('role-daily-log/get',{roleId,logId}),result=readLog(value)
   if(result.id!==logId||result.roleId!==roleId)throw Error('每日日志详情与目标身份不一致。')
   return result
  },
  discard(logId:string):Promise<RoleDailyLog>{
   if(recoveryError)throw recoveryError
   if(!uuid(logId))throw Error('每日日志身份不正确。')
   const proposed:Pending={requestId:pending&&pending.logId===logId?pending.requestId:newId(),logId,expectedState:'kept'}
   if(pending&&JSON.stringify(pending)!==JSON.stringify(proposed))throw Error('请先核对原每日日志请求，再执行其他操作。')
   pending??=proposed
   return send()
  },
 }
}
