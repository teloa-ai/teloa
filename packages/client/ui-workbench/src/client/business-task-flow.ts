import type {WorkTask} from '@teloa/contract'
import type {BusinessTaskResult} from './business-task-api.js'

export function openSavedBusinessTask(result:BusinessTaskResult,merge:(tasks:WorkTask[])=>void,open:(taskId:string)=>void):BusinessTaskResult{
 merge([result.task])
 open(result.task.id)
 return result
}
