import {verifiedAcceptedInboxError} from './task-run-inbox-error.ts'
import {isDeepStrictEqual} from 'node:util'
import type {Context} from '@deepseek-ai/cordis'
import {Session,SessionId,SessionLogOffset,type SessionEvent} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {TaskRun} from '@teloa/backend'
import {WorkError,type GoalObservationContext} from '@teloa/contract'
import {observeTaskRun,isTaskRunReconcileEndReason} from './task-run-observation.ts'
import {taskInputWithoutMemory} from './task-memory-input.ts'

type GoalReader=(events:readonly SessionEvent[])=>Promise<GoalObservationContext|undefined>

async function readColdTaskRunSession(ctx:Context,run:TaskRun,goal:GoalReader|undefined,allowActive:boolean){
 const unavailable=()=>new WorkError('teloa/session-unavailable','执行负责人会话暂不可用。')
 const active=allowActive&&run.state==='active'&&run.evidence?.state==='active'?run.evidence:undefined
 if((!active&&(run.state!=='ended'||run.evidence?.state!=='ended'))||run.stopRequestedAt!=null&&!(run.evidence?.state==='ended'&&run.evidence.inputAnchor))throw unavailable()
 const fixed=await ctx.sessionController.inspect(SessionId(run.sessionId)),meta=fixed.meta
 if(meta.id!==run.sessionId||meta.parentSession!==undefined||meta.origin==='subagent'||meta.isSeeded||fixed.inheritedEventCount!==0||(meta.delegationDepth??0)!==0||run.agentPresetId!==undefined&&meta.agentPreset!==run.agentPresetId)throw unavailable()
 // 正式完成证据固定原结束位置；后续本人追问不能污染旧报告，也不能因新轮正在运行而阻断冷读。
 const events=!active&&run.evidence?.state==='ended'&&run.evidence.reason==='completed'?fixed.events.slice(0,run.evidence.endSeq+1):fixed.events
 const boundary=[...events].reverse().find(event=>event.type==='turn/start'||event.type==='turn/end')
 if(boundary?.type!=='turn/end')throw unavailable()
 const goalState=await goal?.(events)
 const observed=run.evidence?.state==='ended'&&run.evidence.inputAnchor?(goalState===undefined?verifiedAcceptedInboxError(run,events,fixed.inheritedEventCount):null):observeTaskRun(events,run.nativeRequestId,undefined,goalState)
 if(active){
  // 真实 active 锚点与同请求的普通终态对齐；失败原因原样保留，不能先伪造 ended Run 借用历史读口。
  if(!observed||observed.state!=='ended'||!isTaskRunReconcileEndReason(observed.reason)||observed.turn!==active.turn||observed.messageSeq!==active.messageSeq||observed.endSeq!==boundary.seq)throw unavailable()
  const message=events[active.messageSeq],input=message?.type==='user/message'?message.data.content[0]:undefined
  if(input?.type!=='text'||![run.inputText,taskInputWithoutMemory(run.inputText)].includes(input.text))throw unavailable()
 }else if(!isDeepStrictEqual(observed,run.evidence))throw unavailable()
 const session=Session.create(SessionId(run.sessionId),events,meta,SessionLogOffset(fixed.inheritedEventCount))
 const inbox=ctx.sessionProjections.stateOf(session,'inbox')
 if(!inbox)throw unavailable()
 if(active&&observed?.state==='ended'&&observed.reason!=='completed'){
  const team=ctx.sessionProjections.stateOf(session,'agentTeam')
  if(!team||team.failure||team.members.length||team.tasks.length||team.messages.length)throw unavailable()
 }
 return {session,inbox}
}

/** 结束轮只读冷日志，不用 resolveAgent 唤醒旧 Inbox；缺少证据一律不能宣称空闲。 */
export function readEndedTaskRunSession(ctx:Context,run:TaskRun,goal?:GoalReader){
 return readColdTaskRunSession(ctx,run,goal,false)
}

/** 对账候选仍保留原 active 记录；这里只核原生终态，控制、后台与子级继续由正常驱动核验。 */
export function readTaskRunSessionForReconcile(ctx:Context,run:TaskRun,goal?:GoalReader){
 return readColdTaskRunSession(ctx,run,goal,true)
}
