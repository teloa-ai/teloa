import type {TaskMaterialResult,WorkTask} from '@teloa/contract'
import type {HomeResourceSelection} from './home-resource-selection.js'

type AddMaterial=(taskId:string,expectedTaskVersion:number,resourceId:string,expectedResourceVersion:number)=>Promise<TaskMaterialResult>

export async function pinHomeWorkResources(
  initial:WorkTask,
  resources:readonly HomeResourceSelection[],
  add:AddMaterial,
  changed:(task:WorkTask)=>void,
):Promise<{task:WorkTask;error?:unknown}>{
  let task=initial
  for(const resource of resources){
    try{
      const result=await add(task.id,task.version,resource.id,resource.version)
      task=result.task
      changed(task)
    }catch(error){return {task,error}}
  }
  return {task}
}
