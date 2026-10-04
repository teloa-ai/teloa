import type {Pool,PoolClient} from 'pg'
import {WorkError,isBusinessScopeKey,taskInput,readBusinessRuntimeState,readBusinessRuntimeSetSyncInput,type BusinessRuntimeState,type BusinessRuntimeSetSyncInput} from '@teloa/contract'

export type BusinessRuntimeActor={ownerId:string;scopeIds:string[]}
/** 门控失败不代表来源失败：同步器据此退出，不增加来源退避。 */
export class BusinessRuntimeGateError extends WorkError{}
const corrupt=()=>new BusinessRuntimeGateError('teloa/storage-corrupt','业务运行状态损坏，已停止自动同步。')
const conflict=()=>new BusinessRuntimeGateError('teloa/conflict','业务同步已暂停或运行修订已变化，本次结果不再采用。')
const invalid=()=>new WorkError('teloa/invalid-input','业务范围未登记为受管业务。')
function owner(value:string):void{
 if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>128||/[\x00-\x1f\x7f]/.test(value))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
}
function scopeKey(value:string):void{if(!isBusinessScopeKey(value)||value==='general')throw invalid()}
function authorize(actor:BusinessRuntimeActor,scope:string):void{
 owner(actor?.ownerId);scopeKey(scope)
 if(!Array.isArray(actor.scopeIds)||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(value=>!isBusinessScopeKey(value))||!actor.scopeIds.includes(scope))throw new WorkError('teloa/forbidden','当前主体未获准操作此业务范围。')
}
/** 与来源调用共享同一锁键；调用方已有配置锁时，顺序恒为配置 → 运行 → 行。 */
export async function lockBusinessRuntime(db:PoolClient,ownerId:string,scope:string,mode:'exclusive'|'shared'|'session-shared'|'session-unlock'):Promise<void>{
 const operation={exclusive:'pg_advisory_xact_lock',shared:'pg_advisory_xact_lock_shared','session-shared':'pg_advisory_lock_shared','session-unlock':'pg_advisory_unlock_shared'}[mode]
 const result=await db.query('select '+operation+'(hashtextextended($1,0)) as locked',[JSON.stringify(['teloa.business-runtime',ownerId,scope])])
 if(mode==='session-unlock'&&result.rows[0]?.locked!==true)throw corrupt()
}
export async function initializeBusinessRuntime(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_business_runtime(
  owner_id text not null,scope_id text not null,sync_enabled boolean not null,revision bigint not null check(revision>0 and revision<=9007199254740991),
  updated_at timestamptz not null,primary key(owner_id,scope_id),
  foreign key(owner_id,scope_id) references teloa_business_scopes(owner_id,scope));
 create table if not exists teloa_business_runtime_requests(
  owner_id text not null,request_id uuid not null,request_spec jsonb not null,result jsonb not null,created_at timestamptz not null,
  primary key(owner_id,request_id));`)
}
/** 同一条查询核对身份与值；先探测表，避免兼容读取把事务弄成失败状态。 */
async function readState(db:PoolClient,ownerId:string,scope:string):Promise<BusinessRuntimeState>{
 const tables=(await db.query("select to_regclass('teloa_business_scopes') as scopes,to_regclass('teloa_business_runtime') as runtime")).rows[0]
 const marker=tables.scopes?"(select jsonb_build_object('present',to_jsonb(s)?'runtime_managed','value',to_jsonb(s)->'runtime_managed') from teloa_business_scopes s where owner_id=$1 and scope=$2)":"null"
 const runtime=tables.runtime?"(select jsonb_build_object('enabled',sync_enabled,'revision',revision) from teloa_business_runtime where owner_id=$1 and scope_id=$2)":"null"
 const row=(await db.query('select '+marker+' as marker,'+runtime+' as runtime where $1::text is not null and $2::text is not null',[ownerId,scope])).rows[0]
 if(row.marker!==null&&row.marker.present&&typeof row.marker.value!=='boolean')throw corrupt()
 const managed=row.marker?.value===true
 if(!managed){if(row.runtime!==null)throw corrupt();return {scope,managed:false,syncEnabled:true,revision:0}}
 if(row.runtime===null)throw corrupt()
 try{return readBusinessRuntimeState({scope,managed:true,syncEnabled:row.runtime.enabled,revision:row.runtime.revision})}catch{throw corrupt()}
}
/** 同一数据库快照中读取经过旧范围兼容与受管行完整性核对的运行状态。 */
export const businessRuntimeStateInTransaction=readState
export async function assertScheduledSync(db:PoolClient,ownerId:string,scope:string,expectedRevision?:number):Promise<BusinessRuntimeState>{
 const state=await readState(db,ownerId,scope)
 if(!state.syncEnabled||(expectedRevision!==undefined&&state.revision!==expectedRevision))throw conflict()
 return state
}
export async function scheduledSyncAllowed(db:PoolClient,ownerId:string,scope:string):Promise<boolean>{
 return (await readState(db,ownerId,scope)).syncEnabled
}
/** 来源 Promise 当场接住成功与拒绝；解锁后才等待网络。 */
export async function invokeScheduledSync<T>(db:PoolClient,ownerId:string,scope:string,revision:number,invoke:()=>Promise<T>,broken:(error:Error)=>void,check?:()=>Promise<void>):Promise<T>{
 let pending:Promise<{ok:true;value:T}|{ok:false;error:unknown}>
 // 加锁回包丢失时持锁状态同样未知，不能把连接重新交给池。
 try{await lockBusinessRuntime(db,ownerId,scope,'session-shared')}
 catch(error){broken(error instanceof Error?error:Error('业务运行锁获取失败'));throw new BusinessRuntimeGateError('teloa/dependency-unavailable','业务运行锁状态未知，连接已隔离。')}
 try{
  await assertScheduledSync(db,ownerId,scope,revision)
  await check?.()
  pending=invoke().then(value=>({ok:true as const,value}),error=>({ok:false as const,error}))
 }finally{
  try{await lockBusinessRuntime(db,ownerId,scope,'session-unlock')}
  catch(error){broken(error instanceof Error?error:Error('业务运行锁释放失败'));throw new BusinessRuntimeGateError('teloa/dependency-unavailable','业务运行锁释放失败，连接已隔离。')}
 }
 const result=await pending
 if(!result.ok)throw result.error
 return result.value
}
export class BusinessRuntimeService{
 private readonly pool:Pool
 private readonly identity:{now:()=>string}
 constructor(pool:Pool,identity:{now:()=>string}){this.pool=pool;this.identity=identity}
 /** 调用方拥有事务；登记只能升级真实范围，既有受管行绝不被重置。 */
 async registerInTransaction(db:PoolClient,ownerId:string,scope:string):Promise<BusinessRuntimeState>{
  owner(ownerId);scopeKey(scope)
  await lockBusinessRuntime(db,ownerId,scope,'exclusive')
  const row=(await db.query('select runtime_managed from teloa_business_scopes where owner_id=$1 and scope=$2 for update',[ownerId,scope])).rows[0]
  if(!row)throw invalid()
  const previous=await readState(db,ownerId,scope)
  if(previous.managed)return previous
  await db.query('insert into teloa_business_runtime(owner_id,scope_id,sync_enabled,revision,updated_at) values($1,$2,false,1,$3)',[ownerId,scope,this.identity.now()])
  await db.query('update teloa_business_scopes set runtime_managed=true where owner_id=$1 and scope=$2',[ownerId,scope])
  return {scope,managed:true,syncEnabled:false,revision:1}
 }
 async get(actor:BusinessRuntimeActor,scope:string):Promise<BusinessRuntimeState>{
  authorize(actor,scope)
  const db=await this.pool.connect()
  try{await db.query('begin isolation level repeatable read read only');const result=await readState(db,actor.ownerId,scope);await db.query('commit');return result}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async setSync(actor:BusinessRuntimeActor,input:BusinessRuntimeSetSyncInput):Promise<BusinessRuntimeState>{
  const checked=readBusinessRuntimeSetSyncInput(input);authorize(actor,checked.scope)
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   // 请求锁先于范围锁，同本人跨范围复用请求也只生成一份回执。
   await this.lockRequest(db,actor.ownerId,checked.requestId)
   const previous=await this.request(db,actor.ownerId,checked.requestId)
   if(previous){
    const {spec,result}=previous
    if(JSON.stringify(spec)!==JSON.stringify(checked))throw new WorkError('teloa/conflict','同一启停请求不能改变内容。')
    await db.query('commit');return result
   }
   await lockBusinessRuntime(db,actor.ownerId,checked.scope,'exclusive')
   const state=await readState(db,actor.ownerId,checked.scope)
   if(!state.managed)throw invalid()
   const result=await this.writeSync(db,actor.ownerId,checked,state)
   await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /**
  * 导入等维护入口在启动调度前调用：同一事务登记旧范围并暂停自动同步与看板刷新，声明与成果不动。
  * 使用既有启停回执；同请求重放不再次暂停本人后来明确开启的工作。
  */
 async pauseScheduledWork(actor:BusinessRuntimeActor,input:{scope:string;requestId:string}):Promise<BusinessRuntimeState>{
  const row=taskInput(input,['scope','requestId'])
  // 复用启停输入的身份校验；期望修订由持锁后的真实状态取得，不信任调用方。
  const validated=readBusinessRuntimeSetSyncInput({...row,enabled:false,expectedRevision:1})
  authorize(actor,validated.scope)
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   await this.lockRequest(db,actor.ownerId,validated.requestId)
   const previous=await this.request(db,actor.ownerId,validated.requestId)
   if(previous){
    if(previous.spec.scope!==validated.scope||previous.spec.enabled)throw new WorkError('teloa/conflict','同一启停请求不能改变内容。')
    await db.query('commit');return previous.result
   }
   const state=await this.registerInTransaction(db,actor.ownerId,validated.scope)
   const checked={...validated,expectedRevision:state.revision}
   const result=await this.writeSync(db,actor.ownerId,checked,state)
   await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 private async lockRequest(db:PoolClient,ownerId:string,requestId:string):Promise<void>{
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa.business-runtime-request',ownerId,requestId])])
 }
 private async request(db:PoolClient,ownerId:string,requestId:string):Promise<{spec:BusinessRuntimeSetSyncInput;result:BusinessRuntimeState}|undefined>{
  const previous=(await db.query('select request_spec,result from teloa_business_runtime_requests where owner_id=$1 and request_id=$2',[ownerId,requestId])).rows[0]
  if(!previous)return undefined
  let spec:BusinessRuntimeSetSyncInput,result:BusinessRuntimeState
  try{spec=readBusinessRuntimeSetSyncInput(previous.request_spec);result=readBusinessRuntimeState(previous.result)}catch{throw corrupt()}
  if(spec.requestId!==requestId||!result.managed||result.scope!==spec.scope||result.syncEnabled!==spec.enabled||result.revision!==spec.expectedRevision+1)throw corrupt()
  return {spec,result}
 }
 private async writeSync(db:PoolClient,ownerId:string,checked:BusinessRuntimeSetSyncInput,state:BusinessRuntimeState):Promise<BusinessRuntimeState>{
  if(state.revision!==checked.expectedRevision||state.revision>=Number.MAX_SAFE_INTEGER)throw new WorkError('teloa/conflict','业务运行修订已变化，请重新读取。')
  const now=this.identity.now(),result={...state,syncEnabled:checked.enabled,revision:state.revision+1}
  await db.query('update teloa_business_runtime set sync_enabled=$3,revision=$4,updated_at=$5 where owner_id=$1 and scope_id=$2',[ownerId,checked.scope,result.syncEnabled,result.revision,now])
  await db.query('insert into teloa_business_runtime_requests(owner_id,request_id,request_spec,result,created_at) values($1,$2,$3,$4,$5)',[ownerId,checked.requestId,JSON.stringify(checked),JSON.stringify(result),now])
  return result
 }
}
