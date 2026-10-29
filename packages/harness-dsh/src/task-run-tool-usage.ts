import type {Agent} from '@deepseek-ai/dsh-agent'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {TaskRun} from '@teloa/backend'
import type {GoalObservationContext} from '@teloa/contract'
import {observeTaskRunTimeline} from './task-run-observation.ts'
import {readSessionEvents} from './session-events.ts'
import {referenceReadTool} from './role-tool-grants.ts'
import {isDeliveryReviewInProgress} from './task-delivery-review.ts'

type Counts={requested:number;returned:number;succeeded:number;failed:number;pending:number}
type Reason='unobserved-request'|'invalid-events'|'unverified-mcp-name'|'invalid-tool-pair'|'unproven-ptc'|'child-sessions-excluded'|'unreturned-at-end'|'changed-during-read'|'outside-active-run'
export type TaskRunToolUsage={
 hostVerified:true;scope:'current-run-root-session';coverage:'complete'|'partial'|'unavailable';throughSeq:number
 counts?:Counts;byTool?:readonly ({name:string}&Counts)[];reasons:readonly Reason[]
 /** 宿主原生日志的观测范围，不是业务来源的事件时间或每条证据的采集时间。 */
 observedWindow?:{firstEventAt:string;lastEventAt:string}
}
type Binding=Pick<TaskRun,'nativeRequestId'|'allowedTools'>
type Call={seq:number;name:string;id:string;turn:number;step:number;returned?:boolean;isError?:boolean}
const contextName='teloa:run-mcp-tool-usage'
const empty=():Counts=>({requested:0,returned:0,succeeded:0,failed:0,pending:0})
// 只识别已冻结的完整公开名；不拆 server/raw 名，不用目录或参数正文扩大清单。
const externalMcpName=(name:string)=>name.startsWith('mcp__')&&name!==referenceReadTool&&!name.startsWith('mcp__playwright-mcp__')
const unavailable=(events:readonly SessionEvent[],reason:Reason):TaskRunToolUsage=>({hostVerified:true,scope:'current-run-root-session',coverage:'unavailable',throughSeq:events.length-1,reasons:[reason]})
const iso=(time:number)=>Number.isSafeInteger(time)&&time>=0&&time<=8640000000000000?new Date(time).toISOString():undefined

/** 只读完整原生日志。请求包括拒绝/取消；返回完成不等于成功，更不证明外部 HTTP 已发出。 */
export function projectTaskRunToolUsage(binding:Binding,events:readonly SessionEvent[],continuations?:ReadonlySet<string>,goal?:GoalObservationContext):{authorized:boolean;usage:TaskRunToolUsage}{
 const owned:SessionEvent[]=[]
 let timeline:ReturnType<typeof observeTaskRunTimeline>
 try{timeline=observeTaskRunTimeline(events,binding.nativeRequestId,continuations,event=>owned.push(event),goal)}
 catch{return {authorized:false,usage:unavailable(events,'invalid-events')}}
 if(timeline.observation.state==='unobserved')return {authorized:false,usage:unavailable(events,'unobserved-request')}
 const names=new Set(binding.allowedTools.filter(externalMcpName)),reasons=new Set<Reason>(),calls=new Map<number,Call>()
 const allCalls=new Map<number,Extract<SessionEvent,{type:'tool/call'}>>(),openParents=new Map<number,Extract<SessionEvent,{type:'tool/call'}>>()
 const nested=new Map<string,Call>(),ownedSeqs=new Set(owned.map(event=>event.seq))
 const classify=(name:string)=>{if(names.has(name))return true;if(externalMcpName(name))reasons.add('unverified-mcp-name');return false}
 const settle=(call:Call,isError:unknown)=>{if(call.returned||typeof isError!=='boolean'){reasons.add('invalid-tool-pair');return}call.returned=true;call.isError=isError}
 for(const event of owned){
  if(event.type==='tool/call'){
   allCalls.set(event.seq,event)
   if(event.data.name==='run_code')openParents.set(event.seq,event)
   if(classify(event.data.name))calls.set(event.seq,{seq:event.seq,name:event.data.name,id:event.data.callId,turn:event.data.turn,step:event.data.step})
  }else if(event.type==='tool/result'){
   const source=event.sourceEventSeqs,call=source?.length===1?allCalls.get(source[0]!):undefined
   if(!call||call.data.callId!==event.data.message.toolCallId||call.data.turn!==event.data.turn||call.data.step!==event.data.step||call.seq>=event.seq){reasons.add('invalid-tool-pair');continue}
   openParents.delete(call.seq)
   const counted=calls.get(call.seq)
   if(counted)settle(counted,event.data.message.isError)
  }else if(event.type==='tool/ptc-dispatch-start'||event.type==='tool/ptc-dispatch'){
   if(!classify(event.data.name))continue
   const parents=[...openParents.values()].filter(parent=>parent.data.callId===event.data.parentCallId&&parent.data.callId===event.data.rootCallId)
   const parent=parents[0]
   if(parents.length!==1||!parent||parent.seq>=event.seq){reasons.add('unproven-ptc');continue}
   const key=parent.seq+'\0'+event.data.subCallId
   if(event.type==='tool/ptc-dispatch-start'){
    if(nested.has(key)){reasons.add('unproven-ptc');continue}
    nested.set(key,{seq:event.seq,name:event.data.name,id:event.data.subCallId,turn:parent.data.turn,step:parent.data.step})
   }else{
    const started=nested.get(key),start=started?events[started.seq]:undefined
    if(!started||start?.type!=='tool/ptc-dispatch-start'||started.name!==event.data.name||start.seq>=event.seq||JSON.stringify(start.data.arguments)!==JSON.stringify(event.data.arguments)){reasons.add('unproven-ptc');continue}
    settle(started,event.data.isError)
   }
  }else if(event.type.startsWith('subagent/')||event.type.startsWith('team/'))reasons.add('child-sessions-excluded')
 }
 const rows=[...calls.values(),...nested.values()],byTool=new Map<string,Counts>(),counts=empty()
 for(const call of rows){
  const row=byTool.get(call.name)??empty();byTool.set(call.name,row)
  for(const count of [counts,row]){count.requested++;if(call.returned){count.returned++;if(call.isError)count.failed++;else count.succeeded++}else count.pending++}
 }
 if(timeline.observation.state==='ended'&&counts.pending)reasons.add('unreturned-at-end')
 // end 本身不进入 visitOwned；只使用 observation 已核实归属的精确终结事件。
 const end=timeline.observation.state==='ended'?events[timeline.observation.endSeq]:undefined
 const window=end?.type==='turn/end'?[...owned,end]:owned
 const first=window[0],last=window.at(-1),firstAt=first?iso(first.time):undefined,lastAt=last?iso(last.time):undefined
 const monotonic=window.every((event,index)=>iso(event.time)!==undefined&&(index===0||event.time>=window[index-1]!.time))
 // 未归属的其他轮次不参与数量或时间；完整日志的序号已由 timeline 核验。
 const throughSeq=last?.seq??Math.max(...ownedSeqs)
 return {authorized:timeline.authorized,usage:{hostVerified:true,scope:'current-run-root-session',coverage:reasons.size?'partial':'complete',throughSeq,counts,byTool:[...byTool].sort(([a],[b])=>a.localeCompare(b)).map(([name,count])=>({name,...count})),reasons:[...reasons],...(monotonic&&firstAt&&lastAt?{observedWindow:{firstEventAt:firstAt,lastEventAt:lastAt}}:{})}}
}

export type TaskRunToolUsagePorts={
 continuations?:(events:readonly SessionEvent[])=>Promise<ReadonlySet<string>|undefined>
 goal?:(events:readonly SessionEvent[])=>Promise<GoalObservationContext|undefined>
}
/** 同 Run 的 pre-step 只更新快照；持久 runtime-context 由官方 provider 投影，不伪造事件或新增模型步。 */
export function leaseTaskRunToolUsage(agent:Agent,run:Pick<TaskRun,'id'|'sessionId'|'nativeRequestId'|'allowedTools'>,ports:TaskRunToolUsagePorts={}):()=>void{
 const session=agent.session
 let active=true,snapshot:TaskRunToolUsage|undefined
 const render=()=>snapshot?'Host-verified MCP tool usage for this Run (counts are requests/returns, not external HTTP calls; returned includes errors). succeeded means native isError:false returns only; it does not prove business-payload success, complete evidence, non-empty results or issue resolution. Payload timeouts, invalid requests, empty/truncated results and other evidence gaps must still be reported from their actual receipts; do not call all evidence collection successful from these counts. failed means native isError:true returns. Counts cover only the fixed root session and proven native PTC calls. Partial coverage is not an all-Run or child-Agent total. Use the latest snapshot when reporting calls made in THIS Run; it is not evidence about referenced historical Runs and must not replace their verified figures. The observedWindow contains host log event times, not per-evidence collection times; never estimate individual collection times. Without a verified exact evidence time, use this Run observation range with that label or omit the time; do not apply this range to historical evidence. This snapshot grants no permissions and does not enforce a natural-language budget.\n'+JSON.stringify(snapshot):''
 const removeContext=agent.ctx.systemPrompt.context({name:contextName,order:130,required:true,interpolate:false,text:context=>active&&context.agent===agent&&agent.session===session?render():''})
 const removeStep=agent.ctx.on('agent/pre-step',async(payload,next)=>{
  const decision=await next()
  if(decision.kind==='reject'||payload.agent!==agent||!active)return decision
  // 复核只调用内部回执工具，不产生新的 MCP 请求。保留进入复核前的同一计数快照，
  // 避免官方 runtime-context 更新夹入 R1 尾段；R2 仍严格拒绝任何未知历史节点。
  if(isDeliveryReviewInProgress(agent))return decision
  snapshot=undefined
  if(agent.session!==session||session.id!==run.sessionId)return decision
  const events=readSessionEvents(session)
  try{
   const continuations=await ports.continuations?.(events),goal=await ports.goal?.(events)
   payload.signal.throwIfAborted()
   if(!active||agent.session!==session||readSessionEvents(session).length!==events.length){snapshot=unavailable(events,'changed-during-read');return decision}
   const projected=projectTaskRunToolUsage(run,events,continuations,goal)
   snapshot=projected.authorized?projected.usage:unavailable(events,projected.usage.coverage==='unavailable'?projected.usage.reasons[0]??'outside-active-run':'outside-active-run')
  }catch(error){if(payload.signal.aborted)throw error;snapshot=unavailable(events,'invalid-events')}
  return decision
 })
 return ()=>{active=false;snapshot=undefined;removeStep();removeContext()}
}
