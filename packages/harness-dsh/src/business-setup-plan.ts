import {WorkError,taskInput,readBusinessConversationSession,readBusinessSetupPlan,readBusinessSetupPreview,readBusinessSetupAdoption,readBusinessSetupManual,readBusinessSetupHistory,type BusinessConversationBinding} from '@teloa/contract'
import type {BusinessSetupPlanService} from '@teloa/backend'

export const businessSetupPlanEndpoints=['business-setup-plan/list','business-setup-plan/history','business-setup-plan/restore','business-setup-plan/read','business-setup-plan/revise','business-setup-plan/manual','business-setup-plan/edit','business-setup-plan/preview','business-setup-plan/apply','business-setup-plan/receipt','business-setup-plan/prepare','business-setup-plan/readiness'] as const
type Services={bindings:{bySession:(actor:{ownerId:string;scopeIds:string[]},input:{sessionId:string})=>Promise<BusinessConversationBinding|undefined>};setup:BusinessSetupPlanService}
const keys:Record<string,string[]>={read:[],manual:[],restore:['requestId','expectedRevision','configurationRevision','configurationHash','version','expectedHash'],edit:['requestId','expectedRevision','configurationRevision','configurationHash','candidate','description','roleEdits'],revise:['requestId','expectedRevision','package','roleEdits'],preview:['expectedRevision','rejected'],apply:['requestId','expectedRevision','expectedDigest','previewReceipt'],receipt:['requestId'],prepare:['expectedDigest'],readiness:[]}
/** 每次从可信本人会话重取绑定；模型提交的 owner、scope、授权及发送状态都不是接口参数。 */
export function createBusinessSetupPlanHandler(ownerId:string,scopeIds:()=>Promise<readonly string[]>,get:()=>Promise<Services>){
 return async(endpoint:string,value:unknown)=>{
  const method=endpoint.slice('business-setup-plan/'.length)
  if(!(businessSetupPlanEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此业务方案接口。')
  if(method==='list'){const actor={ownerId,scopeIds:[...await scopeIds()]};return (await get()).setup.list(actor,taskInput(value,['scope']))}
  if(method==='history'){const actor={ownerId,scopeIds:[...await scopeIds()]};return readBusinessSetupHistory(await (await get()).setup.history(actor,taskInput(value,['scope','beforeVersion'])))}
  const request=taskInput(value,['sessionId','draftId',...keys[method]!]),{sessionId}=readBusinessConversationSession({sessionId:request.sessionId})
  const actor={ownerId,scopeIds:[...await scopeIds()]},services=await get(),binding=await services.bindings.bySession(actor,{sessionId})
  if(!binding||binding.kind!=='builder'||binding.sessionId!==sessionId||binding.draftId!==request.draftId)throw new WorkError('teloa/forbidden','只能在原业务搭建会话处理当前方案。')
  const {sessionId:_,...input}=request
  if(method==='read'){const result=await services.setup.read(actor,input);return result===null?null:readBusinessSetupPlan(result)}
  if(method==='manual')return readBusinessSetupManual(await services.setup.manual(actor,input))
  if(method==='edit')return readBusinessSetupPlan(await services.setup.edit(actor,input))
  if(method==='restore')return readBusinessSetupPlan(await services.setup.restore(actor,input))
  if(method==='revise')return readBusinessSetupPlan(await services.setup.revise(actor,input))
  if(method==='preview')return readBusinessSetupPreview(await services.setup.preview(actor,input))
  if(method==='apply')return readBusinessSetupAdoption(await services.setup.apply(actor,input))
  if(method==='receipt'){const result=await services.setup.receiptByRequest(actor,{requestId:input.requestId});return result===null?null:readBusinessSetupAdoption(result)}
  if(method==='prepare')return readBusinessSetupPlan(await services.setup.prepare(actor,input))
  return services.setup.readiness(actor,input)
 }
}
