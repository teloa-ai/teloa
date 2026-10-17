import {isDeepStrictEqual} from 'node:util'
import type {Context} from '@deepseek-ai/cordis'
import {Session,SessionId,SessionLogOffset,type SessionEvent} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {TaskRun} from '@teloa/backend'
import {WorkError,type GoalObservationContext} from '@teloa/contract'
import {observeTaskRun} from './task-run-observation.ts'

/** 结束轮只读冷日志，不用 resolveAgent 唤醒旧 Inbox；缺少证据一律不能宣称空闲。 */
export async function readEndedTaskRunSession(ctx:Context,run:TaskRun,goal?:(events:readonly SessionEvent[])=>Promise<GoalObservationContext|undefined>){
 const unavailable=()=>new WorkError('teloa/session-unavailable','执行负责人会话暂不可用。')
 if(run.state!=='ended'||run.evidence?.state!=='ended'||run.stopRequestedAt!=null)throw unavailable()
 const fixed=await ctx.sessionController.inspect(SessionId(run.sessionId)),meta=fixed.meta
 if(meta.id!==run.sessionId||meta.parentSession!==undefined||meta.origin==='subagent'||meta.isSeeded||fixed.inheritedEventCount!==0||(meta.delegationDepth??0)!==0||run.agentPresetId!==undefined&&meta.agentPreset!==run.agentPresetId)throw unavailable()
 const boundary=[...fixed.events].reverse().find(event=>event.type==='turn/start'||event.type==='turn/end')
 if(boundary?.type!=='turn/end'||!isDeepStrictEqual(observeTaskRun(fixed.events,run.nativeRequestId,undefined,await goal?.(fixed.events)),run.evidence))throw unavailable()
 const session=Session.create(SessionId(run.sessionId),fixed.events,meta,SessionLogOffset(fixed.inheritedEventCount))
 const inbox=ctx.sessionProjections.stateOf(session,'inbox')
 if(!inbox)throw unavailable()
 return {session,inbox}
}
