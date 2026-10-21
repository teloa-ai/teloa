import {isDeepStrictEqual} from 'node:util'
import type {SessionEvent,SessionHeader} from '@deepseek-ai/dsh-session'
import type {TaskRun,TaskRunSubagent} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import type {TaskRunPorts} from './task-run-driver.ts'
import {observeTaskRunTimeline} from './task-run-observation.ts'
import {readNativeReviewChildren,proveNativeReviewChildren} from './task-delivery-review-native-children.ts'

export type RetryChildInspection={meta:SessionHeader;inheritedEventCount:number;events:readonly SessionEvent[]}
const denied=()=>new WorkError('teloa/conflict','原执行的正式复核或副作用尚不能安全核对，请查看原运行；不会重复执行。')
const known=new Set(['permission/preset','sandbox/mode','approval/policy','agent/inbox/spliced','turn/start','step/start','system/message','user/message','request/header','request/context','assistant/attempt','assistant/message','tool/call','tool/result','step/end','turn/end','session/title','session/end-seed'])
const text=(parts:readonly {type:string;text?:string}[])=>parts.map(part=>part.text??'').join('\n')
/** 只认实际 call/result 和原 assistant 声明；isError 本身不能证明未知工具没有写入。 */
function safeCalls(events:readonly SessionEvent[],child:boolean){
 const calls=events.filter(event=>event.type==='tool/call'),results=events.filter(event=>event.type==='tool/result'),assistants=events.filter(event=>event.type==='assistant/message')
 if(new Set(calls.map(call=>call.data.callId)).size!==calls.length||results.length!==calls.length)throw denied()
 return calls.map(call=>{
  const matches=results.filter(result=>result.data.message.toolCallId===call.data.callId),result=matches[0]
  const declarations=assistants.flatMap(event=>event.data.message.content.flatMap(block=>block.type==='tool-call'&&block.id===call.data.callId?[{event,block}]:[])),declared=declarations[0]
  if(matches.length!==1||!result||declarations.length!==1||!declared||declared.block.name!==call.data.name||declared.block.arguments!==call.data.arguments||declared.event.data.turn!==call.data.turn||declared.event.data.step!==call.data.step||declared.event.seq>=call.seq||call.seq>=result.seq||result.data.turn!==call.data.turn||result.data.step!==call.data.step||!isDeepStrictEqual(result.sourceEventSeqs,[call.seq])||typeof result.data.message.isError!=='boolean'||result.data.message.content.some(part=>part.type!=='text'))throw denied()
  const value=text(result.data.message.content)
  // 已核宿主工具发现只改变当前会话的可见目录，不调用被发现工具。
  if(call.data.name==='teloa_tools_load'){}
  else if(!child&&call.data.name==='subagent_task'&&!result.data.message.isError){}
  // business-result-tools 的原生 child 身份守卫在读取/写入业务端口之前明确拒绝。
  else if(child&&call.data.name==='teloa_business_object_result_record'&&result.data.message.isError&&value==='Error: 子 Agent 会话不能使用业务看板工具。'){}
  else throw denied()
  return {callId:call.data.callId,name:call.data.name,arguments:call.data.arguments,callSeq:Number(call.seq),callTime:call.time,resultSeq:Number(result.seq),resultTime:result.time,isError:result.data.message.isError,text:value}
 })
}
function shape(events:readonly SessionEvent[],child:boolean){
 const input=events.find(event=>event.type==='user/message'&&event.data.source.kind==='user')
 const initialDirectory=(event:SessionEvent)=>event.type==='working-directory/change'&&input!==undefined&&event.seq<input.seq&&Object.keys(event.data).join(',')==='cwd'&&typeof event.data.cwd==='string'&&event.data.cwd.startsWith('/')&&!/[\x00-\x1f\x7f]/.test(event.data.cwd)
 // 官方 WorkingDirectoryService 只在首输入前投影默认 cwd；输入后的切目录仍拒绝。
 if(events.length>512||Buffer.byteLength(JSON.stringify(events))>2*1024*1024||events.some((event,index)=>event.seq!==index||!known.has(event.type)&&!initialDirectory(event)&&!(child&&event.type==='subagent/descriptor')&&!(!child&&event.type==='subagent/catalog')))throw denied()
 const ids=new Set(events.filter(event=>event.type==='tool/call').map(event=>event.data.callId))
 for(const event of events){
  if(event.type==='assistant/message'&&(event.data.interrupted===true||event.data.message.content.some(part=>!['text','reasoning','tool-call'].includes(part.type)||part.type==='tool-call'&&!ids.has(part.id))))throw denied()
  if(event.type==='assistant/attempt'&&event.data.stream.some(chunk=>chunk.type==='tool-call-chunks'&&!ids.has(chunk.id)))throw denied()
  if(event.type==='user/message'&&(event.data.content.some(part=>part.type!=='text')||!['user','agent-instructions','runtime-context','time-context'].includes(event.data.source.kind)))throw denied()
 }
}
const registered=(rows:readonly TaskRunSubagent[])=>rows.map(({tokenEstimate:_,...row})=>row)

/** 本轮只支持 owner 的单轮文本/工具发现与 fresh 纯计算子调用；不扩为通用副作用重试。 */
export async function assertSafeReviewFailedRetry(run:TaskRun,ports:TaskRunPorts,signal:AbortSignal,registrations:{subagents:readonly unknown[];webAccess:readonly unknown[]}):Promise<void>{
 if(run.executor?.kind!=='owner'||run.roleId!==null||run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.stopRequestedAt!==null||run.flowId!==undefined||run.groupContext!==undefined||registrations.webAccess.length||registrations.subagents.length>4||!ports.backgroundState||!ports.subagentState||!ports.flowState||!ports.stopState||!ports.goalObservation||!ports.retryOwnerOnlyBackground||!ports.reviewSubagents)throw denied()
 const events=await ports.events(run);signal.throwIfAborted();shape(events,false)
 if(events.length!==run.evidence.endSeq+1||!isDeepStrictEqual(observeTaskRunTimeline(events,run.nativeRequestId).observation,run.evidence))throw denied()
 const roots=events.filter(event=>event.type==='user/message'&&event.data.source.kind==='user')
 const root=roots[0]
 if(roots.length!==1||root?.type!=='user/message'||root.seq!==run.evidence.messageSeq||Reflect.get(root.data.source,'rpcId')!==run.nativeRequestId)throw denied()
 const before=await ports.reviewSubagents(run,signal)
 if(!isDeepStrictEqual(registered(before),registered(registrations.subagents as TaskRunSubagent[])))throw denied()
 const inspected=new Map<string,RetryChildInspection>()
 const inspect=async(id:string)=>{
  if(!ports.retryChildInspection)throw denied()
  const snapshot=await ports.retryChildInspection(run,id,signal);signal.throwIfAborted();shape(snapshot.events,true)
  safeCalls(snapshot.events,true);inspected.set(id,snapshot);return snapshot
 }
 const binding={runId:run.id,sessionId:run.sessionId,requestId:run.nativeRequestId}
 let children:Awaited<ReturnType<typeof readNativeReviewChildren>>
 try{children=await readNativeReviewChildren({inspect,live:()=>undefined},events,binding,before,signal)}catch{signal.throwIfAborted();throw denied()}
 if((children?.length??0)!==before.length||!proveNativeReviewChildren(events.filter(event=>event.type==='subagent/catalog'),safeCalls(events,false),binding,children))throw denied()
 const settled=async()=>{
  const [background,children,flow,host,goal,ownerOnly]=await Promise.all([ports.backgroundState!(run),ports.subagentState!(run,signal),ports.flowState!(run),ports.stopState!(run),ports.goalObservation!(run,events),ports.retryOwnerOnlyBackground!(run,signal)])
  if(background.outstanding!==false||background.cancelled===true||typeof background.interrupted!=='boolean'||children!=='none'||flow!=='none'||host.running!==false||goal!==undefined||ownerOnly!==true)throw denied()
 }
 await settled()
 for(const [id,snapshot] of inspected)if(!isDeepStrictEqual(await ports.retryChildInspection!(run,id,signal),snapshot))throw denied()
 if(!isDeepStrictEqual(await ports.events(run),events)||!isDeepStrictEqual(registered(await ports.reviewSubagents(run,signal)),registered(before)))throw denied()
 await settled();signal.throwIfAborted()
}
