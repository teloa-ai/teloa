import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {
 WorkError,isBusinessScopeKey,industryUpdateCanonical,businessObjectReference,
 readBusinessImportAnyStageInput,readBusinessImportStageReceiptInput,readBusinessImportGetInput,readBusinessImportAnyInspectInput,
 readBusinessImportAnyPreviewInput,readBusinessImportApplyInput,readBusinessImportRevisionInput,readBusinessImportReceiptInput,
 readBusinessImportAnyDraft,readBusinessImportAnyReceipt,readBusinessImportFileRef,readBusinessImportTable,
 type BusinessImportActor,type BusinessImportAnyDraft,type BusinessImportAnyReceipt,type BusinessImportFileRef,type BusinessImportTable,
 type BusinessImportFilePort,type BusinessImportTablePort,type BusinessImportIssue,type BusinessImportInspection,type BusinessImportAnyInspection,type BusinessObjectReference,
 readBusinessImportWorkbookInputV2,readBusinessImportWorkbookV2,readBusinessImportTableV2,
 type BusinessImportXlsxPort,type BusinessImportSourceV2,type BusinessImportTableV2,type BusinessImportDraftV2,type BusinessImportWorkbookV2,
} from '@teloa/contract'
import type {BusinessDefinitionSourceReader} from './business-definition-source.ts'
import type {BusinessConfigurationStore} from './business-configuration-store.ts'
import type {BusinessRecordService} from './business-records.ts'
import type {BusinessSnapshotReferenceService} from './business-snapshot-references.ts'
import {readBusinessObjectSnapshot,businessObjectSnapshotHash} from './business-data.ts'
import {businessRecordSchemaFingerprint} from './business-record-schema.ts'
import {lockBusinessConfiguration} from './business-configuration-lock.ts'
import {businessImportHash,businessImportSourceIdentity,checkBusinessImportSignal,businessImportParseIssues,buildBusinessImportInspection,buildBusinessImportPreview} from './business-record-import-preview.ts'

import {businessImportXlsxSourceIdentity,businessImportXlsxRawDigest,businessImportXlsxPolicyDigest,businessImportXlsxContentKey,businessImportXlsxPreviewDigest,businessImportXlsxParseIssues,buildBusinessImportXlsxInspection,buildBusinessImportXlsxPreview} from './business-record-import-xlsx-preview.ts'

type Dependencies={definitions:Pick<BusinessDefinitionSourceReader,'forScopeVersioned'>;store:Pick<BusinessConfigurationStore,'currentInTransaction'>;records:Pick<BusinessRecordService,'get'|'batchInTransaction'>;references:Pick<BusinessSnapshotReferenceService,'pinInTransaction'>;files:BusinessImportFilePort;tables:BusinessImportTablePort;xlsx?:BusinessImportXlsxPort}
type DraftRow={owner_id:string;id:string;stage_request_id:string;stage_hash:string;scope_id:string;object_type:string;source_identity:string;draft_hash:string;draft:unknown;relation_references:unknown}
type ReceiptRow={owner_id:string;request_id:string;request_hash:string;kind:string;scope_id:string;object_type:string;source_identity:string|null;content_key:string|null;canonical_request_id:string|null;result_hash:string;result:unknown}
const corrupt=()=>new WorkError('teloa/storage-corrupt','表格导入草案、来源或固定回执不一致，请保留文件并联系支持。')
const forbidden=()=>new WorkError('teloa/forbidden','当前本人无权访问此业务表格，请切回原业务后重试。')
const conflict=()=>new WorkError('teloa/conflict','此请求标识已用于不同的导入操作，请使用原请求和原预览核对。')
const versionConflict=()=>new WorkError('teloa/version-conflict','表格草案或业务字段已改变，请重新读取并预览后确认。')
const sourceConflict=()=>new WorkError('teloa/conflict','此文件已按其他主键或映射导入，请使用原政策核对已有批次。',{reason:'source-policy-conflict'})
const hashPattern=/^[a-f0-9]{64}$/
function authorize(actor:BusinessImportActor,scope?:string):void{
 if(!actor||typeof actor.ownerId!=='string'||!actor.ownerId||actor.ownerId!==actor.ownerId.trim()||actor.ownerId.length>128||/[\x00-\x1f\x7f]/.test(actor.ownerId)||!Array.isArray(actor.scopeIds)||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(key=>!isBusinessScopeKey(key))||scope!==undefined&&!actor.scopeIds.includes(scope))throw forbidden()
}
function nextRevision(draft:BusinessImportAnyDraft):number{if(draft.revision>=2147483647)throw new WorkError('teloa/conflict','此表格草案版本已达上限，请保留文件并联系支持。');return draft.revision+1}
const same=(a:unknown,b:unknown)=>industryUpdateCanonical(a)===industryUpdateCanonical(b)
const xlsxDraft=(draft:BusinessImportAnyDraft):draft is BusinessImportDraftV2=>draft.format==='teloa.business-record-import/v2'
function sourceIdentity(owner:string,scope:string,type:string,fileHash:string,value:object){return 'format' in value&&typeof value.format==='string'&&value.format.endsWith('/v2')&&'source' in value?businessImportXlsxSourceIdentity(owner,scope,type,fileHash,value.source as BusinessImportSourceV2):businessImportSourceIdentity(owner,scope,type,fileHash)}
function sameFormat(input:object,draft:BusinessImportAnyDraft){if(('format' in input)!==xlsxDraft(draft))throw new WorkError('teloa/invalid-input','导入参数版本与原草案不一致，请使用原文件和工作表核对。')}


export async function initializeBusinessRecordImports(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_business_record_import_drafts(
  owner_id text not null,id uuid not null,stage_request_id uuid not null,stage_hash text not null check(stage_hash~'^[a-f0-9]{64}$'),
  scope_id text not null,object_type text not null,source_identity text not null check(source_identity~'^[a-f0-9]{64}$'),
  draft_hash text not null check(draft_hash~'^[a-f0-9]{64}$'),draft jsonb not null,relation_references jsonb not null default '[]',
  primary key(owner_id,id),unique(owner_id,stage_request_id));
 create table if not exists teloa_business_record_import_receipts(
  owner_id text not null,request_id uuid not null,request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
  kind text not null check(kind in ('apply','cancel','resume')),scope_id text not null,object_type text not null,
  source_identity text,content_key text,canonical_request_id uuid,result_hash text not null check(result_hash~'^[a-f0-9]{64}$'),result jsonb not null,
  primary key(owner_id,request_id),foreign key(owner_id,canonical_request_id) references teloa_business_record_import_receipts(owner_id,request_id),
  check((kind='apply' and canonical_request_id is not null and source_identity is not null and content_key is not null and source_identity~'^[a-f0-9]{64}$' and content_key~'^[a-f0-9]{64}$') or (kind<>'apply' and canonical_request_id is null and source_identity is null and content_key is null)));
 create unique index if not exists teloa_business_record_import_source_once on teloa_business_record_import_receipts(owner_id,scope_id,object_type,source_identity) where kind='apply' and request_id=canonical_request_id;
 create unique index if not exists teloa_business_record_import_content_once on teloa_business_record_import_receipts(owner_id,scope_id,object_type,content_key) where kind='apply' and request_id=canonical_request_id;
 create table if not exists teloa_business_record_import_source_keys(
  owner_id text not null,scope_id text not null,object_type text not null,source_identity text not null check(source_identity~'^[a-f0-9]{64}$'),
  source_policy_digest text not null check(source_policy_digest~'^[a-f0-9]{64}$'),content_key text not null check(content_key~'^[a-f0-9]{64}$'),
  canonical_request_id uuid not null,key_hash text not null check(key_hash~'^[a-f0-9]{64}$'),object_id uuid not null,
  primary key(owner_id,scope_id,object_type,source_identity,key_hash),
  foreign key(owner_id,canonical_request_id) references teloa_business_record_import_receipts(owner_id,request_id));`)
}

/** 文件与预览在事务外计算；正式记录仍只有既有 snapshot 真源。 */
export class BusinessRecordImportService{
 private readonly pool:Pool
 private readonly identity:{id:()=>string;now:()=>string}
 private readonly dependencies:Dependencies
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},dependencies:Dependencies){this.pool=pool;this.identity=identity;this.dependencies=dependencies}
 private async transaction<T>(write:boolean,run:(db:PoolClient)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  const db=await this.pool.connect()
  try{await db.query(write?'begin':'begin isolation level repeatable read read only');const result=await run(db);if(write)checkBusinessImportSignal(signal);await db.query('commit');return result}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 private async lockRequest(db:PoolClient,owner:string,requestId:string){await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa.business-import-request',owner,requestId])])}
 private async lockSourceDraft(db:PoolClient,owner:string,source:string,id:string){
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa.business-import-source',owner,source])])
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa.business-import-draft',owner,id])])
 }
 private draftOf(actor:BusinessImportActor,row:DraftRow):BusinessImportAnyDraft{
  let draft:BusinessImportAnyDraft
  try{draft=readBusinessImportAnyDraft(row.draft)}catch{throw corrupt()}
  if(draft.ownerId!==actor.ownerId||row.owner_id!==actor.ownerId||row.id!==draft.id||row.stage_request_id!==draft.stageRequestId||row.scope_id!==draft.scope||row.object_type!==draft.type||row.source_identity!==draft.sourceIdentity||row.draft_hash!==businessImportHash(draft)||!hashPattern.test(row.stage_hash)||draft.sourceIdentity!==sourceIdentity(actor.ownerId,draft.scope,draft.type,draft.file.sha256,draft))throw corrupt()
  if(xlsxDraft(draft)&&draft.preview){
   const preview=draft.preview
   if(!Array.isArray(row.relation_references))throw corrupt()
   let relations:BusinessObjectReference[];try{relations=row.relation_references.map(businessObjectReference)}catch{throw corrupt()}
   if(relations.some(ref=>ref.scope!==draft.scope)||preview.sourcePolicyDigest!==businessImportXlsxPolicyDigest(draft.file.sha256,draft.source,draft.policy,preview.rawCellsDigest,preview.mapping)||preview.contentKey!==businessImportXlsxContentKey(draft.sourceIdentity,preview.sourcePolicyDigest,preview.mapping,preview.writeSchemaFingerprint)||preview.digest!==businessImportXlsxPreviewDigest(draft.file.sha256,preview,relations))throw corrupt()
  }
  authorize(actor,draft.scope)
  return draft
 }
 private async draftRow(db:PoolClient,actor:BusinessImportActor,id:string,lock=false):Promise<DraftRow>{
  const row=(await db.query('select * from teloa_business_record_import_drafts where owner_id=$1 and id=$2'+(lock?' for update':''),[actor.ownerId,id])).rows[0] as DraftRow|undefined
  if(!row)throw new WorkError('teloa/not-found','未找到此表格草案，请使用原上传请求核对并切回原业务。')
  this.draftOf(actor,row);return row
 }
 private async stageRow(db:PoolClient,actor:BusinessImportActor,requestId:string):Promise<DraftRow|undefined>{return (await db.query('select * from teloa_business_record_import_drafts where owner_id=$1 and stage_request_id=$2',[actor.ownerId,requestId])).rows[0]}
 private async draftFact(db:PoolClient,actor:BusinessImportActor,row:DraftRow):Promise<BusinessImportAnyDraft>{
  const draft=this.draftOf(actor,row)
  if(draft.receipt){const receipt=await this.receiptRow(db,actor.ownerId,draft.receipt.requestId);if(!receipt||!same(await this.fixedReceipt(db,actor,receipt),draft.receipt))throw corrupt()}
  return draft
 }
 private async receiptRow(db:PoolClient,owner:string,requestId:string):Promise<ReceiptRow|undefined>{return (await db.query('select * from teloa_business_record_import_receipts where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0]}
 private async sourceRow(db:PoolClient,actor:BusinessImportActor,draft:BusinessImportAnyDraft):Promise<ReceiptRow|undefined>{return (await db.query("select * from teloa_business_record_import_receipts where owner_id=$1 and scope_id=$2 and object_type=$3 and source_identity=$4 and kind='apply' and request_id=canonical_request_id",[actor.ownerId,draft.scope,draft.type,draft.sourceIdentity])).rows[0]}
 private receiptOf(actor:BusinessImportActor,row:ReceiptRow):BusinessImportAnyReceipt{
  let receipt:BusinessImportAnyReceipt
  try{receipt=readBusinessImportAnyReceipt(row.result)}catch{throw corrupt()}
  if(row.kind!=='apply'||row.owner_id!==actor.ownerId||row.request_id!==receipt.requestId||row.scope_id!==receipt.scope||row.object_type!==receipt.type||row.source_identity!==receipt.sourceIdentity||row.content_key!==receipt.contentKey||row.canonical_request_id!==receipt.canonicalRequestId||row.result_hash!==businessImportHash(receipt)||!hashPattern.test(row.request_hash)||receipt.sourceIdentity!==sourceIdentity(actor.ownerId,receipt.scope,receipt.type,receipt.fileHash,receipt))throw corrupt()
  authorize(actor,receipt.scope);return receipt
 }
 /** 成功事实只核固定快照与来源索引，类型改名和当前head改变不否定旧回执。 */
 private async fixedReceipt(db:PoolClient,actor:BusinessImportActor,row:ReceiptRow):Promise<BusinessImportAnyReceipt>{
  const receipt=this.receiptOf(actor,row),canonicalRow=receipt.requestId===receipt.canonicalRequestId?row:await this.receiptRow(db,actor.ownerId,receipt.canonicalRequestId)
  if(!canonicalRow)throw corrupt()
  const canonical=this.receiptOf(actor,canonicalRow)
  if(!same(('format' in canonical?{format:canonical.format,source:canonical.source,policy:canonical.policy,rawCellsDigest:canonical.rawCellsDigest}:{}),('format' in receipt?{format:receipt.format,source:receipt.source,policy:receipt.policy,rawCellsDigest:receipt.rawCellsDigest}:{}))||canonical.requestId!==canonical.canonicalRequestId||canonical.scope!==receipt.scope||canonical.type!==receipt.type||canonical.fileHash!==receipt.fileHash||canonical.sourceIdentity!==receipt.sourceIdentity||canonical.sourcePolicyDigest!==receipt.sourcePolicyDigest||canonical.contentKey!==receipt.contentKey||canonical.created!==receipt.created||canonical.appliedAt!==receipt.appliedAt||!same(canonical.references,receipt.references))throw corrupt()
  if('format' in canonical){
   const stored=(await db.query('select * from teloa_business_record_import_drafts where owner_id=$1 and id=$2',[actor.ownerId,canonical.draftId])).rows[0] as DraftRow|undefined
   if(!stored)throw corrupt()
   const draft=this.draftOf(actor,stored)
   if(!xlsxDraft(draft)||!draft.preview||draft.sourceIdentity!==canonical.sourceIdentity||draft.file.sha256!==canonical.fileHash||!same(draft.source,canonical.source)||!same(draft.policy,canonical.policy)||draft.preview.rawCellsDigest!==canonical.rawCellsDigest||draft.preview.sourcePolicyDigest!==canonical.sourcePolicyDigest||draft.preview.contentKey!==canonical.contentKey||draft.preview.digest!==canonical.previewDigest)throw corrupt()
  }
  const keys=(await db.query('select source_policy_digest,content_key,canonical_request_id,key_hash,object_id from teloa_business_record_import_source_keys where owner_id=$1 and scope_id=$2 and object_type=$3 and source_identity=$4',[actor.ownerId,receipt.scope,receipt.type,receipt.sourceIdentity])).rows
  if(keys.length!==receipt.created||keys.some(key=>key.source_policy_digest!==receipt.sourcePolicyDigest||key.content_key!==receipt.contentKey||key.canonical_request_id!==receipt.canonicalRequestId||!hashPattern.test(key.key_hash))||!same(keys.map(key=>key.object_id).sort(),receipt.references.map(ref=>ref.id).sort()))throw corrupt()
  for(const ref of receipt.references){
   const snapshot=(await db.query('select snapshot_hash,snapshot from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 and object_version=$5',[actor.ownerId,ref.scope,ref.type,ref.id,ref.version])).rows[0]
   if(!snapshot)throw corrupt()
   let stored:ReturnType<typeof readBusinessObjectSnapshot>
   try{stored=readBusinessObjectSnapshot(snapshot.snapshot,ref.scope)}catch{throw corrupt()}
   if(stored.type!==ref.type||stored.id!==ref.id||stored.version!==ref.version||stored.source!=='本地记录'||stored.deletedAt||snapshot.snapshot_hash!==ref.snapshotHash||businessObjectSnapshotHash(stored)!==ref.snapshotHash)throw corrupt()
   if(!(await db.query("select 1 from teloa_business_snapshot_references where owner_id=$1 and scope_id=$2 and kind='import' and reference_id=$3 and object_type=$4 and object_id=$5 and object_version=$6",[actor.ownerId,ref.scope,receipt.canonicalRequestId,ref.type,ref.id,ref.version])).rowCount)throw corrupt()
  }
  return readBusinessImportAnyReceipt(receipt)
 }
 private async definition(db:PoolClient,actor:BusinessImportActor,target:{scope:string;type:string}){
  authorize(actor,target.scope)
  const bundles=await this.dependencies.definitions.forScopeVersioned(db,actor.ownerId,target.scope)
  const matches=bundles.flatMap(bundle=>bundle.objectTypes.filter(row=>row.definition.id===target.type).map(row=>({bundle,definition:row.definition})))
  const current=await this.dependencies.store.currentInTransaction(db,actor.ownerId,target.scope)
  if(matches.length!==1||matches[0]!.bundle.origin.kind!=='local-configuration'||!current||!matches[0]!.bundle.sources.has(matches[0]!.definition.sourceId)||!current.manifest.sources.some(source=>source.sourceId===matches[0]!.definition.sourceId&&source.kind==='local-records'))throw new WorkError('teloa/invalid-input','此对象尚未采用为本地业务记录，请先完成业务配置后导入。')
  if(bundles.some(bundle=>bundle.mappings.some(row=>row.definition.objectType===target.type)))throw new WorkError('teloa/conflict','此对象已有同步来源，记录归属需要核对；请先处理来源映射后再导入。')
  const invalid=(await db.query(`select 1 from teloa_business_object_snapshots s where s.owner_id=$1 and s.scope_id=$2 and s.object_type=$3 and
   (s.source_id<>$4 or s.snapshot->>'source'<>'本地记录' or not exists(select 1 from teloa_business_record_heads h where h.owner_id=s.owner_id and h.scope_id=s.scope_id and h.object_type=s.object_type and h.object_id=s.object_id and h.source_id=s.source_id)) limit 1`,[actor.ownerId,target.scope,target.type,matches[0]!.definition.sourceId])).rowCount
  if(invalid)throw new WorkError('teloa/conflict','此对象存在归属尚未核定的记录，请先核对来源后再导入。')
  return {definition:matches[0]!.definition,configurationVersion:current.version}
 }
 private async updateDraft(db:PoolClient,actor:BusinessImportActor,draft:BusinessImportAnyDraft,relations?:BusinessObjectReference[]):Promise<BusinessImportAnyDraft>{
  authorize(actor,draft.scope)
  if(Buffer.byteLength(industryUpdateCanonical(draft),'utf8')>1_048_576)throw new WorkError('teloa/invalid-input','表格预览内容超过草案大小限制，请拆分文件或减少映射字段后重新预览。')
  const valid=readBusinessImportAnyDraft(draft)
  const changed=await db.query('update teloa_business_record_import_drafts set draft=$3,draft_hash=$4'+(relations===undefined?'':',relation_references=$5')+' where owner_id=$1 and id=$2',[actor.ownerId,draft.id,JSON.stringify(valid),businessImportHash(valid),...(relations===undefined?[]:[JSON.stringify(relations)])])
  if(changed.rowCount!==1)throw corrupt();return valid
 }
 private async putReceipt(db:PoolClient,actor:BusinessImportActor,requestId:string,requestHash:string,kind:'apply'|'cancel'|'resume',scope:string,type:string,result:BusinessImportAnyReceipt|{draftId:string}):Promise<void>{
  authorize(actor,scope)
  const receipt=kind==='apply'?readBusinessImportAnyReceipt(result):undefined
  await db.query('insert into teloa_business_record_import_receipts(owner_id,request_id,request_hash,kind,scope_id,object_type,source_identity,content_key,canonical_request_id,result_hash,result) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[actor.ownerId,requestId,requestHash,kind,scope,type,receipt?.sourceIdentity??null,receipt?.contentKey??null,receipt?.canonicalRequestId??null,businessImportHash(result),JSON.stringify(result)])
 }
 private async readFile(file:BusinessImportFileRef,signal?:AbortSignal):Promise<Uint8Array>{
  checkBusinessImportSignal(signal);const trusted=readBusinessImportFileRef(file)
  const bytes=await this.dependencies.files.read(trusted,signal);checkBusinessImportSignal(signal)
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>2_097_152||bytes.byteLength!==trusted.bytes||createHash('sha256').update(bytes).digest('hex')!==trusted.sha256)throw new WorkError('teloa/file-changed','保存的表格文件大小或摘要已改变，请保留原文件并重新核对上传。')
  return bytes
 }
 private async parse(file:BusinessImportFileRef,delimiter:BusinessImportInspection['delimiter'],signal?:AbortSignal):Promise<{table?:BusinessImportTable;issues?:BusinessImportIssue[]}>{
  const bytes=await this.readFile(file,signal);checkBusinessImportSignal(signal)
  try{const table=await this.dependencies.tables.parse(bytes,{delimiter},signal);checkBusinessImportSignal(signal);return {table:readBusinessImportTable(table)}}
  catch(error){checkBusinessImportSignal(signal);return {issues:businessImportParseIssues(error)}}
 }
 private xlsx():BusinessImportXlsxPort{if(!this.dependencies.xlsx)throw new WorkError('teloa/dependency-unavailable','当前宿主未提供 XLSX 原文件读取，请保留文件并更新宿主。',{reason:'xlsx-port-unavailable'});return this.dependencies.xlsx}
 private async workbook(bytes:Uint8Array,signal?:AbortSignal):Promise<BusinessImportWorkbookV2>{
  checkBusinessImportSignal(signal);const snapshot=new Uint8Array(bytes),fileHash=createHash('sha256').update(snapshot).digest('hex')
  const workbook=readBusinessImportWorkbookV2(await this.xlsx().inspectWorkbook(snapshot,signal));checkBusinessImportSignal(signal)
  if(workbook.fileHash!==fileHash||workbook.bytes!==snapshot.byteLength)throw new WorkError('teloa/invalid-host-response','工作簿回包的原文件大小或摘要不一致。')
  return workbook
 }
 async inspectWorkbook(actor:BusinessImportActor,value:unknown,signal?:AbortSignal):Promise<BusinessImportWorkbookV2>{
  const input=readBusinessImportWorkbookInputV2(value);authorize(actor,input.scope);checkBusinessImportSignal(signal);this.xlsx()
  const initial=await this.transaction(false,db=>this.definition(db,actor,input)),raw=Buffer.from(input.dataBase64,'base64')
  const workbook=await this.workbook(raw,signal);authorize(actor,input.scope);checkBusinessImportSignal(signal)
  const current=await this.transaction(false,db=>this.definition(db,actor,input))
  if(current.configurationVersion!==initial.configurationVersion||businessRecordSchemaFingerprint(current.definition)!==businessRecordSchemaFingerprint(initial.definition))throw versionConflict()
  return workbook
 }
 private async parseXlsx(draft:BusinessImportDraftV2,signal?:AbortSignal):Promise<{table?:BusinessImportTableV2;issues?:BusinessImportIssue[]}>{
  this.xlsx();const bytes=new Uint8Array(await this.readFile(draft.file,signal));checkBusinessImportSignal(signal)
  try{
   const table=readBusinessImportTableV2(await this.xlsx().parseSheet(bytes,draft.source,signal));checkBusinessImportSignal(signal)
   if(!same(table.source,draft.source)||!same(table.policy,draft.policy))throw new WorkError('teloa/invalid-host-response','工作表读取回包与固定来源或政策不一致。')
   return {table}
  }catch(error){checkBusinessImportSignal(signal);return {issues:businessImportXlsxParseIssues(error)}}
 }
 async stage(actor:BusinessImportActor,value:unknown,signal?:AbortSignal):Promise<BusinessImportAnyDraft>{
  const input=readBusinessImportAnyStageInput(value);authorize(actor,input.scope);checkBusinessImportSignal(signal)
  const v2='format' in input;if(v2)this.xlsx()
  const {requestId,...body}=input,stageHash=businessImportHash([v2?'teloa.business-import-stage/v2':'teloa.business-import-stage/v1',body])
  const prior=await this.transaction(false,async db=>{const row=await this.stageRow(db,actor,requestId);if(!row)return undefined;const draft=await this.draftFact(db,actor,row);if(row.stage_hash!==stageHash)throw conflict();return draft})
  if(prior)return prior
  checkBusinessImportSignal(signal)
  const rawInput=Buffer.from(input.dataBase64,'base64'),workbook=v2?await this.workbook(rawInput,signal):undefined
  if(v2&&!workbook!.sheets.some(sheet=>same(sheet,input.source.sheet)))throw new WorkError('teloa/invalid-input','所选工作表与原文件的名称、编号或部件不一致。')
  authorize(actor,input.scope);checkBusinessImportSignal(signal)
  const saved=await this.dependencies.files.save({dataBase64:input.dataBase64,name:input.name,bytes:input.bytes},signal);checkBusinessImportSignal(signal)
  const file=readBusinessImportFileRef(saved),raw=Buffer.from(input.dataBase64,'base64')
  if(file.name!==input.name||file.bytes!==raw.byteLength||raw.byteLength>2_097_152||file.sha256!==createHash('sha256').update(raw).digest('hex'))throw new WorkError('teloa/invalid-host-response','附件保存的名称、大小或摘要不一致，请保留原文件并重试。')
  return this.transaction(true,async db=>{
   await this.lockRequest(db,actor.ownerId,requestId)
   const row=await this.stageRow(db,actor,requestId)
   if(row){const draft=await this.draftFact(db,actor,row);if(row.stage_hash!==stageHash)throw conflict();return draft}
   authorize(actor,input.scope);checkBusinessImportSignal(signal)
   const now=this.identity.now(),draft=readBusinessImportAnyDraft({format:v2?'teloa.business-record-import/v2':'teloa.business-record-import/v1',...(v2?{source:input.source,policy:workbook!.policy}:{}),id:this.identity.id(),stageRequestId:requestId,ownerId:actor.ownerId,scope:input.scope,type:input.type,sourceIdentity:sourceIdentity(actor.ownerId,input.scope,input.type,file.sha256,input),revision:1,status:'ready',file,createdAt:now,updatedAt:now})
   await this.lockSourceDraft(db,actor.ownerId,draft.sourceIdentity,draft.id)
   await lockBusinessConfiguration(db,actor.ownerId,input.scope,'shared');await this.definition(db,actor,input)
   // 本人草案计数另取owner锁，避免并发上传越过16份限额。
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa.business-import-draft-quota',actor.ownerId])])
   if((await db.query("select count(*)::int n from teloa_business_record_import_drafts where owner_id=$1 and draft->>'status'<>'applied'",[actor.ownerId])).rows[0].n>=16)throw new WorkError('teloa/conflict','本人未采用的表格草案已达16份，请先处理已有草案。')
   checkBusinessImportSignal(signal)
   await db.query('insert into teloa_business_record_import_drafts(owner_id,id,stage_request_id,stage_hash,scope_id,object_type,source_identity,draft_hash,draft) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[actor.ownerId,draft.id,requestId,stageHash,draft.scope,draft.type,draft.sourceIdentity,businessImportHash(draft),JSON.stringify(draft)])
   return draft
  },signal)
 }
 async stageReceipt(actor:BusinessImportActor,value:unknown):Promise<BusinessImportAnyDraft|undefined>{
  const input=readBusinessImportStageReceiptInput(value);authorize(actor,input.scope)
  return this.transaction(false,async db=>{const row=await this.stageRow(db,actor,input.requestId);if(!row)return undefined;const draft=await this.draftFact(db,actor,row);if(draft.scope!==input.scope||draft.type!==input.type)throw forbidden();return draft})
 }
 async get(actor:BusinessImportActor,value:unknown):Promise<BusinessImportAnyDraft>{
  const input=readBusinessImportGetInput(value);authorize(actor)
  return this.transaction(false,async db=>this.draftFact(db,actor,await this.draftRow(db,actor,input.draftId)))
 }
 async inspect(actor:BusinessImportActor,value:unknown,signal?:AbortSignal):Promise<BusinessImportAnyInspection>{
  const input=readBusinessImportAnyInspectInput(value),draft=await this.get(actor,{draftId:input.draftId})
  sameFormat(input,draft)
  if(draft.revision!==input.expectedRevision)throw versionConflict()
  const parsed=xlsxDraft(draft)?await this.parseXlsx(draft,signal):await this.parse(draft.file,'delimiter' in input?input.delimiter:',',signal);checkBusinessImportSignal(signal)
  const current=await this.get(actor,{draftId:draft.id});if(current.revision!==draft.revision)throw versionConflict()
  if(xlsxDraft(draft))return buildBusinessImportXlsxInspection({draftId:draft.id,scope:draft.scope,type:draft.type,fileHash:draft.file.sha256,revision:draft.revision,source:draft.source,policy:draft.policy,...parsed as {table?:BusinessImportTableV2;issues?:BusinessImportIssue[]}})
  return buildBusinessImportInspection({draftId:draft.id,scope:draft.scope,type:draft.type,fileHash:draft.file.sha256,revision:draft.revision,delimiter:'delimiter' in input?input.delimiter:',',...parsed as {table?:BusinessImportTable;issues?:BusinessImportIssue[]}})
 }
 async preview(actor:BusinessImportActor,value:unknown,signal?:AbortSignal):Promise<BusinessImportAnyDraft>{
  const input=readBusinessImportAnyPreviewInput(value);authorize(actor);checkBusinessImportSignal(signal)
  const initial=await this.transaction(false,async db=>{
   const draft=this.draftOf(actor,await this.draftRow(db,actor,input.draftId));sameFormat(input,draft)
   if(draft.status==='previewed'&&draft.revision===input.expectedRevision+1&&same(draft.mapping,input.mapping))return {kind:'replay' as const,draft}
   if(draft.revision!==input.expectedRevision)throw versionConflict()
   if(draft.status==='cancelled'||draft.status==='applied')throw new WorkError('teloa/conflict','此表格已取消或采用，请恢复草案或读取已有批次。')
   const schema=await this.definition(db,actor,draft),source=await this.sourceRow(db,actor,draft)
   return {kind:'prepare' as const,draft,...schema,sourceContentKey:source?this.receiptOf(actor,source).contentKey:undefined}
  })
  if(initial.kind==='replay'){
   if(xlsxDraft(initial.draft)){
    await this.readFile(initial.draft.file,signal)
    const current=await this.get(actor,{draftId:initial.draft.id})
    if(current.revision!==initial.draft.revision)throw versionConflict()
    checkBusinessImportSignal(signal);return current
   }
   return initial.draft
  }
  const parsed=xlsxDraft(initial.draft)?await this.parseXlsx(initial.draft,signal):await this.parse(initial.draft.file,'delimiter' in input.mapping?input.mapping.delimiter:',',signal)
  const relations:BusinessObjectReference[]=[],targets=new Map<string,Awaited<ReturnType<BusinessRecordService['get']>>>()
  const resolveReference=async(type:string,id:string)=>{
   const key=JSON.stringify([type,id]);let target=targets.get(key)
   if(!target){target=await this.dependencies.records.get(actor,{scope:initial.draft.scope,type,id});targets.set(key,target)}
   const ref=businessObjectReference({scope:target.scope,type:target.type,id:target.id,version:target.version,snapshotHash:target.snapshotHash});if(!relations.some(row=>same(row,ref)))relations.push(ref)
   return target
  }
  let sourceContentKey=initial.sourceContentKey
  for(let attempt=0;attempt<2;attempt++){
   const previewInput={scope:initial.draft.scope,type:initial.draft.type,fileHash:initial.draft.file.sha256,revision:nextRevision(initial.draft),sourceIdentity:initial.draft.sourceIdentity,configurationVersion:initial.configurationVersion,definition:initial.definition,mapping:input.mapping,sourceContentKey,resolveReference,signal}
   const preview=xlsxDraft(initial.draft)?await buildBusinessImportXlsxPreview({...previewInput,source:initial.draft.source,policy:initial.draft.policy,...parsed as {table?:BusinessImportTableV2;issues?:BusinessImportIssue[]}}):await buildBusinessImportPreview({...previewInput,mapping:{delimiter:',' ,...input.mapping},...parsed as {table?:BusinessImportTable;issues?:BusinessImportIssue[]}})
   const result=await this.transaction<BusinessImportAnyDraft|{retryContent:string}>(true,async db=>{
    await this.lockSourceDraft(db,actor.ownerId,initial.draft.sourceIdentity,initial.draft.id)
    const draft=this.draftOf(actor,await this.draftRow(db,actor,initial.draft.id,true))
    if(draft.status==='previewed'&&draft.revision===input.expectedRevision+1&&same(draft.mapping,input.mapping))return draft
    if(draft.revision!==input.expectedRevision)throw versionConflict()
    if(draft.status==='cancelled'||draft.status==='applied')throw new WorkError('teloa/conflict','此表格已取消或采用，请读取当前状态后继续。')
    const source=await this.sourceRow(db,actor,draft),currentContent=source?this.receiptOf(actor,source).contentKey:undefined
    if(currentContent!==sourceContentKey&&currentContent!==undefined)return {retryContent:currentContent}
    await lockBusinessConfiguration(db,actor.ownerId,draft.scope,'shared')
    if(businessRecordSchemaFingerprint((await this.definition(db,actor,draft)).definition)!==preview.schemaFingerprint)throw versionConflict()
    checkBusinessImportSignal(signal)
    return this.updateDraft(db,actor,readBusinessImportAnyDraft({...draft,status:'previewed',revision:preview.revision,mapping:preview.mapping,preview,updatedAt:this.identity.now()}),relations)
   },signal)
   if('format' in result)return result
   sourceContentKey=result.retryContent
  }
  throw sourceConflict()
 }
 private async assertRelations(db:PoolClient,actor:BusinessImportActor,row:DraftRow):Promise<void>{
  if(!Array.isArray(row.relation_references))throw corrupt()
  for(const value of row.relation_references){
   let ref:BusinessObjectReference;try{ref=businessObjectReference(value)}catch{throw corrupt()}
   if(ref.scope!==row.scope_id)throw corrupt()
   const target=(await db.query(`select h.current_version,s.snapshot_hash,s.snapshot from teloa_business_record_heads h join teloa_business_object_snapshots s
    on s.owner_id=h.owner_id and s.scope_id=h.scope_id and s.object_type=h.object_type and s.object_id=h.object_id and s.object_version=h.current_version
    where h.owner_id=$1 and h.scope_id=$2 and h.object_type=$3 and h.object_id=$4`,[actor.ownerId,ref.scope,ref.type,ref.id])).rows[0]
   if(!target||target.current_version!==ref.version||target.snapshot_hash!==ref.snapshotHash||target.snapshot?.deletedAt)throw new WorkError('teloa/version-conflict','预览中的关联记录已改变或归档，请重新预览后确认。')
  }
 }
 async apply(actor:BusinessImportActor,value:unknown,signal?:AbortSignal):Promise<BusinessImportAnyReceipt>{
  const input=readBusinessImportApplyInput(value);authorize(actor)
  const requestHash=businessImportHash(['teloa.business-import-apply/v1',input])
  const prior=await this.transaction(false,async db=>{const row=await this.receiptRow(db,actor.ownerId,input.requestId);if(!row)return undefined;if(row.kind!=='apply'||row.request_hash!==requestHash)throw conflict();return this.fixedReceipt(db,actor,row)})
  if(prior)return prior
  checkBusinessImportSignal(signal)
  const before=await this.get(actor,{draftId:input.draftId}),reparsed=xlsxDraft(before)?await this.parseXlsx(before,signal):undefined
  if(!xlsxDraft(before))await this.readFile(before.file,signal)
  return this.transaction(true,async db=>{
   await this.lockRequest(db,actor.ownerId,input.requestId)
   const existing=await this.receiptRow(db,actor.ownerId,input.requestId)
   if(existing){if(existing.kind!=='apply'||existing.request_hash!==requestHash)throw conflict();return this.fixedReceipt(db,actor,existing)}
   await this.lockSourceDraft(db,actor.ownerId,before.sourceIdentity,before.id)
   const row=await this.draftRow(db,actor,before.id,true),draft=this.draftOf(actor,row),preview=draft.preview
   if(draft.status==='cancelled')throw new WorkError('teloa/conflict','此表格已取消，请恢复并重新预览后确认。')
   if(!preview||!['previewed','applied'].includes(draft.status)||draft.status==='previewed'&&draft.revision!==input.previewRevision||preview.revision!==input.previewRevision||preview.digest!==input.previewDigest)throw versionConflict()
   if(!preview.canApply){if(preview.issues.some(issue=>issue.code==='source-policy-conflict'))throw sourceConflict();throw new WorkError('teloa/invalid-input','此预览仍有问题，请修正行列映射并重新预览后确认。')}
   if(xlsxDraft(draft)){
    if(!reparsed?.table||!same(reparsed.table.source,draft.source)||!same(reparsed.table.policy,draft.policy)||businessImportXlsxRawDigest(reparsed.table)!==draft.preview?.rawCellsDigest)throw new WorkError('teloa/file-changed','原工作表内容或读取政策已改变，请重新读取预览后确认。')
   }
   checkBusinessImportSignal(signal);authorize(actor,draft.scope)
   const source=await this.sourceRow(db,actor,draft)
   let receipt:BusinessImportAnyReceipt
   if(source){
    const canonical=await this.fixedReceipt(db,actor,source)
    if(canonical.contentKey!==preview.contentKey||canonical.sourcePolicyDigest!==preview.sourcePolicyDigest)throw sourceConflict()
    // 成功来源只写别名；取得配置共享锁后不进入记录锁域。
    await lockBusinessConfiguration(db,actor.ownerId,draft.scope,'shared')
    if(businessRecordSchemaFingerprint((await this.definition(db,actor,draft)).definition)!==preview.schemaFingerprint)throw versionConflict()
    if(canonical.created!==preview.rows.length)throw corrupt()
    receipt=readBusinessImportAnyReceipt({...canonical,requestId:input.requestId,draftId:draft.id,previewDigest:preview.digest})
    await this.putReceipt(db,actor,input.requestId,requestHash,'apply',draft.scope,draft.type,receipt)
   }else{
    // batch自行取得record-request→configuration→type/head，禁止提前持有反向锁。
    const batch=await this.dependencies.records.batchInTransaction(db,actor,{requestId:input.requestId,scope:draft.scope,operations:preview.rows.map(row=>row.operation)},undefined,{scope:draft.scope,type:draft.type,schemaFingerprint:preview.schemaFingerprint,receiptPolicy:'new-only'})
    // 新导入不能收养普通批次；原语的共享配置锁内仍再核完整预览定义。
    if(businessRecordSchemaFingerprint((await this.definition(db,actor,draft)).definition)!==preview.schemaFingerprint)throw versionConflict()
    await this.assertRelations(db,actor,row);checkBusinessImportSignal(signal)
    const references=batch.items.map(item=>businessObjectReference({scope:item.scope,type:item.type,id:item.id,version:item.version,snapshotHash:item.snapshotHash}))
    receipt=readBusinessImportAnyReceipt({...(xlsxDraft(draft)?{format:'teloa.business-import-receipt/v2',source:draft.source,policy:draft.policy,rawCellsDigest:draft.preview!.rawCellsDigest}:{}),requestId:input.requestId,canonicalRequestId:input.requestId,draftId:draft.id,scope:draft.scope,type:draft.type,fileHash:draft.file.sha256,previewDigest:preview.digest,sourceIdentity:draft.sourceIdentity,sourcePolicyDigest:preview.sourcePolicyDigest,contentKey:preview.contentKey,created:references.length,references,appliedAt:this.identity.now()})
    await this.putReceipt(db,actor,input.requestId,requestHash,'apply',draft.scope,draft.type,receipt)
    for(let index=0;index<preview.rows.length;index++){
     const ref=references[index]!
     await db.query('insert into teloa_business_record_import_source_keys(owner_id,scope_id,object_type,source_identity,source_policy_digest,content_key,canonical_request_id,key_hash,object_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[actor.ownerId,draft.scope,draft.type,draft.sourceIdentity,preview.sourcePolicyDigest,preview.contentKey,input.requestId,businessImportHash(preview.rows[index]!.primaryKey),ref.id])
     await this.dependencies.references.pinInTransaction(db,actor,{reference:ref,kind:'import',referenceId:input.requestId})
    }
   }
   checkBusinessImportSignal(signal)
   await this.updateDraft(db,actor,readBusinessImportAnyDraft({...draft,status:'applied',revision:nextRevision(draft),receipt,updatedAt:this.identity.now()}))
   return receipt
  },signal)
 }
 private async revise(actor:BusinessImportActor,kind:'cancel'|'resume',value:unknown):Promise<BusinessImportAnyDraft>{
  const input=readBusinessImportRevisionInput(value);authorize(actor)
  const requestHash=businessImportHash(['teloa.business-import-revision/v1',kind,input])
  return this.transaction(true,async db=>{
   await this.lockRequest(db,actor.ownerId,input.requestId)
   const prior=await this.receiptRow(db,actor.ownerId,input.requestId)
   if(prior){
    if(prior.kind!==kind||prior.request_hash!==requestHash)throw conflict()
    if(prior.owner_id!==actor.ownerId||prior.result_hash!==businessImportHash(prior.result)||!same(prior.result,{draftId:input.draftId}))throw corrupt()
    return this.draftFact(db,actor,await this.draftRow(db,actor,input.draftId))
   }
   const initial=this.draftOf(actor,await this.draftRow(db,actor,input.draftId))
   await this.lockSourceDraft(db,actor.ownerId,initial.sourceIdentity,initial.id)
   const draft=this.draftOf(actor,await this.draftRow(db,actor,initial.id,true))
   if(draft.status==='applied'){
    if(kind==='resume')throw new WorkError('teloa/conflict','此表格已采用，无法恢复为未采用草案；请查看原批次。')
    const receipt=await this.receiptRow(db,actor.ownerId,draft.receipt!.requestId)
    if(!receipt||!same(await this.fixedReceipt(db,actor,receipt),draft.receipt))throw corrupt()
   }else if(draft.revision!==input.expectedRevision)throw versionConflict()
   let result=draft
   if(kind==='cancel'&&draft.status!=='cancelled'&&draft.status!=='applied')result=await this.updateDraft(db,actor,readBusinessImportAnyDraft({...draft,status:'cancelled',revision:nextRevision(draft),updatedAt:this.identity.now()}))
   if(kind==='resume'){
    if(draft.status!=='cancelled'&&draft.status!=='ready')throw new WorkError('teloa/conflict','请先取消当前预览，或继续确认已有预览。')
    if(draft.status==='cancelled'){
     const {preview:_,receipt:__,...ready}=draft
     result=await this.updateDraft(db,actor,{...ready,status:'ready',revision:nextRevision(draft),updatedAt:this.identity.now()},[])
    }
   }
   await this.putReceipt(db,actor,input.requestId,requestHash,kind,result.scope,result.type,{draftId:result.id})
   return result
  })
 }
 async cancel(actor:BusinessImportActor,value:unknown):Promise<BusinessImportAnyDraft>{return this.revise(actor,'cancel',value)}
 async resume(actor:BusinessImportActor,value:unknown):Promise<BusinessImportAnyDraft>{return this.revise(actor,'resume',value)}
 async receipt(actor:BusinessImportActor,value:unknown):Promise<BusinessImportAnyReceipt|undefined>{
  const input=readBusinessImportReceiptInput(value);authorize(actor,input.scope)
  return this.transaction(false,async db=>{const row=await this.receiptRow(db,actor.ownerId,input.requestId);if(!row||row.kind!=='apply')return undefined;const receipt=await this.fixedReceipt(db,actor,row);if(receipt.scope!==input.scope)throw forbidden();return receipt})
 }
}
