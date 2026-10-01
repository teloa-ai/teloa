import type {Pool} from 'pg'
import {WorkError,isRecord} from '@teloa/contract'

import {pendingRequestEndpoints,isPendingRequestEndpoint,type PendingRequestEndpoint} from '@teloa/contract'
export {pendingRequestEndpoints,isPendingRequestEndpoint,type PendingRequestEndpoint} from '@teloa/contract'

type RecoveryEndpoint=PendingRequestEndpoint|'market-content/import'
export type PendingRequest={requestId:string;endpoint:RecoveryEndpoint;createdAt:string;updatedAt:string;lastErrorCode?:string}
export type PendingRequestRecovery=PendingRequest&{payload:Record<string,unknown>}

// 只读兼容升级前已冻结的市场上传；reserve 仍只认共享白名单，不再复制新上传正文。
const endpointSet=new Set<string>([...pendingRequestEndpoints,'market-content/import'])
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const storedStamp=(value:unknown):string=>{
 if(typeof value==='string'&&stamp(value))return value
 if(value instanceof Date&&!Number.isNaN(value.valueOf()))return value.toISOString()
 throw new WorkError('teloa/storage-corrupt','待恢复请求目录已损坏。')
}
// 子串匹配：credentials、TELEGRAM_BOT_TOKEN、privateKey 等变体一律拒绝入表（纵深防线，白名单之外再拦一道）。
const sensitiveKey=/(password|secret|token|credential|authorization|api[_-]?key|private[_-]?key)/i
const maxRequestBytes=100_000

function invalid(message:string):never{throw new WorkError('teloa/invalid-input',message)}
function canonical(value:unknown):string{return JSON.stringify(value)}
function safePayload(value:unknown):Record<string,unknown>{
 if(!isRecord(value)||!Object.hasOwn(value,'requestId')||!uuid(value.requestId))invalid('待恢复请求必须带有效的请求身份。')
 const json=canonical(value)
 if(json.length>maxRequestBytes)invalid('待恢复请求内容过大。')
 const visit=(current:unknown):void=>{
  if(Array.isArray(current)){for(const item of current)visit(item);return}
  if(!isRecord(current))return
  for(const [key,item] of Object.entries(current)){
   if(sensitiveKey.test(key))invalid('待恢复请求不能保存凭据或口令字段。')
   visit(item)
  }
 }
 visit(value)
 return {...structuredClone(value),requestId:String(value.requestId).toLowerCase()}
}

function read(row:Record<string,unknown>):PendingRequest{
 if(!uuid(row.request_id)||!endpointSet.has(String(row.endpoint)))throw new WorkError('teloa/storage-corrupt','待恢复请求目录已损坏。')
 if(row.last_error_code!==null&&typeof row.last_error_code!=='string')throw new WorkError('teloa/storage-corrupt','待恢复请求目录已损坏。')
 return {requestId:String(row.request_id).toLowerCase(),endpoint:row.endpoint as RecoveryEndpoint,createdAt:storedStamp(row.created_at),updatedAt:storedStamp(row.updated_at),...(typeof row.last_error_code==='string'?{lastErrorCode:row.last_error_code}:{})}
}


export async function initializePendingRequests(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_pending_request_registry(
  owner_id text not null,request_id uuid not null,endpoint text not null,
  request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  state text not null check(state in ('pending','completed','rejected')),
  last_error_code text,created_at timestamptz not null,updated_at timestamptz not null,
  primary key(owner_id,request_id)
 )`)
 // im/channels/save 曾被登记且请求体含凭据原值；移出白名单后清除旧行，既抹掉凭据也避免读目录时判为损坏。
 await pool.query("delete from teloa_pending_request_registry where endpoint='im/channels/save'")
 // 旧目录升级时保守保留 pending，必须重放成功后才允许收讫确认。
 await pool.query('alter table teloa_pending_request_registry add column if not exists response_ready boolean not null default false')
 await pool.query('create index if not exists teloa_pending_request_registry_owner_pending_idx on teloa_pending_request_registry(owner_id,updated_at desc) where state=\'pending\'')
}

export class PendingRequestService{
 private readonly pool:Pool
 constructor(pool:Pool){this.pool=pool}
 async reserve(ownerId:string,endpoint:PendingRequestEndpoint,payload:unknown,now:string):Promise<void>{
  if(!isPendingRequestEndpoint(endpoint)||typeof ownerId!=='string'||!ownerId.trim()||!stamp(now))invalid('待恢复请求身份或时间无效。')
  const fixed=safePayload(payload),requestId=fixed.requestId as string,spec=canonical(fixed)
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/pending-request',ownerId,requestId])])
   const prior=(await db.query('select endpoint,request_spec=$3::jsonb same_spec from teloa_pending_request_registry where owner_id=$1 and request_id=$2',[ownerId,requestId,spec])).rows[0]
   if(prior){
    if(prior.endpoint!==endpoint||prior.same_spec!==true)throw new WorkError('teloa/conflict','同一请求身份不能用于不同命令或内容。')
   }else await db.query('insert into teloa_pending_request_registry(owner_id,request_id,endpoint,request_spec,state,created_at,updated_at) values($1,$2,$3,$4,\'pending\',$5,$5)',[ownerId,requestId,endpoint,spec,now])
   await db.query('commit')
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async complete(ownerId:string,requestId:string,now:string):Promise<void>{await this.setState(ownerId,requestId,'completed',now)}
 /**
  * 浏览器收到可恢复写命令的结果后才确认关闭目录。回包在网络层丢失时，
  * 这条确认不会发生，另一浏览器仍可只凭 requestId 重放服务端冻结的原请求。
  */
 async markResponseReady(ownerId:string,requestId:string,now:string):Promise<void>{
  if(!uuid(requestId)||!stamp(now))invalid('待恢复请求身份或时间无效。')
  await this.pool.query("update teloa_pending_request_registry set response_ready=true,updated_at=$3 where owner_id=$1 and request_id=$2 and state='pending'",[ownerId,requestId.toLowerCase(),now])
 }
 async acknowledge(ownerId:string,requestId:string,now:string):Promise<void>{
  if(!uuid(requestId)||!stamp(now))invalid('待恢复请求身份或时间无效。')
  const updated=await this.pool.query("update teloa_pending_request_registry set state='completed',updated_at=$3 where owner_id=$1 and request_id=$2 and state='pending' and response_ready returning request_id",[ownerId,requestId.toLowerCase(),now])
  if(updated.rows.length)return
  const row=(await this.pool.query('select state from teloa_pending_request_registry where owner_id=$1 and request_id=$2',[ownerId,requestId.toLowerCase()])).rows[0]
  if(!row)throw new WorkError('teloa/not-found','没有可确认的原请求。')
  if(row.state!=='completed')throw new WorkError('teloa/conflict','原请求尚未返回成功结果，不能确认完成。')
 }

 async reject(ownerId:string,requestId:string,code:string,now:string):Promise<void>{await this.setState(ownerId,requestId,'rejected',now,code)}
 /** 删除本人该请求的整行（任何状态）：被贴密钥闸拒收的请求原文不得留在目录里。 */
 async discard(ownerId:string,requestId:string):Promise<void>{
  if(!uuid(requestId))invalid('待恢复请求身份无效。')
  await this.pool.query('delete from teloa_pending_request_registry where owner_id=$1 and request_id=$2',[ownerId,requestId.toLowerCase()])
 }
 private async setState(ownerId:string,requestId:string,state:'completed'|'rejected',now:string,code?:string):Promise<void>{
  if(!uuid(requestId)||!stamp(now))invalid('待恢复请求身份或时间无效。')
  await this.pool.query('update teloa_pending_request_registry set state=$3,last_error_code=$4,updated_at=$5 where owner_id=$1 and request_id=$2 and state=\'pending\'',[ownerId,requestId.toLowerCase(),state,code??null,now])
 }
 async list(ownerId:string):Promise<PendingRequest[]>{
  const rows=(await this.pool.query('select request_id,endpoint,created_at,updated_at,last_error_code from teloa_pending_request_registry where owner_id=$1 and state=\'pending\' order by updated_at desc,request_id',[ownerId])).rows
  return rows.map(row=>read(row as Record<string,unknown>))
 }
 async readForRecovery(ownerId:string,requestId:string):Promise<PendingRequestRecovery>{
  if(!uuid(requestId))invalid('待恢复请求身份无效。')
  const row=(await this.pool.query('select request_id,endpoint,request_spec,created_at,updated_at,last_error_code from teloa_pending_request_registry where owner_id=$1 and request_id=$2 and state=\'pending\'',[ownerId,requestId.toLowerCase()])).rows[0]
  if(!row)throw new WorkError('teloa/not-found','没有待核对的原请求。')
  const base=read(row as Record<string,unknown>),payload=safePayload(row.request_spec)
  if(payload.requestId!==base.requestId)throw new WorkError('teloa/storage-corrupt','待恢复请求身份已损坏。')
  return {...base,payload}
 }
}
