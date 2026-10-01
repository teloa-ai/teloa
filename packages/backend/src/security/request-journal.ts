import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord} from '@teloa/contract'

export type SecurityIdentity={id:()=>string;now:()=>string}
export type SecurityRequestCommand='propose'|'submit'|'decide'|'withdraw-submission'|'withdraw-approval'|'acknowledge-failure'|'execute'|'observe'

export async function initializeSecurityRequests(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_security_requests(
  owner_id text not null,request_id uuid not null,command text not null,
  request_spec jsonb not null,created_at timestamptz not null,
  primary key(owner_id,request_id),
  check(command in ('propose','submit','decide','withdraw-submission','withdraw-approval','acknowledge-failure','execute','observe')),
  check(jsonb_typeof(request_spec)='object' and request_spec ? 'command' and jsonb_typeof(request_spec->'command')='string' and request_spec->>'command'=command and not(request_spec ? 'requestId'))
 )`)
}

/** 所有安全写命令共用 owner/request 锁，不能按 endpoint 分别加锁。 */
export class SecurityRequestJournal{
 private readonly pool:Pool
 constructor(pool:Pool){this.pool=pool}
 async transaction<T>(work:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect()
  try{await db.query('begin');const result=await work(db);await db.query('commit');return result}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** true 表示同请求已提交，调用方必须严格读取专用结果绑定。 */
 async reserve(db:PoolClient,ownerId:string,requestId:string,command:SecurityRequestCommand,spec:Record<string,unknown>,createdAt:string):Promise<boolean>{
  if(!isRecord(spec)||spec.command!==command||Object.hasOwn(spec,'requestId'))throw new WorkError('teloa/invalid-input','安全请求必须含精确命令，且不得把请求 ID 放入内容。')
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/security-request',ownerId,requestId])])
  const prior=(await db.query('select command,request_spec=$3::jsonb same_spec from teloa_security_requests where owner_id=$1 and request_id=$2',[ownerId,requestId,JSON.stringify(spec)])).rows[0]
  if(prior){if(prior.command!==command||prior.same_spec!==true)throw new WorkError('teloa/conflict','同一安全请求不能用于不同命令或内容。');return true}
  await db.query('insert into teloa_security_requests(owner_id,request_id,command,request_spec,created_at) values($1,$2,$3,$4,$5)',[ownerId,requestId,command,JSON.stringify(spec),createdAt])
  return false
 }
}
