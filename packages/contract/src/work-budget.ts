import {WorkError} from './work-error.ts'
import type {WorkBudgetPolicy} from './role-work.ts'
export type BudgetReservation={id:string;ownerId:string;budgetAccountId:string;controlGeneration:number;modelRequestId:string;providerRequestId:string|null;kind:'goal'|'team'|'routing'|'memory'|'retry';reservedTokens:number;reservedRounds:number;state:'reserved'|'settled'|'unknown'|'released'}
/** 上限是累计工作额度，不因进程重启、下一周期或新子任务自动重置。 */
export function readWorkBudgetPolicy(value:unknown):WorkBudgetPolicy{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new WorkError('teloa/invalid-input','工作额度格式不正确。')
 const v=value as Record<string,unknown>,keys=['maxGoalRounds','maxTokens','maxElapsedMs','maxConcurrent','maxRetries','stagnationRounds','money']
 if(Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k))||keys.slice(0,-1).some(k=>!Number.isSafeInteger(v[k])||Number(v[k])<(k==='maxRetries'?0:1)))throw new WorkError('teloa/invalid-input','工作额度需要完整的正数上限；重试次数可以为 0。')
 if(v.money!==null){const m=v.money as Record<string,unknown>;if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).length!==2||!Object.hasOwn(m,'currency')||!Object.hasOwn(m,'maxMinorUnits')||typeof m.currency!=='string'||!/^[A-Z]{3}$/.test(m.currency)||!Number.isSafeInteger(m.maxMinorUnits)||Number(m.maxMinorUnits)<1)throw new WorkError('teloa/invalid-input','费用额度格式不正确。')}
 return structuredClone(v) as WorkBudgetPolicy
}
