import {isTaskHandoffChangeResult,readTaskHandoffChangeInput,taskInput,type TaskHandoffChangeInput,type TaskHandoffChangeResult,type TaskHandoffTarget} from '@teloa/contract'
import {readSavedTask,type TaskRequestJournal} from './task-api.ts'
import {recoveryStorageError} from './recovery-error.ts'
export type TaskHandoff={id:string;taskId:string;fromRoleId:string;ownerId:string;roleVersion:number;taskVersion:number;reason:string;createdAt:string;status:'pending'|'resolved'}
export type RoleHandoffRequest={handoffId:string;expectedTaskVersion:number;toRoleId:string;expectedRoleVersion:number;note:string}
export type SelfHandoffRequest={handoffId:string;expectedTaskVersion:number;target:{kind:'self'};note:string}
export type HandoffRequest=RoleHandoffRequest|SelfHandoffRequest
export type HandoffChangeRequest=Omit<TaskHandoffChangeInput,'requestId'>
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const version=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>0
function checked(value:unknown):HandoffRequest{
 const selfTarget=typeof value==='object'&&value!==null&&Object.hasOwn(value,'target')
 const row=taskInput(value,selfTarget?['handoffId','expectedTaskVersion','target','note']:['handoffId','expectedTaskVersion','toRoleId','expectedRoleVersion','note'])
 if(!uuid(row.handoffId)||!version(row.expectedTaskVersion)||typeof row.note!=='string'||!row.note.trim()||row.note.length>4000)throw Error('接任请求格式不正确。')
 if(selfTarget){const target=taskInput(row.target,['kind']);if(target.kind!=='self')throw Error('接任请求格式不正确。');return {handoffId:row.handoffId,expectedTaskVersion:row.expectedTaskVersion as number,target:{kind:'self'},note:row.note.trim()}}
 if(!uuid(row.toRoleId)||!version(row.expectedRoleVersion))throw Error('接任请求格式不正确。')
 return {handoffId:row.handoffId,expectedTaskVersion:row.expectedTaskVersion as number,toRoleId:row.toRoleId,expectedRoleVersion:row.expectedRoleVersion as number,note:row.note.trim()}
}
export type HandoffApi=ReturnType<typeof createHandoffApi>
export function createHandoffApi(call:(method:string,payload:unknown)=>Promise<unknown>,journal?:TaskRequestJournal,changeJournal?:TaskRequestJournal){
 let pending:{taskId:string;request:HandoffRequest}|undefined,error:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 try{const raw=journal?.read();if(raw){if(raw.length>30000)throw Error();const value=taskInput(JSON.parse(raw),['schema','taskId','request']);if(value.schema!=='teloa.handoff/v1'||!uuid(value.taskId))throw Error();pending={taskId:value.taskId,request:checked(value.request)}}}catch{error=recoveryStorageError()}
 let changePending:TaskHandoffChangeInput|undefined,changeError:ReturnType<typeof recoveryStorageError>|undefined,changeBusy=false
 try{const raw=changeJournal?.read();if(raw){if(raw.length>30000)throw Error();const value=taskInput(JSON.parse(raw),['schema','request']);if(value.schema!=='teloa.handoff-change/v1')throw Error();changePending=readTaskHandoffChangeInput(value.request)}}catch{changeError=recoveryStorageError()}
 const send=async()=>{
  if(error)throw error;if(busy)throw Error('接任正在核对。');if(!pending)throw Error('没有待核对的接任。');busy=true
  try{
   journal?.write(JSON.stringify({schema:'teloa.handoff/v1',...pending}))
   const result=taskInput(await call('handoffs/resolve',pending.request),['task','handoffId','appliedVersion']),task=readSavedTask(result.task),appliedVersion=pending.request.expectedTaskVersion+1
   const expected='target' in pending.request?{roleId:null,roleVersion:null}:{roleId:pending.request.toRoleId,roleVersion:pending.request.expectedRoleVersion}
   if(task.id!==pending.taskId||result.handoffId!==pending.request.handoffId||result.appliedVersion!==appliedVersion||task.version<appliedVersion||task.version===appliedVersion&&(task.assigneeRoleId!==expected.roleId||task.assigneeRoleVersion!==expected.roleVersion))throw Error('接任响应不一致，请核对原请求。')
   journal?.clear();pending=undefined;return {task,handoffId:result.handoffId as string,appliedVersion}
  }catch(cause){if(cause&&typeof cause==='object'&&'rejected' in cause&&cause.rejected===true&&'code' in cause&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(String(cause.code))){journal?.clear();pending=undefined}throw cause}finally{busy=false}
 }
 const sendChange=async():Promise<TaskHandoffChangeResult>=>{
  if(changeError)throw changeError;if(changeBusy)throw Error('负责人调整正在核对。');if(!changePending)throw Error('没有待核对的负责人调整。');changeBusy=true
  try{
   changeJournal?.write(JSON.stringify({schema:'teloa.handoff-change/v1',request:changePending}))
   const value=await call('handoffs/change',changePending)
   if(!isTaskHandoffChangeResult(value))throw Error('负责人调整响应不一致，请核对原请求。')
   const expectedTo=changePending.target.kind==='self'?{kind:'self'}:{kind:'role',roleId:changePending.target.roleId,roleVersion:changePending.target.expectedRoleVersion}
   if(value.change.requestId!==changePending.requestId||value.change.taskId!==changePending.taskId||value.change.baseVersion!==changePending.expectedTaskVersion||value.change.note!==changePending.note||JSON.stringify(value.change.to)!==JSON.stringify(expectedTo))throw Error('负责人调整响应不一致，请核对原请求。')
   changeJournal?.clear();changePending=undefined;return value
  }catch(cause){if(cause&&typeof cause==='object'&&'rejected' in cause&&cause.rejected===true&&'code' in cause&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(String(cause.code))){changeJournal?.clear();changePending=undefined}throw cause}finally{changeBusy=false}
 }
 return {pending:()=>pending?structuredClone(pending):undefined,recoveryMessage:()=>error,
  /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discard(){const had=pending!==undefined||error!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;error=undefined;return had},
  recover:send,pendingChange:()=>changePending?structuredClone(changePending):undefined,changeRecoveryMessage:()=>changeError,
  /** 丢弃负责人调整的本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discardChange(){const had=changePending!==undefined||changeError!==undefined;try{changeJournal?.clear()}catch{/* 清不掉不该变成第二道墙 */}changePending=undefined;changeError=undefined;return had},
  recoverChange:sendChange,
  async list():Promise<TaskHandoff[]>{
   const value=await call('handoffs/list',{});if(!Array.isArray(value))throw Error('交接目录格式不正确。')
   const rows=value.map(v=>{const r=taskInput(v,['id','taskId','fromRoleId','ownerId','roleVersion','taskVersion','reason','createdAt','status']);if(!uuid(r.id)||!uuid(r.taskId)||!uuid(r.fromRoleId)||typeof r.ownerId!=='string'||!r.ownerId||!version(r.roleVersion)||!version(r.taskVersion)||typeof r.reason!=='string'||!r.reason.trim()||typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt))||!['pending','resolved'].includes(String(r.status)))throw Error('交接目录格式不正确。');return r as TaskHandoff})
   if(new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('交接目录身份重复。');return rows
  },
  async resolve(taskId:string,input:HandoffRequest){if(error)throw error;if(!uuid(taskId))throw Error('任务身份不正确。');const proposed={taskId,request:checked(input)};if(pending&&JSON.stringify(pending)!==JSON.stringify(proposed))throw Error('请先核对原请求，再修改接任安排。');pending??=proposed;return send()},
  async change(taskId:string,expectedTaskVersion:number,target:TaskHandoffTarget,note:string){
   if(changeError)throw changeError
   const request=readTaskHandoffChangeInput({requestId:crypto.randomUUID(),taskId,expectedTaskVersion,target,note})
   const key=(value:TaskHandoffChangeInput)=>JSON.stringify({taskId:value.taskId,expectedTaskVersion:value.expectedTaskVersion,target:value.target,note:value.note})
   if(changePending&&key(changePending)!==key(request))throw Error('请先核对原改派请求，再调整负责人。')
   changePending??=request
   return sendChange()
  },
 }
}
