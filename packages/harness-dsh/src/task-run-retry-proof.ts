import {isDeepStrictEqual} from 'node:util'
import {WorkError,taskInput} from '@teloa/contract'
import type {TaskRun} from '@teloa/backend'
import type {TaskRunPorts} from './task-run-driver.ts'
import {observeTaskRunTimeline} from './task-run-observation.ts'

const denied=()=>new WorkError('teloa/conflict','无法证实原失败没有执行副作用，请核对原运行；不会重复派发。')
/** 官方 fallback 标题是原输入的日志投影；种子边界也是元数据，均不进入模型消息或派发工作。 */
function safeSessionMetadata(event:{type:string;seq:number;data:unknown},messageSeq:number,endSeq:number):boolean{
 try{
  if(event.type==='session/end-seed')return Object.keys(taskInput(event.data,[])).length===0
  if(event.type!=='session/title')return false
  const data=taskInput(event.data,['title','messageSeqs','source']),source=taskInput(data.source,['kind'])
  return Object.keys(data).length===3&&Object.keys(source).length===1&&source.kind==='fallback'&&typeof data.title==='string'&&data.title.length>0&&data.title.trim()===data.title&&data.title.replace(/\s+/gu,' ')===data.title&&!/[\x00-\x1f\x7f-\x9f\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/u.test(data.title)&&Array.isArray(data.messageSeqs)&&data.messageSeqs.length===1&&data.messageSeqs[0]===messageSeq&&event.seq>messageSeq&&event.seq<endSeq
 }catch{return false}
}
/** 显式重试只接受固定失败轮的零输出、零工具、零子级证据；读取失败不是零副作用证明。 */
export async function assertSafeTaskRunRetry(run:TaskRun,ports:TaskRunPorts,signal:AbortSignal,registrations:{subagents:readonly unknown[];webAccess:readonly unknown[]}):Promise<void>{
 signal.throwIfAborted()
 if(run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='error'||run.stopRequestedAt!==null||run.flowId!==undefined||run.groupContext!==undefined||!Array.isArray(registrations.subagents)||!Array.isArray(registrations.webAccess)||registrations.subagents.length||registrations.webAccess.length)throw denied()
 if(!ports.backgroundState||!ports.subagentState||!ports.flowState||!ports.stopState||!ports.goalObservation)throw denied()
 const events=await ports.events(run)
 const timeline=observeTaskRunTimeline(events,run.nativeRequestId),observed=timeline.observation
 if(timeline.turn!==run.evidence.turn||observed.state!=='ended'||observed.reason!=='error'||!isDeepStrictEqual(observed,run.evidence))throw denied()
 const harmless=new Set<string>(['permission/preset','sandbox/mode','approval/policy','agent/inbox/spliced','turn/start','step/start','system/message','user/message','request/header','request/context','assistant/attempt','step/end','turn/end'])
 let ownMessages=0
 for(const event of events){
  if(['session/title','session/end-seed'].includes(event.type)){
   if(!safeSessionMetadata(event,run.evidence.messageSeq,run.evidence.endSeq))throw denied()
   continue
  }
  if(!harmless.has(event.type))throw denied()
  if(event.type==='agent/inbox/spliced'){
   if(event.seq>run.evidence.endSeq&&event.data.inserted.length)throw denied()
   for(const message of event.data.inserted){if(message.role!=='user')throw denied();const source=message.source,kind:string=source.kind;if(kind!=='agent-instructions'&&kind!=='runtime-context'&&!(source.kind==='user'&&'rpcId' in source&&source.rpcId===run.nativeRequestId))throw denied();if(message.content.some(block=>block.type!=='text'))throw denied()}
  }

  if(event.seq>run.evidence.endSeq&&(event.type==='user/message'||event.type==='turn/start'||event.type==='turn/end'))throw denied()
  if(event.type==='user/message'){
   const source=event.data.source,kind:string=source.kind
   if(source.kind==='user'&&'rpcId' in source&&source.rpcId===run.nativeRequestId)ownMessages++
   else if(kind!=='agent-instructions'&&kind!=='runtime-context')throw denied()
   if(event.data.content.some(block=>block.type!=='text'))throw denied()
  }
  if(event.type==='assistant/message'||event.type.startsWith('tool/')||event.type.startsWith('team/')||event.type.startsWith('subagent/')||event.type.startsWith('job/'))throw denied()
  if(event.type==='assistant/attempt'&&event.data.stream.some(record=>record.type!=='chunk'||record.chunk.type!=='finish'||record.chunk.reason.kind!=='error'))throw denied()
 }
 if(ownMessages!==1)throw denied()
 const [background,children,flow,host,goal]=await Promise.all([ports.backgroundState(run),ports.subagentState(run,signal),ports.flowState(run),ports.stopState(run),ports.goalObservation(run,events)])
 if(background.outstanding!==false||background.cancelled!==undefined&&background.cancelled!==false||children!=='none'||flow!=='none'||host.running!==false||goal!==undefined)throw denied()
 let ownerOnly=false
 if(background.interrupted!==false&&background.interrupted!==true)throw denied()
 if(ports.retryOwnerOnlyBackground){
  // 有宿主登记读口时，空登记也不是“从未派发”的证明；当前与旧世代均须精确只有 owner。
  if(!await ports.retryOwnerOnlyBackground(run,signal))throw denied()
  ownerOnly=true
 }else if(background.interrupted!==false)throw denied()
 // 完整原生日志在各收口读数之后再次核对，不能借旧快照忽略迟到输入或工作。
 const after=await ports.events(run)
 signal.throwIfAborted();if(!isDeepStrictEqual(after,events))throw denied()
 if(ownerOnly&&!await ports.retryOwnerOnlyBackground!(run,signal))throw denied()
}
