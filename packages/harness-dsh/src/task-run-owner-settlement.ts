import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Context} from '@deepseek-ai/cordis'
import {SessionId} from '@deepseek-ai/dsh-session'
import type {TaskRun,TaskRunOwnerSettlement,TaskRunRuntimeLink} from '@teloa/backend'
import type {TaskRunPorts} from './task-run-driver.ts'
import {observeTaskRunTimeline} from './task-run-observation.ts'

type Options={runtimeId:string;ports:TaskRunPorts;listLinks:()=>Promise<readonly TaskRunRuntimeLink[]>;nativeInput:{hasPendingJobCompletion:(sessionId:string)=>boolean;hasCancelledJobCompletion:(sessionId:string)=>boolean};now:()=>string}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
const terminal=(status:string)=>['completed','killed','failed'].includes(status)

/** 只由原存活宿主核对实际活动；冷宿主的空 jobs 表不能替旧宿主签署无副作用证明。 */
export async function taskRunOwnerSettlement(ctx:Context,run:TaskRun,options:Options):Promise<TaskRunOwnerSettlement|null>{
 const {ports,nativeInput,runtimeId}=options,evidence=run.evidence
 if(run.state!=='ended'||evidence?.state!=='ended'||!ports.backgroundState||!ports.subagentState||!ports.flowState)return null
 try{
  const frame=async()=>{
   const full=await ports.events(run)
   if(full.length<evidence.endSeq+1||full.some((event,index)=>event.seq!==index||!Number.isSafeInteger(event.time)||event.time<0))return null
   const events=full.slice(0,evidence.endSeq+1)
   const owned=new Set<number>(),continuations=await ports.continuations?.(run,events),goal=await ports.goalObservation?.(run,events)
   const observed=observeTaskRunTimeline(events,run.nativeRequestId,continuations,event=>owned.add(event.seq),goal).observation
   if(!isDeepStrictEqual(observed,evidence)||events[evidence.endSeq]?.type!=='turn/end')return null
   if(events.some(event=>event.seq>evidence.messageSeq&&event.type==='user/message'&&event.surfaceOp==='append'&&!owned.has(event.seq)))return null
   // 完成轮不能藏着尚无正式结果的工具调用；工具名称不参与资格判定。
   const calls=new Set<string>(),results=new Set<string>()
   for(const event of events.slice(evidence.messageSeq+1)){
    if(event.type==='tool/call'){
     if(!event.data.callId||calls.has(event.data.callId))return null
     calls.add(event.data.callId)
    }else if(event.type==='tool/result'){
     const id=event.data.message.toolCallId
     if(!id||!calls.has(id))return null
     results.add(id)
    }
   }
   if(calls.size!==results.size)return null
   const background=await ports.backgroundState!(run)
   if(background.outstanding||background.interrupted||background.cancelled||await ports.subagentState!(run,new AbortController().signal)!=='none'||await ports.flowState!(run)!=='none')return null
   const links=await options.listLinks(),owners=links.filter((link):link is Extract<TaskRunRuntimeLink,{kind:'job'}>=>link.kind==='job'&&link.payload.record==='owner')
   const root=owners.filter(link=>link.sessionId===run.sessionId)
   if(root.length!==1||root[0]!.runId!==run.id||root[0]!.payload.runtimeId!==runtimeId||root[0]!.payload.requestId!==run.nativeRequestId||root[0]!.nativeId!==`owner:${runtimeId}:${run.sessionId}`)return null
   for(const link of links){
    if(link.runId!==run.id||link.payload.requestId!==run.nativeRequestId)return null
    if(link.kind==='job'&&(link.payload.runtimeId!==runtimeId||link.payload.record==='job'&&!terminal(link.payload.status)))return null
    if(link.kind==='browser'&&link.payload.status!=='closed'||link.kind==='external'&&!['completed','failed','aborted'].includes(link.payload.status))return null
   }
   // 子会话 owner 也必须仍由本宿主实际可查；持久 child/flow 收口并不代替当前队列读数。
   for(const owner of owners){
    const agent=ctx.agents.get(SessionId(owner.sessionId))
    if(!agent||agent.id!==owner.sessionId||agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length||nativeInput.hasPendingJobCompletion(owner.sessionId)||nativeInput.hasCancelledJobCompletion(owner.sessionId))return null
    if(owner.sessionId===run.sessionId&&(!Number.isSafeInteger(Number(agent.session.inheritedEventCount))||Number(agent.session.inheritedEventCount)>evidence.messageSeq))return null
    const jobs=ctx.jobs.list(SessionId(owner.sessionId)).filter(job=>job.owner===owner.sessionId)
    if(jobs.some(job=>!terminal(job.status)||!links.some(link=>link.kind==='job'&&link.payload.record==='job'&&link.sessionId===owner.sessionId&&link.payload.runtimeId===runtimeId&&link.payload.jobId===job.id&&link.payload.status===job.status)))return null
   }
   return {events,links,nativeId:root[0]!.nativeId,fullSha256:sha(JSON.stringify(full))}
  }
  const before=await frame();if(!before)return null
  const after=await frame();if(!after||!isDeepStrictEqual(before,after))return null
  return {schema:'teloa.task-run-owner-settlement/v1',runId:run.id,nativeId:after.nativeId,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,inputSha256:sha(run.inputText),evidence:{...evidence},prefixLength:evidence.endSeq+1,prefixSha256:sha(JSON.stringify(after.events)),observedAt:options.now()}
 }catch{return null}
}
