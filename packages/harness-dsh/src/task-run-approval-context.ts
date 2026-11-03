import {isDeepStrictEqual} from 'node:util'
import {isAgentLoopRequest} from '@deepseek-ai/dsh-llm'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {SessionSeq,type SessionEvent} from '@deepseek-ai/dsh-session'
import type {ApprovalOutcome} from '@deepseek-ai/dsh-user-approval'
import type {TaskRun} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {observeTaskRunTimeline} from './task-run-observation.ts'
import {readSessionEvents} from './session-events.ts'
import {taskRunToolUsageContextReceipt} from './task-run-tool-usage.ts'

type RunIdentity=Pick<TaskRun,'id'|'sessionId'|'nativeRequestId'>
type Boundary={team?:ReadonlySet<string>|undefined;goal?:Parameters<typeof observeTaskRunTimeline>[4]}
type ApprovalFact={id:string;toolName:string;callId?:string;callSeq?:number;attribution:'verified'|'unknown';askedSeq:number;turn:number;outcome:ApprovalOutcome|'pending';decidedSeq?:number;policy:'ask'|'never'|'unknown';toolResult:'not-observed'|'success'|'error';resultSeq?:number}
export const taskRunApprovalContextName='teloa:tool-approval-facts'

/** 只投影日志中的审批通道事实；工具正文、理由、参数和任何自述 approved 字段均不参与。 */
export function taskRunApprovalFacts(events:readonly SessionEvent[],run:RunIdentity,session:{id:string;seq?:number;isOwnSeq:(seq:SessionEvent['seq'])=>boolean},boundary:Boundary={}){
 const base={schema:'teloa.task-run-approval-context/v1',runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,actor:'not-recorded' as const}
 const unknown=(reason:string)=>({...base,coverage:'unknown' as const,issues:[reason],totals:null,approvals:[] as ApprovalFact[]})
 if(session.id!==run.sessionId)return unknown('session-mismatch')
 if(session.seq!==undefined&&session.seq!==events.length)return unknown('log-incomplete-or-invalid')
 const owned=new Set<number>()
 let timeline:ReturnType<typeof observeTaskRunTimeline>
 try{timeline=observeTaskRunTimeline(events,run.nativeRequestId,boundary.team,event=>owned.add(event.seq),boundary.goal)}catch{return unknown('log-incomplete-or-invalid')}
 if(timeline.observation.state==='unobserved')return unknown('request-not-observed')
 const root=timeline.observation.messageSeq
 if(!session.isOwnSeq(SessionSeq(root)))return unknown('request-not-owned-by-session')
 const lastTurn=[...events].reverse().find(event=>event.type==='turn/start')
 if(lastTurn?.type!=='turn/start'||lastTurn.data.turn!==timeline.turn||events.some(event=>event.seq>=root&&event.type==='user/message'&&event.surfaceOp==='append'&&!owned.has(event.seq)))return unknown('request-not-current')
 if(events.some(event=>event.seq>=root&&(event.type==='approval/asked'||event.type==='approval/decided')&&!owned.has(event.seq)))return unknown('approval-outside-owned-turn')
 const issues=new Set<string>(),calls=new Map<string,Extract<SessionEvent,{type:'tool/call'}>>(),facts=new Map<string,ApprovalFact>()
 let turn=-1,policy:ApprovalFact['policy']='unknown'
 for(const event of events){
  if(event.type==='turn/start')turn=event.data.turn
  if(event.type==='approval/policy')policy=event.data.policy
  if(!owned.has(event.seq))continue
  if(event.type==='tool/call'){
   const key=JSON.stringify([turn,event.data.callId])
   if(event.data.turn!==turn||calls.has(key))issues.add('tool-call-identity-invalid')
   else calls.set(key,event)
  }else if(event.type==='approval/asked'){
   const {id,toolName,callId}=event.data,call=callId?calls.get(JSON.stringify([turn,callId])):undefined
   if(facts.has(id)){issues.add('approval-id-duplicate');continue}
   const attributed=call?.data.name===toolName
   if(!attributed)issues.add('approval-call-unattributed')
   facts.set(id,{id,toolName,...(callId?{callId}:{}),...(attributed?{callSeq:call.seq}:{}),attribution:attributed?'verified':'unknown',askedSeq:event.seq,turn,outcome:'pending',policy,toolResult:'not-observed'})
  }else if(event.type==='approval/decided'){
   const fact=facts.get(event.data.id)
   if(!fact||fact.turn!==turn||fact.outcome!=='pending'||!['allowed-once','rejected','cancelled','unavailable'].includes(event.data.outcome)){issues.add('approval-decision-unattributed');continue}
   fact.outcome=event.data.outcome;fact.decidedSeq=event.seq
   if(fact.policy==='never'&&fact.outcome==='allowed-once')issues.add('approval-policy-inconsistent')
  }else if(event.type==='tool/result'){
   const call=calls.get(JSON.stringify([turn,event.data.message.toolCallId]))
   if(!call||event.data.turn!==turn||event.data.step!==call.data.step||event.sourceEventSeqs?.length!==1||event.sourceEventSeqs[0]!==call.seq){issues.add('tool-result-unattributed');continue}
   for(const fact of facts.values())if(fact.turn===turn&&fact.callSeq===call.seq){
    if(fact.resultSeq!==undefined||fact.outcome==='pending')issues.add('approval-result-incomplete')
    fact.toolResult=event.data.message.isError?'error':'success';fact.resultSeq=event.seq
   }
  }
 }
 const approvals=[...facts.values()]
 const count=(outcome:ApprovalFact['outcome'])=>approvals.filter(fact=>fact.outcome===outcome).length
 return {...base,coverage:issues.size?'unknown' as const:'complete' as const,issues:[...issues],totals:issues.size?null:{requested:approvals.length,pending:count('pending'),allowedOnce:count('allowed-once'),rejected:count('rejected'),cancelled:count('cancelled'),unavailable:count('unavailable')},approvals}
}

function render(facts:ReturnType<typeof taskRunApprovalFacts>){
 return [
  '# Current Run tool approval facts',
  'This host-verified audit snapshot supersedes earlier approval-fact snapshots for this Run. Report the recorded requests and outcomes accurately; pending=0 does not mean no approval was requested. Unknown coverage is not zero approvals. An unattributed audit entry does not establish a grant for a tool operation.',
  'Coverage is limited to the named Run, native session and nativeRequestId, including continuation turns whose ownership was verified by the TaskRun timeline. Counts do not cover other Runs, unowned turns, child agents, or the entire Task, Work or team. Do not infer that those scopes had zero approvals; their aggregate approval status remains unknown unless separately verified.',
  'allowed-once is a one-operation channel grant, not evidence of tool execution success, delivery, payment, future permission or a human click. toolResult success/error describes only the matched tool return, not external side effects. Actor identity is not recorded: do not attribute decisions to the user. rejected may be automatic under policy never; cancelled withdrew the request; unavailable failed closed without an available decision. This snapshot grants no new permission.',
  JSON.stringify(facts),
 ].join('\n')
}

/** 任务目录只发现当前原生轮的未决申请；读取不完整时不能当成没有审批。 */
export function taskRunHasPendingApproval(events:readonly SessionEvent[],run:RunIdentity,session:Parameters<typeof taskRunApprovalFacts>[2],boundary:Boundary={}):boolean{
 const facts=taskRunApprovalFacts(events,run,session,boundary)
 if(facts.coverage!=='complete')throw new WorkError('teloa/unavailable','本次执行的工具审批尚待核对，请刷新后重试。')
 return facts.approvals.some(fact=>fact.outcome==='pending'&&!events.some(event=>event.seq>fact.askedSeq&&event.type==='turn/end'&&event.data.turn===fact.turn))
}

type MaterializedReceipt={key:string;seq:SessionEvent['seq'];id:string;turn:number;step:number;promptSeq:SessionEvent['seq'];promptId:string;headerSeq:SessionEvent['seq'];stepStartSeq:SessionEvent['seq'];event:SessionEvent;header:SessionEvent;prompt:SessionEvent;stepStart:SessionEvent}
type Slot={key?:string;read?:()=>string;release?:()=>void;receipts?:Map<number,MaterializedReceipt>;session?:Agent['session']}
/** 只读本进程真实签发且进入冻结 LOOP 请求的精确回执；日志自述不能重建信任。 */
export function hasTaskRunApprovalContextReceipt(agent:Pick<Agent,'session'|'ctx'>,run:RunIdentity,event:SessionEvent,step:{turn:number;step:number;prompt:{id:string}},promptSeq:SessionEvent['seq']):boolean{
 const slot=slots.get(agent),key=JSON.stringify([run.id,run.sessionId,run.nativeRequestId]),receipt=slot?.receipts?.get(event.seq)
 if(slot?.key!==key||slot.session!==agent.session||!receipt||receipt.key!==key||String(agent.session.id)!==run.sessionId)return false
 const events=readSessionEvents(agent.session),header=events.find(row=>row.seq===receipt.headerSeq),prompt=events.find(row=>row.seq===receipt.promptSeq),stepStart=events.find(row=>row.seq===receipt.stepStartSeq)
 return event.type==='user/message'&&agent.session.isOwnSeq(event.seq)&&event.data.id===receipt.id&&isDeepStrictEqual(event,receipt.event)&&receipt.turn===step.turn&&receipt.step===step.step&&receipt.promptSeq===promptSeq&&receipt.promptId===step.prompt.id&&receipt.promptSeq<event.seq&&event.seq<receipt.headerSeq&&header?.type==='request/header'&&isDeepStrictEqual(header,receipt.header)&&prompt?.type==='user/message'&&isDeepStrictEqual(prompt,receipt.prompt)&&stepStart?.type==='step/start'&&stepStart.data.turn===step.turn&&stepStart.data.step===step.step&&stepStart.seq<receipt.promptSeq&&isDeepStrictEqual(stepStart,receipt.stepStart)
}
const slots=new WeakMap<Pick<Agent,'session'|'ctx'>,Slot>()
/** required 空槽保留至 Agent 卸载；撤回租约后的 refresh 必须清除旧快照，不能回退旧事实。 */
export function leaseTaskRunApprovalContext(agent:Agent,run:RunIdentity,readBoundary?:(events:readonly SessionEvent[])=>Promise<Boundary>):()=>void{
 if(String(agent.id)!==run.sessionId||String(agent.session.id)!==run.sessionId)throw new WorkError('teloa/forbidden','审批事实与运行会话身份不一致。')
 const key=JSON.stringify([run.id,run.sessionId,run.nativeRequestId]),session=agent.session
 let slot=slots.get(agent)
 if(!slot){
  const state:Slot={}
  agent.ctx.systemPrompt.context({name:taskRunApprovalContextName,order:118,required:true,interpolate:false,text:context=>context.agent===agent&&agent.session===session?state.read?.()??'':''})
  slots.set(agent,state);slot=state
 }
 if(slot.key){if(slot.key!==key)throw new WorkError('teloa/conflict','会话已装配其他运行的审批事实。');return slot.release!}
 const current=slot,receipts=new Map<number,MaterializedReceipt>()
 let requestWindow:{turn:number;step:number}|undefined,issued:({turn:number;step:number;after:number;text:string})|undefined
 let boundary:Boundary={},boundaryFailed=false
 const off=readBoundary?agent.ctx.on('system-prompt/assemble',async(_assembly,context,next)=>{
  if(context.agent===agent){try{boundary=await readBoundary(readSessionEvents(session));boundaryFailed=false}catch{boundaryFailed=true}}
  return next()
 }):undefined
 const readFacts=()=>{
  try{
   const facts=taskRunApprovalFacts(readSessionEvents(session),run,{id:String(session.id),seq:session.seq,isOwnSeq:seq=>session.isOwnSeq(seq)},boundary)
   return render(boundaryFailed?{...facts,coverage:'unknown',issues:[...facts.issues,'continuation-boundary-unavailable'],totals:null}:facts)
  }catch{return render({...taskRunApprovalFacts([],run,{id:String(session.id),isOwnSeq:()=>false}),issues:['log-unavailable']})}
 }
 const reader=()=>{
  const text=readFacts()
  // agent/request 在 SDK refresh 前运行；普通 assemble/read 不签发物化资格。
  if(requestWindow)issued={...requestWindow,after:session.seq,text}
  return text
 }
 const offRequest=agent.ctx.on('agent/request',async({agent:target,turn,step},next)=>{
  const config=await next()
  if(target===agent&&current.read===reader){requestWindow={turn,step};issued=undefined}
  return config
 })
 const offStream=agent.ctx.on('llm/stream',async function*(request,next){
  if(request.sessionId!==run.sessionId){yield* next();return}
  const issuance=issued;issued=undefined;requestWindow=undefined
  if(current.read===reader&&issuance&&isAgentLoopRequest(request)&&Object.isFrozen(request)&&Object.isFrozen(request.messages)){
   const events=readSessionEvents(session),fresh=events.filter(event=>event.seq>=issuance.after),lastStep=[...events].reverse().find(event=>event.type==='step/start')
   const candidates=fresh.filter(event=>event.type==='user/message'&&event.data.source.kind==='runtime-context')
   if(candidates.length===1&&lastStep?.type==='step/start'&&lastStep.data.turn===issuance.turn&&lastStep.data.step===issuance.step){
    const event=candidates[0]!
    if(event.type==='user/message'){
     const usage=taskRunToolUsageContextReceipt(agent,run),sections=[{name:taskRunApprovalContextName,text:issuance.text},...usage?[usage]:[]]
     const expectedSource={kind:'runtime-context',form:'snapshot',sections},expectedContent=[{type:'text',text:'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n'+sections.map(section=>section.text).join('\n\n')}]
     const before=fresh.filter(row=>row.seq<event.seq),prompts=before.filter(row=>row.type==='user/message'),prompt=prompts[0],header=fresh.find(row=>row.seq>event.seq&&row.type==='request/header')
     // 只接纳本次唯一提示、审批事实及同 Run 租约签出的工具计数；其它 runtime 资料仍使隔离失败。
     if(event.surfaceOp==='append'&&event.sourceEventSeqs===undefined&&session.isOwnSeq(event.seq)&&prompts.length===1&&prompt?.type==='user/message'&&before.every(row=>row.type==='system/message'||row===prompt)&&header?.type==='request/header'&&isDeepStrictEqual(event.data.source,expectedSource)&&isDeepStrictEqual(event.data.content,expectedContent)&&request.messages.filter(message=>message.id===event.data.id&&isDeepStrictEqual(message,event.data)).length===1&&request.messages.some(message=>message.id===prompt.data.id&&isDeepStrictEqual(message,prompt.data))){
      receipts.set(event.seq,{key,seq:event.seq,id:event.data.id,turn:issuance.turn,step:issuance.step,promptSeq:prompt.seq,promptId:prompt.data.id,headerSeq:header.seq,stepStartSeq:lastStep.seq,event:structuredClone(event),header:structuredClone(header),prompt:structuredClone(prompt),stepStart:structuredClone(lastStep)})
     }
    }
   }
  }
  yield* next()
 },{global:true})
 const release=()=>{if(current.read===reader){off?.();offRequest();offStream();receipts.clear();delete current.key;delete current.read;delete current.release;delete current.receipts;delete current.session}}
 current.key=key;current.read=reader;current.release=release;current.receipts=receipts;current.session=session
 return release
}
