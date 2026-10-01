import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,isBusinessScopeKey,businessConfigurationLimits,businessConfigurationFormat,businessConfigurationFormatV2,businessObjectTypeFormatV2,readBusinessConfigurationCandidateVersioned,readBusinessConfigurationPatchVersioned,type BusinessConfigurationCandidate,type BusinessConfigurationCandidateV2,type BusinessConfigurationPatch,type BusinessConfigurationPatchV2} from '@teloa/contract'
import {BusinessConfigurationStore,businessConfigurationHash} from './business-configuration-store.ts'
import {lockBusinessConfiguration} from './business-configuration-lock.ts'

export type BusinessConfigurationActor={ownerId:string;scopeIds:string[]}
type Candidate=BusinessConfigurationCandidate|BusinessConfigurationCandidateV2
export type BusinessConfigurationDraft={ownerId:string;id:string;scope:string;revision:number;baseVersion:number;candidate:Candidate;hash:string;status:'draft'|'applied';createdAt:string;updatedAt:string}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const invalid=()=>new WorkError('teloa/invalid-input','业务配置请求格式不正确。')
const forbidden=()=>new WorkError('teloa/forbidden','业务配置草案不存在或当前主体未获准访问。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','业务配置草案存储不一致，已停止读取。')
function actorValid(actor:BusinessConfigurationActor){
 if(!actor||typeof actor.ownerId!=='string'||!actor.ownerId.trim()||actor.ownerId!==actor.ownerId.trim()||actor.ownerId.length>128||/[\x00-\x1f\x7f]/.test(actor.ownerId)||!Array.isArray(actor.scopeIds)||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(s=>!isBusinessScopeKey(s)))throw forbidden()
}
function reviseInput(input:unknown){
 const row=taskInput(input,['draftId','expectedRevision','requestId','patch'])
 if(!uuid(row.draftId)||!uuid(row.requestId)||!Number.isSafeInteger(row.expectedRevision)||Number(row.expectedRevision)<1||!('patch' in row))throw invalid()
 return {draftId:row.draftId.toLowerCase(),expectedRevision:row.expectedRevision as number,requestId:row.requestId.toLowerCase(),patch:row.patch}
}
function readDraft(row:Record<string,unknown>):BusinessConfigurationDraft{
 try{
  if(!uuid(row.id)||typeof row.owner_id!=='string'||!Number.isSafeInteger(row.revision)||Number(row.revision)<1||!Number.isSafeInteger(row.base_version)||Number(row.base_version)<0||(row.status!=='draft'&&row.status!=='applied'))throw corrupt()
  const candidate=readBusinessConfigurationCandidateVersioned(row.candidate)
  if(row.scope_id!==candidate.scope||row.hash!==businessConfigurationHash(candidate))throw corrupt()
  return {ownerId:row.owner_id,id:row.id,scope:candidate.scope,revision:Number(row.revision),baseVersion:Number(row.base_version),candidate,hash:String(row.hash),status:row.status,createdAt:(row.created_at instanceof Date?row.created_at:new Date(String(row.created_at))).toISOString(),updatedAt:(row.updated_at instanceof Date?row.updated_at:new Date(String(row.updated_at))).toISOString()}
 }catch{throw corrupt()}
}
function fromResult(value:unknown):BusinessConfigurationDraft{
 const r=value as BusinessConfigurationDraft
 if(!r||typeof r!=='object')throw corrupt()
 return readDraft({owner_id:r.ownerId,id:r.id,scope_id:r.scope,revision:r.revision,base_version:r.baseVersion,candidate:r.candidate,hash:r.hash,status:r.status,created_at:r.createdAt,updated_at:r.updatedAt})
}
function merge(candidate:Candidate,patch:BusinessConfigurationPatch|BusinessConfigurationPatchV2):Candidate{
 const key=(kind:string,id:string)=>kind+'\0'+id
 const removed=new Set(patch.removeDefinitions?.map(r=>key(r.kind,r.localId)))
 const definitions=new Map<string,BusinessConfigurationCandidate['definitions'][number]|BusinessConfigurationCandidateV2['definitions'][number]>(candidate.definitions.filter(d=>!removed.has(key(d.kind,d.definition.id))).map(d=>[key(d.kind,d.definition.id),d]))
 for(const d of patch.upsertDefinitions??[])definitions.set(key(d.kind,d.definition.id),d)
 const pages=new Map(candidate.pages.filter(p=>!patch.removePageIds?.includes(p.id)).map(p=>[p.id,p]))
 for(const p of patch.upsertPages??[])pages.set(p.id,p)
 if(patch.pageOrder&&(patch.pageOrder.length!==pages.size||patch.pageOrder.some(id=>!pages.has(id))))throw invalid()
 const ordered=patch.pageOrder?patch.pageOrder.map(id=>pages.get(id)!):[...pages.values()]
 if(!ordered.length&&patch.homePageId!==undefined)throw invalid()
 const {homePageId:oldHome,...rest}=candidate
 return readBusinessConfigurationCandidateVersioned({...rest,title:patch.title??candidate.title,definitions:[...definitions.values()],pages:ordered,...(ordered.length?{homePageId:patch.homePageId??oldHome}:{})})
}
/** 整体 begin/revise/upgrade/apply 共用；必须先于范围锁和任何草案行锁。 */
export async function lockBusinessConfigurationRequests(db:PoolClient,ownerId:string):Promise<void>{
 await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa.business-configuration-requests',ownerId])])
}
export class BusinessConfigurationDraftService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}
 private async transaction<T>(work:(db:PoolClient)=>Promise<T>,readOnly=false):Promise<T>{
  const db=await this.pool.connect()
  try{await db.query(readOnly?'begin read only':'begin');const result=await work(db);await db.query('commit');return result}
  catch(error){
   await db.query('rollback').catch(()=>{})
   if(error instanceof WorkError)throw error
   throw new WorkError('teloa/dependency-unavailable','业务配置暂时无法保存，请稍后再试。')
  }finally{db.release()}
 }
 private async request(db:PoolClient,ownerId:string,requestId:string,kind:string,specHash:string|((result:BusinessConfigurationDraft)=>string)):Promise<BusinessConfigurationDraft|undefined>{
  // 本人级锁同时串行请求回执和创建额度；其后才取 scope 锁。
  await lockBusinessConfigurationRequests(db,ownerId)
  const row=(await db.query('select * from teloa_business_configuration_receipts where owner_id=$1 and request_id=$2',[ownerId,requestId])).rows[0]
  if(!row)return undefined
  if(row.kind!==kind||(typeof specHash==='string'&&row.spec_hash!==specHash))throw new WorkError('teloa/conflict','同一请求身份已用于不同的业务配置操作。')
  const result=fromResult(row.result)
  if(result.ownerId!==ownerId)throw corrupt()
  if(typeof specHash==='function'&&row.spec_hash!==specHash(result))throw new WorkError('teloa/conflict','同一请求身份已用于不同的业务配置操作。')
  return result
 }
 private async receipt(db:PoolClient,ownerId:string,requestId:string,kind:string,specHash:string,result:BusinessConfigurationDraft){
  await db.query('insert into teloa_business_configuration_receipts(owner_id,request_id,kind,spec_hash,result,created_at) values($1,$2,$3,$4,$5,$6)',[ownerId,requestId,kind,specHash,JSON.stringify(result),this.identity.now()])
  return result
 }
 async begin(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessConfigurationDraft>{
  actorValid(actor)
  const row=taskInput(input,['requestId','title','scope','format'])
  if(!uuid(row.requestId)||(row.scope!==undefined&&(!isBusinessScopeKey(row.scope)||row.scope==='general'))||(row.format!==undefined&&row.format!==businessConfigurationFormat&&row.format!==businessConfigurationFormatV2))throw invalid()
  const requestId=row.requestId.toLowerCase(),specHash=businessConfigurationHash({kind:'begin',title:row.title,...(row.scope===undefined?{}:{scope:row.scope}),...(row.format===undefined?{}:{format:row.format})})
  return this.transaction(async db=>{
   const prior=await this.request(db,actor.ownerId,requestId,'begin',specHash)
   if(prior){if(prior.baseVersion>0&&!actor.scopeIds.includes(prior.scope))throw forbidden();return prior}
   const count=Number((await db.query("select count(*)::int n from teloa_business_configuration_drafts where owner_id=$1 and status='draft'",[actor.ownerId])).rows[0].n)
   if(count>=businessConfigurationLimits.pendingDraftsPerOwner)throw new WorkError('teloa/conflict','本人未采用的业务配置草案已达 16 份。')
   const id=this.identity.id(),scope=row.scope??'business_'+this.identity.id().replaceAll('-','')
   if(!uuid(id)||!isBusinessScopeKey(scope))throw invalid()
   let baseVersion=0,candidate:Candidate
   await lockBusinessConfiguration(db,actor.ownerId,scope)
   if(row.scope!==undefined){
    if(!actor.scopeIds.includes(scope))throw forbidden()
    const current=await new BusinessConfigurationStore(this.pool).currentInTransaction(db,actor.ownerId,scope)
    if(!current)throw forbidden()
    if(row.format!==undefined&&row.format!==current.manifest.format)throw new WorkError('teloa/version-conflict','现有业务配置格式与请求不一致。')
    baseVersion=current.version
    candidate=readBusinessConfigurationCandidateVersioned({...current.manifest,title:row.title,definitions:current.leaves.map(d=>({kind:d.kind,definition:JSON.parse(d.body)}))})
   }else{
    const sourceId='records-'+this.identity.id().replaceAll('-','')
    candidate=readBusinessConfigurationCandidateVersioned({format:row.format??businessConfigurationFormat,scope,title:row.title,sources:[{sourceId,kind:'local-records'}],definitions:[],pages:[]})
   }
   const now=this.identity.now(),hash=businessConfigurationHash(candidate)
   const saved=(await db.query("insert into teloa_business_configuration_drafts(owner_id,id,scope_id,revision,base_version,candidate,hash,status,created_at,updated_at) values($1,$2,$3,1,$4,$5,$6,'draft',$7,$7) returning *",[actor.ownerId,id,scope,baseVersion,JSON.stringify(candidate),hash,now])).rows[0]
   return this.receipt(db,actor.ownerId,requestId,'begin',specHash,readDraft(saved))
  })
 }
 async get(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessConfigurationDraft>{
  actorValid(actor);const row=taskInput(input,['draftId']);if(!uuid(row.draftId))throw invalid()
  const db=await this.pool.connect()
  try{return await this.draftInTransaction(db,actor,row.draftId)}finally{db.release()}
 }
 /** 调用方负责事务；预览可在同一只读快照内读取完整草案。 */
 async draftInTransaction(db:PoolClient,actor:BusinessConfigurationActor,draftId:string):Promise<BusinessConfigurationDraft>{
  actorValid(actor);if(!uuid(draftId))throw invalid()
  const saved=(await db.query('select * from teloa_business_configuration_drafts where owner_id=$1 and id=$2',[actor.ownerId,draftId])).rows[0]
  if(!saved)throw forbidden()
  const result=readDraft(saved)
  if((result.baseVersion>0||result.status==='applied')&&!actor.scopeIds.includes(result.scope))throw forbidden()
  return result
 }

 async revise(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessConfigurationDraft>{
  actorValid(actor);const row=reviseInput(input),{requestId,draftId}=row
  return this.transaction(async db=>{
   const prior=await this.reviseReceiptInTransaction(db,actor,row)
   if(prior)return prior
   const initial=(await db.query('select scope_id,candidate from teloa_business_configuration_drafts where owner_id=$1 and id=$2',[actor.ownerId,draftId])).rows[0]
   if(!initial)throw forbidden()
   const format=readBusinessConfigurationCandidateVersioned(initial.candidate).format
   const patch=readBusinessConfigurationPatchVersioned(row.patch,format),specHash=businessConfigurationHash({kind:'revise',draftId,expectedRevision:row.expectedRevision,patch})
   await lockBusinessConfiguration(db,actor.ownerId,initial.scope_id)
   const saved=(await db.query('select * from teloa_business_configuration_drafts where owner_id=$1 and id=$2 for update',[actor.ownerId,draftId])).rows[0]
   const draft=readDraft(saved)
   if(draft.scope!==initial.scope_id)throw corrupt()
   if(draft.candidate.format!==format)throw corrupt()
   if(draft.baseVersion>0){
    if(!actor.scopeIds.includes(draft.scope))throw forbidden()
    if(!await new BusinessConfigurationStore(this.pool).currentInTransaction(db,actor.ownerId,draft.scope))throw forbidden()
   }
   if(draft.status!=='draft'||draft.revision!==row.expectedRevision)throw new WorkError('teloa/version-conflict','业务配置草案已变化，请重新读取。')
   const candidate=merge(draft.candidate,patch),hash=businessConfigurationHash(candidate)
   const updated=(await db.query('update teloa_business_configuration_drafts set candidate=$3,hash=$4,revision=revision+1,updated_at=$5 where owner_id=$1 and id=$2 returning *',[actor.ownerId,draft.id,JSON.stringify(candidate),hash,this.identity.now()])).rows[0]
   return this.receipt(db,actor.ownerId,requestId,'revise',specHash,readDraft(updated))
  })
 }

 private async reviseReceiptInTransaction(db:PoolClient,actor:BusinessConfigurationActor,row:ReturnType<typeof reviseInput>):Promise<BusinessConfigurationDraft|undefined>{
  // 成功回执冻结修订当时的格式；未命中不解析 patch，更不猜测新请求的版本。
  const prior=await this.request(db,actor.ownerId,row.requestId,'revise',result=>businessConfigurationHash({kind:'revise',draftId:row.draftId,expectedRevision:row.expectedRevision,patch:readBusinessConfigurationPatchVersioned(row.patch,result.candidate.format)}))
  if(!prior)return undefined
  const current=await this.draftInTransaction(db,actor,row.draftId)
  if(prior.id!==row.draftId||prior.revision!==row.expectedRevision+1||prior.status!=='draft'||prior.scope!==current.scope||prior.baseVersion!==current.baseVersion||prior.revision>current.revision)throw corrupt()
  return prior
 }
 /** 原生工具在当前草案解析前核验旧请求；数据库只读事务保证不生成草案或回执。 */
 async reviseReceipt(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessConfigurationDraft|undefined>{
  actorValid(actor);const row=reviseInput(input)
  return this.transaction(db=>this.reviseReceiptInTransaction(db,actor,row),true)
 }

 async upgradeFormat(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessConfigurationDraft>{
  actorValid(actor);const row=taskInput(input,['draftId','expectedRevision','requestId'])
  if(!uuid(row.draftId)||!uuid(row.requestId)||!Number.isSafeInteger(row.expectedRevision)||Number(row.expectedRevision)<1)throw invalid()
  const requestId=row.requestId.toLowerCase(),draftId=row.draftId.toLowerCase(),specHash=businessConfigurationHash({kind:'upgrade-format',draftId,expectedRevision:row.expectedRevision})
  return this.transaction(async db=>{
   const prior=await this.request(db,actor.ownerId,requestId,'upgrade-format',specHash)
   if(prior){
    const current=await this.draftInTransaction(db,actor,draftId)
    if(prior.id!==draftId||prior.scope!==current.scope||prior.candidate.format!==businessConfigurationFormatV2)throw corrupt()
    return prior
   }
   const initial=(await db.query('select scope_id from teloa_business_configuration_drafts where owner_id=$1 and id=$2',[actor.ownerId,draftId])).rows[0]
   if(!initial)throw forbidden()
   await lockBusinessConfiguration(db,actor.ownerId,initial.scope_id)
   const saved=(await db.query('select * from teloa_business_configuration_drafts where owner_id=$1 and id=$2 for update',[actor.ownerId,draftId])).rows[0]
   if(!saved)throw forbidden()
   const draft=readDraft(saved)
   if(draft.scope!==initial.scope_id)throw corrupt()
   if(draft.baseVersion>0||draft.status==='applied'){
    if(!actor.scopeIds.includes(draft.scope))throw forbidden()
    if(!await new BusinessConfigurationStore(this.pool).currentInTransaction(db,actor.ownerId,draft.scope))throw forbidden()
   }
   if(draft.status!=='draft'||draft.revision!==row.expectedRevision||draft.candidate.format!==businessConfigurationFormat)throw new WorkError('teloa/version-conflict','业务配置草案已变化或格式已升级，请重新读取。')
   const candidate=readBusinessConfigurationCandidateVersioned({...draft.candidate,format:businessConfigurationFormatV2,definitions:draft.candidate.definitions.map(item=>item.kind==='object-type'?{...item,definition:{...item.definition,format:businessObjectTypeFormatV2}}:item)}),hash=businessConfigurationHash(candidate)
   const updated=(await db.query("update teloa_business_configuration_drafts set candidate=$3,hash=$4,revision=revision+1,updated_at=$5 where owner_id=$1 and id=$2 and revision=$6 and status='draft' returning *",[actor.ownerId,draftId,JSON.stringify(candidate),hash,this.identity.now(),row.expectedRevision])).rows[0]
   if(!updated)throw new WorkError('teloa/version-conflict','业务配置草案已变化，请重新读取。')
   return this.receipt(db,actor.ownerId,requestId,'upgrade-format',specHash,readDraft(updated))
  })
 }
}
