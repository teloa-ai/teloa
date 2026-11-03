import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {readFile,readdir,lstat,realpath} from 'node:fs/promises'
import {join,relative} from 'node:path'
import {zstdDecompressSync} from 'node:zlib'
import {Context} from '@deepseek-ai/cordis'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {Session,SessionId,SessionLogOffset} from '@deepseek-ai/dsh-session'
import {foldGoal} from '@deepseek-ai/dsh-goal'
import {WorkError} from '@teloa/contract'
import {readSessionEvents} from './session-events.ts'
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex')
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value
const denied=()=>new WorkError('teloa/conflict','完整原生记录仍有待办、未结清活动或身份不明，维护保持停止。')
async function officialRead(root:string,path:string,sessionId:string){
 const ctx=new Context()
 try{
  await ctx.plugin(JsonlSessionPersistence,{root,compression:path.endsWith('.zstd')?'zstd':'none'})
  const store=ctx.sessionPersistence,id=SessionId(sessionId),resolver=Reflect.get(store,'resolveCurrentLog')
  if(typeof resolver!=='function'||await resolver.call(store,id)!==path)throw denied()
  const handle=await store.open(id,'read')
  try{const {events}=await handle.read(0);return {meta:handle.header,events,inherited:Number(handle.inheritedEventCount)}}finally{await handle.close()}
 }finally{await ctx.fiber.dispose()}
}
/** 仅认证宿主退出后使用；复用官方 Session codec，不创建 Agent、Loop 或模型服务。 */
export async function inspectPreparedMaintenanceNative(input:{dshHome:string;expectedCwd:string;sessionId:string;agentPresetId:string}){
 const root=await realpath(join(input.dshHome,'sessions')),files:{path:string;sha256:string;bytes:number}[]=[],seen=new Set<string>();let original:{snapshotSha256:string;fileSha256:string}|undefined
 // 固定默认 storage-json 的 host Schedule 独立于 Session 活动；空闲不能代替它的持久准入。
 const schedulePath=join(input.dshHome,'storages/schedule.json');let scheduleSha256:string|null=null
 try{const info=await lstat(schedulePath);if(!info.isFile()||info.isSymbolicLink())throw denied();const bytes=await readFile(schedulePath),value=JSON.parse(bytes.toString()) as {unit?:{name?:unknown;version?:unknown};tables?:{tasks?:Record<string,{status?:unknown}>};global?:unknown};if(value.unit?.name!=='schedule'||value.unit.version!==1||value.global!==null||!value.tables||Object.keys(value.tables).some(key=>key!=='tasks')||!value.tables.tasks||typeof value.tables.tasks!=='object'||Array.isArray(value.tables.tasks)||Object.values(value.tables.tasks).some(task=>task?.status!=='inactive'))throw denied();scheduleSha256=hash(bytes)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 async function walk(directory:string):Promise<void>{
  for(const entry of(await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const path=join(directory,entry.name);if(entry.isSymbolicLink())throw denied();if(entry.isDirectory()){await walk(path);continue}if(!entry.isFile()||await realpath(path)!==path)throw denied()
   if(!/^session\.v4\.jsonl(?:\.zstd)?$/.test(entry.name)){if(entry.name!=='session.lock')throw denied();continue}
   const before=await lstat(path),bytes=await readFile(path);if(bytes.length===0||bytes.length>67_108_864)throw denied()
   const decoded=entry.name.endsWith('.zstd')?zstdDecompressSync(bytes,{maxOutputLength:67_108_864}):bytes,text=new TextDecoder('utf-8',{fatal:true}).decode(decoded);if(!text.endsWith('\n'))throw denied()
   const records:unknown[]=text.slice(0,-1).split('\n').map(line=>JSON.parse(line)),header=records.shift();if(!header||typeof header!=='object'||Array.isArray(header))throw denied()
   const {type,inheritedEventCount=0,...physicalMeta}=header as Record<string,unknown>
   if(type!=='session'||physicalMeta.version!==4||typeof physicalMeta.id!=='string'||physicalMeta.cwd!==input.expectedCwd||seen.has(physicalMeta.id)||!Number.isSafeInteger(inheritedEventCount)||Number(inheritedEventCount)<0)throw denied();seen.add(physicalMeta.id)
   // v4 文件将 sourceEventSeqs 压缩为范围；须由正式 persistence codec 解码，不把物理行直接当 SessionEvent。
   const {meta,events,inherited}=await officialRead(root,path,physicalMeta.id)
   if(!isDeepStrictEqual(meta,physicalMeta)||inherited!==inheritedEventCount||events.length!==records.length)throw denied()
   const session=Session.create(SessionId(meta.id),events,meta,SessionLogOffset(inherited))
   const restored=readSessionEvents(session)
   // 官方 codec 可在内存补 end-seed；它不属于冷文件证明，也不参与原检查点摘要。
   if(restored.length<events.length||events.some((event,index)=>!isDeepStrictEqual(restored[index],event))||restored.slice(events.length).some(event=>event.type!=='session/end-seed'||Object.keys(event.data).length!==0))throw denied()
   const inbox:Record<string,unknown[]>={'next-turn':[],'next-step':[]},tools=new Set<string>(),jobs=new Set<string>(),commands=new Set<string>();let running=false
   for(const event of events){
    if(event.type==='agent/inbox/spliced'){const q=inbox[event.data.target],removed=event.data.removedCount??0;if(!q||!Number.isSafeInteger(event.data.start)||event.data.start<0||event.data.start>q.length||!Number.isSafeInteger(removed)||removed<0||event.data.start+removed>q.length)throw denied();q.splice(event.data.start,removed,...event.data.inserted);const ids=new Set<string>();for(const message of Object.values(inbox).flat()){if(!message||typeof message!=='object'||!('id'in message)||typeof message.id!=='string'||ids.has(message.id))throw denied();ids.add(message.id)}}
    if(event.type==='turn/start'){if(running)throw denied();running=true}if(event.type==='turn/end'){if(!running)throw denied();running=false}
    if(event.type==='tool/call'){if(tools.has(event.data.callId))throw denied();tools.add(event.data.callId)}if(event.type==='tool/result'){if(!tools.delete(event.data.message.toolCallId))throw denied()}
    if(event.type==='job/registered'){if(event.data.owner!==meta.id||jobs.has(event.data.jobId))throw denied();jobs.add(event.data.jobId)}if(event.type==='job/settled'){if(event.data.owner!==meta.id||!jobs.delete(event.data.jobId))throw denied()}
    // command 事件由固定 SDK 的另一模块声明；冷边界逐项核形状，不伪造全局类型扩展。
    const kind:string=event.type
    if(kind==='command/run'||kind==='command/done'){const data:unknown=event.data;if(!data||typeof data!=='object'||!('commandId'in data)||typeof data.commandId!=='string'||!data.commandId)throw denied();if(kind==='command/run'){if(commands.has(data.commandId))throw denied();commands.add(data.commandId)}else if(!commands.delete(data.commandId))throw denied()}
   }
   const goal=foldGoal(events).goal
   if(running||tools.size||jobs.size||commands.size||goal&&goal.phase!=='complete'||Object.values(inbox).some(queue=>queue.length))throw denied()
   if(meta.id===input.sessionId){
    if(meta.agentPreset!==input.agentPresetId||Number(inheritedEventCount)!==0||meta.parentSession!==undefined||meta.isSeeded===true||events.some(event=>!['permission/preset','sandbox/mode','approval/policy','model/selection','session/end-seed'].includes(event.type)))throw denied()
    original={snapshotSha256:hash(JSON.stringify(canonical({header:meta,events,inheritedEventCount:0}))),fileSha256:hash(bytes)}
   }
   const after=await lstat(path);for(const key of ['ino','dev','size','mtimeMs'] as const)if(before[key]!==after[key])throw denied();if(!bytes.equals(await readFile(path)))throw denied()
   files.push({path:relative(root,path),sha256:hash(bytes),bytes:bytes.length})
  }
 }
 await walk(root);if(!original)throw denied();return {schema:'teloa.prepared-maintenance-native/v1' as const,original,files,sessions:seen.size,scheduleSha256,allInboxesEmpty:true as const,noOpenTurnOrTool:true as const}
}
