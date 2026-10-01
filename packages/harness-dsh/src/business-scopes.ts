import {WorkError,isBusinessScopeLabel,isRecord,type BusinessScopeLabel} from '@teloa/contract'
import type {BusinessScopeService} from '@teloa/backend'

export const businessScopeEndpoints=['business-scopes/list'] as const
const invalid=()=>new WorkError('teloa/invalid-host-response','业务范围标签回包的取值、计数或字段不正确。')

/** 严格回包：只有 `items` 一个键，每条标签逐项核对形状，标签不得重复。 */
export function readBusinessScopeLabels(value:unknown):{items:BusinessScopeLabel[]}{
 if(!isRecord(value)||Object.keys(value).length!==1||!('items' in value)||!Array.isArray(value.items)||value.items.length>500)throw invalid()
 const items=value.items.map(item=>{if(!isBusinessScopeLabel(item))throw invalid();return item})
 if(new Set(items.map(item=>item.scope)).size!==items.length)throw invalid()
 return {items}
}

export function createBusinessScopeHandler(owner:string,get:()=>Promise<BusinessScopeService>){
 return async(endpoint:string,_payload:unknown):Promise<unknown>=>{
  // 目录是只读汇总，不接受任何入参：客户端提不出 `kind`、`spaceId`，也无从指定别人的身份。
  if(endpoint==='business-scopes/list')return readBusinessScopeLabels({items:await(await get()).list(owner)})
  throw new WorkError('teloa/not-found','未提供此业务范围接口。')
 }
}
