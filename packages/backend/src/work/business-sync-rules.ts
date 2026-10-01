import type {Pool,PoolClient} from 'pg'
import {WorkError,isBusinessScopeKey,type BusinessSyncRuleState} from '@teloa/contract'
import {lockBusinessConfiguration} from './business-configuration-lock.ts'
import {BusinessRuntimeGateError,lockBusinessRuntime} from './business-runtime.ts'

export type BusinessSyncRuleActor={ownerId:string;scopeIds:string[]}
export type {BusinessSyncRuleState} from '@teloa/contract'
export type BusinessSyncRuleSetInput={scope:string;mappingId:string;enabled:boolean;expectedRevision:number;requestId:string}
export type BusinessSyncRuleDefinition={definitionHash:string;managed:boolean}
/** 只从已生效定义与已验证的业务运行标记读取，不能使用客户端传来的摘要或受管状态。 */
export type BusinessSyncRuleResolver=(db:PoolClient,ownerId:string,scope:string,mappingId:string)=>Promise<BusinessSyncRuleDefinition|undefined>

const mappingPattern=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
const hashPattern=/^[a-f0-9]{64}$/
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const conflict=()=>new BusinessRuntimeGateError('teloa/conflict','业务规则已暂停或运行修订已变化，本次执行已停止。')
const corrupt=()=>new BusinessRuntimeGateError('teloa/storage-corrupt','业务规则状态或声明摘要损坏，已停止自动执行。')
const invalid=()=>new WorkError('teloa/invalid-input','业务规则启停参数不正确。')
const forbidden=()=>new WorkError('teloa/forbidden','当前主体未获准操作此业务规则。')

export async function initializeBusinessSyncRules(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_business_sync_rules(
  owner_id text not null,scope_id text not null,mapping_id text not null,definition_hash text not null,
  enabled boolean not null,revision bigint not null check(revision>0 and revision<=9007199254740991),updated_at timestamptz not null,
  primary key(owner_id,scope_id,mapping_id),
  foreign key(owner_id,scope_id) references teloa_business_scopes(owner_id,scope));
 create table if not exists teloa_business_sync_rule_requests(
  owner_id text not null,request_id uuid not null,request_spec jsonb not null,result jsonb not null,created_at timestamptz not null,
  primary key(owner_id,request_id));`)
}

function authorize(actor:BusinessSyncRuleActor,scope:string):void{
 if(typeof actor?.ownerId!=='string'||!actor.ownerId.trim()||actor.ownerId!==actor.ownerId.trim()||actor.ownerId.length>128||/[\x00-\x1f\x7f]/.test(actor.ownerId)||
  !isBusinessScopeKey(scope)||scope==='general'||!Array.isArray(actor.scopeIds)||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(value=>!isBusinessScopeKey(value))||!actor.scopeIds.includes(scope))throw forbidden()
}
function readInput(value:BusinessSyncRuleSetInput):BusinessSyncRuleSetInput{
 if(!value||Object.keys(value).length!==5||!Object.hasOwn(value,'scope')||!Object.hasOwn(value,'mappingId')||!Object.hasOwn(value,'enabled')||!Object.hasOwn(value,'expectedRevision')||!Object.hasOwn(value,'requestId')||
  !isBusinessScopeKey(value.scope)||value.scope==='general'||typeof value.mappingId!=='string'||!mappingPattern.test(value.mappingId)||typeof value.enabled!=='boolean'||
  !Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0||typeof value.requestId!=='string'||!uuidPattern.test(value.requestId))throw invalid()
 return {...value,requestId:value.requestId.toLowerCase()}
}
function readState(value:unknown):BusinessSyncRuleState{
 if(!value||typeof value!=='object'||Array.isArray(value))throw corrupt()
 const row=value as Record<string,unknown>
 if(Object.keys(row).length!==5||!isBusinessScopeKey(row.scope)||row.scope==='general'||typeof row.mappingId!=='string'||!mappingPattern.test(row.mappingId)||
  typeof row.definitionHash!=='string'||!hashPattern.test(row.definitionHash)||typeof row.enabled!=='boolean'||!Number.isSafeInteger(row.revision)||Number(row.revision)<0)throw corrupt()
 return row as BusinessSyncRuleState
}

export class BusinessSyncRuleService{
 private readonly resolve:BusinessSyncRuleResolver
 private readonly pool:Pool
 private readonly identity:{now:()=>string}
 constructor(pool:Pool,identity:{now:()=>string},resolve:BusinessSyncRuleResolver){this.pool=pool;this.identity=identity;this.resolve=resolve}

 private async definition(db:PoolClient,ownerId:string,scope:string,mappingId:string):Promise<BusinessSyncRuleDefinition|undefined>{
  const value=await this.resolve(db,ownerId,scope,mappingId)
  if(value===undefined)return undefined
  if(!value||typeof value.managed!=='boolean'||typeof value.definitionHash!=='string'||!hashPattern.test(value.definitionHash))throw corrupt()
  return value
 }
 private async state(db:PoolClient,ownerId:string,scope:string,mappingId:string,definition:BusinessSyncRuleDefinition,lock=false):Promise<BusinessSyncRuleState>{
  const row=(await db.query('select definition_hash,enabled,revision from teloa_business_sync_rules where owner_id=$1 and scope_id=$2 and mapping_id=$3'+(lock?' for update':''),[ownerId,scope,mappingId])).rows[0]
  if(!row)return {scope,mappingId,definitionHash:definition.definitionHash,enabled:!definition.managed,revision:0}
  const revision=Number(row.revision)
  if(typeof row.definition_hash!=='string'||!hashPattern.test(row.definition_hash)||typeof row.enabled!=='boolean'||!Number.isSafeInteger(revision)||revision<1)throw corrupt()
  return {scope,mappingId,definitionHash:definition.definitionHash,enabled:row.definition_hash===definition.definitionHash&&row.enabled,revision}
 }
 async get(actor:BusinessSyncRuleActor,input:{scope:string;mappingId:string}):Promise<BusinessSyncRuleState>{
  authorize(actor,input?.scope)
  if(typeof input.mappingId!=='string'||!mappingPattern.test(input.mappingId))throw invalid()
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   const definition=await this.definition(db,actor.ownerId,input.scope,input.mappingId)
   if(!definition)throw new WorkError('teloa/not-found','此业务范围没有这条持续规则。')
   const state=await this.state(db,actor.ownerId,input.scope,input.mappingId,definition)
   await db.query('commit')
   return state
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
 /** 调用方在来源调用和提交边界持有业务运行共享锁，并传入首次领取时固定的修订及摘要。 */
 async assertEnabled(db:PoolClient,ownerId:string,scope:string,mappingId:string,expectedRevision?:number,expectedHash?:string):Promise<BusinessSyncRuleState>{
  const definition=await this.definition(db,ownerId,scope,mappingId)
  if(!definition)throw conflict()
  const state=await this.state(db,ownerId,scope,mappingId,definition)
  if(!state.enabled||(expectedRevision!==undefined&&state.revision!==expectedRevision)||(expectedHash!==undefined&&state.definitionHash!==expectedHash))throw conflict()
  return state
 }
 /** 到期扫描的只读判定；无法确认当前声明时只会拒绝或抛错，绝不默认为可执行。 */
 async allowed(db:PoolClient,ownerId:string,scope:string,mappingId:string):Promise<boolean>{
  const definition=await this.definition(db,ownerId,scope,mappingId)
  return definition!==undefined&&(await this.state(db,ownerId,scope,mappingId,definition)).enabled
 }
 async set(actor:BusinessSyncRuleActor,input:BusinessSyncRuleSetInput):Promise<BusinessSyncRuleState>{
  const checked=readInput(input)
  authorize(actor,checked.scope)
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa.business-sync-rule-request',actor.ownerId,checked.requestId])])
   const prior=(await db.query('select request_spec,result from teloa_business_sync_rule_requests where owner_id=$1 and request_id=$2',[actor.ownerId,checked.requestId])).rows[0]
   if(prior){
    let spec:BusinessSyncRuleSetInput,result:BusinessSyncRuleState
    try{spec=readInput(prior.request_spec);result=readState(prior.result)}catch{throw corrupt()}
    if(spec.scope!==checked.scope||spec.mappingId!==checked.mappingId||spec.enabled!==checked.enabled||spec.expectedRevision!==checked.expectedRevision||spec.requestId!==checked.requestId)throw new WorkError('teloa/conflict','同一启停请求不能改变内容。')
    if(result.scope!==spec.scope||result.mappingId!==spec.mappingId||result.enabled!==spec.enabled||result.revision!==spec.expectedRevision+1)throw corrupt()
    await db.query('commit')
    return result
   }
   await lockBusinessConfiguration(db,actor.ownerId,checked.scope,'shared')
   await lockBusinessRuntime(db,actor.ownerId,checked.scope,'exclusive')
   const definition=await this.definition(db,actor.ownerId,checked.scope,checked.mappingId)
   if(!definition)throw new WorkError('teloa/not-found','此业务范围没有这条持续规则。')
   const state=await this.state(db,actor.ownerId,checked.scope,checked.mappingId,definition,true)
   if(state.revision!==checked.expectedRevision||state.revision>=Number.MAX_SAFE_INTEGER)throw conflict()
   const result:BusinessSyncRuleState={...state,enabled:checked.enabled,revision:state.revision+1}
   const timestamp=this.identity.now()
   await db.query(`insert into teloa_business_sync_rules(owner_id,scope_id,mapping_id,definition_hash,enabled,revision,updated_at)
    values($1,$2,$3,$4,$5,$6,$7) on conflict(owner_id,scope_id,mapping_id)
    do update set definition_hash=excluded.definition_hash,enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at`,[actor.ownerId,checked.scope,checked.mappingId,result.definitionHash,result.enabled,result.revision,timestamp])
   await db.query('insert into teloa_business_sync_rule_requests(owner_id,request_id,request_spec,result,created_at) values($1,$2,$3,$4,$5)',[actor.ownerId,checked.requestId,JSON.stringify(checked),JSON.stringify(result),timestamp])
   await db.query('commit')
   return result
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
}
