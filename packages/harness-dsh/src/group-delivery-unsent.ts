import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {isAbsolute} from 'node:path'
import {lstat,readFile,realpath} from 'node:fs/promises'
import {zstdDecompressSync} from 'node:zlib'
import {SessionId,type SessionStore,type SessionHeader} from '@deepseek-ai/dsh-session'
import type {SessionPersistence} from '@deepseek-ai/dsh-session-persistence'
import type {PermissionPresetService} from '@deepseek-ai/dsh-permission-presets'
import type {ConversationService,GroupDeliveryRecoveryHost} from '@teloa/backend'
import {WorkError,type Conversation} from '@teloa/contract'
import {readSessionEvents} from './session-events.ts'

const denied=()=>new WorkError('teloa/conflict','原会话已有工作事件或配置变化，不能重新准备或发送。')
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex')
// 官方Header契约中缺省depth为0；JSONL读口补0，而同一live header可省略，仅此字段作等价规范化。
const headerValue=(value:SessionHeader)=>({...value,delegationDepth:value.delegationDepth??0})
type CurrentLogPersistence=Pick<SessionPersistence,'open'>&{resolveCurrentLog:(id:SessionId,signal?:AbortSignal)=>Promise<string|undefined>}
const hasCurrentLog=(value:Pick<SessionPersistence,'open'>):value is CurrentLogPersistence=>typeof Reflect.get(value,'resolveCurrentLog')==='function'
export type GroupDeliveryUnsentOptions={
 owner:string
 conversations:Pick<ConversationService,'runReservation'>
 agents:Pick<import('@deepseek-ai/dsh-agent').AgentRegistry,'get'>
 sessions:Pick<SessionStore,'get'>
 persistence:Pick<SessionPersistence,'open'>
 permissions:Pick<PermissionPresetService,'defaultPreset'|'resolve'>
 expectedCwd:(reservation:Conversation)=>string
}

/** 只读原预约与完整原生日志；正常构造事实不等于工作受理，也不授予执行能力。 */
export function createGroupDeliveryUnsentProof(options:GroupDeliveryUnsentOptions):GroupDeliveryRecoveryHost['assertUnsent']{
 return async(input,signal)=>{
  signal?.throwIfAborted()
  if(input.ownerId!==options.owner)throw new WorkError('teloa/forbidden','原执行不属于当前本人。')
  const reserved=await options.conversations.runReservation(options.owner,{requestId:input.requestId}),sessionId='task-run-'+input.requestId,id=SessionId(sessionId)
  if(!reserved||reserved.ownerId!==options.owner||reserved.requestId!==input.requestId||reserved.purpose!=='task-run'||reserved.status!=='ready'||reserved.sessionId!==sessionId||reserved.requestedSessionId!==sessionId||reserved.run?.taskId!==input.taskId||reserved.run.roleId!==input.roleId||reserved.run.roleVersion!==input.roleVersion||!Number.isSafeInteger(reserved.run.taskVersion)||reserved.run.taskVersion<1||reserved.run.executor!==undefined)throw new WorkError('teloa/conflict','无法核对原运行专用会话，不能推定尚未提交。')
  const cwd=options.expectedCwd(reserved)
  if(!isAbsolute(cwd)||!hasCurrentLog(options.persistence))throw denied()
  const bootstrap=()=>{const preset=options.permissions.defaultPreset,spec=options.permissions.resolve(preset);if(!preset||['auto','custom'].includes(preset)||!['read-only','workspace-write','danger-full-access'].includes(spec.sandbox)||!['ask','never'].includes(spec.approval))throw denied();return {preset,sandbox:spec.sandbox,approval:spec.approval}}
  const expected=bootstrap(),path=await options.persistence.resolveCurrentLog(id,signal)
  if(!path||!isAbsolute(path)||!/\/session\.v4\.jsonl(?:\.zstd)?$/.test(path)||await realpath(path)!==path)throw denied()
  const before=await lstat(path)
  if(!before.isFile()||before.isSymbolicLink()||before.size===0||before.size>1_048_576)throw denied()
  const bytes=await readFile(path,{signal}),decoded=path.endsWith('.zstd')?zstdDecompressSync(bytes,{maxOutputLength:1_048_576}):bytes,text=new TextDecoder('utf-8',{fatal:true}).decode(decoded)
  if(!text.endsWith('\n'))throw denied()
  const records:unknown[]=text.slice(0,-1).split('\n').map(line=>JSON.parse(line))
  const handle=await options.persistence.open(id,'read',{...(signal?{signal}:{})})
  try{
   const header=handle.header,{events}=await handle.read(0,undefined,{...(signal?{signal}:{})})
   if(handle.id!==id||handle.access!=='read'||header.id!==id||header.version!==4||header.cwd!==cwd||header.agentPreset!==reserved.run.agentPresetId||header.isSeeded||header.parentSession!==undefined||header.origin!==undefined||(header.delegationDepth??0)!==0||Number(handle.inheritedEventCount)!==0)throw denied()
   const raw=records[0]
   if(!raw||typeof raw!=='object'||Array.isArray(raw))throw denied()
   const {type,inheritedEventCount=0,...physicalHeader}=raw as Record<string,unknown>
   if(type!=='session'||inheritedEventCount!==0||!isDeepStrictEqual(headerValue(physicalHeader as unknown as SessionHeader),headerValue(header))||!isDeepStrictEqual(records.slice(1),events))throw denied()
   // 固定SDK的pinInitialPermission只对真正新建的会话按这个顺序追加三个完整事实。
   // 必须与实际公开defaultPreset/resolve组合完全一致；不按事件名泛放配置变更或seed。
   const initial=[['permission/preset',{preset:expected.preset}],['sandbox/mode',{mode:expected.sandbox}],['approval/policy',{policy:expected.approval}]] as const
   if(events.length!==initial.length||events.some((event,index)=>Object.keys(event).sort().join(',')!=='data,seq,time,type'||event.seq!==index||event.type!==initial[index]![0]||!isDeepStrictEqual(event.data,initial[index]![1])||!Number.isSafeInteger(event.time)||event.time<0))throw denied()
   const verifyLive=()=>{
    const agent=options.agents.get(id),session=options.sessions.get(id)
    if(agent&&(agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length||agent.session!==session))throw denied()
    if(session&&(!isDeepStrictEqual(headerValue(session.header),headerValue(header))||Number(session.inheritedEventCount)!==0||!isDeepStrictEqual(readSessionEvents(session),events)))throw denied()
    return agent
   }
   const live=verifyLive(),after=await lstat(path)
   if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||!bytes.equals(await readFile(path,{signal}))||await options.persistence.resolveCurrentLog(id,signal)!==path||!isDeepStrictEqual(await options.conversations.runReservation(options.owner,{requestId:input.requestId}),reserved)||!isDeepStrictEqual(bootstrap(),expected))throw denied()
   if(verifyLive()!==live)throw denied()
   signal?.throwIfAborted()
   return {sessionId,sha256:sha(JSON.stringify({input,reservation:reserved,header,events,bootstrap:expected,physicalLogSha256:sha(bytes)})),unsent:true as const}
  }finally{await handle.close()}
 }
}
