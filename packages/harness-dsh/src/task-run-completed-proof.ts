import {isDeepStrictEqual} from 'node:util'
import {foldGoal} from '@deepseek-ai/dsh-goal'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {WorkError,type GoalObservationContext} from '@teloa/contract'
import type {TaskRun,TaskRunRuntimeLink,TaskRunGoalService} from '@teloa/backend'
import {taskRunTeamContinuations,groupRunAppendKey} from './task-run-team-records.ts'
import {taskRunExternalContinuations} from './task-run-external-continuations.ts'
import {observeTaskRun} from './task-run-observation.ts'

/** 固定结束位置的只读核验；所有数据库事实由调用者同一事务提供，不借连接、不激活Goal或Agent。 */
export function assertTaskRunCompletedProof(run:Pick<TaskRun,'id'|'sessionId'|'nativeRequestId'|'allowedTools'|'state'|'evidence'|'stopRequestedAt'>,events:readonly SessionEvent[],links:readonly TaskRunRuntimeLink[],appends:readonly string[],storedGoal:Awaited<ReturnType<TaskRunGoalService['read']>>):void{
 const denied=()=>new WorkError('teloa/conflict','原运行尚无可核对的正式结束证据。')
 if(run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.stopRequestedAt!==null)throw denied()
 const prefix=events.slice(0,run.evidence.endSeq+1),end=prefix.at(-1)
 if(prefix.length!==run.evidence.endSeq+1||end?.type!=='turn/end'||end.data.reason.kind!=='completed')throw denied()
 const teams=links.filter((row):row is Extract<TaskRunRuntimeLink,{kind:'team'}>=>row.kind==='team')
 if(links.some(row=>row.runId!==run.id)||teams.some(row=>row.sessionId!==run.sessionId||row.payload.requestId!==run.nativeRequestId||row.nativeId!==row.payload.reservationId))throw denied()
 const base=new Set([...taskRunTeamContinuations(prefix,teams),...appends.map(groupRunAppendKey)]),continuations=new Set([...base,...taskRunExternalContinuations(run,prefix,links,base)])
 let goal:GoalObservationContext|undefined
 if(storedGoal.binding){
  const binding=storedGoal.binding,folded=foldGoal(prefix).goal
  if(binding.runId!==run.id||binding.sessionId!==run.sessionId||!folded||folded.id!==binding.goalId||folded.revision!==binding.revision||folded.phase!=='complete'||storedGoal.continuations.some(row=>row.state==='reserved'||row.state==='unknown'))throw denied()
  goal={binding,continuations:storedGoal.continuations,goalPhase:'complete',activation:'disarmed',pendingRound:false,childrenOutstanding:false}
 }
 if(!isDeepStrictEqual(observeTaskRun(prefix,run.nativeRequestId,continuations,goal),run.evidence))throw denied()
}
