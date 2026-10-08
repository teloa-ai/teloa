import {WorkError} from './work-error.ts'
import {workObject,workUuid,workMoment} from './work-events.ts'
export type WorkProgress={rootTaskId:string;version:number;stage:string;completedStepIds:string[];nextStep:string|null;wait:{kind:'event'|'time'|'owner'|'external';reason:string;nextAt:string|null}|null;artifactIds:string[];pendingActionIds:string[];updatedAt:string}
export type WorkProgressFields=Omit<WorkProgress,'rootTaskId'|'version'|'updatedAt'>
const words=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim()&&v.length<=4000
const ids=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=256&&v.every(workUuid)&&new Set(v).size===v.length
const steps=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=256&&v.every(id=>typeof id==='string'&&/^[a-zA-Z0-9][-_a-zA-Z0-9]{0,119}$/.test(id))&&new Set(v).size===v.length
export function readWorkProgressFields(value:unknown):WorkProgressFields{
 const v=workObject(value,['stage','completedStepIds','nextStep','wait','artifactIds','pendingActionIds'])
 if(!words(v.stage)||v.nextStep!==null&&!words(v.nextStep)||!steps(v.completedStepIds)||!ids(v.artifactIds)||!ids(v.pendingActionIds))throw new WorkError('teloa/invalid-input','工作进展字段格式不正确。')
 let wait:WorkProgress['wait']=null
 if(v.wait!==null){const w=workObject(v.wait,['kind','reason','nextAt']);if(!['event','time','owner','external'].includes(String(w.kind))||!words(w.reason)||w.nextAt!==null&&typeof w.nextAt!=='string')throw new WorkError('teloa/invalid-input','工作等待条件不正确。');wait={kind:w.kind as NonNullable<WorkProgress['wait']>['kind'],reason:w.reason,nextAt:w.nextAt===null?null:workMoment(w.nextAt)}}
 return {stage:v.stage,completedStepIds:[...v.completedStepIds],nextStep:v.nextStep as string|null,wait,artifactIds:[...v.artifactIds],pendingActionIds:[...v.pendingActionIds]}
}
export function readWorkProgress(value:unknown):WorkProgress{const v=workObject(value,['rootTaskId','version','stage','completedStepIds','nextStep','wait','artifactIds','pendingActionIds','updatedAt']),{rootTaskId,version,updatedAt,...fields}=v;if(!workUuid(rootTaskId)||!Number.isSafeInteger(version)||Number(version)<1)throw new WorkError('teloa/invalid-input','工作进展身份或版本不正确。');return {rootTaskId,version:Number(version),...readWorkProgressFields(fields),updatedAt:workMoment(updatedAt)}}
