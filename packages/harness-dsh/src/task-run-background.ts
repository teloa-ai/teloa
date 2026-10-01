import {randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {JobStatus,JobView} from '@deepseek-ai/dsh-jobs'
import {SessionId} from '@deepseek-ai/dsh-session'
import type {TaskRun} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {readSessionEvents} from './session-events.ts'
import {observeTaskRunTimeline} from './task-run-observation.ts'
import type {TaskRunRuntimeLinks,TaskRunRuntimeLink} from '@teloa/backend'
type TaskRunJobLink=Extract<TaskRunRuntimeLink,{kind:'job'}>

type Binding=Pick<TaskRun,'id'|'sessionId'|'nativeRequestId'>
type TextBinding=Binding&Partial<Pick<TaskRun,'allowedTools'|'skills'|'stopRequestedAt'|'groupContext'|'flowId'|'subagents'>>
const live=(status:JobStatus)=>status==='running'||status==='stopping'
/** 同一宿主的 root 与 Team 适配共享世代；进程重启才变化。 */
export const taskRunRuntimeId=randomUUID()
/** 空权限必须来自固定 Run 快照；缺失字段不能当作未授权后台能力。 */
export function isTextOnlyTaskRun(run:TextBinding):boolean{
 return Array.isArray(run.allowedTools)&&run.allowedTools.length===0&&Array.isArray(run.skills)&&run.skills.length===0&&run.stopRequestedAt===null&&run.groupContext===undefined&&run.flowId===undefined&&(run.subagents===undefined||Array.isArray(run.subagents)&&run.subagents.length===0)
}
/** 这里只提供旧世代纯文本候选；完整原生完成轮仍由驱动核验，不能据 owner 单独收口。 */
export function isOwnerOnlyTextRun(run:TextBinding,rows:readonly TaskRunRuntimeLink[],runtimeId:string=taskRunRuntimeId):boolean{
 if(!isTextOnlyTaskRun(run)||!Array.isArray(run.subagents)||run.subagents.length!==0||rows.length!==1)return false
 const row=rows[0]!
 return row.kind==='job'&&row.payload.record==='owner'&&row.runId===run.id&&row.sessionId===run.sessionId&&row.payload.requestId===run.nativeRequestId&&row.payload.runtimeId!==runtimeId&&row.nativeId==='owner:'+row.payload.runtimeId+':'+run.sessionId
}
/** RC 的 Session.append 无法持久化外部 ignorable 事件，业务关联因此经窄端口落库。 */
export function createTaskRunBackground(ctx:Context,links:TaskRunRuntimeLinks,admit?:(run:Binding)=>boolean,runtimeId:string=taskRunRuntimeId){
 const bindings=new Map<string,Binding>(),pending=new Map<string,Promise<void>>()
 const recorded=new Map<string,JobStatus>(),failed=new Set<string>()
 const agentFor=(sessionId:string)=>{
  const agent=ctx.agents.get(SessionId(sessionId))
  if(!agent)throw new WorkError('teloa/session-unavailable','后台工作所属会话暂不可用。')
  return agent
 }
 const bind=(run:Binding)=>{
  const previous=bindings.get(run.sessionId)
  if(previous&&(previous.id!==run.id||previous.nativeRequestId!==run.nativeRequestId))throw new WorkError('teloa/storage-corrupt','后台工作会话已经属于另一条执行。')
  bindings.set(run.sessionId,{id:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId})
 }
 const journal=async(run:Binding)=>{
  const all=await links.list({runId:run.id})
  const rows=all.filter((row):row is TaskRunJobLink=>row.kind==='job'&&row.sessionId===run.sessionId)
  if(rows.some(row=>row.runId!==run.id||row.payload.requestId!==run.nativeRequestId))throw new WorkError('teloa/storage-corrupt','后台工作归属记录与执行不一致。')
  return {all,rows}
 }
 const record=(job:JobView)=>{
  if(job.owner===undefined)return
  const run=bindings.get(job.owner)
  if(!run)return
  const key=run.sessionId+':'+job.id,previous=recorded.get(key)
  if(previous===job.status)return
  if(previous===undefined&&!(admit?.(run)??observeTaskRunTimeline(readSessionEvents(agentFor(run.sessionId).session),run.nativeRequestId).authorized))return
  recorded.set(key,job.status)
  const prior=pending.get(run.sessionId)??Promise.resolve()
  const next=prior.then(()=>links.put({runId:run.id,kind:'job',nativeId:runtimeId+':'+job.id,sessionId:run.sessionId,payload:{record:'job',runtimeId,requestId:run.nativeRequestId,jobId:job.id,status:job.status}}))
  pending.set(run.sessionId,next)
  next.catch(()=>failed.add(run.sessionId))
 }
 const dispose=ctx.jobs.events.subscribe({owners:'all'},event=>{
  if(event.type==='registered'||event.type==='stopping'||event.type==='settled'){
   try{record(event.job)}catch{if(event.job.owner!==undefined)failed.add(event.job.owner)}
  }
 })
 return {
  bind,
  async start(run:Binding):Promise<void>{
   // 先留进程世代，再允许外部工作出现；突然崩溃不会把遗漏状态写入伪装成完成。
   await links.put({runId:run.id,kind:'job',nativeId:'owner:'+runtimeId+':'+run.sessionId,sessionId:run.sessionId,payload:{record:'owner',runtimeId,requestId:run.nativeRequestId}})
   bind(run)
  },
  dispose,
  async state(run:TextBinding):Promise<{outstanding:boolean;interrupted:boolean;ownerOnly?:true}>{
   bind(run)
   const agent=ctx.agents.get(SessionId(run.sessionId))
   const jobs=ctx.jobs.list(SessionId(run.sessionId)).filter(job=>job.owner===run.sessionId)
   for(const job of jobs)record(job)
   await pending.get(run.sessionId)
   if(failed.has(run.sessionId))throw new WorkError('teloa/storage-corrupt','后台工作归属记录未写入，请核对执行。')
   const {all,rows}=await journal(run)
   const interrupted=rows.some(row=>{const payload=row.payload;return payload.runtimeId!==runtimeId||(payload.record==='job'&&live(payload.status)&&!jobs.some(job=>job.id===payload.jobId))})
   return {outstanding:jobs.some(job=>live(job.status)&&rows.some(row=>row.payload.record==='job'&&row.payload.runtimeId===runtimeId&&row.payload.jobId===job.id))||agent?.status==='running'||(agent?.inbox.nextTurn.length??0)>0||(agent?.inbox.nextStep.length??0)>0,interrupted,...(jobs.length===0&&isOwnerOnlyTextRun(run,all,runtimeId)?{ownerOnly:true as const}:{})}
  },
  async cancel(run:Binding,signal:AbortSignal):Promise<void>{
   bind(run);signal.throwIfAborted();await pending.get(run.sessionId)
   const {rows}=await journal(run)
   for(const job of ctx.jobs.list(SessionId(run.sessionId))){
    if(job.owner!==run.sessionId||!live(job.status)||!rows.some(row=>row.payload.record==='job'&&row.payload.runtimeId===runtimeId&&row.payload.jobId===job.id))continue
    signal.throwIfAborted();ctx.jobs.kill(job.id,SessionId(run.sessionId),'Teloa 任务已请求停止。')
   }
  },
 }
}
