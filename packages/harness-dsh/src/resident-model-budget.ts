import {createHash,randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {GenerateOptions,StreamChunk,TokenUsage,LlmFailure} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry'
import {SessionId} from '@deepseek-ai/dsh-session'
import {WorkError} from '@teloa/contract'
import {WorkRetryService,combineWorkAccessLeases,type TaskRunService,type TaskRun,type WorkControlService,type WorkBudgetService,type WorkAccessLease} from '@teloa/backend'
import type {createNativeWorkInput} from './native-work-input.ts'
import {readSessionEvents} from './session-events.ts'

type Position={sessionId:string;turn:number;step:number}
export type ResidentRoutingBudget={budgetAccountId:string|null;controlGeneration:number;operationId:string;lease:WorkAccessLease}
type Options={owner:string;pool:TaskRunService['pool'];identity:{id:()=>string;now:()=>string};runs:()=>Promise<TaskRunService>;controls:WorkControlService;budgets:WorkBudgetService;resolveRun:(sessionId:string)=>Promise<TaskRun|null>;resolveRouting?:(sessionId:string)=>Promise<ResidentRoutingBudget|null>;nativeInput:Pick<ReturnType<typeof createNativeWorkInput>,'modelPosition'>;report:(code:string)=>void}
type Attempt={run:TaskRun;tokens:number;role:WorkAccessLease}
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const unavailable=()=>new WorkError('teloa/unavailable','当前模型请求没有完整的受控工作准入。')
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0

/** 用实际提供方计数，缓存输入与普通输入是互斥项，不按流片段重复累加。 */
function usedTokens(usage:TokenUsage):number|null{
 if(!count(usage.inputTokens)||!count(usage.outputTokens)||usage.cacheReadTokens!==undefined&&!count(usage.cacheReadTokens)||usage.cacheWriteTokens!==undefined&&!count(usage.cacheWriteTokens))return null
 const sum=usage.inputTokens+usage.outputTokens+(usage.cacheReadTokens??0)+(usage.cacheWriteTokens??0)
 if(usage.totalTokens!==undefined&&(!count(usage.totalTokens)||usage.totalTokens<sum))return null
 const result=usage.totalTokens??sum;return count(result)?result:null
}
function failureOutcome(failure:LlmFailure|undefined,outputSeen:boolean):'transient'|'authentication'|'permission'|'conflict'|'unknown'{
 if(!failure||outputSeen)return 'unknown'
 if(failure.status===401||failure.code==='AUTHENTICATION_ERROR')return 'authentication'
 if(failure.status===403||failure.code==='PERMISSION_DENIED')return 'permission'
 if(failure.status===409)return 'conflict'
 // 明确拒绝的模型请求可以有限重试；传输中断或丢失回包保留未知，不自动重放。
 if(failure.status===429||failure.status===503||failure.code==='RATE_LIMITED')return 'transient'
 return 'unknown'
}
function operationStep(ctx:Context,position:Position):number{
 const agent=ctx.agents.get(SessionId(position.sessionId));if(!agent)throw unavailable()
 const events=readSessionEvents(agent.session)
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
  if(!request.sessionId){yield* next();return}
  const run=await options.resolveRun(request.sessionId)
  const routing=run?null:await options.resolveRouting?.(request.sessionId)
  if(!run&&!routing){yield* next();return}
  if(run&&(!run.roleSnapshot||!run.lineage))throw new WorkError('teloa/conflict','历史任务需要建立新的受控执行，不能自动重放。')
  const position=nativeInput.modelPosition(request)
  if(!position||position.sessionId!==request.sessionId)throw unavailable()
  // 官方 prepared call 已把提供方输出上限写回原请求；未知上限不能承诺有限预留。
  if(!count(request.maxTokens)||request.maxTokens<1)throw new WorkError('teloa/conflict','请为这个模型设置输出上限后继续工作。')
  const tokens=Buffer.byteLength(JSON.stringify({messages:request.messages,system:request.system,tools:request.tools,toolHistory:request.toolHistory}),'utf8')+request.maxTokens
  if(!count(tokens))throw unavailable()
  if(routing){
   routing.lease.assertCurrent();request.signal?.throwIfAborted()
   const modelRequestId='routing:'+digest([routing.operationId,position.sessionId,position.turn,operationStep(ctx,position),request.provider,request.model])
   const reservation=routing.budgetAccountId===null?await budgets.reserveOwnerRouting(owner,{modelRequestId,tokens}):await budgets.reserve(owner,{budgetAccountId:routing.budgetAccountId,controlGeneration:routing.controlGeneration,modelRequestId,kind:'routing',tokens,rounds:0})
   const lease=combineWorkAccessLeases([routing.lease,budgets.lease(owner,reservation)])
   let dispatched=false,usage:number|null=null
   try{
    request.signal?.throwIfAborted();lease.assertCurrent();await budgets.markDispatched(owner,{reservationId:reservation.id});dispatched=true
    request.signal?.throwIfAborted();lease.assertCurrent()
    for await(const chunk of next()){
     if(chunk.type==='usage'){const current=usedTokens(chunk.usage);usage=current===null?null:Math.max(usage??0,current)}
     request.signal?.throwIfAborted();lease.assertCurrent();yield chunk
    }
   }finally{
    if(dispatched)await budgets.settle(owner,{reservationId:reservation.id,modelRequestId,provider:request.provider,providerRequestId:null,tokens:usage,moneyMinorUnits:null,currency:null,receiptId:'routing-attempt:'+digest(modelRequestId)})
    else await budgets.releaseUnaccepted(owner,{reservationId:reservation.id})
   }
   return
  }
  if(!run?.lineage)throw unavailable()
  const operationId='model:'+digest([run.id,position.sessionId,position.turn,operationStep(ctx,position),request.purpose??null,request.provider,request.model])
  const role=await(await runs()).executionAdmission(owner,run.id),controlled=await controls.acquireForRun(owner,{runId:run.id,mode:'continuation'})
  request.signal?.throwIfAborted();role.assertCurrent();controlled.lease.assertCurrent()
  if(pending.has(operationId))throw new WorkError('teloa/execution-pending','原模型请求仍在受理，不重复派发。')
  pending.set(operationId,{run,tokens,role})
  let claim:Awaited<ReturnType<WorkRetryService['claim']>>|undefined,reservationId:string|undefined,usage:number|null=null,finished=false,outputSeen=false,failure:LlmFailure|undefined,dispatched=false
  try{
   await retries.register(owner,{runId:run.id,operationId})
   claim=await retries.claim(owner,{operationId,requestId:randomUUID(),expectedGeneration:controlled.control.generation})
   if(!claim.dispatch)throw new WorkError('teloa/conflict','原模型操作已经完成，不能重复派发。')
   const reservation=await budgets.reserve(owner,{budgetAccountId:run.lineage.budgetAccountId,controlGeneration:controlled.control.generation,modelRequestId:claim.modelRequestId,kind:'retry',tokens,rounds:0})
   reservationId=reservation.id
   request.signal?.throwIfAborted();claim.lease.assertCurrent();controlled.lease.assertCurrent()
   await budgets.markDispatched(owner,{reservationId});dispatched=true
   request.signal?.throwIfAborted();claim.lease.assertCurrent();controlled.lease.assertCurrent()
   for await(const chunk of next()){
    if(chunk.type==='usage'){const current=usedTokens(chunk.usage);usage=current===null?null:Math.max(usage??0,current)}
    if(chunk.type==='finish'){finished=true;if(chunk.reason.kind==='error'||chunk.reason.kind==='aborted')failure=chunk.reason.failure}
    if(chunk.type==='text-delta'||chunk.type==='reasoning-delta'||chunk.type==='tool-call-delta')outputSeen=true
    request.signal?.throwIfAborted();claim.lease.assertCurrent();controlled.lease.assertCurrent();yield chunk
   }
  }finally{
   pending.delete(operationId)
   if(claim?.dispatch){
    const receiptId='model-attempt:'+digest([operationId,claim.attempt])
    if(reservationId){
     if(dispatched)await budgets.settle(owner,{reservationId,modelRequestId:claim.modelRequestId,provider:request.provider,providerRequestId:null,tokens:usage,moneyMinorUnits:null,currency:null,receiptId})
     else await budgets.releaseUnaccepted(owner,{reservationId})
    }
    const outcome=finished&&!failure?'success':failureOutcome(failure,outputSeen)
    await retries.record(owner,{operationId,attempt:claim.attempt,receiptId,outcome,reason:outcome==='success'?'模型本次请求已完成':outcome==='transient'?'提供方暂时拒绝请求，按有限次数稍后重试':outcome==='authentication'?'模型认证需要本人处理':outcome==='permission'?'模型权限需要本人处理':outcome==='conflict'?'模型请求冲突，需要核对原请求':'原模型请求结果未知，保留现场等待核对'})
    if(outcome!=='success')options.report('resident-model/'+outcome)
   }
  }
 },{global:true})
 return ()=>{dispose();pending.clear()}
}
