import {AsyncLocalStorage} from 'node:async_hooks'
import {randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {SessionId} from '@deepseek-ai/dsh-session'
import type {PreToolDecision,ToolExecution} from '@deepseek-ai/dsh-tools'
import type {TaskRun,TaskRunRuntimeLink,TaskRunRuntimeLinks} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {nativeBrowserToolNames} from './native-tool-access.ts'
import {resolveSessionLineage} from './subagent-lineage.ts'
import {taskToolArgumentsAllowed} from './task-tool-arguments.ts'
import type {TaskToolPolicy,TaskToolPolicyReader} from './task-tool-guard.ts'
import {taskRunRuntimeId} from './task-run-background.ts'
import type {TaskRunPorts} from './task-run-driver.ts'
import {createSessionBrowserStop} from './session-browser-stop.ts'
import {createNativeResourceCleanupOwner} from './native-resource-cleanup.ts'

type Binding=Pick<TaskRun,'id'|'sessionId'|'nativeRequestId'>
type BrowserLink=Extract<TaskRunRuntimeLink,{kind:'browser'}>
type Receipt={agent:Agent;link:BrowserLink}
type CleanupMode='stop'|'child-release'
type CleanupToken={mode:CleanupMode;run:Binding;agent:Agent;callId:ToolCallId;consumed:boolean;blocked:boolean;exec?:ToolExecution}
const closeTool='mcp__playwright-mcp__browser_close'
const empty=(value:unknown)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===0
const sameRun=(first:Binding,second:Binding)=>first.id===second.id&&first.nativeRequestId===second.nativeRequestId
const denied=()=>new WorkError('teloa/forbidden','浏览器收尾未获原任务关闭授权，任务仍在停止中。')
/** 只有同一宿主闭包能产生授权；工具参数、callId 字面量和模型消息均不是凭据。 */
export type TaskBrowserCleanupAccess={
 consume:(exec:ToolExecution,policy:TaskToolPolicy|null)=>Promise<boolean>
 issue:(exec:ToolExecution)=>string|undefined
 decision:(exec:ToolExecution,decision:PreToolDecision)=>void
}

/** 仅记 Run 与官方 Browser Session 的派发/关闭事实，不实现浏览器或伪造 Session 事件。 */
export function createTaskRunBrowser(ctx:Context,links:TaskRunRuntimeLinks,readPolicy:TaskToolPolicyReader,runtimeId=taskRunRuntimeId){
 const sessionStop=createSessionBrowserStop(ctx)
 const bindings=new Map<string,Binding>(),receipts=new Map<string,Receipt>(),active=new Map<string,number>()
 const closing=new Map<Agent,Promise<void>>(),maintaining=new WeakSet<Agent>()
 const authorization=new AsyncLocalStorage<CleanupToken>(),cancelling=new Map<string,Promise<{closed:boolean;reason?:string}>>()
 const bind=(run:Binding)=>{
  const previous=bindings.get(run.sessionId)
  if(previous&&!sameRun(previous,run))throw new WorkError('teloa/storage-corrupt','浏览器会话已属于另一条执行。')
  bindings.set(run.sessionId,{id:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId})
 }
 const journal=async(run:Binding)=>{
  const rows=(await links.list({runId:run.id,kind:'browser'})).filter((row):row is BrowserLink=>row.kind==='browser')
  if(rows.some(row=>row.runId!==run.id||row.payload.requestId!==run.nativeRequestId))throw new WorkError('teloa/storage-corrupt','浏览器派发归属与任务请求不一致。')
  return rows
 }
 const owned=(row:BrowserLink)=>{
  const receipt=receipts.get(row.nativeId),binding=bindings.get(row.sessionId)
  return row.payload.runtimeId===runtimeId&&receipt?.link.runId===row.runId&&receipt.link.payload.requestId===row.payload.requestId&&binding?.id===row.runId&&binding.nativeRequestId===row.payload.requestId&&ctx.agents.get(SessionId(row.sessionId))===receipt.agent?receipt:undefined
 }
 const cleanupOwner=createNativeResourceCleanupOwner(ctx,agent=>{
  const token=authorization.getStore()
  return !!token&&!token.blocked&&token.agent===agent&&[...receipts.values()].some(receipt=>receipt.link.payload.status==='dirty'&&sameRun(token.run,{id:receipt.link.runId,nativeRequestId:receipt.link.payload.requestId,sessionId:receipt.link.sessionId})&&owned(receipt.link)?.agent===agent)
 })
 const policyFor=(agent:Agent,signal:AbortSignal)=>readPolicy(resolveSessionLineage(ctx,agent.session).root.id,signal)
 const permitted=(policy:TaskToolPolicy|null,run:Binding,mode:CleanupMode)=>policy?.nativeRequestId===run.nativeRequestId&&(policy.stopRequested===true||mode==='child-release'&&policy.allowedTools.includes(closeTool))&&taskToolArgumentsAllowed(policy.argumentRules,closeTool,{})
 const matches=(token:CleanupToken,exec:ToolExecution)=>token.agent===exec.agent&&token.callId===exec.callId&&exec.name===closeTool&&empty(exec.arguments)&&exec.parent===undefined
 const cleanup:TaskBrowserCleanupAccess={
  async consume(exec,policy){
   const token=authorization.getStore()
   if(!token||token.consumed||!matches(token,exec))return false
   token.consumed=true
   if(!permitted(policy,token.run,token.mode)||!await hasOwnedDirty(token.run,token.agent))return false
   token.exec=exec;return true
  },
  issue(exec){
   const token=authorization.getStore()
   return !token||token.blocked||token.exec!==exec||!matches(token,exec)?'浏览器收尾授权已失效，任务仍在停止中。':undefined
  },
  decision(exec,decision){const token=authorization.getStore();if(token?.exec===exec&&decision.kind!=='allow')token.blocked=true},
 }
 async function hasOwnedDirty(run:Binding,agent:Agent){return (await journal(run)).some(row=>row.payload.status==='dirty'&&row.sessionId===agent.session.id&&owned(row)?.agent===agent)}
 const disposeTools=ctx.on('tools/execute',async(exec,next)=>{
  if(!exec.agent||!nativeBrowserToolNames.includes(exec.name))return next()
  const agent=exec.agent,policy=await policyFor(agent,exec.signal),run=bindings.get(agent.session.id)
  if(policy===null){if(run)throw denied();return sessionStop.dispatch(exec,next)}
  if(!run||policy.nativeRequestId!==run.nativeRequestId)throw new WorkError('teloa/forbidden','浏览器派发缺少本次任务的持久归属。')
  const token=authorization.getStore(),trusted=token?.exec===exec
  // 审批等待期间停止，或下游 wrapper 改写身份，都不能在派发口取得一次迟到的动作。
  if(policy.stopRequested===true&&(!trusted||cleanup.issue(exec)||!permitted(policy,run,token?.mode??'stop')))throw denied()
  if(trusted&&(!sameRun(token.run,run)||cleanup.issue(exec)||!permitted(policy,run,token?.mode??'stop')))throw denied()
  exec.signal.throwIfAborted()
  const dispatchId=randomUUID(),link:BrowserLink={runId:run.id,kind:'browser',nativeId:runtimeId+':'+dispatchId,sessionId:run.sessionId,payload:{runtimeId,requestId:run.nativeRequestId,dispatchId,status:'dirty'}}
  active.set(run.id,(active.get(run.id)??0)+1)
  try{
   // 存储失败不进入官方工具体；导航被取消后仍有页面请求时，这条记录不会漏掉。
   await links.put(link);receipts.set(link.nativeId,{agent,link})
   exec.signal.throwIfAborted()
   const before=exec.name===closeTool?(await journal(run)).filter(row=>row.sessionId===run.sessionId&&row.payload.status==='dirty'&&owned(row)?.agent===agent):[]
   const result=await next()
   if(exec.name===closeTool&&!result.isError&&!exec.signal.aborted){
    for(const row of before){const closed:BrowserLink={...row,payload:{...row.payload,status:'closed'}};await links.put(closed);receipts.set(row.nativeId,{agent,link:closed})}
   }
   return result
  }finally{const remaining=(active.get(run.id)??1)-1;if(remaining)active.set(run.id,remaining);else active.delete(run.id)}
 })
 const state=async(run:Binding):Promise<{dirty:boolean;outstanding:boolean;interrupted:boolean}>=>{
  const rows=(await journal(run)).filter(row=>row.payload.status==='dirty')
  const interrupted=rows.some(row=>!owned(row))
  let stopping=false
  for(const row of rows){const receipt=owned(row);if(receipt&&(await policyFor(receipt.agent,AbortSignal.timeout(5000)))?.stopRequested===true)stopping=true}
  return {dirty:rows.length>0,outstanding:interrupted||rows.some(row=>row.sessionId!==run.sessionId)||[...closing.keys()].some(agent=>bindings.get(agent.session.id)?.id===run.id)||(active.get(run.id)??0)>0||stopping&&rows.length>0,interrupted}
 }
 const closeAgent=(run:Binding,agent:Agent,signal:AbortSignal,mode:CleanupMode):Promise<void>=>{
  const pending=closing.get(agent);if(pending)return pending
  const operation=(async()=>{
   signal.throwIfAborted()
   const binding=bindings.get(agent.session.id)
   if(!binding||!sameRun(binding,run)||!permitted(await policyFor(agent,signal),binding,mode))throw denied()
   if(!await hasOwnedDirty(binding,agent))return
   const token:CleanupToken={mode,run:binding,agent,callId:ToolCallId('teloa-browser-close-'+randomUUID()),consumed:false,blocked:false}
   const result=await authorization.run(token,()=>cleanupOwner.execute(agent,token.callId,signal))
   if(result.isError)throw denied()
  })()
  closing.set(agent,operation)
  void operation.finally(()=>{if(closing.get(agent)===operation)closing.delete(agent)}).catch(()=>{})
  return operation
 }
 // 官方子级 owner 在 whenIdle 后释放 Agent。同步占用公开维护阶段，让卸载等待真实关闭回执；
 // 正常结束、取消和出错均经过 idle。父会话保留页面，不能按全局 Agent 卸载推断关闭成功。
 // 回收使用独立有界超时：后来的 user/parent cancel 不得再次打断它要等待的资源关闭。
 const disposeStatus=ctx.on('agent/status',({agent,status})=>{
  if(status!=='idle'||maintaining.has(agent))return
  const run=bindings.get(agent.session.id)
  if(!run||!agent.session.header.parentSession||![...receipts.values()].some(row=>row.agent===agent&&row.link.payload.status==='dirty'))return
  maintaining.add(agent)
  try{
   const operation=agent.runMaintenance(()=>closeAgent(run,agent,AbortSignal.timeout(10000),'child-release'))
   void operation.catch(()=>{ctx.logger.warn('受管子会话的浏览器资源回收未确认，保留未结清记录。')}).finally(()=>maintaining.delete(agent))
  }catch{maintaining.delete(agent)}
 })
 const cancel=async(run:Binding,signal:AbortSignal):Promise<{closed:boolean;reason?:string}>=>{
  signal.throwIfAborted()
  const previous=cancelling.get(run.id);if(previous)return previous
  const pending=(async()=>{
   const rows=(await journal(run)).filter(row=>row.payload.status==='dirty'),agents=new Set<Agent>()
   let reason:string|undefined
   for(const row of rows){const receipt=owned(row);if(!receipt)reason='浏览器收尾归属已中断，不能确认资源已经释放。';else agents.add(receipt.agent)}
   for(const agent of agents){
    try{await closeAgent(run,agent,signal,'stop')}
    catch{reason='浏览器收尾未获授权、已取消或未成功，任务仍在停止中。'}
   }
   const remaining=await state(run)
   return {closed:!remaining.dirty&&!(active.get(run.id)??0),...(reason?{reason}:{})}
  })()
  cancelling.set(run.id,pending)
  try{return await pending}finally{if(cancelling.get(run.id)===pending)cancelling.delete(run.id)}
 }
 return {bind,state,cancel,cleanup,sessionState:sessionStop.state,dispose:async()=>{await sessionStop.dispose();disposeStatus();await Promise.allSettled([...closing.values()]);cleanupOwner.close();disposeTools()}}
}

/** 将资源回收纳入已有 Run 收口；不以取消回执替代官方浏览器的关闭结果。 */
export function attachTaskRunBrowser(ports:TaskRunPorts,browser:ReturnType<typeof createTaskRunBrowser>):void{
 const {send,backgroundState,stopChildren,stopState}=ports
 ports.send=async(run,signal,target)=>{browser.bind(run);await send(run,signal,target)}
 ports.backgroundState=async run=>{
  const previous=await backgroundState?.(run),current=await browser.state(run)
  return {outstanding:previous?.outstanding===true||current.outstanding,interrupted:previous?.interrupted===true||current.interrupted,...(previous?.ownerOnly===true&&!current.dirty&&!current.outstanding&&!current.interrupted?{ownerOnly:true}:{})}
 }
 ports.stopChildren=async(run,signal)=>{
  // 子级取消失败也继续回收已登记页面；任一失败都保留停止中，供下次核对重试。
  const [children]=await Promise.allSettled([stopChildren?.(run,signal)])
  const result=await browser.cancel(run,signal)
  if(children?.status==='rejected')throw children.reason
  if(!result.closed)throw new WorkError('teloa/execution-pending',result.reason??'浏览器尚未完成回收，任务仍在停止中。')
 }
 ports.stopState=async run=>{
  if((await browser.state(run)).outstanding)return {running:true,settledSeq:null}
  return await stopState?.(run)??{running:false,settledSeq:null}
 }
}
