import type {SessionBinding,SessionEventLikeEntry,SessionSnapshot} from '@deepseek-ai/dsh-api-session-controller/client'
import type {ConversationOverviewResourceGroup} from './conversation-overview-resources.js'

export type ConversationOverviewStatus='idle'|'running'|'waiting'|'stopping'|'stopped'|'failed'|'completed'|'unknown'
export type ConversationOverviewEventEntry=Extract<SessionEventLikeEntry,{type:'event'}>
export type ConversationOverviewRound={
 readonly sessionId:string
 readonly turn:number
 readonly turns:readonly number[]
 readonly startSeq:number
 readonly startedAt:number
 readonly userMessageId:string
 readonly userMessageSeq:number
 readonly endSeq?:number
 readonly endedAt?:number
 readonly status:ConversationOverviewStatus
 readonly reason?:string
}
export type ConversationOverviewStep={readonly id:string;readonly content:string;readonly status:'pending'|'running'|'completed';readonly source:'todo';readonly sessionId:string;readonly seq?:number}
export type ConversationOverviewWork={
 readonly id:string
 readonly kind:'job'|'subagent'
 readonly label:string
 readonly status:ConversationOverviewStatus
 readonly sessionId:string
 readonly parentSessionId?:string
 readonly jobId?:string
 readonly childSessionId?:string
 readonly runId?:string
 readonly detail?:string
 readonly progress?:string
 readonly startedAt?:number
 readonly finishedAt?:number
 readonly canStop:boolean
 readonly canOpenRecord:boolean
}
export type ConversationOverviewArtifact={readonly id:string;readonly sessionId:string;readonly path:string;readonly label:string;readonly kind:string;readonly status:'draft'|'final'|'unknown';readonly version?:string;readonly seq?:number;readonly isHistorical?:boolean}
export type ConversationOverviewGoal={readonly id:string;readonly objective:string;readonly phase:'active'|'paused'|'blocked'|'complete';readonly blockedReason?:string}
export type ConversationOverviewSnapshot={
 readonly sessionId:string
 readonly status:ConversationOverviewStatus
 readonly currentRound?:ConversationOverviewRound
 readonly progress:{readonly current:readonly ConversationOverviewStep[];readonly earlier:readonly ConversationOverviewStep[];readonly goal?:ConversationOverviewGoal}
 readonly running:readonly ConversationOverviewWork[]
 readonly ended:readonly ConversationOverviewWork[]
 readonly artifacts:readonly ConversationOverviewArtifact[]
 readonly usageGroups:readonly ConversationOverviewResourceGroup[]
}
export type ConversationOverviewSource<T>={getSnapshot:()=>T;subscribe:(listener:()=>void)=>()=>void}
/** JobView 的公开只读字段；不会把浏览器模型耦合到宿主 JobRegistry。 */
export type ConversationOverviewJob={readonly id:string;readonly kind:string;readonly label:string;readonly owner?:string;readonly status:string;readonly progress?:string;readonly detail?:string;readonly startedAt:number;readonly finishedAt?:number}
export type ConversationOverviewChild={readonly id:string;readonly mode:'one-shot'|'continuable'|'unknown';readonly label?:string;readonly createdAt:number;readonly running?:boolean;readonly parentAvailable?:boolean;readonly entries?:readonly SessionEventLikeEntry[];readonly lastTurnCompleted?:boolean}
/** 只接受生产者提供的稳定关系，禁止按名称、标签或启动时间猜测同一执行。 */
export type ConversationOverviewWorkLink={readonly jobId:string;readonly childSessionId:string}
export type ConversationOverviewInput={
 readonly sessionId:string
 readonly session:Pick<SessionSnapshot,'running'|'removed'|'openState'|'lastAgentError'|'promptError'|'awaitingFirstTurn'>
 readonly entries:readonly SessionEventLikeEntry[]
 readonly todos?:unknown
 readonly goal?:unknown
 readonly children?:readonly ConversationOverviewChild[]
 readonly jobs?:readonly ConversationOverviewJob[]
 readonly workLinks?:readonly ConversationOverviewWorkLink[]
 readonly pendingInteraction?:boolean
 readonly stopping?:boolean
 readonly connected?:boolean
 readonly artifacts?:readonly ConversationOverviewArtifact[]
 readonly usageGroups?:readonly ConversationOverviewResourceGroup[]
}

function durableEntries(entries:readonly SessionEventLikeEntry[]):ConversationOverviewEventEntry[]{
 const bySeq=new Map<number,ConversationOverviewEventEntry>()
 for(const entry of entries)if(entry.type==='event')bySeq.set(entry.event.seq,entry)
 return [...bySeq.values()].sort((left,right)=>left.event.seq-right.event.seq)
}
function ownEntries(entries:readonly SessionEventLikeEntry[]):ConversationOverviewEventEntry[]{
 const durable=durableEntries(entries)
 const inherited=lastEntry(durable,entry=>entry.event.type==='session/end-seed'&&entry.event.data.inherited===true)
 return inherited?durable.filter(entry=>entry.event.seq>inherited.event.seq):durable
}
function lastEntry(entries:readonly ConversationOverviewEventEntry[],matches:(entry:ConversationOverviewEventEntry)=>boolean):ConversationOverviewEventEntry|undefined{
 for(let index=entries.length-1;index>=0;index--){const entry=entries[index]!;if(matches(entry))return entry}
 return undefined
}
function record(value:unknown):Record<string,unknown>|undefined{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined}
function terminalStatus(kind:unknown):ConversationOverviewStatus{
 switch(kind){
  case 'completed':return 'completed'
  case 'aborted':case 'killed':return 'stopped'
  case 'error':case 'failed':case 'max-tokens':case 'refusal':return 'failed'
  case 'blocked':return 'waiting'
  default:return 'unknown'
 }
}

/** 当前范围由最后一条真正进入宿主的人类消息确定；排队回声和压缩副本不授予执行范围。 */
export function conversationOverviewRound(sessionId:string,entries:readonly SessionEventLikeEntry[]):ConversationOverviewRound|undefined{
 const durable=ownEntries(entries)
 let activeStart:ConversationOverviewEventEntry|undefined
 let current:ConversationOverviewRound|undefined
 let humansInTurn=0
 let entered=false
 for(const entry of durable){
  const event=entry.event
  if(event.type==='turn/start'){
   activeStart=entry;humansInTurn=0;entered=false
  }else if(event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user'){
   if(!activeStart||activeStart.event.type!=='turn/start')continue
   humansInTurn++
   entered=true
   const start=humansInTurn>1?event:activeStart.event
   current={sessionId,turn:activeStart.event.data.turn,turns:[activeStart.event.data.turn],startSeq:start.seq,startedAt:start.time,userMessageId:event.data.id,userMessageSeq:event.seq,status:'running'}
  }else if(event.type==='user/message'&&event.surfaceOp==='append'&&String(event.data.source.kind)==='goal'&&current&&activeStart?.event.type==='turn/start'){
   entered=true
   if(!current.turns.includes(activeStart.event.data.turn))current={...current,turns:[...current.turns,activeStart.event.data.turn],status:'running'}
  }else if(event.type==='turn/end'&&current&&current.turns.at(-1)===event.data.turn){
   current={...current,endSeq:event.seq,endedAt:event.time,status:terminalStatus(event.data.reason.kind),reason:event.data.reason.kind}
   activeStart=undefined
  }
 }
 // 后续续轮已开始时，旧终态只是前一个宿主 turn 的事实，不是整次用户工作的终态。
 if(activeStart&&!entered)return undefined
 if(current&&activeStart){const {endSeq:_endSeq,endedAt:_endedAt,reason:_reason,...open}=current;current=open}
 return current
}
export function conversationOverviewRoundEntries(entries:readonly SessionEventLikeEntry[],round:ConversationOverviewRound|undefined):readonly ConversationOverviewEventEntry[]{
 return round?durableEntries(entries).filter(entry=>entry.event.seq>=round.startSeq&&(round.endSeq===undefined||entry.event.seq<=round.endSeq)):[]
}
function goalValue(value:unknown):ConversationOverviewGoal|undefined{
 const goal=record(record(value)?.goal)
 if(!goal||typeof goal.id!=='string'||typeof goal.objective!=='string'||!['active','paused','blocked','complete'].includes(String(goal.phase)))return undefined
 const blocked=record(goal.blockedReason)
 return {id:goal.id,objective:goal.objective,phase:goal.phase as ConversationOverviewGoal['phase'],...(typeof blocked?.message==='string'?{blockedReason:blocked.message}:{})}
}
function todoSteps(sessionId:string,todos:unknown,seq:number|undefined):ConversationOverviewStep[]{
 if(!Array.isArray(todos))return []
 const rows=todos.map(record)
 if(rows.some(row=>!row||typeof row.content!=='string'||!row.content.trim()||!['pending','in_progress','completed'].includes(String(row.status))))return []
 return rows.map((row,index)=>({id:`${sessionId}:todo:${seq??'projection'}:${index}`,content:row!.content as string,status:row!.status==='in_progress'?'running':row!.status as 'pending'|'completed',source:'todo',sessionId,...(seq===undefined?{}:{seq})}))
}
function childStatus(child:ConversationOverviewChild):{status:ConversationOverviewStatus;detail?:string;finishedAt?:number}{
 if(child.running===true)return {status:'running'}
 const latest=lastEntry(ownEntries(child.entries??[]),entry=>entry.event.type==='turn/start'||entry.event.type==='turn/end')?.event
 if(latest?.type==='turn/end')return {status:terminalStatus(latest.data.reason.kind),detail:latest.data.reason.kind,finishedAt:latest.time}
 if(child.lastTurnCompleted===true)return {status:'completed'}
 return {status:'unknown'}
}
export function projectConversationOverviewSnapshot(input:ConversationOverviewInput):ConversationOverviewSnapshot{
 const currentRound=conversationOverviewRound(input.sessionId,input.entries)
 const goal=goalValue(input.goal)
 const todoWrite=lastEntry(ownEntries(input.entries),entry=>String(entry.event.type)==='todo/write')?.event
 const todoData=record(todoWrite?.data)
 const steps=todoSteps(input.sessionId,input.todos===undefined?todoData?.todos:input.todos,todoWrite?.seq)
 const work:ConversationOverviewWork[]=[]
 const children=new Map((input.children??[]).map(child=>[child.id,child]))
 const linkedChildren=new Set<string>()
 const seenJobs=new Set<string>()
 for(const job of input.jobs??[]){
  if(job.owner!==input.sessionId||seenJobs.has(job.id))continue
  seenJobs.add(job.id)
  const link=input.workLinks?.find(item=>item.jobId===job.id&&children.has(item.childSessionId))
  const child=link?children.get(link.childSessionId):undefined
  if(child)linkedChildren.add(child.id)
  const status=job.status==='running'||job.status==='stopping'?job.status:terminalStatus(job.status)
  work.push({id:`${input.sessionId}:job:${job.id}`,kind:child||job.kind==='subagent'?'subagent':'job',label:child?.label??job.label,status,sessionId:input.sessionId,jobId:job.id,...(child?{childSessionId:child.id,parentSessionId:input.sessionId}:{}),...(job.detail===undefined?{}:{detail:job.detail}),...(job.progress===undefined?{}:{progress:job.progress}),startedAt:job.startedAt,...(job.finishedAt===undefined?{}:{finishedAt:job.finishedAt}),canStop:status==='running',canOpenRecord:true})
 }
 for(const child of children.values()){
  if(linkedChildren.has(child.id))continue
  const state=childStatus(child)
  work.push({id:`${input.sessionId}:child:${child.id}`,kind:'subagent',label:child.label??child.id,...state,sessionId:child.id,parentSessionId:input.sessionId,childSessionId:child.id,startedAt:child.createdAt,canStop:state.status==='running'&&child.mode!=='unknown'&&child.parentAvailable!==false,canOpenRecord:true})
 }
 let status:ConversationOverviewStatus
 if(input.session.removed||input.session.openState!=='open'||input.connected===false)status='unknown'
 else if(input.stopping&&input.session.running)status='stopping'
 else if(input.pendingInteraction||goal?.phase==='blocked')status='waiting'
 else if(input.session.lastAgentError)status='failed'
 else if(input.session.promptError?.op==='stop')status='unknown'
 else if(input.session.running)status='running'
 else if(currentRound)status=currentRound.status==='running'?'unknown':currentRound.status
 else status='idle'
 const ended=(item:ConversationOverviewWork)=>['stopped','failed','completed'].includes(item.status)
 return {sessionId:input.sessionId,status,...(currentRound?{currentRound}:{}),progress:{current:steps.filter(step=>step.status!=='completed'),earlier:steps.filter(step=>step.status==='completed'),...(goal?{goal}:{})},running:work.filter(item=>!ended(item)),ended:work.filter(ended),artifacts:input.artifacts??[],usageGroups:input.usageGroups??[]}
}

export type ConversationOverviewModelPorts={
 readonly jobs?:ConversationOverviewSource<{readonly rows:Readonly<Record<string,readonly ConversationOverviewJob[]>>}>
 readonly activity?:ConversationOverviewSource<unknown>
 readonly children?:(catalog:unknown)=>readonly ConversationOverviewChild[]
 readonly context?:()=>Pick<ConversationOverviewInput,'pendingInteraction'|'stopping'|'connected'|'workLinks'|'artifacts'|'usageGroups'>
}
/** 所有状态来源由现有绑定持有；此模型只缓存投影和订阅，不启动、停止或重放执行。 */
export function createConversationOverviewModel(binding:SessionBinding,ports:ConversationOverviewModelPorts={}){
 const todos=binding.session.projections.faceOf('todos'),goal=binding.session.projections.faceOf('goal'),catalog=binding.session.projections.faceOf('subagentCatalog')
 const read=()=>projectConversationOverviewSnapshot({sessionId:binding.sessionId,session:binding.session.getSnapshot(),entries:binding.eventSource.getSnapshot().entries,todos:todos.getSnapshot(),goal:goal.getSnapshot(),children:ports.children?.(catalog.getSnapshot())??catalogChildren(catalog.getSnapshot()),jobs:ports.jobs?.getSnapshot().rows[binding.sessionId]??[],...ports.context?.()})
 let snapshot=read(),references=0,off:(()=>void)[]=[]
 const listeners=new Set<()=>void>()
 const refresh=()=>{snapshot=read();for(const listener of listeners)listener()}
 return {
  getSnapshot:()=>snapshot,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},
  attach:()=>{
   if(references++===0){
    off=[binding.session.subscribe(refresh),binding.eventSource.subscribe(refresh),todos.subscribe(refresh),goal.subscribe(refresh),catalog.subscribe(refresh)]
    if(ports.jobs)off.push(ports.jobs.subscribe(refresh))
    if(ports.activity)off.push(ports.activity.subscribe(refresh))
    refresh()
   }
   let released=false
   return()=>{if(released)return;released=true;if(--references===0){for(const dispose of off)dispose();off=[]}}
  },
 }
}
export type ConversationOverviewModel=ReturnType<typeof createConversationOverviewModel>

function catalogChildren(value:unknown):ConversationOverviewChild[]{
 if(!Array.isArray(value))return []
 return value.flatMap(item=>{
  const child=record(item)
  return child&&typeof child.id==='string'&&typeof child.createdAt==='number'&&['one-shot','continuable','unknown'].includes(String(child.mode))?[{id:child.id,createdAt:child.createdAt,mode:child.mode as ConversationOverviewChild['mode'],...(typeof child.label==='string'?{label:child.label}:{})}]:[]
 })
}
