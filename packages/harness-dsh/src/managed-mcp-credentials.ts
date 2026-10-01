import {constants} from 'node:fs'
import {lstat,open,readdir,unlink,type FileHandle} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {credentialKey,type CredentialKey,type CredentialProvider,type CredentialRecord} from '@deepseek-ai/dsh-credentials'
import {CredentialStoreLocked,isCredentialStoreLocked} from './credentials/store-state.ts'

/**
 * 受管 MCP 凭据槽存于 ctx.credentials 的 grant 记录 teloa-managed-mcp/s<hex(serverName)>（规格 §3.5）。
 * 锁顺序：调用方外层持 oauth.exclusive(serverName)，本模块只经提供方写锁读改写，不再自持文件锁。
 */
export type McpSlotStore={
 read(serverName:string):Promise<Record<string,string>>
 patch(serverName:string,patch:Record<string,string|undefined>):Promise<void>
 replace(serverName:string,slots:Record<string,string>):Promise<void>
 remove(serverName:string):Promise<void>
 /** 当前不可写（锁定或可读不可写）时抛 CredentialStoreLocked：调用方在任何副作用之前预检 */
 assertWritable(serverName:string):Promise<void>
}
export type McpCredentialPort=Pick<CredentialProvider,'readRecord'|'describeRecord'|'modifyRecord'|'deleteRecord'>
const serverNamePattern=/^[A-Za-z0-9_-]{1,64}$/
/** 一期 writeAtomic 崩溃残留的临时明文：<serverName>.<pid>.<uuid>.tmp */
const legacyTempPattern=/^[A-Za-z0-9_-]{1,64}\.\d+\.[0-9a-f-]{36}\.tmp$/

export function mcpCredentialKey(serverName:string):CredentialKey{
 if(!serverNamePattern.test(serverName))throw new TypeError('invalid managed MCP server name')
 return credentialKey('teloa-managed-mcp','s'+Buffer.from(serverName,'utf8').toString('hex'))
}
function slotsOf(record:CredentialRecord|undefined):Record<string,string>{
 if(record?.kind!=='grant'||!record.payload||typeof record.payload!=='object'||Array.isArray(record.payload))return {}
 return Object.fromEntries(Object.entries(record.payload).filter((entry):entry is [string,string]=>typeof entry[1]==='string'))
}
/** 提供方的其他故障（信封、锁超时、已停用等）一律按锁定处理：调用方照锁定语义跳过，回包只给固定文案，不透出内部键名。 */
async function viaStore<T>(run:()=>Promise<T>,onFault?:(errorName:string)=>void):Promise<T>{
 try{return await run()}catch(error){
  if(isCredentialStoreLocked(error))throw error
  // 只交出错误类名（不带 message，避免内部键名外泄），便于排查被转成锁定的原始故障
  onFault?.(error instanceof Error?error.name:typeof error)
  throw new CredentialStoreLocked('store-unavailable')
 }
}
/** 未挂载 ctx.credentials（如只装了部分服务的宿主夹具）时，每次读写都按锁定处理，调用方照锁定语义跳过。 */
export function credentialSlotStore(input:McpCredentialPort|undefined,onFault?:(errorName:string)=>void):McpSlotStore{
 const unavailable=async():Promise<never>=>{throw new CredentialStoreLocked('store-unavailable')}
 const port:McpCredentialPort=input??{readRecord:unavailable,describeRecord:async()=>({configured:false,writable:false}),modifyRecord:unavailable,deleteRecord:unavailable}
 return {
  read:async serverName=>{const key=mcpCredentialKey(serverName);return slotsOf(await viaStore(()=>port.readRecord(key),onFault))},
  patch:async(serverName,patch)=>{
   const key=mcpCredentialKey(serverName)
   await viaStore(()=>port.modifyRecord(key,async current=>{
    const slots=slotsOf(current)
    for(const [name,value] of Object.entries(patch)){if(value===undefined)delete slots[name];else slots[name]=value}
    return {kind:'grant',payload:slots}
   }),onFault)
  },
  replace:async(serverName,slots)=>{const key=mcpCredentialKey(serverName);await viaStore(()=>port.modifyRecord(key,async()=>({kind:'grant',payload:{...slots}})),onFault)},
  remove:async serverName=>{const key=mcpCredentialKey(serverName);await viaStore(()=>port.deleteRecord(key),onFault)},
  assertWritable:async serverName=>{
   const key=mcpCredentialKey(serverName)
   if(!(await viaStore(()=>port.describeRecord(key),onFault)).writable)throw new CredentialStoreLocked('store-unavailable')
  },
 }
}
/** 仅测试与验收夹具使用的内存端口。 */
export function memoryCredentialPort():McpCredentialPort{
 const records=new Map<string,CredentialRecord>()
 return {
  readRecord:async key=>records.get(key),
  describeRecord:async key=>{const record=records.get(key);return record?{configured:true,kind:record.kind,writable:true}:{configured:false,writable:true}},
  modifyRecord:async(key,mutate)=>{const next=await mutate(records.get(key));if(next!==undefined)records.set(key,next);return next??records.get(key)},
  deleteRecord:async key=>{records.delete(key)},
 }
}
export const memorySlotStore=():McpSlotStore=>credentialSlotStore(memoryCredentialPort())

/** 原位覆写同长度零字节并 fsync（不先截断），核对写入字节数 */
async function wipe(handle:FileHandle,size:number):Promise<void>{
 let offset=0
 while(offset<size){
  const {bytesWritten}=await handle.write(Buffer.alloc(size-offset),0,size-offset,offset)
  if(bytesWritten<=0)throw new Error('failed')
  offset+=bytesWritten
 }
 await handle.sync()
}
/** O_NOFOLLOW 打开末级；只接受链接数为 1 的普通文件（硬链接会让原位覆写波及外部文件） */
async function openLegacy(path:string):Promise<{handle:FileHandle;size:number}>{
 const handle=await open(path,constants.O_RDWR|constants.O_NONBLOCK|(constants.O_NOFOLLOW??0))
 try{
  const info=await handle.stat()
  if(!info.isFile()||info.nlink!==1)throw new Error('failed')
  return {handle,size:info.size}
 }catch(error){await handle.close();throw error}
}
async function wipeAndRemove(path:string):Promise<void>{
 const {handle,size}=await openLegacy(path)
 try{await wipe(handle,size)}finally{await handle.close()}
 await unlink(path)
}

type MigrationLogger={info(format:string,...args:unknown[]):void;warn(format:string,...args:unknown[]):void}
const reasonOf=(error:unknown)=>isCredentialStoreLocked(error)?'store-locked':error instanceof SyntaxError||(error as Error).message==='format'?'format':'failed'

/**
 * 一期 0600 文件 → 记录：记录里没有的槽才补写，读回逐值确认后擦除再删除旧文件；日志只记 serverName。
 * 启动清理一并处理：擦除中断留下的空文件或全 NUL 文件、一期原子写崩溃残留的 .tmp 明文、没有对应连接的孤儿旧文件（只擦除不导入）。
 * `hasConnection` 缺省时视为都有对应连接；调用方只在连接状态文件完整解析成功时才传入真实判定（读不出时判孤儿会不可逆地擦掉凭据）。
 * 孤儿文件也先确认是 JSON 对象才擦除，解析不了的按 format 告警并保留。
 */
export async function migrateLegacyMcpCredentials(runtimeRoot:string,slots:McpSlotStore,exclusive:<T>(serverName:string,task:()=>Promise<T>)=>Promise<T>,logger:MigrationLogger,hasConnection:(serverName:string)=>boolean=()=>true):Promise<string[]>{
 const dir=resolve(runtimeRoot,'mcp','credentials')
 let dirInfo
 try{dirInfo=await lstat(dir)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error}
 // 目录本身是符号链接时不跟随：否则原位覆写会落到外部文件
 if(!dirInfo.isDirectory()){logger.warn('受管 MCP 旧凭据目录不是普通目录，未处理（%s）','failed');return []}
 const names=(await readdir(dir)).sort()
 for(const name of names.filter(item=>legacyTempPattern.test(item))){
  try{await wipeAndRemove(join(dir,name))}catch(error){logger.warn('受管 MCP 旧凭据临时文件未清除：%s（%s）',name,reasonOf(error))}
 }
 const migrated:string[]=[]
 for(const name of names.filter(item=>serverNamePattern.test(item))){
  // 逐个 serverName 隔离：坏文件、读回不一致、存储锁定只影响这一个，旧文件保留，下次启动重试；日志只记 serverName 与原因类别。
  try{
   await exclusive(name,async()=>{
    const path=join(dir,name),{handle,size}=await openLegacy(path)
    let imported=false
    try{
     const text=await handle.readFile('utf8')
     // 上次擦除中途中断（空文件或含 NUL：合法 JSON 不含裸 NUL，写到一半的擦除也算）：不导入，直接擦除
     if(text.length===0||text.includes('\0')){await wipe(handle,size)}
     else{
      const parsed=JSON.parse(text) as unknown
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('format')
      // 孤儿旧文件（有完整连接记录可比对且没有对应连接）：不导入，直接擦除
      if(!hasConnection(name)){await wipe(handle,size)}
      else{
       const legacy=Object.fromEntries(Object.entries(parsed).filter((entry):entry is [string,string]=>typeof entry[1]==='string'))
       const existing=await slots.read(name)
       const missing=Object.fromEntries(Object.entries(legacy).filter(([slot])=>!(slot in existing)))
       if(Object.keys(missing).length)await slots.patch(name,missing)
       const back=await slots.read(name)
       if(Object.keys(legacy).some(slot=>!(slot in back))||Object.entries(missing).some(([slot,value])=>back[slot]!==value))throw new Error('verify')
       await wipe(handle,size)
       imported=true
      }
     }
    }finally{await handle.close()}
    await unlink(path)
    if(imported)migrated.push(name)
   })
  }catch(error){logger.warn('受管 MCP 旧凭据未迁移，保留原文件待下次启动：%s（%s）',name,reasonOf(error))}
 }
 if(migrated.length)logger.info('受管 MCP 凭据已迁入加密存储：%s',migrated.join(', '))
 return migrated
}
