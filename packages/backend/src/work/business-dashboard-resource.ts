import {createHash} from 'node:crypto'
import type {Pool} from 'pg'
import {WorkError,taskInput,isRecord,isBusinessScopeKey,businessConfigurationFormatV2,readBusinessConfigurationCandidateV2,readBusinessConfigurationManifestVersioned,readBusinessDashboardResource,type BusinessDashboardResourceDefinition} from '@teloa/contract'
import {type MarketContentStore,readMarketBusinessConfigurationResource} from '../market/content-store.ts'
import {type BusinessConfigurationActor,type BusinessConfigurationDraftService} from './business-configuration-drafts.ts'
import type {BusinessConfigurationService} from './business-configuration.ts'
import type {BusinessConfigurationPreviewService} from './business-configuration-preview.ts'
import type {BusinessConfigurationPageService} from './business-configuration-page.ts'
import {businessConfigurationHash} from './business-configuration-store.ts'
import {mapBusinessDashboardConfiguration} from './business-dashboard-resource-mapping.ts'
import {mergeBusinessDashboardResourceUpgrade} from './business-dashboard-resource-upgrade.ts'
import {compareSemver} from '@teloa/contract'
import {prepareBusinessConfigurationDefinition} from './business-definition-write.ts'

export async function initializeBusinessDashboardResources(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_business_dashboard_preparations(
 owner_id text not null,request_id uuid not null,spec_hash text not null,draft_id uuid,
 source jsonb not null,result jsonb not null,created_at timestamptz not null default now(),
 primary key(owner_id,request_id),foreign key(owner_id,draft_id) references teloa_business_configuration_drafts(owner_id,id));`)
}
type Ports={market:Pick<MarketContentStore,'get'>;configuration:Pick<BusinessConfigurationService,'current'|'apply'>;drafts:Pick<BusinessConfigurationDraftService,'begin'|'revise'|'get'>;preview:Pick<BusinessConfigurationPreviewService,'preview'>;pages:Pick<BusinessConfigurationPageService,'preview'>}
const invalid=()=>new WorkError('teloa/invalid-input','业务看板请求格式不正确。')
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const localId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
/** 同一外部请求派生两个稳定的内部请求，异常或冷重启后不再次创建草案。 */
const requestId=(value:string,phase:string)=>{
 const hex=createHash('sha256').update('teloa.dashboard:'+value+':'+phase).digest('hex')
 return hex.slice(0,8)+'-'+hex.slice(8,12)+'-5'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20,32)
}
function resourceBaseline(resource:BusinessDashboardResourceDefinition,target:ReturnType<typeof readBusinessConfigurationCandidateV2>,mapping:Readonly<Record<string,string>>,borrowedObjectIds:readonly string[]=[]){
 const {homePageId:_,...base}=target
 return mapBusinessDashboardConfiguration(resource,{...base,definitions:target.definitions.filter(item=>item.kind==='object-type'&&borrowedObjectIds.includes(item.definition.id)),pages:[]},mapping)
}

export class BusinessDashboardResourceService{
 readonly pool:Pool
 readonly ports:Ports
 constructor(pool:Pool,ports:Ports){this.pool=pool;this.ports=ports}

 private async assertPrepared(actor:BusinessConfigurationActor,draftId:unknown){
  if(!uuid(draftId))throw invalid()
  if(!(await this.pool.query('select 1 from teloa_business_dashboard_preparations where owner_id=$1 and draft_id=$2',[actor.ownerId,draftId])).rowCount)throw new WorkError('teloa/forbidden','此看板草案不属于当前本人。')
  await this.ports.drafts.get(actor,{draftId})
 }
 async preview(actor:BusinessConfigurationActor,input:unknown){
  const row=taskInput(input,['draftId','expectedRevision'])
  await this.assertPrepared(actor,row.draftId)
  return this.ports.preview.preview(actor,row)
 }
 async apply(actor:BusinessConfigurationActor,input:unknown,signal?:AbortSignal){
  const row=taskInput(input,['requestId','draftId','expectedRevision','expectedBaseVersion','previewReceipt'])
  await this.assertPrepared(actor,row.draftId)
  return this.ports.configuration.apply(actor,row,signal)
 }
 async page(actor:BusinessConfigurationActor,input:unknown,signal?:AbortSignal){
  const row=taskInput(input,['draftId','expectedRevision','pageId','timeRange'])
  await this.assertPrepared(actor,row.draftId)
  return this.ports.pages.preview(actor,row,signal)
 }
 async adoption(actor:BusinessConfigurationActor,input:unknown){
  const row=taskInput(input,['draftId']);await this.assertPrepared(actor,row.draftId)
  const draft=await this.ports.drafts.get(actor,row)
  if(draft.status!=='applied')return null
  const version=draft.baseVersion+1
  const saved=(await this.pool.query('select manifest,hash from teloa_business_configuration_versions where owner_id=$1 and scope_id=$2 and version=$3',[actor.ownerId,draft.scope,version])).rows[0]
  try{
   const manifest=readBusinessConfigurationManifestVersioned(saved?.manifest)
   if(saved.hash!==businessConfigurationHash(manifest)||manifest.scope!==draft.scope||manifest.definitions.length!==draft.candidate.definitions.length)throw invalid()
   const {definitions:_,...fixed}=manifest,{definitions:__,...expected}=draft.candidate
   if(businessConfigurationHash(fixed)!==businessConfigurationHash(expected))throw invalid()
   for(const item of draft.candidate.definitions){
    const hash=prepareBusinessConfigurationDefinition(draft.scope,item.kind,item.definition,draft.candidate.format).definitionHash
    if(!manifest.definitions.some(ref=>ref.kind===item.kind&&ref.localId===item.definition.id&&ref.definitionHash===hash))throw invalid()
   }
  }catch{throw new WorkError('teloa/storage-corrupt','看板采用结果与历史配置不一致，已停止核对。')}
  return {draftId:draft.id,scope:draft.scope,version,configurationHash:saved.hash as string}
 }

 async exportCurrent(actor:BusinessConfigurationActor,input:unknown):Promise<{resource:BusinessDashboardResourceDefinition;excluded:string[];configurationHash:string}>{
  const row=taskInput(input,['scope','id','version'])
  if(!isBusinessScopeKey(row.scope)||row.scope==='general'||!localId(row.id)||typeof row.version!=='string')throw invalid()
  const current=await this.ports.configuration.current(actor,{scope:row.scope})
  if(!current)throw new WorkError('teloa/not-found','此业务还没有可分享的页面和看板，请先完成业务配置。')
  const excluded:string[]=[]
  const definitions=current.leaves.flatMap(leaf=>{
   if(leaf.kind==='source-mapping'){excluded.push('数据同步「'+leaf.localId+'」需要接收方重新连接，未随包分享。');return []}
   const definition=JSON.parse(leaf.body)
   const {defaultAction,...portable}=definition
   if(defaultAction!==undefined)excluded.push('对象「'+leaf.localId+'」的任务动作需要接收方重新配置，未随包分享。')
   return [{kind:leaf.kind,definition:{...portable,format:leaf.kind==='object-type'?'teloa.business-object-type/v2':portable.format,domain:'template',...(leaf.kind==='object-type'?{sourceId:'records'}:{})}}]
  })
  const configuration=readBusinessConfigurationCandidateV2({...current.manifest,format:businessConfigurationFormatV2,scope:'template',sources:[{sourceId:'records',kind:'local-records'}],definitions})
  return {resource:readBusinessDashboardResource({format:'teloa.business-dashboard-resource/v1',id:row.id,version:row.version,configuration}),excluded,configurationHash:current.hash}
 }

 async prepare(actor:BusinessConfigurationActor,input:unknown){
  const row=taskInput(input,['requestId','contentId','contentHash','resourceId','target','objectMapping'])
  if(!uuid(row.requestId)||!uuid(row.contentId)||typeof row.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(row.contentHash)||!localId(row.resourceId)||!isRecord(row.target))throw invalid()
  const target=taskInput(row.target,['kind','title','scope','expectedVersion'])
  if(target.kind==='new'?typeof target.title!=='string'||target.scope!==undefined||target.expectedVersion!==undefined:target.kind!=='existing'||target.title!==undefined||!isBusinessScopeKey(target.scope)||target.scope==='general'||!Number.isSafeInteger(target.expectedVersion)||Number(target.expectedVersion)<1)throw invalid()
  const mapping=row.objectMapping??{}
  if(!isRecord(mapping)||Object.keys(mapping).length>256||Object.entries(mapping).some(([id,value])=>!localId(id)||!localId(value)))throw invalid()
  const externalRequest=row.requestId.toLowerCase()
  const specHash=businessConfigurationHash({...row,requestId:externalRequest,contentId:row.contentId.toLowerCase()})
  const prior=(await this.pool.query('select spec_hash,draft_id,source from teloa_business_dashboard_preparations where owner_id=$1 and request_id=$2',[actor.ownerId,externalRequest])).rows[0]
  if(prior){
   if(prior.spec_hash!==specHash)throw new WorkError('teloa/conflict','此请求已用于不同的看板，请重新发起。')
   if(prior.draft_id)return this.ports.drafts.get(actor,{draftId:prior.draft_id})
  }
  const content=await this.ports.market.get({ownerId:actor.ownerId,kind:'human'},{contentId:row.contentId})
  if(content.hash!==row.contentHash)throw new WorkError('teloa/source-unavailable','看板内容已经变化，请重新打开资源详情。')
  const reference=content.references.find(ref=>ref.resourceId===row.resourceId)
  const fixed=reference?await this.ports.market.get({ownerId:actor.ownerId,kind:'human'},{contentId:reference.sourceContentId}):content
  if(reference&&fixed.hash!==reference.sourceHash)throw new WorkError('teloa/source-unavailable','方案引用的看板内容已变化，请重新核对来源。')
  const resource=readMarketBusinessConfigurationResource(fixed,reference?.sourceResourceId??row.resourceId)
  const current=target.kind==='existing'&&!prior?await this.ports.configuration.current(actor,{scope:target.scope}):undefined
  if(target.kind==='existing'&&!prior&&current?.version!==target.expectedVersion)throw new WorkError('teloa/version-conflict','目标业务已变化，请重新选择并预览。')
  const title=prior?prior.source.intendedTitle:target.kind==='new'?target.title:current!.manifest.title
  // 先固定准备意图；begin/revise 成功但失回包后，即使业务版本推进，也能接回原草案。
  await this.pool.query('insert into teloa_business_dashboard_preparations(owner_id,request_id,spec_hash,source,result) values($1,$2,$3,$4,$5) on conflict(owner_id,request_id) do nothing',[actor.ownerId,externalRequest,specHash,JSON.stringify({intendedTitle:title}),JSON.stringify({})])
  const intent=(await this.pool.query('select spec_hash,draft_id,source from teloa_business_dashboard_preparations where owner_id=$1 and request_id=$2',[actor.ownerId,externalRequest])).rows[0]
  if(!intent||intent.spec_hash!==specHash)throw new WorkError('teloa/conflict','看板准备意图已变化，请重新发起。')
  if(intent.draft_id)return this.ports.drafts.get(actor,{draftId:intent.draft_id})
  const draft=await this.ports.drafts.begin(actor,{requestId:requestId(externalRequest,'begin'),title:intent.source.intendedTitle,format:businessConfigurationFormatV2,...(target.kind==='existing'?{scope:target.scope}:{})})
  if(target.kind==='existing'&&draft.baseVersion!==target.expectedVersion)throw new WorkError('teloa/version-conflict','目标业务已变化，请重新选择并预览。')
  // begin 的固定回包是该请求的最初基线，重试 revise 用同一身份核对成功回执。
  const candidate=mapBusinessDashboardConfiguration(resource,readBusinessConfigurationCandidateV2(draft.candidate),mapping as Record<string,string>)
  const result=await this.ports.drafts.revise(actor,{requestId:requestId(externalRequest,'revise'),draftId:draft.id,expectedRevision:1,patch:{title:candidate.title,upsertDefinitions:candidate.definitions,upsertPages:candidate.pages,homePageId:candidate.homePageId,pageOrder:candidate.pages.map(page=>page.id)}})
  // 来源基线只含该资源所属实体；现有业务其他页面不能被后续资源升级删除。
  const baseline=resourceBaseline(resource,readBusinessConfigurationCandidateV2(draft.candidate),mapping as Record<string,string>)
  const borrowedObjectIds=resource.configuration.definitions.filter(item=>item.kind==='object-type').map(item=>(mapping as Record<string,string>)[item.definition.id]??item.definition.id).filter(id=>draft.candidate.definitions.some(item=>item.kind==='object-type'&&item.definition.id===id))
  const source={contentId:content.id,contentHash:content.hash,resourceId:row.resourceId,resource,objectMapping:mapping,target,baseline,baselineHash:businessConfigurationHash(baseline),borrowedObjectIds}
  await this.pool.query('update teloa_business_dashboard_preparations set draft_id=$4,source=$5,result=$6 where owner_id=$1 and request_id=$2 and spec_hash=$3 and (draft_id is null or draft_id=$4)',[actor.ownerId,externalRequest,specHash,result.id,JSON.stringify(source),JSON.stringify(result)])
  const saved=(await this.pool.query('select spec_hash,draft_id from teloa_business_dashboard_preparations where owner_id=$1 and request_id=$2',[actor.ownerId,externalRequest])).rows[0]
  if(!saved||saved.spec_hash!==specHash||saved.draft_id!==result.id)throw new WorkError('teloa/conflict','看板准备请求已变化，请重新核对。')
  return result
 }

 async prepareUpgrade(actor:BusinessConfigurationActor,input:unknown){
  const row=taskInput(input,['requestId','adoptionId','candidateContentId','candidateContentHash','resourceId','expectedConfigurationVersion','choices'])
  if(!uuid(row.requestId)||!uuid(row.adoptionId)||!uuid(row.candidateContentId)||typeof row.candidateContentHash!=='string'||!/^[a-f0-9]{64}$/.test(row.candidateContentHash)||!localId(row.resourceId)||!Number.isSafeInteger(row.expectedConfigurationVersion)||Number(row.expectedConfigurationVersion)<1)throw invalid()
  const externalRequest=row.requestId.toLowerCase(),specHash=businessConfigurationHash({...row,requestId:externalRequest,adoptionId:row.adoptionId.toLowerCase(),candidateContentId:row.candidateContentId.toLowerCase()})
  const prior=(await this.pool.query('select spec_hash,draft_id,result from teloa_business_dashboard_preparations where owner_id=$1 and request_id=$2',[actor.ownerId,externalRequest])).rows[0]
  if(prior){
   if(prior.spec_hash!==specHash)throw new WorkError('teloa/conflict','此请求已用于不同的看板升级，请重新发起。')
   if(prior.draft_id)return {draft:await this.ports.drafts.get(actor,{draftId:prior.draft_id}),conflicts:[],changed:prior.result.changed??[]}
   const latest=(await this.pool.query('select source,draft_id,result from teloa_business_dashboard_preparations where owner_id=$1 and request_id=$2',[actor.ownerId,externalRequest])).rows[0]
   if(latest?.draft_id)return {draft:await this.ports.drafts.get(actor,{draftId:latest.draft_id}),conflicts:[],changed:latest.result.changed??[]}
   const stored=latest?.source
   if(!isRecord(stored)||!isRecord(stored.pendingUpgrade)||stored.planHash!==businessConfigurationHash(stored.pendingUpgrade))throw new WorkError('teloa/storage-corrupt','固定升级意图不一致，已停止恢复。')
   await this.ports.drafts.get(actor,{draftId:row.adoptionId})
   return this.finishUpgrade(actor,externalRequest,specHash,stored.pendingUpgrade as unknown as UpgradePlan)
  }
  const adoption=await this.ports.drafts.get(actor,{draftId:row.adoptionId})
  if(adoption.status!=='applied')throw new WorkError('teloa/conflict','请先采用原看板，再选择升级版本。')
  const fixed=(await this.pool.query('select source from teloa_business_dashboard_preparations where owner_id=$1 and draft_id=$2',[actor.ownerId,adoption.id])).rows[0]?.source
  if(!isRecord(fixed)||!isRecord(fixed.objectMapping))throw new WorkError('teloa/source-unavailable','原看板的固定来源缺失，无法比较升级。')
  let baseline:ReturnType<typeof readBusinessConfigurationCandidateV2>,original:BusinessDashboardResourceDefinition
  try{
   baseline=readBusinessConfigurationCandidateV2(fixed.baseline)
   original=readBusinessDashboardResource(fixed.resource)
   if(baseline.scope!==adoption.scope||fixed.baselineHash!==businessConfigurationHash(baseline))throw invalid()
  }catch{throw new WorkError('teloa/storage-corrupt','原看板的固定来源与采用基线不一致。')}
  const content=await this.ports.market.get({ownerId:actor.ownerId,kind:'human'},{contentId:row.candidateContentId})
  if(content.hash!==row.candidateContentHash)throw new WorkError('teloa/source-unavailable','候选版本的内容已经变化，请重新选择。')
  const reference=content.references.find(ref=>ref.resourceId===row.resourceId)
  const source=reference?await this.ports.market.get({ownerId:actor.ownerId,kind:'human'},{contentId:reference.sourceContentId}):content
  if(reference&&source.hash!==reference.sourceHash)throw new WorkError('teloa/source-unavailable','候选看板的固定引用摘要不匹配。')
  const incoming=readMarketBusinessConfigurationResource(source,reference?.sourceResourceId??row.resourceId)
  if(incoming.id!==original.id||compareSemver(incoming.version,original.version)<=0)throw new WorkError('teloa/conflict','请选择同一看板的更新版本。')
  const current=await this.ports.configuration.current(actor,{scope:adoption.scope})
  if(!current||current.version!==row.expectedConfigurationVersion)throw new WorkError('teloa/version-conflict','业务配置已变化，请重新核对升级差异。')
  const candidate=readBusinessConfigurationCandidateV2({...current.manifest,definitions:current.leaves.map(leaf=>({kind:leaf.kind,definition:JSON.parse(leaf.body)}))})
  const priorBorrowed=Array.isArray(fixed.borrowedObjectIds)&&fixed.borrowedObjectIds.every(localId)?fixed.borrowedObjectIds:[]
  const incomingObjects=new Set(incoming.configuration.definitions.filter(item=>item.kind==='object-type').map(item=>item.definition.id))
  const incomingMapping=Object.fromEntries(Object.entries(fixed.objectMapping as Record<string,string>).filter(([id])=>incomingObjects.has(id)))
  // 基线为引用闭合会包含借用对象；只有扣除旧借用后剩下的对象才归来源所有。
  const ownedObjects=new Set(baseline.definitions.filter(item=>item.kind==='object-type'&&!priorBorrowed.includes(item.definition.id)).map(item=>item.definition.id))
  const currentObjects=new Set(candidate.definitions.filter(item=>item.kind==='object-type').map(item=>item.definition.id))
  const borrowedObjectIds=[...new Set([...priorBorrowed,...[...incomingObjects].map(id=>incomingMapping[id]??id).filter(id=>currentObjects.has(id)&&!ownedObjects.has(id))])]
  const incomingBaseline=resourceBaseline(incoming,candidate,incomingMapping,borrowedObjectIds)
  const merged=mergeBusinessDashboardResourceUpgrade({baseline,current:candidate,candidate:incomingBaseline,choices:row.choices as never})
  if(!merged.configuration)return {draft:null,conflicts:merged.conflicts,changed:merged.changed}
  const plan:UpgradePlan={configuration:merged.configuration,current:candidate,baseline:incomingBaseline,resource:incoming,mapping:incomingMapping,borrowedObjectIds,scope:adoption.scope,changed:merged.changed,contentId:content.id,contentHash:content.hash,resourceId:row.resourceId,adoptionId:adoption.id,baseVersion:current.version}
  await this.pool.query('insert into teloa_business_dashboard_preparations(owner_id,request_id,spec_hash,source,result) values($1,$2,$3,$4,$5) on conflict(owner_id,request_id) do nothing',[actor.ownerId,externalRequest,specHash,JSON.stringify({pendingUpgrade:plan,planHash:businessConfigurationHash(plan)}),JSON.stringify({})])
  const intent=(await this.pool.query('select spec_hash,draft_id,source,result from teloa_business_dashboard_preparations where owner_id=$1 and request_id=$2',[actor.ownerId,externalRequest])).rows[0]
  if(!intent||intent.spec_hash!==specHash)throw new WorkError('teloa/conflict','升级意图已变化，请重新发起。')
  if(intent.draft_id)return {draft:await this.ports.drafts.get(actor,{draftId:intent.draft_id}),conflicts:[],changed:intent.result.changed??[]}
  if(intent.source.planHash!==businessConfigurationHash(intent.source.pendingUpgrade))throw new WorkError('teloa/storage-corrupt','固定升级意图不一致。')
  return this.finishUpgrade(actor,externalRequest,specHash,intent.source.pendingUpgrade as UpgradePlan)
 }

 private async finishUpgrade(actor:BusinessConfigurationActor,externalRequest:string,specHash:string,plan:UpgradePlan){
  const config=readBusinessConfigurationCandidateV2(plan.configuration),candidate=readBusinessConfigurationCandidateV2(plan.current),baseline=readBusinessConfigurationCandidateV2(plan.baseline),resource=readBusinessDashboardResource(plan.resource)
  if(config.scope!==plan.scope||candidate.scope!==plan.scope||baseline.scope!==plan.scope)throw new WorkError('teloa/storage-corrupt','升级目标业务不一致。')
  const draft=await this.ports.drafts.begin(actor,{requestId:requestId(externalRequest,'upgrade-begin'),scope:plan.scope,title:candidate.title,format:businessConfigurationFormatV2})
  if(draft.baseVersion!==plan.baseVersion)throw new WorkError('teloa/version-conflict','业务配置已变化，请重新核对升级差异。')
  const key=(kind:string,id:string)=>kind+':'+id,next=new Set(config.definitions.map(item=>key(item.kind,item.definition.id)))
  const result=await this.ports.drafts.revise(actor,{requestId:requestId(externalRequest,'upgrade-revise'),draftId:draft.id,expectedRevision:1,patch:{
   upsertDefinitions:config.definitions,removeDefinitions:candidate.definitions.filter(item=>!next.has(key(item.kind,item.definition.id))).map(item=>({kind:item.kind,localId:item.definition.id})),
   upsertPages:config.pages,removePageIds:candidate.pages.filter(page=>!config.pages.some(item=>item.id===page.id)).map(page=>page.id),homePageId:config.homePageId,pageOrder:config.pages.map(page=>page.id),
  }})
  const provenance={contentId:plan.contentId,contentHash:plan.contentHash,resourceId:plan.resourceId,resource,objectMapping:plan.mapping,borrowedObjectIds:plan.borrowedObjectIds,adoptionId:plan.adoptionId,baseline,baselineHash:businessConfigurationHash(baseline)}
  await this.pool.query('update teloa_business_dashboard_preparations set draft_id=$4,source=$5,result=$6 where owner_id=$1 and request_id=$2 and spec_hash=$3 and (draft_id is null or draft_id=$4)',[actor.ownerId,externalRequest,specHash,result.id,JSON.stringify(provenance),JSON.stringify({draftId:result.id,changed:plan.changed})])
  const saved=(await this.pool.query('select spec_hash,draft_id from teloa_business_dashboard_preparations where owner_id=$1 and request_id=$2',[actor.ownerId,externalRequest])).rows[0]
  if(!saved||saved.spec_hash!==specHash||saved.draft_id!==result.id)throw new WorkError('teloa/conflict','升级准备请求已变化，请重新核对。')
  return {draft:result,conflicts:[],changed:plan.changed}
 }
}
type UpgradePlan={configuration:ReturnType<typeof readBusinessConfigurationCandidateV2>;current:ReturnType<typeof readBusinessConfigurationCandidateV2>;baseline:ReturnType<typeof readBusinessConfigurationCandidateV2>;resource:BusinessDashboardResourceDefinition;mapping:Record<string,string>;borrowedObjectIds:string[];scope:string;changed:string[];contentId:string;contentHash:string;resourceId:string;adoptionId:string;baseVersion:number}
