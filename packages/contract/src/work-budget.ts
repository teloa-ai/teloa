import {WorkError} from './work-error.ts'
import type {WorkBudgetPolicy} from './role-work.ts'
export type BudgetReservation={id:string;ownerId:string;budgetAccountId:string;controlGeneration:number;modelRequestId:string;providerRequestId:string|null;kind:'goal'|'team'|'routing'|'memory'|'retry';reservedTokens:number;reservedRounds:number;state:'reserved'|'settled'|'unknown'|'released'}
/**
 * 模型耗时上限（`maxElapsedMs`）只统计滚动窗口内的模型调用时长：较早的耗时满窗口后自动释放，持续业务不会因终身累计停摆。
 * 未核验终态的调用仍按进行中计时，与并发占用一致。token 与轮次仍是累计额度。
 */
export const workBudgetElapsedWindowMs=86_400_000
/** 单次交办只允许预设有限 token 上限；与完整 WorkBudgetPolicy.maxTokens 使用同一数值边界。 */
export function readWorkTokenLimit(value:unknown):number{
 if(!Number.isSafeInteger(value)||Number(value)<1)throw new WorkError('teloa/invalid-input','工作 token 上限必须是正安全整数。')
 return Number(value)
}
export type WorkBudgetExhaustion={reason:'tokens'|'rounds'|'concurrent'|'elapsed';scope:'work'|'owner'}
const exhaustionReasons:readonly string[]=['tokens','rounds','concurrent','elapsed'],exhaustionScopes:readonly string[]=['work','owner']
/**
 * 模型请求中额度拒绝只能经原生失败 code 留在 turn/end（原生失败没有 details）：`teloa/budget-exhausted/<reason>/<scope>`。
 * 原因不明时退回 `teloa/budget-exhausted`，界面只按 code 本地化，不解析 message。
 */
export function workBudgetExhaustedCode(details:unknown):string{
 const d=details&&typeof details==='object'?details as Record<string,unknown>:{}
 return exhaustionReasons.includes(String(d.reason))&&exhaustionScopes.includes(String(d.scope))?`teloa/budget-exhausted/${d.reason}/${d.scope}`:'teloa/budget-exhausted'
}
export function readWorkBudgetExhaustedCode(code:unknown):Partial<WorkBudgetExhaustion>|undefined{
 if(code==='teloa/budget-exhausted')return {}
 const m=typeof code==='string'?/^teloa\/budget-exhausted\/([a-z]+)\/([a-z]+)$/.exec(code):null
 return m&&exhaustionReasons.includes(m[1]!)&&exhaustionScopes.includes(m[2]!)?{reason:m[1],scope:m[2]} as WorkBudgetExhaustion:undefined
}
/** token 与轮次上限是累计工作额度，不因进程重启、下一周期或新子任务自动重置；耗时按 {@link workBudgetElapsedWindowMs} 滚动窗口计。 */
export function readWorkBudgetPolicy(value:unknown):WorkBudgetPolicy{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new WorkError('teloa/invalid-input','工作额度格式不正确。')
 const v=value as Record<string,unknown>,keys=['maxGoalRounds','maxTokens','maxElapsedMs','maxConcurrent','maxRetries','stagnationRounds','money']
 if(Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k))||keys.slice(0,-1).filter(k=>k!=='maxTokens').some(k=>!Number.isSafeInteger(v[k])||Number(v[k])<(k==='maxRetries'?0:1)))throw new WorkError('teloa/invalid-input','工作额度需要完整的正数上限；重试次数可以为 0。')
 readWorkTokenLimit(v.maxTokens)
 if(v.money!==null){const m=v.money as Record<string,unknown>;if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).length!==2||!Object.hasOwn(m,'currency')||!Object.hasOwn(m,'maxMinorUnits')||typeof m.currency!=='string'||!/^[A-Z]{3}$/.test(m.currency)||!Number.isSafeInteger(m.maxMinorUnits)||Number(m.maxMinorUnits)<1)throw new WorkError('teloa/invalid-input','费用额度格式不正确。')}
 return structuredClone(v) as WorkBudgetPolicy
}
