import type {Context} from '@deepseek-ai/cordis'
import type {SessionEvent,SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import type {TaskRun} from '@teloa/backend'
import {readModelRecovery,readModelReference,readTaskRunModelStatus,sameModelRoute,type ModelRecovery,type TaskRunModelStatus} from '@teloa/contract'
import {observeTaskRunTimeline} from './task-run-observation.ts'
import {readSessionEvents} from './session-events.ts'
import {taskModelRecoverySource} from './task-model-dsh.ts'
import type {TaskRunPorts} from './task-run-driver.ts'

/** DSH 0.1.7-rc.1 的 request/header 是实际请求选路；按同一任务轮次判据截断后续聊天。 */
export function projectTaskRunModelStatus(run:Pick<TaskRun,'id'|'nativeRequestId'|'modelPolicy'>,events:readonly SessionEvent[],continuations?:ReadonlySet<string>):TaskRunModelStatus{
 if(!run.modelPolicy)throw Error('missing-model-policy')
 let latest:Extract<TaskRunModelStatus,{state:'observed'}>|undefined
 const recoveries=events.flatMap(event=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind===taskModelRecoverySource&&event.data.source.runId===run.id?[{seq:event.seq,recovery:readModelRecovery(event.data.source.recovery)}]:[])
 if(recoveries.length>1)throw Error('duplicate-model-recovery')
 observeTaskRunTimeline(events,run.nativeRequestId,continuations,event=>{
  if(event.type!=='request/header')return
  const config=event.data.header.config,model=readModelReference({provider:config.provider,model:config.model,...(config.reasoningEffort===undefined?{}:{reasoningEffort:config.reasoningEffort})})
  const notice=recoveries[0]
  let recovery:ModelRecovery|undefined
  if(notice&&notice.seq<event.seq){
   // 一旦切换，不能把损坏/回退的请求头当作正常首选请求展示。
   if(!sameModelRoute(model,notice.recovery.to))throw Error('inconsistent-model-recovery')
   recovery=notice.recovery
  }
  latest=readTaskRunModelStatus({state:'observed',model,requestSeq:event.seq,...(recovery?{recovery}:{})},run.modelPolicy!) as typeof latest
 })
 return latest??{state:'unobserved'}
}

/** 调用方先通过 RunService 核对 owner；只读日志，绝不 resolveAgent 或续跑任务。 */
export function createTaskRunModelReader(ctx:Context,continuations?:TaskRunPorts['continuations']){
 return {read:async(run:TaskRun):Promise<TaskRunModelStatus|undefined>=>{
  if(!run.modelPolicy)return undefined
  try{
   const id=run.sessionId as SessionId,sessions=Reflect.get(ctx,'sessions') as unknown as SessionStore,live=sessions.get(id)
   let events:readonly SessionEvent[]
   if(live)events=readSessionEvents(live)
   else{
    const handle=await ctx.sessionPersistence.open(id,'read')
    try{events=(await handle.read()).events}finally{await handle.close()}
   }
   return projectTaskRunModelStatus(run,events,await continuations?.(run,events))
  }catch{return {state:'unavailable'}}
 }}
}
