import {randomUUID} from 'node:crypto'
import {PlanService,MarketContentStore,PlanOccurrenceService,PlanSchedulerStatusService,ObjectConversationService,type ConversationService,type PlanOccurrence,type TaskRun,type TaskRunService} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {PlanCoordinator} from './plan-coordinator.ts'
import {PlanDshDispatcher} from './plan-dispatch-dsh.ts'
import {TaskRunDriver,type TaskRunPorts} from './task-run-driver.ts'
import {createTaskRunHandler,type TaskKnowledgeLoader} from './task-runs.ts'

export type PlanRuntimeDependencies={
 owner:string
 getPool:()=>Promise<TaskRunService['pool']>
 conversations:Pick<ConversationService,'createRun'|'runReservation'|'failRunReservation'|'bySession'>
 /** 调用方保留工具授权策略，并将 planContext 配置为 runtime.executionContext。 */
 getRunService:()=>Promise<TaskRunService>
 runPorts:TaskRunPorts
 loadTaskKnowledge?:TaskKnowledgeLoader
 deliverNotifications?:(owner:string,signal:AbortSignal)=>Promise<unknown>
 reportNotification?:(code:string)=>void
}

/** 只组装真实服务；数据库初始化、启动调度和卸载生命周期都由宿主负责。 */
export function createPlanRuntime(dependencies:PlanRuntimeDependencies,options:{pageSize?:number}={}){
 const {owner,getPool,conversations,getRunService,runPorts,loadTaskKnowledge}=dependencies
 const now=()=>new Date().toISOString(),identity={id:randomUUID,now}
 const actor=(value:string)=>{if(value!==owner)throw new WorkError('teloa/forbidden','计划运行时只能访问固定宿主本人。')}
 const services=async(signal?:AbortSignal)=>{
  signal?.throwIfAborted();const pool=await getPool();signal?.throwIfAborted()
  const market=new MarketContentStore(pool,identity)
  return {pool,plans:new PlanService(pool,identity,market),occurrences:new PlanOccurrenceService(pool,identity,market)}
 }
 const dispatchExecution=async(value:string,job:Parameters<PlanDshDispatcher['dispatch']>[1],signal:AbortSignal)=>{
   actor(value);signal.throwIfAborted()
   const runService=await getRunService();signal.throwIfAborted()
   const links=new ObjectConversationService((await services(signal)).pool,(actor,id)=>conversations.bySession(actor,id),now)
   const prepare=createTaskRunHandler(owner,async()=>runService,runPorts,loadTaskKnowledge,{conversations,links})
   const dispatcher=new PlanDshDispatcher({
    prepare:async(actorId,input,currentSignal)=>{
     actor(actorId);currentSignal.throwIfAborted()
     return await prepare('task-runs/prepare',input,currentSignal) as TaskRun
    },
    driver:new TaskRunDriver(runService,runPorts),
   })
   return dispatcher.dispatch(owner,job,signal)
  }
 const coordinator=new PlanCoordinator(owner,{
  plans:{schedulerPlans:async(value,input)=>{actor(value);return (await services()).plans.schedulerPlans(owner,input)}},
  occurrences:{
   recover:async(value,input)=>{actor(value);return (await services()).occurrences.recover(owner,input)},
   recoveryPending:async(value,input)=>{actor(value);return (await services()).occurrences.recoveryPending(owner,input)},
   dispatchTask:async(value,input)=>{actor(value);return (await services()).occurrences.dispatchTask(owner,input)},
   claim:async(value,input)=>{actor(value);return (await services()).occurrences.claim(owner,input)},
   pendingExecutions:async(value,input)=>{actor(value);return (await services()).occurrences.pendingExecutions(owner,input)},
  },
  dispatcher:{dispatch:dispatchExecution},
 report:async(value,report,signal)=>{
   actor(value);const {pool}=await services(signal)
   // 同一周期统一使用报告时间，避免步骤耗时让较晚成功覆盖较早失败。
   const status=new PlanSchedulerStatusService(pool,{now:()=>report.now})
   if(report.outcome==='skipped'){
    if(report.code==='teloa/task-ended')return status.acknowledge(owner,{claimId:report.claimId,taskId:report.taskId,reason:'task-ended'})
    return
   }
   return status.record(owner,{...(report.planId?{planId:report.planId}:{}),outcome:report.outcome,...(report.outcome==='failed'?{code:report.code}:{})})
  },
  notifications:{
   deliver:async(value,signal)=>{actor(value);return dependencies.deliverNotifications?.(owner,signal)},
   report:code=>dependencies.reportNotification?.(code),
  },
 },options)
 const overview=async(input:unknown)=>(await services()).occurrences.overview(owner,input)
 const executionHistory=async(input:unknown)=>(await services()).occurrences.executionHistory(owner,input)
 const status=async(input:unknown)=>new PlanSchedulerStatusService(await getPool(),{now}).get(owner,input)
 const executionContext=async(db:Parameters<PlanOccurrenceService['executionContext']>[0],value:string,taskId:string)=>{
  actor(value);return (await services()).occurrences.executionContext(db,owner,taskId)
 }
 const dispatchOccurrence=async(occurrence:PlanOccurrence,signal:AbortSignal)=>{
  actor(occurrence.ownerId);signal.throwIfAborted()
  const runtime=await services(signal)
  const dispatched=await runtime.occurrences.dispatchTask(owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now:now()})
  signal.throwIfAborted()
  const run=await dispatchExecution(owner,{claimId:occurrence.id,taskId:dispatched.task.id,taskCreatedVersion:1,taskTitle:occurrence.fields.title,roleId:occurrence.fields.roleId,roleVersion:occurrence.roleVersion},signal)
  return {occurrence,task:dispatched.task,run:run.run}
 }
 const trigger=async(input:unknown,signal:AbortSignal)=>{
  signal.throwIfAborted()
  const runtime=await services(signal),claimed=await runtime.occurrences.trigger(owner,input)
  signal.throwIfAborted()
  const nowValue=input&&typeof input==='object'&&'now' in input?(input as {now?:unknown}).now:undefined
  if(typeof nowValue!=='string')throw new WorkError('teloa/invalid-input','立即运行请求缺少固定时间。')
  const dispatched=await runtime.occurrences.dispatchTask(owner,{claimId:claimed.occurrence.id,taskRequestId:claimed.occurrence.taskRequestId,now:nowValue})
  const run=await dispatchExecution(owner,{claimId:claimed.occurrence.id,taskId:dispatched.task.id,taskCreatedVersion:1,taskTitle:claimed.occurrence.fields.title,roleId:claimed.occurrence.fields.roleId,roleVersion:claimed.occurrence.roleVersion},signal)
  return {occurrence:claimed.occurrence,task:dispatched.task,run:run.run}
 }
 return {coordinator,overview,status,executionHistory,executionContext,trigger,dispatchOccurrence,readPorts:{
  overview:async(value:string,input:unknown)=>{actor(value);return overview(input)},
  status:async(value:string,input:unknown)=>{actor(value);return status(input)},
  executionHistory:async(value:string,input:unknown)=>{actor(value);return executionHistory(input)},
  skipHistory:async(value:string,input:unknown)=>{actor(value);return (await services()).occurrences.skipHistory(owner,input)},
 }}
}
