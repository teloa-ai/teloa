import {randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {SessionController} from '@deepseek-ai/dsh-api-session-controller'
import {createUserMessage,ToolCallId,type ContextFormed} from '@deepseek-ai/dsh-llm'
import {SessionId,type SessionStore} from '@deepseek-ai/dsh-session'
import type {ToolExecution,ToolExecutionResult} from '@deepseek-ai/dsh-tools'

const closeTool='mcp__playwright-mcp__browser_close'
export const browserStopSource='plugin:teloa.browser-stop' as const
type BrowserStopState='ready'|'unconfirmed'|'isolated'
declare module '@deepseek-ai/dsh-llm' {interface MessageSourceMap {'plugin:teloa.browser-stop':{kind:typeof browserStopSource;state:BrowserStopState}&ContextFormed}}
type State={dispatched:number;closed:number;requested:boolean;closing:boolean;unconfirmed:boolean}
// MCP 超时不等于服务端关闭结束；同一 live Agent 重新装配适配器也不能据此解除隔离。
const closeUnknown=new WeakSet<Agent>()
const unknownMessage='浏览器关闭结果未确认，本会话的浏览器操作已暂停，避免迟到的关闭影响新页面。普通聊天仍可继续；如需浏览网页，请新建会话。'

/** rc.1 普通取消只中止工具等待。复用官方维护阶段与关闭工具，既不释放 Agent，也不清空排队消息。 */
export function createSessionBrowserStop(ctx:Context){
 const states=new WeakMap<Agent,State>(),pending=new Set<Promise<void>>()
 let disposed=false
 const current=(agent:Agent)=>ctx.agents.get(agent.session.id)===agent
 const record=async(agent:Agent,state:BrowserStopState)=>{
  if(!current(agent))return
  const summary=state==='ready'?'浏览器已关闭':'浏览器操作尚未确认停止'
  const text=state==='ready'?'浏览器已确认关闭，可以继续本会话。':state==='isolated'?unknownMessage:'浏览器关闭未成功或未获授权，页面可能仍在运行。聊天记录和排队消息已保留；请在当前会话中关闭浏览器后再继续浏览器操作。'
  agent.session.append('user/message',createUserMessage({source:{kind:browserStopSource,form:'notice',summary,state},content:[{type:'text',text}]}),{surfaceOp:'append'})
  const sessions=Reflect.get(ctx,'sessions') as unknown as SessionStore
  await sessions.flush(agent.session)
 }
 const failed=async(agent:Agent)=>{
  const state=states.get(agent);if(state)state.unconfirmed=true
  await record(agent,closeUnknown.has(agent)?'isolated':'unconfirmed')
 }
 const maintain=(agent:Agent,state:State)=>{
  if(disposed||!current(agent)||!state.requested||state.closing||agent.status!=='idle')return
  state.requested=false
  if(state.closed===state.dispatched)return
  state.closing=true
  let operation:Promise<void>
  try{
   // 必须同步占用 idle；官方队列才能在后续消息唤醒前等待收尾。重复停止不复用维护的取消信号。
   operation=agent.runMaintenance(async()=>{
    try{
     let unsuccessful=false
     try{
      const signal=AbortSignal.timeout(10000)
      const result=await ctx.tools.execute({agent,name:closeTool,arguments:{},callId:ToolCallId('teloa-session-close-'+randomUUID()),signal})
      unsuccessful=result.isError||signal.aborted||state.closed!==state.dispatched
     }catch{unsuccessful=true}
     if(unsuccessful)await failed(agent)
    }finally{state.closing=false}
   })
  }catch{state.closing=false;operation=failed(agent)}
  pending.add(operation)
  void operation.catch(()=>{ctx.logger.warn('普通会话浏览器收尾或提示写入失败，未确认页面已关闭。')}).finally(()=>{pending.delete(operation)})
 }
 const requestClose=(agent:Agent)=>{
  const state=states.get(agent)
  if(!state||state.closing||state.closed===state.dispatched)return
  state.requested=true;maintain(agent,state)
 }
 const offEvent=ctx.on('session/event',(session,event)=>{
  if(event.type!=='turn/end'||event.data.reason.kind!=='aborted'||event.data.reason.reason.kind!=='user')return
  const agent=ctx.agents.get(session.id)
  if(agent?.session===session)requestClose(agent)
 })
 const offStatus=ctx.on('agent/status',({agent,status})=>{
  const state=states.get(agent)
  if(status==='idle'&&state)maintain(agent,state)
 })
 // 官方 cancel 在 idle 仍返回 accepted，但不产生事件；覆盖晚到的停止及上次关闭失败后的重试。
 const controller=ctx.get('sessionController'),cancel=controller?.cancel
 const wrapped:SessionController['cancel']=function(this:SessionController,request){
  const result=cancel!.call(this,request)
  const agent=ctx.agents.get(request.sessionId)
  if(agent)requestClose(agent)
  return result
 }
 if(controller)controller.cancel=wrapped
 return {
  state(sessionId:string):{state:BrowserStopState}{
   const agent=ctx.agents.get(SessionId(sessionId))
   return {state:agent&&closeUnknown.has(agent)?'isolated':agent&&states.get(agent)?.unconfirmed?'unconfirmed':'ready'}
  },
  async dispatch(exec:ToolExecution,next:()=>Promise<ToolExecutionResult>):Promise<ToolExecutionResult>{
   const agent=exec.agent
   // 原生子 Agent 由其 owner 释放；普通 fork 有 parentSession，不能据此误判为子 Agent。
   if(!agent||agent.session.header.origin==='subagent')return next()
   exec.signal.throwIfAborted()
   if(closeUnknown.has(agent))throw Error(unknownMessage)
   // 官方 execute 的 wrapper 早于可见性解析；工具不存在时没有真正开始关闭，仍可恢复后重试。
   if(!ctx.tools.get(exec.name,agent))return next()
   let state=states.get(agent)
   if(!state){state={dispatched:0,closed:0,requested:false,closing:false,unconfirmed:false};states.set(agent,state)}
   const sequence=++state.dispatched
   let result:ToolExecutionResult
   try{result=await next()}catch(error){if(exec.name===closeTool)closeUnknown.add(agent);throw error}
   if(exec.name===closeTool){
    if(!result.isError&&!exec.signal.aborted){
     state.closed=Math.max(state.closed,sequence)
     if(state.unconfirmed&&state.closed===state.dispatched){
      state.unconfirmed=false
      await record(agent,'ready').catch(()=>{ctx.logger.warn('浏览器已关闭，但恢复提示未能写入。')})
     }
    }else closeUnknown.add(agent)
   }
   return result
  },
  async dispose(){
   disposed=true;offEvent();offStatus()
   if(controller?.cancel===wrapped)controller.cancel=cancel!
   await Promise.allSettled([...pending])
  },
 }
}
