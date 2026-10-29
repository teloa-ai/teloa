import {createHash,randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {LlmError,type GenerateOptions,type StreamChunk,type TokenUsage,type LlmFailure} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry'
import {SessionId,type SessionEvent} from '@deepseek-ai/dsh-session'
import {WorkError,workBudgetExhaustedCode} from '@teloa/contract'
import {WorkRetryService,combineWorkAccessLeases,type TaskRunService,type TaskRun,type WorkControlService,type WorkBudgetService,type WorkAccessLease,type RunBudgetTerminal} from '@teloa/backend'
import type {createNativeWorkInput} from './native-work-input.ts'
import {readSessionEvents} from './session-events.ts'
import {observeTaskRunTimeline} from './task-run-observation.ts'

type Position={sessionId:string;turn:number;step:number;reviewCallId?:string}
export type ResidentRoutingBudget={budgetAccountId:string|null;controlGeneration:number;operationId:string;lease:WorkAccessLease}
type Options={owner:string;pool:TaskRunService['pool'];identity:{id:()=>string;now:()=>string};runs:()=>Promise<TaskRunService>;controls:WorkControlService;budgets:WorkBudgetService;resolveRun:(sessionId:string)=>Promise<TaskRun|null>;resolveRouting?:(sessionId:string)=>Promise<ResidentRoutingBudget|null>;nativeInput:Pick<ReturnType<typeof createNativeWorkInput>,'modelPosition'>&Partial<Pick<ReturnType<typeof createNativeWorkInput>,'hasAuxiliaryModelAdmission'>>;report:(code:string)=>void}
type Attempt={run:TaskRun;tokens:number;role:WorkAccessLease}
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const unavailable=()=>new WorkError('teloa/unavailable','当前模型请求没有完整的受控工作准入。')
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0
/** 额度拒绝改为原生可保留的失败 code，会话 turn/end 留下原因与范围供界面说明；其余错误原样上抛。 */
async function reserveOrExplain<T>(reserve:()=>Promise<T>):Promise<T>{
 try{return await reserve()}
 catch(error){if(error instanceof WorkError&&error.code==='teloa/budget-exhausted')throw new LlmError(error.message,workBudgetExhaustedCode(error.details),{cause:error});throw error}
}

/** 只读同一原生 Run 的持久结束锚点；修复器回填的 turn/end 时间不能替代其正式封口时刻。 */
export function runBudgetTerminal(run:TaskRun,snapshot:{sessionId:string;events:readonly SessionEvent[];inheritedEventCount:number}):RunBudgetTerminal|null{
 const evidence=run.evidence
 if(run.state!=='ended'||evidence?.state!=='ended'||snapshot.sessionId!==run.sessionId||!count(snapshot.inheritedEventCount)||evidence.messageSeq<snapshot.inheritedEventCount||snapshot.events.length<evidence.endSeq+1)return null
 // 原 Run 的结束锚点冻结在此前缀；后续独立输入不归入原 Run 的消耗。
 const events=snapshot.events.slice(0,evidence.endSeq+1)
 try{
  if(events.some((event,index)=>event.seq!==index||!count(event.time)))return null
  const observed=observeTaskRunTimeline(events,run.nativeRequestId).observation
  if(observed.state!=='ended'||observed.turn!==evidence.turn||observed.messageSeq!==evidence.messageSeq||observed.reason!==evidence.reason)return null
  const message=events[evidence.messageSeq],turnEnd=events[observed.endSeq],terminal=events[evidence.endSeq]
  if(message?.type!=='user/message'||message.data.source.kind!=='user'||!('rpcId' in message.data.source)||message.data.source.rpcId!==run.nativeRequestId||turnEnd?.type!=='turn/end'||terminal===undefined)return null
  if(events.slice(evidence.messageSeq+1,evidence.endSeq+1).some(event=>event.type==='user/message'&&['user','goal'].includes(event.data.source.kind)))return null
  let terminalKind:RunBudgetTerminal['terminalKind']
  if(observed.endSeq===evidence.endSeq&&terminal.type==='turn/end')terminalKind='turn/end'
  else if(observed.endSeq+1===evidence.endSeq&&terminal.type==='session/end-seed'&&Object.keys(terminal.data).length===0)terminalKind='session/end-seed'
  else return null
  if(terminal.time<message.time||terminal.time<turnEnd.time)return null
  return {schema:'teloa.work-budget-terminal/v1',runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,turn:evidence.turn,messageSeq:evidence.messageSeq,endSeq:evidence.endSeq,turnEndSeq:observed.endSeq,terminalKind,endedAt:new Date(terminal.time).toISOString()}
 }catch{return null}
}

/** 用实际提供方计数，缓存输入与普通输入是互斥项，不按流片段重复累加。 */
function usedTokens(usage:TokenUsage):number|null{
 if(!count(usage.inputTokens)||!count(usage.outputTokens)||usage.cacheReadTokens!==undefined&&!count(usage.cacheReadTokens)||usage.cacheWriteTokens!==undefined&&!count(usage.cacheWriteTokens))return null
 const sum=usage.inputTokens+usage.outputTokens+(usage.cacheReadTokens??0)+(usage.cacheWriteTokens??0)
 if(usage.totalTokens!==undefined&&(!count(usage.totalTokens)||usage.totalTokens<sum))return null
 const result=usage.totalTokens??sum;return count(result)?result:null
}
type ModelFinish=Extract<StreamChunk,{type:'finish'}>['reason']
/** 固定官方适配器在认证读取阶段、HTTP 之前给出此码；任何输出/用量片段或取消都不能据此推断零消耗。 */
function unsentCredentialFailure(finish:ModelFinish|undefined,streamActivitySeen:boolean,signal:AbortSignal|undefined):boolean{
 return !streamActivitySeen&&!signal?.aborted&&finish?.kind==='error'&&finish.failure?.code==='MISSING_CREDENTIAL'&&finish.failure.status===undefined&&finish.failure.requestId===undefined
}
export function failureOutcome(failure:LlmFailure|undefined,outputSeen:boolean):'transient'|'authentication'|'permission'|'conflict'|'unknown'{
 if(!failure||outputSeen)return 'unknown'
 if(failure.status===401||failure.code==='AUTHENTICATION_ERROR')return 'authentication'
 if(failure.status===403||failure.code==='PERMISSION_DENIED')return 'permission'
 if(failure.status===409)return 'conflict'
 // 明确拒绝的模型请求可以有限重试；传输中断或丢失回包保留未知，不自动重放。
 // 部分 Anthropic 协议适配器不填 status，只把 HTTP 状态写在服务端错误消息开头（实跑：MiniMax 529 overloaded_error）。
 const leading=failure.status===undefined&&failure.code==='SERVER'?Number(/^(\d{3})\s/.exec(failure.message??'')?.[1]):undefined
 const status=failure.status??leading
 if(status===429||status===503||status===529||failure.code==='RATE_LIMITED')return 'transient'
 return 'unknown'
}
function positionEvents(ctx:Context,position:Position):readonly SessionEvent[]{
 const agent=ctx.agents.get(SessionId(position.sessionId));if(!agent)throw unavailable()
 return readSessionEvents(agent.session)
}
/** 本 turn 仍未闭合的官方压缩身份；压缩持锁期间的请求都属于这次压缩。 */
function openCompaction(events:readonly SessionEvent[],turn:number):string|null{
 for(let index=events.length-1;index>=0;index--){
  const event=events[index]!
  if(event.type==='compaction/start')return event.data.turn===turn?event.data.compactionId:null
  if(event.type==='compaction/end'||event.type==='turn/start')return null
 }
 return null
}
/**
 * 模型操作的持久身份。pre-step 压缩发生在 step-end 之后，同一 turn 的各次压缩步号都为 0；
 * 追加持久 compaction/start 的 compactionId，使不同压缩各自独立，同一次压缩的重放仍回到原操作。
 * 非压缩请求保持原身份。
 */
export function modelOperationId(events:readonly SessionEvent[],position:Position,run:string,request:Pick<GenerateOptions,'purpose'|'provider'|'model'>):string{
 const compaction=openCompaction(events,position.turn)
 return 'model:'+digest([run,position.sessionId,position.turn,operationStep(events,position),request.purpose??null,request.provider,request.model,...compaction===null?[]:[compaction],...position.reviewCallId===undefined?[]:[position.reviewCallId]])
}
function operationStep(events:readonly SessionEvent[],position:Position):number{
 const tail=[...events].reverse().find(e=>e.type==='llm/retry-started'||e.type==='assistant/message'||e.type==='turn/start')
 if(tail?.type==='llm/retry-started'&&tail.data.turn===position.turn){
  const first=events.find(e=>e.type==='llm/retry'&&e.data.retryId===tail.data.retryId&&e.data.turn===position.turn)
  if(first?.type==='llm/retry')return first.data.step
 }
 return position.step
}

/** 真实 llm/stream 的持久预留/结算；不复制请求或替代官方模型 loop。 */
export function installResidentModelBudget(ctx:Context,options:Options):()=>void{
 const {owner,pool,identity,runs,controls,budgets,nativeInput}=options,pending=new Map<string,Attempt>()
 const retries=new WorkRetryService(pool,identity,{controls,authorizeAttempt:async(db,value,input)=>{
  if(value!==owner)throw unavailable()
  const request=pending.get(input.operationId);if(!request||request.run.id!==input.runId||!request.run.lineage)throw unavailable()
  request.role.assertCurrent()
  const fixed=await(await runs()).readVerifiedInTransaction(db,owner,input.runId)
  if(fixed.lineage?.budgetAccountId!==request.run.lineage.budgetAccountId)throw unavailable()
  const reservation=await budgets.reserveInTransaction(db,owner,{budgetAccountId:fixed.lineage.budgetAccountId,controlGeneration:input.controlGeneration,modelRequestId:input.modelRequestId,kind:'retry',tokens:request.tokens,rounds:0})
  return combineWorkAccessLeases([request.role,budgets.lease(owner,reservation)])
 }})
 const dispose=ctx.on('llm/stream',async function*(request,next):AsyncIterable<StreamChunk>{
  // 辅助提炼已经组合真实来源、能力与owner预算；只凭private exact-object证明避免重复计费。
  if(nativeInput.hasAuxiliaryModelAdmission?.(request)){yield* next();return}
  if(!request.sessionId){yield* next();return}
  const run=await options.resolveRun(request.sessionId)
  const routing=run?null:await options.resolveRouting?.(request.sessionId)
  // 首页和员工单聊的手动对话没有 Task/Run 或后台路由来源，不使用自动工作的累计额度。
  if(!run&&!routing){yield* next();return}
  if(run&&(!run.roleSnapshot&&run.executor?.kind!=='owner'||!run.lineage))throw new WorkError('teloa/conflict','历史任务需要建立新的受控执行，不能自动重放。')
  const position=nativeInput.modelPosition(request)
  if(!position||position.sessionId!==request.sessionId)throw unavailable()
  // 官方 prepared call 已把提供方输出上限写回原请求；未知上限不能承诺有限预留。
  if(!count(request.maxTokens)||request.maxTokens<1)throw new WorkError('teloa/conflict','请为这个模型设置输出上限后继续工作。')
  const tokens=Buffer.byteLength(JSON.stringify({messages:request.messages,system:request.system,tools:request.tools,toolHistory:request.toolHistory}),'utf8')+request.maxTokens
  if(!count(tokens))throw unavailable()
  if(routing){
   routing.lease.assertCurrent();request.signal?.throwIfAborted()
   const modelRequestId='routing:'+digest([routing.operationId,position.sessionId,position.turn,operationStep(positionEvents(ctx,position),position),request.provider,request.model,...position.reviewCallId===undefined?[]:[position.reviewCallId]])
   const reservation=await reserveOrExplain(()=>routing.budgetAccountId===null?budgets.reserveOwnerRouting(owner,{modelRequestId,tokens}):budgets.reserve(owner,{budgetAccountId:routing.budgetAccountId,controlGeneration:routing.controlGeneration,modelRequestId,kind:'routing',tokens,rounds:0}))
   const lease=combineWorkAccessLeases([routing.lease,budgets.lease(owner,reservation)])
   let dispatched=false,usage:number|null=null,finish:ModelFinish|undefined,streamActivitySeen=false
   try{
    request.signal?.throwIfAborted();lease.assertCurrent();await budgets.markDispatched(owner,{reservationId:reservation.id});dispatched=true
    request.signal?.throwIfAborted();lease.assertCurrent()
    for await(const chunk of next()){
     if(chunk.type==='finish')finish=chunk.reason;else streamActivitySeen=true
     if(chunk.type==='usage'){const current=usedTokens(chunk.usage);usage=current===null?null:Math.max(usage??0,current)}
     request.signal?.throwIfAborted();lease.assertCurrent();yield chunk
    }
   }finally{
    if(dispatched)await budgets.settle(owner,{reservationId:reservation.id,modelRequestId,provider:request.provider,providerRequestId:null,tokens:unsentCredentialFailure(finish,streamActivitySeen,request.signal)?0:usage,moneyMinorUnits:null,currency:null,receiptId:'routing-attempt:'+digest(modelRequestId)})
    else await budgets.releaseUnaccepted(owner,{reservationId:reservation.id})
   }
   return
  }
  if(!run?.lineage)throw unavailable()
  const operationId=modelOperationId(positionEvents(ctx,position),position,run.id,request)
  const role=await(await runs()).executionAdmission(owner,run.id),controlled=await controls.acquireForRun(owner,{runId:run.id,mode:'continuation'})
  request.signal?.throwIfAborted();role.assertCurrent();controlled.lease.assertCurrent()
  if(pending.has(operationId))throw new WorkError('teloa/execution-pending','原模型请求仍在受理，不重复派发。')
  pending.set(operationId,{run,tokens,role})
  let claim:Awaited<ReturnType<WorkRetryService['claim']>>|undefined,reservationId:string|undefined,usage:number|null=null,finished=false,outputSeen=false,failure:LlmFailure|undefined,dispatched=false,finish:ModelFinish|undefined,streamActivitySeen=false
  try{
   await retries.register(owner,{runId:run.id,operationId})
   claim=await reserveOrExplain(()=>retries.claim(owner,{operationId,requestId:randomUUID(),expectedGeneration:controlled.control.generation}))
   if(!claim.dispatch)throw new WorkError('teloa/conflict','原模型操作已经完成，不能重复派发。')
   const reserve={budgetAccountId:run.lineage.budgetAccountId,controlGeneration:controlled.control.generation,modelRequestId:claim.modelRequestId,kind:'retry' as const,tokens,rounds:0}
   const reservation=await reserveOrExplain(()=>budgets.reserve(owner,reserve))
   reservationId=reservation.id
   request.signal?.throwIfAborted();claim.lease.assertCurrent();controlled.lease.assertCurrent()
   await budgets.markDispatched(owner,{reservationId});dispatched=true
   request.signal?.throwIfAborted();claim.lease.assertCurrent();controlled.lease.assertCurrent()
   for await(const chunk of next()){
    if(chunk.type!=='finish')streamActivitySeen=true
    if(chunk.type==='usage'){const current=usedTokens(chunk.usage);usage=current===null?null:Math.max(usage??0,current)}
    if(chunk.type==='finish'){finish=chunk.reason;finished=true;if(chunk.reason.kind==='error'||chunk.reason.kind==='aborted')failure=chunk.reason.failure}
    if(chunk.type==='text-delta'||chunk.type==='reasoning-delta'||chunk.type==='tool-call-delta')outputSeen=true
    request.signal?.throwIfAborted();claim.lease.assertCurrent();controlled.lease.assertCurrent();yield chunk
   }
  }finally{
   pending.delete(operationId)
   if(claim?.dispatch){
    const receiptId='model-attempt:'+digest([operationId,claim.attempt])
    const unsent=unsentCredentialFailure(finish,streamActivitySeen,request.signal)
    if(reservationId){
     if(dispatched)await budgets.settle(owner,{reservationId,modelRequestId:claim.modelRequestId,provider:request.provider,providerRequestId:null,tokens:unsent?0:usage,moneyMinorUnits:null,currency:null,receiptId})
     else await budgets.releaseUnaccepted(owner,{reservationId})
    }
    const outcome=unsent?'authentication':finished&&!failure?'success':failureOutcome(failure,outputSeen)
    await retries.record(owner,{operationId,attempt:claim.attempt,receiptId,outcome,reason:outcome==='success'?'模型本次请求已完成':outcome==='transient'?'提供方暂时拒绝请求，按有限次数稍后重试':outcome==='authentication'?'模型认证需要本人处理':outcome==='permission'?'模型权限需要本人处理':outcome==='conflict'?'模型请求冲突，需要核对原请求':'原模型请求结果未知，保留现场等待核对'})
    if(outcome!=='success')options.report('resident-model/'+outcome)
   }
  }
 },{global:true})
 return ()=>{dispose();pending.clear()}
}
