import {
 WorkError,readBusinessConversationReserve,readBusinessConversationBind,readBusinessConversationRequest,readBusinessConversationSession,readBusinessConversationList,readBusinessConversationBinding,readBusinessConversationDirectory,readBusinessConversationRecentDaily,readBusinessConversationRecentDailyResponse,
 readBusinessBuilderRequest,readBusinessConfigurationDraftResponseVersioned as readBusinessConfigurationDraftResponse,readBusinessConfigurationPreviewResponse,readBusinessConfigurationApplyResult,readBusinessConfigurationCurrentResponseVersioned as readBusinessConfigurationCurrentResponse,readBusinessConfigurationPageProjectionVersioned as readBusinessConfigurationPageProjection,
 type BusinessConversationReserve,type BusinessConversationList,type BusinessConfigurationPageRequest,
} from '@teloa/contract'
import {businessSetupUuid,readBusinessSetupPlan,readBusinessSetupPreview,readBusinessSetupAdoption,readBusinessSetupManual,readBusinessSetupHistory,type BusinessSetupManual} from '@teloa/contract'
type Call=(endpoint:string,input:unknown,signal?:AbortSignal)=>Promise<unknown>
export type BusinessBuilderDraftTarget={sessionId:string;draftId:string}
export type BusinessBuilderPreviewInput=BusinessBuilderDraftTarget&{expectedRevision:number}
export type BusinessBuilderDiscardInput=({sessionId:string}|{requestId:string})&{draftId:string;expectedRevision:number}
export type BusinessBuilderApplyInput=BusinessBuilderPreviewInput&{requestId:string;expectedBaseVersion:number;previewReceipt:string}
const invalid=()=>new WorkError('teloa/invalid-host-response','业务搭建回包与请求不一致。')
export function createBusinessBuilderApi(call:Call){
 const setupTarget=(input:BusinessBuilderDraftTarget)=>{readBusinessConversationSession({sessionId:input.sessionId});if(!businessSetupUuid(input.draftId))throw invalid();return input}
 return {
  async setupPlans(input:{scope:string},signal?:AbortSignal){
   if(Object.keys(input).length!==1||typeof input.scope!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(input.scope)||input.scope==='general')throw invalid()
   const result=await call('business-setup-plan/list',input,signal)
   if(!result||typeof result!=='object'||Object.keys(result).length!==1||!('items'in result)||!Array.isArray(result.items)||result.items.length>16)throw invalid()
   const nonempty=(v:unknown,max:number)=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v)
   if(result.items.some(row=>!row||typeof row!=='object'||Object.keys(row).length!==5||Object.keys(row).some(k=>!['scope','draftId','sessionId','title','revision'].includes(k))||row.scope!==input.scope||!businessSetupUuid(row.draftId)||!nonempty(row.sessionId,200)||!nonempty(row.title,120)||!Number.isSafeInteger(row.revision)||row.revision<1)||new Set(result.items.map(row=>row.draftId)).size!==result.items.length||new Set(result.items.map(row=>row.sessionId)).size!==result.items.length)throw invalid()
   return result as {items:{draftId:string;scope:string;sessionId:string;title:string;revision:number}[]}
  },
  async setupPlan(input:BusinessBuilderDraftTarget,signal?:AbortSignal){const target=setupTarget(input),value=await call('business-setup-plan/read',target,signal);if(value===null)return null;const result=readBusinessSetupPlan(value);if(result.draftId!==target.draftId)throw invalid();return result},
  async setupHistory(input:{scope:string;beforeVersion?:number},signal?:AbortSignal){if(typeof input.scope!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(input.scope)||input.scope==='general'||Object.keys(input).some(k=>!['scope','beforeVersion'].includes(k))||input.beforeVersion!==undefined&&(!Number.isSafeInteger(input.beforeVersion)||input.beforeVersion<1))throw invalid();const result=readBusinessSetupHistory(await call('business-setup-plan/history',input,signal));if(result.scope!==input.scope||input.beforeVersion!==undefined&&result.items.some(row=>row.version>=input.beforeVersion!))throw invalid();return result},
  async setupRestore(input:BusinessBuilderDraftTarget&{requestId:string;expectedRevision:0;configurationRevision:number;configurationHash:string;version:number;expectedHash:string},signal?:AbortSignal){setupTarget(input);const result=readBusinessSetupPlan(await call('business-setup-plan/restore',input,signal));if(result.draftId!==input.draftId||result.revision!==1)throw invalid();return result},
  async setupManual(input:BusinessBuilderDraftTarget,signal?:AbortSignal){setupTarget(input);const result=readBusinessSetupManual(await call('business-setup-plan/manual',input,signal));if(result.draftId!==input.draftId)throw invalid();return result},
  async setupEdit(input:BusinessBuilderDraftTarget&{requestId:string;expectedRevision:number;configurationRevision:number;configurationHash:string}&Pick<BusinessSetupManual,'candidate'|'description'|'roleEdits'>,signal?:AbortSignal){setupTarget(input);const result=readBusinessSetupPlan(await call('business-setup-plan/edit',input,signal));if(result.draftId!==input.draftId||result.revision!==input.expectedRevision+1)throw invalid();return result},
  async setupPreview(input:BusinessBuilderDraftTarget&{expectedRevision:number;rejected:string[]},signal?:AbortSignal){setupTarget(input);const result=readBusinessSetupPreview(await call('business-setup-plan/preview',input,signal));if(result.draftId!==input.draftId||result.revision!==input.expectedRevision+1)throw invalid();return result},
  async setupApply(input:BusinessBuilderDraftTarget&{requestId:string;expectedRevision:number;expectedDigest:string;previewReceipt:string},signal?:AbortSignal){setupTarget(input);const result=readBusinessSetupAdoption(await call('business-setup-plan/apply',input,signal));if(result.requestId!==input.requestId)throw invalid();return result},
  async setupReceipt(input:BusinessBuilderDraftTarget&{requestId:string},signal?:AbortSignal){const target={sessionId:input.sessionId,draftId:input.draftId,requestId:input.requestId};setupTarget(target);const value=await call('business-setup-plan/receipt',target,signal);if(value===null)return null;const result=readBusinessSetupAdoption(value);if(result.requestId!==target.requestId)throw invalid();return result},
  async setupPrepare(input:BusinessBuilderDraftTarget&{expectedDigest?:string},signal?:AbortSignal){setupTarget(input);const result=readBusinessSetupPlan(await call('business-setup-plan/prepare',input,signal));if(result.draftId!==input.draftId||result.state!=='applied')throw invalid();return result},
  async setupReadiness(input:BusinessBuilderDraftTarget,signal?:AbortSignal){setupTarget(input);const value=await call('business-setup-plan/readiness',input,signal);if(value===null)return null;if(!value||typeof value!=='object'||!('digest'in value)||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest)||!('rows'in value)||!Array.isArray(value.rows))throw invalid();return value as {digest:string;rows:{itemInstanceId:string;kind:string;title:string;state:string}[]}},
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
  async discard(input:BusinessBuilderDiscardInput,signal?:AbortSignal){
   const r=readBusinessBuilderRequest('business-configuration/discard',input),result=readBusinessConfigurationDraftResponse(await call('business-configuration/discard',r,signal))
   if(result.id!==r.draftId||result.revision!==Number(r.expectedRevision)+1||result.status!=='discarded')throw invalid()
   return result
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
