import {createHash,randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import {WorkError,hardwareOperationId,readHardwarePrepare,type HardwareOperation,type HardwareResultRef} from '@teloa/contract'

export type DirectDeviceBinding=Readonly<{id:string;ownerId:string;installationId:string;assistantSessionId:string;contextVersion:number;credentialDigest:string;grantVersion:number;status:'active'|'revoked';allowApprovals?:boolean}>
export type DirectDeviceCapture=Omit<HardwareOperation,'state'>&Readonly<{state:'reserved'|'transcribed'|'dispatching'|'accepted'|'unknown'|'discarded'}>
const forbidden=()=>new WorkError('teloa/forbidden','设备请求不属于当前本人、安装或授权。')
type Registration=Pick<DirectDeviceBinding,'id'|'assistantSessionId'|'contextVersion'|'credentialDigest'>&{allowApprovals?:boolean}
const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
/** 物理设备独立记录，不改变官方 MCP 的单绑定和既有数据。凭据只保存摘要。 */
export function createDirectDeviceStore(pool:Pool,identity:{ownerId:string;installationId:string}){
 const {ownerId,installationId}=identity
 if(!ownerId.trim()||!installationId.trim())throw forbidden()
 const binding=async(id:string,db:Pick<Pool,'query'>=pool):Promise<DirectDeviceBinding>=>{
  if(!hardwareOperationId(id))throw forbidden()
  const row=(await db.query('select record from teloa_direct_devices where id=$1 and owner_id=$2 and installation_id=$3',[id,ownerId,installationId])).rows[0]
  if(!row)throw forbidden()
  return row.record
 }
 const get=async(bindingId:string,captureId:string):Promise<DirectDeviceCapture|null>=>{
  await binding(bindingId);if(!hardwareOperationId(captureId))throw forbidden()
  const row=(await pool.query('select record from teloa_direct_captures where binding_id=$1 and capture_id=$2',[bindingId,captureId])).rows[0]
  return row?.record??null
 }
 const active=(b:DirectDeviceBinding)=>{if(b.status!=='active')throw forbidden()}
 const register=async(input:Registration,db:Pick<Pool,'query'>=pool)=>{
   if(!hardwareOperationId(input.id)||!hardwareOperationId(input.assistantSessionId)||!Number.isSafeInteger(input.contextVersion)||input.contextVersion<1||!/^[a-f0-9]{64}$/.test(input.credentialDigest))throw forbidden()
   const record:DirectDeviceBinding={...input,allowApprovals:input.allowApprovals===true,ownerId,installationId,grantVersion:1,status:'active'}
   await db.query('insert into teloa_direct_devices(id,owner_id,installation_id,credential_digest,record) values($1,$2,$3,$4,$5) on conflict(id) do nothing',[input.id,ownerId,installationId,input.credentialDigest,record])
   const current=await binding(input.id,db)
   if(current.assistantSessionId!==input.assistantSessionId||current.contextVersion!==input.contextVersion||current.credentialDigest!==input.credentialDigest||(current.allowApprovals===true)!==(input.allowApprovals===true))throw forbidden()
   return current
 }
 return Object.freeze({binding,get,
  async initialize(){await pool.query(`
   create table if not exists teloa_direct_devices(id uuid primary key,owner_id text not null,installation_id text not null,credential_digest text not null unique,record jsonb not null);
   create table if not exists teloa_direct_captures(binding_id uuid not null references teloa_direct_devices(id),capture_id uuid not null,native_request_id uuid not null unique,record jsonb not null,primary key(binding_id,capture_id));
   create table if not exists teloa_device_pairing_jobs(id uuid primary key,owner_id text not null,installation_id text not null,record jsonb not null);
  `)},
  register,
  async completePairing(job:{id:string;digest?:string},input:Registration){
   const client=await pool.connect()
   try{
    await client.query('begin')
    const stored=(await client.query('select record from teloa_device_pairing_jobs where id=$1 and owner_id=$2 and installation_id=$3 for update',[job.id,ownerId,installationId])).rows[0]?.record
    if(!stored||stored.state!=='ready'||stored.digest!==job.digest||stored.expiresAt<=Date.now()||stored.id!==input.id||stored.assistantSessionId!==input.assistantSessionId||stored.contextVersion!==input.contextVersion||stored.allowApprovals!==(input.allowApprovals===true))throw forbidden()
    active(await register(input,client))
    await client.query('update teloa_device_pairing_jobs set record=$4 where id=$1 and owner_id=$2 and installation_id=$3',[job.id,ownerId,installationId,{...stored,state:'paired'}])
    await client.query('commit')
   }catch(error){await client.query('rollback');throw error}finally{client.release()}
  },
  async list():Promise<DirectDeviceBinding[]>{return (await pool.query('select record from teloa_direct_devices where owner_id=$1 and installation_id=$2',[ownerId,installationId])).rows.map(row=>row.record)},
  async savePairing(job:{id:string}){if(!hardwareOperationId(job.id))throw forbidden();await pool.query('insert into teloa_device_pairing_jobs(id,owner_id,installation_id,record) values($1,$2,$3,$4) on conflict(id) do update set record=excluded.record where teloa_device_pairing_jobs.owner_id=$2 and teloa_device_pairing_jobs.installation_id=$3',[job.id,ownerId,installationId,job])},
  async readPairing(id:string):Promise<unknown>{if(!hardwareOperationId(id))throw forbidden();return (await pool.query('select record from teloa_device_pairing_jobs where id=$1 and owner_id=$2 and installation_id=$3',[id,ownerId,installationId])).rows[0]?.record},
  async hasPairingJobs(){return (await pool.query('select 1 from teloa_device_pairing_jobs where owner_id=$1 and installation_id=$2 limit 1',[ownerId,installationId])).rows.length>0},
  async latestPairing():Promise<unknown>{return (await pool.query("select record from teloa_device_pairing_jobs where owner_id=$1 and installation_id=$2 and record->>'state' in ('awaiting-device','ready') and (record->>'expiresAt')::bigint>$3 order by (record->>'createdAt')::bigint desc limit 1",[ownerId,installationId,Date.now()])).rows[0]?.record},
  async authorize(digest:string):Promise<DirectDeviceBinding|null>{
   const row=(await pool.query('select record from teloa_direct_devices where credential_digest=$1 and owner_id=$2 and installation_id=$3',[digest,ownerId,installationId])).rows[0]
   return row?.record.status==='active'?row.record:null
  },
  async nativeRequestIds():Promise<string[]>{return (await pool.query('select c.native_request_id from teloa_direct_captures c join teloa_direct_devices d on d.id=c.binding_id where d.owner_id=$1 and d.installation_id=$2',[ownerId,installationId])).rows.map(row=>row.native_request_id)},
  async reserve(bindingId:string,captureId:string){
   const b=await binding(bindingId);active(b);if(!hardwareOperationId(captureId))throw forbidden()
   const stamp=new Date().toISOString(),record:DirectDeviceCapture={id:captureId,bindingId,grantVersion:b.grantVersion,nativeRequestId:randomUUID(),text:'',textDigest:hash(''),state:'reserved',createdAt:stamp,expiresAt:new Date(Date.now()+300000).toISOString(),resultRef:null}
   const inserted=await pool.query(`insert into teloa_direct_captures(binding_id,capture_id,native_request_id,record) select $1,$2,$3,$4 from teloa_direct_devices where id=$1 and record->>'status'='active' and (record->>'grantVersion')::int=$5 on conflict do nothing returning capture_id`,[bindingId,captureId,record.nativeRequestId,record,b.grantVersion])
   const stored=await get(bindingId,captureId);if(!stored)throw forbidden()
   return {created:inserted.rowCount===1,record:stored}
  },
  async transcribed(bindingId:string,captureId:string,value:string){
   const {text}=readHardwarePrepare({text:value});await binding(bindingId)
   const updated=await pool.query(`update teloa_direct_captures c set record=c.record||$3::jsonb from teloa_direct_devices d where c.binding_id=$1 and c.capture_id=$2 and d.id=c.binding_id and d.record->>'status'='active' and c.record->>'grantVersion'=d.record->>'grantVersion' and c.record->>'state'='reserved' returning c.capture_id`,[bindingId,captureId,JSON.stringify({text,textDigest:hash(text),state:'transcribed'})])
   if(updated.rowCount!==1)throw forbidden()
  },
  async claim(bindingId:string,captureId:string){
   await binding(bindingId)
   const row=await pool.query(`update teloa_direct_captures c set record=jsonb_set(c.record,'{state}','"dispatching"') from teloa_direct_devices d where c.binding_id=$1 and c.capture_id=$2 and d.id=c.binding_id and d.record->>'status'='active' and c.record->>'grantVersion'=d.record->>'grantVersion' and c.record->>'state'='transcribed' returning c.capture_id`,[bindingId,captureId])
   return row.rowCount===1
  },
  async receipt(bindingId:string,captureId:string,state:'accepted'|'unknown'|'discarded',resultRef:HardwareResultRef|null=null){
   const original=await get(bindingId,captureId);if(!original||resultRef&&resultRef.nativeRequestId!==original.nativeRequestId)throw forbidden()
   await pool.query(`update teloa_direct_captures set record=record||$3::jsonb where binding_id=$1 and capture_id=$2 and not(record->>'state'='accepted' and $4<>'accepted')`,[bindingId,captureId,JSON.stringify({state,resultRef}),state])
  },
  async revoke(id:string){await binding(id);await pool.query(`update teloa_direct_devices set record=record||jsonb_build_object('status','revoked','grantVersion',(record->>'grantVersion')::int+1) where id=$1 and record->>'status'='active'`,[id])},
 })
}
export type DirectDeviceStore=ReturnType<typeof createDirectDeviceStore>
