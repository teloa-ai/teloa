import type {PreviewRole} from './role-preview.ts'
import type {Artifact} from './artifact-preview.ts'
import type {PreviewTask} from './task-preview.ts'

/** 只从同一任务的真实参与身份统计合作；同群或同业务不等于一起处理过工作。 */
export function employeeCoworkers(roleId:string,tasks:readonly PreviewTask[],roles:readonly PreviewRole[]){
 const counts=new Map<string,Set<string>>()
 for(const task of tasks){
  const participants=new Set([task.authorId,task.assigneeId,...task.assigneeHistory])
  if(!participants.has(roleId))continue
  for(const id of participants)if(id!==roleId){const ids=counts.get(id)??new Set<string>();ids.add(task.id);counts.set(id,ids)}
 }
 return roles.filter(role=>role.kind==='employee'&&counts.has(role.id)).map(role=>({role,count:counts.get(role.id)!.size})).sort((a,b)=>b.count-a.count||a.role.name.localeCompare(b.role.name))
}

/** 成果必须能回溯到员工参与的任务或该任务的固定成果引用，不按同名标题或所属业务猜测。 */
export function employeeResults(tasks:readonly PreviewTask[],artifacts:readonly Artifact[]){
 const byTask=new Map(tasks.map(task=>[task.id,task]))
 return artifacts.flatMap(artifact=>{
  const task=artifact.source.kind==='task'?byTask.get(artifact.source.id):tasks.find(task=>task.artifact?.id===artifact.id)
  const version=artifact.versions.at(-1)
  return task&&version?[{artifact,version,task}]:[]
 }).sort((a,b)=>b.version.at.localeCompare(a.version.at))
}
