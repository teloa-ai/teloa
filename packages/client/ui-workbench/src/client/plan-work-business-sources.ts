import {isBusinessScopeKey,type BusinessWorkSourceRef} from '@teloa/contract'
import type {BusinessBuilderApi} from './business-builder-api.js'
import type {BusinessLedgerApi} from './business-ledger-api.js'

export type PlanBusinessSource={sourceRef:Extract<BusinessWorkSourceRef,{kind:'business-object-type'}>;title?:string}
export type PlanBusinessSources={list:(scope:string,signal?:AbortSignal)=>Promise<PlanBusinessSource[]>}
const invalid=()=>Object.assign(Error('业务触发来源与当前业务不一致。'),{code:'teloa/invalid-host-response'})

/** 正式配置（含富字段 v2）优先；只有明确不存在时才读取旧台账，读取失败不能变为空目录。 */
export function createPlanBusinessSources(configuration:Pick<BusinessBuilderApi,'current'>,ledger:Pick<BusinessLedgerApi,'read'>):PlanBusinessSources{
 return {async list(scope,signal){
  if(!isBusinessScopeKey(scope)||scope==='general')throw invalid()
  const current=await configuration.current({scope},signal)
  if(current!==null){
   if(current.scope!==scope||current.manifest.scope!==scope)throw invalid()
   const types=new Set(current.manifest.definitions.filter(row=>row.kind==='object-type').map(row=>row.localId)),rows=new Map<string,PlanBusinessSource>([...types].map(type=>[type,{sourceRef:{kind:'business-object-type',scope,type}}]))
   for(const page of current.manifest.pages){
    if(page.kind!=='records')continue
    if(!types.has(page.objectType))throw invalid()
    if(!rows.get(page.objectType)?.title)rows.set(page.objectType,{sourceRef:{kind:'business-object-type',scope,type:page.objectType},title:page.title})
   }
   return [...rows.values()]
  }
  const legacy=await ledger.read({scope},signal)
  if(legacy.scope!==scope||legacy.blocks.some(row=>row.objectType.definition.domain!==scope))throw invalid()
  return legacy.blocks.map(row=>({sourceRef:{kind:'business-object-type',scope,type:row.objectType.definition.id},title:row.objectType.definition.title}))
 }}
}
