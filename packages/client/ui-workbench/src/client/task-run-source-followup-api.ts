import {readTaskRunSourceFollowupCandidate,readTaskRunSourceFollowupCommand,type TaskRunSourceFollowupCandidate,type TaskRunSourceFollowupCommand,type TaskRunSubmissionDisposition} from '@teloa/contract'
import type {RunView} from './task-run-api.js'
import type {TaskRequestJournal} from './task-api.js'

type Pending={candidate:TaskRunSourceFollowupCandidate;command:TaskRunSourceFollowupCommand}
/** 契约已解析为固定平面记录；忽略JSON成员排列，字段及值仍须全部严格一致。 */
function sameDisposition(left:TaskRunSubmissionDisposition|undefined,right:TaskRunSubmissionDisposition|undefined):boolean{
 return left===undefined?right===undefined:right!==undefined&&Object.keys(left).length===Object.keys(right).length&&(Object.keys(left) as Array<keyof TaskRunSubmissionDisposition>).every(key=>left[key]===right[key])
}
export function createSourceFollowupApi(call:(method:string,payload:unknown)=>Promise<unknown>,read:(value:unknown)=>RunView,journal?:TaskRequestJournal,draftJournal?:TaskRequestJournal){
 let pending:Pending|undefined,error:Error|undefined,busy=false,drafts:Record<string,string>={}
 try{const raw=journal?.read();if(raw){if(raw.length>20000)throw Error();const value=JSON.parse(raw);if(Object.keys(value).sort().join(',')!=='candidate,command')throw Error();pending={candidate:readTaskRunSourceFollowupCandidate(value.candidate),command:readTaskRunSourceFollowupCommand(value.command)};if(pending.candidate.runId!==pending.command.runId||pending.candidate.sourceUpdateId!==pending.command.sourceUpdateId||pending.candidate.expectedTaskVersion!==pending.command.expectedTaskVersion||pending.candidate.disposition?.requestId!==pending.command.dispositionRequestId||pending.candidate.kind!==pending.command.kind)throw Error()}}catch{error=Error('上次后续核验确认记录不可读，请先核对原任务。')}
 try{const raw=draftJournal?.read();if(raw){const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value)||Object.values(value).some(text=>typeof text!=='string'||text.length>8000))throw Error();drafts=value}}catch{error=Error('后续核验草稿不可读，请先核对恢复记录。')}
 const key=(taskId:string,runId:string)=>JSON.stringify([taskId,runId])
 const send=async()=>{
  if(error)throw error;if(!pending||busy)throw Error('请先核对当前后续核验请求。')
  busy=true
  try{
   journal?.write(JSON.stringify(pending))
   const run=read(await call('task-runs/source-followup/prepare',pending.command)),f=run.sourceFollowup,c=pending.candidate
   if(!f||run.id===c.runId||run.taskId!==c.taskId||run.taskVersion!==c.expectedTaskVersion||run.sessionId!==c.sessionId||run.nativeRequestId===c.originalNativeRequestId||f.originalInputSha256!==c.originalInputSha256||f.originalEvidenceSha256!==c.originalEvidenceSha256||f.originalStopRequestedAt!==c.originalStopRequestedAt||f.originalNativeRequestId!==c.originalNativeRequestId||f.sourceEventId!==c.sourceEventId||f.sourceTaskVersion!==c.sourceTaskVersion||f.kind!==c.kind||f.requestId!==pending.command.requestId||f.originalRunId!==c.runId||f.instruction!==pending.command.instruction||f.sourceUpdateId!==c.sourceUpdateId||!sameDisposition(f.disposition,c.disposition)||JSON.stringify(f.reference)!==JSON.stringify(c.reference))throw Error('后续核验回执与原确认不一致，请核对原任务。')
   delete drafts[key(c.taskId,c.runId)];draftJournal?.write(JSON.stringify(drafts));journal?.clear();pending=undefined;return run
  }catch(cause){if(cause&&typeof cause==='object'&&Reflect.get(cause,'rejected')===true&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(String(Reflect.get(cause,'code')))){journal?.clear();pending=undefined}throw cause}
  finally{busy=false}
 }
 return {
  pending:()=>pending?structuredClone(pending):undefined,
  recoveryError:()=>error,
  draft:(taskId:string,runId:string)=>drafts[key(taskId,runId)]??'',
  saveDraft(taskId:string,runId:string,text:string){if(text.length>8000)throw Error('核验要求不能超过8000字符。');drafts[key(taskId,runId)]=text;draftJournal?.write(JSON.stringify(drafts))},
  async get(run:RunView){const candidate=readTaskRunSourceFollowupCandidate(await call('task-runs/source-followup/get',{runId:run.id}));if(candidate.runId!==run.id||candidate.taskId!==run.taskId||candidate.sessionId!==run.sessionId||candidate.originalNativeRequestId!==run.nativeRequestId||candidate.kind!==(run.state==='submission_unknown'?'unknown-verification':run.reason==='error'&&run.stopRequestedAt!==null?'stopped-continuation':run.reason==='error'||run.state==='withdrawn'&&run.submissionRecovery==='not-published'?'error-recovery':'result-verification')||candidate.originalStopRequestedAt!==(run.reason==='error'&&run.stopRequestedAt!==null?run.stopRequestedAt:undefined)||!sameDisposition(candidate.disposition,run.submissionDisposition))throw Error('原未知提交已变化，请刷新核对。');return candidate},
  async prepare(candidate:TaskRunSourceFollowupCandidate,instruction:string){if(error)throw error;if(pending||busy)throw Error('请先核对上次后续核验准备。');pending={candidate:readTaskRunSourceFollowupCandidate(candidate),command:readTaskRunSourceFollowupCommand({kind:candidate.kind,requestId:crypto.randomUUID(),runId:candidate.runId,expectedTaskVersion:candidate.expectedTaskVersion,...(candidate.kind==='unknown-verification'?{dispositionRequestId:candidate.disposition!.requestId,acknowledgeUnknown:true}:{}),sourceUpdateId:candidate.sourceUpdateId,instruction:instruction.trim()})};return send()},
  recover:send,
 }
}
