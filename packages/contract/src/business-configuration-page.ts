import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {taskInput} from './tasks.ts'
import {isBusinessScopeKey} from './business-scopes.ts'
import {readBusinessConfigurationCandidate,readBusinessConfigurationManifest,readBusinessConfigurationPage,type BusinessConfigurationCandidate,type BusinessConfigurationManifest,type BusinessConfigurationPage} from './business-configuration.ts'
import {readBusinessObjectTypeDefinition,readBusinessViewDefinition,type BusinessObjectTypeDefinition,type BusinessViewDefinition,type BusinessDefinitionDiffRow} from './business-definitions.ts'
import {readBusinessDashboardDefinition,readBusinessWidgetDefinition,readBusinessWidgetResult,businessTimeRanges,type BusinessDashboardDefinition,type BusinessWidgetDefinition,type BusinessWidgetResult,type BusinessTimeRange} from './business-dashboards.ts'
import {readBusinessConversationSession} from './business-conversations.ts'
import {readBusinessObjectTypeDefinitionV2,readBusinessObjectTypeDefinitionVersioned,type BusinessObjectTypeDefinitionV2} from './business-definitions-v2.ts'
import {readBusinessConfigurationCandidateVersioned,readBusinessConfigurationManifestVersioned,type BusinessConfigurationCandidateV2,type BusinessConfigurationManifestV2} from './business-configuration-v2.ts'
import {assertBusinessViewV2References,readBusinessViewDefinitionVersioned,readBusinessViewWidgetResultV2,type BusinessViewDefinitionVersioned,type BusinessViewWidgetResultV2} from './business-views-v2.ts'
import {industryUpdateCanonical} from './industry-update-compare.ts'

/** view-ref 的表示元数据直接使用现有视图/对象定义，避免第二套图表契约。 */
export type BusinessConfigurationViewRef={view:BusinessViewDefinition;objectType:BusinessObjectTypeDefinition}
export type BusinessConfigurationViewRefVersioned={view:BusinessViewDefinitionVersioned;objectType:BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2}
/** records.emptyState 仅定义列表为空时的展示类型；真实数量由 records/list 返回。 */
export type BusinessConfigurationPageContent=
 |{kind:'records';definition:Extract<BusinessConfigurationPage,{kind:'records'}>;objectType:BusinessObjectTypeDefinition;emptyState:'no-records'}
 |{kind:'dashboard';definition:Extract<BusinessConfigurationPage,{kind:'dashboard'}>;dashboard:BusinessDashboardDefinition;widgets:BusinessWidgetDefinition[];results:BusinessWidgetResult[];viewRefs:BusinessConfigurationViewRef[];timeRange:BusinessTimeRange}
export type BusinessConfigurationPageProjection={scope:string;configurationHash:string;page:BusinessConfigurationPageContent}&(
 {mode:'preview';draftId:string;revision:number}|{mode:'saved';configurationVersion:number})
/** 富字段记录页显式升级；旧投影不接受额外 format，也不把金额降为文字。 */
export type BusinessConfigurationPageContentV2=
 |{kind:'records';definition:Extract<BusinessConfigurationPage,{kind:'records'}>;objectType:BusinessObjectTypeDefinitionV2;emptyState:'no-records'}
 |{kind:'dashboard';definition:Extract<BusinessConfigurationPage,{kind:'dashboard'}>;dashboard:BusinessDashboardDefinition;widgets:BusinessWidgetDefinition[];results:BusinessViewWidgetResultV2[];viewRefs:BusinessConfigurationViewRefVersioned[];timeRange:BusinessTimeRange}
export type BusinessConfigurationPageProjectionV2={format:'teloa.business-configuration-page/v2';scope:string;configurationHash:string;page:BusinessConfigurationPageContentV2}&(
 {mode:'preview';draftId:string;revision:number}|{mode:'saved';configurationVersion:number})
export type BusinessConfigurationPageProjectionVersioned=BusinessConfigurationPageProjection|BusinessConfigurationPageProjectionV2
export type BusinessConfigurationDraftResponse={ownerId:string;id:string;scope:string;revision:number;baseVersion:number;candidate:BusinessConfigurationCandidate;hash:string;status:'draft'|'applied';createdAt:string;updatedAt:string}
export type BusinessConfigurationCurrentResponse={scope:string;version:number;manifest:BusinessConfigurationManifest;hash:string;createdAt:string}
export type BusinessConfigurationDraftResponseVersioned=Omit<BusinessConfigurationDraftResponse,'candidate'>&{candidate:BusinessConfigurationCandidate|BusinessConfigurationCandidateV2}
export type BusinessConfigurationCurrentResponseVersioned=Omit<BusinessConfigurationCurrentResponse,'manifest'>&{manifest:BusinessConfigurationManifest|BusinessConfigurationManifestV2}
export type BusinessConfigurationApplyResult={scope:string;version:number;configurationHash:string;requestId:string}
export type BusinessConfigurationPreviewResponse={draftId:string;revision:number;candidateHash:string;baseVersion:number;dependencyHash:string;receipt:string;changes:{rows:BusinessDefinitionDiffRow[];truncated:boolean};issues:[]}
const bad=()=>new WorkError('teloa/invalid-host-response','业务配置回包格式或身份不一致。')
const invalid=()=>new WorkError('teloa/invalid-input','业务配置请求格式不正确。')
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(v)
const scope=(v:unknown):v is string=>isBusinessScopeKey(v)&&v!=='general'
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0
const natural=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v
function exact(v:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{
 if(!isRecord(v)||required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k)))throw bad()
 return v
}
function response<T>(read:()=>T):T{try{return read()}catch{throw bad()}}
const unique=(values:string[])=>new Set(values).size===values.length
export function readBusinessConfigurationPageProjection(value:unknown):BusinessConfigurationPageProjection{return response(()=>{
 if(!isRecord(value))throw bad()
 const row=exact(value,['mode','scope','configurationHash','page',...(value.mode==='preview'?['draftId','revision']:['configurationVersion'])])
 if(!scope(row.scope)||!hash(row.configurationHash))throw bad()
 if(row.mode==='preview'?(!uuid(row.draftId)||!positive(row.revision)):(row.mode!=='saved'||!positive(row.configurationVersion)))throw bad()
 if(!isRecord(row.page))throw bad()
 const p=row.page
 const definition=readBusinessConfigurationPage(p.definition)
 if(p.kind==='records'){
  exact(p,['kind','definition','objectType','emptyState'])
  const objectType=readBusinessObjectTypeDefinition(p.objectType)
  if(definition.kind!=='records'||objectType.domain!==row.scope||objectType.id!==definition.objectType||definition.fields.some(name=>!objectType.fields.some(f=>f.name===name))||p.emptyState!=='no-records')throw bad()
 }else if(p.kind==='dashboard'){
  exact(p,['kind','definition','dashboard','widgets','results','viewRefs','timeRange'])
  const dashboard=readBusinessDashboardDefinition(p.dashboard)
  if(definition.kind!=='dashboard'||dashboard.id!==definition.dashboardId||dashboard.domain!==row.scope||!Array.isArray(p.widgets)||!Array.isArray(p.results)||!Array.isArray(p.viewRefs)||!businessTimeRanges.includes(p.timeRange as BusinessTimeRange))throw bad()
  if(dashboard.filters?!dashboard.filters.timeRange.options.includes(p.timeRange as BusinessTimeRange):p.timeRange!=='all')throw bad()
  const widgets=p.widgets.map(readBusinessWidgetDefinition),results=p.results.map(readBusinessWidgetResult)
  if(widgets.length!==dashboard.widgets.length||widgets.some((w,i)=>w.id!==dashboard.widgets[i]||w.domain!==row.scope)||results.length!==widgets.length||results.some((r,i)=>r.widgetId!==widgets[i]!.id||r.rowCount>50||r.stale))throw bad()
  const refs=p.viewRefs.map(v=>{const r=exact(v,['view','objectType']);return {view:readBusinessViewDefinition(r.view),objectType:readBusinessObjectTypeDefinition(r.objectType)}})
  const needed=[...new Set(widgets.flatMap(w=>w.viewRef?[w.viewRef]:[]))]
  if(!unique(refs.map(r=>r.view.id))||refs.length!==needed.length||refs.some(r=>!needed.includes(r.view.id)||r.view.domain!==row.scope||r.objectType.domain!==row.scope||r.view.objectType!==r.objectType.id))throw bad()
 }else throw bad()
 return row as BusinessConfigurationPageProjection
})}
export function readBusinessConfigurationPageProjectionVersioned(value:unknown):BusinessConfigurationPageProjectionVersioned{
 if(!isRecord(value)||!Object.hasOwn(value,'format'))return readBusinessConfigurationPageProjection(value)
 return response(()=>{
  const row=exact(value,['format','mode','scope','configurationHash','page',...(value.mode==='preview'?['draftId','revision']:['configurationVersion'])])
  if(row.format!=='teloa.business-configuration-page/v2'||!scope(row.scope)||!hash(row.configurationHash))throw bad()
  if(row.mode==='preview'?(!uuid(row.draftId)||!positive(row.revision)):(row.mode!=='saved'||!positive(row.configurationVersion)))throw bad()
  if(!isRecord(row.page))throw bad()
  const p=row.page,definition=readBusinessConfigurationPage(p.definition)
  if(p.kind==='records'){
   exact(p,['kind','definition','objectType','emptyState'])
   const objectType=readBusinessObjectTypeDefinitionV2(p.objectType)
   if(p.emptyState!=='no-records'||definition.kind!=='records'||objectType.domain!==row.scope||objectType.id!==definition.objectType||definition.fields.some(name=>!objectType.fields.some(field=>field.name===name)))throw bad()
   return {...row,page:{...p,definition,objectType}} as BusinessConfigurationPageProjectionV2
  }
  if(p.kind!=='dashboard')throw bad()
  exact(p,['kind','definition','dashboard','widgets','results','viewRefs','timeRange'])
  const dashboard=readBusinessDashboardDefinition(p.dashboard)
  if(definition.kind!=='dashboard'||dashboard.id!==definition.dashboardId||dashboard.domain!==row.scope||!Array.isArray(p.widgets)||!Array.isArray(p.results)||!Array.isArray(p.viewRefs)||!businessTimeRanges.includes(p.timeRange as BusinessTimeRange))throw bad()
  if(dashboard.filters?!dashboard.filters.timeRange.options.includes(p.timeRange as BusinessTimeRange):p.timeRange!=='all')throw bad()
  const widgets=p.widgets.map(readBusinessWidgetDefinition),results=p.results.map(readBusinessViewWidgetResultV2)
  if(widgets.length!==dashboard.widgets.length||widgets.some((widget,index)=>widget.id!==dashboard.widgets[index]||widget.domain!==row.scope||widget.kind!=='view-ref')||results.length!==widgets.length||results.some((result,index)=>result.widgetId!==widgets[index]!.id))throw bad()
  const refs=p.viewRefs.map(value=>{
   const r=exact(value,['view','objectType']),view=readBusinessViewDefinitionVersioned(r.view),objectType=readBusinessObjectTypeDefinitionVersioned(r.objectType)
   if(view.domain!==row.scope||objectType.domain!==row.scope)throw bad()
   assertBusinessViewV2References(view,objectType)
   return {view,objectType}
  })
  const needed=[...new Set(widgets.map(widget=>widget.viewRef!))]
  if(!unique(refs.map(ref=>ref.view.id))||refs.length!==needed.length||refs.some(ref=>!needed.includes(ref.view.id)))throw bad()
  for(const [index,result] of results.entries()){
   const ref=refs.find(ref=>ref.view.id===widgets[index]!.viewRef),view=result.view
   if(!ref||view.viewId!==ref.view.id||view.viewVersion!==ref.view.version||view.scope!==row.scope||view.objectType!==ref.objectType.id||view.kind!==ref.view.kind||view.chart!==ref.view.chart||view.title!==ref.view.title||industryUpdateCanonical(view.localized??null)!==industryUpdateCanonical(ref.view.localized??null)||view.dimensionField!==ref.view.dimension?.field||view.measures.length!==ref.view.measures.length)throw bad()
   const dimension=ref.objectType.fields.find(field=>field.name===ref.view.dimension?.field)
   if(view.dimensionMode!==(dimension?.type==='multi-enum'?'membership':'records'))throw bad()
   const usedFields=new Set([
    ...(ref.view.dimension?[ref.view.dimension.field]:[]),...(ref.view.window?[ref.view.window.field]:[]),
    ...ref.view.filters.map(filter=>filter.field),...ref.view.measures.flatMap(measure=>[...(measure.field?[measure.field]:[]),...(measure.where?[measure.where.field]:[])]),
   ])
   if(view.missingFields.some(field=>!usedFields.has(field)))throw bad()
   for(const [measureIndex,actual] of view.measures.entries()){
    const expected=ref.view.measures[measureIndex]!,field=ref.objectType.fields.find(field=>field.name===expected.field)
    if(actual.id!==expected.id||actual.label!==expected.label||actual.aggregation!==expected.aggregation||actual.fieldType!==field?.type||actual.currency!==('currency' in expected?expected.currency:undefined)||industryUpdateCanonical(actual.localized??null)!==industryUpdateCanonical(expected.localized??null))throw bad()
   }
  }
  return {...row,page:{...p,definition,dashboard,widgets,results,viewRefs:refs}} as BusinessConfigurationPageProjectionV2
 })
}
function draftResponse<T extends BusinessConfigurationCandidate|BusinessConfigurationCandidateV2>(value:unknown,read:(value:unknown)=>T):Omit<BusinessConfigurationDraftResponse,'candidate'>&{candidate:T}{return response(()=>{
 const r=exact(value,['ownerId','id','scope','revision','baseVersion','candidate','hash','status','createdAt','updatedAt'])
 const candidate=read(r.candidate)
 if(typeof r.ownerId!=='string'||!r.ownerId.trim()||r.ownerId.length>128||!uuid(r.id)||r.scope!==candidate.scope||!positive(r.revision)||!natural(r.baseVersion)||!hash(r.hash)||!['draft','applied'].includes(String(r.status))||!stamp(r.createdAt)||!stamp(r.updatedAt)||r.updatedAt<r.createdAt)throw bad()
 return {...r,candidate} as Omit<BusinessConfigurationDraftResponse,'candidate'>&{candidate:T}
})}
export function readBusinessConfigurationDraftResponse(value:unknown):BusinessConfigurationDraftResponse{return draftResponse(value,readBusinessConfigurationCandidate)}
export function readBusinessConfigurationDraftResponseVersioned(value:unknown):BusinessConfigurationDraftResponseVersioned{return draftResponse(value,readBusinessConfigurationCandidateVersioned)}
function currentResponse<T extends BusinessConfigurationManifest|BusinessConfigurationManifestV2>(value:unknown,read:(value:unknown)=>T):Omit<BusinessConfigurationCurrentResponse,'manifest'>&{manifest:T}{return response(()=>{
 const r=exact(value,['scope','version','manifest','hash','createdAt']),manifest=read(r.manifest)
 if(r.scope!==manifest.scope||!positive(r.version)||!hash(r.hash)||!stamp(r.createdAt))throw bad()
 return {...r,manifest} as Omit<BusinessConfigurationCurrentResponse,'manifest'>&{manifest:T}
})}
export function readBusinessConfigurationCurrentResponse(value:unknown):BusinessConfigurationCurrentResponse{return currentResponse(value,readBusinessConfigurationManifest)}
export function readBusinessConfigurationCurrentResponseVersioned(value:unknown):BusinessConfigurationCurrentResponseVersioned{return currentResponse(value,readBusinessConfigurationManifestVersioned)}
export function readBusinessConfigurationApplyResult(value:unknown):BusinessConfigurationApplyResult{
 const r=exact(value,['scope','version','configurationHash','requestId'])
 if(!scope(r.scope)||!positive(r.version)||!hash(r.configurationHash)||!uuid(r.requestId))throw bad()
 return r as BusinessConfigurationApplyResult
}
export function readBusinessConfigurationPreviewResponse(value:unknown):BusinessConfigurationPreviewResponse{
 const r=exact(value,['draftId','revision','candidateHash','baseVersion','dependencyHash','receipt','changes','issues'])
 if(!uuid(r.draftId)||!positive(r.revision)||!natural(r.baseVersion)||!hash(r.candidateHash)||!hash(r.dependencyHash)||!hash(r.receipt)||!Array.isArray(r.issues)||r.issues.length)throw bad()
 const c=exact(r.changes,['rows','truncated'])
 if(!Array.isArray(c.rows)||c.rows.length>200||typeof c.truncated!=='boolean'||c.truncated&&c.rows.length!==200)throw bad()
 for(const value of c.rows){const row=exact(value,['path','before','after']);if(typeof row.path!=='string'||!row.path||row.path.length>512||!/^[$a-zA-Z0-9_.\[\]-]+$/.test(row.path)||[row.before,row.after].some(v=>v!==null&&(typeof v!=='string'||v.length>2_097_152))||row.before===row.after)throw bad()}
 if(!unique(c.rows.map(v=>(v as {path:string}).path)))throw bad()
 return r as BusinessConfigurationPreviewResponse
}
export type BusinessConfigurationPageRequest={scope:string;pageId:string;timeRange?:BusinessTimeRange}|{sessionId:string;draftId:string;expectedRevision:number;pageId:string;timeRange?:BusinessTimeRange}
export function readBusinessBuilderRequest(endpoint:string,input:unknown):Record<string,unknown>{
 const keys:Record<string,string[]>={
  'business-configuration/draft':['sessionId','draftId'],
  'business-configuration/preview':['sessionId','draftId','expectedRevision'],
  'business-configuration/apply':['sessionId','requestId','draftId','expectedRevision','expectedBaseVersion','previewReceipt'],
  'business-configuration/receipt':['requestId'],
  'business-configuration/current':['scope'],
  'business-configuration/page':isRecord(input)&&Object.hasOwn(input,'scope')?['scope','pageId','timeRange']:['sessionId','draftId','expectedRevision','pageId','timeRange'],
 }
 const allowed=keys[endpoint]
 if(!allowed)throw new WorkError('teloa/not-found','未提供此业务配置接口。')
 const r=taskInput(input,allowed)
 for(const key of allowed){
  if(key==='timeRange'){if(r[key]!==undefined&&!businessTimeRanges.includes(r[key] as BusinessTimeRange))throw invalid();continue}
  const v=r[key]
  if(key==='sessionId'){readBusinessConversationSession({sessionId:v});continue}
  if(key==='draftId'||key==='requestId'){if(!uuid(v))throw invalid()}
  else if(key==='expectedRevision'){if(!positive(v))throw invalid()}
  else if(key==='expectedBaseVersion'){if(!natural(v))throw invalid()}
  else if(key==='scope'){if(!scope(v))throw invalid()}
  else if(key==='pageId'){if(!id(v))throw invalid()}
  else if(key==='previewReceipt'){if(!hash(v))throw invalid()}
 }
 return r
}
