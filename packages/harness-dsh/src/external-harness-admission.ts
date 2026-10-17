import {AsyncLocalStorage} from 'node:async_hooks'
import {realpath} from 'node:fs/promises'
import type {Context} from '@deepseek-ai/cordis'
import type {ToolExecution,ToolDefinition} from '@deepseek-ai/dsh-tools'
import type {SubagentActivation,SubagentProvider} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {TaskRunRuntimeLinks,ExternalHarnessProvider,ExternalHarnessStatus} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {installActivationAdmission} from './subagent-activation-admission.ts'
import type {ExternalHarnessMetadata} from './external-harness-status.ts'
import {isPlatformModelProvider} from './platform-model-connection.ts'
import {isPlatformNativeProvider} from './platform-native-provider.ts'
import {harnessDirectiveDenial,type HarnessDirective} from './harness-routing.ts'

export type ExternalHarnessPermit=Readonly<{
 /** 本人普通会话不伪造业务 Run；受管 Run 必须由宿主证明内部边界等价。 */
 runId:string|null;requestId:string;reservationId:string;runtimeId:string;workspaceRoot:string;provider:ExternalHarnessProvider
 assertCurrent:()=>void
}>
export type ExternalHarnessPorts=Readonly<{
 preference?:(exec:ToolExecution)=>HarnessDirective
 authorize:(input:{sessionId:string;callId:string;provider:ExternalHarnessProvider;signal:AbortSignal})=>Promise<ExternalHarnessPermit>
 reserve:(permit:ExternalHarnessPermit)=>Promise<void>
 links:TaskRunRuntimeLinks
 save:(metadata:ExternalHarnessMetadata)=>Promise<void>
 consent:(input:Readonly<{exec:ToolExecution;permit:ExternalHarnessPermit}>)=>Promise<void>
}>
export type ExternalHarnessControl=Readonly<{stop:(runId:string,signal:AbortSignal)=>Promise<void>;stopActivation:(sessionId:string,activationId:string,signal:AbortSignal)=>Promise<void>;current:(sessionId:string,activationId:string)=>ExternalHarnessStatus|undefined;dispose:()=>Promise<void>}>
const providers:Readonly<Record<string,ExternalHarnessProvider>>={subagent_codex:'codex',subagent_claude_code:'claude-code'}
export const externalHarnessTools=Object.freeze(Object.keys(providers))
const denied=(message='外部引擎没有当前工具调用与执行许可，请从原会话重新发起。')=>new WorkError('teloa/forbidden',message)
type Scope={exec:ToolExecution;definition:ToolDefinition;provider:SubagentProvider;permit:ExternalHarnessPermit;active:boolean;consumed:boolean;cleanup:Array<()=>void>}
type ExternalExecutionRecord={permit:ExternalHarnessPermit;sessionId:string;activation?:SubagentActivation;status:ExternalHarnessStatus;done?:Promise<void>}

/** 工具调用只授权其真实 activation；执行、结果通知和资源释放仍由官方 manager 拥有。 */
export function registerExternalHarnessAdmission(ctx:Context,ports:ExternalHarnessPorts):ExternalHarnessControl{
 const scopes=new AsyncLocalStorage<Scope>(),checked=new WeakMap<ToolExecution,{definition:ToolDefinition;provider:SubagentProvider;workspaceRoot:string}>()
 const seen=new Set<string>(),stopped=new Set<string>(),records=new Map<string,ExternalExecutionRecord>(),starting=new Map<Promise<unknown>,{runId:string|null;controller:AbortController}>(),closing=new AbortController()
 let closed=false,disposal:Promise<void>|undefined
 const authorize=async(exec:ToolExecution,provider:ExternalHarnessProvider)=>{
  if(closed||!exec.agent||ctx.agents.get(exec.agent.id)!==exec.agent)throw denied()
  exec.signal.throwIfAborted()
  const directive=ports.preference?.(exec),selectionDenial=directive?harnessDirectiveDenial(directive,provider):undefined
  if(selectionDenial)throw denied(selectionDenial)
  const permit=await ports.authorize({sessionId:exec.agent.id,callId:exec.callId,provider,signal:exec.signal})
  if(!permit||permit.provider!==provider||!permit.reservationId||!permit.requestId||!permit.runtimeId||typeof permit.assertCurrent!=='function'||permit.runId!==null&&(typeof permit.runId!=='string'||stopped.has(permit.runId))||await realpath(permit.workspaceRoot)!==permit.workspaceRoot)throw denied()
  permit.assertCurrent();exec.signal.throwIfAborted()
  if(closed||ctx.agents.get(exec.agent.id)!==exec.agent)throw denied()
  return permit
 }
 const write=async(record:ExternalExecutionRecord,status:ExternalHarnessStatus)=>{
  if(record.permit.runId!==null)await ports.links.put({runId:record.permit.runId,kind:'external',nativeId:record.permit.reservationId,sessionId:record.sessionId,payload:{provider:record.permit.provider,runtimeId:record.permit.runtimeId,requestId:record.permit.requestId,reservationId:record.permit.reservationId,workspaceRoot:record.permit.workspaceRoot,...record.activation?{activationId:record.activation.childId}:{},status}})
  const {assertCurrent:_assert,...identity}=record.permit
  await ports.save({...identity,sessionId:record.sessionId,...record.activation?{activationId:record.activation.childId}:{},status})
  record.status=status
 }
 const removePre=ctx.on('tools/pre-execute',async(exec,next)=>{
  const provider=providers[exec.name];if(!provider)return next()
  try{
   const permit=await authorize(exec,provider),definition=ctx.tools.get(exec.name,exec.agent),native=ctx.subagents.getProvider(provider)
   if(!definition||!native||native.prepareContinuable!==undefined)throw denied('外部引擎尚未加载，请核对扩展状态后重试。')
   if(isPlatformModelProvider(exec.agent?.session.requestContext()?.provider)&&!isPlatformNativeProvider(native))throw denied('此引擎刚启用，请重启当前实例以接入平台模型认证；本次未启动引擎。')
   checked.set(exec,{definition,provider:native,workspaceRoot:permit.workspaceRoot})
   return next()
  }catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'当前无法核对外部引擎的执行范围，请稍后重试。'}}
 })
 const removeExecute=ctx.on('tools/execute',async(exec,next)=>{
  const provider=providers[exec.name];if(!provider)return next()
  const prior=checked.get(exec),permit=await authorize(exec,provider)
  if(!prior||ctx.tools.get(exec.name,exec.agent)!==prior.definition||ctx.subagents.getProvider(provider)!==prior.provider||permit.workspaceRoot!==prior.workspaceRoot)throw denied('确认期间外部引擎或工作目录已变化，请重新发起。')
  const scope:Scope={exec,definition:prior.definition,provider:prior.provider,permit,active:true,consumed:false,cleanup:[]}
  try{await ports.consent({exec,permit});permit.assertCurrent();exec.signal.throwIfAborted();return await scopes.run(scope,next)}finally{scope.active=false;for(const remove of scope.cleanup)remove()}
 })
 const removeAdmission=installActivationAdmission(ctx.subagents,async(spec,start)=>{
  const provider=ctx.subagents.getProvider(spec.provider)
  if(provider?.prepareContinuable!==undefined)return start(spec)
  const scope=scopes.getStore()
  if(closed||!scope?.active||scope.consumed||spec.provider!==scope.permit.provider||provider!==scope.provider||spec.request.parent!==scope.exec.agent||spec.delivery!=='parent'||spec.childId!==undefined||ctx.tools.get(scope.exec.name,scope.exec.agent)!==scope.definition)throw denied()
  scope.consumed=true
  const permit=scope.permit,agent=scope.exec.agent!,controller=new AbortController(),signal=AbortSignal.any([scope.exec.signal,spec.signal,closing.signal,controller.signal])
  const operation=(async()=>{
   permit.assertCurrent();signal.throwIfAborted();if(permit.runId!==null&&stopped.has(permit.runId))throw denied('本次执行已停止。')
   if(await realpath(await ctx.workingDirectory.ensure(agent,signal))!==permit.workspaceRoot||spec.request.cwd!==undefined&&await realpath(spec.request.cwd)!==permit.workspaceRoot)throw denied('外部引擎的工作目录已变化，请重新发起。')
   if(seen.has(permit.reservationId))throw denied('本次外部工作已有回执，请核对原执行，不能重复派发。')
   seen.add(permit.reservationId)
   const record:ExternalExecutionRecord={permit,sessionId:agent.id,status:'reserved'}
   records.set(permit.reservationId,record)
   try{
    await ports.reserve(permit)
    await write(record,'reserved')
    const current=await authorize(scope.exec,permit.provider)
    for(const key of ['runId','requestId','reservationId','runtimeId','workspaceRoot','provider'] as const)if(current[key]!==permit[key])throw denied('外部执行归属在启动前已变化，请核对原请求。')
    current.assertCurrent()
    permit.assertCurrent();signal.throwIfAborted()
    if(closed||!scope.active||ctx.agents.get(agent.id)!==agent||ctx.subagents.getProvider(spec.provider)!==provider||ctx.tools.get(scope.exec.name,scope.exec.agent)!==scope.definition)throw denied()
    record.activation=await start({...spec,signal,request:{...spec.request,cwd:permit.workspaceRoot}})
    // 发布后 signal 已不拥有原生执行；工具体尚未返回时的真实取消仍必须释放句柄。
    const cancel=()=>{if(scope.active)void record.activation!.dispose().catch(()=>{})}
    scope.exec.signal.addEventListener('abort',cancel,{once:true})
    scope.cleanup.push(()=>scope.exec.signal.removeEventListener('abort',cancel))
    if(scope.exec.signal.aborted)cancel()
    await write(record,'running')
    record.done=record.activation.result.then(async result=>{
     await record.activation!.dispose()
     await write(record,result.stopReason==='completed'?'completed':result.stopReason==='aborted'?'aborted':'failed')
     records.delete(permit.reservationId)
    },async()=>{await write(record,'unknown')}).catch(async()=>{
     record.status='unknown';await write(record,'unknown').catch(()=>{})
     ctx.logger.warn('外部执行收尾记录待核对：%s',permit.reservationId)
    })
    return record.activation
   }catch(error){
    if(record.activation){
     await record.activation.dispose().catch(()=>{})
     await write(record,'unknown').catch(()=>{});record.status='unknown'
    }else{await write(record,signal.aborted?'aborted':'failed').catch(()=>{record.status='unknown'});if(record.status!=='unknown')records.delete(permit.reservationId)}
    throw error
   }
  })()
  starting.set(operation,{runId:permit.runId,controller})
  try{return await operation}finally{starting.delete(operation)}
 },'external')
 const settle=async(selected:readonly ExternalExecutionRecord[])=>{
  const results=await Promise.allSettled(selected.map(async record=>{
   if(record.activation){
    if(record.status==='running')await write(record,'stopping').catch(()=>{record.status='unknown'})
    await record.activation.dispose();await record.done
   }
   if(record.status==='unknown')throw new Error('external settlement is unknown')
  }))
  if(results.some(result=>result.status==='rejected'))throw new WorkError('teloa/execution-pending','外部工作尚未确认停止，请核对原执行状态。')
 }
 return Object.freeze({
  current(sessionId:string,activationId:string){return [...records.values()].find(record=>record.sessionId===sessionId&&record.activation?.childId===activationId)?.status},
  async stopActivation(sessionId:string,activationId:string,signal:AbortSignal){
   signal.throwIfAborted()
   const record=[...records.values()].find(record=>record.sessionId===sessionId&&record.activation?.childId===activationId)
   if(!record)throw new WorkError('teloa/execution-pending','当前宿主没有此外部执行的取消句柄，请核对原状态。')
   await settle([record]);signal.throwIfAborted()
  },
  async stop(runId:string,signal:AbortSignal){
   signal.throwIfAborted();stopped.add(runId)
   const pending=[...starting].filter(([,entry])=>entry.runId===runId)
   for(const [,entry] of pending)entry.controller.abort()
   await Promise.allSettled(pending.map(([operation])=>operation))
   await settle([...records.values()].filter(record=>record.permit.runId===runId));signal.throwIfAborted()
  },
  dispose(){
   if(disposal)return disposal
   closed=true;closing.abort()
   disposal=(async()=>{await Promise.allSettled([...starting.keys()]);try{await settle([...records.values()])}finally{removePre();removeExecute();removeAdmission()}})()
   return disposal
  },
 })
}
