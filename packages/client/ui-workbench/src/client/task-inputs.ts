import type { PreviewTask } from './task-preview.ts'

export type TaskInputFields={result:string;source:string;materialNote:string;assignee:string;handoffNote:string}
export type TaskInputDraft={taskId:string;version:number;goal:string;assigneeId:string;fields:TaskInputFields}
export type TaskInputDrafts=Record<string,TaskInputDraft>
const emptyFields=():TaskInputFields=>({result:'',source:'',materialNote:'',assignee:'',handoffNote:''})
const basis=(task:PreviewTask)=>({taskId:task.id,version:task.version,goal:task.goal,assigneeId:task.assigneeId})
const ended=(task:PreviewTask)=>task.state==='completed'||task.state==='cancelled'
export const hasTaskInputs=(draft:TaskInputDraft)=>Object.values(draft.fields).some(value=>value!=='')
export const taskInputsStale=(draft:TaskInputDraft,task:PreviewTask)=>draft.taskId!==task.id||draft.version!==task.version||draft.goal!==task.goal||draft.assigneeId!==task.assigneeId
export function readTaskInputs(forms:TaskInputDrafts,task:PreviewTask):TaskInputDraft{
  return forms[task.id]??{...basis(task),fields:emptyFields()}
}
export function editTaskInputs(forms:TaskInputDrafts,task:PreviewTask,patch:Partial<TaskInputFields>):TaskInputDrafts{
  if(ended(task))throw Error('任务已结束，未提交输入只读保留。')
  const previous=readTaskInputs(forms,task)
  const draft=hasTaskInputs(previous)?previous:{...basis(task),fields:emptyFields()}
  return {...forms,[task.id]:{...draft,fields:{...draft.fields,...patch}}}
}
export function assertTaskInputsCurrent(draft:TaskInputDraft,task:PreviewTask):void{
  if(ended(task))throw Error('任务已结束，不能提交未保存输入。')
  if(taskInputsStale(draft,task))throw Error('任务目标或负责员工已变化，请先复核保留的输入。')
}
export function reviewTaskInputs(forms:TaskInputDrafts,task:PreviewTask):TaskInputDrafts{
  if(ended(task))throw Error('任务已结束，不能接续旧输入。')
  return {...forms,[task.id]:{...basis(task),fields:readTaskInputs(forms,task).fields}}
}
export function clearTaskInputs(forms:TaskInputDrafts,id:string,fields:readonly (keyof TaskInputFields)[]):TaskInputDrafts{
  const previous=forms[id]
  if(!previous)return forms
  const next={...previous,fields:{...previous.fields}}
  for(const field of fields)next.fields[field]=''
  const result={...forms}
  if(hasTaskInputs(next))result[id]=next;else delete result[id]
  return result
}
