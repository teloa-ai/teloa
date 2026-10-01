import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,industryUpdateCanonical,readBusinessConfigurationManifestVersioned,readBusinessConfigurationCandidateVersioned,type BusinessConfigurationManifest,type BusinessConfigurationManifestV2} from '@teloa/contract'
import {versionOf,prepareBusinessConfigurationDefinition} from './business-definition-write.ts'

export const businessConfigurationHash=(value:unknown)=>createHash('sha256').update(industryUpdateCanonical(value)).digest('hex')
const corrupt=()=>new WorkError('teloa/storage-corrupt','业务配置存储不一致，已停止读取。')
export type BusinessConfigurationCurrent={ownerId:string;scope:string;version:number;manifest:BusinessConfigurationManifest|BusinessConfigurationManifestV2;hash:string;createdAt:string;leaves:ReturnType<typeof versionOf>[]}

export async function initializeBusinessConfigurations(pool:Pool):Promise<void>{
 await pool.query(`
 create table if not exists teloa_business_configuration_drafts(
 owner_id text not null,id uuid not null,scope_id text not null,revision integer not null check(revision>0),
 base_version integer not null check(base_version>=0),candidate jsonb not null,hash text not null check(hash~'^[a-f0-9]{64}$'),
 status text not null check(status in ('draft','applied')),created_at timestamptz not null,updated_at timestamptz not null,primary key(owner_id,id));
 create table if not exists teloa_business_configuration_versions(
 owner_id text not null,scope_id text not null,version integer not null check(version>0),manifest jsonb not null,
 hash text not null check(hash~'^[a-f0-9]{64}$'),created_at timestamptz not null,primary key(owner_id,scope_id,version));
 create table if not exists teloa_business_configuration_heads(
 owner_id text not null,scope_id text not null,version integer not null check(version>0),updated_at timestamptz not null,
 primary key(owner_id,scope_id),foreign key(owner_id,scope_id,version) references teloa_business_configuration_versions(owner_id,scope_id,version));
 create table if not exists teloa_business_configuration_receipts(
 owner_id text not null,request_id uuid not null,kind text not null,spec_hash text not null check(spec_hash~'^[a-f0-9]{64}$'),
 result jsonb not null,created_at timestamptz not null,primary key(owner_id,request_id));
 `)
}

export class BusinessConfigurationStore{
 readonly pool:Pool
 constructor(pool:Pool){this.pool=pool}
 /** 所有事实一次 SQL 读取，即使调用方用 READ COMMITTED 也来自同一 MVCC 快照。 */
 async currentInTransaction(db:PoolClient,ownerId:string,scope:string):Promise<BusinessConfigurationCurrent|undefined>{
  const row=(await db.query(`select
   (select configuration_managed from teloa_business_scopes where owner_id=$1 and scope=$2) managed,
   (select to_jsonb(h) from teloa_business_configuration_heads h where owner_id=$1 and scope_id=$2) head,
   (select to_jsonb(v) from teloa_business_configuration_versions v join teloa_business_configuration_heads h using(owner_id,scope_id,version) where v.owner_id=$1 and v.scope_id=$2) version,
   coalesce((select jsonb_agg(jsonb_build_object('head',to_jsonb(h),'leaf',to_jsonb(v))) from teloa_business_local_definition_heads h left join teloa_business_local_definitions v using(owner_id,scope_id,kind,local_id,version) where h.owner_id=$1 and h.scope_id=$2 and h.version is not null),'[]'::jsonb) leaves`,[ownerId,scope]).catch((error:unknown)=>{
   if(error&&typeof error==='object'&&'code' in error&&(error.code==='42P01'||error.code==='42703'))throw corrupt()
   throw error
  })).rows[0]
  if(!row.managed){if(row.head)throw corrupt();return undefined}
  try{
   if(!row.head||!row.version)throw corrupt()
   const stored=row.version,manifest=readBusinessConfigurationManifestVersioned(stored.manifest)
   if(manifest.scope!==scope||stored.hash!==businessConfigurationHash(manifest)||!Number.isSafeInteger(stored.version)||stored.version<1)throw corrupt()
   const leaves=(row.leaves as Array<{head:Record<string,unknown>;leaf:Record<string,unknown>|null}>).map(({head,leaf})=>{
    if(!leaf||!Number.isSafeInteger(head.revision)||Number(head.revision)<1)throw corrupt()
    return versionOf(scope,{...leaf,created_at:new Date(String(leaf.created_at))})
   })
   if(leaves.length!==manifest.definitions.length)throw corrupt()
   const refs=new Map(manifest.definitions.map(ref=>[ref.kind+'\0'+ref.localId,ref]))
   for(const leaf of leaves){
    const ref=refs.get(leaf.kind+'\0'+leaf.localId)
    if(!ref||ref.version!==leaf.version||ref.definitionHash!==leaf.definitionHash)throw corrupt()
    const parsed=prepareBusinessConfigurationDefinition(scope,leaf.kind,JSON.parse(leaf.body),manifest.format)
    if(parsed.localId!==leaf.localId||parsed.semver!==leaf.semver||parsed.body!==leaf.body||parsed.definitionHash!==leaf.definitionHash)throw corrupt()
   }
   // 对固定正文再过契约解析器，防止合法哈希包装了不合法定义。
   readBusinessConfigurationCandidateVersioned({...manifest,definitions:leaves.map(leaf=>({kind:leaf.kind,definition:JSON.parse(leaf.body)}))})
   const createdAt=new Date(stored.created_at).toISOString()
   const byKey=new Map(leaves.map(leaf=>[leaf.kind+'\0'+leaf.localId,leaf]))
   return {ownerId,scope,version:stored.version,manifest,hash:stored.hash,createdAt,leaves:manifest.definitions.map(ref=>byKey.get(ref.kind+'\0'+ref.localId)!)}
  }catch{throw corrupt()}
 }
 /** 旧入口在配置锁内调用；精简初始化只装旧表时保留 legacy 行为。 */
 async assertStandaloneMutationAllowed(db:PoolClient,ownerId:string,scope:string):Promise<void>{
  const {managed}=await readBusinessConfigurationManagement(db,ownerId,scope)
  if(managed)throw new WorkError('teloa/conflict','此业务由整体配置管理，请修改业务配置后预览采用。')
 }
}

/** 精简 legacy 初始化允许无表；调用方使用配置锁或同一只读快照保证一致性。 */
export async function readBusinessConfigurationManagement(db:PoolClient,ownerId:string,scope:string):Promise<{managed:boolean;hasHead:boolean;hasConfigurationTables:boolean}>{
 const tables=(await db.query("select to_regclass('teloa_business_scopes') scopes,to_regclass('teloa_business_configuration_heads') heads,to_regclass('teloa_business_configuration_versions') versions,to_regclass('teloa_business_local_definitions') leaves,to_regclass('teloa_business_local_definition_heads') leaf_heads")).rows[0]
 const managed=tables.scopes?(await db.query("select to_jsonb(s)->>'configuration_managed' managed from teloa_business_scopes s where owner_id=$1 and scope=$2",[ownerId,scope])).rows[0]?.managed==='true':false
 const head=tables.heads?(await db.query('select 1 from teloa_business_configuration_heads where owner_id=$1 and scope_id=$2',[ownerId,scope])).rowCount:0
 if(!managed&&head)throw corrupt()
 return {managed,hasHead:!!head,hasConfigurationTables:!!(tables.heads&&tables.versions&&tables.leaves&&tables.leaf_heads)}
}
