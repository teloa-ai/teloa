import {isDeepStrictEqual} from 'node:util'
import {taskInputWithoutMemory} from './task-memory-input.ts'
import {verifiedAnalysisRun} from './task-run-analysis.ts'
import type {TaskExecutionScope,TaskRun,TaskRunService,TaskRunSkillDatabase,TaskRunSubagent} from '@teloa/backend'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {WorkError,type RoleRuntimeConfig,type TaskRunModelPolicy,type WorkControl} from '@teloa/contract'
import {observeTaskRun,isTaskRunReconcileEndReason,type TaskRunObservation} from './task-run-observation.ts'
import {readTaskRunGroupResult} from './task-run-group-result.ts'
import {taskRunPlanReportOccurrence} from './task-run-group-publisher.ts'
import {isTextOnlyTaskRun} from './task-run-background.ts'
import {deliveryReviewSource,deliveryReviewToolName} from './task-delivery-review.ts'
import type {GoalObservationContext,ModelReference} from '@teloa/contract'
import type {EmployeePermissionMode} from '../../sdk/contract.mjs'

export const roleRunNoExecutionToolsReason='role-run-no-execution-tools'
/**
 * 员工运行真正能“做事”的工具。
 * `allowedTools` 只来自岗位工具授权：群表情/提及、记忆提议、小结提交这些自授权辅助工具从不写进这里
 * （授权校验拒绝它们）。清单为空不授予外部执行，可信分析范围另由后端固定；工具守卫仍是最终闸。
 */
export function roleRunExecutionTools(run:Pick<TaskRun,'allowedTools'>):string[]{
 return [...(run.allowedTools??[])]
}
/**
 * 哪些运行必须带执行工具：本人运行由宿主自己装配工具；群交流回应（v2 来源 executionMode=reply）
 * 以及后端已核验的显式受限文本能力或来源派生分析范围，按设计冻结空工具集，只生成正文。
 * 没有可信分析依据的普通员工运行，仍须具备实际执行工具才能启动。
 */
export function roleRunRequiresExecutionTools(run:Pick<TaskRun,'executor'|'groupContext'|'textCapability'|'analysisScope'>):boolean{
 // 仅消费后端 get/readVerified 已核对的持久范围；控制、claim 与发送前闸仍逐一执行。
 if(run.textCapability!==undefined||run.analysisScope!==undefined)return false
 if(run.executor?.kind==='owner')return false
 return true
}
/** 启动前的空工具闸：缺执行工具时停在本方准入处并给出可操作提示，不能把空目录交给模型。 */
export function assertRoleRunToolsRunnable(run:Pick<TaskRun,'executor'|'groupContext'|'allowedTools'|'textCapability'|'analysisScope'>):void{
 if(!roleRunRequiresExecutionTools(run)||roleRunExecutionTools(run).length)return
 throw new WorkError('teloa/conflict','这名员工还没有可用的执行工具，已阻止启动。请先在员工详情打开工具授权，为该员工保存要用的工具，再撤回本次准备并重新准备执行。',{reason:roleRunNoExecutionToolsReason})
}

/** 恢复例外只认固定单轮纯文本或本 Run 正式复核；其他工具、后台续轮与子级均拒绝。 */
function completedTextRun(run:TaskRun,events:readonly SessionEvent[],observed:TaskRunObservation):boolean{
 if(observed.state!=='ended'||observed.reason!=='completed')return false
 const {turn,messageSeq,endSeq}=observed,end=events[endSeq]
 if(end?.type!=='turn/end'||end.data.turn!==turn)return false
 const start=[...events.slice(0,messageSeq)].reverse().find(event=>event.type==='turn/start')
 if(start?.type!=='turn/start'||start.data.turn!==turn)return false
 const reviewed=run.executor?.kind==='owner'&&run.stopRequestedAt===null&&run.groupContext===undefined&&run.flowId===undefined&&(run.subagents===undefined||run.subagents.length===0)&&readTaskRunGroupResult(events,run.nativeRequestId,undefined,undefined,{requireReview:true,runId:run.id})!==undefined
 if(!isTextOnlyTaskRun(run)&&!reviewed)return false
 const receipt=reviewed?events.slice(start.seq,endSeq).reverse().find(event=>event.type==='user/message'&&event.data.source.kind===deliveryReviewSource):undefined
 const callIds=new Set(receipt?.type==='user/message'&&receipt.data.source.kind===deliveryReviewSource?receipt.data.source.rounds?.flatMap(round=>round.units.flatMap(unit=>unit.callId?[unit.callId]:[])):[])
 const reviewCall=(id:string,name:string|undefined)=>reviewed&&name===deliveryReviewToolName&&callIds.has(id)
 let answer=false
 for(const event of events.slice(start.seq,endSeq+1)){
  if(event.type.startsWith('team/')||event.type.startsWith('subagent/'))return false
  if(event.type==='tool/call'){if(!reviewCall(event.data.callId,event.data.name))return false}
  else if(event.type==='tool/result'){if(!reviewed||!callIds.has(event.data.message.toolCallId))return false}
  else if(event.type.startsWith('tool/'))return false
  if(event.type==='user/message'){
   const source:string=event.data.source.kind
   if(event.seq!==messageSeq&&source!=='agent-instructions'&&source!=='runtime-context'&&!(reviewed&&source===deliveryReviewSource&&Reflect.get(event.data.source,'runId')===run.id))return false
   if(event.data.content.some(block=>block.type!=='text'))return false
  }else if(event.type==='assistant/message'){
   if(event.data.interrupted===true||event.data.stream.some(chunk=>chunk.type==='tool-call-chunks'&&!reviewCall(chunk.id,chunk.name)))return false
   if(event.data.message.content.some(block=>block.type!=='text'&&block.type!=='reasoning'&&!(block.type==='tool-call'&&reviewCall(block.id,block.name))))return false
   answer ||= event.surfaceOp==='append'&&event.data.turn===turn&&event.data.message.content.some(block=>block.type==='text'&&block.text.trim().length>0)
  }else if(event.type==='assistant/attempt'&&event.data.stream.some(chunk=>chunk.type==='tool-call-chunks'&&!reviewCall(chunk.id,chunk.name)))return false
 }
 return answer
}

export type TaskRunPorts={
 interaction?:(sessionId:string,signal:AbortSignal)=>Promise<{sessionId:string;available:boolean}>
 openInteraction?:(run:TaskRun,signal:AbortSignal)=>Promise<void>
 /** 持久提交协议：只有宿主在关闭原生发布回调后签收的未发布记录才可恢复。 */
 submissions?:import('@teloa/backend').TaskRunSubmissionJournal
 withAcceptedInboxFailureFence?:<T>(run:TaskRun,signal:AbortSignal,work:(fence:import('@teloa/backend').AcceptedInboxErrorFence)=>Promise<T>)=>Promise<T|null>
 withSubmissionFence?:<T>(run:TaskRun,signal:AbortSignal,work:(fence:import('@teloa/backend').TaskRunSubmissionFence)=>Promise<T>)=>Promise<T>
 cancelNotPublishedSubmission?:(run:TaskRun,signal:AbortSignal)=>Promise<TaskRun>
 disposeSubmission?:(run:TaskRun,input:unknown,signal:AbortSignal)=>Promise<TaskRun>
 /** 仅后端同源续报账本可授予原会话接续资格，不能来自客户端参数。 */
 sourceContinuation?:(run:TaskRun)=>Promise<TaskRun|null>
 sourceFollowup?:(run:TaskRun)=>Promise<TaskRun|null>
 inspectSourceFollowup?:(run:TaskRun,signal:AbortSignal)=>Promise<void>
 /** 仅已核验同源终态或显式未知核验或失败后新确认的宿主续办流程可退役旧资源槽；保留持久归属。 */
 prepareContinuation?:(run:TaskRun,signal:AbortSignal,proof?:{unknownVerification:true}|{errorRecovery:true}|{stoppedContinuation:true})=>Promise<void>
 /** 旧轮已收尾后释放其受管技能作用域；不能清除历史或执行记录。 */
 releaseRunSkills?:(run:TaskRun,signal:AbortSignal)=>Promise<void>
 /** 本人普通交办的不可变原文投影；必须经正式 ledger 与固定原生消息核验。 */
 ownerReviewSource?:(run:TaskRun,signal:AbortSignal)=>Promise<Awaited<ReturnType<TaskRunService['ownerReviewSource']>>>
 /** 正式会话交办的同源投影；null 仅表示原 Task 确实没有会话父交办。 */
 conversationReviewSource?:(run:TaskRun,signal:AbortSignal)=>Promise<Awaited<ReturnType<TaskRunService['conversationReviewSource']>>>
 /** 结束后恢复同一候选的幂等保存；不能重新向模型发送。 */
 publishOwnerResult?:(run:TaskRun)=>Promise<void>
 prepareOwnerPolicy?:(sessionId:string,agentPresetId:string,signal:AbortSignal,target:TaskExecutionScope)=>Promise<{allowedTools:readonly string[];argumentRules?:import('@teloa/contract').TaskToolArgumentRule[];knowledge?:TaskRun['knowledge']}>
 /** 真实持久 round/definition 状态；暂停不把原生取消结束倒推为业务终态。 */
 controlState?:(run:TaskRun)=>Promise<WorkControl['state']>
 /** 原失败轮的显式重试预检，必须先于新会话、准备和领取。 */
 prepareRetry?:(run:TaskRun,signal:AbortSignal)=>Promise<void>
 stableStart?:<T>(operation:()=>Promise<T>)=>Promise<T>
 resolvePreset?:(agentPresetId:undefined|string,signal:AbortSignal)=>Promise<string>
 prepareSession?:(sessionId:string,agentPresetId:undefined|string,signal:AbortSignal,permissionMode?:EmployeePermissionMode)=>Promise<string>
 /** 请求级权限模式与模型只在准备时核对；缺席表示旧宿主不提供该能力。 */
 checkPermissionMode?:(permissionMode:EmployeePermissionMode,signal:AbortSignal)=>Promise<void>
 checkModel?:(model:ModelReference,signal:AbortSignal)=>Promise<void>
 prepareModels?:(runtime:RoleRuntimeConfig|undefined,signal:AbortSignal)=>Promise<TaskRunModelPolicy>
 /** `roleId` 只供复核时补读岗位自身范围；缺席时知识复核退回任务范围。 */
 check:(run:Pick<TaskRun,'sessionId'>&{previousRun?:TaskRun}&Partial<Pick<TaskRun,'id'|'modelPolicy'|'permissionMode'|'taskId'|'taskVersion'|'linkVersion'|'agentPresetId'|'roleId'|'skills'|'knowledge'|'inputText'>>,signal:AbortSignal,target?:TaskExecutionScope)=>Promise<void>
 /** `roleScopes` 只在通用范围任务里把主体范围并上岗位自身范围；拿不到岗位时省略，退回任务范围。 */
 loadKnowledge?:(target:TaskExecutionScope,ids:readonly string[],signal:AbortSignal,roleScopes?:readonly string[],database?:TaskRunSkillDatabase)=>Promise<TaskRun['knowledge']>
 loadSkills?:(sessionId:string,names:readonly string[],signal:AbortSignal,database?:TaskRunSkillDatabase,industryInstallationIds?:readonly string[])=>Promise<TaskRun['skills']>
 send:(run:TaskRun,signal:AbortSignal,target:TaskExecutionScope)=>Promise<void>
 stop:(run:TaskRun,signal:AbortSignal)=>Promise<void>
 /** 收口前核对子级是否已结项；读口失败保持未结清，不妨碍先请求取消。 */
 subagentState?:(run:TaskRun,signal:AbortSignal)=>Promise<'none'|'outstanding'>
 /** 本人原 Run 的既有子调用登记；正式复核再与官方子会话固定归属和终态核对。 */
 reviewSubagents?:(run:TaskRun,signal:AbortSignal)=>Promise<readonly TaskRunSubagent[]>
 /** 显式复核失败重试只读原 fresh child 完整事件；不恢复 Agent、不复用复核摘要判断副作用。 */
 retryChildInspection?:(run:TaskRun,childSessionId:string,signal:AbortSignal)=>Promise<import('./task-run-review-retry-proof.ts').RetryChildInspection>
 /** 官方后台工作及排队的官方续轮尚未结清时，Run 必须保持 active。 */
 backgroundState?:(run:TaskRun)=>Promise<{outstanding:boolean;interrupted:boolean;ownerOnly?:boolean;reviewOnly?:boolean;cancelled?:boolean}>
 /** 仅显式 retry 已证实零输出/零工具的失败轮可消费；不能替代后台完成判据。 */
 retryOwnerOnlyBackground?:(run:TaskRun,signal:AbortSignal)=>Promise<boolean>
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
 /** 仅宿主诊断读取原异常；不把传输细节回传客户端，也不触发重发。 */
 onSubmissionError?:(run:TaskRun,error:unknown)=>void
 /** 返回经身份核验、落盘后复制的完整日志，不能用当前压缩表面代替。 */
 events:(run:TaskRun)=>Promise<readonly SessionEvent[]>
 /** 仅由宿主调用；正文来自已确认的原生助手消息，服务端会再次核验群授权。 */
 publishGroupResult?:(run:TaskRun,text:string)=>Promise<void>
}
export class TaskRunDriver{
 readonly service:Pick<TaskRunService,'get'|'executionScope'|'claim'|'record'|'requestStop'> & {recordAcceptedInboxFailure?:TaskRunService['recordAcceptedInboxFailure'];settleDeferred?:TaskRunService['settleDeferred'];isSystemDigestRun?:(owner:string,input:unknown)=>Promise<boolean>;isGroupReplyRun?:(owner:string,input:unknown)=>Promise<boolean>;isAnalysisRun?:(owner:string,input:unknown)=>Promise<boolean>};readonly ports:TaskRunPorts
 constructor(service:Pick<TaskRunService,'get'|'executionScope'|'claim'|'record'|'requestStop'> & {recordAcceptedInboxFailure?:TaskRunService['recordAcceptedInboxFailure'];settleDeferred?:TaskRunService['settleDeferred'];isSystemDigestRun?:(owner:string,input:unknown)=>Promise<boolean>;isGroupReplyRun?:(owner:string,input:unknown)=>Promise<boolean>;isAnalysisRun?:(owner:string,input:unknown)=>Promise<boolean>},ports:TaskRunPorts){this.service=service;this.ports=ports}
 start(owner:string,input:unknown,signal:AbortSignal):Promise<TaskRun>{
  const operation=()=>this.startStable(owner,input,signal)
  return this.ports.stableStart?this.ports.stableStart(operation):operation()
 }
 private async startStable(owner:string,input:unknown,signal:AbortSignal):Promise<TaskRun>{
  signal.throwIfAborted()
  const current=await this.service.get(owner,input)
  const recovering=current.state==='submitting'&&await this.ports.submissions?.recoverable(current)===true
  if(current.state!=='prepared'&&!recovering)return current
  // AutoDream 每日小结只用自授权证据/提交工具：按谱系里的计划身份只读核实来源后豁免空执行工具闸；
  // 找不到来源、旧装配或读失败一律按普通运行处理（继续拦截）。
  const planId=current.lineage?.definition?.planId
  const systemDigest=typeof planId==='string'?await this.service.isSystemDigestRun?.(owner,{planId})??false:false
  // 新reply也冻结本人限制，不能再以ownerRequest缺失猜模式；只读口未接或校验失败时不放宽工作运行。
  const groupReply=current.groupContext!==undefined&&await this.service.isGroupReplyRun?.(owner,{runId:current.id})===true
  await verifiedAnalysisRun(current,signal,this.service.isAnalysisRun?async run=>this.service.isAnalysisRun!(owner,{runId:run.id}):undefined)
  if(!systemDigest&&!groupReply)assertRoleRunToolsRunnable(current)
  if(current.lineage&&await this.ports.controlState?.(current)!=='active')throw new WorkError('teloa/forbidden','原工作已暂停或停止，请先核对恢复。',{reason:'work-control-inactive'})
  const target=await this.service.executionScope(owner,input)
  await this.ports.check(current,signal,target)
  signal.throwIfAborted()
  // 恢复保持原 Run/输入/任务状态版本；发送口的持久 CAS 只允许一个尝试领取。
  const claimed=recovering?{run:current,dispatch:true,target}:await this.service.claim(owner,input)
  if(!claimed.dispatch)return claimed.run
  try{
   if(!claimed.target)throw new WorkError('teloa/storage-corrupt','执行发送权缺少可信任务关联。')
   await this.ports.send(claimed.run,signal,claimed.target)
   const accepted=await this.service.record(owner,{runId:claimed.run.id,sessionId:claimed.run.sessionId,nativeRequestId:claimed.run.nativeRequestId,evidence:{state:'accepted'}})
   try{this.ports.onAccepted?.(accepted)}catch{/* 通知失败不影响已接受的执行 */}
   return accepted
  }catch(error){
   try{this.ports.onSubmissionError?.(claimed.run,error)}catch{/* 诊断失败不改变提交未知语义 */}
   // 包括发送前取消、回包丢失及已接收但数据库回填失败；一律不自动重发。
   // 仍在原宿主时优先落定可核验的原生日志与后台收口，避免把已有证据留到重启后猜测。
   // 核验失败保持提交未知；不能用失败的读取或旧 owner 标记推断完成。
   await this.reconcileSubmission(owner,claimed.run.id,signal)
   const pending=new WorkError('teloa/execution-pending','执行提交结果需要核对，请读取原生会话状态；不要重复发送。')
   Object.defineProperty(pending,'cause',{value:error,configurable:true})
   throw pending
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
 if(run.state==='ended'||run.state==='withdrawn'||run.state==='configuration_failed'||run.state==='submission_unknown')return run
 if(run.state==='prepared')throw new WorkError('teloa/conflict','本次执行尚未提交。')
  // 先落停止意图再递交取消：取消回执只代表"请求已递交"，落库这一步才让停止在刷新后仍可见、
  // 也让后台循环有可判别的重发依据。幂等，重复停止不覆盖首次时间。
  const requested=await this.service.requestStop(owner,{runId:run.id})
  if(requested.state==='submitting'&&this.ports.cancelNotPublishedSubmission&&await this.ports.submissions?.publicationState?.(requested)==='not-published')return this.ports.cancelNotPublishedSubmission(requested,signal)
  // 先阻止新派发；即使父轮已经空闲，也必须取消已登记子级与后台工作。
  const cancellations=await Promise.allSettled([this.ports.stop(requested,signal),this.ports.stopChildren?.(requested,signal)])
  const failed=cancellations.find(result=>result.status==='rejected')
  if(failed?.status==='rejected')throw failed.reason
  return this.reconcile(owner,input)
 }
 async reconcile(owner:string,input:unknown,signal?:AbortSignal):Promise<TaskRun>{
  signal?.throwIfAborted()
  let run=await this.service.get(owner,input)
  signal?.throwIfAborted()
  if(run.state==='prepared'||run.state==='withdrawn'||run.state==='configuration_failed'||run.state==='submission_unknown')return run
  // 已落定证据不可被迟到通知改写；交付失败仍能按同一终态重试既有幂等发布器。
  if(run.state==='ended'&&run.evidence?.state==='ended'){
   // 新error的owner/零派发额度已与Run同事务落定；历史reconcile不重新占writer或结算。
   // 暂停只允许读取既有终态；不能借再次对账触发成果交付或流程推进。
   if(run.lineage&&!run.evidence.inputAnchor&&isTaskRunReconcileEndReason(run.evidence.reason)&&(run.evidence.reason==='completed'||run.stopRequestedAt==null)){
    const control=await this.ports.controlState?.(run)
    signal?.throwIfAborted()
    if(control!=='active'||!this.service.settleDeferred)return run
    const settlement=await this.service.settleDeferred(owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:run.evidence})
    signal?.throwIfAborted()
    run=settlement.run
    if(settlement.disposition==='inapplicable')return run
   }
   if(run.state!=='ended'||run.evidence?.state!=='ended')throw new WorkError('teloa/conflict','终态结算返回了不同状态。')
   if(run.executor?.kind==='owner'&&run.evidence.reason==='completed')await this.ports.publishOwnerResult?.(run)
   if((run.groupContext||taskRunPlanReportOccurrence(run))&&run.evidence.reason==='completed'){
    const events=(await this.ports.events(run)).slice(0,run.evidence.endSeq+1)
    signal?.throwIfAborted()
    const text=readTaskRunGroupResult(events,run.nativeRequestId,await this.ports.continuations?.(run,events),await this.ports.goalObservation?.(run,events))
    signal?.throwIfAborted()
    await this.ports.publishGroupResult?.(run,text??'')
   }
   return run
  }
  // 只有具备新证明端口的accepted候选延后背景聚合；提交未知等旧路径保持原读取/取消顺序。
  const inboxFailureCandidate=run.state==='accepted'&&this.ports.withAcceptedInboxFailureFence!==undefined&&this.service.recordAcceptedInboxFailure!==undefined
  let background=inboxFailureCandidate?undefined:await this.ports.backgroundState?.(run)
  signal?.throwIfAborted()
  const events=await this.ports.events(run)
  signal?.throwIfAborted()
  const continuations=await this.ports.continuations?.(run,events)
  signal?.throwIfAborted()
  const goal=await this.ports.goalObservation?.(run,events)
  signal?.throwIfAborted()
  let observed=observeTaskRun(events,run.nativeRequestId,continuations,goal)
  if(observed.state==='ended'&&observed.reason==='forked')return run
  if(observed.state==='unobserved'){
   if(run.state!=='accepted'||!this.ports.withAcceptedInboxFailureFence||!this.service.recordAcceptedInboxFailure)return run
   return await this.ports.withAcceptedInboxFailureFence(run,signal??new AbortController().signal,fence=>this.service.recordAcceptedInboxFailure!(owner,fence))??run
  }
  // 预消息失败由独占原生证明核实全部后台关联；先走旧Team历史口会拒绝accepted冷Run。
  // 普通已观察轮继续使用完整背景/Team/编排聚合，不能借此跳过活动或未知检查。
  if(inboxFailureCandidate)background=await this.ports.backgroundState?.(run)
  signal?.throwIfAborted()
  const control=await this.ports.controlState?.(run)
  signal?.throwIfAborted()
  // 暂停仍阻止执行和交付，但不能掩盖已完成的原生轮。例外只做同 Run 的终态记账：
  // 固定 active 锚点、完整单轮及唯一 owner 后台回执全部重验；缺少任何读口或安全证明仍保持原状态。
  if((control==='pausing'||control==='paused')&&run.stopRequestedAt==null){
   const active=run.evidence,message=observed.state==='ended'?events[observed.messageSeq]:undefined
   const input=message?.type==='user/message'?message.data.content[0]:undefined
   const boundary=[...events].reverse().find(event=>event.type==='turn/start'||event.type==='turn/end')
   if(run.state!=='active'||active?.state!=='active'||observed.state!=='ended'||!isTaskRunReconcileEndReason(observed.reason)||observed.turn!==active.turn||observed.messageSeq!==active.messageSeq||boundary?.type!=='turn/end'||boundary.seq!==observed.endSeq||message?.type!=='user/message'||message.data.content.some(block=>block.type!=='text')||input?.type!=='text'||![run.inputText,taskInputWithoutMemory(run.inputText)].includes(input.text)||goal!==undefined||(continuations?.size??0)!==0||background?.outstanding!==false||!this.ports.subagentState||!this.ports.flowState||!this.ports.retryOwnerOnlyBackground)return run
   const observationSignal=signal??new AbortController().signal
   if(await this.ports.subagentState(run,observationSignal)!=='none'||await this.ports.flowState(run)!=='none')return run
   observationSignal.throwIfAborted()
   // 该既有端口只读核对唯一精确 owner、无 Job/外部关联/待通知及空闲 Agent；不执行 retry。
   if(!await this.ports.retryOwnerOnlyBackground(run,observationSignal))return run
   const currentEvents=await this.ports.events(run)
   observationSignal.throwIfAborted()
   if(!isDeepStrictEqual(events,currentEvents)||await this.ports.controlState?.(run)!==control)return run
   observationSignal.throwIfAborted()
   if((await this.ports.backgroundState?.(run))?.outstanding!==false||await this.ports.subagentState(run,observationSignal)!=='none'||await this.ports.flowState(run)!=='none'||!await this.ports.retryOwnerOnlyBackground(run,observationSignal))return run
   observationSignal.throwIfAborted()
   return this.service.record(owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:observed},{deferSettlement:true})
  }
  const children=await this.ports.subagentState?.(run,signal??new AbortController().signal)
  signal?.throwIfAborted()
  const outstanding=background?.outstanding===true||children==='outstanding'
  const flowPending=run.stopRequestedAt==null&&control!=='stopping'&&control!=='stopped'&&observed.state==='ended'&&await this.ports.flowState?.(run)==='outstanding'
  signal?.throwIfAborted()
  if((outstanding||flowPending)&&observed.state==='ended')observed={state:'active',turn:observed.turn,messageSeq:observed.messageSeq}
  // 旧 owner 只证明宿主世代变化。完整纯文本或严格核过本 Run 全部复核工具回执的单轮，仍以原生结尾为准。
  const textCompletion=goal===undefined&&(background?.ownerOnly===true||background?.reviewOnly===true)&&(continuations?.size??0)===0&&completedTextRun(run,events,observed)
  // 唯一 owner 无 Job/外部工作时保留可信失败原因；真实后台丢失仍沿原判据记中断，未完成 Goal 不借此结束。
  const failureOwner=background?.interrupted===true&&observed.state==='ended'&&observed.reason!=='completed'&&isTaskRunReconcileEndReason(observed.reason)&&run.stopRequestedAt==null&&goal===undefined&&(continuations?.size??0)===0&&!outstanding&&!flowPending&&children==='none'&&this.ports.flowState!==undefined&&await this.ports.flowState(run)==='none'&&await this.ports.retryOwnerOnlyBackground?.(run,signal??new AbortController().signal)===true
  if(!outstanding&&!flowPending&&background?.interrupted===true&&!textCompletion&&!failureOwner&&(observed.state==='ended'||goal===undefined))observed={state:'ended',turn:observed.turn,messageSeq:observed.messageSeq,endSeq:events.length-1,reason:'interrupted'}
  // 停止后同 Run 的真实 Job 被取消时，初轮完成只代表占位回复；必须等待宿主冻结来核实收口。
  if(!outstanding&&background?.cancelled===true&&run.stopRequestedAt!=null&&observed.state==='ended'&&observed.reason==='completed')observed={state:'active',turn:observed.turn,messageSeq:observed.messageSeq}
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
  if((saved.groupContext||taskRunPlanReportOccurrence(saved))&&observed.state==='ended'&&observed.reason==='completed'){
   const text=readTaskRunGroupResult(events,saved.nativeRequestId,continuations,goal)
   await this.ports.publishGroupResult?.(saved,text??'')
  }
  return saved
 }
}
