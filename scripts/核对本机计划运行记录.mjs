export function summarizePreparedPlanHistory(saved,dispatchedTaskId){
 if(!saved||saved.task?.id!==dispatchedTaskId)throw Error('本机持续计划未形成与固定领取记录一致的正式任务。')
 return {
  occurrences:1,
  linkedTasks:1,
  taskState:saved.task.state,
  runState:saved.run?.state??'not-started',
 }
}
