import {
 businessTimeRanges,isBusinessScopeKey,readBusinessDashboardPage,readBusinessDashboardSummaries,readBusinessSyncRun,readBusinessSyncStatus,readBusinessSyncRuleState,readBusinessSyncRuleView,readBusinessRuntimeState,
 type BusinessDashboardPage,type BusinessDashboardSummary,type BusinessSyncRun,type BusinessSyncStatus,type BusinessSyncRuleState,type BusinessSyncRuleView,type BusinessRuntimeState,type BusinessTimeRange,
} from '@teloa/contract'

type Call=(method:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>

const localId=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const invalidHost=()=>Object.assign(Error('看板服务回包与本次请求不一致。'),{code:'teloa/invalid-host-response'})
function scopeOf(value:unknown):string{
 if(!isBusinessScopeKey(value)||value==='general')throw Error('需要明确的业务范围。')
 return value
}
function idOf(value:unknown,message:string):string{if(typeof value!=='string'||!localId.test(value))throw Error(message);return value}
function requestIdOf(value:unknown):string{if(typeof value!=='string'||!uuid.test(value))throw Error('请求标识不合法。');return value}
/** 可选的整页时间范围：只收五个枚举键，没选就不进载荷（宿主按看板默认范围）。 */
function timeRangeOf(value:unknown):{timeRange?:BusinessTimeRange}{
 if(value===undefined)return {}
 if(!(businessTimeRanges as readonly unknown[]).includes(value))throw Error('时间范围不合法。')
 return {timeRange:value as BusinessTimeRange}
}
/** 回包核对：是请求的那一张看板；请求带了范围时，回包所选范围必须就是它。 */
function pageFor(page:BusinessDashboardPage,dashboardId:string,range:{timeRange?:BusinessTimeRange}):BusinessDashboardPage{
 if(page.dashboard.id!==dashboardId)throw invalidHost()
 if(range.timeRange!==undefined&&page.timeRange?.selected!==range.timeRange)throw invalidHost()
 return page
}

/**
 * 看板与同步的读侧（照 `business-ledger-api.ts` 的 `call` 封装）：请求只递契约白名单键，
 * 回包一律过契约读取器——组件声明里的图表规范因此在下发到界面之前就再过了一次白名单（纵深）。
 * 刷新与立即同步自带 requestId：看板刷新宿主按它幂等（同一 requestId 重放取已记下的结果）；立即同步宿主只核对格式、不按它去重，
 * 恢复重放会再同步一次——同步按主键与快照哈希写入，重复拉取不产生重复对象，只多一条同步记录。客户端先核对形状，不合格不发请求。
 */
export function createBusinessDashboardApi(call:Call){
 return {
  async list(input:{scope:string},signal?:AbortSignal):Promise<BusinessDashboardSummary[]>{
   const scope=scopeOf(input.scope)
   return readBusinessDashboardSummaries(await call('business-dashboards/list',{scope},signal),scope)
  },
  async read(input:{scope:string;dashboardId:string;timeRange?:BusinessTimeRange|undefined},signal?:AbortSignal):Promise<BusinessDashboardPage>{
   const scope=scopeOf(input.scope),dashboardId=idOf(input.dashboardId,'看板标识不合法。'),range=timeRangeOf(input.timeRange)
   return pageFor(readBusinessDashboardPage(await call('business-dashboards/read',{scope,dashboardId,...range},signal),scope),dashboardId,range)
  },
  async refresh(input:{requestId:string;scope:string;dashboardId:string;timeRange?:BusinessTimeRange|undefined},signal?:AbortSignal):Promise<BusinessDashboardPage>{
   const requestId=requestIdOf(input.requestId),scope=scopeOf(input.scope),dashboardId=idOf(input.dashboardId,'看板标识不合法。'),range=timeRangeOf(input.timeRange)
   return pageFor(readBusinessDashboardPage(await call('business-dashboards/refresh',{requestId,scope,dashboardId,...range},signal),scope),dashboardId,range)
  },
  async syncStatus(input:{scope:string},signal?:AbortSignal):Promise<BusinessSyncStatus[]>{
   const scope=scopeOf(input.scope),value=await call('business-sync/status',{scope},signal)
   if(!Array.isArray(value))throw invalidHost()
   return value.map(item=>readBusinessSyncStatus(item,scope))
  },
  async syncRules(input:{scope:string},signal?:AbortSignal):Promise<BusinessSyncRuleView[]>{
   const scope=scopeOf(input.scope),value=await call('business-sync/rules',{scope},signal)
   if(!Array.isArray(value))throw invalidHost()
   const rows=value.map(item=>readBusinessSyncRuleView(item,scope))
   if(new Set(rows.map(row=>row.mappingId)).size!==rows.length)throw invalidHost()
   return rows
  },
  async syncRuntime(input:{scope:string},signal?:AbortSignal):Promise<BusinessRuntimeState>{
   const scope=scopeOf(input.scope),result=readBusinessRuntimeState(await call('business-sync/runtime',{scope},signal))
   if(result.scope!==scope)throw invalidHost()
   return result
  },
  async setSyncRuntime(input:{scope:string;enabled:boolean;expectedRevision:number;requestId:string},signal?:AbortSignal):Promise<BusinessRuntimeState>{
   const scope=scopeOf(input.scope),requestId=requestIdOf(input.requestId)
   if(typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)throw Error('业务持续运行启停参数不正确。')
   const result=readBusinessRuntimeState(await call('business-sync/runtime-set',{scope,enabled:input.enabled,expectedRevision:input.expectedRevision,requestId},signal))
   if(result.scope!==scope||!result.managed||result.syncEnabled!==input.enabled||result.revision!==input.expectedRevision+1)throw invalidHost()
   return result
  },
  async setSyncRule(input:{scope:string;mappingId:string;enabled:boolean;expectedRevision:number;requestId:string},signal?:AbortSignal):Promise<BusinessSyncRuleState>{
   const scope=scopeOf(input.scope),mappingId=idOf(input.mappingId,'映射标识不合法。'),requestId=requestIdOf(input.requestId)
   if(typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw Error('规则启停参数不正确。')
   const result=readBusinessSyncRuleState(await call('business-sync/rule-set',{scope,mappingId,enabled:input.enabled,expectedRevision:input.expectedRevision,requestId},signal),scope)
   if(result.mappingId!==mappingId||result.enabled!==input.enabled||result.revision!==input.expectedRevision+1)throw invalidHost()
   return result
  },
  async syncRuns(input:{scope:string;mappingId?:string;limit:number},signal?:AbortSignal):Promise<BusinessSyncRun[]>{
   const scope=scopeOf(input.scope),mappingId=input.mappingId===undefined?undefined:idOf(input.mappingId,'映射标识不合法。')
   if(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100)throw Error('同步记录条数必须在 1 到 100 之间。')
   const value=await call('business-sync/runs',{scope,...(mappingId===undefined?{}:{mappingId}),limit:input.limit},signal)
   if(!Array.isArray(value))throw invalidHost()
   const runs=value.map(item=>readBusinessSyncRun(item,scope))
   if(mappingId!==undefined&&runs.some(run=>run.mappingId!==mappingId))throw invalidHost()
   return runs
  },
  async syncRun(input:{requestId:string;scope:string;mappingId:string},signal?:AbortSignal):Promise<BusinessSyncRun>{
   const requestId=requestIdOf(input.requestId),scope=scopeOf(input.scope),mappingId=idOf(input.mappingId,'映射标识不合法。')
   const run=readBusinessSyncRun(await call('business-sync/run',{requestId,scope,mappingId},signal),scope)
   if(run.mappingId!==mappingId)throw invalidHost()
   return run
  },
 }
}

export type BusinessDashboardApi=ReturnType<typeof createBusinessDashboardApi>
