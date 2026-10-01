import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {
 WorkError,assertNoCredentialKeys,pageCreateCanonicalBody,pageCreateEntities,pageCreateLimits,readPageCreateBody,taskInput,
 type PageCreateBodyReaders,type PageCreateDraft,type PageCreateDraftDirectory,type PageCreateEntity,
} from '@teloa/contract'
import {validateManifest} from '../market/content-store.ts'
import {BusinessScopeService} from './business-scopes.ts'

export type PageCreateActor={ownerId:string;scopeIds:string[]}
export type PageCreateDraftInput={entity:PageCreateEntity;scope?:string;body:unknown;requestId:string}
export type PageCreateReaders=PageCreateBodyReaders

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const stamp=(value:unknown):value is Date=>value instanceof Date&&Number.isFinite(value.getTime())
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex')
const invalid=(message:string)=>new WorkError('teloa/invalid-input',message)
const forbidden=(message:string)=>new WorkError('teloa/forbidden',message)
const conflict=(message:string)=>new WorkError('teloa/conflict',message)
const versionConflict=(message:string)=>new WorkError('teloa/version-conflict',message)
const corrupt=(message:string)=>new WorkError('teloa/storage-corrupt',message)

function actorValue(actor:PageCreateActor):void{
 if(!text(actor?.ownerId,128)||!Array.isArray(actor.scopeIds)||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(scope=>!scopeValue(scope)))throw forbidden('需要有效的本人身份与业务范围。')
}

function scopeValue(value:unknown):value is string{return text(value,120)&&value!=='general'&&!/[\r\n]/.test(value)}
function entityValue(value:unknown):PageCreateEntity{
 if(typeof value!=='string'||!pageCreateEntities.includes(value as PageCreateEntity))throw invalid('页内新建草案的实体类型不正确。')
 return value as PageCreateEntity
}

// 新业务范围在加载前不属于任何已登记范围，因此不能按「本人已获准范围」核对；
// 但它终究会被当成 `industry-loads.ts`/`content-store.ts` 里的范围键，键格式必须先在这里挡住。
const scopeKeyPattern=/^[a-zA-Z0-9_-]{1,64}$/
function requireScope(entity:PageCreateEntity,scope:unknown):string|undefined{
 if(entity==='role'||entity==='skill'||entity==='extension'){
  if(scope!==undefined)throw invalid('此类新建草案不接受业务范围。')
  return undefined
 }
 if(!scopeValue(scope))throw invalid('需要明确的业务范围。')
 if(entity==='business-domain'&&!scopeKeyPattern.test(scope))throw invalid('业务范围只能是 1–64 位字母、数字、下划线或连字符。')
 return scope
}

function titleOf(entity:PageCreateEntity,value:unknown):string{
 if(typeof value!=='object'||value===null||Array.isArray(value))throw corrupt('页内新建草案正文损坏，已停止读取。')
 const row=value as Record<string,unknown>
 const title=entity==='role'?row.name
  :entity==='extension'?typeof row.packageName==='string'&&typeof row.version==='string'?row.packageName+' @ '+row.version:undefined
   :entity==='business-domain'?((row.manifest as Record<string,unknown>|undefined)?.title)
    :entity==='connector'?((row.resource as Record<string,unknown>|undefined)?.sourceId??(row.resource as Record<string,unknown>|undefined)?.id)
     :entity==='business-definition'?row.title
      :row.title
 if(!text(title,240))throw corrupt('页内新建草案标题损坏，已停止读取。')
 return title
}

function storedDraft(row:Record<string,unknown>,readers:PageCreateReaders):PageCreateDraft{
 if(!uuid(row.id)||!text(row.owner_id,128)||!uuid(row.request_id)||typeof row.body!=='string'||!digest(row.body_hash)||!text(row.title,240)||!stamp(row.created_at)||!stamp(row.updated_at))throw corrupt('页内新建草案记录损坏，已停止读取。')
 let entity:PageCreateEntity,scope:string|undefined
 try{
  entity=entityValue(row.entity)
  scope=requireScope(entity,row.scope_id===null?undefined:row.scope_id)
 }catch{throw corrupt('页内新建草案实体或范围损坏，已停止读取。')}
 const status=row.status
 if(status!=='draft'&&status!=='applied'&&status!=='discarded')throw corrupt('页内新建草案状态损坏，已停止读取。')
 const appliedRef=typeof row.applied_ref==='string'?row.applied_ref:undefined
 if((status==='applied')!==text(appliedRef,200)||status==='discarded'&&appliedRef!==undefined)throw corrupt('页内新建草案状态与落地记录不一致，已停止读取。')
 let body:unknown
 try{body=JSON.parse(row.body);assertNoCredentialKeys(body);body=readPageCreateBody(entity,body,{manifest:validateManifest,...readers})}catch(error){
  if(error instanceof WorkError&&error.code==='teloa/dependency-unavailable')throw error
  throw corrupt('页内新建草案正文损坏，已停止读取。')
 }
 const canonical=pageCreateCanonicalBody(body)
 if(canonical!==row.body||sha256(canonical)!==row.body_hash||titleOf(entity,body)!==row.title)throw corrupt('页内新建草案正文摘要或标题不一致，已停止读取。')
 return {id:row.id,ownerId:row.owner_id,requestId:row.request_id,entity,...(scope===undefined?{}:{scope}),body:row.body,bodyHash:row.body_hash,title:row.title,status,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),...(appliedRef===undefined?{}:{appliedRef})}
}

/** 页内新建草案：会话只写这一张表，确认阶段仅标记结果，实体仍由既有写路径创建。 */
export async function initializePageCreateDrafts(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_page_create_drafts (
  owner_id text not null,id uuid not null,request_id uuid not null,
  entity text not null check(entity in ('business-definition','business-domain','role','skill','connector','extension')),
  scope_id text,title text not null,body text not null,body_hash text not null check(body_hash~'^[a-f0-9]{64}$'),
  status text not null check(status in ('draft','applied','discarded')),applied_ref text,
  created_at timestamptz not null,updated_at timestamptz not null,
  primary key(owner_id,id),unique(owner_id,request_id),
  check((status='applied')=(applied_ref is not null)),
  check((entity in ('business-definition','business-domain','connector'))=(scope_id is not null))
 )`)
}

export class PageCreateDraftService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 readonly readers:PageCreateReaders
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},readers:PageCreateReaders={}){this.pool=pool;this.identity=identity;this.readers=readers}

 async draft(actor:PageCreateActor,input:PageCreateDraftInput,signal?:AbortSignal):Promise<PageCreateDraft>{
  actorValue(actor)
  const row=taskInput(input,['entity','scope','body','requestId']),entity=entityValue(row.entity),scope=requireScope(entity,row.scope)
  if(!uuid(row.requestId))throw invalid('页内新建草案的请求身份不正确。')
  if((entity==='business-definition'||entity==='connector')&&(!actor.scopeIds.includes(scope!)||!await BusinessScopeService.registered(this.pool,actor.ownerId,scope!)))throw forbidden('当前主体未获准在此业务范围创建草案。')
  // 新业务范围还没有登记，草案阶段只校验名称；真正登记由后续既有加载路径负责。
  assertNoCredentialKeys(row.body)
  const bodyValue=readPageCreateBody(entity,row.body,{manifest:validateManifest,...this.readers})
  if(entity==='business-domain'&&((bodyValue as {manifest:{scope?:unknown}}).manifest.scope!==scope))throw invalid('新业务清单的加载范围与目标范围不一致。')
  const body=pageCreateCanonicalBody(bodyValue),bodyHash=sha256(body),title=titleOf(entity,bodyValue),requestId=(row.requestId as string).toLowerCase(),id=this.identity.id(),now=this.identity.now()
  if(!uuid(id))throw invalid('页内新建草案身份生成失败。')
  signal?.throwIfAborted()
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['page-create-request',actor.ownerId,requestId])])
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['page-create-drafts',actor.ownerId,entity,scope??''])])
   const count=Number((await db.query(`select count(*)::int total from teloa_page_create_drafts where owner_id=$1 and entity=$2 and scope_id is not distinct from $3 and status='draft' and request_id<>$4`,[actor.ownerId,entity,scope??null,requestId])).rows[0]?.total)
   if(!Number.isSafeInteger(count))throw corrupt('页内新建草案目录计数损坏，已停止写入。')
   if(count>=pageCreateLimits.draftsPerEntity)throw conflict('此处待确认的新建草案已达 '+pageCreateLimits.draftsPerEntity+' 条，请先确认或丢弃一条。')
   const saved=(await db.query(`insert into teloa_page_create_drafts(owner_id,id,request_id,entity,scope_id,title,body,body_hash,status,applied_ref,created_at,updated_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,'draft',null,$9,$9)
    on conflict(owner_id,request_id) do update set entity=excluded.entity,scope_id=excluded.scope_id,title=excluded.title,body=excluded.body,body_hash=excluded.body_hash,updated_at=excluded.updated_at
    where teloa_page_create_drafts.status='draft' returning *`,[actor.ownerId,id,requestId,entity,scope??null,title,body,bodyHash,now])).rows[0]
   if(!saved)throw conflict('同一条指令派生的新建草案已经落定，不能再改写。')
   const result=storedDraft(saved,this.readers)
   await db.query('commit')
   return result
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 async directory(actor:PageCreateActor,input:unknown,signal?:AbortSignal):Promise<PageCreateDraftDirectory>{
  actorValue(actor)
  const row=taskInput(input,['entity','scope']),entity=entityValue(row.entity),scope=requireScope(entity,row.scope)
  if((entity==='business-definition'||entity==='connector')&&(!actor.scopeIds.includes(scope!)||!await BusinessScopeService.registered(this.pool,actor.ownerId,scope!)))throw forbidden('当前主体未获准读取此业务范围的新建草案。')
  // 业务范围本就是加载后才登记：这里只挡键格式，不核对「本人已获准范围」；已经登记过的键改走「新增业务定义」。
  if(entity==='business-domain'&&scope!==undefined&&actor.scopeIds.includes(scope))throw conflict('该业务范围已存在，请改用页内「新增业务定义」。')
  signal?.throwIfAborted()
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   const rows=(await db.query(`select * from teloa_page_create_drafts where owner_id=$1 and entity=$2 and scope_id is not distinct from $3 order by case status when 'draft' then 0 else 1 end,updated_at desc,id limit $4`,[actor.ownerId,entity,scope??null,pageCreateLimits.draftsPerEntity])).rows as Array<Record<string,unknown>>
   const drafts=rows.map(row=>storedDraft(row,this.readers))
   await db.query('commit')
   return {schema:'teloa.page-create-drafts/v1',entity,...(scope===undefined?{}:{scope}),readAt:this.identity.now(),drafts}
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 /** D8：既有写路径成功后才调用；这里仅改草案状态，绝不创建任何实体。 */
 async settle(actor:PageCreateActor,input:unknown,signal?:AbortSignal):Promise<PageCreateDraftDirectory>{
  actorValue(actor)
  const row=taskInput(input,['requestId','draftId','expectedBodyHash','outcome','appliedRef'])
  if(!uuid(row.requestId)||!uuid(row.draftId)||!digest(row.expectedBodyHash)||row.outcome!=='applied'&&row.outcome!=='discarded')throw invalid('新建草案确认请求格式不正确。')
  const appliedRef=row.appliedRef
  if(row.outcome==='applied'?!text(appliedRef,200):appliedRef!==undefined)throw invalid(row.outcome==='applied'?'确认生效必须带落地记录。':'丢弃草案不带落地记录。')
  signal?.throwIfAborted()
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   const found=(await db.query('select * from teloa_page_create_drafts where owner_id=$1 and id=$2 for update',[actor.ownerId,row.draftId])).rows[0] as Record<string,unknown>|undefined
   if(!found)throw forbidden('新建草案不存在或不属于当前本人。')
   const draft=storedDraft(found,this.readers)
   if((draft.entity==='business-definition'||draft.entity==='connector')&&(!draft.scope||!actor.scopeIds.includes(draft.scope)))throw forbidden('当前主体未获准确认此业务范围的新建草案。')
   if(draft.status!=='draft'||draft.bodyHash!==row.expectedBodyHash)throw versionConflict('新建草案已变化，请重新预览后再确认。')
   const updated=(await db.query(`update teloa_page_create_drafts set status=$3,applied_ref=$4,updated_at=$5 where owner_id=$1 and id=$2 returning *`,[actor.ownerId,draft.id,row.outcome,appliedRef??null,this.identity.now()])).rows[0] as Record<string,unknown>
   // 更新行先按同一套存储判据读回；提交之后才另开只读目录事务，避免目录读到提交前的旧状态。
   const settled=storedDraft(updated,this.readers)
   await db.query('commit')
   return this.directory(actor,{entity:settled.entity,...(settled.scope===undefined?{}:{scope:settled.scope})},signal)
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 async draftInTransaction(db:PoolClient,ownerId:string,draftId:string):Promise<PageCreateDraft>{
  if(!text(ownerId,128)||!uuid(draftId))throw forbidden('新建草案身份不正确。')
  const found=(await db.query('select * from teloa_page_create_drafts where owner_id=$1 and id=$2',[ownerId,draftId])).rows[0] as Record<string,unknown>|undefined
  if(!found)throw forbidden('新建草案不存在或不属于当前本人。')
  return storedDraft(found,this.readers)
 }
}
