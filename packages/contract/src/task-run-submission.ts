import {WorkError,taskInput} from './index.ts'

export type TaskRunSubmissionDisposition={schema:'teloa.task-run-submission-disposition/v1';requestId:string;runId:string;sessionId:string;nativeRequestId:string;inputSha256:string;runtimeId:string;logCut:number;logSha256:string;acknowledgedUnknown:true;closedAt:string}
/** 独立于原生执行终态：保留是否执行过的不确定性，不代表成功、撤回或没有副作用。 */
export type TaskRunState='prepared'|'submitting'|'accepted'|'active'|'ended'|'withdrawn'|'configuration_failed'|'submission_unknown'
export const taskRunStates:readonly string[]=['prepared','submitting','accepted','active','ended','withdrawn','configuration_failed','submission_unknown'] satisfies TaskRunState[]
export const taskRunTerminalStates:readonly string[]=['ended','withdrawn','configuration_failed','submission_unknown'] satisfies TaskRunState[]
export function readTaskRunSubmissionDisposition(value:unknown):TaskRunSubmissionDisposition{
 const row=taskInput(value,['schema','requestId','runId','sessionId','nativeRequestId','inputSha256','runtimeId','logCut','logSha256','acknowledgedUnknown','closedAt'])
 const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v),sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
 if(Object.keys(row).length!==11||row.schema!=='teloa.task-run-submission-disposition/v1'||![row.requestId,row.runId,row.nativeRequestId,row.runtimeId].every(uuid)||typeof row.sessionId!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(row.sessionId)||!sha(row.inputSha256)||!sha(row.logSha256)||!Number.isSafeInteger(row.logCut)||Number(row.logCut)<-1||row.acknowledgedUnknown!==true||typeof row.closedAt!=='string'||!Number.isFinite(Date.parse(row.closedAt))||new Date(row.closedAt).toISOString()!==row.closedAt)throw new WorkError('teloa/invalid-input','未知提交处置回执不正确。')
 return {...row} as TaskRunSubmissionDisposition
}
