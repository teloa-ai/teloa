import {WorkError} from './work-error.ts'

/** 只保存原生路由身份；地址、密钥和提供方参数仍由 DSH 管理。 */
export type ModelReference={provider:string;model:string;reasoningEffort?:string}
export type TaskRunModelPolicy={primary:ModelReference;fallback?:ModelReference}
export const modelRecoveryReasons=['TIMEOUT','TRANSPORT','SERVER','RATE_LIMIT','NO_ADAPTER','UNKNOWN_MODEL'] as const
export type ModelRecoveryReason=typeof modelRecoveryReasons[number]
export type ModelRecovery={from:ModelReference;to:ModelReference;reason:ModelRecoveryReason}
const fields=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new WorkError('teloa/invalid-input','模型配置格式不正确。')
 return value as Record<string,unknown>
}
const token=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value&&!/[\s\x00-\x1f\x7f]/.test(value)
export function readModelReference(value:unknown):ModelReference{
 const row=fields(value,['provider','model','reasoningEffort'])
 if(!token(row.provider,128)||!token(row.model,256)||row.reasoningEffort!==undefined&&!token(row.reasoningEffort,128))throw new WorkError('teloa/invalid-input','请选择有效的模型。')
 return {provider:row.provider,model:row.model,...(row.reasoningEffort===undefined?{}:{reasoningEffort:row.reasoningEffort as string})}
}
export const sameModelRoute=(a:ModelReference,b:ModelReference):boolean=>a.provider===b.provider&&a.model===b.model
export function readTaskRunModelPolicy(value:unknown):TaskRunModelPolicy{
 const row=fields(value,['primary','fallback']),primary=readModelReference(row.primary),fallback=row.fallback===undefined?undefined:readModelReference(row.fallback)
 if(fallback&&sameModelRoute(primary,fallback))throw new WorkError('teloa/invalid-input','备用模型不能与首选模型相同。')
 return {primary,...(fallback?{fallback}:{})}
}
export function readModelRecovery(value:unknown):ModelRecovery{
 const row=fields(value,['from','to','reason']),from=readModelReference(row.from),to=readModelReference(row.to)
 if(!(modelRecoveryReasons as readonly unknown[]).includes(row.reason)||sameModelRoute(from,to))throw new WorkError('teloa/invalid-input','模型切换记录不正确。')
 return {from,to,reason:row.reason as ModelRecoveryReason}
}

/** 原生日志的只读投影。请求头证明请求选路，不代表模型已经成功返回。 */
export type TaskRunModelStatus={state:'unobserved'|'unavailable'}|{state:'observed';model:ModelReference;requestSeq:number;recovery?:ModelRecovery}
export function readTaskRunModelStatus(value:unknown,policy:TaskRunModelPolicy):TaskRunModelStatus{
 const row=fields(value,['state','model','requestSeq','recovery'])
 if(row.state==='unobserved'||row.state==='unavailable'){
  if(Object.keys(row).length!==1)throw new WorkError('teloa/invalid-input','模型观察状态不正确。')
  return {state:row.state}
 }
 if(row.state!=='observed'||!Number.isSafeInteger(row.requestSeq)||(row.requestSeq as number)<0)throw new WorkError('teloa/invalid-input','模型请求证据不正确。')
 const model=readModelReference(row.model),recovery=row.recovery===undefined?undefined:readModelRecovery(row.recovery)
 // 原生适配器可以补默认思考档位；路由身份必须属于本次固定策略。
 if(recovery){
  if(JSON.stringify(recovery.from)!==JSON.stringify(policy.primary)||JSON.stringify(recovery.to)!==JSON.stringify(policy.fallback)||!sameModelRoute(model,recovery.to))throw new WorkError('teloa/invalid-input','模型切换与本次执行不一致。')
 }else if(!sameModelRoute(model,policy.primary))throw new WorkError('teloa/invalid-input','模型请求与首选配置不一致。')
 return {state:'observed',model,requestSeq:row.requestSeq as number,...(recovery?{recovery}:{})}
}
