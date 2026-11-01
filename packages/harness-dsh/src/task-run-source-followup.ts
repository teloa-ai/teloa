import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {readFile,lstat,realpath} from 'node:fs/promises'
import {zstdDecompressSync} from 'node:zlib'
import type {Context} from '@deepseek-ai/cordis'
import {SessionId,SessionLogOffset,type SessionEvent} from '@deepseek-ai/dsh-session'
import type {SessionPersistence} from '@deepseek-ai/dsh-session-persistence'
import {foldGoal} from '@deepseek-ai/dsh-goal'
import type {TaskRun} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {observeTaskRun} from './task-run-observation.ts'

const denied=()=>new WorkError('teloa/conflict','原会话的日志、待办或后台工作尚不能证明安全，暂不能在原会话核验。')
/** 仅认可处置时完整 prefix；unknown 不转换为 completed。 */
function assertDispositionPrefix(run:TaskRun,events:readonly SessionEvent[]):void{
 const d=run.submissionDisposition
 if(run.state!=='submission_unknown'||!run.stopRequestedAt||run.evidence!==null||!d||d.logCut>=events.length||events.some((e,i)=>e.seq!==i)||createHash('sha256').update(JSON.stringify(events.slice(0,d.logCut+1))).digest('hex')!==d.logSha256)throw denied()
}
function assertClosedSession(events:readonly SessionEvent[]):void{
 const goal=foldGoal(events)
 if(goal?.goal&&goal.goal.phase!=='complete')throw denied()
 let turn=false,step=false
 const approvals=new Set<string>(),calls=new Set<string>(),results=new Set<string>()
 for(const event of events){
  if(event.type==='turn/start')turn=true;else if(event.type==='turn/end'){turn=false;step=false}else if(event.type==='step/start')step=true;else if(event.type==='step/end')step=false
  if(event.type==='approval/asked')approvals.add(event.data.id);else if(event.type==='approval/decided')approvals.delete(event.data.id)
  if(event.type==='tool/call'){const id=JSON.stringify([event.data.turn,event.data.step,event.data.callId]);if(!event.data.callId||calls.has(id))throw denied();calls.add(id)}
  else if(event.type==='tool/result'){const id=JSON.stringify([event.data.turn,event.data.step,event.data.message.toolCallId]);if(!event.data.message.toolCallId||!calls.has(id)||results.has(id))throw denied();results.add(id)}
 }
 if(turn||step||approvals.size||calls.size!==results.size)throw denied()
}
export function assertSourceFollowupEvents(run:TaskRun,events:readonly SessionEvent[]):void{
 assertDispositionPrefix(run,events)
 const d=run.submissionDisposition!
 const tail=events.slice(d.logCut+1)
 if(tail.length>1||tail.some(e=>e.type!=='session/end-seed'||!isDeepStrictEqual(e.data,{})))throw denied()
 assertClosedSession(events)
}

/** 暂停只认可信持久 Run 的终态链；后继工作不放宽新 followup 的严格 prefix/tail 准入。 */
export function assertTaskRunQuiescentEvents(run:TaskRun,events:readonly SessionEvent[],history:readonly TaskRun[]):void{
 if(!history.length||!history.some(item=>item.id===run.id)||new Set(history.map(item=>item.id)).size!==history.length||new Set(history.map(item=>item.nativeRequestId)).size!==history.length)throw denied()
 const requests=new Set(history.map(item=>item.nativeRequestId));let last=-1
 for(const item of history){
  if(item.taskId!==run.taskId||item.sessionId!==run.sessionId||item.roleId!==run.roleId||item.roleVersion!==run.roleVersion||item.agentPresetId!==run.agentPresetId)throw denied()
  if(item.state==='submission_unknown'){assertDispositionPrefix(item,events);last=Math.max(last,item.submissionDisposition!.logCut)}
  else{
   if(item.state!=='ended'||item.evidence?.state!=='ended'||!['completed','error'].includes(item.evidence.reason)||events[item.evidence.endSeq]?.type!=='turn/end'||!isDeepStrictEqual(observeTaskRun(events.slice(0,item.evidence.endSeq+1),item.nativeRequestId),item.evidence))throw denied()
   last=Math.max(last,item.evidence.endSeq)
  }
 }
 const tail=events.slice(last+1)
 if(events.some((event,index)=>event.seq!==index)||tail.length>1||tail.some(event=>event.type!=='session/end-seed'||!isDeepStrictEqual(event.data,{})))throw denied()
 let inTurn=false,owned=false;const seen=new Set<string>()
 for(const event of events){
  if(event.type==='turn/start'){if(inTurn)throw denied();inTurn=true;owned=false}
  else if(event.type==='turn/end'){if(!inTurn||!owned)throw denied();inTurn=false}
  else if(event.type==='user/message'){
   const source=event.data.source,kind:string=source.kind
   if(source.kind==='user'&&'rpcId' in source){if(!inTurn||!requests.has(source.rpcId)||seen.has(source.rpcId))throw denied();seen.add(source.rpcId);owned=true}
   else if(kind!=='agent-instructions'&&kind!=='runtime-context'&&kind!=='time-context')throw denied()
  }
 }
 assertClosedSession(events)
}

/** 官方持久冷读，不 resolve Agent，不恢复 Loop；物理文件完整性与官方投影须同时通过。 */
export async function inspectSourceFollowup(ctx:Context,run:TaskRun,signal:AbortSignal,verifyCompleted?:(events:readonly SessionEvent[])=>Promise<void>):Promise<void>{
 return inspectPersistentTaskRun(ctx,run,signal,async events=>{
  if(run.state==='submission_unknown')assertSourceFollowupEvents(run,events)
  else{
   if(run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.stopRequestedAt!==null||!verifyCompleted)throw denied()
   const tail=events.slice(run.evidence.endSeq+1)
   if(tail.length>1||tail.some(e=>e.type!=='session/end-seed'||!isDeepStrictEqual(e.data,{})))throw denied()
   assertClosedSession(events);await verifyCompleted(events)
  }
 })
}
export async function inspectTaskRunQuiescence(ctx:Context,run:TaskRun,signal:AbortSignal,history:readonly TaskRun[]):Promise<void>{
 return inspectPersistentTaskRun(ctx,run,signal,async events=>assertTaskRunQuiescentEvents(run,events,history))
}
async function inspectPersistentTaskRun(ctx:Context,run:TaskRun,signal:AbortSignal,verifyEvents:(events:readonly SessionEvent[])=>Promise<void>):Promise<void>{
 signal.throwIfAborted()
 const persistence=Reflect.get(ctx,'sessionPersistence') as SessionPersistence|undefined,resolver=persistence&&Reflect.get(persistence,'resolveCurrentLog')
 if(!persistence||typeof resolver!=='function'||!ctx.sessionProjections)throw denied()
 const id=SessionId(run.sessionId),path=await resolver.call(persistence,id,signal)
 if(typeof path!=='string')throw denied()
 const before=await lstat(path)
 if(!before.isFile()||before.isSymbolicLink()||await realpath(path)!==path||before.size<=0||before.size>67_108_864)throw denied()
 const bytes=await readFile(path),decoded=path.endsWith('.zstd')?zstdDecompressSync(bytes,{maxOutputLength:67_108_864}):bytes,text=new TextDecoder('utf-8',{fatal:true}).decode(decoded)
 if(!text.endsWith('\n'))throw denied()
 const records=text.slice(0,-1).split('\n').map(line=>JSON.parse(line)),handle=await persistence.open(id,'read',{signal})
 try{
  const {events}=await handle.read(0,undefined,{signal}),header=handle.header
  const physical=records[0],{type,inheritedEventCount=0,...meta}=physical??{}
  if(type!=='session'||inheritedEventCount!==0||handle.inheritedEventCount!==0||header.id!==run.sessionId||header.version!==4||header.cwd!==ctx.workingDirectory.defaultDirectory||header.agentPreset!==run.agentPresetId||header.parentSession!==undefined||header.origin==='subagent'||header.isSeeded||(header.delegationDepth??0)!==0||!isDeepStrictEqual(meta,header)||!isDeepStrictEqual(records.slice(1),events))throw denied()
  await verifyEvents(events)
  const projected=ctx.sessionProjections.restore({},events,SessionLogOffset(0),header,handle.inheritedEventCount).snapshot.values
  const inbox=projected.inbox
  if(!inbox||inbox['next-turn'].length||inbox['next-step'].length)throw denied()
  // 原始 user/turn 记录可以存在；未结审批或原生团队不能被空队列掩盖。
  if(projected.agentTeam?.members.some(member=>member.role==='teammate'))throw new WorkError('teloa/conflict','本轮核验尚不支持带团队成员的原会话，请保留原记录并先核对团队工作。')
  const live=ctx.agents.get(id)
  const nativeInput=ctx.get('teloaNativeInput')?.input
  if(live&&(live.status!=='idle'||live.inbox.nextTurn.length||live.inbox.nextStep.length)||ctx.jobs?.list(id).some(job=>job.owner===id&&['running','stopping'].includes(job.status))||nativeInput?.hasPendingJobCompletion(id)||nativeInput?.hasCancelledJobCompletion(id))throw denied()
  const after=await lstat(path)
  if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||!bytes.equals(await readFile(path))||await resolver.call(persistence,id,signal)!==path)throw denied()
  signal.throwIfAborted()
 }finally{await handle.close()}
}
