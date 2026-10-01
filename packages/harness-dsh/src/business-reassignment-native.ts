import {createHash} from 'node:crypto'
import type {Session,SessionEvent,SessionHeader} from '@deepseek-ai/dsh-session'
import {WorkError} from '@teloa/contract'
import {observeTaskRunTimeline} from './task-run-observation.ts'
import type {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import {SessionLogOffset} from '@deepseek-ai/dsh-session'
import {readSessionEvents} from './session-events.ts'
import {SessionId} from '@deepseek-ai/dsh-session'
import {JobId,type JobRegistry} from '@deepseek-ai/dsh-jobs'
import type {TaskRunRuntimeLink,TaskRunRuntimeLinks} from '@teloa/backend'
import type {Agent,Inbox} from '@deepseek-ai/dsh-agent'
type FixedRun={id:string;taskId:string;sessionId:string;nativeRequestId:string;state:string;stopRequestedAt:string|null;evidence:{state:string;turn?:number;messageSeq?:number;endSeq?:number;reason?:string}|null}
export type NativeAbortInspection={meta:Pick<SessionHeader,'id'>;inheritedEventCount:number;events:readonly SessionEvent[]}
const denied=()=>new WorkError('teloa/conflict','尚未取得固定请求的真实原生取消证据，请核对原生会话。')
export async function withNativeResourceInspection<T>(agent:Agent|undefined,ports:NativeInspectionPorts,run:FixedRunIdentity,links:TaskRunRuntimeLinks|undefined,runtimeId:string,jobs:Pick<JobRegistry,'list'|'get'>|undefined,signal:AbortSignal,work:(inspection:NativeAbortInspection,resources:NativeResourceFacts|undefined,signal:AbortSignal)=>Promise<T>):Promise<T>{
 signal.throwIfAborted()
 // rc.1 runMaintenance 不冻结输入。同步 pre-COMMIT 检查仍不能封闭 await COMMIT 期间的入队，
 // 因而 live 采集不能进入持久化回调；不事后撤销已可能被消费的 proof，也不丢弃晚到输入。
 if(agent)throw denied()
 const inspection=await readNativeReassignmentInspection(ports,run,signal)
 return work(inspection,undefined,signal)
}
export type NativeResourceFacts={source:'native-maintenance-jobs';owners:Array<{nativeId:string;runtimeId:string;observedRuntimeId:string;sessionId:string;requestId:string;logCut:number;inbox:{nextTurn:string[];nextStep:string[]};jobs:Array<{id:string;status:'completed'|'killed'|'failed';startedAt:number;finishedAt:number}>}>}
/** 仅在 true idle 的官方维护闭包内调用；当前世代和 exact owner 必须同时匹配。 */
export function collectNativeJobOwnerSettlement(run:FixedRunIdentity,inspection:NativeAbortInspection,links:readonly TaskRunRuntimeLink[],runtimeId:string,jobs:Pick<JobRegistry,'list'|'get'>,inbox:Pick<Inbox,'nextTurn'|'nextStep'>):NativeResourceFacts{
 if(inbox.nextTurn.length||inbox.nextStep.length)throw denied()
 const facts:NativeResourceFacts={source:'native-maintenance-jobs',owners:[]}
 const owners=links.filter(link=>link.kind==='job'&&link.payload.record==='owner')
 for(const link of links){
  if(link.kind!=='job'||link.payload.record!=='job')continue
  const requestId=link.payload.requestId,jobRuntime=link.payload.runtimeId
  if(owners.filter(owner=>owner.kind==='job'&&owner.payload.record==='owner'&&owner.sessionId===link.sessionId&&owner.payload.runtimeId===jobRuntime&&owner.payload.requestId===requestId).length!==1)throw denied()
 }
 if(owners.length===0&&jobs.list(SessionId(run.sessionId)).some(job=>job.owner===run.sessionId))throw denied()
 for(const owner of owners){
  if(owner.kind!=='job'||owner.payload.record!=='owner'||owner.runId!==run.id||owner.sessionId!==run.sessionId||owner.payload.requestId!==run.nativeRequestId||owner.payload.runtimeId!==runtimeId)throw denied()
  const persisted=links.filter(link=>link.kind==='job'&&link.payload.record==='job'&&link.sessionId===owner.sessionId&&link.payload.runtimeId===runtimeId)
  const current=jobs.list(SessionId(owner.sessionId)).filter(job=>job.owner===owner.sessionId)
  if(current.length!==persisted.length)throw denied()
  const terminal:NativeResourceFacts['owners'][number]['jobs']=[]
  for(const link of persisted){
   if(link.kind!=='job'||link.payload.record!=='job'||link.payload.requestId!==run.nativeRequestId)throw denied()
   const job=jobs.get(JobId(link.payload.jobId),SessionId(owner.sessionId))
   if(job.id!==link.payload.jobId||job.owner!==owner.sessionId||job.status!==link.payload.status||!['completed','killed','failed'].includes(job.status)||!Number.isSafeInteger(job.startedAt)||!Number.isSafeInteger(job.finishedAt)||job.finishedAt===undefined||job.finishedAt<job.startedAt||!current.some(item=>item.id===job.id&&item.status===job.status))throw denied()
   terminal.push({id:job.id,status:job.status as 'completed'|'killed'|'failed',startedAt:job.startedAt,finishedAt:job.finishedAt})
  }
  facts.owners.push({nativeId:owner.nativeId,runtimeId,observedRuntimeId:runtimeId,sessionId:owner.sessionId,requestId:run.nativeRequestId,logCut:inspection.events.length-1,inbox:{nextTurn:[],nextStep:[]},jobs:terminal})
 }
 return facts
}
/** 只复用宿主已注册官方 Team 投影；不恢复 Agent，不注册或复制未导出的定义。 */
export function inspectColdTeamSettlement(inspection:NativeAbortInspection&{meta:SessionHeader},registry:Pick<SessionProjectionRegistry,'restore'>|undefined){
 if(!registry)throw denied()
 const {snapshot}=registry.restore({},inspection.events,SessionLogOffset(0),inspection.meta,SessionLogOffset(inspection.inheritedEventCount))
 const team=snapshot.values.agentTeam
 if(!team||team.failure||team.tasks.some(task=>!['completed','deleted'].includes(task.status))||team.members.some(member=>member.role!=='lead'||member.phase!=='active'))throw denied()
 const pending=new Map<string,string>()
 for(const event of inspection.events){
  if(event.type==='team/message/queued'){const key=JSON.stringify([event.data.teamId,event.data.message.id]);if(pending.has(key))throw denied();pending.set(key,event.data.message.targetId)}
  if(event.type==='team/message/delivered'){const key=JSON.stringify([event.data.teamId,event.data.messageId]);if(pending.get(key)!==event.data.targetId)throw denied();pending.delete(key)}
 }
 if(pending.size)throw denied()
 return snapshot
}
type FixedRunIdentity=Pick<FixedRun,'id'|'taskId'|'sessionId'|'nativeRequestId'>
// 与 功能验证 冻结 tuple 结构一致；仅由已授权 readReassignmentRuns 的整体返回值传入。
export type NativeReassignmentRunTargets={oldRequestId:string;oldSessionId:string;scope:string;targets:Array<{roleId:string;taskRequestId:string;taskId:string|null;runs:FixedRunIdentity[]}>}
type NativeProof=ReturnType<typeof inspectNativeAbort>&{settlementHash:string}
type NativeInspectionPorts={get:(sessionId:string)=>Session|undefined;flush:(session:Session)=>Promise<boolean>;inspect:(sessionId:string)=>Promise<NativeAbortInspection>}
/** 只接收后端授权后的固定 Run；普通 events 仍保留原 session ready 校验。 */
export async function readNativeReassignmentInspection(ports:NativeInspectionPorts,run:FixedRunIdentity,signal:AbortSignal):Promise<NativeAbortInspection>{
 signal.throwIfAborted()
 const attached=ports.get(run.sessionId)
 let inspection:NativeAbortInspection
 if(attached){
  const events=[...readSessionEvents(attached)]
  if(!await ports.flush(attached))throw new WorkError('teloa/session-unavailable','原生日志尚未可靠落盘，不能取得取消证明。')
  inspection={meta:attached.header,inheritedEventCount:attached.inheritedEventCount,events}
 }else inspection=await ports.inspect(run.sessionId)
 signal.throwIfAborted()
 if(inspection.meta.id!==run.sessionId)throw denied()
 return inspection
}
export type NativeReassignmentPorts<Database,Run extends FixedRun=FixedRun>={
 withRunTransaction:<T>(owner:string,identity:FixedRunIdentity,work:(db:Database,run:Run)=>Promise<T>)=>Promise<T>
 readSettlement:(db:Database,owner:string,run:Run)=>Promise<string>
 hashSettlement:(snapshot:string)=>string
 readInspection:(run:FixedRunIdentity,signal:AbortSignal)=>Promise<NativeAbortInspection>
 withInspection?:<T>(run:FixedRunIdentity,signal:AbortSignal,work:(inspection:NativeAbortInspection,resources:NativeResourceFacts|undefined,signal:AbortSignal)=>Promise<T>)=>Promise<T>
 recordResources?:(db:Database,owner:string,run:Run,before:string,resources:NativeResourceFacts)=>Promise<void>
 recordProof:(db:Database,owner:string,run:Run,proof:NativeProof)=>Promise<void>
}
export class NativeReassignmentAttestor<Database,Run extends FixedRun=FixedRun>{
 readonly ports:NativeReassignmentPorts<Database,Run>
 constructor(ports:NativeReassignmentPorts<Database,Run>){this.ports=ports}
 async attestReassignmentRuns(owner:string,targets:NativeReassignmentRunTargets,signal:AbortSignal):Promise<void>{
  const seen=new Set<string>()
  for(const target of targets.targets)for(const identity of target.runs){
   signal.throwIfAborted()
   if(target.taskId!==identity.taskId||seen.has(identity.id))throw denied()
   seen.add(identity.id)
   const fixed=(run:FixedRun)=>{if(['id','taskId','sessionId','nativeRequestId'].some(key=>run[key as keyof FixedRun]!==identity[key as keyof FixedRunIdentity]))throw denied()}
   const before=await this.ports.withRunTransaction(owner,identity,async(db,run)=>{fixed(run);return {run,snapshot:await this.ports.readSettlement(db,owner,run)}})
   if(before.run.state==='withdrawn'||before.run.state==='configuration_failed')continue
   signal.throwIfAborted()
   const attest=async(inspection:NativeAbortInspection,resources:NativeResourceFacts|undefined,currentSignal:AbortSignal)=>{
    currentSignal.throwIfAborted()
    // 当前公开面没有原子输入冻结／数据库提交栅栏；collector 的事实尚不足以创建持久证明。
    if(resources!==undefined)throw denied()
    const eventProof=inspectNativeAbort(before.run,inspection)
    await this.ports.withRunTransaction(owner,identity,async(db,run)=>{
     currentSignal.throwIfAborted();fixed(run)
     if(await this.ports.readSettlement(db,owner,run)!==before.snapshot)throw denied()
     const settlement=await this.ports.readSettlement(db,owner,run)
     currentSignal.throwIfAborted();await this.ports.recordProof(db,owner,run,{...eventProof,settlementHash:this.ports.hashSettlement(settlement)})
     currentSignal.throwIfAborted()
    })
   }
   if(this.ports.withInspection)await this.ports.withInspection(identity,signal,attest)
   else await attest(await this.ports.readInspection(identity,signal),undefined,signal)
  }
 }
}
/** 仅从完整原生日志生成锚点。idle、停止回执及历史合成终态均不参与推断。 */
export function inspectNativeAbort(run:FixedRun,inspection:NativeAbortInspection){
 const {meta,inheritedEventCount,events}=inspection
 if(meta.id!==run.sessionId||!Number.isSafeInteger(inheritedEventCount)||inheritedEventCount<0||inheritedEventCount>events.length||run.state!=='ended'||!run.stopRequestedAt||run.evidence?.state!=='ended'||run.evidence.reason!=='aborted')throw denied()
 // Team 子级的持久结清尚未完成真实验证；即使关联登记丢失，也不能绕过未知边界。
 if(events.some(event=>event.seq>=inheritedEventCount&&event.type.startsWith('team/')))throw denied()
 const timeline=observeTaskRunTimeline(events,run.nativeRequestId),observation=timeline.observation
 if(observation.state!=='ended'||observation.reason!=='aborted'||observation.messageSeq<inheritedEventCount||observation.turn!==run.evidence.turn||observation.messageSeq!==run.evidence.messageSeq||observation.endSeq!==run.evidence.endSeq)throw denied()
 const end=events[observation.endSeq],message=events[observation.messageSeq]
 if(end?.type!=='turn/end'||end.data.turn!==timeline.turn||end.data.reason.kind!=='aborted'||!['user','parent','hook','disposed'].includes(end.data.reason.reason?.kind)||end.data.reason.reason.kind==='hook'&&!end.data.reason.reason.reason?.trim())throw denied()
 // 后续 foreign 轮/后台轮均不能被旧证明覆盖；同一 turn 内的外国本人消息也拒绝。
 if(events.some(event=>event.seq>observation.messageSeq&&event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user')||events.some(event=>event.seq>observation.endSeq&&(event.type==='turn/start'||event.type==='user/message')))throw denied()
 const initialStart=events.find(event=>event.type==='turn/start'&&event.data.turn===observation.turn&&event.seq<observation.messageSeq)
 if(!initialStart)throw denied()
 const eventHash=createHash('sha256').update(JSON.stringify({sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,inheritedEventCount,message,ownedEvents:events.slice(initialStart.seq,observation.endSeq+1),end})).digest('hex')
 return {runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,turn:observation.turn,ownedEndTurn:end.data.turn,messageSeq:observation.messageSeq,endSeq:observation.endSeq,logCut:events.length-1,inheritedEventCount,reason:'aborted' as const,source:'native-turn-end' as const,eventHash}
}
