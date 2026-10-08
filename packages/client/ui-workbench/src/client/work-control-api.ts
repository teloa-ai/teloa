import {readWorkControl,readRecoveryCandidate,type WorkControl} from '@teloa/contract'
import {workObject,workUuid} from '@teloa/contract'
import {readWorkProgress} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'
import {createWorkBudgetApi} from './work-budget-api.ts'
type Journal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
type Command={requestId:string;controlId:string;expectedVersion:number}&({kind:'change';action:'pause'|'stop';scope:'round'|'definition';roundControlId:string|null}|{kind:'resume';candidateRunIds:string[]})
const read=(value:unknown):Command=>{if(!value||typeof value!=='object'||!('kind'in value))throw Error('控制恢复记录损坏。');const v=workObject(value,value.kind==='change'?['kind','requestId','controlId','expectedVersion','action','scope','roundControlId']:['kind','requestId','controlId','expectedVersion','candidateRunIds']);if(!workUuid(v.requestId)||!workUuid(v.controlId)||!Number.isSafeInteger(v.expectedVersion)||Number(v.expectedVersion)<1)throw Error('控制版本不正确。');if(v.kind==='change'){if(!['pause','stop'].includes(String(v.action))||!['round','definition'].includes(String(v.scope))||v.roundControlId!==null&&!workUuid(v.roundControlId))throw Error('控制操作不正确。')}else if(v.kind!=='resume'||!Array.isArray(v.candidateRunIds)||!v.candidateRunIds.every(workUuid)||new Set(v.candidateRunIds).size!==v.candidateRunIds.length)throw Error('恢复候选不正确。');return v as Command}
export function createWorkControlApi(call:(endpoint:string,payload:unknown)=>Promise<unknown>,journal?:Journal,id=()=>crypto.randomUUID(),budgetJournal?:Journal){
 let pending:Command|undefined,error:Error|undefined,busy=false
 try{const raw=journal?.read();if(raw){const v=workObject(JSON.parse(raw),['schema','request']);if(v.schema!=='teloa.work-control-command/v1')throw Error();pending=read(v.request)}}catch{error=recoveryStorageError()}
 const clear=()=>{journal?.clear();pending=undefined}
 const send=async()=>{if(error)throw error;if(!pending||busy)throw Error('没有可核对的控制请求。');busy=true;const command=pending
  try{journal?.write(JSON.stringify({schema:'teloa.work-control-command/v1',request:command}));const {kind,...request}=command;const result=readWorkControl(await call(kind==='resume'?'work-recovery/resume':'work-controls/change',request));if(result.id!==command.controlId||result.version<=command.expectedVersion)throw Error('控制回执与原请求不一致。');clear();return result}catch(cause){if(cause&&typeof cause==='object'&&'rejected'in cause&&cause.rejected===true)clear();throw cause}finally{busy=false}}
 const prepare=(value:Command)=>{const next=read(value);if(pending&&JSON.stringify(pending)!==JSON.stringify(next))throw Error('请先核对原控制请求。');pending??=next;return send()}
 return {
  budgets:createWorkBudgetApi(call,budgetJournal,id),
  pending:()=>pending?structuredClone(pending):undefined,recoveryMessage:()=>error,recover:send,
  discard(){clear();error=undefined},
  async get(controlId:string){const value=readWorkControl(await call('work-controls/get',{controlId}));if(value.id!==controlId)throw Error('控制详情与当前工作不一致。');return value},
  async inspect(controlId:string){const raw=await call('work-recovery/inspect',{controlId});if(!Array.isArray(raw))throw Error('恢复候选格式不正确。');const rows=raw.map(readRecoveryCandidate);if(rows.some(r=>r.controlId!==controlId)||new Set(rows.map(r=>r.runId)).size!==rows.length)throw Error('恢复候选不属于当前工作。');return rows},
  change:(control:WorkControl,action:'pause'|'stop',scope:WorkControl['scope']=control.scope,roundControlId:string|null=null)=>prepare({kind:'change',requestId:pending?.kind==='change'?pending.requestId:id(),controlId:control.id,expectedVersion:control.version,action,scope,roundControlId}),
  resume:(control:WorkControl,candidateRunIds:string[])=>prepare({kind:'resume',requestId:pending?.kind==='resume'?pending.requestId:id(),controlId:control.id,expectedVersion:control.version,candidateRunIds}),
  async progress(rootTaskId:string){const raw=await call('work-progress/get',{rootTaskId});if(raw===null)return null;const result=readWorkProgress(raw);if(result.rootTaskId!==rootTaskId)throw Error('进展不属于当前工作。');return result},
 }
}
export type WorkControlApi=ReturnType<typeof createWorkControlApi>
