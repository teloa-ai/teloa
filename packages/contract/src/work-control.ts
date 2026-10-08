import {WorkError} from './work-error.ts'
import {readGoalRunBinding,type GoalRunBinding} from './task-run-goal.ts'

export type WorkControl={id:string;ownerId:string;generation:number;version:number;state:'active'|'pausing'|'paused'|'stopping'|'stopped';scope:'round'|'definition';pendingRunIds:string[];unknownOperationIds:string[]}
export type RecoveryCandidate={controlId:string;expectedGeneration:number;runId:string;nativeRequestId:string;goal:GoalRunBinding|null;reason:'unaccepted'|'accepted'|'unknown';safeRecovery:boolean}
export type WorkControlChange={requestId:string;controlId:string;expectedVersion:number;action:'pause'|'resume'|'stop';scope:'round'|'definition';roundControlId:string|null}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0
const text=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim()&&v.length<=512&&!/[\x00-\x1f]/.test(v)
const invalid=()=>new WorkError('teloa/invalid-input','整项工作控制或恢复请求不正确。')
const exact=(value:unknown,keys:readonly string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value as Record<string,unknown>}
function ids(value:unknown,check:(v:unknown)=>v is string):string[]{if(!Array.isArray(value)||value.some(v=>!check(v))||new Set(value).size!==value.length)throw invalid();return [...value]}
export function readWorkControl(value:unknown):WorkControl{
 const r=exact(value,['id','ownerId','generation','version','state','scope','pendingRunIds','unknownOperationIds'])
 if(!uuid(r.id)||!text(r.ownerId)||r.ownerId.length>128||!positive(r.generation)||!positive(r.version)||!['active','pausing','paused','stopping','stopped'].includes(r.state as string)||!['round','definition'].includes(r.scope as string))throw invalid()
 return {id:r.id,ownerId:r.ownerId,generation:r.generation,version:r.version,state:r.state as WorkControl['state'],scope:r.scope as WorkControl['scope'],pendingRunIds:ids(r.pendingRunIds,uuid),unknownOperationIds:ids(r.unknownOperationIds,text)}
}
export function readWorkControlChange(value:unknown):WorkControlChange{
 const r=exact(value,['requestId','controlId','expectedVersion','action','scope','roundControlId'])
 if(!uuid(r.requestId)||!uuid(r.controlId)||!positive(r.expectedVersion)||!['pause','resume','stop'].includes(r.action as string)||!['round','definition'].includes(r.scope as string)||r.roundControlId!==null&&!uuid(r.roundControlId))throw invalid()
 return {requestId:r.requestId,controlId:r.controlId,expectedVersion:r.expectedVersion,action:r.action as WorkControlChange['action'],scope:r.scope as WorkControlChange['scope'],roundControlId:r.roundControlId as string|null}
}
export function readRecoveryCandidate(value:unknown):RecoveryCandidate{
 const r=exact(value,['controlId','expectedGeneration','runId','nativeRequestId','goal','reason','safeRecovery'])
 if(!uuid(r.controlId)||!positive(r.expectedGeneration)||!uuid(r.runId)||!uuid(r.nativeRequestId)||!['unaccepted','accepted','unknown'].includes(r.reason as string)||typeof r.safeRecovery!=='boolean')throw invalid()
 return {controlId:r.controlId,expectedGeneration:r.expectedGeneration,runId:r.runId,nativeRequestId:r.nativeRequestId,goal:r.goal===null?null:readGoalRunBinding(r.goal),reason:r.reason as RecoveryCandidate['reason'],safeRecovery:r.safeRecovery}
}
