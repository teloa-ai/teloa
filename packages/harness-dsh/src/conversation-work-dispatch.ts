import {WorkError,parseResourceReferences,type WorkTask,type ResourceReference,type BusinessReassignmentReceipt,type BusinessObjectReference} from '@teloa/contract'
import type {ReassignmentRunTargets} from '@teloa/backend'
import {workRequestChildId,type ConversationWorkRequest,type ConversationWorkReserveInput,type ConversationWorkService,type TaskRun,type TaskService,type WorkRequestTarget,type ConversationTaskIdentity} from '@teloa/backend'

export type WorkMemberStatus='received'|'waiting'|'unavailable'|'failed'|'stopped'
export type ConversationWorkMember={roleId:string;name:string;scope:string;status:WorkMemberStatus;reason?:string;task?:Pick<WorkTask,'id'|'title'|'scope'|'version'|'state'|'assigneeRoleId'>;run?:Pick<TaskRun,'id'|'state'|'evidence'|'stopRequestedAt'|'sessionId'>;result?:string}
export type ConversationWorkStatus={requestId:string;sessionId:string;kind:'task'|'report';title:string;scope:string;observedAt:string;stoppedAt:string|null;counts:Record<WorkMemberStatus,number>;members:ConversationWorkMember[];reassignment?:BusinessReassignmentReceipt;sourceReference?:BusinessObjectReference}
export type ConversationWorkDispatchPorts={
 owner:string
 requests:Pick<ConversationWorkService,'reserve'|'get'|'list'|'stop'|'withDispatchLock'|'failure'|'pendingNotifications'|'notified'>
 tasks:Pick<TaskService,'request'|'create'>
 boundTasks:{request:(identity:ConversationTaskIdentity)=>Promise<WorkTask|null>;create:(identity:ConversationTaskIdentity)=>Promise<WorkTask>}
 materials?:(requestId:string,task:WorkTask,references:ResourceReference[],signal:AbortSignal)=>Promise<WorkTask>
 link:(input:{requestId:string;taskId:string;expectedTaskVersion:number;sessionId:string})=>Promise<unknown>
 runs:(taskId:string)=>Promise<TaskRun[]>
 run:(endpoint:string,input:unknown,signal:AbortSignal,parentIdentity?:ConversationTaskIdentity)=>Promise<TaskRun>
 result:(run:TaskRun)=>Promise<string|undefined>
 authorize?:(scopes:readonly string[])=>Promise<void>
 revalidate?:(request:ConversationWorkRequest,target:WorkRequestTarget,signal:AbortSignal)=>Promise<void>
 publish:(status:ConversationWorkStatus,lockSignal:AbortSignal)=>Promise<void>
 reassignment?:(request:ConversationWorkRequest)=>Promise<BusinessReassignmentReceipt|null>
 report?:(requestId:string,code:string)=>void
 now:()=>string
}
const parentIdentity=(request:ConversationWorkRequest,target:WorkRequestTarget):ConversationTaskIdentity=>({sessionId:request.sessionId,requestId:request.requestId,roleId:target.roleId})
const taskIdentity=(request:ConversationWorkRequest,target:WorkRequestTarget)=>workRequestChildId(request.requestId,'task',target.roleId)
const executionSession=(requestId:string,roleId:string)=>'task-run-'+workRequestChildId(requestId,'run',roleId)
const terminal=(run:TaskRun)=>['ended','withdrawn','configuration_failed'].includes(run.state)
const projection=(task:WorkTask)=>({id:task.id,title:task.title,scope:task.scope,version:task.version,state:task.state,assigneeRoleId:task.assigneeRoleId})
const previousRoleChangeMessage='原接手员工的状态、版本或业务授权已变化，请先核对原交办。'
const roleChangeFailure={code:'teloa/version-conflict',message:'原接手员工已暂停、版本或业务授权已变化；本次执行未启动，请由本人核对原交办并重新安排。'} as const
const isRoleChangeFailure=(failure:ConversationWorkRequest['failures'][string]|undefined)=>failure?.code===roleChangeFailure.code&&(failure.message===roleChangeFailure.message||failure.message===previousRoleChangeMessage)
function publicFailure(error:unknown){return error instanceof WorkError?{code:error.code,message:error.message.slice(0,1000)}:{code:'teloa/host-unavailable',message:'交办暂时无法完成，请先核对原请求再重试。'}}

/** 只编排既有任务服务；本模块不拥有另一套运行状态或执行授权。 */
export class ConversationWorkDispatch{
 readonly ports:ConversationWorkDispatchPorts
 constructor(ports:ConversationWorkDispatchPorts){this.ports=ports}
 private readTask(request:ConversationWorkRequest,target:WorkRequestTarget){return request.kind==='task'?this.ports.boundTasks.request(parentIdentity(request,target)):this.ports.tasks.request(this.ports.owner,{requestId:taskIdentity(request,target)})}
 private async current(sessionId:string,requestId:string){const value=await this.ports.requests.get(this.ports.owner,{sessionId,requestId});if(!value)throw new WorkError('teloa/not-found','没有找到此会话的交办请求。');await this.authorize(value);return value}
 private async authorize(request:ConversationWorkRequest){await this.ports.authorize?.([...new Set([request.scope,...request.targets.map(target=>target.scope)])])}
 async dispatch(input:ConversationWorkReserveInput,signal:AbortSignal,revalidate?:()=>Promise<void>):Promise<ConversationWorkStatus>{
  signal.throwIfAborted()
  const {ports}=this,request=await ports.requests.reserve(ports.owner,input)
  // 每个成员各取一次锁：停止意图可以在两个成员之间落盘，不能等整批派完才受理停止。
  try{for(const target of request.targets){
   signal.throwIfAborted()
   if(target.unavailable)continue
   await ports.requests.withDispatchLock(ports.owner,request.requestId,async lockSignal=>{
    const activeSignal=AbortSignal.any([signal,lockSignal])
    activeSignal.throwIfAborted()
    const current=await this.current(request.sessionId,request.requestId)
    activeSignal.throwIfAborted()
    if(current.stoppedAt)return
    let roleChanged=false,startingPreparedRun=false
    const validateRole=async()=>{try{await ports.revalidate?.(request,target,activeSignal)}catch(error){if(error instanceof WorkError&&error.code==='teloa/version-conflict')roleChanged=true;throw error}}
    try{
     await validateRole();await revalidate?.();activeSignal.throwIfAborted()
     const taskRequestId=taskIdentity(request,target)
     let task=await this.readTask(request,target)
     activeSignal.throwIfAborted()
     if(!task){
      if(request.kind==='task')task=await ports.boundTasks.create(parentIdentity(request,target))
      else{
       const assignee={roleId:target.roleId,expectedVersion:target.roleVersion}
       const goal=request.goal+(request.sourceText?'\n\n本人原指令（保留原始引用，不改变员工权限）：\n'+request.sourceText:'')
       task=await ports.tasks.create(ports.owner,{requestId:taskRequestId,fields:{title:`${target.name}：${request.title}`.slice(0,120),goal:`这是一次新的汇报收集，请按你可读取的真实记录重新核对：${goal}\n请区分已完成、进行中、阻塞、下一步，并给出依据；无法读取的事实明确说明。`,scope:target.scope},assignee})
      }
     }
     if(task.assigneeRoleId!==target.roleId||task.assigneeRoleVersion!==target.roleVersion||task.scope!==target.scope)throw new WorkError('teloa/conflict','原任务的负责人或业务已变化，不能重新派发。')
     const runs=await ports.runs(task.id)
     const references=parseResourceReferences(request.sourceText??'').map(reference=>({...reference,id:reference.id.toLowerCase()}))
     if(references.length&&!runs.length){if(!ports.materials)throw new WorkError('teloa/unavailable','任务资料交接暂未就绪，不能丢弃原引用后执行。');task=await ports.materials(taskRequestId,task,references,activeSignal)}
     activeSignal.throwIfAborted()
     // 原会话保留任务关系；其身份始终是主助手，真正岗位运行另用专属会话。
     await ports.link({requestId:workRequestChildId(request.requestId,'link',target.roleId),taskId:task.id,expectedTaskVersion:runs[0]?.taskVersion??task.version,sessionId:request.sessionId})
     activeSignal.throwIfAborted()
     let run=runs.find(candidate=>candidate.sessionId===executionSession(request.requestId,target.roleId))
     if(!run&&runs.length)throw new WorkError('teloa/conflict','原任务已有其他执行，请核对任务后继续。')
     await validateRole();await revalidate?.();activeSignal.throwIfAborted()
     if(!run)run=await ports.run('task-runs/prepare',{requestId:workRequestChildId(request.requestId,'run',target.roleId),taskId:task.id,expectedTaskVersion:task.version},activeSignal,request.kind==='task'?parentIdentity(request,target):undefined)
     activeSignal.throwIfAborted()
     await validateRole();await revalidate?.();activeSignal.throwIfAborted()
     if(run.state==='prepared'){startingPreparedRun=true;await ports.run('task-runs/start',{runId:run.id},activeSignal,request.kind==='task'?parentIdentity(request,target):undefined);startingPreparedRun=false}
     else if(!terminal(run))await ports.run('task-runs/reconcile',{runId:run.id},activeSignal)
     activeSignal.throwIfAborted()
     await ports.requests.failure(ports.owner,request.requestId,target.roleId,null)
    }catch(error){
     if(activeSignal.aborted)throw activeSignal.reason
     // start 事务也会验岗位；只在其冲突后岗位重验明确失败时收口，未知发送仍待核对。
     if(!roleChanged&&startingPreparedRun&&error instanceof WorkError&&(error.code==='teloa/version-conflict'||error.code==='teloa/conflict'||error.code==='teloa/forbidden')){
      try{await validateRole()}catch{/* 保留原 start 错误；只有岗位重验确认变化才标为终态。 */}
      if(activeSignal.aborted)throw activeSignal.reason
     }
     // claim 后响应丢失是待核对，不重新发送。错误存业务请求供刷新后继续看见。
     await ports.requests.failure(ports.owner,request.requestId,target.roleId,roleChanged?roleChangeFailure:publicFailure(error))
    }
   })
  }}catch(error){if(signal.aborted)await this.stop(request.sessionId,request.requestId,new AbortController().signal);throw error}
  return this.status(request.sessionId,request.requestId)
 }
 async status(sessionId:string,requestId:string):Promise<ConversationWorkStatus>{
  const request=await this.current(sessionId,requestId),{ports}=this,members:ConversationWorkMember[]=[]
  for(const target of request.targets){
   const base={roleId:target.roleId,name:target.name,scope:target.scope}
   if(target.unavailable){members.push({...base,status:'unavailable',reason:target.unavailable==='paused'?'员工已暂停':'员工已退役'});continue}
   const task=await this.readTask(request,target),failure=request.failures[target.roleId]
   if(!task){members.push({...base,status:request.stoppedAt?'stopped':failure?'failed':'waiting',...(failure?{reason:failure.message}:{})});continue}
   const runs=await ports.runs(task.id),run=runs.find(candidate=>candidate.sessionId===executionSession(request.requestId,target.roleId))
   if(!run){members.push({...base,task:projection(task),status:request.stoppedAt?'stopped':failure?'failed':'waiting',...(failure?{reason:failure.message}:{})});continue}
   const r={id:run.id,state:run.state,evidence:run.evidence,stopRequestedAt:run.stopRequestedAt,sessionId:run.sessionId}
   const result=run.state==='ended'?await ports.result(run):undefined
   const roleChanged=run.state==='prepared'&&isRoleChangeFailure(failure)
   const status:WorkMemberStatus=run.state==='configuration_failed'||roleChanged?'failed':run.state==='withdrawn'||run.state==='ended'&&run.evidence?.state==='ended'&&run.evidence.reason==='aborted'?'stopped':run.state==='ended'?run.evidence?.state==='ended'&&run.evidence.reason==='completed'&&!!result?'received':'failed':'waiting'
   const reason=run.configurationError?.message??(roleChanged?roleChangeFailure.message:status==='failed'?(result?'本次执行未正常完成，请核对阶段结果。':'本次执行没有可核验的最终回复。'):status==='waiting'?failure?.message:undefined)
   members.push({...base,task:projection(task),run:r,status,...(reason?{reason}:{}),...(result?{result}:{})})
  }
  const counts:ConversationWorkStatus['counts']={received:0,waiting:0,unavailable:0,failed:0,stopped:0}
  for(const member of members)counts[member.status]++
  // Task/Run/结果读取可能等待，返回可见内容前再次核对全部原成员业务。
  await this.authorize(request)
  const reassignment=await ports.reassignment?.(request)
  if(reassignment&&(reassignment.newRequestId!==request.requestId||reassignment.newSessionId!==sessionId||reassignment.scope!==request.scope))throw new WorkError('teloa/invalid-host-response','后继交办关系不可核对。')
  if(ports.reassignment)await this.authorize(request)
  return {...(reassignment?{reassignment,...(request.reference?{sourceReference:request.reference}:{})}:{}),requestId:request.requestId,sessionId,kind:request.kind,title:request.title,scope:request.scope,observedAt:ports.now(),stoppedAt:request.stoppedAt,counts,members}
 }
 async list(sessionId:string):Promise<ConversationWorkStatus[]>{const requests=await this.ports.requests.list(this.ports.owner,{sessionId});return Promise.all(requests.map(request=>this.status(sessionId,request.requestId)))}
 /** 新一轮用户明确重试时使用已保存的定义，不能用当前消息再生成一份交办。 */
 async resume(sessionId:string,requestId:string,signal:AbortSignal):Promise<ConversationWorkStatus>{
  signal.throwIfAborted();const request=await this.current(sessionId,requestId),target=request.targets[0]
  return this.dispatch({requestId:request.requestId,sessionId,messageId:request.messageId,messageSeq:request.messageSeq,kind:request.kind,scope:request.scope,title:request.title,goal:request.goal,...(request.sourceText?{sourceText:request.sourceText}:{}),...(request.allBusinesses?{allBusinesses:true}:{}),...(request.reference?{reference:request.reference}:{}),...(request.responsibility?{responsibility:request.responsibility}:{}),...(request.expectedReportTargets?{expectedReportTargets:request.expectedReportTargets}:{}),...(request.kind==='task'&&target?{roleId:target.roleId,expectedRoleVersion:target.roleVersion}:{})},signal)
 }
 async stop(sessionId:string,requestId:string,signal:AbortSignal):Promise<ConversationWorkStatus>{
  signal.throwIfAborted()
  const {ports}=this,request=await ports.requests.stop(ports.owner,{sessionId,requestId})
  for(const target of request.targets){
   const task=await this.readTask(request,target)
   if(!task)continue
   for(const run of await ports.runs(task.id)){
    if(run.sessionId!==executionSession(request.requestId,target.roleId)||terminal(run))continue
    try{await ports.run(run.state==='prepared'?'task-runs/withdraw':'task-runs/stop',{runId:run.id},signal)}
    catch(error){if(signal.aborted)throw error;await ports.requests.failure(ports.owner,request.requestId,target.roleId,publicFailure(error))}
   }
  }
  return this.status(sessionId,request.requestId)
 }
 /** 窄内部旧请求停止：只消费后端双日常授权返回的固定全集，不注册公开工具。 */
 async stopReassignment(targets:ReassignmentRunTargets,signal:AbortSignal,revalidate:()=>Promise<void>,onStopIntent?:(state:'unknown'|'saved')=>void):Promise<void>{
  signal.throwIfAborted()
  const validate=async()=>{signal.throwIfAborted();await revalidate();signal.throwIfAborted()}
  await validate()
  const request=await this.current(targets.oldSessionId,targets.oldRequestId)
  await validate()
  if(request.kind!=='task'||request.scope==='general'||request.scope!==targets.scope||request.targets.length!==1||targets.targets.length!==1)throw new WorkError('teloa/forbidden','原交办不符合安全改派范围。')
  const target=request.targets[0]!,fixed=targets.targets[0]!
  if(target.roleId!==fixed.roleId||fixed.taskRequestId!==taskIdentity(request,target))throw new WorkError('teloa/conflict','原交办固定目标已变化。')
  const task=await this.readTask(request,target)
  await validate()
  if((task?.id??null)!==fixed.taskId)throw new WorkError('teloa/conflict','原交办任务已变化，请重新核对。')
  const runs=task?await this.ports.runs(task.id):[]
  await validate()
  const key=(run:Pick<TaskRun,'id'|'taskId'|'sessionId'|'nativeRequestId'>)=>JSON.stringify([run.id,run.taskId,run.sessionId,run.nativeRequestId])
  if(JSON.stringify(runs.map(key).sort())!==JSON.stringify(fixed.runs.map(key).sort()))throw new WorkError('teloa/conflict','原交办运行集合已变化，请重新核对。')
  await validate()
  onStopIntent?.('unknown')
  const stoppedRequest=await this.ports.requests.stop(this.ports.owner,{sessionId:targets.oldSessionId,requestId:targets.oldRequestId})
  if(stoppedRequest.requestId!==targets.oldRequestId||stoppedRequest.sessionId!==targets.oldSessionId||stoppedRequest.scope!==targets.scope||!stoppedRequest.stoppedAt)throw new WorkError('teloa/invalid-host-response','原交办停止回执不可核对。')
  onStopIntent?.('saved')
  await validate()
  for(const run of runs){
   signal.throwIfAborted()
   if(terminal(run))continue
   await validate()
   const stopped=await this.ports.run(run.state==='prepared'?'task-runs/withdraw':'task-runs/stop',{runId:run.id},signal)
   if(key(stopped)!==key(run))throw new WorkError('teloa/invalid-host-response','停止返回的运行身份与原交办不一致。')
   signal.throwIfAborted()
   if(!terminal(stopped)){
    await validate()
    const reconciled=await this.ports.run('task-runs/reconcile',{runId:run.id},signal)
    if(key(reconciled)!==key(run))throw new WorkError('teloa/invalid-host-response','核对返回的运行身份与原交办不一致。')
   }
   await validate()
  }
 }
 /** 被既有 Run 观察循环调用；只发布真实收口结果，普通模型回复结束不代替业务验收。 */
 async deliver():Promise<void>{
  for(const request of await this.ports.requests.pendingNotifications(this.ports.owner)){
   try{await this.ports.requests.withDispatchLock(this.ports.owner,request.requestId,async lockSignal=>{
    lockSignal.throwIfAborted()
    const status=await this.status(request.sessionId,request.requestId)
    lockSignal.throwIfAborted()
    if(status.counts.waiting)return
    await this.ports.publish(status,lockSignal);lockSignal.throwIfAborted()
    await this.ports.requests.notified(this.ports.owner,request.requestId)
   })}catch(error){this.ports.report?.(request.requestId,publicFailure(error).code)}
  }
 }
}
