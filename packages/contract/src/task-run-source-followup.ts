import {WorkError,taskInput,businessObjectReference,type BusinessObjectReference} from './index.ts'
import {readTaskRunSubmissionDisposition,type TaskRunSubmissionDisposition} from './task-run-submission.ts'

export type SourceFollowupKind='unknown-verification'|'result-verification'
export const sourceFollowupNotice='此前提交结果未知，可能已执行并产生费用。本轮只按本人新的核验要求工作，不推定此前动作未发生，也不自动重做。原目标中的工具、资料和审批限制继续适用。'
export const resultFollowupNotice='本轮是本人新确认的成果重核验。原执行与来源记录保留，不自动重复此前动作。原目标中的工具、资料和审批限制继续适用。'
export type TaskRunSourceFollowupCommand={kind:SourceFollowupKind;requestId:string;runId:string;expectedTaskVersion:number;sourceUpdateId:string;instruction:string;dispositionRequestId?:string;acknowledgeUnknown?:true}
export type TaskRunSourceFollowupCandidate={schema:'teloa.task-run-source-followup-candidate/v1';kind:SourceFollowupKind;taskId:string;expectedTaskVersion:number;runId:string;sessionId:string;originalNativeRequestId:string;originalInputSha256:string;originalEvidenceSha256:string|null;disposition?:TaskRunSubmissionDisposition;sourceUpdateId:string;sourceTaskVersion:number;sourceEventId:string;reference:BusinessObjectReference}
export type TaskRunSourceFollowup={schema:'teloa.task-run-source-followup/v1';kind:SourceFollowupKind;requestId:string;taskId:string;taskVersion:number;sessionId:string;originalRunId:string;originalNativeRequestId:string;originalInputSha256:string;originalEvidenceSha256:string|null;disposition?:TaskRunSubmissionDisposition;sourceUpdateId:string;sourceTaskVersion:number;sourceEventId:string;reference:BusinessObjectReference;instruction:string;confirmedAt:string;notice:string}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0
const instruction=(v:unknown):v is string=>typeof v==='string'&&v===v.trim()&&!!v&&v.length<=8000&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)
const denied=()=>new WorkError('teloa/invalid-input','请核对原执行、固定来源，并明确提交本轮核验要求。')
export function readTaskRunSourceFollowupCommand(value:unknown):TaskRunSourceFollowupCommand{
 const row=taskInput(value,['kind','requestId','runId','expectedTaskVersion','dispositionRequestId','sourceUpdateId','acknowledgeUnknown','instruction'])
 const unknown=row.kind==='unknown-verification'
 if(!['unknown-verification','result-verification'].includes(String(row.kind))||Object.keys(row).length!==(unknown?8:6)||![row.requestId,row.runId,row.sourceUpdateId].every(uuid)||row.requestId===row.runId||!positive(row.expectedTaskVersion)||!instruction(row.instruction)||unknown&&(!uuid(row.dispositionRequestId)||row.requestId===row.dispositionRequestId||row.acknowledgeUnknown!==true)||!unknown&&(row.dispositionRequestId!==undefined||row.acknowledgeUnknown!==undefined))throw denied()
 return row as TaskRunSourceFollowupCommand
}
export function readTaskRunSourceFollowupCandidate(value:unknown):TaskRunSourceFollowupCandidate{
 const row=taskInput(value,['schema','kind','taskId','expectedTaskVersion','runId','sessionId','disposition','sourceUpdateId','sourceTaskVersion','sourceEventId','reference','originalNativeRequestId','originalInputSha256','originalEvidenceSha256']),unknown=row.kind==='unknown-verification'
 const disposition=unknown?readTaskRunSubmissionDisposition(row.disposition):undefined,reference=businessObjectReference(row.reference)
 if(Object.keys(row).length!==(unknown?14:13)||row.schema!=='teloa.task-run-source-followup-candidate/v1'||!['unknown-verification','result-verification'].includes(String(row.kind))||![row.taskId,row.runId,row.sourceUpdateId,row.sourceEventId,row.originalNativeRequestId].every(uuid)||!sha(row.originalInputSha256)||typeof row.sessionId!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(row.sessionId)||!positive(row.expectedTaskVersion)||!positive(row.sourceTaskVersion)||Number(row.sourceTaskVersion)>=Number(row.expectedTaskVersion)||unknown&&(row.runId!==disposition!.runId||row.sessionId!==disposition!.sessionId||row.originalNativeRequestId!==disposition!.nativeRequestId||row.originalInputSha256!==disposition!.inputSha256||row.originalEvidenceSha256!==null)||!unknown&&(row.disposition!==undefined||!sha(row.originalEvidenceSha256)))throw denied()
 return {...row,...(disposition?{disposition}:{}),reference} as TaskRunSourceFollowupCandidate
}
export function readTaskRunSourceFollowup(value:unknown):TaskRunSourceFollowup{
 const row=taskInput(value,['schema','kind','requestId','taskId','taskVersion','sessionId','originalRunId','disposition','sourceUpdateId','sourceTaskVersion','sourceEventId','reference','instruction','confirmedAt','notice','originalNativeRequestId','originalInputSha256','originalEvidenceSha256']),unknown=row.kind==='unknown-verification'
 if(Object.keys(row).length!==(unknown?18:17)||row.schema!=='teloa.task-run-source-followup/v1'||!uuid(row.requestId)||row.notice!==(unknown?sourceFollowupNotice:resultFollowupNotice)||!instruction(row.instruction)||typeof row.confirmedAt!=='string'||!Number.isFinite(Date.parse(row.confirmedAt))||new Date(row.confirmedAt).toISOString()!==row.confirmedAt)throw denied()
 const candidate=readTaskRunSourceFollowupCandidate({schema:'teloa.task-run-source-followup-candidate/v1',kind:row.kind,taskId:row.taskId,expectedTaskVersion:row.taskVersion,runId:row.originalRunId,sessionId:row.sessionId,...(row.disposition===undefined?{}:{disposition:row.disposition}),sourceUpdateId:row.sourceUpdateId,sourceTaskVersion:row.sourceTaskVersion,sourceEventId:row.sourceEventId,reference:row.reference,originalNativeRequestId:row.originalNativeRequestId,originalInputSha256:row.originalInputSha256,originalEvidenceSha256:row.originalEvidenceSha256})
 if(row.requestId===row.originalRunId||row.requestId===candidate.disposition?.requestId||row.requestId===candidate.originalNativeRequestId)throw denied()
 return {...row,...(candidate.disposition?{disposition:candidate.disposition}:{}),reference:candidate.reference} as TaskRunSourceFollowup
}
