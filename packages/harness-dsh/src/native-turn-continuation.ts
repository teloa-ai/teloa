import {createHash} from 'node:crypto'
import {interruptedTurnClosers,type SessionEvent} from '@deepseek-ai/dsh-session'
import type {NativeCheckpointSnapshot,NativeInputRoot} from './native-input-checkpoint.ts'
import {nativeInputIdentity} from './native-input-access.ts'
declare module '@deepseek-ai/dsh-llm' {interface MessageSourceMap {'plugin:teloa.session-continuation':{kind:'plugin:teloa.session-continuation';continuationId:string;form:'notice';summary:string}}}

/** 只读持久检查点输入；候选或恢复文案本身均不授予执行许可。 */
export type NativeTurnCheckpoint=Readonly<{sessionId:string;hostGeneration:number;phase:'claimed'|'model'|'tools'|'step-end'|'turn-end';logCut:number;logSha256:string;roots:readonly NativeInputRoot[];runtimeId?:string;background?:{runtimeId:string;unsettledJobIds:readonly string[]}}>
export type NativeTurnContinuation=Readonly<{sessionId:string;turn:number;requestId:string;messageSeq:number;messageId:string;logCut:number;logSha256:string;roots:readonly NativeInputRoot[]}>
export type NativeTurnContinuationInspection={state:'ready';candidate:NativeTurnContinuation}|{state:'completed'|'held';reason:string}
const hash=(events:readonly SessionEvent[])=>createHash('sha256').update(JSON.stringify(events)).digest('hex')

/** 核对完整原前缀和实际Inbox受理根；未知外部结果、未结清输入及主动终止一律交回核对。 */
export function inspectNativeTurnContinuation(snapshot:NativeCheckpointSnapshot,checkpoint:NativeTurnCheckpoint,currentHostGeneration:number,manual?:true,reviewRecovery?:true,verifiedContinuations:ReadonlySet<string>=new Set()):NativeTurnContinuationInspection{
 const held=(reason:string):NativeTurnContinuationInspection=>({state:'held',reason})
 try{
  const {header,events,inheritedEventCount}=snapshot
  if(header.id!==checkpoint.sessionId||header.origin!==undefined||header.parentSession!==undefined||inheritedEventCount!==0||!Number.isSafeInteger(currentHostGeneration)||!Number.isSafeInteger(checkpoint.hostGeneration)||checkpoint.hostGeneration<1||checkpoint.hostGeneration>currentHostGeneration||!manual&&checkpoint.hostGeneration===currentHostGeneration)return held('identity')
  if(!Number.isSafeInteger(checkpoint.logCut)||checkpoint.logCut<0||checkpoint.logCut>=events.length||events.some((event,index)=>event.seq!==index)||hash(events.slice(0,checkpoint.logCut+1))!==checkpoint.logSha256)return held('prefix')
  let start=-1
  for(let i=0;i<events.length;i++)if(events[i]!.type==='turn/start')start=i
  const opened=events[start]
  if(opened?.type!=='turn/start')return held('turn')
  const turn=opened.data.turn,tail=events.slice(start),end=tail.find(event=>event.type==='turn/end')
  if(start>checkpoint.logCut||!checkpoint.roots.length)return held('checkpoint')
  const users=tail.filter((event):event is Extract<SessionEvent,{type:'user/message'}>=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user')
  const originals=events.filter((event):event is Extract<SessionEvent,{type:'user/message'}>=>event.type==='user/message'&&event.surfaceOp==='append'&&checkpoint.roots.some(root=>root.messageId===event.data.id))
  if(originals.length!==1||users.length>1||users.some(user=>user.data.id!==originals[0]!.data.id))return held('mixed-input')
  const original=originals[0]!,identity=nativeInputIdentity(original.data),rpc=Reflect.get(original.data.source,'rpcId')
  if(typeof rpc!=='string'||!rpc||Object.keys(original.data.source).some(key=>!['kind','rpcId'].includes(key)))return held('input')
  const root=checkpoint.roots.find(root=>root.messageId===original.data.id&&root.nativeRequestId===rpc&&root.payloadSha256===identity.payloadSha256&&root.sessionId===header.id)
  if(!root||checkpoint.roots.length!==1)return held('roots')
  const accepted=events.filter(event=>event.type==='agent/inbox/spliced'&&event.seq<original.seq&&event.data.inserted.some(message=>message.id===root.messageId&&nativeInputIdentity(message).payloadSha256===root.payloadSha256))
  if(accepted.length!==1)return held('inbox-receipt')
  const queuesForClaim:{'next-turn':import('@deepseek-ai/dsh-session').UserMessage[];'next-step':import('@deepseek-ai/dsh-session').UserMessage[]}={'next-turn':[],'next-step':[]}
  let continued=users.length===1
  for(const event of events)if(event.type==='agent/inbox/spliced'){
   const queue=queuesForClaim[event.data.target],removed=queue.splice(event.data.start,event.data.removedCount??0,...event.data.inserted)
   if(event.seq>=start&&event.data.target==='next-turn'&&event.data.outcome!=='canceled'&&removed.length===1){const m=removed[0]!;if(verifiedContinuations.has(m.id)||event.seq<=checkpoint.logCut&&m.source.kind==='tool-jobs'&&checkpoint.background?.runtimeId===checkpoint.runtimeId&&!checkpoint.background?.unsettledJobIds.length)continued=true}
  }
  if(!continued)return held('continuation-receipt')
  if(end?.type==='turn/end'){
   if(end.data.reason.kind==='completed'&&!reviewRecovery)return {state:'completed',reason:'delivery-only'}
   // 官方生命周期退役与本人取消分别持久记录；只有真实disposed可按程序退出继续核验。
   const repaired=end.data.reason.kind==='interrupted'&&end.seq>checkpoint.logCut&&JSON.stringify(interruptedTurnClosers(events.slice(0,end.seq)))===JSON.stringify([end])
   if(!(reviewRecovery&&end.data.reason.kind==='completed')&&!repaired&&!(manual&&end.data.reason.kind==='error')&&(end.data.reason.kind!=='aborted'||end.data.reason.reason.kind!=='disposed'))return held('terminal')
   if(tail.some(event=>event.seq>end.seq&&(event.type!=='session/end-seed'||Object.keys(event.data).length!==0)))return held('post-terminal-input')
  }
  const approvals=new Set<string>(),calls=new Map<string,SessionEvent>(),results=new Set<string>()
  for(const event of tail){
   if(event.type.startsWith('team/')||event.type.startsWith('subagent/')&&event.type!=='subagent/catalog')return held('child-work')
   if(event.type==='approval/asked')approvals.add(event.data.id)
   else if(event.type==='approval/decided')approvals.delete(event.data.id)
   else if(event.type==='tool/call'){
    if(['bash','run_code','external_harness','job_output','job_list','job_kill'].includes(event.data.name)&&(!checkpoint.runtimeId||checkpoint.background?.runtimeId!==checkpoint.runtimeId||checkpoint.background.unsettledJobIds.length||event.seq>checkpoint.logCut))return held('background-work')
    const key=JSON.stringify([event.data.turn,event.data.step,event.data.callId])
    if(!event.data.callId||calls.has(key))return held('tool-call')
    calls.set(key,event)
   }else if(event.type==='tool/result'){
    const key=JSON.stringify([event.data.turn,event.data.step,event.data.message.toolCallId]),call=calls.get(key)
    if(!call||results.has(key)||event.data.message.isError&&!(reviewRecovery&&call.type==='tool/call'&&call.data.name==='teloa_submit_review_plan')||event.sourceEventSeqs?.length!==1||event.sourceEventSeqs[0]!==call.seq)return held('tool-result')
    results.add(key)
   }else if(event.type==='user/message'&&event.data.source.kind==='tool-jobs'&&(!checkpoint.runtimeId||checkpoint.background?.runtimeId!==checkpoint.runtimeId||checkpoint.background.unsettledJobIds.length||event.seq>checkpoint.logCut))return held('background-input')
  }
  if(approvals.size||calls.size!==results.size)return held('unknown-operation')
  // 检查点之后的步骤内输入没有通用恢复协议，不能静默改成下一轮本人输入。
  const queues:{'next-turn':unknown[];'next-step':unknown[]}={'next-turn':[],'next-step':[]}
  for(const event of events)if(event.type==='agent/inbox/spliced'){
   const {target,start,inserted,removedCount=0}=event.data,queue=queues[target]
   if(!queue||!Number.isSafeInteger(start)||start<0||start>queue.length||!Number.isSafeInteger(removedCount)||removedCount<0||removedCount>queue.length-start)return held('inbox-state')
   queue.splice(start,removedCount,...inserted)
  }
  if(queues['next-step'].length)return held('step-input')
  if(queues['next-turn'].length)return held('pending-input')
  return {state:'ready',candidate:{sessionId:header.id,turn,requestId:rpc,messageSeq:original.seq,messageId:original.data.id,logCut:events.length-1,logSha256:hash(events),roots:checkpoint.roots}}
 }catch{return held('unverifiable')}
}
