import {taskInput} from '@teloa/contract'
import {readSavedTask,type TaskRequestJournal} from './task-api.ts'
import {recoveryStorageError} from './recovery-error.ts'
const states={start:'running',pause:'paused',resume:'running',cancel:'cancelled',complete:'completed'} as const
export type TaskAction=keyof typeof states
type Request={taskId:string;requestId:string;expectedVersion:number;action:TaskAction;artifact?:{id:string;version:number};note?:string}
function checked(value:unknown):Request{
 const row=taskInput(value,['taskId','requestId','expectedVersion','action','artifact','note'])
 if(![row.taskId,row.requestId].every(value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))||!Number.isSafeInteger(row.expectedVersion)||(row.expectedVersion as number)<1||typeof row.action!=='string'||!Object.hasOwn(states,row.action))throw Error('任务状态请求格式不正确。')
 const artifact=row.action==='complete'?taskInput(row.artifact,['id','version']):undefined
 if(artifact&&(typeof artifact.id!=='string'||!/^[a-f0-9-]{36}$/i.test(artifact.id)||!Number.isSafeInteger(artifact.version)||(artifact.version as number)<1||typeof row.note!=='string'||!row.note.trim()||row.note.length>4000))throw Error('结项成果或说明不正确。')
 if(!artifact&&(row.artifact!==undefined||row.note!==undefined))throw Error('此状态操作不能包含结项内容。')
 return {...(artifact?{artifact:{id:artifact.id as string,version:artifact.version as number},note:(row.note as string).trim()}:{}),taskId:row.taskId as string,requestId:row.requestId as string,expectedVersion:row.expectedVersion as number,action:row.action as TaskAction}
}
export type TaskTransitionApi=ReturnType<typeof createTaskTransitionApi>
export function createTaskTransitionApi(call:(method:string,payload:unknown)=>Promise<unknown>,journal?:TaskRequestJournal){
 let request:Request|undefined,error:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 try{const raw=journal?.read();if(raw){if(raw.length>30000)throw Error();const value=taskInput(JSON.parse(raw),['schema','request']);if(value.schema!=='teloa.task-transition/v1')throw Error();request=checked(value.request)}}catch{error=recoveryStorageError()}
 const send=async()=>{
  if(error)throw error;if(busy)throw Error('任务状态正在核对。');if(!request)throw Error('没有待核对的任务状态。')
  busy=true
  try{journal?.write(JSON.stringify({schema:'teloa.task-transition/v1',request}));const result=readSavedTask(await call('tasks/transition',request))
   if(result.id!==request.taskId||result.version!==request.expectedVersion+1||result.state!==states[request.action])throw Error('任务状态响应不一致，请核对原请求。')
   journal?.clear();request=undefined;return result
  }catch(cause){if(cause&&typeof cause==='object'&&'rejected' in cause&&cause.rejected===true&&'code' in cause&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(String(cause.code))){journal?.clear();request=undefined}throw cause}finally{busy=false}
 }
 return {pending:()=>request?structuredClone(request):undefined,recoveryMessage:()=>error,
  /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discard(){const had=request!==undefined||error!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}request=undefined;error=undefined;return had},
  recover:send,
  async change(taskId:string,expectedVersion:number,action:TaskAction,delivery?:{artifact:{id:string;version:number};note:string}){
   if(error)throw error
   const proposed=checked({taskId,expectedVersion,action,requestId:request?.requestId??crypto.randomUUID(),...delivery})
   if(request&&(JSON.stringify(request)!==JSON.stringify(proposed)||request.taskId!==taskId||request.expectedVersion!==expectedVersion||request.action!==action))throw Error('请先核对原请求，再执行其他状态操作。')
   request??=proposed;return send()
  }
 }
}
