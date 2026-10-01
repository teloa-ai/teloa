import type {TaskRunSubagentView} from './task-run-api.js'

export type TaskRunSubagentPresentation={number:number;stateKey:string;outcomeKey?:string;createdAt:string;recoveryId?:string;startedAt?:string;endedAt?:string;tokenEstimate?:number}

const outcomes:Readonly<Record<string,string>>={
 completed:'subagent.run.outcome.completed',
 aborted:'subagent.run.outcome.stopped',
 interrupted:'subagent.run.outcome.stopped',
 error:'subagent.run.outcome.failed',
}

/**
 * 停止原因为原生运行时文本，不能直接作为界面文案展示；只把产品认识的结局映射为词表键。
 */
export function taskRunSubagentPresentation(rows:readonly TaskRunSubagentView[]):TaskRunSubagentPresentation[]{
 return rows.map((row,index)=>({
  number:index+1,
  stateKey:'subagent.run.state.'+row.state,
  ...(row.state==='ended'?{outcomeKey:row.stopReason===undefined?'subagent.run.outcome.ended':outcomes[row.stopReason]??'subagent.run.outcome.ended'}:{}),
  createdAt:row.createdAt,
  ...(row.recoveryId===undefined?{}:{recoveryId:row.recoveryId}),
  ...(row.startedAt===undefined?{}:{startedAt:row.startedAt}),
  ...(row.endedAt===undefined?{}:{endedAt:row.endedAt}),
  ...(row.tokenEstimate===undefined?{}:{tokenEstimate:row.tokenEstimate}),
 }))
}
