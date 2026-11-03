import {taskRunHasPublicationEvidence} from './task-run-publication.ts'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {isAbsolute,join} from 'node:path'
import {readFile,readdir,lstat,realpath} from 'node:fs/promises'
import {zstdDecompressSync} from 'node:zlib'
import {Context} from '@deepseek-ai/cordis'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {Session,SessionId,SessionLogOffset} from '@deepseek-ai/dsh-session'
import type {SessionPersistence} from '@deepseek-ai/dsh-session-persistence'
import type {TaskRun,StoppedUnacceptedNativeProof} from '@teloa/backend'
import {WorkError,taskInput} from '@teloa/contract'

/** 已证明原宿主退出后使用。只读当前v4日志；输入/工具历史的存在不影响unknown，也不证明未发布。 */
export async function readStoppedSubmissionSnapshot(input:{dshHome:string;expectedCwd:string;run:Pick<TaskRun,'sessionId'|'agentPresetId'>&{nativeRequestId?:string};requireNotPublished?:true}){
 const denied=()=>new WorkError('teloa/conflict','原会话完整日志或归属无法核对，维护保持停止。')
 const {run}=input
 if(!/^[a-zA-Z0-9_-]{1,128}$/.test(run.sessionId)||!isAbsolute(input.dshHome)||!isAbsolute(input.expectedCwd)||!run.agentPresetId)throw denied()
 const root=await realpath(join(input.dshHome,'sessions')),paths:string[]=[]
 if((await lstat(root)).isSymbolicLink())throw denied()
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.isSymbolicLink())continue
  const directory=join(root,entry.name,run.sessionId)
  let names:string[]
  try{if(!(await lstat(directory)).isDirectory()||(await lstat(directory)).isSymbolicLink())throw denied();names=await readdir(directory)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error}
  for(const name of names)if(/^session\.v\d+\.jsonl(?:\.zstd)?$/.test(name))paths.push(join(directory,name))
 }
 if(paths.length!==1||!/[\\/]session\.v4\.jsonl(?:\.zstd)?$/.test(paths[0]!))throw denied()
 const path=paths[0]!,before=await lstat(path)
 if(!before.isFile()||before.isSymbolicLink()||before.size===0||before.size>67108864||await realpath(path)!==path)throw denied()
 const bytes=await readFile(path),decoded=path.endsWith('.zstd')?zstdDecompressSync(bytes,{maxOutputLength:67108864}):bytes
 const text=new TextDecoder('utf-8',{fatal:true}).decode(decoded)
 if(!text.endsWith('\n'))throw denied()
 const records=text.slice(0,-1).split('\n').map(line=>JSON.parse(line)),header=records[0]
 if(!header||header.type!=='session'||header.version!==4||header.id!==run.sessionId||header.cwd!==input.expectedCwd||header.agentPreset!==run.agentPresetId)throw denied()
 const ctx=new Context()
 try{
  await ctx.plugin(JsonlSessionPersistence,{root,compression:path.endsWith('.zstd')?'zstd':'none'})
  const persistence=ctx.sessionPersistence,id=SessionId(run.sessionId),resolver=Reflect.get(persistence,'resolveCurrentLog')
  if(typeof resolver!=='function'||await resolver.call(persistence,id)!==path)throw denied()
  const handle=await persistence.open(id,'read')
  try{
   const {events}=await handle.read(0),meta=handle.header
   if(handle.id!==id||handle.access!=='read'||meta.id!==run.sessionId||meta.cwd!==input.expectedCwd||meta.agentPreset!==run.agentPresetId)throw denied()
   if(input.requireNotPublished){
    if(!run.nativeRequestId)throw denied()
    if(taskRunHasPublicationEvidence(events,run.nativeRequestId))throw denied()
   }
   const after=await lstat(path)
   if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||!bytes.equals(await readFile(path))||await resolver.call(persistence,id)!==path)throw denied()
   return {path,device:after.dev,inode:after.ino,size:after.size,fileSha256:createHash('sha256').update(bytes).digest('hex'),logCut:events.length-1,logSha256:createHash('sha256').update(JSON.stringify(events)).digest('hex'),...(input.requireNotPublished?{notPublished:true as const}:{})}
  }finally{await handle.close()}
 }finally{await ctx.fiber.dispose()}
}

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
