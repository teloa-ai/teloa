import type {TaskMaterialRef,TaskMaterialResult} from '@teloa/contract'
import {isTaskMaterialRef,isTaskMaterialResult,taskInput} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
type TaskRequestJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
export type TaskMaterial=TaskMaterialRef
export type TaskMaterialAdd={requestId:string;taskId:string;expectedTaskVersion:number;resourceId:string;expectedResourceVersion:number}
export type TaskMaterialApi=ReturnType<typeof createTaskMaterialApi>

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0
function readMaterial(value:unknown):TaskMaterial{
  if(!isTaskMaterialRef(value))throw Error('任务知识响应格式不正确。')
  return {...value,scopeIds:[...value.scopeIds]}
}

function readAdd(value:unknown):TaskMaterialResult{
  if(!isTaskMaterialResult(value))throw Error('任务知识添加响应格式不正确。')
  return {...value,material:{...value.material,scopeIds:[...value.material.scopeIds]}}
}

function readRequest(value:unknown):TaskMaterialAdd{
  try{
    const row=taskInput(value,['requestId','taskId','expectedTaskVersion','resourceId','expectedResourceVersion'])
    if(!uuid(row.requestId)||!uuid(row.taskId)||!positive(row.expectedTaskVersion)||!uuid(row.resourceId)||!positive(row.expectedResourceVersion))throw Error()
    return {requestId:row.requestId,taskId:row.taskId,expectedTaskVersion:row.expectedTaskVersion,resourceId:row.resourceId,expectedResourceVersion:row.expectedResourceVersion}
  }catch{throw Error('任务知识待核对记录不正确。')}
}

export function createTaskMaterialApi(call:Call,journal?:TaskRequestJournal){
  let pending:TaskMaterialAdd|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false
  try{
    const raw=journal?.read()
    if(raw){
      if(raw.length>4000)throw Error()
      const envelope=taskInput(JSON.parse(raw),['schema','request'])
      if(envelope.schema!=='teloa.task-material-add/v1')throw Error()
      pending=readRequest(envelope.request)
    }
  }catch{recoveryError=recoveryStorageError()}
  const persist=()=>journal?.write(JSON.stringify({schema:'teloa.task-material-add/v1',request:pending}))
  const finish=()=>{journal?.clear();pending=undefined}
  const send=async()=>{
    if(recoveryError)throw recoveryError
    if(!pending)throw Error('没有待核对的任务知识添加。')
    persist()
    try{
      const result=readAdd(await call('tasks/materials/add',pending))
      if(result.task.id!==pending.taskId||result.task.version!==pending.expectedTaskVersion+1||result.material.taskId!==pending.taskId||result.material.taskVersion!==pending.expectedTaskVersion+1||result.material.resourceId!==pending.resourceId||result.material.resourceVersion!==pending.expectedResourceVersion)throw Error('任务知识添加响应与原请求不一致。')
      finish()
      return result
    }catch(error){
      if(error&&typeof error==='object'&&'rejected' in error&&(error as {rejected?:unknown}).rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(String((error as {code?:unknown}).code)))finish()
      throw error
    }
  }
  return {
    pending:()=>pending?{...pending}:undefined,
    recoveryMessage:()=>recoveryError,
    /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
    discard(){const had=pending!==undefined||recoveryError!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;recoveryError=undefined;return had},
    async list(taskId:string){
      const value=await call('tasks/materials',{taskId})
      if(!Array.isArray(value))throw Error('任务知识目录格式不正确。')
      const rows=value.map(readMaterial)
      if(rows.some(row=>row.taskId!==taskId)||new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('任务知识目录身份不一致。')
      return rows
    },
    async add(taskId:string,expectedTaskVersion:number,resourceId:string,expectedResourceVersion:number){
      if(busy)throw Error('任务知识请求正在核对，请等待完成。')
      if(recoveryError)throw recoveryError
      const next=readRequest({requestId:crypto.randomUUID(),taskId,expectedTaskVersion,resourceId,expectedResourceVersion})
      if(pending&&JSON.stringify({...pending,requestId:undefined})!==JSON.stringify({...next,requestId:undefined}))throw Error('上次任务知识添加结果尚待核对，请先恢复原请求。')
      pending??=next
      busy=true
      try{return await send()}finally{busy=false}
    },
    async recover(){
      if(busy)throw Error('任务知识请求正在核对，请等待完成。')
      busy=true
      try{return await send()}finally{busy=false}
    },
  }
}
