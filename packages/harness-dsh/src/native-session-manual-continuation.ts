import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Context} from '@deepseek-ai/cordis'
import {SessionId,type UserMessage} from '@deepseek-ai/dsh-session'
import {WorkError} from '@teloa/contract'
import {combineWorkAccessLeases,type NativeSessionContinuationJournal,type NativeSessionCheckpoint,type NativeSessionContinuation,type WorkAccessLease} from '@teloa/backend'
import type {TeloaNativeInput} from './native-input-provider.ts'
import type {NativeCheckpointSnapshot,NativeInputRestoreInput,NativeInputRestoreLease,NativeInputCheckpointInput} from './native-input-checkpoint.ts'
import {nativeInputRecoveryCandidate} from './native-input-recovery-candidate.ts'
import {inspectNativeTurnContinuation} from './native-turn-continuation.ts'
import {nativeInputIdentity} from './native-input-access.ts'

type Ports={
 owner:string;journal:NativeSessionContinuationJournal;nativeInput:TeloaNativeInput['input'];generation:()=>number;assertCurrent:()=>void
 snapshot:(sessionId:string)=>Promise<NativeCheckpointSnapshot>
 inbox:(snapshot:NativeCheckpointSnapshot)=>Parameters<typeof nativeInputRecoveryCandidate>[0]['inbox']
 authorize:(checkpoint:NativeSessionCheckpoint)=>Promise<WorkAccessLease>
 binding:(checkpoint:NativeSessionCheckpoint,db?:Parameters<Parameters<NativeSessionContinuationJournal['prepare']>[3]>[0])=>Promise<string>
 accepted?:(checkpoint:NativeSessionCheckpoint,input:NativeInputCheckpointInput)=>void
}
type Candidate={checkpoint:NativeSessionCheckpoint;snapshot:NativeCheckpointSnapshot;prefix:{logCut:number;logSha256:string};input:'continuation'|'pending'}
type Permit={record:NativeSessionContinuation;lease:WorkAccessLease;binding:string}
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const denied=()=>new WorkError('teloa/conflict','原会话的未完成工作或恢复许可已变化，请保留原输入并重新核对。')

/** 只有本人显式resume调用会创建/装配票据；inspect、启动、历史读与重连均不装配许可。 */
export function createNativeSessionManualContinuation(ctx:Context,ports:Ports){
 const permits=new Map<string,Permit>(),inFlight=new Map<string,{prefix:string;operation:Promise<unknown>}>()
 const current=()=>ports.assertCurrent()
 const read=async(sessionId:string):Promise<Candidate|null>=>{
  current()
  const checkpoint=await ports.journal.latest(ports.owner,sessionId)
  if(!checkpoint||checkpoint.runId!==null||checkpoint.review!==null||checkpoint.roots.length!==1||checkpoint.hostGeneration>ports.generation())return null
  await ports.binding(checkpoint)
  const snapshot=await ports.snapshot(sessionId),prefix={logCut:snapshot.events.length-1,logSha256:sha(snapshot.events)}
  if(checkpoint.background===undefined||checkpoint.background.unsettledJobIds.length)return null
  if(snapshot.header.id!==sessionId||snapshot.header.parentSession!==undefined||snapshot.header.origin!==undefined||snapshot.header.isSeeded||snapshot.inheritedEventCount!==0||snapshot.events.some((event,index)=>event.seq!==index)||sha(snapshot.events.slice(0,checkpoint.logCut+1))!==checkpoint.logSha256)return null
  const pending=nativeInputRecoveryCandidate({snapshot,inbox:ports.inbox(snapshot)})
  if(pending&&isDeepStrictEqual(pending.roots,checkpoint.roots))return {checkpoint,snapshot,prefix,input:'pending'}
  // 旧检查点之后新落下的工具回执尚未带回后台事实，不能把空的新宿主注册表当旧资源已结束。
  if(snapshot.events.some(event=>event.seq>checkpoint.logCut&&(event.type==='tool/call'||event.type==='tool/result')))return null
  const inspected=inspectNativeTurnContinuation(snapshot,checkpoint,ports.generation(),true)
  return inspected.state==='ready'?{checkpoint,snapshot,prefix,input:'continuation'}:null
 }
 const assertPermit=(sessionId:string,permit:Permit,continuation=false)=>{
  current();if(permits.get(sessionId)!==permit)throw denied()
  ;(continuation||permit.record.state==='accepted'?permit.lease.assertContinuationCurrent??permit.lease.assertCurrent:permit.lease.assertCurrent)()
 }
 const accept=async(permit:Permit,snapshot:NativeCheckpointSnapshot)=>{
  const r=permit.record,sid=r.checkpoint.sessionId
  assertPermit(sid,permit)
  if(sha(snapshot.events.slice(0,r.prefix.logCut+1))!==r.prefix.logSha256)throw denied()
  const messageId=r.message?.id??r.checkpoint.roots[0]!.messageId
  const events=snapshot.events.filter(event=>event.type==='agent/inbox/spliced'&&event.data.target==='next-turn'&&event.data.inserted.some(message=>message.id===messageId))
  if(events.length!==1)throw denied()
  permit.record=await ports.journal.accept(ports.owner,r.id,events[0]!.seq,events[0],()=>assertPermit(sid,permit),ports.generation())
 }
 return {
  async inspect(sessionId:string){const candidate=await read(sessionId);return {sessionId,available:candidate!==null,...(candidate?{prefixSha256:candidate.prefix.logSha256}:{})}},
  async resume(sessionId:string,prefixSha256:string,signal:AbortSignal){
   const existing=inFlight.get(sessionId)
   if(existing){if(existing.prefix!==prefixSha256)throw denied();return existing.operation}
   const operation=(async()=>{
    current();signal.throwIfAborted()
    let record=await ports.journal.forPrefix(ports.owner,sessionId,prefixSha256)
    if(record&&(record.mode!=='manual'||record.checkpoint.runId!==null))throw denied()
    const candidate=record?null:await read(sessionId)
    if(!record&&(!candidate||candidate.prefix.logSha256!==prefixSha256))throw denied()
    const checkpoint=record?.checkpoint??candidate!.checkpoint,binding=await ports.binding(checkpoint),lease=await ports.authorize(checkpoint)
    signal.throwIfAborted();lease.assertCurrent()
    if(!record){
     const prepared=await ports.journal.prepare(checkpoint,ports.generation(),'manual',async db=>{if(await ports.binding(checkpoint,db)!==binding)throw denied();signal.throwIfAborted();lease.assertCurrent();return lease},candidate!.input,candidate!.prefix)
     record=prepared.record
    }
    if(record.hostGeneration>ports.generation()||await ports.binding(checkpoint)!==binding)throw denied()
    const permit:Permit={record,lease,binding};permits.set(sessionId,permit)
    const now=await ports.snapshot(sessionId)
    if(sha(now.events.slice(0,record.prefix.logCut+1))!==record.prefix.logSha256)throw denied()
    const pending=nativeInputRecoveryCandidate({snapshot:now,inbox:ports.inbox(now)})
    const pendingId=record.message?.id??checkpoint.roots[0]!.messageId
    const existing=pending?.messages.some(message=>message.id===pendingId)
    if(record.state==='accepted'&&!existing)return {sessionId,accepted:true}
    if(record.input==='pending'||existing){
     await accept(permit,now)
     const resolved=await ctx.sessionController.resolveAgent(SessionId(sessionId))
     signal.throwIfAborted();assertPermit(sessionId,permit)
     if('error'in resolved)throw denied()
     if(resolved.agent.inbox.nextTurn.length)await ports.nativeInput.wakePending(resolved.agent,signal)
    }else{
     const inspected=inspectNativeTurnContinuation(now,checkpoint,ports.generation(),true)
     if(inspected.state!=='ready'||record.message===null)throw denied()
     const resolved=await ctx.sessionController.resolveAgent(SessionId(sessionId))
     signal.throwIfAborted();assertPermit(sessionId,permit)
     if('error'in resolved)throw denied()
     const message=structuredClone(record.message) as UserMessage
     await ports.nativeInput.withNewInput(resolved.agent,message,{producer:'prompt',identity:'manual-continuation:'+record.id},()=>resolved.agent.followup(message),signal,{assertCurrent:()=>assertPermit(sessionId,permit),assertContinuationCurrent:()=>assertPermit(sessionId,permit,true)})
    }
    return {sessionId,accepted:true}
   })()
   inFlight.set(sessionId,{prefix:prefixSha256,operation})
   try{return await operation}finally{if(inFlight.get(sessionId)?.operation===operation)inFlight.delete(sessionId)}
  },
  async restore(input:NativeInputRestoreInput):Promise<NativeInputRestoreLease>{
   const permit=permits.get(input.sessionId);if(!permit||!inFlight.has(input.sessionId))throw denied()
   assertPermit(input.sessionId,permit)
   if(await ports.binding(permit.record.checkpoint)!==permit.binding)throw denied()
   const record=permit.record,messageId=record.message?.id??record.checkpoint.roots[0]!.messageId
   const candidate=nativeInputRecoveryCandidate({snapshot:input.snapshot,inbox:ports.inbox(input.snapshot)})
   if(!candidate||candidate.messages.length!==1||candidate.messages[0]!.id!==messageId||!isDeepStrictEqual(candidate.messages,input.messages))throw denied()
   await accept(permit,input.snapshot)
   const lease=combineWorkAccessLeases([permit.lease,await ports.authorize(record.checkpoint)])
   const roots=Object.freeze(candidate.roots.map(root=>Object.freeze({...root})))
   return Object.freeze({roots,assertCurrent:()=>{input.signal.throwIfAborted();assertPermit(input.sessionId,permit);lease.assertCurrent();return undefined}})
  },
  async checkpoint(input:NativeInputCheckpointInput){
   const permit=permits.get(String(input.agent.id));if(!permit)return
   const id=permit.record.message?.id??permit.record.checkpoint.roots[0]!.messageId
   if(!input.messages.some(message=>message.id===id))return
   const message=input.messages.find(message=>message.id===id)!
   if(permit.record.message?!isDeepStrictEqual(message,permit.record.message):nativeInputIdentity(message).payloadSha256!==permit.record.checkpoint.roots[0]!.payloadSha256)throw denied()
   input.assertCurrent();await accept(permit,input.snapshot);input.assertCurrent();ports.accepted?.(permit.record.checkpoint,input)
  },
  invalidate(sessionId:string){permits.delete(sessionId)},
  close(){permits.clear()},
 }
}
