import {WorkError} from '@teloa/contract'
import type {TaskRun} from '@teloa/backend'
import type {TaskRunDriver} from './task-run-driver.ts'

export type PlanDshDispatchJob={claimId:string;taskId:string;taskCreatedVersion:1;taskTitle:string;roleId:string;roleVersion:number}
export type PlanDshPrepareInput={requestId:string;taskId:string;expectedTaskVersion:number}
export type PlanDshDispatchPorts={
 /** 必须复用 task-runs/prepare 的受信任一键编排，不接受客户端或计划侧上传岗位配置。 */
 prepare:(owner:string,input:PlanDshPrepareInput,signal:AbortSignal)=>Promise<TaskRun>
 driver:Pick<TaskRunDriver,'start'|'reconcile'>
}
export type PlanDshDispatchResult={run:TaskRun}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const session=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const corrupt=()=>new WorkError('teloa/storage-corrupt','持续计划执行身份或固定版本不一致，已停止派发。')

function jobInput(owner:string,value:PlanDshDispatchJob):PlanDshDispatchJob{
 if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的宿主本人身份。')
 if(!value||Object.keys(value).some(key=>!['claimId','taskId','taskCreatedVersion','taskTitle','roleId','roleVersion'].includes(key))||!uuid(value.claimId)||!uuid(value.taskId)||value.taskCreatedVersion!==1||typeof value.taskTitle!=='string'||!value.taskTitle.trim()||value.taskTitle.length>120||!uuid(value.roleId)||!positive(value.roleVersion))throw corrupt()
 return {...value,taskTitle:value.taskTitle.trim()}
}

function runResult(value:TaskRun,job:PlanDshDispatchJob,runId?:string):TaskRun{
 if(!value||typeof value!=='object'||!uuid(value.id)||runId!==undefined&&value.id!==runId||value.taskId!==job.taskId||value.roleId!==job.roleId||value.taskVersion!==job.taskCreatedVersion||value.roleVersion!==job.roleVersion||!session(value.sessionId)||!uuid(value.nativeRequestId)||!['prepared','submitting','accepted','active','ended','withdrawn','configuration_failed'].includes(value.state))throw corrupt()
 return value
}

/** 固定 claim 作为 prepare requestId；会话预约、preset、关联和 Run 由同一可信编排完成。 */
export class PlanDshDispatcher{
 readonly ports:PlanDshDispatchPorts
 constructor(ports:PlanDshDispatchPorts){this.ports=ports}
 async dispatch(owner:string,input:PlanDshDispatchJob,signal:AbortSignal):Promise<PlanDshDispatchResult>{
  const job=jobInput(owner,input);signal.throwIfAborted()
  let run=runResult(await this.ports.prepare(owner,{requestId:job.claimId,taskId:job.taskId,expectedTaskVersion:job.taskCreatedVersion},signal),job)
  signal.throwIfAborted()
  if(run.state==='configuration_failed')throw new WorkError('teloa/run-configuration-failed','持续计划的运行配置不可用，请核对员工预设。')
  if(run.state==='prepared'){
   const runId=run.id;run=runResult(await this.ports.driver.start(owner,{runId},signal),job,runId)
   if(run.state==='prepared')throw corrupt()
  }
  if(['submitting','accepted','active'].includes(run.state)){
   signal.throwIfAborted();const runId=run.id;run=runResult(await this.ports.driver.reconcile(owner,{runId}),job,runId)
  }
  if(run.state==='submitting')throw new WorkError('teloa/execution-pending','执行提交结果仍待原生日志确认；不会重复发送。')
  if(run.state==='configuration_failed')throw new WorkError('teloa/run-configuration-failed','持续计划的运行配置不可用，请核对员工预设。')
  return {run}
 }
}
