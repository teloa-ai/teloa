import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {lstat,open,readdir,realpath} from 'node:fs/promises'
import {constants,openSync,closeSync,fstatSync,readFileSync} from 'node:fs'
import {basename,dirname} from 'node:path'
import {zstdDecompressSync} from 'node:zlib'
import {SessionId,SessionPreparation,interruptedTurnClosers,type SessionStore,type SessionEvent,type SessionHeader} from '@deepseek-ai/dsh-session'
import {Context,symbols} from '@deepseek-ai/cordis'
import type {SessionHandle,SessionPersistence} from '@deepseek-ai/dsh-session-persistence'
import {taskRunEvidenceProofEnd,type TaskRun,type AcceptedInboxFailureEvidence} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {acceptedInboxErrorEvidence,canSealAcceptedInboxInterruption} from './task-run-inbox-error.ts'
import {readSessionEvents} from './session-events.ts'

type Candidate={sessionId:string;header:SessionHeader;events:readonly SessionEvent[];inheritedEventCount:number;signal:AbortSignal}
type AtomicPersistence=SessionPersistence&{resolveCurrentLog:(id:SessionId,signal?:AbortSignal)=>Promise<string|undefined>;openWithAdmission:(id:SessionId,admit:(candidate:Candidate)=>Promise<Readonly<{assertCurrent:()=>void}>>,options:{signal:AbortSignal})=>Promise<SessionHandle>}
export type ColdInboxErrorProof={evidence:AcceptedInboxFailureEvidence;endedAt:string;physicalSha256:string;assertCurrent:()=>void}
type Recovery={sessions:Pick<SessionStore,'prepare'>;assertSafe:()=>Promise<void>}
const denied=()=>new WorkError('teloa/conflict','原受理会话尚未取得独立存储维护证明，请保留原记录后核对。')
/** 取得现存v4的正式内核writer租约；旧error只读；仅严格未发布前缀可复用官方恢复封口，不创建Agent、不执行格式迁移或torn-tail修复。 */
export async function withColdInboxErrorWriter<T>(persistence:SessionPersistence,run:TaskRun,signal:AbortSignal,assertAbsent:()=>void,work:(proof:ColdInboxErrorProof)=>Promise<T>,recovery?:Recovery):Promise<T>{
 // 固定Cordis版本适配：公开original符号解代理，再核protected ctx确属真实provider；不是SessionHandle API。
 const original=Reflect.get(persistence,symbols.original)??persistence,owner=Reflect.get(original,'ctx') as unknown
 if(!(owner instanceof Context)||typeof owner.effect!=='function'||typeof owner.fiber?.assertActive!=='function')throw denied()
 let finish!:()=>void
 const finished=new Promise<void>(done=>{finish=done}),lifetime=new AbortController()
 // 已发出的COMMIT不能被signal撤销；provider等待本次finally关writer，不能先释放锁。
 const release=owner.effect(()=>()=>{lifetime.abort(denied());return finished},'accepted inbox error writer maintenance')
 try{return await withOwnedWriter(persistence,run,AbortSignal.any([signal,lifetime.signal]),assertAbsent,work,recovery)}
 finally{finish();await release()}
}
async function withOwnedWriter<T>(persistence:SessionPersistence,run:TaskRun,signal:AbortSignal,assertAbsent:()=>void,work:(proof:ColdInboxErrorProof)=>Promise<T>,recovery?:Recovery):Promise<T>{
 const p=persistence as AtomicPersistence,id=SessionId(run.sessionId)
 if(typeof constants.O_NOFOLLOW!=='number'||typeof p.openWithAdmission!=='function'||typeof p.resolveCurrentLog!=='function')throw denied()
 const alive=()=>{signal.throwIfAborted();assertAbsent()}
 alive()
 const physical=async()=>{
  alive();const path=await p.resolveCurrentLog(id,signal);alive()
  if(!path||!/^session\.v4\.jsonl(?:\.zstd)?$/.test(basename(path))||await realpath(path)!==path)throw denied()
  const names=await readdir(dirname(path));alive()
  if(names.filter(n=>/^session\.v\d+\.jsonl(?:\.zstd)?$/.test(n)).length!==1)throw denied()
  const stat=await lstat(path);alive()
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0||stat.size>67_108_864)throw denied()
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  let bytes:Buffer
  try{
   const actual=await file.stat();alive()
   if(!actual.isFile()||actual.dev!==stat.dev||actual.ino!==stat.ino||actual.size!==stat.size||actual.mtimeMs!==stat.mtimeMs)throw denied()
   bytes=await file.readFile({signal});alive()
  }finally{await file.close()}
  const decoded=path.endsWith('.zstd')?zstdDecompressSync(bytes,{maxOutputLength:67_108_864}):bytes,text=new TextDecoder('utf-8',{fatal:true}).decode(decoded)
  if(!text.endsWith('\n'))throw denied()
  const records=text.slice(0,-1).split('\n').map(line=>JSON.parse(line)),head=records[0]
  if(!head||head.type!=='session'||head.version!==4||head.id!==run.sessionId)throw denied()
  const {type:_type,inheritedEventCount=0,...header}=head
  if(inheritedEventCount!==0||header.isSeeded||header.parentSession!==undefined||header.origin==='subagent'||(header.delegationDepth??0)!==0||!run.agentPresetId||header.agentPreset!==run.agentPresetId)throw denied()
  const assertCurrent=()=>{
   alive();const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)
   try{const now=fstatSync(fd);if(!now.isFile()||now.dev!==stat.dev||now.ino!==stat.ino||now.size!==stat.size||now.mtimeMs!==stat.mtimeMs||!bytes.equals(readFileSync(fd)))throw denied()}finally{closeSync(fd)}
  }
  assertCurrent();return {path,bytes,header,events:records.slice(1) as SessionEvent[],assertCurrent}
 }
 // 先拒历史物理格式；锁内admission再核一次，不能在竞争窗口中偷偷迁移。
 const before=await physical();let proof:ColdInboxErrorProof|undefined,repair=false
 const readProof=(events:readonly SessionEvent[],locked:Awaited<ReturnType<typeof physical>>)=>{
  const boundary=[...events].reverse().find(e=>e.type==='turn/start'||e.type==='turn/end')
  if(boundary?.type!=='turn/end')throw denied()
  const proofEnd=boundary.data.reason.kind==='interrupted'?boundary.seq+1:boundary.seq,evidence=acceptedInboxErrorEvidence(run,events.slice(0,proofEnd+1))
  if(!evidence||events.some((e,i)=>e.seq!==i)||events.slice(taskRunEvidenceProofEnd(evidence)+1).some(e=>e.type!=='session/end-seed'||Object.keys(e.data).length!==0))throw denied()
  return {evidence,endedAt:new Date(events[taskRunEvidenceProofEnd(evidence)]!.time).toISOString(),physicalSha256:createHash('sha256').update(locked.bytes).digest('hex'),assertCurrent:locked.assertCurrent}
 }
 const handle=await p.openWithAdmission(id,async candidate=>{
  alive();before.assertCurrent();const locked=await physical()
  if(locked.path!==before.path||!locked.bytes.equals(before.bytes)||candidate.sessionId!==run.sessionId||candidate.inheritedEventCount!==0||!isDeepStrictEqual(candidate.header,locked.header)||!isDeepStrictEqual(candidate.events,locked.events))throw denied()
  if(recovery&&run.state==='accepted'&&run.evidence?.state==='accepted'&&canSealAcceptedInboxInterruption(run,candidate.events,candidate.inheritedEventCount))repair=true
  else proof=readProof(candidate.events,locked)
  return Object.freeze({assertCurrent:locked.assertCurrent})
 },{signal})
 try{
  if(handle.access!=='write'||handle.id!==id)throw denied()
  before.assertCurrent();const observed=await handle.read(0,undefined,{signal});before.assertCurrent()
  if(!isDeepStrictEqual(observed.events,before.events))throw denied()
  if(repair){
   if(!recovery)throw denied()
   await recovery.assertSafe();alive();before.assertCurrent()
   const closers=interruptedTurnClosers(observed.events)
   if(closers.length!==1||closers[0]?.type!=='turn/end'||closers[0].data.reason.kind!=='interrupted')throw denied()
   // 与官方AgentLoopFactory.resumeWith完全相同的公开prepare路径；不enter/announce，不创建或运行Agent。
   const preparation=SessionPreparation.create(recovery.sessions.prepare(id,{seed:[...observed.events,...closers],meta:structuredClone(handle.header),inheritedEventCount:handle.inheritedEventCount,eventState:observed.eventState}))
   try{
    const full=readSessionEvents(preparation.session),suffix=full.slice(observed.events.length),seal=suffix[1]
    if(suffix.length!==2||!isDeepStrictEqual(suffix[0],closers[0])||seal?.type!=='session/end-seed'||Object.keys(seal.data).length!==0||!acceptedInboxErrorEvidence(run,full))throw denied()
    alive();before.assertCurrent();await handle.append(suffix);await handle.flush();alive()
    const locked=await physical(),after=await handle.read(0,undefined,{signal});locked.assertCurrent()
    if(!isDeepStrictEqual(after.events,full)||!isDeepStrictEqual(locked.events,full))throw denied()
    proof=readProof(after.events,locked)
   }finally{preparation[Symbol.dispose]()}
  }
  if(!proof)throw denied()
  proof.assertCurrent()
  return await work(proof)
 }finally{await handle.close()}
}
