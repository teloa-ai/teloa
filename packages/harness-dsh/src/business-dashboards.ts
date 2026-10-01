import {
 WorkError,businessDashboardEndpoints,businessSyncRuleWriteEndpoint,businessTimeRanges,readBusinessDashboardPage,readBusinessDashboardSummaries,readBusinessSyncRun,readBusinessSyncStatus,readBusinessSyncRuleState,readBusinessSyncRuleView,readBusinessRuntimeState,readBusinessRuntimeSetSyncInput,taskInput,
} from '@teloa/contract'
import type {BusinessDashboardService,BusinessSyncService,BusinessSyncRuleService,BusinessRuntimeService} from '@teloa/backend'

export {businessDashboardEndpoints,businessSyncRuleWriteEndpoint} from '@teloa/contract'
export const businessSyncRuntimeEndpoints=['business-sync/runtime','business-sync/runtime-set'] as const

type Endpoint=typeof businessDashboardEndpoints[number]|typeof businessSyncRuleWriteEndpoint|typeof businessSyncRuntimeEndpoints[number]
const keys:Record<Endpoint,readonly string[]>={
 'business-dashboards/list':['scope'],
 // 固定键 + 可选 timeRange（值须在 businessTimeRanges；看板有没有这个范围由服务端按声明核对）。
 'business-dashboards/read':['scope','dashboardId','timeRange'],
 'business-dashboards/refresh':['requestId','scope','dashboardId','timeRange'],
 'business-sync/status':['scope'],
 'business-sync/runs':['scope','mappingId','limit'],
 'business-sync/run':['requestId','scope','mappingId'],
 'business-sync/rules':['scope'],
 'business-sync/rule-set':['requestId','scope','mappingId','enabled','expectedRevision'],
 'business-sync/runtime':['scope'],
 'business-sync/runtime-set':['requestId','scope','enabled','expectedRevision'],
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const invalidHost=()=>new WorkError('teloa/invalid-host-response','看板服务回包与本次请求不一致。')
/** 回包读取器只认契约形状；任何不符都收成宿主回包错误，不把服务端细节透给界面。 */
function hostRead<T>(read:()=>T):T{
 try{return read()}catch(error){if(error instanceof WorkError&&error.code==='teloa/invalid-host-response')throw invalidHost();throw error}
}

/**
 * 看板与同步的 RPC 端点（本人界面用）：本人身份与登记范围只取可信来源，请求里不能带主体；
 * 请求键集严格（多字段、未知字段即 `teloa/invalid-input`），范围不在 `scopeIds()` 即 `teloa/forbidden`；
 * 回包一律过契约读取器，形状不符即 `teloa/invalid-host-response`。模型会话没有这些写口（刷新、立即同步）。
 */
export function createBusinessDashboardHandler(owner:string,scopeIds:()=>Promise<readonly string[]>,get:()=>Promise<{dashboards:BusinessDashboardService;sync:BusinessSyncService;rules?:BusinessSyncRuleService;runtime?:BusinessRuntimeService}>){
 return async(endpoint:string,payload:unknown,signal?:AbortSignal):Promise<unknown>=>{
  if(!(businessDashboardEndpoints as readonly string[]).includes(endpoint)&&endpoint!==businessSyncRuleWriteEndpoint&&!(businessSyncRuntimeEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此看板接口。')
  const name=endpoint as Endpoint,row=taskInput(payload,keys[name])
  if(typeof row.scope!=='string')throw new WorkError('teloa/invalid-input','需要明确的业务范围。')
  if((name==='business-dashboards/refresh'||name==='business-sync/run'||name==='business-sync/rule-set'||name==='business-sync/runtime-set')&&(typeof row.requestId!=='string'||!uuid.test(row.requestId)))throw new WorkError('teloa/invalid-input','请求标识不合法。')
  if(row.timeRange!==undefined&&!(businessTimeRanges as readonly unknown[]).includes(row.timeRange))throw new WorkError('teloa/invalid-input','时间范围不合法。')
  const range=row.timeRange===undefined?{}:{timeRange:row.timeRange}
  const scopes=[...await scopeIds()],scope=row.scope
  if(!scopes.includes(scope))throw new WorkError('teloa/forbidden','当前主体未获准读取此业务范围。')
  signal?.throwIfAborted()
  const actor={ownerId:owner,scopeIds:scopes},{dashboards,sync,rules,runtime}=await get()
  // 回包所按的范围必须是本次请求的范围（未指定即看板默认范围）；看板无 filters 时契约读取器已要求 timeRange 为 null。
  const page=(value:unknown)=>hostRead(()=>{
   const read=readBusinessDashboardPage(value,scope)
   if(read.dashboard.id!==row.dashboardId)throw invalidHost()
   if(read.timeRange!==null&&read.timeRange.selected!==(row.timeRange??read.dashboard.filters?.timeRange.default))throw invalidHost()
   return read
  })
  switch(name){
   case 'business-dashboards/list':{const value=await dashboards.list(actor,{scope});return hostRead(()=>readBusinessDashboardSummaries(value,scope))}
   case 'business-dashboards/read':{const value=await dashboards.read(actor,{scope,dashboardId:row.dashboardId,...range});return page(value)}
   case 'business-dashboards/refresh':{const value=await dashboards.refresh(actor,{requestId:row.requestId,scope,dashboardId:row.dashboardId,...range},signal);return page(value)}
   case 'business-sync/status':{const value=await sync.status(actor,scope);return hostRead(()=>{if(!Array.isArray(value))throw invalidHost();return value.map(item=>readBusinessSyncStatus(item,scope))})}
   case 'business-sync/runs':{
    if(row.mappingId!==undefined&&typeof row.mappingId!=='string')throw new WorkError('teloa/invalid-input','映射标识不合法。')
    const value=await sync.runs(actor,{scope,limit:row.limit as number,...(row.mappingId===undefined?{}:{mappingId:row.mappingId as string})})
    return hostRead(()=>{if(!Array.isArray(value)||value.some(item=>row.mappingId!==undefined&&item?.mappingId!==row.mappingId))throw invalidHost();return value.map(item=>readBusinessSyncRun(item,scope))})
   }
   case 'business-sync/run':{
    if(typeof row.mappingId!=='string')throw new WorkError('teloa/invalid-input','需要明确的数据源映射。')
    const value=await sync.run(actor,{scope,mappingId:row.mappingId,trigger:'manual'},signal)
    return hostRead(()=>{const run=readBusinessSyncRun(value,scope);if(run.mappingId!==row.mappingId)throw invalidHost();return run})
   }
   case 'business-sync/rules':{
    if(!rules||!runtime)throw new WorkError('teloa/dependency-unavailable','业务规则状态暂不可读。')
    const scopeState=await runtime.get(actor,scope)
    const mappings=(await sync.mappings(actor,scope)).filter(mapping=>mapping.source.kind!=='role-result')
    const states=await Promise.all(mappings.map(async mapping=>{
     const state=await rules.get(actor,{scope,mappingId:mapping.id})
     return readBusinessSyncRuleView({...state,title:mapping.title,schedule:mapping.schedule,running:state.enabled&&scopeState.syncEnabled},scope)
    }))
    return states
   }
   case 'business-sync/rule-set':{
    if(!rules)throw new WorkError('teloa/dependency-unavailable','业务规则启停暂不可用。')
    if(typeof row.mappingId!=='string'||typeof row.enabled!=='boolean'||!Number.isSafeInteger(row.expectedRevision)||Number(row.expectedRevision)<0)throw new WorkError('teloa/invalid-input','业务规则启停参数不正确。')
    const result=await rules.set(actor,{scope,mappingId:row.mappingId,enabled:row.enabled,expectedRevision:row.expectedRevision as number,requestId:row.requestId as string})
    return hostRead(()=>{const state=readBusinessSyncRuleState(result,scope);if(state.mappingId!==row.mappingId||state.enabled!==row.enabled||state.revision!==(row.expectedRevision as number)+1)throw invalidHost();return state})
   }
   case 'business-sync/runtime':{
    if(!runtime)throw new WorkError('teloa/dependency-unavailable','业务持续运行状态暂不可读。')
    const result=await runtime.get(actor,scope)
    return hostRead(()=>{const state=readBusinessRuntimeState(result);if(state.scope!==scope)throw invalidHost();return state})
   }
   case 'business-sync/runtime-set':{
    if(!runtime)throw new WorkError('teloa/dependency-unavailable','业务持续运行启停暂不可用。')
    const input=readBusinessRuntimeSetSyncInput(row)
    const result=await runtime.setSync(actor,input)
    return hostRead(()=>{const state=readBusinessRuntimeState(result);if(state.scope!==scope||state.syncEnabled!==input.enabled||state.revision!==input.expectedRevision+1)throw invalidHost();return state})
   }
  }
 }
}
