import type {Context} from '@deepseek-ai/cordis'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {PreToolDecision,ToolExecution,ToolDefinition} from '@deepseek-ai/dsh-tools'
import {resolveSessionLineage} from './subagent-lineage.ts'
import {readSessionEvents} from './session-events.ts'
import {WorkError} from '@teloa/contract'

/** 最近输入批次采用范围交集；无新输入的续轮保留整个批次，不只取最后一条。 */
export function hardwareInputRequests(events:readonly SessionEvent[]):string[]{
 const messages:SessionEvent[]=[]
 for(let i=events.length-1;i>=0;i--){
  const event=events[i]!
  if(event.type==='turn/end'&&messages.length)break
  if(event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user')messages.push(event)
 }
 return messages.reverse().flatMap(event=>event.type==='user/message'&&'rpcId'in event.data.source&&typeof event.data.source.rpcId==='string'?[event.data.source.rpcId]:[])
}
type SourcePorts={known:(requestId:string)=>boolean;readEvents:(sessionId:string)=>Promise<readonly SessionEvent[]>;parent:(sessionId:string)=>Promise<{sessionId:string;messageId:string}|null>}
/** 派生工作沿正式原消息追溯；不能用原主聊的最新一条输入覆盖已受理来源。 */
export function createHardwareSourceReader(ports:SourcePorts):Ports['hasSource']{
 return async(sessionId,events)=>{
  if(hardwareInputRequests(events).some(ports.known))return true
  const visited=new Set<string>([sessionId])
  let current=sessionId
  for(let depth=0;depth<8;depth++){
   const parent=await ports.parent(current)
   if(!parent)return false
   if(visited.has(parent.sessionId))break
   visited.add(parent.sessionId)
   const source=(await ports.readEvents(parent.sessionId)).find(event=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.id===parent.messageId)
   if(!source||source.type!=='user/message'||source.data.source.kind!=='user')break
   if('rpcId'in source.data.source&&typeof source.data.source.rpcId==='string'&&ports.known(source.data.source.rpcId))return true
   current=parent.sessionId
  }
  throw new WorkError('teloa/forbidden','无法核对派生工作的原输入来源。')
 }
}
type Ports={hasSource:(sessionId:string,events:readonly SessionEvent[])=>Promise<boolean>}
/** 硬件文本不是全权限本人输入；未知工具必须走已有原生审批。 */
export function registerHardwareToolGuard(ctx:Context,ports:Ports):()=>void{
 const reads=new Set(['teloa_work_directory','teloa_work_status','teloa_work_facts'])
 const checked=new WeakMap<ToolExecution,ToolDefinition>()
 const removeGuard=ctx.tools.guard(exec=>{
  const definition=checked.get(exec)
  return definition&&ctx.tools.get(exec.name,exec.agent)!==definition?'硬件请求的工具定义已变化，请重新确认。':undefined
 })
 const remove=ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!exec.agent)return next()
  let source:boolean
  try{
   exec.signal.throwIfAborted()
   const {root}=resolveSessionLineage(ctx,exec.agent.session)
   source=await ports.hasSource(String(root.id),readSessionEvents(root))
  }catch{return {kind:'deny',reason:'无法核对外部请求的来源，请到 Teloa 查看原工作。'}}
  const decision=await next()
  if(!source||decision.kind!=='allow'||reads.has(exec.name))return decision
  const definition=ctx.tools.get(exec.name,exec.agent)
  if(!definition)return {kind:'deny',reason:'此工具当前不可用。'}
  checked.set(exec,definition)
  return {kind:'ask',reason:'此工作来自硬件或外部小智接入，请本人在 Teloa 确认本次工具操作。',displayReason:{en:'This request came from a hardware connection. Confirm this tool action in Teloa.','zh-CN':'此工作来自硬件或外部小智接入，请在 Teloa 确认本次工具操作。','zh-Hant':'此工作來自硬件或外部小智連接，請在 Teloa 確認這次工具操作。'}}
 },{prepend:true})
 return ()=>{remove();removeGuard()}
}
