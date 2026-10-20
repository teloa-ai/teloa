import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {
 WorkError,assertPageCreateNoCredentialKeys,pageCreateCanonicalBody,pageCreateEntities,pageCreateLimits,readPageCreateBody,readPageCreateDraftOrigin,readPageCreatePlanDraft,taskInput,
 type PageCreateBodyReaders,type PageCreateDraft,type PageCreateDraftDirectory,type PageCreateEntity,type PageCreateDraftOrigin,type PageCreateDraftRevisionInput,
} from '@teloa/contract'
import {validateManifest} from '../market/content-store.ts'
import {BusinessScopeService} from './business-scopes.ts'

export type PageCreateActor={ownerId:string;scopeIds:string[]}
export type PageCreateDraftInput={entity:PageCreateEntity;scope?:string;body:unknown;requestId:string;origin?:PageCreateDraftOrigin}
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
 if(entity==='role'||entity==='skill'||entity==='extension'||entity==='share'||entity==='plan'||entity==='app'){
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
 const title=entity==='plan'?('definition' in row?(row.definition as Record<string,unknown>)?.title:(row.fields as Record<string,unknown>|undefined)?.title??'计划配置')
  :entity==='share'?(row.package as Record<string,unknown>|undefined)?.title
  :entity==='app'?(row.definition as Record<string,unknown>|undefined)?.title
  :entity==='role'?row.name
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
 try{body=JSON.parse(row.body);assertPageCreateNoCredentialKeys(entity,body);body=readPageCreateBody(entity,body,{manifest:validateManifest,...readers})}catch(error){
  if(error instanceof WorkError&&error.code==='teloa/dependency-unavailable')throw error
  throw corrupt('页内新建草案正文损坏，已停止读取。')
 }
 const canonical=pageCreateCanonicalBody(body)
 if(canonical!==row.body||sha256(canonical)!==row.body_hash||titleOf(entity,body)!==row.title)throw corrupt('页内新建草案正文摘要或标题不一致，已停止读取。')
 return {id:row.id,ownerId:row.owner_id,requestId:row.request_id,entity,...(scope===undefined?{}:{scope}),body:row.body,bodyHash:row.body_hash,title:row.title,status,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),...(appliedRef===undefined?{}:{appliedRef})}
}

/** 新建草案保持独立保存；应用阶段通过现有实体服务写入并核对真实回执。 */
export async function initializePageCreateDrafts(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_page_create_drafts (
  owner_id text not null,id uuid not null,request_id uuid not null,
  entity text not null check(entity in ('business-definition','business-domain','role','skill','connector','extension','share','plan','app')),
  scope_id text,title text not null,body text not null,body_hash text not null check(body_hash~'^[a-f0-9]{64}$'),
  status text not null check(status in ('draft','applied','discarded')),applied_ref text,
  created_at timestamptz not null,updated_at timestamptz not null,
  primary key(owner_id,id),unique(owner_id,request_id),
  check((status='applied')=(applied_ref is not null)),
  check((entity in ('business-definition','business-domain','connector'))=(scope_id is not null))
 )`)
 await pool.query('alter table teloa_page_create_drafts add column if not exists origin_source jsonb')
 await pool.query(`create table if not exists teloa_page_create_draft_revisions (
  owner_id text not null,draft_id uuid not null,request_id uuid not null,
  previous_body text not null,previous_body_hash text not null,body text not null,body_hash text not null,
  accepted_source jsonb not null,created_at timestamptz not null,
  primary key(owner_id,request_id),foreign key(owner_id,draft_id) references teloa_page_create_drafts(owner_id,id)
 )`)
 const constraint=(await pool.query("select pg_get_constraintdef(oid) definition from pg_constraint where conrelid='teloa_page_create_drafts'::regclass and conname='teloa_page_create_drafts_entity_check'")).rows[0]?.definition
 if(typeof constraint!=='string'||!constraint.includes("'app'"))await pool.query("alter table teloa_page_create_drafts drop constraint if exists teloa_page_create_drafts_entity_check, add constraint teloa_page_create_drafts_entity_check check(entity in ('business-definition','business-domain','role','skill','connector','extension','share','plan','app'))")
}

export class PageCreateDraftService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 readonly readers:PageCreateReaders
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},readers:PageCreateReaders={}){this.pool=pool;this.identity=identity;this.readers=readers}

 async draft(actor:PageCreateActor,input:PageCreateDraftInput,signal?:AbortSignal):Promise<PageCreateDraft>{
  const db=await this.pool.connect()
  try{await db.query('begin');const result=await this.createInTransaction(db,actor,input,signal);await db.query('commit');return result}
  catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 /** 与可信方法来源账本共用事务；不会自行提交、采用、安装或启用。 */
 async createInTransaction(db:PoolClient,actor:PageCreateActor,input:PageCreateDraftInput,signal?:AbortSignal):Promise<PageCreateDraft>{
  actorValue(actor)
  const row=taskInput(input,['entity','scope','body','requestId','origin']),entity=entityValue(row.entity),scope=requireScope(entity,row.scope),origin=row.origin===undefined?undefined:readPageCreateDraftOrigin(row.origin)
  if(!uuid(row.requestId))throw invalid('页内新建草案的请求身份不正确。')
  if((entity==='business-definition'||entity==='connector')&&(!actor.scopeIds.includes(scope!)||!await BusinessScopeService.registered(this.pool,actor.ownerId,scope!)))throw forbidden('当前主体未获准在此业务范围创建草案。')
  // 新业务范围还没有登记，草案阶段只校验名称；真正登记由后续既有加载路径负责。
  assertPageCreateNoCredentialKeys(entity,row.body)
  const bodyValue=readPageCreateBody(entity,row.body,{manifest:validateManifest,...this.readers})
  if(entity==='business-domain'&&((bodyValue as {manifest:{scope?:unknown}}).manifest.scope!==scope))throw invalid('新业务清单的加载范围与目标范围不一致。')
  const body=pageCreateCanonicalBody(bodyValue),bodyHash=sha256(body),title=titleOf(entity,bodyValue),requestId=(row.requestId as string).toLowerCase(),id=this.identity.id(),now=this.identity.now()
  if(!uuid(id))throw invalid('页内新建草案身份生成失败。')
  signal?.throwIfAborted()
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['page-create-request',actor.ownerId,requestId])])
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['page-create-drafts',actor.ownerId,entity,scope??''])])
   // 先锁原行，再用下一语句的新快照核后续修改，避免旧 create 等锁后以旧 statement snapshot 覆盖续改。
   const original=(await db.query('select id from teloa_page_create_drafts where owner_id=$1 and request_id=$2 for update',[actor.ownerId,requestId])).rows[0]
   if(original&&(await db.query('select request_id from teloa_page_create_draft_revisions where owner_id=$1 and draft_id=$2 limit 1',[actor.ownerId,original.id])).rows.length)throw conflict('原草稿已有后续修改，请重新读取原稿。')
   const count=Number((await db.query(`select count(*)::int total from teloa_page_create_drafts where owner_id=$1 and entity=$2 and scope_id is not distinct from $3 and status='draft' and request_id<>$4`,[actor.ownerId,entity,scope??null,requestId])).rows[0]?.total)
   if(!Number.isSafeInteger(count))throw corrupt('页内新建草案目录计数损坏，已停止写入。')
   if(count>=pageCreateLimits.draftsPerEntity)throw conflict('此处待确认的新建草案已达 '+pageCreateLimits.draftsPerEntity+' 条，请先确认或丢弃一条。')
   const saved=(await db.query(`insert into teloa_page_create_drafts(owner_id,id,request_id,entity,scope_id,title,body,body_hash,status,applied_ref,created_at,updated_at,origin_source)
    values($1,$2,$3,$4,$5,$6,$7,$8,'draft',null,$9,$9,$10)
    on conflict(owner_id,request_id) do update set entity=excluded.entity,scope_id=excluded.scope_id,title=excluded.title,body=excluded.body,body_hash=excluded.body_hash,updated_at=excluded.updated_at
    where teloa_page_create_drafts.status='draft' returning *`,[actor.ownerId,id,requestId,entity,scope??null,title,body,bodyHash,now,origin?JSON.stringify(origin):null])).rows[0]
   if(!saved)throw conflict('同一条指令派生的新建草案已经落定或已有后续修改，不能再改写。')
   const result=storedDraft(saved,this.readers)
   return result
 }

 /** 不猜历史普通草稿的来源；旧方法草稿可沿原已核对账本恢复原生会话。 */
 async origin(actor:PageCreateActor,input:{draftId:string;expectedBodyHash:string},signal?:AbortSignal):Promise<{draftId:string;bodyHash:string;sessionId:string}>{
  const draft=await this.read(actor,{draftId:input.draftId},signal)
  if(!digest(input.expectedBodyHash)||draft.status!=='draft'||draft.bodyHash!==input.expectedBodyHash)throw versionConflict('草稿已变化，请重新预览。')
  const db=await this.pool.connect()
  try{const origin=await this.originInTransaction(db,actor.ownerId,draft.id);signal?.throwIfAborted();return {draftId:draft.id,bodyHash:draft.bodyHash,sessionId:origin.sessionId}}finally{db.release()}
 }

 private async originInTransaction(db:PoolClient,ownerId:string,draftId:string):Promise<PageCreateDraftOrigin>{
  const row=(await db.query('select origin_source from teloa_page_create_drafts where owner_id=$1 and id=$2',[ownerId,draftId])).rows[0]
  if(row?.origin_source!=null)return readPageCreateDraftOrigin(row.origin_source)
  const exists=(await db.query("select to_regclass('teloa_method_reuse_requests') name")).rows[0]?.name
  if(exists){const method=(await db.query('select request_spec from teloa_method_reuse_requests where owner_id=$1 and draft_id=$2',[ownerId,draftId])).rows[0];if(method?.request_spec?.acceptedSource)return readPageCreateDraftOrigin(method.request_spec.acceptedSource)}
  throw new WorkError('teloa/source-unavailable','无法核对原创建会话，请保留原草稿。')
 }

 /** 仅更改未应用的原草稿；旧正文与本次本人消息追加保存，不改身份或确认状态。 */
 async revise(actor:PageCreateActor,input:PageCreateDraftRevisionInput,guard:{assertCurrent:()=>Promise<void>;method:(db:PoolClient,draft:PageCreateDraft,body:unknown,bodyHash:string,restoring:boolean)=>Promise<void>},signal?:AbortSignal):Promise<PageCreateDraft>{
  actorValue(actor);const row=taskInput(input,['draftId','expectedBodyHash','entity','scope','body','requestId','acceptedSource'])
  if(!uuid(row.draftId)||!uuid(row.requestId)||!digest(row.expectedBodyHash))throw invalid('草稿修改请求格式不正确。')
  const accepted=readPageCreateDraftOrigin(row.acceptedSource),db=await this.pool.connect()
  try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['page-create-revision',actor.ownerId,row.requestId])])
   const previous=(await db.query('select * from teloa_page_create_draft_revisions where owner_id=$1 and request_id=$2',[actor.ownerId,row.requestId])).rows[0]
   await db.query('select id from teloa_page_create_drafts where owner_id=$1 and id=$2 for update',[actor.ownerId,row.draftId])
   const draft=await this.draftInTransaction(db,actor.ownerId,row.draftId);this.assertApplyScope(actor,draft)
   if(draft.status!=='draft'||!previous&&draft.bodyHash!==row.expectedBodyHash)throw versionConflict('草稿已变化或已落定，请重新预览。')
   if(draft.entity!==row.entity||draft.scope!==row.scope)throw forbidden('草稿修改不能改变原实体或业务归属。')
   if(draft.scope!==undefined&&draft.entity!=='business-domain'&&!await BusinessScopeService.registered(db,actor.ownerId,draft.scope))throw forbidden('原业务范围已不可用。')
   const origin=await this.originInTransaction(db,actor.ownerId,draft.id)
   if(origin.sessionId!==accepted.sessionId)throw forbidden('请回到原创建会话继续修改草稿。')
   assertPageCreateNoCredentialKeys(draft.entity,row.body);const bodyValue=readPageCreateBody(draft.entity,row.body,{manifest:validateManifest,...this.readers})
   if(draft.entity==='business-domain'&&(bodyValue as {manifest:{scope?:unknown}}).manifest.scope!==draft.scope)throw forbidden('草稿修改不能改变原业务范围。')
   if(draft.entity==='role'&&!isDeepStrictEqual([...(bodyValue as {scopes:string[]}).scopes].sort(),[...(JSON.parse(draft.body) as {scopes:string[]}).scopes].sort()))throw forbidden('草稿修改不能改变原员工的业务归属。')
   if(draft.entity==='business-definition'&&(bodyValue as {domain:string}).domain!==(JSON.parse(draft.body) as {domain:string}).domain)throw forbidden('草稿修改不能改变原业务归属。')
   if(draft.entity==='plan'){const plan=readPageCreatePlanDraft(bodyValue),previous=readPageCreatePlanDraft(JSON.parse(draft.body));if(('kind'in plan)!==('kind'in previous)||'kind'in plan&&'kind'in previous&&plan.planId!==previous.planId||!('kind'in plan)&&!('kind'in previous)&&plan.definition.scope!==previous.definition.scope||plan.intent==='create-and-enable')throw forbidden('修改计划草稿不能更换原计划、业务或启用计划，请保留暂停意图。')}
   const body=pageCreateCanonicalBody(bodyValue),bodyHash=sha256(body)
   if(previous){
    if(previous.draft_id!==draft.id||previous.previous_body_hash!==row.expectedBodyHash||previous.body!==body||previous.body_hash!==bodyHash||!isDeepStrictEqual(previous.accepted_source,accepted))throw conflict('同一修改请求不能替换正文或来源，请回读原稿。')
    if(draft.bodyHash!==bodyHash||draft.body!==body)throw versionConflict('原修改已保存，但草稿已有后续变化，请重新预览。')
    // 丢失回执的同一次调用只读恢复；权限与方法来源仍要重新核对，不追加历史或改账本。
    await guard.assertCurrent();signal?.throwIfAborted();await guard.method(db,draft,bodyValue,bodyHash,true)
    await guard.assertCurrent();signal?.throwIfAborted();await db.query('commit');return draft
   }
   if(bodyHash===draft.bodyHash)throw conflict('草稿内容没有变化。')
   await guard.assertCurrent();signal?.throwIfAborted();await guard.method(db,draft,bodyValue,bodyHash,false)
   const now=this.identity.now();await db.query('insert into teloa_page_create_draft_revisions(owner_id,draft_id,request_id,previous_body,previous_body_hash,body,body_hash,accepted_source,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[actor.ownerId,draft.id,row.requestId,draft.body,draft.bodyHash,body,bodyHash,JSON.stringify(accepted),now])
   const saved=(await db.query('update teloa_page_create_drafts set body=$3,body_hash=$4,title=$5,updated_at=$6 where owner_id=$1 and id=$2 returning *',[actor.ownerId,draft.id,body,bodyHash,titleOf(draft.entity,bodyValue),now])).rows[0]
   await guard.assertCurrent();signal?.throwIfAborted();const result=storedDraft(saved,this.readers);await db.query('commit');return result
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 async directory(actor:PageCreateActor,input:unknown,signal?:AbortSignal):Promise<PageCreateDraftDirectory>{
  actorValue(actor)
  const row=taskInput(input,['entity','scope']),entity=entityValue(row.entity),scope=requireScope(entity,row.scope)
  if((entity==='business-definition'||entity==='connector')&&(!actor.scopeIds.includes(scope!)||!await BusinessScopeService.registered(this.pool,actor.ownerId,scope!)))throw forbidden('当前主体未获准读取此业务范围的新建草案。')
  // 只读历史按本人和目标范围隔离；范围登记后原草案仍须可查。是否能新建由应用路径核对。
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

 /**
  * 「需要你」只读来源：本人全部待确认草案，读取口径与 directory 一致——无范围实体与新业务清单只按本人隔离，
  * 业务定义/连接器须在本人已授权且已登记的范围内。有界读取，超出上限返回 truncated，不静默截断。
  */
 async pendingForAttention(actor:PageCreateActor,signal?:AbortSignal):Promise<{drafts:PageCreateDraft[];truncated:boolean}>{
  actorValue(actor)
  const limit=100
  signal?.throwIfAborted()
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   const rows=(await db.query(`select * from teloa_page_create_drafts where owner_id=$1 and status='draft'
    and (entity not in ('business-definition','connector') or scope_id=any($2::text[]))
    order by updated_at desc,id limit $3`,[actor.ownerId,actor.scopeIds,limit+1])).rows as Array<Record<string,unknown>>
   const registered=new Map<string,boolean>()
   const drafts:PageCreateDraft[]=[]
   for(const row of rows.slice(0,limit)){
    const draft=storedDraft(row,this.readers)
    if(draft.entity==='business-definition'||draft.entity==='connector'){
     if(!registered.has(draft.scope!))registered.set(draft.scope!,await BusinessScopeService.registered(db,actor.ownerId,draft.scope!))
     if(!registered.get(draft.scope!))continue
    }
    drafts.push(draft)
   }
   await db.query('commit')
   return {drafts,truncated:rows.length>limit}
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

 /** 对话和页面共享同一归属、正文完整性与范围检查。 */
 async read(actor:PageCreateActor,input:unknown,signal?:AbortSignal):Promise<PageCreateDraft>{
  actorValue(actor)
  const row=taskInput(input,['draftId'])
  if(!uuid(row.draftId))throw invalid('新建草案身份不正确。')
  signal?.throwIfAborted()
  const db=await this.pool.connect()
  try{
   const draft=await this.draftInTransaction(db,actor.ownerId,row.draftId)
   this.assertApplyScope(actor,draft)
   return draft
  }finally{db.release()}
 }

 /**
  * 锁住同一草案直到既有实体写路径返回真实身份。回调必须使用固定请求身份，
  * 因此外部写入成功、落定事务失败时仍可重试；已落定且摘要相同则不再调用回调。
  */
 async apply(actor:PageCreateActor,input:unknown,write:(draft:PageCreateDraft)=>Promise<string>,signal?:AbortSignal):Promise<PageCreateDraft>{
  actorValue(actor)
  const row=taskInput(input,['draftId','expectedBodyHash'])
  if(!uuid(row.draftId)||!digest(row.expectedBodyHash))throw invalid('新建草案应用请求格式不正确。')
  signal?.throwIfAborted()
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   await db.query('select id from teloa_page_create_drafts where owner_id=$1 and id=$2 for update',[actor.ownerId,row.draftId])
   const draft=await this.draftInTransaction(db,actor.ownerId,row.draftId)
   this.assertApplyScope(actor,draft)
   if(draft.bodyHash!==row.expectedBodyHash||draft.status==='discarded')throw versionConflict('新建草案已变化，请重新预览后再应用。')
   if(draft.status==='applied'){await db.query('commit');return draft}
   signal?.throwIfAborted()
   const appliedRef=await write(draft)
   if(!text(appliedRef,200))throw new WorkError('teloa/invalid-host-response','应用服务没有返回有效的落地身份。')
   signal?.throwIfAborted()
   const updated=(await db.query("update teloa_page_create_drafts set status='applied',applied_ref=$3,updated_at=$4 where owner_id=$1 and id=$2 returning *",[actor.ownerId,draft.id,appliedRef,this.identity.now()])).rows[0] as Record<string,unknown>
   const result=storedDraft(updated,this.readers)
   await db.query('commit')
   return result
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 private assertApplyScope(actor:PageCreateActor,draft:PageCreateDraft):void{
  if(draft.entity!=='business-domain'&&draft.scope!==undefined&&!actor.scopeIds.includes(draft.scope))throw forbidden('当前主体未获准读取或应用此业务范围的新建草案。')
 }
}
