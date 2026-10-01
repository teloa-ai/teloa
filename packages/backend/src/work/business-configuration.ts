import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,isBusinessScopeKey,readBusinessConfigurationManifestVersioned,businessConfigurationFormatV2,type BusinessConfigurationCandidate,type BusinessConfigurationCandidateV2,type BusinessObjectTypeDefinition,type BusinessObjectTypeDefinitionV2} from '@teloa/contract'
import {BusinessConfigurationStore,businessConfigurationHash,type BusinessConfigurationCurrent} from './business-configuration-store.ts'
import {lockBusinessConfigurationRequests,type BusinessConfigurationActor,type BusinessConfigurationDraftService} from './business-configuration-drafts.ts'
import {lockBusinessConfiguration} from './business-configuration-lock.ts'
import {businessConfigurationDependencyHash,verifiesBusinessConfigurationPreviewReceipt} from './business-configuration-preview-receipt.ts'
import {prepareBusinessConfigurationDefinition,insertBusinessDefinitionVersion} from './business-definition-write.ts'
import type {BusinessDefinitionSourceReader} from './business-definition-source.ts'
import {lockBusinessRuntime,type BusinessRuntimeService} from './business-runtime.ts'
import type {BusinessSpaceService} from './business-spaces.ts'
import {readBusinessObjectSnapshot,businessObjectSnapshotHash} from './business-data.ts'
import {assertBusinessRecordFieldValue} from './business-record-values.ts'
import {BusinessScopeService} from './business-scopes.ts'
import {assertBusinessConfigurationUniqueRecords} from './business-record-constraints.ts'

export type BusinessConfigurationResult={scope:string;version:number;configurationHash:string;requestId:string}
type Dependencies={drafts:Pick<BusinessConfigurationDraftService,'draftInTransaction'>;store:Pick<BusinessConfigurationStore,'currentInTransaction'>;definitions:Pick<BusinessDefinitionSourceReader,'forConfigurationCandidate'|'forScope'>&Partial<Pick<BusinessDefinitionSourceReader,'forConfigurationCandidateVersioned'|'forScopeVersioned'>>;runtime:Pick<BusinessRuntimeService,'registerInTransaction'>;spaces:Pick<BusinessSpaceService,'ensurePersonalInTransaction'>}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const invalid=()=>new WorkError('teloa/invalid-input','业务配置采用请求格式不正确。')
const forbidden=()=>new WorkError('teloa/forbidden','当前主体未获准访问此业务配置。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','业务配置回执与固定版本不一致。')
const conflict=()=>new WorkError('teloa/version-conflict','业务配置或草案已变化，请重新预览。')
function authorize(actor:BusinessConfigurationActor,scope?:string){
 if(!actor||typeof actor.ownerId!=='string'||!actor.ownerId.trim()||actor.ownerId!==actor.ownerId.trim()||actor.ownerId.length>128||/[\x00-\x1f\x7f]/.test(actor.ownerId)||!Array.isArray(actor.scopeIds)||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(s=>!isBusinessScopeKey(s))||(scope!==undefined&&!actor.scopeIds.includes(scope)))throw forbidden()
}
const cancelled=(signal?:AbortSignal)=>signal?.throwIfAborted()
/** 检查所有固定历史，归档不免除迁移约束；绝不改写快照。 */
async function assertCompatibleRecords(db:PoolClient,ownerId:string,candidate:BusinessConfigurationCandidate|BusinessConfigurationCandidateV2,current:BusinessConfigurationCurrent|undefined,signal?:AbortSignal){
 const previous=new Map((current?.leaves??[]).filter(leaf=>leaf.kind==='object-type').map(leaf=>[leaf.localId,JSON.parse(leaf.body) as BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2]))
 const next=new Map(candidate.definitions.filter(item=>item.kind==='object-type').map(item=>[item.definition.id,item.definition as BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2]))
 const migrate=()=>new WorkError('teloa/conflict','配置变化与已有历史记录不兼容，需要先迁移数据。')
 let cursor:[string,string,number]|undefined
 for(;;){
 cancelled(signal)
 const rows=(await db.query('select object_type,object_id,object_version,snapshot_hash,snapshot,source_id from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2'+(cursor?' and (object_type,object_id,object_version)>($3,$4,$5)':'')+' order by object_type,object_id,object_version limit 200',[ownerId,candidate.scope,...(cursor??[])])).rows
 for(const row of rows){
  let snapshot:ReturnType<typeof readBusinessObjectSnapshot>
  try{
   snapshot=readBusinessObjectSnapshot(row.snapshot,candidate.scope)
   if(snapshot.type!==row.object_type||snapshot.id!==row.object_id||snapshot.version!==row.object_version||businessObjectSnapshotHash(snapshot)!==row.snapshot_hash)throw Error()
  }catch{throw new WorkError('teloa/storage-corrupt','固定业务对象快照身份或摘要损坏。')}
  const old=previous.get(snapshot.type),definition=next.get(snapshot.type)
  if(!old||!definition||old.sourceId!==definition.sourceId||row.source_id!==old.sourceId)throw migrate()
  for(const field of old.fields){
   const changed=definition.fields.find(value=>value.name===field.name)
   if(!changed||changed.from!==field.from||changed.type!==field.type||('referenceType' in changed?changed.referenceType:undefined)!==('referenceType' in field?field.referenceType:undefined)||('values' in field&&field.values?.some(value=>!('values' in changed)||!changed.values?.includes(value))))throw migrate()
  }
  for(const field of definition.fields){
   try{assertBusinessRecordFieldValue(field,snapshot.fields.find(value=>value.label===field.from)?.value)}catch{throw migrate()}
  }
 }
 if(rows.length<200)break
 const last=rows[rows.length-1]!;cursor=[last.object_type,last.object_id,last.object_version]
 }
}
/** 本人请求锁 → 配置锁 → 草案/head → 本人空间 → runtime → scope行 → 叶子。 */
export class BusinessConfigurationService{
 readonly pool:Pool
 readonly identity:{now:()=>string}
 readonly dependencies:Dependencies
 constructor(pool:Pool,identity:{now:()=>string},dependencies:Dependencies){this.pool=pool;this.identity=identity;this.dependencies=dependencies}
 private async transaction<T>(work:(db:PoolClient)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  cancelled(signal);const db=await this.pool.connect()
  try{await db.query('begin');const result=await work(db);cancelled(signal);await db.query('commit');return result}
  catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
 private async readReceipt(db:PoolClient,actor:BusinessConfigurationActor,requestId:string,specHash?:string):Promise<BusinessConfigurationResult|undefined>{
  const row=(await db.query('select * from teloa_business_configuration_receipts where owner_id=$1 and request_id=$2',[actor.ownerId,requestId])).rows[0]
  if(!row)return undefined
  if(row.kind!=='apply'||(specHash!==undefined&&row.spec_hash!==specHash))throw new WorkError('teloa/conflict','同一请求身份已用于不同的业务配置操作。')
  const result=row.result as BusinessConfigurationResult
  if(!result||!isBusinessScopeKey(result.scope)||!Number.isSafeInteger(result.version)||result.version<1||result.requestId!==requestId||typeof result.configurationHash!=='string')throw corrupt()
  authorize(actor,result.scope)
  const fixed=(await db.query('select manifest,hash from teloa_business_configuration_versions where owner_id=$1 and scope_id=$2 and version=$3',[actor.ownerId,result.scope,result.version])).rows[0]
  try{if(!fixed||fixed.hash!==result.configurationHash||businessConfigurationHash(readBusinessConfigurationManifestVersioned(fixed.manifest))!==fixed.hash||fixed.manifest.scope!==result.scope)throw corrupt()}catch{throw corrupt()}
  return result
 }
 async receipt(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessConfigurationResult|undefined>{
  authorize(actor);const row=taskInput(input,['requestId']);if(!uuid(row.requestId))throw invalid()
  const requestId=row.requestId.toLowerCase();return this.transaction(db=>this.readReceipt(db,actor,requestId))
 }
 async current(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessConfigurationCurrent|undefined>{
  const row=taskInput(input,['scope']);if(!isBusinessScopeKey(row.scope))throw invalid();authorize(actor,row.scope)
  return this.transaction(db=>this.dependencies.store.currentInTransaction(db,actor.ownerId,row.scope as string))
 }
 async apply(actor:BusinessConfigurationActor,input:unknown,signal?:AbortSignal):Promise<BusinessConfigurationResult>{
  authorize(actor);const row=taskInput(input,['requestId','draftId','expectedRevision','expectedBaseVersion','previewReceipt'])
  if(!uuid(row.requestId)||!uuid(row.draftId)||!Number.isSafeInteger(row.expectedRevision)||Number(row.expectedRevision)<1||!Number.isSafeInteger(row.expectedBaseVersion)||Number(row.expectedBaseVersion)<0||typeof row.previewReceipt!=='string'||!row.previewReceipt||row.previewReceipt.length>2048)throw invalid()
  const requestId=row.requestId.toLowerCase(),draftId=row.draftId.toLowerCase(),specHash=businessConfigurationHash({kind:'apply',...row,requestId,draftId})
  return this.transaction(async db=>{
   await lockBusinessConfigurationRequests(db,actor.ownerId);cancelled(signal)
   const prior=await this.readReceipt(db,actor,requestId,specHash);if(prior)return prior
   const initial=(await db.query('select scope_id from teloa_business_configuration_drafts where owner_id=$1 and id=$2',[actor.ownerId,draftId])).rows[0]
   if(!initial)throw forbidden()
   await lockBusinessConfiguration(db,actor.ownerId,initial.scope_id);cancelled(signal)
   await db.query('select id from teloa_business_configuration_drafts where owner_id=$1 and id=$2 for update',[actor.ownerId,draftId])
   const draft=await this.dependencies.drafts.draftInTransaction(db,actor,draftId)
   if(draft.scope!==initial.scope_id)throw corrupt()
   const versioned=draft.candidate.format===businessConfigurationFormatV2,reader=this.dependencies.definitions
   if(versioned&&(!reader.forConfigurationCandidateVersioned||!reader.forScopeVersioned))throw new WorkError('teloa/dependency-unavailable','富字段配置读取尚未接入，草案已保留。')
   const current=await this.dependencies.store.currentInTransaction(db,actor.ownerId,draft.scope)
   if(draft.status!=='draft'||draft.revision!==row.expectedRevision||draft.baseVersion!==row.expectedBaseVersion||draft.baseVersion!==(current?.version??0))throw conflict()
   if(!verifiesBusinessConfigurationPreviewReceipt(row.previewReceipt,{ownerId:actor.ownerId,draftId,scope:draft.scope,revision:draft.revision,candidateHash:draft.hash,baseVersion:draft.baseVersion,dependencyHash:businessConfigurationDependencyHash(current)}))throw new WorkError('teloa/conflict','请由本人重新预览当前业务配置后采用。',{reason:'preview-receipt-invalid'})
   if(versioned)await reader.forConfigurationCandidateVersioned!(db,actor.ownerId,draft.candidate)
   else await reader.forConfigurationCandidate(db,actor.ownerId,draft.candidate)
   await assertBusinessConfigurationUniqueRecords(db,actor.ownerId,draft.candidate,signal)
   cancelled(signal)
   if(!current){
    const space=await this.dependencies.spaces.ensurePersonalInTransaction(db,actor.ownerId)
    await lockBusinessRuntime(db,actor.ownerId,draft.scope,'exclusive');cancelled(signal)
    const inserted=await BusinessScopeService.ensure(db,actor.ownerId,{scope:draft.scope,title:draft.candidate.title,kind:'domain',spaceId:space.id})
    if(!inserted.created)throw new WorkError('teloa/conflict','业务范围已登记，不能自动接管。')
   }
   await this.dependencies.runtime.registerInTransaction(db,actor.ownerId,draft.scope);cancelled(signal)
   await assertCompatibleRecords(db,actor.ownerId,draft.candidate,current,signal)
   const now=this.identity.now(),refs=[]
   for(const item of draft.candidate.definitions){
    cancelled(signal)
    const prepared=prepareBusinessConfigurationDefinition(draft.scope,item.kind,item.definition,draft.candidate.format)
    const previous=current?.leaves.find(leaf=>leaf.kind===item.kind&&leaf.localId===prepared.localId)
    const leaf=previous?.definitionHash===prepared.definitionHash?previous:await insertBusinessDefinitionVersion(db,{ownerId:actor.ownerId,scope:draft.scope,kind:item.kind,definition:item.definition,draftId,now,configurationFormat:draft.candidate.format})
    refs.push({kind:item.kind,localId:leaf.localId,version:leaf.version,definitionHash:leaf.definitionHash})
    if(previous?.version!==leaf.version)await db.query('insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at) values($1,$2,$3,$4,$5,1,$6) on conflict(owner_id,scope_id,kind,local_id) do update set version=excluded.version,revision=teloa_business_local_definition_heads.revision+1,updated_at=excluded.updated_at',[actor.ownerId,draft.scope,item.kind,leaf.localId,leaf.version,now])
   }
   for(const leaf of current?.leaves??[])if(!refs.some(ref=>ref.kind===leaf.kind&&ref.localId===leaf.localId))await db.query('update teloa_business_local_definition_heads set version=null,revision=revision+1,updated_at=$5 where owner_id=$1 and scope_id=$2 and kind=$3 and local_id=$4',[actor.ownerId,draft.scope,leaf.kind,leaf.localId,now])
   const manifest=readBusinessConfigurationManifestVersioned({...draft.candidate,definitions:refs}),version=(current?.version??0)+1,hash=businessConfigurationHash(manifest)
   await db.query('update teloa_business_scopes set configuration_managed=true,title=$3 where owner_id=$1 and scope=$2',[actor.ownerId,draft.scope,manifest.title])
   await db.query('insert into teloa_business_configuration_versions(owner_id,scope_id,version,manifest,hash,created_at) values($1,$2,$3,$4,$5,$6)',[actor.ownerId,draft.scope,version,JSON.stringify(manifest),hash,now])
   await db.query('insert into teloa_business_configuration_heads(owner_id,scope_id,version,updated_at) values($1,$2,$3,$4) on conflict(owner_id,scope_id) do update set version=excluded.version,updated_at=excluded.updated_at',[actor.ownerId,draft.scope,version,now])
   await db.query("update teloa_business_configuration_drafts set status='applied',updated_at=$3 where owner_id=$1 and id=$2",[actor.ownerId,draftId,now])
   if(versioned)await reader.forScopeVersioned!(db,actor.ownerId,draft.scope)
   else await reader.forScope(db,actor.ownerId,draft.scope)
   const result={scope:draft.scope,version,configurationHash:hash,requestId}
   await db.query("insert into teloa_business_configuration_receipts(owner_id,request_id,kind,spec_hash,result,created_at) values($1,$2,'apply',$3,$4,$5)",[actor.ownerId,requestId,specHash,JSON.stringify(result),now])
   return result
  },signal)
 }
}
