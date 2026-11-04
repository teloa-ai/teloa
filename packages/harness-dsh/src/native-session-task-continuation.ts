import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {UserMessage} from '@deepseek-ai/dsh-session'
import {WorkError} from '@teloa/contract'
import type {NativeSessionCheckpoint,NativeSessionContinuation,NativeSessionContinuationJournal,TaskRun,TaskExecutionScope,WorkAccessLease} from '@teloa/backend'
import type {TeloaNativeInput} from './native-input-provider.ts'
import type {NativeCheckpointSnapshot,NativeInputCheckpointInput,NativeInputRestoreInput,NativeInputRestoreLease} from './native-input-checkpoint.ts'
import {nativeInputRecoveryCandidate} from './native-input-recovery-candidate.ts'
import {inspectNativeTurnContinuation} from './native-turn-continuation.ts'
import type {TaskRunPorts} from './task-run-driver.ts'

type Admission={run:TaskRun;target:TaskExecutionScope;lease:WorkAccessLease}
type Ports={owner:string;journal:NativeSessionContinuationJournal;generation:()=>number;assertCurrent:()=>void;nativeInput:TeloaNativeInput['input'];snapshot:(sid:string)=>Promise<NativeCheckpointSnapshot>;inbox:(s:NativeCheckpointSnapshot)=>Parameters<typeof nativeInputRecoveryCandidate>[0]['inbox'];safe:(c:NativeSessionCheckpoint)=>Promise<boolean>;authorize:(db:Parameters<Parameters<NativeSessionContinuationJournal['prepare']>[3]>[0],c:NativeSessionCheckpoint,r:NativeSessionContinuation)=>Promise<Admission>;execute:NonNullable<TaskRunPorts['continueNative']>;accepted:(record:NativeSessionContinuation,input:NativeInputCheckpointInput)=>Promise<void>;report?:(code:string)=>void}
type Candidate={checkpoint:NativeSessionCheckpoint;snapshot:NativeCheckpointSnapshot;input:'pending'|'continuation';prefix?:NativeSessionContinuation['prefix']}
type Permit=Admission&{record:NativeSessionContinuation;snapshot:NativeCheckpointSnapshot}
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const denied=()=>new WorkError('teloa/conflict','原任务续作的持久票据、受理根或当前许可已变化。')

/** ready pump 的唯一原任务续作生产口；不创建Task/Run、不复制原输入、不调用start。 */
export function createNativeSessionTaskContinuation(ports:Ports){
 const permits=new Map<string,Permit>(),inFlight=new Map<string,Promise<void>>()
 const failures=new Map<string,string>()
 const report=(c:NativeSessionCheckpoint,error:unknown)=>{const key=sha([c,ports.generation(),error instanceof WorkError?error.code:'teloa/unavailable']);if(failures.get(c.sessionId)!==key){failures.set(c.sessionId,key);ports.report?.(error instanceof WorkError?error.code:'teloa/unavailable')}}
 const assert=(permit:Permit)=>{ports.assertCurrent();if(permits.get(permit.record.checkpoint.sessionId)!==permit)throw denied();permit.lease.assertCurrent()}
 const read=async(c:NativeSessionCheckpoint):Promise<Candidate|null>=>{
  ports.assertCurrent()
  if(c.ownerId!==ports.owner||c.runId===null||c.scopeRunId!==c.runId||c.hostGeneration>=ports.generation()||c.background?.runtimeId!==c.runtimeId||c.background.unsettledJobIds.length||!await ports.safe(c))return null
  const snapshot=await ports.snapshot(c.sessionId)
  if(snapshot.header.id!==c.sessionId||snapshot.header.origin!==undefined||snapshot.header.parentSession!==undefined||snapshot.header.isSeeded||snapshot.inheritedEventCount!==0||snapshot.events.some((event,index)=>event.seq!==index)||sha(snapshot.events.slice(0,c.logCut+1))!==c.logSha256)return null
  const pending=nativeInputRecoveryCandidate({snapshot,inbox:ports.inbox(snapshot)})
  const terminal=[...snapshot.events].reverse().find(e=>e.type==='turn/end')
  if(terminal?.type==='turn/end'&&terminal.data.reason.kind==='aborted'&&terminal.data.reason.reason.kind!=='disposed')return null
  if(pending&&isDeepStrictEqual(pending.roots,c.roots)){
   const existing=(await ports.journal.records(ports.owner,c.sessionId)).filter(r=>r.mode==='automatic'&&r.input==='pending'&&isDeepStrictEqual(r.checkpoint,c)&&sha(snapshot.events.slice(0,r.prefix.logCut+1))===r.prefix.logSha256)
   if(existing.length>1)throw denied()
   return {checkpoint:c,snapshot,input:'pending',...(existing[0]?{prefix:existing[0].prefix}:{})}
  }
  if(pending?.messages.length===1){
   const existing=(await ports.journal.records(ports.owner,c.sessionId)).filter(r=>r.mode==='automatic'&&r.input==='continuation'&&r.message!==null&&isDeepStrictEqual(r.checkpoint,c)&&isDeepStrictEqual(r.message,pending.messages[0])&&sha(snapshot.events.slice(0,r.prefix.logCut+1))===r.prefix.logSha256)
   if(existing.length===1)return {checkpoint:c,snapshot,input:'continuation',prefix:existing[0]!.prefix}
  }
  if(snapshot.events.some(event=>event.seq>c.logCut&&(event.type==='tool/call'||event.type==='tool/result')))return null
  // 最终宿主交付已落盘时交给原成果收口，不能再次折叠旧R4形成第二份交付。
  if(snapshot.events.some(event=>event.seq>c.logCut&&event.type==='user/message'&&event.data.source.kind==='plugin:teloa.delivery-review'))return null
  const verified=new Set<string>()
  for(const r of await ports.journal.records(ports.owner,c.sessionId)){
   if(r.mode!=='automatic'||r.state!=='accepted'||r.checkpoint.runId!==c.runId||r.checkpoint.requestId!==c.requestId||r.message===null||r.acceptedSeq===null)continue
   const event=snapshot.events[r.acceptedSeq]
   if(event?.type!=='agent/inbox/spliced'||event.data.inserted.length!==1||!isDeepStrictEqual(event.data.inserted[0],r.message)||sha(event)!==r.acceptedEventSha256||sha(snapshot.events.slice(0,r.prefix.logCut+1))!==r.prefix.logSha256)throw denied()
   verified.add(r.message.id)
  }
  const inspected=inspectNativeTurnContinuation(snapshot,c,ports.generation(),undefined,c.review?true:undefined,verified)
  return inspected.state==='ready'?{checkpoint:c,snapshot,input:'continuation'}:null
 }
 const accept=async(permit:Permit,snapshot:NativeCheckpointSnapshot)=>{
  assert(permit);const r=permit.record,id=r.message?.id??r.checkpoint.roots[0]!.messageId
  if(sha(snapshot.events.slice(0,r.prefix.logCut+1))!==r.prefix.logSha256)throw denied()
  const events=snapshot.events.filter(event=>event.type==='agent/inbox/spliced'&&event.data.target==='next-turn'&&event.data.inserted.some(message=>message.id===id))
  if(events.length!==1)throw denied()
  permit.record=await ports.journal.accept(ports.owner,r.id,events[0]!.seq,events[0],()=>assert(permit),ports.generation())
 }
 return {
  async safeRunIds():Promise<ReadonlySet<string>>{const result=new Set<string>();for(const c of await ports.journal.automaticCandidates(ports.owner,ports.generation()))try{if(await read(c))result.add(c.runId!)}catch(error){report(c,error)}return result},
  async pump(signal:AbortSignal):Promise<void>{
   for(const c of await ports.journal.automaticCandidates(ports.owner,ports.generation())){
    signal.throwIfAborted();if(inFlight.has(c.sessionId))continue
    const operation=(async()=>{
     const candidate=await read(c);if(!candidate)return
     const prefix=candidate.prefix??{logCut:candidate.snapshot.events.length-1,logSha256:sha(candidate.snapshot.events)}
     let admission:Admission|undefined
     const prepared=await ports.journal.prepare(c,ports.generation(),'automatic',async(db,checkpoint,record)=>{admission=await ports.authorize(db,checkpoint,record);return admission.lease},candidate.input,prefix)
     if(!admission)throw denied()
     const permit:Permit={...admission,record:prepared.record,snapshot:candidate.snapshot};permits.set(c.sessionId,permit);assert(permit)
     const now=await ports.snapshot(c.sessionId),id=permit.record.message?.id??c.roots[0]!.messageId,pending=nativeInputRecoveryCandidate({snapshot:now,inbox:ports.inbox(now)})
     if(permit.record.state==='accepted'&&!pending?.messages.some(message=>message.id===id))return
     await ports.execute(permit.run,permit.target,{...(c.review?{review:c.review}:{}),publish:async agent=>{
      assert(permit);signal.throwIfAborted()
      if(candidate.input==='pending'||pending?.messages.some(message=>message.id===id)){
       await accept(permit,await ports.snapshot(c.sessionId));await ports.nativeInput.wakePending(agent,signal)
      }else{
       if(permit.record.message===null)throw denied()
       await ports.nativeInput.withRunContinuation(agent,structuredClone(permit.record.message) as UserMessage,permit.record.id,signal)
      }
     }},signal)
    })()
    inFlight.set(c.sessionId,operation)
    try{await operation;failures.delete(c.sessionId)}catch(error){signal.throwIfAborted();report(c,error)}finally{if(inFlight.get(c.sessionId)===operation)inFlight.delete(c.sessionId)}
   }
  },
  admission(sessionId:string):WorkAccessLease|null{const permit=permits.get(sessionId);if(!permit)return null;assert(permit);return permit.lease},
  async continuation(agent:Agent,message:UserMessage,id:string){const permit=permits.get(String(agent.id));if(!permit||permit.record.id!==id||!isDeepStrictEqual(message,permit.record.message))throw denied();assert(permit);return {snapshot:permit.snapshot,roots:permit.record.checkpoint.roots,lease:permit.lease}},
  async restore(input:NativeInputRestoreInput):Promise<NativeInputRestoreLease>{
   const permit=permits.get(input.sessionId);if(!permit||!inFlight.has(input.sessionId))throw denied();assert(permit)
   const candidate=nativeInputRecoveryCandidate({snapshot:input.snapshot,inbox:ports.inbox(input.snapshot)})
   if(!candidate||!isDeepStrictEqual(candidate.messages,input.messages)||(permit.record.input==='pending'?!isDeepStrictEqual(candidate.roots,permit.record.checkpoint.roots):candidate.messages.length!==1||!isDeepStrictEqual(candidate.messages[0],permit.record.message)))throw denied()
   await accept(permit,input.snapshot)
   return Object.freeze({roots:Object.freeze(candidate.roots.map(root=>Object.freeze({...root}))),...(permit.record.input==='continuation'?{inheritedRoots:Object.freeze(permit.record.checkpoint.roots.map(root=>Object.freeze({...root})))}:{}),deferWake:true as const,assertCurrent:()=>{input.signal.throwIfAborted();assert(permit);return undefined}})
  },
  async checkpoint(input:NativeInputCheckpointInput){
   const permit=permits.get(String(input.agent.id));if(!permit)return
   const id=permit.record.message?.id??permit.record.checkpoint.roots[0]!.messageId
   if(!input.messages.some(message=>message.id===id))return
   assert(permit);input.assertCurrent();await accept(permit,input.snapshot);await ports.accepted(permit.record,input);input.assertCurrent();assert(permit)
  },
  close(){permits.clear();failures.clear()},
 }
}
