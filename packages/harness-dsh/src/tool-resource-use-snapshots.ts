import {constants} from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import {link,lstat,mkdir,open,opendir,unlink} from 'node:fs/promises'
import {basename,dirname,isAbsolute,join,resolve} from 'node:path'
import type {ToolResourceUseSnapshot} from '@teloa/contract'

type Directory={path:string;dev:number;ino:number}
const MAX_SNAPSHOT_BYTES=64*1024,MAX_READ_BYTES=8*1024*1024,MAX_SNAPSHOTS=2048,MAX_SESSIONS=256
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const missing=(error:unknown)=>object(error)&&error.code==='ENOENT'
const invalid=()=>Object.assign(Error('工具来源快照输入无效（invalid）。'),{code:'teloa/invalid-input'})
const corrupt=()=>Object.assign(Error('工具来源快照目录或文件不可信（corrupt/symlink）。'),{code:'teloa/storage-corrupt'})
const limited=()=>Object.assign(Error('工具来源快照过大或读取超出限制（limit）。'),{code:'teloa/resource-limit'})
const sessionId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)
const text=(value:unknown,max=2048):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!value.includes('\0')
function keys(value:Record<string,unknown>,allowed:readonly string[]):void{if(Object.keys(value).some(key=>!allowed.includes(key)))throw invalid()}
function checked(value:unknown):ToolResourceUseSnapshot{
 if(!object(value))throw invalid()
 keys(value,['schema','sessionId','parentCallSeq','startSeq','parentCallId','use'])
 if(value.schema!=='teloa.resource-use-snapshot/v1'||!sessionId(value.sessionId)||!Number.isSafeInteger(value.parentCallSeq)||!Number.isSafeInteger(value.startSeq)||(value.parentCallSeq as number)<0||(value.startSeq as number)<=(value.parentCallSeq as number)||!text(value.parentCallId)||!object(value.use))throw invalid()
 const use=value.use
 keys(use,['schema','kind','providerId','name','toolName','rawToolName','state','callId','rootCallId','queries','sources','truncated','answer'])
 if(use.schema!=='teloa.resource-use/v1'||!['mcp','plugin','skill','web'].includes(String(use.kind))||!text(use.providerId)||!text(use.name)||!text(use.toolName)||!text(use.callId)||use.rootCallId!==value.parentCallId||(use.rawToolName!==undefined&&!text(use.rawToolName))||(use.kind==='skill'?!['read','injected'].includes(String(use.state)):use.state!=='used'))throw invalid()
 if(use.kind!=='web'&&['queries','sources','truncated','answer'].some(key=>use[key]!==undefined))throw invalid()
 if(use.queries!==undefined&&(!Array.isArray(use.queries)||use.queries.length>64||!use.queries.every(query=>text(query,8192))))throw invalid()
 if(use.sources!==undefined&&(!Array.isArray(use.sources)||use.sources.length>128))throw invalid()
 const sources=use.sources===undefined?undefined:(use.sources as unknown[]).map(source=>{
  if(!object(source))throw invalid()
  keys(source,['url','title','snippet','publishedAt'])
  if(!text(source.url,8192)||['title','snippet','publishedAt'].some(key=>source[key]!==undefined&&(typeof source[key]!=='string'||(source[key] as string).length>32768||(source[key] as string).includes('\0'))))throw invalid()
  return {url:source.url,...(source.title===undefined?{}:{title:source.title as string}),...(source.snippet===undefined?{}:{snippet:source.snippet as string}),...(source.publishedAt===undefined?{}:{publishedAt:source.publishedAt as string})}
 })
 if((use.truncated!==undefined&&typeof use.truncated!=='boolean')||(use.answer!==undefined&&(typeof use.answer!=='string'||use.answer.length>MAX_SNAPSHOT_BYTES||use.answer.includes('\0'))))throw invalid()
 // 逐字段复制，不调用输入对象的toJSON，也不持久化任意工具args或未声明字段。
 return {schema:'teloa.resource-use-snapshot/v1',sessionId:value.sessionId,parentCallSeq:value.parentCallSeq as number,startSeq:value.startSeq as number,parentCallId:value.parentCallId,use:{schema:'teloa.resource-use/v1',kind:use.kind as ToolResourceUseSnapshot['use']['kind'],providerId:use.providerId,name:use.name,toolName:use.toolName,state:use.state as ToolResourceUseSnapshot['use']['state'],callId:use.callId,rootCallId:value.parentCallId,...(use.rawToolName===undefined?{}:{rawToolName:use.rawToolName as string}),...(use.queries===undefined?{}:{queries:[...use.queries as string[]]}),...(sources===undefined?{}:{sources}),...(use.truncated===undefined?{}:{truncated:use.truncated as boolean}),...(use.answer===undefined?{}:{answer:use.answer as string})}}
}
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 if(object(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}'
 return JSON.stringify(value)
}
const identity=(row:ToolResourceUseSnapshot)=>createHash('sha256').update(JSON.stringify([row.sessionId,row.parentCallSeq,row.startSeq,row.use.callId])).digest('hex')

/** 副本继承的子会话目录不授予访问；仅取本会话持久化历史中的直系关系。 */
export function resourceUseSnapshotSessionScope(parent:string,events:readonly unknown[]):readonly string[]{
 let ownStart=0
 for(let index=0;index<events.length;index++){
  const event=events[index]
  if(object(event)&&event.type==='session/end-seed'&&object(event.data)&&event.data.inherited===true)ownStart=index+1
 }
 const children=events.slice(ownStart).flatMap(event=>object(event)&&event.type==='subagent/catalog'&&object(event.data)&&sessionId(event.data.childId)?[event.data.childId]:[])
 return [parent,...new Set(children)]
}

/** 每层只接受普通目录；保留inode以核对随后读写仍处于同一目录。 */
async function directory(path:string,create:boolean):Promise<Directory[]>{
 const parent=dirname(path),chain=parent===path?[]:await directory(parent,create)
 if(create)try{await mkdir(path,{mode:0o700})}catch(error){if(!object(error)||error.code!=='EEXIST')throw error}
 const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw corrupt()
 return [...chain,{path,dev:info.dev,ino:info.ino}]
}
async function unchanged(chain:readonly Directory[]):Promise<void>{
 for(const row of chain){const info=await lstat(row.path);if(!info.isDirectory()||info.isSymbolicLink()||info.dev!==row.dev||info.ino!==row.ino)throw corrupt()}
}
async function read(path:string,chain:readonly Directory[]):Promise<{row:ToolResourceUseSnapshot;bytes:number}>{
 await unchanged(chain)
 const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink())throw corrupt();if(before.size>MAX_SNAPSHOT_BYTES)throw limited()
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
 try{
  const info=await handle.stat();if(!info.isFile()||info.dev!==before.dev||info.ino!==before.ino)throw corrupt();if(info.size>MAX_SNAPSHOT_BYTES)throw limited()
  const buffer=Buffer.alloc(MAX_SNAPSHOT_BYTES+1);let bytes=0
  for(;;){const result=await handle.read(buffer,bytes,buffer.length-bytes,bytes);bytes+=result.bytesRead;if(bytes>MAX_SNAPSHOT_BYTES)throw limited();if(result.bytesRead===0)break}
  await unchanged(chain)
  let value:unknown;try{value=JSON.parse(buffer.subarray(0,bytes).toString('utf8'))}catch{throw corrupt()}
  let row:ToolResourceUseSnapshot;try{row=checked(value)}catch{throw corrupt()}
  if(join(chain.at(-1)!.path,identity(row)+'.json')!==path||row.sessionId!==basename(chain.at(-1)!.path))throw corrupt()
  return {row,bytes}
 }finally{await handle.close()}
}

/** 私有运行目录内的不可变来源sidecar；授权只来自调用方核实的父/直系子目录。 */
export function createToolResourceUseSnapshots(options:{readonly root:string;readonly authorize:(parentSessionId:string)=>Promise<readonly string[]>}){
 const root=options.root
 if(!isAbsolute(root)||resolve(root)!==root||dirname(root)===root)throw invalid()
 const record=async(input:ToolResourceUseSnapshot):Promise<void>=>{
  const row=checked(input),content=canonical(row),bytes=Buffer.byteLength(content)
  if(bytes>MAX_SNAPSHOT_BYTES)throw limited()
  const chain=await directory(join(root,row.sessionId),true),id=identity(row),path=join(root,row.sessionId,id+'.json')
  const compare=async()=>{const existing=await read(path,chain);if(canonical(existing.row)!==content)throw Object.assign(Error('工具来源快照身份冲突（conflict），保留原记录。'),{code:'teloa/storage-conflict'})}
  try{await compare();return}catch(error){if(!missing(error))throw error}
  const staging=join(root,row.sessionId,`.${id}.${randomUUID()}.tmp`)
  await unchanged(chain)
  const handle=await open(staging,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
  try{
   await unchanged(chain);await handle.writeFile(content,'utf8');await handle.sync()
   const info=await handle.stat(),actual=await lstat(staging);if(!actual.isFile()||actual.isSymbolicLink()||actual.dev!==info.dev||actual.ino!==info.ino)throw corrupt()
   await unchanged(chain)
   // 排他硬链接原子发布，跨factory/进程也不会覆盖同身份的并发记录。
   try{await link(staging,path)}catch(error){if(!object(error)||error.code!=='EEXIST')throw error;await compare()}
   await unchanged(chain);await compare()
  }finally{
   await handle.close()
   // 只移除本次随机命名的暂存链接，不触碰旧记录。
   try{await unchanged(chain);await unlink(staging)}catch(error){if(!missing(error))throw error}
  }
 }
 const list=async(input:unknown):Promise<readonly ToolResourceUseSnapshot[]>=>{
  if(!object(input))throw invalid()
  keys(input,['sessionId'])
  const parentSessionId=input.sessionId
  if(!sessionId(parentSessionId))throw invalid()
  const allowed=await options.authorize(parentSessionId)
  if(!Array.isArray(allowed)||allowed.some(id=>!sessionId(id))||!allowed.includes(parentSessionId))throw invalid()
  const ids=[...new Set(allowed)].sort();if(ids.length>MAX_SESSIONS)throw limited()
  const rows:ToolResourceUseSnapshot[]=[];let count=0,total=0
  for(const id of ids){
   let chain:Directory[];try{chain=await directory(join(root,id),false)}catch(error){if(missing(error))continue;throw error}
   await unchanged(chain);const entries=await opendir(join(root,id))
   for await(const entry of entries){
    if(++count>MAX_SNAPSHOTS)throw limited()
    if(/^\.[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(entry.name)){if(!entry.isFile()||entry.isSymbolicLink())throw corrupt();continue}
    if(!/^[a-f0-9]{64}\.json$/.test(entry.name)||!entry.isFile()||entry.isSymbolicLink())throw corrupt()
    const result=await read(join(root,id,entry.name),chain);total+=result.bytes;if(total>MAX_READ_BYTES)throw limited();rows.push(result.row)
   }
  }
  return rows.sort((left,right)=>left.sessionId.localeCompare(right.sessionId)||left.parentCallSeq-right.parentCallSeq||left.startSeq-right.startSeq||left.use.callId.localeCompare(right.use.callId))
 }
 return {record,list}
}
export type ToolResourceUseSnapshots=ReturnType<typeof createToolResourceUseSnapshots>
