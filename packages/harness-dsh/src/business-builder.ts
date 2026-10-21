import {
 WorkError,readBusinessConversationRecentDaily,readBusinessConversationRecentDailyResponse,readBusinessConversationReserve,readBusinessConversationBind,readBusinessConversationRequest,readBusinessConversationSession,readBusinessConversationList,readBusinessConversationBinding,readBusinessConversationDirectory,
 readBusinessBuilderRequest,readBusinessConfigurationDraftResponseVersioned as readBusinessConfigurationDraftResponse,readBusinessConfigurationCurrentResponseVersioned as readBusinessConfigurationCurrentResponse,readBusinessConfigurationApplyResult,readBusinessConfigurationPreviewResponse,readBusinessConfigurationPageProjectionVersioned as readBusinessConfigurationPageProjection,
 readBusinessRecordCreate,readBusinessRecordEdit,readBusinessRecordArchive,readBusinessRecordList,readBusinessRecordGet,readBusinessRecordReceipt,readBusinessRecordSnapshot,readBusinessRecordPage,
} from '@teloa/contract'
import type {BusinessConversationBindingService,BusinessConfigurationDraftService,BusinessConfigurationService,BusinessConfigurationPreviewService,BusinessConfigurationPageService,BusinessRecordService} from '@teloa/backend'
import {businessSetupPlanEndpoints,createBusinessSetupPlanHandler} from './business-setup-plan.ts'
import type {BusinessSetupPlanService} from '@teloa/backend'
export const businessBuilderEndpoints=[
 ...businessSetupPlanEndpoints,
 'business-conversations/reserve','business-conversations/bind','business-conversations/by-request','business-conversations/by-session','business-conversations/list','business-conversations/recent-daily',
 'business-configuration/draft','business-configuration/discard','business-configuration/preview','business-configuration/apply','business-configuration/receipt','business-configuration/current','business-configuration/page',
 'business-records/create','business-records/edit','business-records/archive','business-records/list','business-records/get','business-records/receipt',
] as const
export type BusinessBuilderServices={
 setup?:BusinessSetupPlanService
 bindings:Pick<BusinessConversationBindingService,'reserve'|'bind'|'byRequest'|'bySession'|'list'|'recentDaily'>
 drafts:Pick<BusinessConfigurationDraftService,'get'|'discard'>
 configuration:Pick<BusinessConfigurationService,'apply'|'receipt'|'current'>
 preview:Pick<BusinessConfigurationPreviewService,'preview'>
 pages:Pick<BusinessConfigurationPageService,'read'|'preview'>
 records:Pick<BusinessRecordService,'create'|'edit'|'archive'|'list'|'get'|'receipt'>
}
const invalid=()=>new WorkError('teloa/invalid-host-response','业务服务回包身份与请求不一致。')
const forbidden=()=>new WorkError('teloa/forbidden','此会话未绑定当前业务草案。')
/** 本人身份来自宿主；每次请求重新取真实范围，特别是采用失回包后的receipt。 */
/**
 * 页面标题仍是所引用定义原文时，取该定义的标题本地化元数据（与 manifest 同一次读取、同一版本与摘要），
 * 供导航按界面语言显示内置页名；不读取任何页面数据。
 */
function businessConfigurationPageTitles(value:{manifest:{pages:readonly ({id:string;title:string;kind:'records';objectType:string}|{id:string;title:string;kind:'dashboard';dashboardId:string}|{id:string;title:string;kind:string})[]};leaves?:readonly {kind:string;localId:string;body:string}[]}):Record<string,unknown>{
 const titles:Record<string,unknown>={}
 for(const page of value.manifest.pages){
  const target='objectType' in page&&page.kind==='records'?['object-type',page.objectType]:'dashboardId' in page&&page.kind==='dashboard'?['dashboard',page.dashboardId]:undefined
  const leaf=target&&value.leaves?.find(leaf=>leaf.kind===target[0]&&leaf.localId===target[1])
  if(!leaf)continue
  const body=JSON.parse(leaf.body) as {title?:unknown;localized?:{title?:unknown}}
  if(body.title===page.title&&body.localized?.title!==undefined)titles[page.id]=body.localized.title
 }
 return titles
}

export function createBusinessBuilderHandler(owner:string,scopeIds:()=>Promise<readonly string[]>,get:()=>Promise<BusinessBuilderServices>){
 return async(endpoint:string,payload:unknown,signal?:AbortSignal):Promise<unknown>=>{
  if((businessSetupPlanEndpoints as readonly string[]).includes(endpoint))return createBusinessSetupPlanHandler(owner,scopeIds,async()=>{const services=await get();if(!services.setup)throw new WorkError('teloa/dependency-unavailable','业务方案服务尚未连接，原草案已保留。');return {bindings:services.bindings,setup:services.setup}})(endpoint,payload)
  if(!(businessBuilderEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此业务搭建接口。')
  const readers:Record<string,(v:unknown)=>unknown>={
   'business-conversations/recent-daily':readBusinessConversationRecentDaily,'business-conversations/reserve':readBusinessConversationReserve,'business-conversations/bind':readBusinessConversationBind,
   'business-conversations/by-request':readBusinessConversationRequest,'business-conversations/by-session':readBusinessConversationSession,'business-conversations/list':readBusinessConversationList,
   'business-records/create':readBusinessRecordCreate,'business-records/edit':readBusinessRecordEdit,'business-records/archive':readBusinessRecordArchive,
   'business-records/list':readBusinessRecordList,'business-records/get':readBusinessRecordGet,'business-records/receipt':readBusinessRecordReceipt,
  }
  const request=(readers[endpoint]?readers[endpoint]!(payload):readBusinessBuilderRequest(endpoint,payload)) as Record<string,unknown>
  const actor={ownerId:owner,scopeIds:[...await scopeIds()].filter(scope=>scope!=='general')}
  signal?.throwIfAborted()
  const services=await get()
  if(endpoint.startsWith('business-conversations/')){
   const method=endpoint.slice('business-conversations/'.length)
   if(method==='recent-daily')return readBusinessConversationRecentDailyResponse(await services.bindings.recentDaily(actor,request,signal),request.scope as string)
   if(method==='list'){
    const page=await services.bindings.list(actor,request),items=[]
    for(const binding of page.items){
     const checked=readBusinessConversationBinding(binding)
     if(checked.draftId){
      const draft=readBusinessConfigurationDraftResponse(await services.drafts.get(actor,{draftId:checked.draftId}))
      if(draft.ownerId!==owner||draft.id!==checked.draftId)throw invalid()
      if(draft.status==='discarded')continue
      items.push({binding:checked,draft:{id:draft.id,title:draft.candidate.title,scope:draft.scope,revision:draft.revision,status:draft.status,updatedAt:draft.updatedAt}})
     }else items.push({binding:checked})
    }
    return readBusinessConversationDirectory({items,...(page.nextCursor===undefined?{}:{nextCursor:page.nextCursor})})
   }
   const result=method==='reserve'?await services.bindings.reserve(actor,request):method==='bind'?await services.bindings.bind(actor,request):method==='by-request'?await services.bindings.byRequest(actor,request):await services.bindings.bySession(actor,request)
   if(result===undefined){if(method==='by-request'||method==='by-session')return null;throw invalid()}
   const binding=readBusinessConversationBinding(result)
   if(request.requestId!==undefined&&binding.requestId!==request.requestId||request.sessionId!==undefined&&(method==='bind'||binding.sessionId!==undefined)&&binding.sessionId!==request.sessionId)throw invalid()
   return binding
  }
  if(endpoint.startsWith('business-records/')){
   const method=endpoint.slice('business-records/'.length) as keyof BusinessBuilderServices['records']
   const value=await services.records[method](actor,request)
   if(value===undefined){if(method==='receipt')return null;throw invalid()}
   if(method==='list'){
    const page=readBusinessRecordPage(value,request.scope as string)
    if(page.items.some(item=>item.type!==request.type))throw invalid()
    return page
   }
   const item=readBusinessRecordSnapshot(value,request.scope as string|undefined)
   if(request.type!==undefined&&item.type!==request.type||request.id!==undefined&&item.id!==request.id||request.version!==undefined&&item.version!==request.version)throw invalid()
   if(!actor.scopeIds.includes(item.scope))throw invalid()
   return item
  }
  if(request.sessionId!==undefined){
   const binding=await services.bindings.bySession(actor,{sessionId:request.sessionId})
   if(!binding)throw forbidden()
   const checked=readBusinessConversationBinding(binding)
   if(checked.kind!=='builder'||checked.sessionId!==request.sessionId||checked.draftId!==request.draftId)throw forbidden()
  }
  if(endpoint==='business-configuration/discard'&&request.requestId!==undefined){
   const binding=await services.bindings.byRequest(actor,{requestId:request.requestId})
   if(!binding)throw forbidden()
   const checked=readBusinessConversationBinding(binding)
   if(checked.kind!=='builder'||checked.requestId!==request.requestId||checked.draftId!==request.draftId||checked.sessionId!==undefined)throw forbidden()
  }
  const {sessionId:_,...rest}=request
  const {requestId:discardRequestId,...discardInput}=rest
  const input=endpoint==='business-configuration/discard'?discardInput:rest
  if(endpoint==='business-configuration/discard'){
   const discarded=readBusinessConfigurationDraftResponse(await services.drafts.discard(actor,input))
   if(discarded.ownerId!==owner||discarded.id!==input.draftId||discarded.status!=='discarded'||discarded.revision!==Number(input.expectedRevision)+1)throw invalid()
   return discarded
  }
  if(endpoint==='business-configuration/draft'){
   const draft=readBusinessConfigurationDraftResponse(await services.drafts.get(actor,input))
   if(draft.ownerId!==owner||draft.id!==input.draftId)throw invalid()
   return draft
  }
  if(endpoint==='business-configuration/preview'){
   const preview=readBusinessConfigurationPreviewResponse(await services.preview.preview(actor,input))
   if(preview.draftId!==input.draftId||preview.revision!==input.expectedRevision)throw invalid()
   return preview
  }
  if(endpoint==='business-configuration/page'){
   const projection=readBusinessConfigurationPageProjection(await(input.scope===undefined?services.pages.preview(actor,input,signal):services.pages.read(actor,input,signal)))
   if(projection.page.definition.id!==input.pageId||input.scope!==undefined&&(projection.mode!=='saved'||projection.scope!==input.scope)||input.draftId!==undefined&&(projection.mode!=='preview'||projection.draftId!==input.draftId||projection.revision!==input.expectedRevision))throw invalid()
   return projection
  }
  if(endpoint==='business-configuration/current'){
   const value=await services.configuration.current(actor,input)
   if(value===undefined)return null
   const pageTitles=businessConfigurationPageTitles(value)
   const result=readBusinessConfigurationCurrentResponse({scope:value.scope,version:value.version,manifest:value.manifest,hash:value.hash,createdAt:value.createdAt,...(Object.keys(pageTitles).length?{pageTitles}:{})})
   if(result.scope!==input.scope)throw invalid()
   return result
  }
  if(endpoint==='business-configuration/apply'&&services.setup&&await services.setup.read(actor,{draftId:input.draftId}))throw new WorkError('teloa/conflict','此草案已有关联的完整方案，请在方案复核中采用。')
  const value=endpoint==='business-configuration/apply'?await services.configuration.apply(actor,input,signal):await services.configuration.receipt(actor,input)
  if(value===undefined){if(endpoint==='business-configuration/receipt')return null;throw invalid()}
  const result=readBusinessConfigurationApplyResult(value)
  if(result.requestId!==String(input.requestId).toLowerCase())throw invalid()
  return result
 }
}
