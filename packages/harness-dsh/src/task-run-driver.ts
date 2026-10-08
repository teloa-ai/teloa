import type {TaskExecutionScope,TaskRun,TaskRunService,TaskRunSkillDatabase} from '@teloa/backend'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {WorkError,type RoleRuntimeConfig,type TaskRunModelPolicy,type WorkControl} from '@teloa/contract'
import {observeTaskRun,type TaskRunObservation} from './task-run-observation.ts'
import {readTaskRunGroupResult} from './task-run-group-result.ts'
import {isTextOnlyTaskRun} from './task-run-background.ts'
import type {GoalObservationContext} from '@teloa/contract'

/** 恢复例外只认固定单轮的纯文本完成证据；后台续轮及工具/子级迹象都保守拒绝。 */
function completedTextRun(run:TaskRun,events:readonly SessionEvent[],observed:TaskRunObservation):boolean{
 if(!isTextOnlyTaskRun(run)||observed.state!=='ended'||observed.reason!=='completed')return false
 const {turn,messageSeq,endSeq}=observed,end=events[endSeq]
 if(end?.type!=='turn/end'||end.data.turn!==turn)return false
 const start=[...events.slice(0,messageSeq)].reverse().find(event=>event.type==='turn/start')
 if(start?.type!=='turn/start'||start.data.turn!==turn)return false
 let answer=false
 for(const event of events.slice(start.seq,endSeq+1)){
  if(event.type.startsWith('tool/')||event.type.startsWith('team/')||event.type.startsWith('subagent/'))return false
  if(event.type==='user/message'){
   const source:string=event.data.source.kind
   if(event.seq!==messageSeq&&source!=='agent-instructions'&&source!=='runtime-context')return false
   if(event.data.content.some(block=>block.type!=='text'))return false
  }else if(event.type==='assistant/message'){
   if(event.data.interrupted===true||event.data.stream.some(chunk=>chunk.type==='tool-call-chunks'))return false
   if(event.data.message.content.some(block=>block.type!=='text'&&block.type!=='reasoning'))return false
   answer ||= event.surfaceOp==='append'&&event.data.turn===turn&&event.data.message.content.some(block=>block.type==='text'&&block.text.trim().length>0)
  }else if(event.type==='assistant/attempt'&&event.data.stream.some(chunk=>chunk.type==='tool-call-chunks'))return false
 }
 return answer
}

export type TaskRunPorts={
 /** 真实持久 round/definition 状态；暂停不把原生取消结束倒推为业务终态。 */
 controlState?:(run:TaskRun)=>Promise<WorkControl['state']>
 stableStart?:<T>(operation:()=>Promise<T>)=>Promise<T>
 resolvePreset?:(agentPresetId:undefined|string,signal:AbortSignal)=>Promise<string>
 prepareSession?:(sessionId:string,agentPresetId:undefined|string,signal:AbortSignal)=>Promise<string>
 prepareModels?:(runtime:RoleRuntimeConfig|undefined,signal:AbortSignal)=>Promise<TaskRunModelPolicy>
 /** `roleId` 只供复核时补读岗位自身范围；缺席时知识复核退回任务范围。 */
 check:(run:Pick<TaskRun,'sessionId'>&Partial<Pick<TaskRun,'id'|'modelPolicy'|'taskId'|'taskVersion'|'linkVersion'|'agentPresetId'|'roleId'|'skills'|'knowledge'|'inputText'>>,signal:AbortSignal,target?:TaskExecutionScope)=>Promise<void>
 /** `roleScopes` 只在通用范围任务里把主体范围并上岗位自身范围；拿不到岗位时省略，退回任务范围。 */
 loadKnowledge?:(target:TaskExecutionScope,ids:readonly string[],signal:AbortSignal,roleScopes?:readonly string[],database?:TaskRunSkillDatabase)=>Promise<TaskRun['knowledge']>
 loadSkills?:(sessionId:string,names:readonly string[],signal:AbortSignal,database?:TaskRunSkillDatabase,industryInstallationIds?:readonly string[])=>Promise<TaskRun['skills']>
 send:(run:TaskRun,signal:AbortSignal,target:TaskExecutionScope)=>Promise<void>
 stop:(run:TaskRun,signal:AbortSignal)=>Promise<void>
 /** 收口前核对子级是否已结项；读口失败保持未结清，不妨碍先请求取消。 */
 subagentState?:(run:TaskRun,signal:AbortSignal)=>Promise<'none'|'outstanding'>
 /** 官方后台工作及排队的官方续轮尚未结清时，Run 必须保持 active。 */
 backgroundState?:(run:TaskRun)=>Promise<{outstanding:boolean;interrupted:boolean;ownerOnly?:boolean}>
 /** 持久工作步骤尚待回执；业务等待不属于原生活动，不阻塞暂停/结束收尾。 */
 flowState?:(run:TaskRun)=>Promise<'none'|'outstanding'>
 continuations?:(run:TaskRun,events:readonly SessionEvent[])=>Promise<ReadonlySet<string>>
 goalObservation?:(run:Pick<TaskRun,'id'|'sessionId'|'nativeRequestId'>,events:readonly SessionEvent[])=>Promise<GoalObservationContext|undefined>
 stopGoal?:(run:TaskRun)=>Promise<void>
 /** 只取消服务端登记归属本 Run 的子会话；回执不代表已经退出。 */
 stopChildren?:(run:TaskRun,signal:AbortSignal)=>Promise<void>
 /**
  * 宿主会话侧的停止读数：`running` 是宿主自报的运行状态，`settledSeq` 非空表示原生日志
  * `seq` 已冻结足够久、可据此收口。缺席这个端口时行为与从前逐字一致（只等原生 turn/end）。
  */
 stopState?:(run:TaskRun)=>Promise<{running:boolean;settledSeq:number|null}>
 /** 执行已被原生宿主接受并落库后通知（如使用统计记活动）；不影响执行结果，异常被吞掉。 */
 onAccepted?:(run:TaskRun)=>void
 /** 返回经身份核验、落盘后复制的完整日志，不能用当前压缩表面代替。 */
 events:(run:TaskRun)=>Promise<readonly SessionEvent[]>
 /** 仅由宿主调用；正文来自已确认的原生助手消息，服务端会再次核验群授权。 */
 publishGroupResult?:(run:TaskRun,text:string)=>Promise<void>
}
export class TaskRunDriver{
 readonly service:Pick<TaskRunService,'get'|'executionScope'|'claim'|'record'|'requestStop'>;readonly ports:TaskRunPorts
 constructor(service:Pick<TaskRunService,'get'|'executionScope'|'claim'|'record'|'requestStop'>,ports:TaskRunPorts){this.service=service;this.ports=ports}
 start(owner:string,input:unknown,signal:AbortSignal):Promise<TaskRun>{
  const operation=()=>this.startStable(owner,input,signal)
  return this.ports.stableStart?this.ports.stableStart(operation):operation()
 }
 private async startStable(owner:string,input:unknown,signal:AbortSignal):Promise<TaskRun>{
  signal.throwIfAborted()
  const current=await this.service.get(owner,input)
  if(current.state!=='prepared')return current
  const target=await this.service.executionScope(owner,input)
  await this.ports.check(current,signal,target)
  signal.throwIfAborted()
  const claimed=await this.service.claim(owner,input)
  if(!claimed.dispatch)return claimed.run
  try{
   if(!claimed.target)throw new WorkError('teloa/storage-corrupt','执行发送权缺少可信任务关联。')
   await this.ports.send(claimed.run,signal,claimed.target)
   const accepted=await this.service.record(owner,{runId:claimed.run.id,sessionId:claimed.run.sessionId,nativeRequestId:claimed.run.nativeRequestId,evidence:{state:'accepted'}})
   try{this.ports.onAccepted?.(accepted)}catch{/* 通知失败不影响已接受的执行 */}
   return accepted
  }catch{
   // 包括发送前取消、回包丢失及已接收但数据库回填失败；一律不自动重发。
   // 仍在原宿主时优先落定可核验的原生日志与后台收口，避免把已有证据留到重启后猜测。
   // 核验失败保持提交未知；不能用失败的读取或旧 owner 标记推断完成。
   await this.reconcileSubmission(owner,claimed.run.id,signal)
   throw new WorkError('teloa/execution-pending','执行提交结果需要核对，请读取原生会话状态；不要重复发送。')
  }
 }
 /** 就地核验仅占一个有界机会；底层不可取消的读取返回后也不能再开启迟到落库。 */
 private async reconcileSubmission(owner:string,runId:string,signal:AbortSignal):Promise<void>{
  if(signal.aborted)return
  await new Promise<void>(resolve=>{
   const controller=new AbortController()
   const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);resolve()}
   const cancel=()=>{controller.abort();finish()}
   const timer=setTimeout(cancel,1000)
   signal.addEventListener('abort',cancel,{once:true})
   // 两个分支都接住：超时/取消后底层读写仍可能完成或拒绝，不能产生未处理异常。
   void this.reconcile(owner,{runId},controller.signal).then(finish,finish)
  })
 }
 async stop(owner:string,input:unknown,signal:AbortSignal):Promise<TaskRun>{
  signal.throwIfAborted()
  const run=await this.service.get(owner,input)
 if(run.state==='ended'||run.state==='withdrawn'||run.state==='configuration_failed')return run
 if(run.state==='prepared')throw new WorkError('teloa/conflict','本次执行尚未提交。')
  // 先落停止意图再递交取消：取消回执只代表"请求已递交"，落库这一步才让停止在刷新后仍可见、
  // 也让后台循环有可判别的重发依据。幂等，重复停止不覆盖首次时间。
  const requested=await this.service.requestStop(owner,{runId:run.id})
  // 先阻止新派发；即使父轮已经空闲，也必须取消已登记子级与后台工作。
  const cancellations=await Promise.allSettled([this.ports.stop(requested,signal),this.ports.stopChildren?.(requested,signal)])
  const failed=cancellations.find(result=>result.status==='rejected')
  if(failed?.status==='rejected')throw failed.reason
  return this.reconcile(owner,input)
 }
 async reconcile(owner:string,input:unknown,signal?:AbortSignal):Promise<TaskRun>{
  signal?.throwIfAborted()
  const run=await this.service.get(owner,input)
  signal?.throwIfAborted()
  if(run.state==='prepared'||run.state==='withdrawn'||run.state==='configuration_failed')return run
  // 已落定证据不可被迟到通知改写；交付失败仍能按同一终态重试既有幂等发布器。
  if(run.state==='ended'&&run.evidence?.state==='ended'){
   if(run.groupContext){
    const events=(await this.ports.events(run)).slice(0,run.evidence.endSeq+1)
    signal?.throwIfAborted()
    const text=readTaskRunGroupResult(events,run.nativeRequestId,await this.ports.continuations?.(run,events),await this.ports.goalObservation?.(run,events))
    signal?.throwIfAborted()
    if(text)await this.ports.publishGroupResult?.(run,text)
   }
   return run
  }
  const background=await this.ports.backgroundState?.(run)
  signal?.throwIfAborted()
  const events=await this.ports.events(run)
  signal?.throwIfAborted()
  const continuations=await this.ports.continuations?.(run,events)
  signal?.throwIfAborted()
  const goal=await this.ports.goalObservation?.(run,events)
  signal?.throwIfAborted()
  let observed=observeTaskRun(events,run.nativeRequestId,continuations,goal)
  if(observed.state==='unobserved')return run
  const control=await this.ports.controlState?.(run)
  signal?.throwIfAborted()
  if(control==='pausing'||control==='paused')return run
  const children=await this.ports.subagentState?.(run,signal??new AbortController().signal)
  signal?.throwIfAborted()
  const outstanding=background?.outstanding===true||children==='outstanding'
  const flowPending=run.stopRequestedAt==null&&control!=='stopping'&&control!=='stopped'&&observed.state==='ended'&&await this.ports.flowState?.(run)==='outstanding'
  signal?.throwIfAborted()
  if((outstanding||flowPending)&&observed.state==='ended')observed={state:'active',turn:observed.turn,messageSeq:observed.messageSeq}
  // 旧 owner 只证明宿主世代变化。固定空权限且完整、无工具/子级的单个文本轮，仍以原生结尾为准。
  const textCompletion=goal===undefined&&background?.ownerOnly===true&&(continuations?.size??0)===0&&completedTextRun(run,events,observed)
  if(!outstanding&&!flowPending&&background?.interrupted===true&&!textCompletion)observed={state:'ended',turn:observed.turn,messageSeq:observed.messageSeq,endSeq:events.length-1,reason:'interrupted'}
  // 取消落在已无活跃活动的 agent 上是上游文档化的 no-op：原生 turn/end 永远不会来，只等日志
  // 就永远没有终态。三个条件同时成立才收口——记录上已有停止意图、宿主自报不在运行、日志 seq
  // 已冻结够久——并把冻结到的 seq 作为 endSeq 留作依据。少一个条件都按「还在跑」原样回填。
  // 此路径证明宿主活动已收敛；其 aborted 不能单独作为安全改派所需的原生取消结束证据。
  if(observed.state==='active'&&!outstanding&&run.stopRequestedAt!=null&&this.ports.stopState){
   const host=await this.ports.stopState(run)
   if(!host.running&&host.settledSeq!==null&&host.settledSeq>observed.messageSeq)observed={state:'ended',turn:observed.turn,messageSeq:observed.messageSeq,endSeq:host.settledSeq,reason:'aborted'}
  }
  signal?.throwIfAborted()
  const saved=await this.service.record(owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:observed})
  signal?.throwIfAborted()
  if(saved.groupContext&&observed.state==='ended'){
   const text=readTaskRunGroupResult(events,saved.nativeRequestId,continuations,goal)
   if(text)await this.ports.publishGroupResult?.(saved,text)
  }
  return saved
 }
}
