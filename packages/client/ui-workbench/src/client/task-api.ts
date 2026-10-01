import type {PreviewTask} from './task-preview.ts'
import {taskDefinition,taskInput,type WorkTask,type TaskDefinition} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'
export type TaskCompletionRecord={taskId:string;taskVersion:number;artifactId:string;artifactVersion:number;note:string;completedAt:string}
type Call=(endpoint:string,input:unknown)=>Promise<unknown>
export type TaskApi=ReturnType<typeof createTaskApi>
export type TaskAssignee={roleId:string;expectedVersion:number}
export type TaskAttention={kind:'error'|'review';reason:'task-blocked'|'execution-failed'|'execution-configuration-failed'|'execution-completed'|'task-waiting'}
export type TaskAttentionItem={task:WorkTask;attention:TaskAttention|null}
function readAssignee(value:unknown):TaskAssignee|undefined{
 if(value===undefined)return undefined
 const row=taskInput(value,['roleId','expectedVersion'])
 if(typeof row.roleId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.roleId)||!Number.isSafeInteger(row.expectedVersion)||(row.expectedVersion as number)<1)throw Error('交办负责人格式不正确。')
 return {roleId:row.roleId,expectedVersion:row.expectedVersion as number}
}
function read(value:unknown):WorkTask{
 try{
  const row=taskInput(value,['id','ownerId','version','state','createdAt','updatedAt','title','goal','scope','assigneeRoleId','assigneeRoleVersion'].concat(['groupId','skills']))
  const {id,ownerId,version,state,createdAt,updatedAt,assigneeRoleId,assigneeRoleVersion,...fields}=row
  if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)||typeof ownerId!=='string'||!ownerId||!Number.isSafeInteger(version)||(version as number)<1||typeof state!=='string'||!['ready','running','paused','waiting','blocked','completed','cancelled'].includes(state)||typeof createdAt!=='string'||!Number.isFinite(Date.parse(createdAt))||typeof updatedAt!=='string'||!Number.isFinite(Date.parse(updatedAt)))throw Error()
  if(assigneeRoleId===null?assigneeRoleVersion!==null:typeof assigneeRoleId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(assigneeRoleId)||!Number.isSafeInteger(assigneeRoleVersion)||(assigneeRoleVersion as number)<1)throw Error()
  return {...taskDefinition(fields),id,ownerId,version:version as number,state:state as WorkTask['state'],createdAt,updatedAt,assigneeRoleId:assigneeRoleId as string|null,assigneeRoleVersion:assigneeRoleVersion as number|null}
 }catch{throw Error('任务服务返回的内容格式不正确。')}
}
export type TaskRequestJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
export function createTaskApi(call:Call,journal?:TaskRequestJournal){
 let pending:{requestId:string;fields:TaskDefinition;assignee:TaskAssignee|undefined;key:string}|undefined
 let recoveryError:ReturnType<typeof recoveryStorageError>|undefined,creating=false
 try{
  const content=journal?.read()
  if(content){const row=taskInput(JSON.parse(content),['schema','requestId','fields','assignee']);if(row.schema!=='teloa.task-create/v1'||typeof row.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.requestId))throw Error();const fields=taskDefinition(row.fields),assignee=readAssignee(row.assignee);pending={requestId:row.requestId,fields,assignee,key:JSON.stringify({fields,assignee})}}
 }catch{recoveryError=recoveryStorageError()}
 return {
  recoveryMessage:()=>recoveryError,
  /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discard(){const had=pending!==undefined||recoveryError!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;recoveryError=undefined;return had},
  pendingFields:()=>pending?taskDefinition(pending.fields):undefined,
  pendingAssignee:()=>pending?.assignee?{...pending.assignee}:undefined,
  async recoverCreate():Promise<WorkTask>{if(!pending)throw Error('没有待核对的任务创建。');return this.create(pending.fields,pending.assignee)},
  async list(){const value=await call('tasks/list',{});if(!Array.isArray(value))throw Error('任务目录格式不正确。');const rows=value.map(read);if(new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('任务目录格式不正确：重复身份。');return rows},
  async attention():Promise<{items:TaskAttentionItem[]}>{
   const response=await call('tasks/attention',{})
   try{
    const value=taskInput(response,['items']);if(!Array.isArray(value.items))throw Error()
    const items=value.items.map(candidate=>{const item=taskInput(candidate,['task','attention']),task=read(item.task);let attention:TaskAttention|null=null
	     if(item.attention!==null){const row=taskInput(item.attention,['kind','reason']);if(typeof row.kind!=='string'||typeof row.reason!=='string'||!['error','review'].includes(row.kind)||!['task-blocked','execution-failed','execution-configuration-failed','execution-completed','task-waiting'].includes(row.reason))throw Error();attention={kind:row.kind as TaskAttention['kind'],reason:row.reason as TaskAttention['reason']}}
	     const configurationFailed=attention?.reason==='execution-configuration-failed'
	     if(configurationFailed){if(attention?.kind!=='error'||!['ready','paused','blocked','waiting'].includes(task.state))throw Error()}
	     else if(task.state==='blocked'){if(attention?.kind!=='error'||!['task-blocked','execution-failed'].includes(attention.reason))throw Error()}
	     else if(task.state==='waiting'){if(attention?.kind!=='review'||!['execution-completed','task-waiting'].includes(attention.reason))throw Error()}
	     else if(attention!==null)throw Error()
     if(attention&&['execution-failed','execution-configuration-failed','execution-completed'].includes(attention.reason)&&task.assigneeRoleId===null)throw Error()
     return {task,attention}
    })
    if(new Set(items.map(item=>item.task.id)).size!==items.length)throw Error()
    return {items}
   }catch{throw Error('任务需要你快照格式不正确。')}
  },
  async completion(taskId:string):Promise<TaskCompletionRecord|null>{
   const value=await call('tasks/completion',{taskId});if(value===null)return null
   const row=taskInput(value,['taskId','taskVersion','artifactId','artifactVersion','note','completedAt'])
   if(row.taskId!==taskId||!Number.isSafeInteger(row.taskVersion)||(row.taskVersion as number)<2||typeof row.artifactId!=='string'||!/^[a-f0-9-]{36}$/i.test(row.artifactId)||!Number.isSafeInteger(row.artifactVersion)||(row.artifactVersion as number)<1||typeof row.note!=='string'||!row.note.trim()||row.note.length>4000||typeof row.completedAt!=='string'||!Number.isFinite(Date.parse(row.completedAt)))throw Error('任务结项记录格式不正确。')
   return row as TaskCompletionRecord
  },
  async edit(taskId:string,expectedVersion:number,fields:{title:string;goal:string}){
   const result=read(await call('tasks/edit',{taskId,expectedVersion,fields}))
   if(result.id!==taskId||result.version!==expectedVersion+1||result.title!==fields.title.trim()||result.goal!==fields.goal.trim())throw Error('任务编辑响应与原请求不一致，请刷新核对。')
   return result
  },
  async create(input:TaskDefinition,target?:TaskAssignee){
   if(recoveryError)throw recoveryError
   if(creating)throw Error('任务创建正在核对，请等待当前请求结束。')
   const fields=taskDefinition(input),assignee=readAssignee(target),key=JSON.stringify({fields,assignee})
   if(pending&&pending.key!==key)throw Error('上次创建结果尚待核对，请先用原内容重试，避免重复创建任务。')
   pending??={requestId:crypto.randomUUID(),fields,assignee,key}
   creating=true
   try{
    journal?.write(JSON.stringify({schema:'teloa.task-create/v1',requestId:pending.requestId,fields:pending.fields,...(pending.assignee?{assignee:pending.assignee}:{})}))
    const result=read(await call('tasks/create',{requestId:pending.requestId,fields:pending.fields,...(pending.assignee?{assignee:pending.assignee}:{})}))
    if(JSON.stringify(taskDefinition({title:result.title,goal:result.goal,scope:result.scope,groupId:result.groupId,skills:result.skills}))!==JSON.stringify(fields))throw Error('任务响应与创建内容不一致，请核对原请求。')
    if(result.version===1&&(result.assigneeRoleId!==(assignee?.roleId??null)||result.assigneeRoleVersion!==(assignee?.expectedVersion??null)))throw Error('任务负责人响应与交办不一致，请核对原请求。')
    journal?.clear();pending=undefined;return result
   }finally{creating=false}
  },
 }
}

export function projectSavedTask(task:WorkTask):PreviewTask{
 const assignee=task.assigneeRoleId??'self'
 return {id:task.id,title:task.title,goal:task.goal,scope:task.scope as PreviewTask['scope'],groupId:task.groupId,skills:task.skills,version:task.version,state:task.state,storage:'persistent',object:'本机任务',need:null,request:'',authorId:'self',assigneeId:assignee,assigneeHistory:[assignee],createdAt:task.createdAt,updatedAt:task.updatedAt,result:'',evidence:[],history:[],supplements:[],approvalRequired:false,risk:'未提出外部动作',execution:'not_started'}
}
export {read as readSavedTask}
