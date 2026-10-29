import {taskInput,WorkError} from '@teloa/contract'
import type {TaskRequestJournal} from './task-api.ts'

export type EmployeeWorkView={taskId:string;currentTaskId:string;sessionId:string|null;canContinue:boolean;work:{id:string;title:string;version:number;round:number;state:'queued'|'running'|'waiting'|'succeeded'|'failed'|'cancel_requested'|'cancelled';error:string|null}}
type Command={taskId:string;workId:string;requestId:string;expectedVersion:number;expectedRound:number;input:string}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
function command(v:unknown):Command{
 const r=taskInput(v,['taskId','workId','requestId','expectedVersion','expectedRound','input'])
 if(!uuid(r.taskId)||!uuid(r.workId)||!uuid(r.requestId)||!Number.isSafeInteger(r.expectedVersion)||Number(r.expectedVersion)<1||!Number.isSafeInteger(r.expectedRound)||Number(r.expectedRound)<1||typeof r.input!=='string'||!r.input.trim()||r.input.length>6000)throw Error('原工作续办记录不正确。')
 return r as Command
}
function read(v:unknown,taskId:string):EmployeeWorkView|null{
 if(v===null)return null
 const r=taskInput(v,['taskId','currentTaskId','sessionId','canContinue','work']),w=r.work as EmployeeWorkView['work']
 if(r.taskId!==taskId||!uuid(r.currentTaskId)||r.sessionId!==null&&(typeof r.sessionId!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(r.sessionId))||typeof r.canContinue!=='boolean'||!w||!uuid(w.id)||typeof w.title!=='string'||!Number.isSafeInteger(w.version)||w.version<1||!Number.isSafeInteger(w.round)||w.round<1||!['queued','running','waiting','succeeded','failed','cancel_requested','cancelled'].includes(w.state)||w.error!==null&&typeof w.error!=='string')throw Error('原工作回包不正确。')
 return {taskId,currentTaskId:r.currentTaskId,sessionId:r.sessionId as string|null,canContinue:r.canContinue,work:{id:w.id,title:w.title,version:w.version,round:w.round,state:w.state,error:w.error}}
}
/** 只保存本人续办正文和幂等身份；从不接触集成密钥。未知回包必须核对原请求。 */
export function createEmployeeApiWorkApi(call:(method:string,payload:unknown)=>Promise<unknown>,journal?:TaskRequestJournal){
 let pending:Command|undefined,fault=false,busy=false
 const listeners=new Set<()=>void>(),changed=()=>{for(const listener of listeners)listener()}
 try{const raw=journal?.read();if(raw){if(raw.length>40000)throw Error();pending=command(JSON.parse(raw))}}catch{fault=true}
 const send=async()=>{
  if(busy||fault||!pending)throw new WorkError('teloa/conflict','请先核对原工作续办记录。')
  busy=true
  const request={...pending}
  try{
   journal?.write(JSON.stringify(request))
   const {expectedRound,...payload}=request
   const view=read(await call('employee-integrations/continue-work',payload),request.taskId)
   if(!view||view.work.id!==request.workId||view.work.round<=expectedRound||view.work.version<=request.expectedVersion)throw Error('续办回包与原工作不一致。')
   journal?.clear();pending=undefined;changed();return view
  }catch(error){
   if(error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(String(error.code))){journal?.clear();pending=undefined;changed()}
   throw error
  }finally{busy=false}
 }
 return {
  subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener)}},
  pending:()=>pending?{...pending}:undefined,fault:()=>fault,
  async read(taskId:string){if(!uuid(taskId))throw Error('任务身份不正确。');return read(await call('employee-integrations/work-for-task',{taskId}),taskId)},
  async continue(view:EmployeeWorkView,input:string){if(pending||fault)throw new WorkError('teloa/conflict','请先核对上次续办。');if(!view.canContinue||!['succeeded','failed','cancelled'].includes(view.work.state))throw new WorkError('teloa/conflict','本轮尚不能续办，请先刷新原工作。');pending=command({taskId:view.taskId,workId:view.work.id,requestId:crypto.randomUUID(),expectedVersion:view.work.version,expectedRound:view.work.round,input});changed();return send()},
  recover:send,
 }
}
export type EmployeeApiWorkApi=ReturnType<typeof createEmployeeApiWorkApi>
