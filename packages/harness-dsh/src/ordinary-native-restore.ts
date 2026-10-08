import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {Session,SessionId,SessionLogOffset} from '@deepseek-ai/dsh-session'
import {WorkError} from '@teloa/contract'
import {workAccess,type WorkAccess,type ConversationService,type TaskRunService} from '@teloa/backend'
import {nativeInputRecoveryCandidate,type NativeInputRecoveryCandidate} from './native-input-recovery-candidate.ts'
import type {NativeCheckpointSnapshot,NativeInputRestoreInput,NativeInputRestoreLease} from './native-input-checkpoint.ts'

type Ports={owner:string;conversations:Pick<ConversationService,'repository'>;pool:Pick<TaskRunService['pool'],'query'>;snapshot:(sessionId:string)=>Promise<NativeCheckpointSnapshot>;isRoutingSession:(id:string)=>boolean;assertCurrent:()=>void;provenanceGeneration:(sessionId:string)=>number;access?:Pick<WorkAccess,'readSessionCapabilities'|'authorizeSessionCapabilities'>}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(Reflect.get(value,key))])):value
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const denied=()=>new WorkError('teloa/forbidden','普通会话恢复需要本人已领养的原会话与完整用户待办；受管工作须使用恢复票据。')

/** 普通本人会话不伪造 Run 票据；只恢复原始 user 根，角色、派工、Goal 与子工作不会走此分支。 */
export function createOrdinaryNativeRestoreAuthorization(ctx:Pick<Context,'sessionProjections'>,ports:Ports){
 const access=ports.access??workAccess
 return async(input:NativeInputRestoreInput,candidate:NativeInputRecoveryCandidate):Promise<NativeInputRestoreLease>=>{
  input.signal.throwIfAborted();ports.assertCurrent()
  const fingerprint=hash([input.sessionId,input.snapshot,input.messages]),header=input.snapshot.header,generation=ports.provenanceGeneration(input.sessionId)
  if(!Number.isSafeInteger(generation)||generation<0)throw denied()
  if(!ports.owner||header.id!==input.sessionId||header.origin!==undefined||header.parentSession!==undefined||header.isSeeded||header.delegationDepth!==0||input.snapshot.inheritedEventCount!==0||ports.isRoutingSession(input.sessionId))throw denied()
  const inbox=ctx.sessionProjections.stateOf(Session.create(SessionId(input.sessionId),input.snapshot.events,header,SessionLogOffset(0)),'inbox'),actual=nativeInputRecoveryCandidate({snapshot:input.snapshot,inbox})
  if(!actual||hash(actual)!==hash(candidate)||hash(actual.messages)!==hash(input.messages)||!actual.messages.length)throw denied()
  if(actual.messages.some(message=>message.source.kind!=='user'||Object.keys(message.source).some(key=>!['kind','rpcId'].includes(key))))throw denied()
  if(input.snapshot.events.some(event=>event.type.startsWith('team/')||event.type.startsWith('goal/')||event.type.startsWith('subagent/')))throw denied()
  const inspect=async()=>{
   const matches=(await ports.conversations.repository.read()).filter(row=>row.sessionId===input.sessionId)
   if(matches.length!==1)throw denied()
   const row=matches[0]!
   if(row.ownerId!==ports.owner||row.status!=='ready'||row.purpose!==undefined||row.run!==undefined||row.requestedRoleId!==undefined||row.scopeIds.length!==1||row.scopeIds[0]!=='general')throw denied()
   // 不限 owner：其他主体的绑定同样阻止把该原生身份降级为普通会话；已结束/已解除记录也不抹掉来源。
   const associated=await ports.pool.query(`select 1 from teloa_task_runs where session_id=$1
    union all select 1 from teloa_task_run_subagents where child_session_id=$1
    union all select 1 from teloa_task_run_runtime_links where session_id=$1
    union all select 1 from teloa_task_run_goals where binding->>'sessionId'=$1
    union all select 1 from teloa_object_conversations where session_id=$1
    union all select 1 from teloa_conversation_work_requests where session_id=$1
    union all select 1 from teloa_conversation_work_contexts where session_id=$1 and (role_id is not null or scope_id<>'general') limit 1`,[input.sessionId])
   if(associated.rows.length)throw denied()
   return hash(row)
  }
  const binding=await inspect(),persisted=await ports.snapshot(input.sessionId)
  if(hash(persisted)!==hash(input.snapshot))throw denied()
  const capabilities=await access.readSessionCapabilities(ports.owner,input.sessionId)
  if(capabilities.status!=='ready'||capabilities.requiredCapabilities?.length!==1||capabilities.requiredCapabilities[0]!=='general-agent')throw denied()
  const lease=await access.authorizeSessionCapabilities(input.sessionId,'restore')
  if(await inspect()!==binding||hash(await ports.snapshot(input.sessionId))!==hash(input.snapshot))throw denied()
  const current=()=>{input.signal.throwIfAborted();ports.assertCurrent();if(ports.provenanceGeneration(input.sessionId)!==generation||hash([input.sessionId,input.snapshot,input.messages])!==fingerprint||ports.isRoutingSession(input.sessionId))throw denied();lease.assertCurrent();return undefined}
  current()
  return Object.freeze({roots:Object.freeze(actual.roots.map(root=>Object.freeze({...root}))),assertCurrent:current})
 }
}
