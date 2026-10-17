import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {isAbsolute} from 'node:path'
import {Session,SessionId,SessionLogOffset} from '@deepseek-ai/dsh-session'
import type {SessionPersistence} from '@deepseek-ai/dsh-session-persistence'
import type {TaskRun,StoppedUnacceptedNativeProof} from '@teloa/backend'
import {WorkError,taskInput} from '@teloa/contract'

const denied=()=>new WorkError('teloa/conflict','原生会话已有受理、活动或未知记录，不能撤回未准入提交。')
export type StoppedTaskRunInspectionOptions={persistence:Pick<SessionPersistence,'open'>&{resolveCurrentLog:(id:SessionId,signal?:AbortSignal)=>Promise<string|undefined>};expectedCwd:string;readCompleteLog:(path:string,signal:AbortSignal)=>Promise<Uint8Array>}
/** 仅官方持久读口和完整物理文件解码器；不启动 Controller、AgentRegistry、Loop 或 HTTP。 */
export function createStoppedUnacceptedTaskRunInspector(options:StoppedTaskRunInspectionOptions){
 if(!options||typeof options.expectedCwd!=='string'||!isAbsolute(options.expectedCwd)||typeof options.readCompleteLog!=='function'||typeof options.persistence?.open!=='function'||typeof options.persistence.resolveCurrentLog!=='function')throw new WorkError('teloa/invalid-input','停止恢复的只读存储装配不完整。')
 return async(run:Readonly<TaskRun>,signal:AbortSignal):Promise<StoppedUnacceptedNativeProof>=>{
  signal.throwIfAborted()
  if(!run.stopRequestedAt||!['submitting','withdrawn'].includes(run.state)||run.evidence!==null||!run.agentPresetId)throw denied()
  const id=SessionId(run.sessionId),path=await options.persistence.resolveCurrentLog(id,signal)
  if(!path)throw denied() // 不迁移历史格式、不生成新日志。
  const bytes=await options.readCompleteLog(path,signal)
  if(!(bytes instanceof Uint8Array)||bytes.byteLength===0||bytes.byteLength>1_048_576)throw denied()
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)
  if(!text.endsWith('\n'))throw denied() // 官方普通 read 可忽略 torn tail；撤回不能如此推断。
  const records:unknown[]=text.slice(0,-1).split('\n').map(line=>JSON.parse(line))
  const handle=await options.persistence.open(id,'read',{signal})
  try{
   const meta=handle.header,{events}=await handle.read(0,undefined,{signal}),inherited=Number(handle.inheritedEventCount)
   if(handle.id!==id||handle.access!=='read'||meta.version!==4||meta.id!==run.sessionId||meta.cwd!==options.expectedCwd||meta.agentPreset!==run.agentPresetId||meta.parentSession!==undefined||meta.origin==='subagent'||meta.isSeeded||(meta.delegationDepth??0)!==0||inherited!==0||events.length>16)throw denied()
   const header=records[0]
   if(!header||typeof header!=='object'||Array.isArray(header))throw denied()
   const {type,inheritedEventCount=0,...physicalMeta}=header as Record<string,unknown>
   if(type!=='session'||inheritedEventCount!==0||!isDeepStrictEqual(physicalMeta,meta)||!isDeepStrictEqual(records.slice(1),events))throw denied()
   const initialization=new Set<string>(['permission/preset','sandbox/mode','approval/policy'])
   if(events.some((event,index)=>event.seq!==index||!initialization.has(event.type)))throw denied()
   for(const event of events){
    const key=event.type==='permission/preset'?'preset':event.type==='sandbox/mode'?'mode':'policy',data=taskInput(event.data,[key])
    if(Object.keys(data).length!==1)throw denied()
    if(key==='preset'&&(data.preset!==null&&(typeof data.preset!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(data.preset))))throw denied()
    if(key==='mode'&&!['read-only','workspace-write','danger-full-access'].includes(String(data.mode)))throw denied()
    if(key==='policy'&&!['ask','never'].includes(String(data.policy)))throw denied()
   }
   // 官方 Session codec 验证完整自有事件；无任何 Inbox 命令意味着官方初始空队列未改变。
   Session.create(id,events,meta,SessionLogOffset(0))
   signal.throwIfAborted();if(await options.persistence.resolveCurrentLog(id,signal)!==path)throw denied()
   return {schema:'teloa.stopped-unaccepted-native/v1',mode:'official-session-initial-inbox-no-commands',runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,agentPresetId:run.agentPresetId,logCut:events.length-1,logSha256:createHash('sha256').update(bytes).digest('hex')}
  }finally{await handle.close()}
 }
}
