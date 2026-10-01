import {
 WorkError,readBusinessConversationReserve,readBusinessConversationBind,readBusinessConversationRequest,readBusinessConversationSession,readBusinessConversationList,readBusinessConversationBinding,readBusinessConversationDirectory,readBusinessConversationRecentDaily,readBusinessConversationRecentDailyResponse,
 readBusinessBuilderRequest,readBusinessConfigurationDraftResponseVersioned as readBusinessConfigurationDraftResponse,readBusinessConfigurationPreviewResponse,readBusinessConfigurationApplyResult,readBusinessConfigurationCurrentResponseVersioned as readBusinessConfigurationCurrentResponse,readBusinessConfigurationPageProjectionVersioned as readBusinessConfigurationPageProjection,
 type BusinessConversationReserve,type BusinessConversationList,type BusinessConfigurationPageRequest,
} from '@teloa/contract'
type Call=(endpoint:string,input:unknown,signal?:AbortSignal)=>Promise<unknown>
export type BusinessBuilderDraftTarget={sessionId:string;draftId:string}
export type BusinessBuilderPreviewInput=BusinessBuilderDraftTarget&{expectedRevision:number}
export type BusinessBuilderApplyInput=BusinessBuilderPreviewInput&{requestId:string;expectedBaseVersion:number;previewReceipt:string}
const invalid=()=>new WorkError('teloa/invalid-host-response','业务搭建回包与请求不一致。')
export function createBusinessBuilderApi(call:Call){
 return {
  async recentDaily(input:{scope:string},signal?:AbortSignal){
   const r=readBusinessConversationRecentDaily(input)
   return readBusinessConversationRecentDailyResponse(await call('business-conversations/recent-daily',r,signal),r.scope)
  },
  async reserve(input:BusinessConversationReserve,signal?:AbortSignal){
   const r=readBusinessConversationReserve(input),result=readBusinessConversationBinding(await call('business-conversations/reserve',r,signal))
   if(['requestId','kind','title','workspaceId','scope'].some(k=>result[k as keyof typeof r]!==r[k as keyof typeof r]))throw invalid()
   return result
  },
  async bind(input:{requestId:string;sessionId:string},signal?:AbortSignal){
   const r=readBusinessConversationBind(input),result=readBusinessConversationBinding(await call('business-conversations/bind',r,signal))
   if(result.requestId!==r.requestId||result.sessionId!==r.sessionId)throw invalid()
   return result
  },
  async byRequest(input:{requestId:string},signal?:AbortSignal){
   const r=readBusinessConversationRequest(input),value=await call('business-conversations/by-request',r,signal)
   if(value===null)return null
   const result=readBusinessConversationBinding(value);if(result.requestId!==r.requestId)throw invalid();return result
  },
  async bySession(input:{sessionId:string},signal?:AbortSignal){
   const r=readBusinessConversationSession(input),value=await call('business-conversations/by-session',r,signal)
   if(value===null)return null
   const result=readBusinessConversationBinding(value)
   // 原生ready、bind尚未成功的预约仍可按原请求恢复，不能伪装成已绑定。
   if(result.sessionId!==undefined&&result.sessionId!==r.sessionId)throw invalid();return result
  },
  async list(input:Partial<BusinessConversationList>={},signal?:AbortSignal){
   const r=readBusinessConversationList(input),result=readBusinessConversationDirectory(await call('business-conversations/list',r,signal))
   if(result.items.length>r.limit||result.items.some(({binding:b})=>r.kind!==undefined&&b.kind!==r.kind||r.scope!==undefined&&b.scope!==r.scope))throw invalid()
   return result
  },
  async draft(input:BusinessBuilderDraftTarget,signal?:AbortSignal){
   const r=readBusinessBuilderRequest('business-configuration/draft',input),result=readBusinessConfigurationDraftResponse(await call('business-configuration/draft',r,signal))
   if(result.id!==r.draftId)throw invalid();return result
  },
  async preview(input:BusinessBuilderPreviewInput,signal?:AbortSignal){
   const r=readBusinessBuilderRequest('business-configuration/preview',input),result=readBusinessConfigurationPreviewResponse(await call('business-configuration/preview',r,signal))
   if(result.draftId!==r.draftId||result.revision!==r.expectedRevision)throw invalid();return result
  },
  async apply(input:BusinessBuilderApplyInput,signal?:AbortSignal){
   const r=readBusinessBuilderRequest('business-configuration/apply',input),result=readBusinessConfigurationApplyResult(await call('business-configuration/apply',r,signal))
   if(result.requestId!==String(r.requestId).toLowerCase()||result.version!==Number(r.expectedBaseVersion)+1)throw invalid();return result
  },
  async receipt(input:{requestId:string},signal?:AbortSignal){
   const r=readBusinessBuilderRequest('business-configuration/receipt',input),value=await call('business-configuration/receipt',r,signal)
   if(value===null)return null
   const result=readBusinessConfigurationApplyResult(value);if(result.requestId!==String(r.requestId).toLowerCase())throw invalid();return result
  },
  async current(input:{scope:string},signal?:AbortSignal){
   const r=readBusinessBuilderRequest('business-configuration/current',input),value=await call('business-configuration/current',r,signal)
   if(value===null)return null
   const result=readBusinessConfigurationCurrentResponse(value);if(result.scope!==r.scope)throw invalid();return result
  },
  async page(input:BusinessConfigurationPageRequest,signal?:AbortSignal){
   const r=readBusinessBuilderRequest('business-configuration/page',input),result=readBusinessConfigurationPageProjection(await call('business-configuration/page',r,signal))
   if(result.page.definition.id!==r.pageId||r.scope!==undefined&&(result.mode!=='saved'||result.scope!==r.scope)||r.draftId!==undefined&&(result.mode!=='preview'||result.draftId!==r.draftId||result.revision!==r.expectedRevision)||r.timeRange!==undefined&&(result.page.kind!=='dashboard'||result.page.timeRange!==r.timeRange))throw invalid()
   return result
  },
 }
}
export type BusinessBuilderApi=ReturnType<typeof createBusinessBuilderApi>
