import type {BusinessDataSourcePort,IndustryDataSourceReadiness} from '@teloa/backend'

export type ReadyDataSourcePort=BusinessDataSourcePort&{ready:(scope:string,signal:AbortSignal)=>Promise<{ready:true;probedAt:string}|{ready:false;reason:string}>}

/** 只按固定定义里的 sourceId 匹配宿主端口；不按标题猜测，不缓存结果。 */
export function createIndustryDataSourceReadiness(ports:readonly ReadyDataSourcePort[],now:()=>string):IndustryDataSourceReadiness{
 return {async ready(definition,scope,signal){
  signal.throwIfAborted()
  const port=ports.find(candidate=>candidate.id===definition.sourceId)
  if(!port)return {ready:false,reason:'宿主未注册数据源 '+definition.sourceId}
  if(!definition.scopes.every(value=>port.scopes.includes(value))||!port.scopes.includes(scope))return {ready:false,reason:'数据源 '+definition.sourceId+' 不覆盖范围 '+scope}
  const result=await port.ready(scope,signal)
  if(!result.ready)return result
  const probedAt=typeof result.probedAt==='string'&&Number.isFinite(Date.parse(result.probedAt))?new Date(result.probedAt).toISOString():now()
  return {ready:true,probedAt}
 }}
}
