import {randomBytes,randomUUID} from 'node:crypto'
import {appendFile,mkdir,open,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises'
import {basename,dirname,isAbsolute,join,relative} from 'node:path'
import {withFileLock,writeFileAtomic} from '@deepseek-ai/dsh-atomic-write'
import {keyIdOf,readHeader} from './envelope.ts'
import {createKeyFile,decodeKey,encodeKey,explicitKeyFile,keyringAccount,keyringProbeTimeoutMs,readKeyFile,withKeyringTimeout,type Env,type KeyringPort} from './key-sources.ts'

/** 档位判定与持久化（规格 §3.2）：只有首次初始化允许明文；已加密后取不到密钥一律锁定，绝不降级。 */
export type StorePreference='auto'|'keyring'|'file'
export type StoreTier='keyring'|'file'|'plaintext'
export type StoreMeta={schema:'teloa.credentials-meta/v1';installId:string;tier:StoreTier;keyId?:string;keyFile?:string}
export type EncryptedMeta=StoreMeta&{tier:'keyring'|'file';keyId:string}
export type LockReason='key-unavailable'|'meta-missing'|'meta-invalid'|'document-corrupt'|'store-unavailable'
export type ResolvedStore={mode:'encrypted';meta:EncryptedMeta;key:Buffer}|{mode:'plaintext';meta:StoreMeta}|{mode:'locked';reason:LockReason}
export type StorePaths={dshHome:string;meta:string;encrypted:string;legacy:string;keyringAccounts:string}
export type StoreDeps={keyring:KeyringPort|undefined;env:Env;keyDir:string;newId?:()=>string}
export class StoreFault extends Error{
 readonly reason:LockReason
 constructor(reason:LockReason){super(`credentials store ${reason}`);this.name='StoreFault';this.reason=reason}
}
/** 存储锁定且没有读好过的快照：读记录时抛出，调用方据此跳过，不能当成“没有凭据”。消息只含原因码。 */
export class CredentialStoreLocked extends Error{
 readonly reason:LockReason
 readonly credentialStoreLocked=true
 constructor(reason:LockReason){super(`credentials store is locked (${reason})`);this.name='CredentialStoreLocked';this.reason=reason}
}
/** 结构判定，不用 instanceof（受管 MCP 模块与提供方可能来自不同模块实例）。 */
export const isCredentialStoreLocked=(error:unknown):error is CredentialStoreLocked=>typeof error==='object'&&error!==null&&(error as {credentialStoreLocked?:unknown}).credentialStoreLocked===true
const metaSchema='teloa.credentials-meta/v1'
/**
 * `waitMs`：首次初始化等锁上限；`upgradeWaitMs`：明文档每次启动尝试升级时的等锁上限，超时就维持明文（不算降级）。
 * `staleMs`：锁文件存在超过它就视为孤儿（远超临界区最长耗时：钥匙串探测 3 s + 写密钥文件与 meta），覆盖持锁 PID 被复用的情况。
 * `guardStaleMs`：接管互斥文件超龄阈值，远大于它的持有时间（几毫秒）。
 */
export const lockWait={waitMs:30_000,upgradeWaitMs:10_000,staleMs:120_000,guardStaleMs:10_000}
const lockBusy=Symbol('lock-busy')
const ownerAlive=(pid:number):boolean=>{
 if(pid===process.pid)return true
 try{process.kill(pid,0);return true}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH'}
}
/** 锁文件是孤儿（持锁进程已不存在或锁超龄）时返回它的身份（inode + 纳秒 mtime）；同一句柄上读内容与 stat，二者属于同一个文件。 */
async function orphanLockId(lockPath:string):Promise<string|undefined>{
 let handle
 try{handle=await open(lockPath,'r')}catch{return undefined}
 try{
  const [text,info]=await Promise.all([handle.readFile('utf8'),handle.stat({bigint:true})])
  const pid=Number.parseInt(text,10)
  const stale=(Number.isSafeInteger(pid)&&pid>0&&!ownerAlive(pid))||Date.now()-Number(info.mtimeMs)>=lockWait.staleMs
  return stale?`${info.ino}-${info.mtimeNs}`:undefined
 }catch{return undefined}finally{await handle.close()}
}
/**
 * 孤儿锁接管（`dsh-atomic-write` 的 withFileLock 自身从不清理）。只有以 O_EXCL 建成接管互斥文件的进程才能删锁，
 * 且在互斥文件内重新核对锁的身份仍是同一把孤儿锁才删，不会误删别人刚建的新锁。
 * 互斥文件名绑定孤儿锁身份，只在“核对 + 删除”几毫秒内存在；它超龄说明接管者崩溃在窗口内，
 * 此时不删它（删它会让两个接管者同时在窗口内），而是改用下一级互斥文件，最多三级。
 * 不支持在不同 PID 命名空间（如容器与宿主）之间共享同一 DSH_HOME：对方的 PID 在这里看来已不存在。
 */
export async function clearStaleLock(filename:string):Promise<void>{
 const lockPath=`${filename}.lock`,id=await orphanLockId(lockPath)
 if(id===undefined)return
 const guard=(level:number)=>`${lockPath}.takeover-${id}-${level}`
 for(let level=0;level<3;level++){
  try{await writeFile(guard(level),`${process.pid}\n`,{flag:'wx',mode:0o600})}
  catch{
   const age=await stat(guard(level)).then(info=>Date.now()-info.mtimeMs,()=>undefined)
   if(age===undefined||age<lockWait.guardStaleMs)return // 别人正在接管或已接管完这把孤儿锁，去 withFileLock 排队
   continue
  }
  try{if(await orphanLockId(lockPath)===id)await rm(lockPath,{force:true})}
  finally{for(let done=level;done>=0;done--)await rm(guard(done),{force:true})}
  return
 }
}
/** 等锁超时返回 lockBusy；临界区内抛出的错误原样抛出。 */
async function withMetaLock<T>(paths:StorePaths,waitMs:number,operation:()=>Promise<T>):Promise<T|typeof lockBusy>{
 await clearStaleLock(paths.meta)
 let entered=false
 try{return await withFileLock(paths.meta,()=>{entered=true;return operation()},{waitMs})}catch(error){if(entered)throw error;return lockBusy}
}

export function storePaths(dshHome:string):StorePaths{
 return {dshHome,meta:join(dshHome,'.credentials.meta.json'),encrypted:join(dshHome,'.credentials.enc'),legacy:join(dshHome,'.credentials.yaml'),keyringAccounts:join(dshHome,'.credentials.keyring-accounts')}
}
export async function readOptional(path:string):Promise<string|undefined>{
 try{return await readFile(path,'utf8')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error}
}
export const inside=(child:string,parent:string):boolean=>{const path=relative(parent,child);return path===''||(!path.startsWith('..')&&!isAbsolute(path))}
/** 把路径最深的已存在祖先解析成真实路径再拼回余下部分，符号链接绕进 DSH_HOME 也能识别。 */
async function resolvedPath(path:string):Promise<string>{
 let head=path,tail=''
 for(;;){
  try{return join(await realpath(head),tail)}catch{}
  const parent=dirname(head)
  if(parent===head)return path
  tail=tail?join(basename(head),tail):basename(head);head=parent
 }
}
async function insideResolved(child:string,parent:string):Promise<boolean>{
 return inside(child,parent)||inside(await resolvedPath(child),await resolvedPath(parent))
}

/**
 * 写钥匙串之前先把账户名（`<installId>:<keyId>`，不含秘密）追加进登记文件：首次探测超时后 set 仍可能落地、轮换中途失败，
 * 都会留下孤立账户；`reset` 按登记逐个精确删除，不必枚举钥匙串（macOS 枚举会逐条读值、可能弹系统授权框）。
 * 登记写不进去就不碰钥匙串，避免留下无从追踪的账户。
 */
export async function trackKeyringAccount(paths:StorePaths,account:string):Promise<boolean>{
 return appendFile(paths.keyringAccounts,account+'\n',{mode:0o600}).then(()=>true,()=>false)
}
export async function readMeta(path:string):Promise<StoreMeta|undefined|'invalid'>{
 const text=await readOptional(path)
 if(text===undefined)return undefined
 try{
  const row=JSON.parse(text) as Record<string,unknown>,tier=row.tier
  if(row.schema!==metaSchema||typeof row.installId!=='string'||!/^[0-9a-f-]{36}$/.test(row.installId)||(tier!=='keyring'&&tier!=='file'&&tier!=='plaintext'))return 'invalid'
  if(tier!=='plaintext'&&(typeof row.keyId!=='string'||!/^[0-9a-f]{16}$/.test(row.keyId)))return 'invalid'
  if(tier==='file'&&(typeof row.keyFile!=='string'||!isAbsolute(row.keyFile)))return 'invalid'
  return {schema:metaSchema,installId:row.installId,tier,...(typeof row.keyId==='string'?{keyId:row.keyId}:{}),...(typeof row.keyFile==='string'?{keyFile:row.keyFile}:{})}
 }catch{return 'invalid'}
}
export async function writeMeta(path:string,meta:StoreMeta):Promise<boolean>{
 await writeFileAtomic(path,JSON.stringify(meta)+'\n',{mode:0o600,dirMode:0o700})
 const back=await readMeta(path)
 return back!==undefined&&back!=='invalid'&&JSON.stringify(back)===JSON.stringify(meta)
}

/** 以信封头 keyId 为准取主密钥；密钥文件在轮换中途崩溃时回看同目录兄弟文件。 */
export async function loadKey(meta:StoreMeta,keyId:string,deps:Pick<StoreDeps,'keyring'>):Promise<Buffer|undefined>{
 if(meta.tier==='keyring'){
  const port=deps.keyring
  if(!port)return undefined
  const text=await withKeyringTimeout(signal=>port.get(keyringAccount(meta.installId,keyId),signal))
  const key=text===undefined?undefined:decodeKey(text)
  return key&&keyIdOf(key)===keyId?key:undefined
 }
 if(meta.tier==='file'&&meta.keyFile){
  for(const path of [meta.keyFile,join(dirname(meta.keyFile),`${meta.installId}.${keyId}.key`)]){
   const generated=new RegExp(`^${meta.installId}\\.[0-9a-f]{16}\\.key$`).test(basename(path))
   const key=await readKeyFile(path,{external:!generated}).catch(()=>undefined)
   if(key&&keyIdOf(key)===keyId)return key
  }
 }
 return undefined
}

async function establish(paths:StorePaths,preference:StorePreference,deps:StoreDeps,installId:string,firstInit:boolean):Promise<ResolvedStore|undefined>{
 const commit=async(meta:StoreMeta,key?:Buffer):Promise<ResolvedStore>=>{
  if(!(await writeMeta(paths.meta,meta)))return {mode:'locked',reason:'meta-invalid'}
  return key&&meta.tier!=='plaintext'&&meta.keyId?{mode:'encrypted',meta:{...meta,tier:meta.tier,keyId:meta.keyId},key}:{mode:'plaintext',meta}
 }
 // 只有 auto 可以维持明文：显式档位（或首次初始化）取不到密钥一律锁定。
 const miss=(reason:LockReason):ResolvedStore|undefined=>firstInit||preference!=='auto'?{mode:'locked',reason}:undefined
 if(preference!=='file'&&deps.keyring){
  const port=deps.keyring,key=randomBytes(32),keyId=keyIdOf(key),account=keyringAccount(installId,keyId)
  const stored=!(await trackKeyringAccount(paths,account))?undefined:await withKeyringTimeout(async signal=>{await port.set(account,encodeKey(key),signal);return port.get(account,signal)},keyringProbeTimeoutMs)
  if(stored!==undefined&&decodeKey(stored)?.equals(key))return commit({schema:metaSchema,installId,tier:'keyring',keyId},key)
 }
 if(preference==='keyring')return miss('store-unavailable')
 const explicit=explicitKeyFile(deps.env)
 if(explicit){
  const key=await readKeyFile(explicit,{external:true}).catch(()=>undefined)
  return key?commit({schema:metaSchema,installId,tier:'file',keyId:keyIdOf(key),keyFile:explicit},key):miss('key-unavailable')
 }
 const runtimeRoot=deps.env.TELOA_RUNTIME_ROOT
 if(!(await insideResolved(deps.keyDir,paths.dshHome))&&!(runtimeRoot&&await insideResolved(deps.keyDir,runtimeRoot))){
  const key=randomBytes(32),keyId=keyIdOf(key),keyFile=join(deps.keyDir,`${installId}.${keyId}.key`)
  try{
   await createKeyFile(keyFile,key)
   if((await readKeyFile(keyFile))?.equals(key))return commit({schema:metaSchema,installId,tier:'file',keyId,keyFile},key)
  }catch{/* 生成失败继续判定下一档 */}
 }
 if(preference==='file')return miss('store-unavailable')
 return firstInit?commit({schema:metaSchema,installId,tier:'plaintext'}):undefined
}

export async function resolveStore(paths:StorePaths,preference:StorePreference,deps:StoreDeps):Promise<ResolvedStore>{
 let meta:StoreMeta|undefined|'invalid',envelopeText:string|undefined
 try{meta=await readMeta(paths.meta);envelopeText=await readOptional(paths.encrypted)}catch{return {mode:'locked',reason:'store-unavailable'}}
 if(meta==='invalid')return {mode:'locked',reason:'meta-invalid'}
 let headerKeyId:string|undefined
 if(envelopeText!==undefined){try{headerKeyId=readHeader(envelopeText).keyId}catch{return {mode:'locked',reason:'document-corrupt'}}}
 if(meta===undefined){
  if(envelopeText!==undefined)return {mode:'locked',reason:'meta-missing'}
  try{await mkdir(paths.dshHome,{recursive:true,mode:0o700})}catch{return {mode:'locked',reason:'store-unavailable'}}
  let created:ResolvedStore|undefined|typeof lockBusy
  try{created=await withMetaLock(paths,lockWait.waitMs,async()=>(await readMeta(paths.meta))===undefined?establish(paths,preference,deps,(deps.newId??randomUUID)(),true):undefined)}
  catch{return {mode:'locked',reason:'store-unavailable'}}
  if(created===lockBusy)return {mode:'locked',reason:'store-unavailable'}
  return created??resolveStore(paths,preference,deps)
 }
 if(meta.tier==='plaintext'){
  if(envelopeText!==undefined)return {mode:'locked',reason:'meta-invalid'}
  const installId=meta.installId,changed=Symbol('meta-changed')
  const stillPlaintext=async():Promise<boolean>=>{const again=await readMeta(paths.meta);return again!==undefined&&again!=='invalid'&&again.tier==='plaintext'}
  let upgraded:ResolvedStore|undefined|typeof lockBusy|typeof changed
  try{upgraded=await withMetaLock(paths,lockWait.upgradeWaitMs,async()=>await stillPlaintext()?establish(paths,preference,deps,installId,false):changed)}
  catch{return {mode:'locked',reason:'store-unavailable'}}
  // 等锁超时：别的进程可能正在升级，重读一次；仍是明文则 auto 维持明文、显式档位锁定。
  if(upgraded===lockBusy)upgraded=await stillPlaintext().catch(()=>false)?(preference==='auto'?undefined:{mode:'locked',reason:'store-unavailable'}):changed
  // meta 已被他人改动（通常是并发升级完成）：按最新状态重新判定，不能返回锁外读到的旧明文状态。
  if(upgraded===changed)return resolveStore(paths,preference,deps)
  return upgraded??{mode:'plaintext',meta}
 }
 const keyId=headerKeyId??meta.keyId
 if(keyId===undefined)return {mode:'locked',reason:'meta-invalid'}
 const key=await loadKey(meta,keyId,deps)
 if(!key)return {mode:'locked',reason:'key-unavailable'}
 return {mode:'encrypted',meta:{...meta,tier:meta.tier,keyId},key}
}
