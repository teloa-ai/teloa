import {WorkError} from '@teloa/contract'
import type {PlanDshDispatchJob} from './plan-dispatch-dsh.ts'

type Plan={id:string;state:'active'|'paused'|'archived'}
type Occurrence={id:string;planId:string;taskRequestId:string}
type Cursor={claimedAt:string;claimId:string}
type Execution={planId?:string;job:PlanDshDispatchJob;action:'prepare'|'start'|'reconcile'|'skip';run?:{id:string}|null;reason?:'task-ended'}
export type PlanCoordinatorReport={phase:'baseline'|'pending'|'claim'|'execute'|'skip'|'cycle';planId?:string;claimId?:string;taskId?:string;now:string;outcome:'failed'|'skipped'|'success';code?:string}
export type PlanCoordinatorPorts={
 plans:{schedulerPlans:(owner:string,input:{limit:number;cursor?:{id:string}})=>Promise<{items:Plan[];errors?:{planId:string;code:'teloa/storage-corrupt'}[];cursor?:{id:string}}>}
 occurrences:{
  recover:(owner:string,input:{planId:string;now:string})=>Promise<unknown>
  recoveryPending:(owner:string,input:{limit:number;cursor?:Cursor})=>Promise<{items:Occurrence[];errors?:{claimId:string;planId?:string;code:'teloa/storage-corrupt'}[];cursor?:Cursor}>
  dispatchTask:(owner:string,input:{claimId:string;taskRequestId:string;now:string})=>Promise<unknown>
  claim:(owner:string,input:{planId:string;now:string})=>Promise<{occurrence:Occurrence|null;dispatch:boolean;skip?:{reason:string}}>
  pendingExecutions:(owner:string,input:{limit:number;cursor?:Cursor})=>Promise<{items:Execution[];errors?:{claimId:string;planId?:string;code:'teloa/storage-corrupt'}[];cursor?:Cursor}>
 }
 dispatcher:{dispatch:(owner:string,job:PlanDshDispatchJob,signal:AbortSignal)=>Promise<unknown>}
 notifications:{deliver:(owner:string,signal:AbortSignal)=>Promise<unknown>;report:(code:string)=>void}
 report:(owner:string,report:PlanCoordinatorReport,signal:AbortSignal)=>Promise<unknown>
}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const corrupt=()=>new WorkError('teloa/storage-corrupt','持续计划协调端口返回的身份或分页依据损坏。')
const code=(error:unknown)=>error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^teloa\/[a-z-]+$/.test(error.code)?error.code:'teloa/plan-coordinator-unavailable'
function timestamp(value:string):number{
 const time=Date.parse(value)
 if(!Number.isFinite(time)||new Date(time).toISOString()!==value)throw new WorkError('teloa/invalid-input','调度时间需要有效的 UTC 时间。')
 return time
}
type Context=Pick<PlanCoordinatorReport,'phase'|'planId'|'claimId'|'taskId'>

/** 仅提供装配端口，不创建定时器或启用宿主。一次协调只用固定 owner 和领取请求身份。 */
export class PlanCoordinator{
 readonly owner:string
 readonly ports:PlanCoordinatorPorts
 readonly pageSize:number
 private initialized=false
 private busy=false
 private readonly needsBaseline=new Set<string>()
 constructor(owner:string,ports:PlanCoordinatorPorts,options:{pageSize?:number}={}){
  if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的宿主本人身份。')
  const pageSize=options.pageSize??50
  if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw new WorkError('teloa/invalid-input','调度分页大小无效。')
  this.owner=owner;this.ports=ports;this.pageSize=pageSize
 }
 recover(now:string,signal:AbortSignal):Promise<void>{return this.run(now,signal,true)}
 tick(now:string,signal:AbortSignal):Promise<void>{return this.run(now,signal,false)}
 private async run(now:string,signal:AbortSignal,startup:boolean):Promise<void>{
  signal.throwIfAborted();timestamp(now)
  if(this.busy)throw new WorkError('teloa/conflict','计划协调周期不能重叠。')
  this.busy=true
  const reportErrors:unknown[]=[],seenClaims=new Set<string>(),seenRuns=new Set<string>(),planOutcomes=new Map<string,{outcome:'success'|'failed';code?:string}>()
  let failureCode:string|undefined
  const invoke=async<T>(work:()=>Promise<T>):Promise<T>=>{signal.throwIfAborted();const value=await work();signal.throwIfAborted();return value}
  const publish=async(context:Context,outcome:PlanCoordinatorReport['outcome'],errorCode?:string)=>{
   if(context.planId&&outcome!=='skipped'){
    const prior=planOutcomes.get(context.planId)
    if(prior?.outcome==='failed'&&outcome==='success')return
    planOutcomes.set(context.planId,{outcome,...(errorCode?{code:errorCode}:{})})
   }
   try{await invoke(()=>this.ports.report(this.owner,{...context,now,outcome,...(errorCode?{code:errorCode}:{})},signal))}
   catch(error){signal.throwIfAborted();reportErrors.push(error);failureCode??='teloa/plan-status-unavailable'}
  }
  const attempt=async<T>(context:Context,work:()=>Promise<T>,success=true):Promise<{ok:true;value:T}|{ok:false}>=>{
   try{const value=await invoke(work);if(success)await publish(context,'success');return {ok:true,value}}
   catch(error){signal.throwIfAborted();const errorCode=code(error);failureCode??=errorCode;await publish(context,'failed',errorCode);return {ok:false}}
  }
  const dispatch=async(occurrence:Occurrence)=>{
   const context:Context={phase:'pending',planId:occurrence.planId,claimId:occurrence.id}
   return attempt(context,async()=>{
    if(!uuid(occurrence.id)||!uuid(occurrence.planId)||!uuid(occurrence.taskRequestId))throw corrupt()
    return this.ports.occurrences.dispatchTask(this.owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now})
   })
  }
  const executions=async()=>{
   let cursor:Cursor|undefined
   while(true){
    const result=await attempt({phase:'execute'},async()=>{
     const page=await this.ports.occurrences.pendingExecutions(this.owner,{limit:this.pageSize,...(cursor?{cursor}:{})})
     if(!Array.isArray(page.items)||page.items.length>this.pageSize)throw corrupt()
     if(page.errors!==undefined&&(!Array.isArray(page.errors)||page.errors.some(error=>!uuid(error.claimId)||error.code!=='teloa/storage-corrupt')))throw corrupt()
     if(page.cursor){
      if(!uuid(page.cursor.claimId))throw corrupt()
      const nextTime=timestamp(page.cursor.claimedAt),oldTime=cursor?timestamp(cursor.claimedAt):undefined
      if(oldTime!==undefined&&(nextTime<oldTime||nextTime===oldTime&&page.cursor.claimId<=cursor!.claimId))throw corrupt()
     }
     return page
    },false)
    if(!result.ok)return
    for(const error of result.value.errors??[]){
     if(seenClaims.has(error.claimId))continue
     seenClaims.add(error.claimId)
     await attempt({phase:'execute',claimId:error.claimId,...(error.planId?{planId:error.planId}:{})},async()=>{throw corrupt()})
    }
    for(const entry of result.value.items){
     const context:Context={phase:entry.action==='skip'?'skip':'execute',claimId:entry.job.claimId,taskId:entry.job.taskId,...(entry.planId?{planId:entry.planId}:{})}
     if(seenClaims.has(entry.job.claimId)||entry.run&&seenRuns.has(entry.run.id))continue
     seenClaims.add(entry.job.claimId);if(entry.run)seenRuns.add(entry.run.id)
     if(entry.action==='skip'){
      if(entry.reason==='task-ended')await publish(context,'skipped','teloa/task-ended')
      else await attempt(context,async()=>{throw corrupt()})
     }else await attempt(context,async()=>{
      if(!['prepare','start','reconcile'].includes(entry.action))throw corrupt()
      return this.ports.dispatcher.dispatch(this.owner,entry.job,signal)
     })
    }
    if(!result.value.cursor)return
    cursor=result.value.cursor
   }
  }
  try{
   const active:Plan[]=[]
   let plansCursor:{id:string}|undefined,plansComplete=true
   while(true){
    const result=await attempt({phase:'cycle'},async()=>{
     const page=await this.ports.plans.schedulerPlans(this.owner,{limit:this.pageSize,...(plansCursor?{cursor:plansCursor}:{})})
     if(!Array.isArray(page.items)||page.items.length>this.pageSize||page.cursor&&(!uuid(page.cursor.id)||plansCursor&&page.cursor.id<=plansCursor.id))throw corrupt()
     return page
    },false)
    if(!result.ok){plansComplete=false;break}
    for(const error of result.value.errors??[])await attempt({phase:'cycle',planId:error.planId},async()=>{throw corrupt()})
    active.push(...result.value.items.filter(plan=>plan.state==='active'))
    if(!result.value.cursor)break
    plansCursor=result.value.cursor
   }
   // 宿主心跳明确检测中断后调用 recover；正常异步处理耗时不能据此丢弃到期时点。
   const reset=startup||!this.initialized
   {
    if(plansComplete)for(const id of this.needsBaseline)if(!active.some(plan=>plan.id===id))this.needsBaseline.delete(id)
    if(reset)for(const plan of active)this.needsBaseline.add(plan.id)
    for(const plan of active)if(this.needsBaseline.has(plan.id)){
     const result=await attempt({phase:'baseline',planId:plan.id},()=>this.ports.occurrences.recover(this.owner,{planId:plan.id,now}))
     if(result.ok)this.needsBaseline.delete(plan.id)
    }
    if(plansComplete)this.initialized=true
   }
   let pendingCursor:Cursor|undefined
   while(true){
    const pending=await attempt({phase:'pending'},async()=>{
     const page=await this.ports.occurrences.recoveryPending(this.owner,{limit:this.pageSize,...(pendingCursor?{cursor:pendingCursor}:{})})
     if(!Array.isArray(page.items)||page.items.length>this.pageSize)throw corrupt()
     if(page.cursor&&(!uuid(page.cursor.claimId)||pendingCursor&&(timestamp(page.cursor.claimedAt)<timestamp(pendingCursor.claimedAt)||page.cursor.claimedAt===pendingCursor.claimedAt&&page.cursor.claimId<=pendingCursor.claimId)))throw corrupt()
     return page
    },false)
    if(!pending.ok)break
    for(const error of pending.value.errors??[])await attempt({phase:'pending',claimId:error.claimId,...(error.planId?{planId:error.planId}:{})},async()=>{throw corrupt()})
    for(const occurrence of pending.value.items)if(!this.needsBaseline.has(occurrence.planId))await dispatch(occurrence)
    if(!pending.value.cursor)break
    pendingCursor=pending.value.cursor
   }
   await executions()
   if(!startup){
    let claimed=false
    for(const plan of active){
     if(this.needsBaseline.has(plan.id))continue
     const result=await attempt({phase:'claim',planId:plan.id},()=>this.ports.occurrences.claim(this.owner,{planId:plan.id,now}))
     if(!result.ok)continue
     if(result.value.skip)await publish({phase:'skip',planId:plan.id},'skipped',result.value.skip.reason==='previous-pending'?'teloa/plan-pending-overlap':'teloa/plan-task-overlap')
     if(result.value.dispatch&&result.value.occurrence){await dispatch(result.value.occurrence);claimed=true}
    }
    // 前一遍已处理（含失败）的 claim/run 本轮不再调用，避免刚提交后重复 reconcile。
    if(claimed)await executions()
   }
   // 最后按计划汇总，防止后续未到期/重叠检查成功掩盖本周期已有失败。
   for(const [planId,result] of planOutcomes)await publish({phase:'cycle',planId},result.outcome,result.code)
   await publish({phase:'cycle'},failureCode?'failed':'success',failureCode)
   try{await invoke(()=>this.ports.notifications.deliver(this.owner,signal))}
   catch(error){signal.throwIfAborted();try{this.ports.notifications.report('teloa/notification-unavailable')}catch{}}
   if(reportErrors.length)throw reportErrors[0]
  }finally{this.busy=false}
 }
}
