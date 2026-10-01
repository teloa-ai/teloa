import {WorkError,securityExecutionInput,securityObservationInput,type SecurityPrincipal,type SecurityActionDispatch,type SecurityActionExecution,type SecurityExecutionReceipt,type SecurityExecutionInput,type SecurityObservationInput} from '@teloa/contract'
import type {SecurityActionExecutionService} from '@teloa/backend'

export type SecurityActionAdapter={
 tool:string
 idempotency:{schema:'teloa.security-action-idempotency/v1';key:'operationId';persistence:'durable';sameRequest:'same-operation';differentRequest:'conflict'}
 ready(signal:AbortSignal):Promise<{ready:true}|{ready:false;reason:string}>
 execute(dispatch:SecurityActionDispatch,signal:AbortSignal):Promise<SecurityExecutionReceipt>
 observe(input:{operationId:string;actionId:string;targets:string[]},signal:AbortSignal):Promise<SecurityExecutionReceipt|null>
}
type ExecutionService=Pick<SecurityActionExecutionService,'toolForAction'|'claim'|'get'|'markUnknown'|'recordAccepted'|'recordEffect'|'observeWithJournal'>
const declaration={schema:'teloa.security-action-idempotency/v1',key:'operationId',persistence:'durable',sameRequest:'same-operation',differentRequest:'conflict'} as const
const unavailable=()=>new WorkError('teloa/dependency-unavailable','安全执行连接尚未证明持久 operationId 幂等能力。')

/** 只驱动领域服务与固定适配器；不声明原生工具、不读取会话授权。 */
export class SecurityActionExecutionDriver{
 private readonly service:ExecutionService
 private readonly adapters:Map<string,SecurityActionAdapter>
 constructor(service:ExecutionService,adapters:readonly SecurityActionAdapter[]){
  this.service=service;this.adapters=new Map(adapters.map(adapter=>[adapter.tool,adapter]))
  if(this.adapters.size!==adapters.length)throw new WorkError('teloa/invalid-input','安全执行适配器目录重复。')
 }
 async readiness(tool:string,signal:AbortSignal):Promise<{ready:true}|{ready:false;reason:string}>{
  signal.throwIfAborted()
  const adapter=this.adapters.get(tool)
  if(!adapter||!adapter.idempotency||Object.keys(adapter.idempotency).length!==Object.keys(declaration).length||
   Object.entries(declaration).some(([key,value])=>adapter.idempotency[key as keyof typeof declaration]!==value))return {ready:false,reason:'缺少持久 operationId 幂等执行适配器。'}
  try{const status=await adapter.ready(signal);signal.throwIfAborted();return status.ready===true?{ready:true}:{ready:false,reason:'安全执行连接尚未就绪。'}}
  catch(error){signal.throwIfAborted();return {ready:false,reason:'无法核对安全执行连接能力。'}}
 }
 private async adapter(tool:string,signal:AbortSignal):Promise<SecurityActionAdapter>{
  if(!(await this.readiness(tool,signal)).ready)throw unavailable()
  return this.adapters.get(tool)!
 }
 private async record(principal:SecurityPrincipal,operationId:string,receipt:SecurityExecutionReceipt):Promise<SecurityActionExecution>{
  return receipt?.status==='accepted'?this.service.recordAccepted(principal,{operationId,receipt}):this.service.recordEffect(principal,{operationId,receipt})
 }
 async run(principal:SecurityPrincipal,input:SecurityExecutionInput,signal:AbortSignal):Promise<SecurityActionExecution>{
  const request=securityExecutionInput(input)
  const tool=await this.service.toolForAction(principal,{actionId:request.actionId}),adapter=await this.adapter(tool,signal)
  signal.throwIfAborted()
  const claimed=await this.service.claim(principal,request)
  signal.throwIfAborted()
  if(!claimed.dispatch){
   try{return await this.recover(principal,claimed.execution.operationId,signal)}
   catch(error){signal.throwIfAborted();if(error instanceof WorkError)throw error;return this.service.get(principal,{operationId:claimed.execution.operationId})}
  }
  if(claimed.execution.dispatch.tool!==tool)throw unavailable()
  try{
   const receipt=await adapter.execute(structuredClone(claimed.execution.dispatch),signal);signal.throwIfAborted()
   return await this.record(principal,claimed.execution.operationId,receipt)
  }catch(error){
   signal.throwIfAborted()
   const unknown=await this.service.markUnknown(principal,{operationId:claimed.execution.operationId,reason:'外部执行回包未知；保留原操作身份和派发内容以便恢复。'})
   if(error instanceof WorkError)throw error
   return unknown
  }
 }
 async observe(principal:SecurityPrincipal,input:SecurityObservationInput,signal:AbortSignal):Promise<SecurityActionExecution>{
  signal.throwIfAborted();const request=securityObservationInput(input)
  return this.service.observeWithJournal(principal,request,()=>this.recover(principal,request.operationId,signal))
 }
 async recover(principal:SecurityPrincipal,operationId:string,signal:AbortSignal):Promise<SecurityActionExecution>{
  signal.throwIfAborted()
  const current=await this.service.get(principal,{operationId})
  operationId=current.operationId
  if(current.state==='succeeded'||current.state==='failed')return current
  const adapter=await this.adapter(current.dispatch.tool,signal)
  try{
   // 每次恢复先查原 operation；持久幂等声明允许查无或查询失联后重放相同 body。
   let observed:SecurityExecutionReceipt|null=null
   try{observed=await adapter.observe({operationId,actionId:current.actionId,targets:[...current.dispatch.targets]},signal)}
   catch(error){signal.throwIfAborted();if(error instanceof WorkError)throw error}
   signal.throwIfAborted()
   if(observed!==null)return await this.record(principal,operationId,observed)
   const receipt=await adapter.execute(structuredClone(current.dispatch),signal);signal.throwIfAborted()
   return await this.record(principal,operationId,receipt)
  }catch(error){
   signal.throwIfAborted()
   await this.service.markUnknown(principal,{operationId,reason:'恢复尚未证明外部效果；继续保留原操作身份和派发内容。'})
   throw error
  }
 }
}
