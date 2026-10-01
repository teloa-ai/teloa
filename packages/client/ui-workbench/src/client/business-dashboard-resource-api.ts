import type {DashboardMarketJournal} from './business-dashboard-market-journal.ts'
import {WorkError,readBusinessDashboardResource,readBusinessBuilderRequest,readBusinessConfigurationCurrentResponseVersioned,readBusinessConfigurationDraftResponseVersioned,readBusinessConfigurationPreviewResponse,readBusinessConfigurationApplyResult,readBusinessConfigurationPageProjectionVersioned,type BusinessDashboardResourceDefinition} from '@teloa/contract'
import {readIndustryDirectory} from './industry-directory.ts'
import type {BusinessBuilderApplyInput,BusinessBuilderPreviewInput} from './business-builder-api.ts'
type Call=(endpoint:string,input:unknown,signal?:AbortSignal)=>Promise<unknown>
export type DashboardPrepareInput={requestId:string;contentId:string;contentHash:string;resourceId:string;target:{kind:'new';title:string}|{kind:'existing';scope:string;expectedVersion:number};objectMapping?:Record<string,string>}
export type DashboardUpgradeChoice='keep-local'|'use-incoming'
export type DashboardUpgradeInput={requestId:string;adoptionId:string;candidateContentId:string;candidateContentHash:string;resourceId:string;expectedConfigurationVersion:number;choices?:Record<string,DashboardUpgradeChoice>}
export type DashboardUpgradeConflict={key:string;entity:'definition'|'page'|'home-page';id:string;kind?:string;baseline:unknown;current:unknown;incoming:unknown}
export type DashboardPreviewInput=Omit<BusinessBuilderPreviewInput,'sessionId'>
export type DashboardApplyInput=Omit<BusinessBuilderApplyInput,'sessionId'>
export type DashboardAdoptionIdentity={draftId:string;scope:string;version:number;configurationHash:string}
const invalid=()=>new WorkError('teloa/invalid-host-response','业务看板资源回包与请求不一致。')
export function readDashboardAdoptionIdentity(value:unknown):DashboardAdoptionIdentity{
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalid()
 const row=value as Record<string,unknown>
 if(Object.keys(row).length!==4||typeof row.draftId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.draftId)||typeof row.scope!=='string'||!row.scope||!Number.isSafeInteger(row.version)||Number(row.version)<1||typeof row.configurationHash!=='string'||!/^[a-f0-9]{64}$/.test(row.configurationHash))throw invalid()
 return row as DashboardAdoptionIdentity
}
/** 独立市场草案只经本人 preparation 端点访问；不把它伪装成会话草案。 */
export function createBusinessDashboardResourceApi(call:Call,journal?:DashboardMarketJournal){
 return {journal,
  async export(input:{scope:string;id:string;version:string},signal?:AbortSignal){
   const value=await call('business-dashboard-resources/export',input,signal)
   if(!value||typeof value!=='object'||Array.isArray(value))throw invalid()
   const row=value as Record<string,unknown>
   let resource:BusinessDashboardResourceDefinition;try{resource=readBusinessDashboardResource(row.resource)}catch{throw invalid()}
   if(Object.keys(row).length!==3||resource.id!==input.id||resource.version!==input.version||typeof row.configurationHash!=='string'||!/^[a-f0-9]{64}$/.test(row.configurationHash)||!Array.isArray(row.excluded)||row.excluded.some(item=>typeof item!=='string'))throw invalid()
   return {resource,excluded:row.excluded as string[],configurationHash:row.configurationHash}
  },
  async prepare(input:DashboardPrepareInput,signal?:AbortSignal){
   const result=readBusinessConfigurationDraftResponseVersioned(await call('business-dashboard-resources/prepare',input,signal))
   if(result.candidate.format!=='teloa.business-configuration/v2'||input.target.kind==='existing'&&(result.scope!==input.target.scope||result.baseVersion!==input.target.expectedVersion))throw invalid()
   return result
  },
  async prepareUpgrade(input:DashboardUpgradeInput,signal?:AbortSignal){
   const value=await call('business-dashboard-resources/prepare-upgrade',input,signal)
   if(!value||typeof value!=='object'||Array.isArray(value))throw invalid()
   const row=value as Record<string,unknown>
   if(Object.keys(row).length!==3||!Array.isArray(row.conflicts)||!Array.isArray(row.changed)||row.changed.some(value=>typeof value!=='string'))throw invalid()
   const conflicts=row.conflicts.map((value):DashboardUpgradeConflict=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw invalid()
    const r=value as Record<string,unknown>,keys=['key','entity','id','baseline','current','incoming']
    if(keys.some(key=>!Object.hasOwn(r,key))||Object.keys(r).some(key=>!keys.includes(key)&&key!=='kind')||typeof r.key!=='string'||!r.key||typeof r.id!=='string'||!['definition','page','home-page'].includes(String(r.entity))||r.kind!==undefined&&typeof r.kind!=='string')throw invalid()
    return structuredClone(r) as DashboardUpgradeConflict
   })
   if(new Set(conflicts.map(value=>value.key)).size!==conflicts.length)throw invalid()
   const draft=row.draft===null?null:readBusinessConfigurationDraftResponseVersioned(row.draft)
   if(draft?(draft.candidate.format!=='teloa.business-configuration/v2'||draft.baseVersion!==input.expectedConfigurationVersion||conflicts.length>0):!conflicts.length)throw invalid()
   return {draft,conflicts,changed:row.changed as string[]}
  },
  async preview(input:DashboardPreviewInput,signal?:AbortSignal){
   const result=readBusinessConfigurationPreviewResponse(await call('business-dashboard-resources/preview',input,signal))
   if(result.draftId!==input.draftId||result.revision!==input.expectedRevision)throw invalid();return result
  },
  async apply(input:DashboardApplyInput,signal?:AbortSignal){
   const result=readBusinessConfigurationApplyResult(await call('business-dashboard-resources/apply',input,signal))
   if(result.requestId!==input.requestId.toLowerCase()||result.version!==input.expectedBaseVersion+1)throw invalid();return result
  },
  async page(input:DashboardPreviewInput&{pageId:string},signal?:AbortSignal){
   const result=readBusinessConfigurationPageProjectionVersioned(await call('business-dashboard-resources/page',input,signal))
   if(result.mode!=='preview'||result.draftId!==input.draftId||result.revision!==input.expectedRevision||result.page.definition.id!==input.pageId)throw invalid();return result
  },
  async current(input:{scope:string},signal?:AbortSignal){
   const value=await call('business-configuration/current',input,signal);if(value===null)return null
   const result=readBusinessConfigurationCurrentResponseVersioned(value);if(result.scope!==input.scope)throw invalid();return result
  },
  async adoption(input:{draftId:string},signal?:AbortSignal){
   const value=await call('business-dashboard-resources/adoption',input,signal);if(value===null)return null
   const result=readDashboardAdoptionIdentity(value);if(result.draftId!==input.draftId)throw invalid();return result
  },
  async receipt(input:{requestId:string},signal?:AbortSignal){
   const r=readBusinessBuilderRequest('business-configuration/receipt',input),value=await call('business-configuration/receipt',r,signal)
   if(value===null)return null
   const result=readBusinessConfigurationApplyResult(value);if(result.requestId!==input.requestId.toLowerCase())throw invalid();return result
  },
 }
}
export type BusinessDashboardResourceApi=ReturnType<typeof createBusinessDashboardResourceApi>
/** 完整配置单独作为 v4 资源固定；归档与公共引用仍由现有市场内容服务负责。 */
export async function packageBusinessDashboardResource(input:BusinessDashboardResourceDefinition,metadata:{title:string;description:string;english?:{title:string;description:string}}){
 const resource=readBusinessDashboardResource(input),encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value,null,2)+'\n')
 const localized=(original:string,english:string)=>({original,defaultLocale:'en',locales:{'zh-CN':original,en:english}})
 const manifest={format:'teloa.business-package/v4',id:resource.id,title:metadata.title,version:resource.version,domain:resource.configuration.scope,scope:resource.configuration.scope,description:metadata.description,...(metadata.english?{localized:{title:localized(metadata.title,metadata.english.title),description:localized(metadata.description,metadata.english.description)}}:{}),resources:[{id:resource.id,kind:'business-configuration',title:metadata.title,...(metadata.english?{localized:{title:localized(metadata.title,metadata.english.title)}}:{}),version:resource.version,required:true,source:{kind:'local',path:'dashboard.json'}}],relations:[],entrypoints:[]}
 const files=[{path:'teloa.json',bytes:encode(manifest)},{path:'dashboard.json',bytes:encode(resource)}]
 return readIndustryDirectory(files.map(file=>({path:file.path,size:file.bytes.byteLength,read:async()=>file.bytes})),'teloa.json','本机业务看板 · '+resource.configuration.scope)
}
