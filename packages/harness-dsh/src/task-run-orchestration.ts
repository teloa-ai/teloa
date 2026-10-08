import {randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {SessionId} from '@deepseek-ai/dsh-session'
import {JobId} from '@deepseek-ai/dsh-jobs'
import type {SubagentProvider,SubagentRun} from '@deepseek-ai/dsh-subagent'
import {foldSubagentDescriptor} from '@deepseek-ai/dsh-subagent'
import type {ToolDefinition,ToolExecution} from '@deepseek-ai/dsh-tools'
import type {TaskRun,TaskRunRuntimeLinks} from '@teloa/backend'
import {WorkError,type TaskRunFlowStep} from '@teloa/contract'
import type {SubagentDelegationPorts} from './subagent-delegation.ts'
import type {TaskToolPolicy,TaskToolPolicyReader} from './task-tool-guard.ts'
import {resolveSessionLineage} from './subagent-lineage.ts'
import {createTaskRunBackground,isOwnerOnlyTextRun,taskRunRuntimeId} from './task-run-background.ts'
import {readSessionEvents} from './session-events.ts'

type Binding=Pick<TaskRun,'id'|'sessionId'|'nativeRequestId'>
type Child={binding:Binding;rootId:string;controller:AbortController;run:SubagentRun;ready:boolean;settled:boolean;interrupted:boolean;structured?:ToolDefinition|undefined;result?:SubagentRun['result']}
export type TaskRunOrchestrationOptions={timeoutMs?:number;maxRounds?:number}
export type TaskRunOrchestrationAccess={
 authorizeChild:(agent:Agent,policy:TaskToolPolicy,signal:AbortSignal)=>Promise<boolean>
 ownsStructuredOutput:(exec:ToolExecution)=>boolean
}
const allowed=(policy:TaskToolPolicy)=>policy.allowedTools.includes('workflow')||policy.allowedTools.includes('ralph')
const failure=(message:string)=>new WorkError('teloa/forbidden',message)

/** 官方拥有脚本、子 Agent 与 job；这里只保留业务身份、共用配额和有界取消。 */
export function createTaskRunOrchestration(ctx:Context,delegation:SubagentDelegationPorts,readPolicy:TaskToolPolicyReader,links:TaskRunRuntimeLinks,options:TaskRunOrchestrationOptions={}){
 const timeoutMs=options.timeoutMs??600_000,maxRounds=options.maxRounds??6
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2_147_483_647||!Number.isSafeInteger(maxRounds)||maxRounds<1)throw new Error('原生编排耗时与轮数上限必须是正整数。')
 const children=new Map<string,Child>(),pending=new Map<string,Set<Promise<void>>>(),stopped=new Set<string>()
 const starting=new Map<string,Set<AbortController>>()
 const deadlines=new Set<{cancel:()=>void;clear:()=>void}>()
 // 票据仅由宿主薄口持有，模型传入 provider 参数不能取得固定 Flow 预留身份。
 const flowTickets=new WeakMap<AbortSignal,{runId:string;reservationId:string;nativeRequestId:string}>()
 const flowStarts=new Map<string,Promise<{reservationId:string;childSessionId:string}>>()
 const jobDeadlines=new Map<string,{clear:()=>void}>()
 let disposed=false
 const background=createTaskRunBackground(ctx,links,binding=>children.get(binding.sessionId)?.ready===true)
 const generation=async(runId:string)=>!(await links.list({runId,kind:'job'})).some(row=>row.kind==='job'&&row.payload.runtimeId!==taskRunRuntimeId)
 const assertPolicy=(policy:TaskToolPolicy)=>{
  if(policy.stopRequested)throw failure('本次执行已请求停止，不能派发或使用子 Agent。')
  if(!policy.nativeRequestId||!allowed(policy))throw failure('本次执行未授权原生编排。')
 }
 const awaitStarts=async(rootId:string,signal:AbortSignal)=>{
  signal.throwIfAborted()
  const starts=[...(pending.get(rootId)??[])]
  if(starts.length){
   let aborted!:()=>void
   const abort=new Promise<never>((_,reject)=>{aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true})})
   try{await Promise.race([Promise.all(starts),abort])}finally{signal.removeEventListener('abort',aborted)}
  }
  signal.throwIfAborted()
 }
 const removeProvider=ctx.subagents.registerProvider({
  name:'teloa-workflow-spawn',
  capabilities:{agentOptions:true,outputSchema:true,depthLimit:true,toolFilter:true,persona:true},
  inheritsParentContext:false,
  async start(request){
   if(disposed)throw failure('原生编排适配已停止。')
   const native=ctx.subagents.getProvider('spawn')
   if(!native||native.inheritsParentContext||Object.values(native.capabilities).some(value=>!value))throw failure('官方 fresh 子 Agent 提供方不可用。')
   const lineage=resolveSessionLineage(ctx,request.parent.session),rootId=lineage.root.id,policy=await readPolicy(rootId,request.signal)
   request.signal.throwIfAborted()
   // 本人会话不伪造业务 Run，完整保留官方默认权限与生命周期。
   const flowTicket=flowTickets.get(request.signal)
   if(policy===null){if(flowTicket)throw failure('Flow 缺少受管执行授权。');return native.start(request)}
   assertPolicy(policy)
   if(stopped.has(rootId))throw failure('本次执行已停止。')
   const depth=lineage.depth+1
   if(depth>delegation.limits.maxDepth)throw failure('已达到本次任务允许的拆分层数上限。')
   const runId=await delegation.runId(rootId,request.signal)
   if(!runId)throw failure('原生编排缺少受管执行身份。')
   if(flowTicket&&(flowTicket.runId!==runId||flowTicket.nativeRequestId!==policy.nativeRequestId))throw failure('Flow 当前执行身份已变化。')
   if(!await generation(runId))throw failure('此执行所属宿主已重启，不能重新派发。')
   let releaseGate!:()=>void
   const reservationId=flowTicket?.reservationId??'workflow:'+randomUUID(),gate=new Promise<void>(resolve=>{releaseGate=resolve}),starts=pending.get(rootId)??new Set<Promise<void>>()
   starts.add(gate);pending.set(rootId,starts)
   const controller=new AbortController()
   const controllers=starting.get(rootId)??new Set<AbortController>();controllers.add(controller);starting.set(rootId,controllers)
   let reserved=false,child:SubagentRun|undefined,record:Child|undefined
   try{
    await delegation.reserve({runId,reservationId,limit:delegation.limits.maxPerRun});reserved=true
    request.signal.throwIfAborted()
    const current=await readPolicy(rootId,request.signal)
    if(!current||current.nativeRequestId!==policy.nativeRequestId)throw failure('原生编排授权身份已变化。')
    assertPolicy(current)
    if(disposed||stopped.has(rootId))throw failure('本次执行已停止。')
    // 直接委托 provider，避免再走 runtime.start 而重复发布生命周期。
    child=await native.start({...request,signal:AbortSignal.any([request.signal,controller.signal]),maxDepth:Math.min(request.maxDepth??delegation.limits.maxDepth,delegation.limits.maxDepth)})
    if(!child.localAgent||child.id!==child.localAgent.id||child.localAgent.session.header.parentSession!==request.parent.id)throw failure('官方子 Agent 身份与请求不一致。')
    record={binding:{id:runId,sessionId:child.id,nativeRequestId:policy.nativeRequestId!},rootId,controller,run:child,ready:false,settled:false,interrupted:false,...(request.outputSchema===undefined?{}:{structured:ctx.tools.get('structured_output',child.localAgent)})}
    children.set(child.id,record)
    await delegation.bind({reservationId,childSessionId:child.id,depth})
    await background.start(record.binding)
    request.signal.throwIfAborted()
    if(disposed||stopped.has(rootId))throw failure('本次执行已停止。')
    record.ready=true
    const fixed=record,published=child
    const result=published.result.then(async result=>{
     try{await delegation.settle({childSessionId:published.id,stopReason:result.stopReason})}
     catch(error){fixed.interrupted=true;await delegation.abandon({reservationId,childSessionId:published.id,depth,stopReason:'orchestration-settlement-failed'});throw error}
     finally{fixed.settled=true}
     fixed.interrupted ||= result.stopReason!=='completed'&&result.stopReason!=='aborted'
     return result
    },async error=>{
     fixed.interrupted=true
     try{await delegation.abandon({reservationId,childSessionId:published.id,depth,stopReason:'orchestration-result-failed'})}finally{fixed.settled=true}
     throw error
    })
    // 宿主负责等待结算；提前拒绝不能制造 unhandled rejection。
    result.catch(()=>{})
    fixed.result=result
    return {id:published.id,localAgent:published.localAgent,result,async dispose(){controller.abort();await published.dispose();await result}}
   }catch(error){
    if(record){record.ready=false;record.interrupted=true}
    if(child){
     controller.abort()
     try{await child.dispose()}finally{
      await delegation.abandon({reservationId,childSessionId:child.id,depth,stopReason:'orchestration-registration-failed'})
      if(record)record.settled=true
     }
    }else if(reserved)await delegation.release({reservationId})
    throw error
   }finally{
    // 必须在取消、绑定失败收口之后释放闸；等待者随后核对精确 child，不能仅凭根谱系放行。
    releaseGate();starts.delete(gate);if(!starts.size)pending.delete(rootId)
    controllers.delete(controller);if(!controllers.size)starting.delete(rootId)
   }
  },
 } satisfies SubagentProvider)
 // 官方 workflow 后台 job 刻意脱离工具 signal，须在工具返回后继续持有同一截止时间。
 const removeWrapper=ctx.on('tools/execute',async(exec,next)=>{
  if(!['workflow','ralph','run_code'].includes(exec.name)||!exec.agent)return next()
  if(disposed)throw failure('原生编排适配已停止。')
  if(exec.name==='ralph'){
   const rounds=(exec.arguments as {maxRounds?:unknown}).maxRounds
   if(rounds!==undefined&&(!Number.isSafeInteger(rounds)||(rounds as number)<1||(rounds as number)>maxRounds))throw failure('Ralph 请求超过本次允许的迭代轮数。')
  }
  const caller=exec.signal,controller=new AbortController(),owner=exec.agent.id
  let jobId:ReturnType<typeof JobId>|undefined,timedOut=false
  const cancel=()=>{
   timedOut=true;controller.abort('原生编排达到总耗时上限。')
   if(jobId){try{ctx.jobs.kill(jobId,owner,'原生编排达到总耗时上限。')}catch{ctx.logger.warn('Teloa 原生编排超时取消未完成。')}}
  }
  const timer=setTimeout(cancel,timeoutMs);timer.unref?.()
  const deadline={cancel,clear:()=>{clearTimeout(timer);deadlines.delete(deadline);if(jobId)jobDeadlines.delete(jobId)}};deadlines.add(deadline)
  exec.signal=AbortSignal.any([caller,controller.signal])
  try{
   const result=await next()
   if(exec.name==='workflow'&&!result.isError&&typeof result.value==='object'&&result.value!==null&&!Array.isArray(result.value)&&result.value.kind==='background'&&typeof result.value.jobId==='string'){
    const candidate=JobId(result.value.jobId),job=ctx.jobs.get(candidate,owner)
    if(job.owner!==owner||job.kind!=='workflow')throw failure('后台编排回执与调用者不一致。')
    jobId=candidate
    jobDeadlines.set(candidate,deadline)
    if(timedOut)cancel()
    if(job.status!=='running'&&job.status!=='stopping')deadline.clear()
   }
   if(timedOut)throw new WorkError('teloa/conflict','原生编排达到总耗时上限。')
   return result
  }finally{exec.signal=caller;if(!jobId)deadline.clear()}
 })
 const removeJobs=ctx.jobs.events.subscribe({owners:'all'},event=>{if(event.type==='settled')jobDeadlines.get(event.job.id)?.clear()})
 const access:TaskRunOrchestrationAccess={
  async authorizeChild(agent,policy,signal){
   const lineage=resolveSessionLineage(ctx,agent.session)
   if(!lineage.depth)return false
   await awaitStarts(lineage.root.id,signal)
   const child=children.get(agent.id)
   if(!child){
    const events=readSessionEvents(agent.session),descriptor=foldSubagentDescriptor(events)
    if(descriptor?.provider==='teloa-workflow-spawn'||events.some(event=>event.type==='subagent/descriptor'&&event.data.provider==='teloa-workflow-spawn'))throw failure('原生编排子 Agent 未登记到当前执行，不能恢复工具权限。')
    return false
   }
   assertPolicy(policy)
   if(!child.ready||child.settled||stopped.has(child.rootId)||child.binding.nativeRequestId!==policy.nativeRequestId||child.rootId!==lineage.root.id)throw failure('子 Agent 没有当前执行的有效授权。')
   if(!await generation(child.binding.id))throw failure('此执行所属宿主已重启，不能继续执行。')
   signal.throwIfAborted();return true
  },
  ownsStructuredOutput(exec){
   const child=exec.agent?children.get(exec.agent.id):undefined
   return exec.name==='structured_output'&&child?.ready===true&&!child.settled&&!stopped.has(child.rootId)&&child.structured!==undefined&&ctx.tools.get(exec.name,exec.agent)===child.structured
  },
 }
 return {
  ...access,
  /** 只由真实 Flow 驱动调用；复用官方 runtime 的单份 descriptor、生命周期及配额结算。 */
  async startFlow(input:{run:TaskRun;flowId:string;step:TaskRunFlowStep;reservationId:string},signal:AbortSignal):Promise<{reservationId:string;childSessionId:string}>{
   signal.throwIfAborted();const {run,flowId,step,reservationId}=input,execution=step.execution
   const parent=ctx.agents.get(SessionId(run.sessionId))
   if(!parent||!execution||!run.nativeRequestId||!['accepted','active'].includes(run.state)||step.state!=='running'||step.attempts<1||reservationId!=='flow:'+flowId+':'+step.id+':'+step.attempts||execution.parentSessionId!==run.sessionId||execution.agentPresetId!==run.agentPresetId||execution.allowedTools.some(name=>!run.allowedTools.includes(name)))throw failure('Flow 子工作配置与真实父执行身份不一致。')
   // fresh provider 当前继承父资源上下文；不能声称收窄了它实际上仍能读取的资料或技能。
   const equal=(a:readonly string[],b:readonly string[])=>a.length===b.length&&a.every(name=>b.includes(name))
   if(!equal(execution.knowledgeIds,run.knowledge.map(item=>item.id))||!equal(execution.skillNames,run.skills.map(item=>item.name)))throw failure('当前 Flow provider 尚不能隔离更窄的资料或技能配置。')
   const policy=await readPolicy(run.sessionId,signal);if(!policy||policy.nativeRequestId!==run.nativeRequestId)throw failure('Flow 当前执行授权已变化。');assertPolicy(policy)
   if(execution.allowedTools.some(name=>!policy.allowedTools.includes(name)))throw failure('Flow 工具授权已变化。')
   const prior=flowStarts.get(reservationId);if(prior)return prior
   const start=async()=>{
    // 有持久预留而本世代没有明确启动回包时只核原件，禁止再次派发。
    if(!delegation.list)throw failure('Flow 缺少真实子执行预留读口。')
    if((await delegation.list(run.id)).some(row=>row.reservationId===reservationId))throw failure('Flow 原子执行回执待核对，不能重新派发。')
    const controller=new AbortController(),currentSignal=AbortSignal.any([signal,controller.signal])
    flowTickets.set(currentSignal,{runId:run.id,reservationId,nativeRequestId:run.nativeRequestId!})
    try{
     const child=await ctx.subagents.start('teloa-workflow-spawn',{parent,signal:currentSignal,label:step.title,prompt:[{type:'text',text:step.inputSummary}],toolFilter:{allow:execution.allowedTools},maxDepth:delegation.limits.maxDepth})
     child.result.catch(()=>{})
     return {reservationId,childSessionId:child.id}
    }finally{flowTickets.delete(currentSignal)}
   }
   const pendingStart=start();flowStarts.set(reservationId,pendingStart);pendingStart.catch(()=>{})
   return pendingStart
  },
  async state(run:TaskRun):Promise<{outstanding:boolean;interrupted:boolean}>{
   const rows=await links.list({runId:run.id})
   // 旧世代仍禁止派发；结果核对不能仅凭旧 root owner 推翻完整纯文本原生结尾。
   let outstanding=(pending.get(run.sessionId)?.size??0)>0,interrupted=rows.some(row=>row.kind==='job'&&row.payload.runtimeId!==taskRunRuntimeId)&&!isOwnerOnlyTextRun(run,rows)
   for(const child of children.values()){
    if(child.binding.id!==run.id)continue
    const jobs=child.ready?await background.state(child.binding):{outstanding:false,interrupted:false}
    outstanding ||= !child.settled||jobs.outstanding
    interrupted ||= child.interrupted||jobs.interrupted
   }
   return {outstanding,interrupted}
  },
  async stop(run:TaskRun,signal:AbortSignal):Promise<void>{
   signal.throwIfAborted();stopped.add(run.sessionId)
   for(const controller of starting.get(run.sessionId)??[])controller.abort('Teloa 任务已请求停止。')
   for(const child of children.values())if(child.binding.id===run.id)child.controller.abort('Teloa 任务已请求停止。')
   await awaitStarts(run.sessionId,signal)
   const results=await Promise.allSettled([...children.values()].filter(child=>child.binding.id===run.id).map(async child=>{
    await background.cancel(child.binding,signal)
    await child.run.dispose();await child.result
   }))
   const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason
  },
  async dispose(){
   if(disposed)return;disposed=true;removeProvider();removeWrapper();removeJobs()
   for(const deadline of [...deadlines]){deadline.cancel();deadline.clear()}
   for(const child of children.values())child.controller.abort('原生编排适配卸载。')
   for(const controllers of starting.values())for(const controller of controllers)controller.abort('原生编排适配卸载。')
   await Promise.all([...pending.values()].flatMap(starts=>[...starts]))
   const outcomes=await Promise.allSettled([...children.values()].map(async child=>{await child.run.dispose();await child.result}))
   background.dispose()
   if(outcomes.some(result=>result.status==='rejected'))ctx.logger.warn('Teloa 原生编排卸载清理未完全成功。')
  },
 }
}
