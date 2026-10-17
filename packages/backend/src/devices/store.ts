import {createHash,randomUUID} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,hardwareScopes,hardwareOperationId,readHardwarePrepare,type HardwareBinding,type HardwareOperation,type HardwareResultRef,type HardwareScope} from '@teloa/contract'

const forbidden=()=>new WorkError('teloa/forbidden','此硬件连接或操作不属于当前授权。')
const conflict=()=>new WorkError('teloa/conflict','已有待提交请求，请先处理原请求。')
const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
export async function initializeHardwareDevices(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_device_bindings(
  id uuid primary key,owner_id text not null,installation_id text not null,record jsonb not null,
  unique(owner_id,installation_id)
 );
 create table if not exists teloa_device_inputs(
  id uuid primary key,binding_id uuid not null references teloa_device_bindings(id),
  native_request_id uuid not null unique,record jsonb not null
 );
 alter table teloa_device_inputs add column if not exists position bigint generated always as identity;
 create index if not exists teloa_device_inputs_binding on teloa_device_inputs(binding_id);
`)}
type Identity={ownerId:string;installationId:string;now?:()=>string}
/** 实例固定本人及安装；设备 payload 无法更换这两个条件。 */
export function createHardwareStore(pool:Pool,identity:Identity){
 const {ownerId,installationId}=identity,now=identity.now??(()=>new Date().toISOString())
 if(!ownerId?.trim()||!installationId?.trim())throw forbidden()
 const readBinding=async(id:string,db:Pick<PoolClient,'query'>=pool,lock=false):Promise<HardwareBinding>=>{
  if(!hardwareOperationId(id))throw forbidden()
  const row=(await db.query(`select record from teloa_device_bindings where id=$1 and owner_id=$2 and installation_id=$3${lock?' for update':''}`,[id,ownerId,installationId])).rows[0]
  if(!row)throw forbidden()
  const binding=row.record as HardwareBinding
  if(binding.id!==id||binding.ownerId!==ownerId||binding.installationId!==installationId||!Number.isSafeInteger(binding.grantVersion)||binding.grantVersion<1||!Array.isArray(binding.scopes)||binding.scopes.some(x=>!hardwareScopes.includes(x)))throw forbidden()
  return binding
 }
 const readOperation=(record:HardwareOperation):HardwareOperation=>{
  if(!hardwareOperationId(record.id)||!hardwareOperationId(record.nativeRequestId)||digest(record.text)!==record.textDigest)throw new WorkError('teloa/storage-corrupt','硬件请求记录无法核对。')
  return record
 }
 const get=async(bindingId:string,operationId?:string):Promise<HardwareOperation|null>=>{
  await readBinding(bindingId)
  if(operationId!==undefined&&!hardwareOperationId(operationId))throw forbidden()
  const row=(await pool.query(`select record from teloa_device_inputs where binding_id=$1${operationId?' and id=$2':''} order by position desc limit 1`,operationId?[bindingId,operationId]:[bindingId])).rows[0]
  return row?readOperation(row.record):null
 }
 const ownedOperation=async(id:string,db:Pick<PoolClient,'query'>=pool):Promise<HardwareOperation>=>{
  if(!hardwareOperationId(id))throw forbidden()
  const row=(await db.query('select i.record from teloa_device_inputs i join teloa_device_bindings b on b.id=i.binding_id where i.id=$1 and b.owner_id=$2 and b.installation_id=$3',[id,ownerId,installationId])).rows[0]
  if(!row)throw forbidden()
  return readOperation(row.record)
 }
 const transaction=async<T>(body:(db:PoolClient)=>Promise<T>):Promise<T>=>{
  const db=await pool.connect()
  try{await db.query('begin');const value=await body(db);await db.query('commit');return value}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 const retirePrepared=async(db:PoolClient,bindingId:string)=>{
  await db.query(`update teloa_device_inputs set record=jsonb_set(record,'{state}','"rejected"') where binding_id=$1 and record->>'state'='prepared'`,[bindingId])
 }
 return Object.freeze({
  readBinding,get,ownedOperation,
  async nativeRequestIds():Promise<string[]>{
   const rows=(await pool.query('select i.record from teloa_device_inputs i join teloa_device_bindings b on b.id=i.binding_id where b.owner_id=$1 and b.installation_id=$2 order by i.position',[ownerId,installationId])).rows
   return rows.map(row=>readOperation(row.record).nativeRequestId)
  },
  async current():Promise<HardwareBinding|null>{const row=(await pool.query('select id from teloa_device_bindings where owner_id=$1 and installation_id=$2',[ownerId,installationId])).rows[0];return row?readBinding(row.id):null},
  async bind(input:{assistantSessionId:string;contextVersion:number}):Promise<HardwareBinding>{
   if(!/^[A-Za-z0-9_-]{1,128}$/.test(input.assistantSessionId)||!Number.isSafeInteger(input.contextVersion)||input.contextVersion<1)throw forbidden()
   const record:HardwareBinding={id:randomUUID(),ownerId,installationId,transport:'xiaozhi-mcp',...input,grantVersion:1,status:'active',scopes:[...hardwareScopes]}
   await pool.query('insert into teloa_device_bindings(id,owner_id,installation_id,record) values($1,$2,$3,$4) on conflict(owner_id,installation_id) do nothing',[record.id,ownerId,installationId,record])
   const current=(await pool.query('select record from teloa_device_bindings where owner_id=$1 and installation_id=$2',[ownerId,installationId])).rows[0]!.record as HardwareBinding
   if(current.assistantSessionId!==input.assistantSessionId||current.contextVersion!==input.contextVersion)throw forbidden()
   return current
  },
  async prepare(bindingId:string,value:string):Promise<HardwareOperation>{
   const {text}=readHardwarePrepare({text:value})
   return transaction(async db=>{
    const binding=await readBinding(bindingId,db,true),stamp=now()
    if(binding.status!=='active'||!binding.scopes.includes('assistant.send'))throw forbidden()
    await db.query(`update teloa_device_inputs set record=jsonb_set(record,'{state}','"rejected"') where binding_id=$1 and record->>'state'='prepared' and (record->>'expiresAt')::timestamptz<=$2::timestamptz`,[bindingId,stamp])
    const pending=(await db.query("select record from teloa_device_inputs where binding_id=$1 and record->>'state'='prepared'",[bindingId])).rows[0]?.record as HardwareOperation|undefined
    if(pending){if(pending.textDigest!==digest(text)||pending.grantVersion!==binding.grantVersion)throw conflict();return readOperation(pending)}
    const record:HardwareOperation={id:randomUUID(),bindingId,grantVersion:binding.grantVersion,nativeRequestId:randomUUID(),text,textDigest:digest(text),state:'prepared',createdAt:stamp,expiresAt:new Date(Date.parse(stamp)+300000).toISOString(),resultRef:null}
    await db.query('insert into teloa_device_inputs(id,binding_id,native_request_id,record) values($1,$2,$3,$4)',[record.id,bindingId,record.nativeRequestId,record])
    return record
   })
  },
  async markDispatching(id:string):Promise<boolean>{
   const op=await ownedOperation(id)
   return transaction(async db=>{
    const binding=await readBinding(op.bindingId,db,true)
    if(binding.status!=='active'||binding.grantVersion!==op.grantVersion||!binding.scopes.includes('assistant.send'))return false
    const updated=await db.query(`update teloa_device_inputs set record=jsonb_set(record,'{state}','"dispatching"') where id=$1 and record->>'state'='prepared' and (record->>'expiresAt')::timestamptz>$2::timestamptz returning id`,[id,now()])
    return updated.rowCount===1
   })
  },
  async recordReceipt(id:string,value:{state:'accepted'|'unknown'|'rejected';resultRef:HardwareResultRef|null}):Promise<void>{
   await ownedOperation(id)
   if(!['accepted','unknown','rejected'].includes(value.state)||value.resultRef!==null&&(value.resultRef.nativeRequestId!==(await ownedOperation(id)).nativeRequestId||!Number.isSafeInteger(value.resultRef.endSeq)))throw forbidden()
   await pool.query(`update teloa_device_inputs set record=record||$2::jsonb where id=$1 and record->>'state' in ('dispatching','unknown','accepted') and not(record->>'state'='accepted' and $3<>'accepted')`,[id,JSON.stringify(value),value.state])
  },
  async updateGrant(id:string,scopes:readonly HardwareScope[]):Promise<HardwareBinding>{
   if(!Array.isArray(scopes)||scopes.some(x=>!hardwareScopes.includes(x))||new Set(scopes).size!==scopes.length)throw forbidden()
   return transaction(async db=>{const binding=await readBinding(id,db,true),updated:HardwareBinding={...binding,grantVersion:binding.grantVersion+1,status:'active',scopes:[...scopes]};await db.query('update teloa_device_bindings set record=$2 where id=$1',[id,updated]);await retirePrepared(db,id);return updated})
  },
  async revoke(id:string):Promise<void>{
   await transaction(async db=>{const binding=await readBinding(id,db,true);if(binding.status==='revoked')return;await db.query('update teloa_device_bindings set record=$2 where id=$1',[id,{...binding,status:'revoked',grantVersion:binding.grantVersion+1}]);await retirePrepared(db,id)})
  },
 })
}
export type HardwareStore=ReturnType<typeof createHardwareStore>
