/**
 * 待启用插件清单与 DSH profile 清单的唯一读写点。
 *
 * 市场插件装进 profile 之后并不自动进入组合：包引用连同"安装时固定的补丁摘要"记在
 * `teloa-待启用插件.json`（0600）里，同时把包名从 `dsh.profile.bundles` 摘掉，
 * 它的 bundle 补丁层在本人显式启用前完全不参与组合。
 *
 * 这件事必须**反复**做：上游 `@deepseek-ai/dsh` 的 `reconcilePlugins` 在每一次成功的
 * `dsh plugin add` 之后都会遍历 `dependencies`，把任何声明了 `dsh.bundle` 而不在 `bundles`
 * 里的包补回去 —— 包括此刻正在待启用的那些。补回它的既可能是 Teloa 自己的下一次安装，
 * 也可能是 `pnpm setup:dsh` 对正式 profile 跑的那条 `add link:packages/…`。
 * 所以压制函数只有这一份，安装适配器、启动器与 `pnpm setup:dsh` 共用它。
 *
 * 这个模块刻意不依赖 `@teloa/contract`：`scripts/*.mjs` 直接按 Node 的类型剥离导入它，
 * 启动路径上不该为了读一份 JSON 把整条契约链拉进来。
 */

import {randomUUID} from 'node:crypto'
import {chmod,readFile,rename,rm,stat,writeFile} from 'node:fs/promises'
import {join} from 'node:path'

const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)

export const PENDING_PLUGINS_FILE='teloa-待启用插件.json'

/**
 * profile 级互斥。
 *
 * profile 清单与待启用清单是"读—改—写"的：两次安装、一次安装与一次启用交错跑，
 * 后写的一方会把前一方刚加进去的键整段覆盖掉。写入方不止后端一处
 * （启动器与 `pnpm setup:dsh` 都写，它们根本不连 Postgres），
 * 所以互斥落在**进程内按 profile 目录排队**这一层，而不是后端的 `effectLock`：
 * 顾问锁只能覆盖走后端的那一条路径。
 * 跨进程的同时写入由另外两道钉兜底 —— 启动器在起宿主之前、宿主在装配期，
 * 都会复核"待启用清单与 bundles 不相交"，不一致即拒绝启动。
 */
const profileQueues=new Map<string,Promise<void>>()

export function withProfileLock<T>(profileDir:string,operation:()=>Promise<T>):Promise<T>{
 const previous=profileQueues.get(profileDir)??Promise.resolve()
 const result=previous.then(operation,operation)
 const settled=result.then(()=>{},()=>{})
 profileQueues.set(profileDir,settled)
 void settled.then(()=>{if(profileQueues.get(profileDir)===settled)profileQueues.delete(profileDir)})
 return result
}

export async function readJsonFile(path:string,maxBytes=1024*1024):Promise<Record<string,unknown>>{
 const info=await stat(path)
 if(!info.isFile()||info.size>maxBytes)throw Error('native-config-invalid')
 const value=JSON.parse(await readFile(path,'utf8'))
 if(!record(value))throw Error('native-config-invalid')
 return value
}

/**
 * 原子落盘：先写同目录的临时文件再 `rename`。
 * 直接 `writeFile` 会先把目标截断成 0 字节，进程在这中间被杀掉就留下一份空的 profile 清单，
 * 宿主下次启动读到的是"没有 bundles"。
 *
 * `rename` 带过去的是**临时文件**的权限位，不是目标原有的：不显式给 `mode` 时先读一次目标，
 * 把它现有的权限位抄到临时文件上，否则每一次改写都会把目标悄悄放宽成 umask 默认值。
 * 目标还不存在时就按默认权限新建。
 */
export async function writeAtomic(path:string,text:string,mode?:number):Promise<void>{
 let target=mode
 if(target===undefined){
  try{target=(await stat(path)).mode&0o777}catch{target=undefined}
 }
 const temporary=path+'.teloa-'+randomUUID()+'.tmp'
 try{
  await writeFile(temporary,text,target===undefined?{}:{mode:target})
  // writeFile 的 mode 只在新建时生效，且会被 umask 削一刀；显式 chmod 才能保证逐位一致。
  if(target!==undefined)await chmod(temporary,target)
  await rename(temporary,path)
 }catch(error){
  await rm(temporary,{force:true}).catch(()=>{})
  throw error
 }
}

/**
 * 待启用清单读不出来时的固定文案。不带路径、不带包名。
 *
 * 读不出来**不等于**没有待启用插件：权限不对、正文被改坏、摘要格式不认识，
 * 都可能是有人在绕开"安装不自动启用"这道闸。朝拒绝方向失败。
 */
export const pendingListUnreadable='DSH profile 的待启用扩展清单不可读或格式不正确，已停止；请核对该清单后重试。'

/**
 * 待启用清单：包引用（`名字@版本`）→ 安装时固定的组合补丁正文 sha256。
 *
 * 只有"文件不存在"才是 `{}`（还没装过任何市场插件）。其余任何读不通的情形
 * —— EACCES、正文不是 JSON、顶层不是对象、某一条的摘要不是 64 位小写十六进制、
 * 或者出现 `__proto__` 这类原型键 —— 一律抛出，由调用方按拒绝处理。
 * 这与 `readProfileFacts` 的取向一致：宁可拒绝启动，也不把"读不出来"当成"没有"。
 */
export async function readPendingPlugins(profileDir:string):Promise<Record<string,string>>{
 let text:string
 try{text=await readFile(join(profileDir,PENDING_PLUGINS_FILE),'utf8')}
 catch(error){
  if(record(error)&&error.code==='ENOENT')return {}
  throw Error(pendingListUnreadable)
 }
 let value:unknown
 try{value=JSON.parse(text)}catch{throw Error(pendingListUnreadable)}
 if(!record(value))throw Error(pendingListUnreadable)
 const pending:Record<string,string>={}
 for(const [ref,hash] of Object.entries(value)){
  if(ref==='__proto__'||ref==='constructor'||ref==='prototype')throw Error(pendingListUnreadable)
  if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))throw Error(pendingListUnreadable)
  pending[ref]=hash
 }
 return pending
}

/** 调用方必须已经持有 `withProfileLock`。 */
export async function writePendingPlugins(profileDir:string,pending:Record<string,string>):Promise<void>{
 await writeAtomic(join(profileDir,PENDING_PLUGINS_FILE),JSON.stringify(pending,null,2)+'\n',0o600)
}

/** 包引用去掉版本段：`@scope/name@1.2.3` → `@scope/name`。 */
export function pendingPackageNames(pending:Readonly<Record<string,string>>):string[]{
 return [...new Set(Object.keys(pending).map(ref=>ref.slice(0,ref.lastIndexOf('@'))).filter(name=>name.length>0))]
}

export function profileBundles(manifest:Record<string,unknown>):string[]{
 const dsh=record(manifest.dsh)?manifest.dsh:{},profile=record(dsh.profile)?dsh.profile:{}
 return Array.isArray(profile.bundles)?profile.bundles.filter((name):name is string=>typeof name==='string'):[]
}

/**
 * 只改 `dsh.profile.bundles` 一个键；profile 清单的其余内容逐字保留。
 * 调用方必须已经持有 `withProfileLock`。
 */
export async function rewriteProfileBundlesLocked(profileDir:string,change:(bundles:string[])=>string[]):Promise<void>{
 const manifest=await readJsonFile(join(profileDir,'package.json'))
 const dsh=record(manifest.dsh)?manifest.dsh:{},profile=record(dsh.profile)?dsh.profile:{}
 const current=profileBundles(manifest)
 const next=change([...current])
 if(next.length===current.length&&next.every((name,index)=>name===current[index]))return
 const updated={...manifest,dsh:{...dsh,profile:{...profile,bundles:next}}}
 await writeAtomic(join(profileDir,'package.json'),JSON.stringify(updated,null,2)+'\n')
}

/** 整份 profile 清单的原子写。调用方必须已经持有 `withProfileLock`。 */
export async function writeProfileManifest(profileDir:string,manifest:Record<string,unknown>):Promise<void>{
 await writeAtomic(join(profileDir,'package.json'),JSON.stringify(manifest,null,2)+'\n')
}

export function rewriteProfileBundles(profileDir:string,change:(bundles:string[])=>string[]):Promise<void>{
 return withProfileLock(profileDir,()=>rewriteProfileBundlesLocked(profileDir,change))
}

/** 调用方必须已经持有 `withProfileLock`。 */
export async function suppressPendingBundlesLocked(profileDir:string):Promise<void>{
 const names=new Set(pendingPackageNames(await readPendingPlugins(profileDir)))
 if(!names.size)return
 await rewriteProfileBundlesLocked(profileDir,bundles=>bundles.filter(name=>!names.has(name)))
}

/**
 * 把待启用的包从 `dsh.profile.bundles` 里摘掉（`dependencies` 与 node_modules 原样保留）。
 * 任何一次 `dsh plugin` 子进程结束之后都要无条件跑一遍：成功、失败、超时、中止、回滚之后都算。
 */
export function suppressPendingBundles(profileDir:string):Promise<void>{
 return withProfileLock(profileDir,()=>suppressPendingBundlesLocked(profileDir))
}

/**
 * 待启用清单与 `dsh.profile.bundles` 的交集：非空即表示"本人没点过启用的插件已经进了组合"，
 * 下次启动就会 import 并执行它的顶层代码。启动器与装配期复验都按这个事实拒绝启动。
 *
 * 待启用清单读不出来时 `readPendingPlugins` 已经抛出（固定文案）。
 * 清单非空而 profile 表读不出来时同样抛出：那就是"有待启用插件，但核不了它在不在组合里"。
 */
export async function pendingBundleConflicts(profileDir:string):Promise<string[]>{
 const names=new Set(pendingPackageNames(await readPendingPlugins(profileDir)))
 if(!names.size)return []
 let manifest:Record<string,unknown>
 try{manifest=await readJsonFile(join(profileDir,'package.json'))}catch{throw Error(pendingListUnreadable)}
 return profileBundles(manifest).filter(name=>names.has(name))
}

/** 固定文案：不带路径、不带包名，只说明发生了什么与下一步。 */
export const pendingBundleRefusal='DSH profile 里有待启用扩展已经进入组合，宿主拒绝启动；请在扩展管理中重新核对该扩展后再启动。'
