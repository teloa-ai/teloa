import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {
 WorkError,businessCustomizationLimits,businessSourceMappingLimits,businessDefinitionCanonicalBody,businessDefinitionKinds,
 readBusinessDefinitionBody,taskInput,
 type BusinessCustomizationDirectory,type BusinessCustomizationEntry,type BusinessDefinitionDraft,
 type BusinessDefinitionKind,type BusinessLocalDefinitionVersion,
} from '@teloa/contract'
import {isBusinessDefinitionPreviewReceipt,verifiesBusinessDefinitionPreviewReceipt} from './business-definition-preview-receipt.ts'
import {lockBusinessConfiguration} from './business-configuration-lock.ts'

export type BusinessLocalActor={ownerId:string;scopeIds:string[]}
export type BusinessLocalDraftInput={scope:string;kind:BusinessDefinitionKind;definition:unknown;requestId:string}
/** 当前生效的一条本地声明：正文原样带出去，由读取器再过一遍 `read*`——库里存的也不信（与第一期同规矩）。 */
export type BusinessLocalCurrent={kind:BusinessDefinitionKind;localId:string;version:number;semver:string;definitionHash:string;bodyHash:string;body:string}
/**
 * 模板侧同 localId 声明在不在、是哪一版，由装配处注入；键是 `kind+'\0'+localId`，值是模板侧那一版三段号。
 * 本服务只管三张本地表，既不读加载记录也不读市场内容：定制目录是一条轻读路径，
 * 不该为看一眼草案付一次全量固定内容读取（新增端点表里「不该为看一眼草案付一次全量计算」的同一条理由）。
 */
export type BusinessLocalTemplatePort=(db:PoolClient,ownerId:string,scope:string)=>Promise<ReadonlyMap<string,string>>

/** 本地声明的摘要域：草案、本地版本与读取器合成身份三处共用这一个字面量，不各写一遍。 */
export {businessLocalDefinitionSchema,businessLocalDefinitionHash} from './business-definition-write.ts'
import {businessLocalDefinitionHash,versionOf,prepareBusinessDefinition,insertBusinessDefinitionVersion} from './business-definition-write.ts'
import {BusinessConfigurationStore} from './business-configuration-store.ts'

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const localIdText=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
const digest=/^[a-f0-9]{64}$/
const invalidInput=(message:string)=>new WorkError('teloa/invalid-input',message)
const forbidden=(message:string)=>new WorkError('teloa/forbidden',message)
const conflict=(message:string)=>new WorkError('teloa/conflict',message)
/** 措辞照 `industry-loads.ts:260`：乐观判据不符一律「……已变化」，不解释是谁改的、也不回对方那一份内容。 */
const versionConflict=(message:string)=>new WorkError('teloa/version-conflict',message)
const corrupt=(message:string)=>new WorkError('teloa/storage-corrupt',message)
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex')
/**
 * 草案写库遇到的数据库错误统一映射为既有码、固定文案：约束类（SQLSTATE 23xxx）是这份草案存不进去，
 * 其余是库暂时不可用。原始错误里的表名、约束名与取值一律不外带——文案会随工具结果进模型上下文。
 */
function draftStorageError(error:unknown):unknown{
 const code=error instanceof Error&&!(error instanceof WorkError)?(error as Error&{code?:unknown}).code:undefined
 if(typeof code!=='string'||!/^[0-9A-Z]{5}$/.test(code))return error
 return code.startsWith('23')
  ?invalidInput('业务定义草案不符合存储约束，未保存。')
  :new WorkError('teloa/dependency-unavailable','业务定义草案暂时无法保存，请稍后再试。')
}

const entryKey=(kind:BusinessDefinitionKind,localId:string)=>kind+'\0'+localId

function actorIdentity(actor:BusinessLocalActor):void{
 if(!text(actor?.ownerId,128)||!Array.isArray(actor.scopeIds)||!actor.scopeIds.length||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(scope=>!text(scope,120)||scope==='general'))throw forbidden('需要有效的本人身份与业务范围。')
}

function scopeValue(value:unknown):string{
 // 范围标签会原样拼进错误文案、并随文案进模型上下文：允许换行等于允许在那里另起一段，是注入面（规格 §8 第 1 条）。
 if(!text(value,120)||value==='general'||/[\r\n]/.test(value))throw invalidInput('需要明确的业务范围。')
 return value
}

function kindValue(value:unknown):BusinessDefinitionKind{
 if(typeof value!=='string'||!businessDefinitionKinds.includes(value as BusinessDefinitionKind))throw invalidInput('业务定义种类不在白名单内。')
 return value as BusinessDefinitionKind
}

/** 两种回退共用一个入参形态：回到某个本地历史版本，或回到模板版本（指针置空）。 */
function targetValue(value:unknown):{kind:'local-version';version:number}|{kind:'template'}{
 const row=taskInput(value,['kind','version'])
 if(row.kind==='template'){
  if(row.version!==undefined)throw invalidInput('回到模板版本不带版本号。')
  return {kind:'template'}
 }
 if(row.kind!=='local-version'||!Number.isSafeInteger(row.version)||Number(row.version)<1)throw invalidInput('业务定义回退目标不正确。')
 return {kind:'local-version',version:row.version as number}
}

function applyInput(input:unknown){
 const row=taskInput(input,['requestId','draftId','expectedDefinitionHash','expectedCurrentVersion','previewReceipt'])
 if(!uuid(row.requestId)||!uuid(row.draftId))throw invalidInput('业务定义生效请求的身份不正确。')
 if(typeof row.expectedDefinitionHash!=='string'||!digest.test(row.expectedDefinitionHash))throw invalidInput('业务定义生效请求缺少预览过的定义校验值。')
 if(!Number.isSafeInteger(row.expectedCurrentVersion)||Number(row.expectedCurrentVersion)<0)throw invalidInput('业务定义生效请求的当前版本不合法。')
 if(!isBusinessDefinitionPreviewReceipt(row.previewReceipt))throw invalidInput('业务定义生效请求缺少有效的预览凭证。')
 return row
}

/** 库里存的也不信：正文摘要与声明摘要都按同一条公式重算一遍，不一致即 teloa/storage-corrupt。 */
function draftOf(row:Record<string,unknown>):BusinessDefinitionDraft{
 const status=row.status,appliedVersion=row.applied_version
 if(!uuid(row.id)||!uuid(row.request_id)||!text(row.owner_id,128)||typeof row.scope_id!=='string'||typeof row.local_id!=='string'||typeof row.semver!=='string'||typeof row.body!=='string'||typeof row.definition_hash!=='string')throw corrupt('业务定义草案记录损坏，已停止读取。')
 if(status!=='draft'&&status!=='applied')throw corrupt('业务定义草案状态损坏，已停止读取。')
 if(!(row.created_at instanceof Date)||!(row.updated_at instanceof Date))throw corrupt('业务定义草案时间戳损坏，已停止读取。')
 if(status==='applied'?!Number.isSafeInteger(appliedVersion)||Number(appliedVersion)<1:appliedVersion!==null)throw corrupt('业务定义草案状态与生效版本不一致，已停止读取。')
 const kind=kindOf(row.kind)
 if(row.definition_hash!==businessLocalDefinitionHash(row.scope_id,kind,row.local_id,row.semver,sha256(row.body)))throw corrupt('业务定义草案校验值与正文不一致，已停止读取。')
 return {
  id:row.id,ownerId:row.owner_id,requestId:row.request_id,scope:row.scope_id,kind,
  localId:row.local_id,semver:row.semver,definitionHash:row.definition_hash,body:row.body,status,
  createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),
  ...(status==='applied'?{appliedVersion:appliedVersion as number}:{}),
 }
}

function kindOf(value:unknown):BusinessDefinitionKind{
 if(typeof value!=='string'||!businessDefinitionKinds.includes(value as BusinessDefinitionKind))throw corrupt('业务定义种类损坏，已停止读取。')
 return value as BusinessDefinitionKind
}

/**
 * 页内新建不复制第二期的草案表；确认时把它那份已固定的页面草案投影为同一份业务声明草案。
 * 此处只读页面草案，状态落定仍由 `page-create-drafts/settle` 负责，避免两个写路径各自改一半状态。
 */
function pageCreateDraftOf(row:Record<string,unknown>,ownerId:string):BusinessDefinitionDraft{
 if(row.entity!=='business-definition')throw forbidden('业务定义草案不存在或不属于当前本人。')
 if(row.status!=='draft')throw versionConflict('业务定义草案状态已变化。')
 if(!uuid(row.id)||!uuid(row.request_id)||row.owner_id!==ownerId||!text(row.scope_id,120)||row.scope_id==='general'||/[\r\n]/.test(row.scope_id)||typeof row.body!=='string'||typeof row.body_hash!=='string'||!digest.test(row.body_hash)||!(row.created_at instanceof Date)||!(row.updated_at instanceof Date))throw corrupt('页内新建的业务定义草案记录损坏，已停止读取。')
 if(sha256(row.body)!==row.body_hash)throw corrupt('页内新建的业务定义草案正文校验值不一致，已停止读取。')
 let parsed:unknown
 try{parsed=JSON.parse(row.body)}catch{throw corrupt('页内新建的业务定义草案正文不是有效 JSON，已停止生效。')}
 const raw=parsed as {format?:unknown}
 const kind=raw?.format==='teloa.business-object-type/v1'?'object-type':raw?.format==='teloa.business-view/v1'?'view':raw?.format==='teloa.business-action/v1'?'action':undefined
 if(!kind)throw corrupt('页内新建的业务定义草案正文不再符合定义格式，已停止生效。')
 let definition
 try{definition=readBusinessDefinitionBody(kind,parsed)}catch{throw corrupt('页内新建的业务定义草案正文不再符合定义格式，已停止生效。')}
 if(definition.domain!==row.scope_id||businessDefinitionCanonicalBody(definition)!==row.body)throw corrupt('页内新建的业务定义草案正文与身份不一致，已停止生效。')
 const definitionHash=businessLocalDefinitionHash(row.scope_id,kind,definition.id,definition.version,sha256(row.body))
 return {id:row.id,ownerId,requestId:row.request_id,scope:row.scope_id,kind,localId:definition.id,semver:definition.version,definitionHash,body:row.body,status:'draft',createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()}
}

/** 回包里只有契约那六列：`kind`/`localId`/`body` 是读取用的内部列，不往外带。 */
const publicVersion=(row:ReturnType<typeof versionOf>):BusinessLocalDefinitionVersion=>
 ({version:row.version,semver:row.semver,definitionHash:row.definitionHash,bodyHash:row.bodyHash,createdAt:row.createdAt,draftId:row.draftId})

/** 版本链 + 当前指针 + 模板侧有没有同名声明，组装成定制目录的一条。`versions` 的升序由查询的 order by 担保。 */
function entriesOf(scope:string,versions:ReturnType<typeof versionOf>[],heads:ReadonlyMap<string,number|null>,templates:ReadonlyMap<string,string>):BusinessCustomizationEntry[]{
 const grouped=new Map<string,ReturnType<typeof versionOf>[]>()
 for(const row of versions){
  const key=entryKey(row.kind,row.localId),list=grouped.get(key)
  if(list)list.push(row);else grouped.set(key,[row])
 }
 const entries:BusinessCustomizationEntry[]=[]
 for(const [key,list] of grouped){
  const head=heads.get(key)
  const current=head===undefined||head===null?undefined:list.find(row=>row.version===head)
  // 指针指向一个不存在的版本说明两张表已经脱节：回退会指到空处，必须整条拒绝而不是当成"回到模板版本"。
  if(head!==undefined&&head!==null&&!current)throw corrupt('本地业务定义当前指针指向不存在的版本，已停止读取。')
  const template=templates.get(key),first=list[0]!
  entries.push({
   scope,kind:first.kind,localId:first.localId,
   ...(current?{current:publicVersion(current)}:{}),
   versions:list.map(publicVersion),
   template:template===undefined?{available:false}:{available:true,version:template},
  })
 }
 return entries
}

/** 三张表 `kind` 列的白名单：字面量只取契约常量，不拼任何外来字符串。 */
const kindCheck='kind in ('+businessDefinitionKinds.map(kind=>"'"+kind+"'").join(',')+')'
const kindTables=['teloa_business_definition_drafts','teloa_business_local_definitions','teloa_business_local_definition_heads'] as const
/** PostgreSQL 对上面那条 check 的反解析形态：库里已是这一条即不再 drop/add（免得每次启动为三张表各取一次排他锁、重扫全表）。 */
const kindCheckDefinition='CHECK ((kind = ANY (ARRAY['+businessDefinitionKinds.map(kind=>"'"+kind+"'::text").join(', ')+'])))'

export async function initializeBusinessDefinitions(pool:Pool):Promise<void>{
 // 草案：会话侧唯一的写落点。status 与 applied_version 的联动写成 check，免得"某条路径忘了填"变成一条能生效的半成品。
 await pool.query(`create table if not exists teloa_business_definition_drafts (
   owner_id text not null, id uuid not null, request_id uuid not null,
   scope_id text not null, kind text not null constraint teloa_business_definition_drafts_kind_check check(${kindCheck}),
   local_id text not null, semver text not null,
   definition_hash text not null check(definition_hash~'^[a-f0-9]{64}$'),
   body text not null, status text not null check(status in ('draft','applied')),
   applied_version integer check(applied_version>0),
   created_at timestamptz not null, updated_at timestamptz not null,
   primary key(owner_id,id), unique(owner_id,request_id),
   check((status='applied')=(applied_version is not null))
 )`)
 // 本地声明版本：追加表，主键含 version，既有版本永不改写（回退只动指针，见下一张表）。
 await pool.query(`create table if not exists teloa_business_local_definitions (
   owner_id text not null, scope_id text not null,
   kind text not null constraint teloa_business_local_definitions_kind_check check(${kindCheck}), local_id text not null,
   version integer not null check(version>0), semver text not null,
   definition_hash text not null check(definition_hash~'^[a-f0-9]{64}$'),
   body_hash text not null check(body_hash~'^[a-f0-9]{64}$'), body text not null,
   draft_id uuid not null, created_at timestamptz not null,
   primary key(owner_id,scope_id,kind,local_id,version)
 )`)
 // 当前指针：version 为空即"回到模板版本"。revision 单调递增，只用来让并发两次回退里必有一次 version-conflict。
 await pool.query(`create table if not exists teloa_business_local_definition_heads (
   owner_id text not null, scope_id text not null,
   kind text not null constraint teloa_business_local_definition_heads_kind_check check(${kindCheck}), local_id text not null,
   version integer check(version>0), revision integer not null check(revision>0), updated_at timestamptz not null,
   primary key(owner_id,scope_id,kind,local_id)
 )`)
 /**
  * 既有库上的放宽：建表时未命名的 check 由 PostgreSQL 自动命名为 `<表>_kind_check`，与上面显式命名的同名，
  * 因此「先 drop if exists 再 add」同时覆盖首次建表与存量库；定义已一致则跳过，重复执行不动约束。
  */
 for(const table of kindTables){
  const current=(await pool.query('select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid=$1::regclass and conname=$2',[table,table+'_kind_check'])).rows[0]?.definition
  if(current===kindCheckDefinition)continue
  await pool.query(`alter table ${table} drop constraint if exists ${table}_kind_check, add constraint ${table}_kind_check check(${kindCheck})`)
 }
}

/**
 * 会话定制的四个操作：写草案、读目录、生效、回退。
 *
 * 四段路径（生成 → 预览 → 确认 → 保存）里没有一条能绕过预览直接写（规格 §6.3）：模型侧只够得到 `draft`，
 * 它写出来的行 `status` 恒 `'draft'`；`apply` 必须带本人真实预览签发的回执，
 * 且回执绑定正文摘要和当前版本。改声明一律走版本，回退只改当前指针，历史版本一条不删（规格 §8 第 5 条）。
 */
export class BusinessLocalDefinitionService{
 private readonly pool:Pool
 private readonly identity:{id:()=>string;now:()=>string}
 private readonly templates:BusinessLocalTemplatePort
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},templates?:BusinessLocalTemplatePort){
  this.pool=pool;this.identity=identity
  // 缺省当作"模板侧没有同名声明"：目录照样读得出版本链，只是「回到模板版本」不可点，不以报错替代。
  this.templates=templates??(async()=>new Map())
 }

 /** 只写草案：同 requestId 重放替换同一行，`status` 与 `applied_version` 一律不进 do update 的赋值列。 */
 async draft(actor:BusinessLocalActor,input:BusinessLocalDraftInput,signal?:AbortSignal):Promise<BusinessDefinitionDraft>{
  actorIdentity(actor)
  const row=taskInput(input,['scope','kind','definition','requestId'])
  const scope=scopeValue(row.scope)
  if(!actor.scopeIds.includes(scope))throw forbidden('当前主体未获准定制此业务范围。')
  if(!uuid(row.requestId))throw invalidInput('业务定义草案的请求身份不正确。')
  const kind=kindValue(row.kind)
  // 会话产出的草案与模板里的声明走同一批 read*，一个字符的宽松都不给。
  const definition=readBusinessDefinitionBody(kind,row.definition)
  // 跨范围引用禁止：本地声明的 domain 必须等于目标范围（general 已被契约层的 domainText 拒绝）。
  if(definition.domain!==scope)throw invalidInput('业务定义所属业务范围与目标业务范围不一致。')
  const {body,definitionHash}=prepareBusinessDefinition(scope,kind,definition)
  const id=this.identity.id(),now=this.identity.now(),requestId=row.requestId.toLowerCase()
  if(!uuid(id))throw invalidInput('业务定义草案身份生成失败。')
  signal?.throwIfAborted()
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   // 条数上限要 race-free：与加载写入段同规矩，先取范围级事务锁再数，免得并发两条各自数到上限以内。
   await lockBusinessConfiguration(db,actor.ownerId,scope)
   await new BusinessConfigurationStore(this.pool).assertStandaloneMutationAllowed(db,actor.ownerId,scope)
   const others=Number((await db.query(`select count(*)::int as total from teloa_business_definition_drafts where owner_id=$1 and scope_id=$2 and status='draft' and request_id<>$3`,[actor.ownerId,scope,requestId])).rows[0].total)
   if(others>=businessCustomizationLimits.draftsPerScope)throw conflict('业务范围 '+scope+' 的待确认草案已达 '+businessCustomizationLimits.draftsPerScope+' 条，先确认或丢弃一条再写。')
   const saved=(await db.query(`insert into teloa_business_definition_drafts(owner_id,id,request_id,scope_id,kind,local_id,semver,definition_hash,body,status,applied_version,created_at,updated_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',null,$10,$10)
     on conflict (owner_id,request_id) do update set scope_id=excluded.scope_id,kind=excluded.kind,local_id=excluded.local_id,semver=excluded.semver,definition_hash=excluded.definition_hash,body=excluded.body,updated_at=excluded.updated_at
     where teloa_business_definition_drafts.status='draft' returning *`,
    [actor.ownerId,id,requestId,scope,kind,definition.id,definition.version,definitionHash,body,now])).rows[0]
   // do update 的 where 不成立即一行未动：那一行已经生效，重放不得把它改回一份未生效的正文。
   if(!saved)throw conflict('同一条指令派生的业务定义草案已经生效，不能再改写。')
   const result=draftOf(saved)
   await db.query('commit')
   return result
  }catch(error){await db.query('rollback').catch(()=>{});throw draftStorageError(error)}finally{db.release()}
 }

 async directory(actor:BusinessLocalActor,input:unknown,signal?:AbortSignal):Promise<BusinessCustomizationDirectory>{
  actorIdentity(actor)
  const row=taskInput(input,['scope']),scope=scopeValue(row.scope)
  if(!actor.scopeIds.includes(scope))throw forbidden('当前主体未获准读取此业务范围的定制目录。')
  signal?.throwIfAborted()
  const db=await this.pool.connect()
  try{
   /**
    * 只读 + 可重复读：草案、版本链与当前指针三张表必须来自同一份 MVCC 快照，否则面板会画出
    * "指针已指向新版本、版本链里还没有它"这种自相矛盾的目录。`read only` 让这条路径一个字节也不写
    * 由数据库自己担保，而不是靠读代码确认。
    */
   await db.query('begin isolation level repeatable read read only')
   const drafts=(await db.query('select * from teloa_business_definition_drafts where owner_id=$1 and scope_id=$2 order by created_at,id',[actor.ownerId,scope])).rows as Array<Record<string,unknown>>
   const entries=await this.entries(db,actor.ownerId,scope)
   await db.query('commit')
   return {schema:'teloa.business-customization/v1',scope,readAt:this.identity.now(),drafts:drafts.map(draftOf),entries}
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 /**
  * 生效：本人预览过的那一份才能落地。
  *
  * `requestId` 只做形状闸、不落库——版本表的主键是（本人,范围,种类,标识,版本），没有一列存请求身份。
  * 重放保护由两条乐观判据担：同一次生效重放第二遍时草案已是 `applied`、指针也已推进，
  * 两条里任何一条都会落 `teloa/version-conflict`，不会多写一个版本。
  */
 async apply(actor:BusinessLocalActor,input:unknown,signal?:AbortSignal):Promise<BusinessCustomizationEntry>{
  actorIdentity(actor)
  applyInput(input)
  signal?.throwIfAborted()
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   const entry=await this.applyInTransaction(db,actor,input,signal)
   await db.query('commit')
   return entry
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 /** 调用方负责事务边界；本方法只在已开启的事务里验证并采用一条定义。 */
 async applyInTransaction(db:PoolClient,actor:BusinessLocalActor,input:unknown,signal?:AbortSignal):Promise<BusinessCustomizationEntry>{
  actorIdentity(actor)
  const row=applyInput(input)
  signal?.throwIfAborted()
  // 先无锁读草案范围以取得范围锁；取锁后再锁行并核对范围，防止重放修改草案期间反向等待。
   const candidate=(await db.query('select scope_id from teloa_business_definition_drafts where owner_id=$1 and id=$2',[actor.ownerId,row.draftId])).rows[0]
    ??(await db.query('select scope_id from teloa_page_create_drafts where owner_id=$1 and id=$2',[actor.ownerId,row.draftId])).rows[0]
   if(!candidate)throw forbidden('业务定义草案不存在或不属于当前本人。')
   const lockedScope=scopeValue(candidate.scope_id)
   if(!actor.scopeIds.includes(lockedScope))throw forbidden('当前主体未获准定制此业务范围。')
   await lockBusinessConfiguration(db,actor.ownerId,lockedScope)
   await new BusinessConfigurationStore(this.pool).assertStandaloneMutationAllowed(db,actor.ownerId,lockedScope)
   const stored=(await db.query('select * from teloa_business_definition_drafts where owner_id=$1 and id=$2 for update',[actor.ownerId,row.draftId])).rows[0] as Record<string,unknown>|undefined
   const pageStored=stored?undefined:(await db.query('select * from teloa_page_create_drafts where owner_id=$1 and id=$2 for update',[actor.ownerId,row.draftId])).rows[0] as Record<string,unknown>|undefined
   if(!stored&&!pageStored)throw forbidden('业务定义草案不存在或不属于当前本人。')
   const draft=stored?draftOf(stored):pageCreateDraftOf(pageStored!,actor.ownerId)
   if(draft.scope!==lockedScope)throw versionConflict('业务定义草案所属业务范围已变化。')
   if(!actor.scopeIds.includes(draft.scope))throw forbidden('当前主体未获准定制此业务范围。')
   if(draft.status!=='draft')throw versionConflict('业务定义草案状态已变化。')
   if(draft.definitionHash!==row.expectedDefinitionHash)throw versionConflict('业务定义草案正文已变化。')
   const head=await this.head(db,actor.ownerId,draft.scope,draft.kind,draft.localId)
   if((head?.version??0)!==row.expectedCurrentVersion)throw versionConflict('本地业务定义当前版本已变化。')
   if(!verifiesBusinessDefinitionPreviewReceipt(row.previewReceipt,{ownerId:actor.ownerId,scope:draft.scope,draftId:draft.id,definitionHash:draft.definitionHash,currentVersion:head?.version??0}))throw versionConflict('业务定义预览凭证无效或已过期，请重新预览后再确认。')
   /**
    * 正文再过一遍 `read*` 并重算一遍规范化正文：库里存的也不信，与第一期「读出来要重算摘要」同规矩。
    * 这一遍不成立即 `teloa/storage-corrupt`——草案入库时已经过过一遍，此时不符说明存储被改动过，
    * 不是调用方给错了参数。
    */
   let parsed:unknown
   try{parsed=JSON.parse(draft.body)}catch{throw corrupt('业务定义草案正文不是有效 JSON，已停止生效。')}
   let definition
   try{definition=readBusinessDefinitionBody(draft.kind,parsed)}catch{throw corrupt('业务定义草案正文不再符合定义格式，已停止生效。')}
   if(definition.domain!==draft.scope||definition.id!==draft.localId||definition.version!==draft.semver)throw corrupt('业务定义草案正文与草案身份不一致，已停止生效。')
   if(businessDefinitionCanonicalBody(definition)!==draft.body)throw corrupt('业务定义草案正文不是规范化正文，已停止生效。')
   /**
    * 数据源映射每范围生效上限在这里拦（新增生效才计，改既有映射不计）：放进台账读取里拒绝会拖垮整个范围的台账，
    * 同步器读映射时另有兜底。一期映射只来自本地声明，数本地指针即是全部。
    */
   if(draft.kind==='source-mapping'){
    if(!head?.version)await this.assertMappingRoom(db,actor.ownerId,draft.scope)
    await this.assertSingleCompare(db,actor.ownerId,draft.scope,draft.localId,definition as {objectType:string;deletionSemantics:string})
   }
   const now=this.identity.now()
   const {version}=await insertBusinessDefinitionVersion(db,{ownerId:actor.ownerId,scope:draft.scope,kind:draft.kind,definition,draftId:draft.id,now})
   await this.point(db,actor.ownerId,draft.scope,draft.kind,draft.localId,version,head,now)
   // 页内新建的状态只由 `page-create-drafts/settle` 落定；本服务只写既有的本地声明版本与当前指针。
   if(stored)await db.query(`update teloa_business_definition_drafts set status='applied',applied_version=$3,updated_at=$4 where owner_id=$1 and id=$2`,[actor.ownerId,draft.id,version,now])
   return this.entry(db,actor.ownerId,draft.scope,draft.kind,draft.localId)
 }

 /** 回退：只改当前指针与 revision，本地版本一条不删（D1、D2）。 */
 async revert(actor:BusinessLocalActor,input:unknown,signal?:AbortSignal):Promise<BusinessCustomizationEntry>{
  actorIdentity(actor)
  const row=taskInput(input,['requestId','scope','kind','localId','target','expectedCurrentVersion'])
  if(!uuid(row.requestId))throw invalidInput('业务定义回退请求的身份不正确。')
  const scope=scopeValue(row.scope)
  if(!actor.scopeIds.includes(scope))throw forbidden('当前主体未获准定制此业务范围。')
  const kind=kindValue(row.kind)
  if(typeof row.localId!=='string'||!localIdText.test(row.localId))throw invalidInput('业务定义本地标识不合法。')
  if(!Number.isSafeInteger(row.expectedCurrentVersion)||Number(row.expectedCurrentVersion)<0)throw invalidInput('业务定义回退请求的当前版本不合法。')
  const target=targetValue(row.target),localId=row.localId
  signal?.throwIfAborted()
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   await lockBusinessConfiguration(db,actor.ownerId,scope)
   await new BusinessConfigurationStore(this.pool).assertStandaloneMutationAllowed(db,actor.ownerId,scope)
   const head=await this.head(db,actor.ownerId,scope,kind,localId)
   if((head?.version??0)!==row.expectedCurrentVersion)throw versionConflict('本地业务定义当前版本已变化。')
   const chain=(await db.query('select version from teloa_business_local_definitions where owner_id=$1 and scope_id=$2 and kind=$3 and local_id=$4 order by version',[actor.ownerId,scope,kind,localId])).rows as Array<{version:number}>
   if(!chain.length)throw conflict('业务范围 '+scope+' 内没有本地业务定义 '+kind+':'+localId+'，无处回退。')
   if(target.kind==='local-version'&&!chain.some(item=>Number(item.version)===target.version))throw conflict('本地业务定义回退目标版本不存在；历史版本一条不删，请按版本链里的版本号回退。')
   // 从模板版本回退到某个本地版本同样是"新增生效"。
   if(kind==='source-mapping'&&target.kind==='local-version'){
    if(!head?.version)await this.assertMappingRoom(db,actor.ownerId,scope)
    const body=(await db.query('select body from teloa_business_local_definitions where owner_id=$1 and scope_id=$2 and kind=$3 and local_id=$4 and version=$5',[actor.ownerId,scope,kind,localId,target.version])).rows[0]?.body
    let parsed:{objectType:string;deletionSemantics:string}
    try{parsed=JSON.parse(String(body))}catch{throw corrupt('本地业务定义版本正文不是有效 JSON，已停止回退。')}
    await this.assertSingleCompare(db,actor.ownerId,scope,localId,parsed)
   }
   await this.point(db,actor.ownerId,scope,kind,localId,target.kind==='template'?null:target.version,head,this.identity.now())
   const entry=await this.entry(db,actor.ownerId,scope,kind,localId)
   await db.query('commit')
   return entry
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 /**
  * 台账与预览共用：在调用方那次只读事务里读当前生效的本地声明。
  * 不取行锁——整条路径跑在 `repeatable read read only` 事务里，`for share` 与 `read only`
  * 在 Postgres 里不能共存（25006），与读取器读固定内容的那一条同理。
  */
 async currentInTransaction(db:PoolClient,ownerId:string,scope:string):Promise<BusinessLocalCurrent[]>{
  const rows=(await db.query(`select v.kind,v.local_id,v.version,v.semver,v.definition_hash,v.body_hash,v.body,v.draft_id,v.created_at
    from teloa_business_local_definition_heads h
    join teloa_business_local_definitions v on v.owner_id=h.owner_id and v.scope_id=h.scope_id and v.kind=h.kind and v.local_id=h.local_id and v.version=h.version
    where h.owner_id=$1 and h.scope_id=$2 and h.version is not null order by v.kind,v.local_id`,[ownerId,scope])).rows as Array<Record<string,unknown>>
  return rows.map(row=>{
   const stored=versionOf(scope,row)
   return {kind:stored.kind,localId:stored.localId,version:stored.version,semver:stored.semver,definitionHash:stored.definitionHash,bodyHash:stored.bodyHash,body:stored.body}
  })
 }

 /** 预览回执绑定的当前本地版本：只读事务不取锁，与 apply 的 `head` 使用同一张指针表。 */
 async currentVersionInTransaction(db:PoolClient,ownerId:string,scope:string,kind:BusinessDefinitionKind,localId:string):Promise<number>{
  const row=(await db.query('select version,revision from teloa_business_local_definition_heads where owner_id=$1 and scope_id=$2 and kind=$3 and local_id=$4',[ownerId,scope,kind,localId])).rows[0] as Record<string,unknown>|undefined
  if(!row)return 0
  if(!Number.isSafeInteger(Number(row.revision))||Number(row.revision)<1||(row.version!==null&&(!Number.isSafeInteger(Number(row.version))||Number(row.version)<1)))throw corrupt('本地业务定义当前指针损坏，已停止读取。')
  return row.version===null?0:Number(row.version)
 }

 /** 预览专用：在调用方那次只读事务里按 draftId 读一条草案。 */
 async draftInTransaction(db:PoolClient,ownerId:string,draftId:string):Promise<BusinessDefinitionDraft>{
  // 不存在与不属本人回同一句：否则回包本身就能用来枚举别人的草案标识。
  if(!uuid(draftId))throw forbidden('业务定义草案不存在或不属于当前本人。')
  const row=(await db.query('select * from teloa_business_definition_drafts where owner_id=$1 and id=$2',[ownerId,draftId])).rows[0]
  if(!row)throw forbidden('业务定义草案不存在或不属于当前本人。')
  return draftOf(row)
 }

 /** 同一范围同一对象类型只允许一个 compare 映射生效：两个都按"全量里缺席即删"对比，会互相把对方的对象 tombstone。 */
 private async assertSingleCompare(db:PoolClient,ownerId:string,scope:string,localId:string,definition:{objectType:string;deletionSemantics:string}):Promise<void>{
  if(definition.deletionSemantics!=='compare')return
  const clash=(await db.query(`select 1 from teloa_business_local_definition_heads h
    join teloa_business_local_definitions v on v.owner_id=h.owner_id and v.scope_id=h.scope_id and v.kind=h.kind and v.local_id=h.local_id and v.version=h.version
    where h.owner_id=$1 and h.scope_id=$2 and h.kind='source-mapping' and h.local_id<>$3
     and (v.body::jsonb)->>'objectType'=$4 and (v.body::jsonb)->>'deletionSemantics'='compare' limit 1`,[ownerId,scope,localId,definition.objectType])).rows.length
  if(clash)throw invalidInput('同一业务范围的同一对象类型只能有一个按 compare 对比缺席的数据源映射生效；请先回退另一个。')
 }

 private async assertMappingRoom(db:PoolClient,ownerId:string,scope:string):Promise<void>{
  const active=Number((await db.query(`select count(*) as total from teloa_business_local_definition_heads where owner_id=$1 and scope_id=$2 and kind='source-mapping' and version is not null`,[ownerId,scope])).rows[0].total)
  if(active>=businessSourceMappingLimits.mappingsPerScope)throw conflict('业务范围 '+scope+' 已有 '+businessSourceMappingLimits.mappingsPerScope+' 个生效的数据源映射，先回退一个再生效新的。')
 }

 private async head(db:PoolClient,ownerId:string,scope:string,kind:BusinessDefinitionKind,localId:string):Promise<{version:number|null;revision:number}|undefined>{
  const row=(await db.query('select version,revision from teloa_business_local_definition_heads where owner_id=$1 and scope_id=$2 and kind=$3 and local_id=$4 for update',[ownerId,scope,kind,localId])).rows[0]
  if(!row)return undefined
  if(!Number.isSafeInteger(Number(row.revision))||Number(row.revision)<1||(row.version!==null&&(!Number.isSafeInteger(Number(row.version))||Number(row.version)<1)))throw corrupt('本地业务定义当前指针损坏，已停止读取。')
  return {version:row.version===null?null:Number(row.version),revision:Number(row.revision)}
 }

 /** 当前指针只有这一处能改：`version` 为空即回到模板版本，`revision` 只为让并发两次改指针里必有一次落 version-conflict。 */
 private async point(db:PoolClient,ownerId:string,scope:string,kind:BusinessDefinitionKind,localId:string,version:number|null,head:{revision:number}|undefined,now:string):Promise<void>{
  await db.query(`insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at)
    values($1,$2,$3,$4,$5,$6,$7)
    on conflict (owner_id,scope_id,kind,local_id) do update set version=excluded.version,revision=excluded.revision,updated_at=excluded.updated_at`,
   [ownerId,scope,kind,localId,version,(head?head.revision:0)+1,now])
 }

 private async entries(db:PoolClient,ownerId:string,scope:string):Promise<BusinessCustomizationEntry[]>{
  const versions=(await db.query('select * from teloa_business_local_definitions where owner_id=$1 and scope_id=$2 order by kind,local_id,version',[ownerId,scope])).rows as Array<Record<string,unknown>>
  const heads=(await db.query('select kind,local_id,version from teloa_business_local_definition_heads where owner_id=$1 and scope_id=$2',[ownerId,scope])).rows as Array<Record<string,unknown>>
  const pointer=new Map<string,number|null>()
  for(const head of heads)pointer.set(entryKey(kindOf(head.kind),String(head.local_id)),head.version===null?null:Number(head.version))
  return entriesOf(scope,versions.map(row=>versionOf(scope,row)),pointer,await this.templates(db,ownerId,scope))
 }

 private async entry(db:PoolClient,ownerId:string,scope:string,kind:BusinessDefinitionKind,localId:string):Promise<BusinessCustomizationEntry>{
  const entry=(await this.entries(db,ownerId,scope)).find(row=>row.kind===kind&&row.localId===localId)
  if(!entry)throw corrupt('本地业务定义写入后读不回版本链，已停止。')
  return entry
 }
}
