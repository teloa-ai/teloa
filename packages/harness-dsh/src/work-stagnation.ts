import {WorkError,type WorkBudgetPolicy,type GoalContinuationReceipt,type GoalObservationContext} from '@teloa/contract'
import {readProgressEvidence,progressEvidenceKey,type ProgressEvidence} from '@teloa/backend'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {observeTaskRunTimeline} from './task-run-observation.ts'

export type {ProgressEvidence} from '@teloa/backend'
/** referenceId 必须是稳定业务事实/资料版本摘要，而不是模型文字、随机 call ID 或时间戳。计数由持久服务提供。 */
export function evaluateWorkStagnation(previous:readonly ProgressEvidence[],current:readonly ProgressEvidence[],policy:Pick<WorkBudgetPolicy,'stagnationRounds'>,previousStagnantRounds=0):{progressed:boolean;shouldWait:boolean;reason:string|null}{
 if(!Number.isSafeInteger(policy.stagnationRounds)||policy.stagnationRounds<1||!Number.isSafeInteger(previousStagnantRounds)||previousStagnantRounds<0)throw new WorkError('teloa/invalid-input','停滞策略和既有轮次不正确。')
 const seen=new Set(readProgressEvidence(previous).map(progressEvidenceKey)),progressed=readProgressEvidence(current).some(e=>!seen.has(progressEvidenceKey(e))),shouldWait=!progressed&&previousStagnantRounds+1>=policy.stagnationRounds
 return {progressed,shouldWait,reason:shouldWait?'连续多轮没有新的可信业务进展，等待本人调整目标或资料。':null}
}

/** 只取真实已准入 Goal 的 completed 原生轮。证据解析器由资源/业务回执服务装配，不能让模型提交进展 DTO。 */
export async function inspectNativeProgressRound(run:{id:string;nativeRequestId:string},receipt:GoalContinuationReceipt,events:readonly SessionEvent[],goal:GoalObservationContext,resolveEvidence:(events:readonly SessionEvent[])=>Promise<readonly ProgressEvidence[]>,teamMessages?:ReadonlySet<string>):Promise<{completed:boolean;evidence:readonly ProgressEvidence[]}>{
 if(receipt.state!=='accepted'||receipt.runId!==run.id||!goal.continuations.some(r=>r.nativeRequestId===receipt.nativeRequestId&&r.state==='accepted'))return {completed:false,evidence:[]}
 const owned=new Set<number>()
 observeTaskRunTimeline(events,run.nativeRequestId,teamMessages,event=>owned.add(event.seq),goal)
 const message=events.find(event=>event.type==='user/message'&&event.data.id===receipt.messageId&&owned.has(event.seq))
 if(!message)return {completed:false,evidence:[]}
 const start=[...events.slice(0,message.seq)].reverse().find(event=>event.type==='turn/start')
 if(start?.type!=='turn/start')return {completed:false,evidence:[]}
 const end=events.slice(message.seq+1).find(event=>event.type==='turn/end'||event.type==='turn/start')
 if(end?.type!=='turn/end'||end.data.turn!==start.data.turn||end.data.reason.kind!=='completed'||events.slice(message.seq,end.seq).some(event=>event.type==='user/message'&&!owned.has(event.seq)))return {completed:false,evidence:[]}
 const window=events.slice(message.seq,end.seq+1).filter(event=>owned.has(event.seq)||event===end),evidence=readProgressEvidence(await resolveEvidence(Object.freeze(window))),roundSeqs=new Set<number>(window.map(event=>event.seq))
 if(evidence.some(e=>e.runId===run.id&&!roundSeqs.has(e.seq)))throw new WorkError('teloa/forbidden','进展不是本轮获准原生事件或真实子工作回执。')
 return {completed:true,evidence}
}
