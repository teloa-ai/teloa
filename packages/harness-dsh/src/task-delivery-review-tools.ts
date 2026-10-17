import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subagent'
import type {TaskRunRuntimeLink} from '@teloa/backend'
import type {ReviewSourceInput} from './task-delivery-review-protocol.ts'

/** 宿主按原受理根、运行关联及真实后台读口提供；当前 Agent 收尾的 running 不属于后台待办。 */
export type DeliveryReviewExecutionSnapshot=Readonly<{
 runId:string;sessionId:string;requestId:string;allowedTools:readonly string[]
 continuationMessageIds:ReadonlySet<string>
 runtimeLinks:readonly TaskRunRuntimeLink[]
 jobs:readonly Readonly<{id:string;owner:string|undefined;status:string}>[]
 pendingJobCompletion:boolean;pendingInput:boolean
 children:'none'|'outstanding';flow:'none'|'outstanding'
}>
type FrozenExecution=Omit<DeliveryReviewExecutionSnapshot,'continuationMessageIds'>&{continuationMessageIds:readonly string[]}
type ToolReceipt=Readonly<{callId:string;name:string;turn:number;step:number;assistantSeq:number;callSeq:number;resultSeq:number;argumentsSha256:string;isError:boolean;text:string;sha256:string}>
type ContinuationReceipt=Readonly<{messageId:string;seq:number;text:string;sha256:string}>
export type ReviewToolEvidence=Readonly<{schema:'teloa.delivery-review-tools/v1';execution:FrozenExecution;turn:number;draftMessageId:string;draftSeq:number;receipts:readonly ToolReceipt[];continuations:readonly ContinuationReceipt[];sha256:string}>
type AssistantEvent=Extract<SessionEvent,{type:'assistant/message'}>
type Collection={state:'plain'}|{state:'pending';reason:string}|{state:'blocked';reason:string}|{state:'ready';draft:AssistantEvent;evidence:ReviewToolEvidence;sources:readonly ReviewSourceInput[]}
const sha=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex')
const blocked=(reason:string):Collection=>({state:'blocked',reason})
const pending=(reason:string):Collection=>({state:'pending',reason})
const terminal=(status:string)=>['completed','failed','killed'].includes(status)
const contextKinds=new Set(['agent-instructions','runtime-context','time-context'])

/** 所有工具事实只来自当前受理根内成对的原生 call/result；不读推理、子进程日志或模型声称。 */
export function collectReviewToolEvidence(events:readonly SessionEvent[],binding:Readonly<{runId:string;sessionId:string;requestId:string;turn:number}>,snapshot:DeliveryReviewExecutionSnapshot):Collection{
 if(snapshot.runId!==binding.runId||snapshot.sessionId!==binding.sessionId||snapshot.requestId!==binding.requestId)return blocked('execution-binding')
 const roots=events.filter(event=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user'&&Reflect.get(event.data.source,'rpcId')===binding.requestId)
 if(roots.length!==1)return blocked('request-root')
 const first=roots[0]!,start=events.findIndex(event=>event===first),window=events.slice(start)
 let currentTurn:number|undefined
 for(const event of events.slice(0,start))if(event.type==='turn/start')currentTurn=event.data.turn
 const ownedTurns=new Set<number>(),calls=new Map<string,Extract<SessionEvent,{type:'tool/call'}>>(),results=new Map<string,Extract<SessionEvent,{type:'tool/result'}>>()
 const assistants:AssistantEvent[]=[],continuations:ContinuationReceipt[]=[],inputIds=new Set<string>()
 const registeredJobs=new Map<string,Extract<SessionEvent,{type:'job/registered'}>>(),settledJobs=new Map<string,Extract<SessionEvent,{type:'job/settled'}>>()
 const externalCatalog:Extract<SessionEvent,{type:'subagent/catalog'}>[]=[]
 for(const event of window){
  if(event.type==='turn/start'){currentTurn=event.data.turn;continue}
  if(event.type==='user/message'){
   const source=event.data.source
   if(event===first||snapshot.continuationMessageIds.has(event.data.id)){
    if(event.surfaceOp!=='append'||currentTurn===undefined||inputIds.has(event.data.id)||event.data.content.some(part=>part.type!=='text'))return blocked('input-shape')
    inputIds.add(event.data.id)
    if(event!==first){const text=event.data.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n');continuations.push({messageId:event.data.id,seq:event.seq,text,sha256:sha(text)})}
    ownedTurns.add(currentTurn)
   }else if(!contextKinds.has(source.kind))return blocked('foreign-input')
  }
  if(event.type==='assistant/message'){
   if(!ownedTurns.has(event.data.turn)||event.surfaceOp!=='append'||event.data.interrupted===true)return blocked('foreign-assistant')
   assistants.push(event)
  }
  if(event.type==='tool/call'){
   if(!ownedTurns.has(event.data.turn)||calls.has(event.data.callId)||!snapshot.allowedTools.includes(event.data.name))return blocked('tool-identity')
   calls.set(event.data.callId,event)
  }
  if(event.type==='tool/result'){
   if(!ownedTurns.has(event.data.turn)||results.has(event.data.message.toolCallId))return blocked('tool-result-identity')
   results.set(event.data.message.toolCallId,event)
  }
  if(event.type==='job/registered'){
   if(event.data.owner!==binding.sessionId||registeredJobs.has(event.data.jobId))return blocked('job-event-identity')
   registeredJobs.set(event.data.jobId,event)
  }else if(event.type==='job/settled'){
   if(event.data.owner!==binding.sessionId||settledJobs.has(event.data.jobId))return blocked('job-event-identity')
   settledJobs.set(event.data.jobId,event)
  }else if(event.type==='subagent/catalog'){
   if(event.data.version!==2||event.data.mode!=='external'||externalCatalog.some(row=>row.data.childId===event.data.childId))return blocked('unproven-child-event')
   externalCatalog.push(event)
  // 仅下方与真实外部回执一致的官方目录事实可读；未知协作事件仍拒绝。
  }else if(event.type.startsWith('team/')||event.type.startsWith('subagent/')||event.type.startsWith('job/'))return blocked('unproven-child-event')
 }
 if(currentTurn!==binding.turn||!ownedTurns.has(binding.turn))return blocked('foreign-turn')
 if(!calls.size&&!results.size){
  if(snapshot.runtimeLinks.some(row=>!(row.kind==='job'&&row.payload.record==='owner'))||snapshot.jobs.length||snapshot.pendingJobCompletion||snapshot.pendingInput||snapshot.children!=='none'||snapshot.flow!=='none')return pending('background')
  return {state:'plain'}
 }
 const linkIds=new Set<string>(),jobLinks=new Map<string,Extract<TaskRunRuntimeLink,{kind:'job'}>>()
 for(const row of snapshot.runtimeLinks){
  if(!['job','team','browser','external'].includes(row.kind)||row.runId!==binding.runId||row.sessionId!==binding.sessionId||row.payload.requestId!==binding.requestId||linkIds.has(row.kind+':'+row.nativeId))return blocked('runtime-link-identity')
  linkIds.add(row.kind+':'+row.nativeId)
  if(row.kind==='job'){
   if(row.payload.record==='owner'){
    if(row.nativeId!=='owner:'+row.payload.runtimeId+':'+binding.sessionId)return blocked('job-owner')
   }else{
    if(row.nativeId!==row.payload.runtimeId+':'+row.payload.jobId||jobLinks.has(row.payload.jobId))return blocked('job-link')
    jobLinks.set(row.payload.jobId,row)
    if(!terminal(row.payload.status))return pending('job')
   }
  }else if(row.kind==='external'){
   if(row.nativeId!==row.payload.reservationId||row.payload.status==='unknown')return blocked('external-unknown')
   if(!['completed','failed','aborted'].includes(row.payload.status))return pending('external')
   if(row.payload.status==='completed'&&!row.payload.activationId)return blocked('external-activation')
  }else if(row.kind==='browser'&&row.payload.status!=='closed')return pending('browser')
 }
 const jobIds=new Set<string>()
 for(const job of snapshot.jobs){
  const row=jobLinks.get(job.id)
  if(job.owner!==binding.sessionId||jobIds.has(job.id)||!row||row.payload.record!=='job'||row.payload.status!==job.status)return blocked('job-identity')
  jobIds.add(job.id)
  if(!terminal(job.status))return pending('job')
 }
 if([...jobLinks.keys()].some(id=>!jobIds.has(id)))return blocked('job-missing')
 if(snapshot.pendingJobCompletion||snapshot.pendingInput||snapshot.children==='outstanding'||snapshot.flow==='outstanding')return pending('background')
 if(snapshot.children!=='none'||snapshot.flow!=='none')return blocked('background-unknown')
 const receipts:ToolReceipt[]=[]
 for(const [id,call] of calls){
  const matching=assistants.filter(event=>event.data.turn===call.data.turn&&event.data.step===call.data.step&&event.data.message.content.some(block=>block.type==='tool-call'&&block.id===id))
  const assistant=matching[0],result=results.get(id)
  if(matching.length!==1||!assistant||!result)return blocked('tool-pair')
  const blocks=assistant.data.message.content.filter(block=>block.type==='tool-call'&&block.id===id),block=blocks[0]
  if(blocks.length!==1||block?.type!=='tool-call'||block.name!==call.data.name||!isDeepStrictEqual(block.arguments,call.data.arguments)||assistant.seq>=call.seq||call.seq>=result.seq||result.data.turn!==call.data.turn||result.data.step!==call.data.step||!isDeepStrictEqual(result.sourceEventSeqs,[call.seq])||typeof result.data.message.isError!=='boolean'||result.data.message.content.some(part=>part.type!=='text'))return blocked('tool-pair')
  const provider=call.data.name==='subagent_codex'?'codex':call.data.name==='subagent_claude_code'?'claude-code':undefined
  if(provider&&!result.data.message.isError){
   const matches=snapshot.runtimeLinks.filter(row=>row.kind==='external'&&row.payload.provider===provider&&row.payload.reservationId==='external:'+sha(JSON.stringify([row.payload.runtimeId,binding.sessionId,id,provider])))
   const row=matches[0]
   if(matches.length!==1||row?.kind!=='external'||row.payload.status!=='completed'||externalCatalog.filter(event=>event.data.childId===row.payload.activationId&&call.seq<event.seq&&event.seq<result.seq).length!==1)return blocked('external-call')
  }
  const text=result.data.message.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n')
  receipts.push({callId:id,name:call.data.name,turn:call.data.turn,step:call.data.step,assistantSeq:assistant.seq,callSeq:call.seq,resultSeq:result.seq,argumentsSha256:sha(call.data.arguments),isError:result.data.message.isError,text,sha256:sha(text)})
 }
 if(results.size!==calls.size||assistants.some(event=>event.data.message.content.some(block=>block.type==='tool-call'&&!calls.has(block.id))))return blocked('tool-unmatched')
 if(registeredJobs.size!==jobIds.size||settledJobs.size!==jobIds.size)return blocked('job-event-missing')
 for(const job of snapshot.jobs){
  const registered=registeredJobs.get(job.id),settled=settledJobs.get(job.id)
  if(!registered||!settled||registered.seq>=settled.seq||settled.data.status!==job.status||registered.data.startedAt!==settled.data.startedAt||registered.data.kind!==settled.data.kind||registered.data.label!==settled.data.label||!isDeepStrictEqual(registered.data.toolCall,settled.data.toolCall)||settled.data.finishedAt<registered.data.startedAt)return blocked('job-event-pair')
  const cause=registered.data.toolCall
  if(!receipts.some(receipt=>receipt.callSeq<registered.seq&&registered.seq<receipt.resultSeq&&(!cause||cause.callId===receipt.callId&&cause.rootCallId===receipt.callId)))return blocked('job-tool-origin')
 }
 for(const row of snapshot.runtimeLinks)if(row.kind==='external'&&!receipts.some(receipt=>row.payload.provider===(receipt.name==='subagent_codex'?'codex':receipt.name==='subagent_claude_code'?'claude-code':undefined)&&row.payload.reservationId==='external:'+sha(JSON.stringify([row.payload.runtimeId,binding.sessionId,receipt.callId,row.payload.provider]))))return blocked('external-unmatched')
 for(const event of externalCatalog)if(!snapshot.runtimeLinks.some(row=>row.kind==='external'&&row.payload.activationId===event.data.childId&&receipts.some(receipt=>receipt.callSeq<event.seq&&event.seq<receipt.resultSeq&&row.payload.reservationId==='external:'+sha(JSON.stringify([row.payload.runtimeId,binding.sessionId,receipt.callId,row.payload.provider])))))return blocked('external-catalog')
 const draft=assistants.at(-1)
 if(!draft||draft.data.turn!==binding.turn||receipts.some(row=>row.resultSeq>=draft.seq))return blocked('tool-final-draft')
 const execution:FrozenExecution={...snapshot,allowedTools:[...snapshot.allowedTools],continuationMessageIds:continuations.map(row=>row.messageId),runtimeLinks:structuredClone(snapshot.runtimeLinks),jobs:structuredClone(snapshot.jobs)}
 const body={schema:'teloa.delivery-review-tools/v1' as const,execution,turn:binding.turn,draftMessageId:draft.data.message.id,draftSeq:draft.seq,receipts,continuations}
 const evidence:ReviewToolEvidence={...body,sha256:sha(JSON.stringify(body))}
 return {state:'ready',draft,evidence,sources:reviewToolSources(evidence)}
}

/** 普通回执和明确错误原样封存；错误不是成功动作，工具内容也不是可执行指令。 */
export function reviewToolSources(evidence:ReviewToolEvidence):readonly ReviewSourceInput[]{
 return [...evidence.receipts.map((row):ReviewSourceInput=>({id:'tool-result:'+row.resultSeq,kind:'context',title:`工具 ${row.name} 的${row.isError?'错误':'成功'}回执`,text:JSON.stringify({tool:row.name,callId:row.callId,isError:row.isError,text:row.text}),origin:{field:'toolResults',pointer:'/'+row.resultSeq}})),...evidence.continuations.map((row):ReviewSourceInput=>({id:'tool-continuation:'+row.seq,kind:'context',title:'已登记后台续轮的普通回执',text:row.text,origin:{field:'toolResults',pointer:'/'+row.seq}}))]
}

/** 冷读只复算宿主冻结草稿以前的原生事件；首次数据和正式交付必须携带同一份证据。 */
export function replayReviewToolEvidence(events:readonly SessionEvent[],value:ReviewToolEvidence):boolean{
 try{
  const {sha256,...body}=value
  if(value.schema!=='teloa.delivery-review-tools/v1'||sha(JSON.stringify(body))!==sha256)return false
  const snapshot={...value.execution,continuationMessageIds:new Set(value.execution.continuationMessageIds)}
  const read=collectReviewToolEvidence(events.filter(event=>event.seq<=value.draftSeq),{...snapshot,turn:value.turn},snapshot)
  return read.state==='ready'&&isDeepStrictEqual(read.evidence,value)
 }catch{return false}
}
