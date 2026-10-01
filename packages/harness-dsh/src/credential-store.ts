import {createHash} from 'node:crypto'
import {constants} from 'node:fs'
import {lstat,open,readdir,readFile,realpath,unlink} from 'node:fs/promises'
import {homedir} from 'node:os'
import {basename,dirname,isAbsolute,join,relative} from 'node:path'
import {WorkError} from '@teloa/contract'

/**
 * 凭据存储状态与历史明文副本清单（规格 §0-1、§0-3）：只列不自动删，删除必须由本人在设置页按清单 id 确认。
 * 端点只由本人浏览器的 `/teloa` 连接分发，不进 dispatchTeloaEndpoint 与 teloaWork.invoke，模型工具够不到。
 */
export const credentialStoreEndpoints=['credential-store/status','credential-store/plaintext-copies/delete'] as const
/** `dev/ino` 只留在服务端清单项里，擦除前核对；回包只有 `id/label/shared`。`shared`：链接数大于 1，与其他路径共用内容，只能手动处理。 */
export type PlaintextCopy={id:string;label:string;path:string;shared:boolean;dev:number;ino:number}
type Status={tier:'keyring'|'file'|'plaintext'|null;fault:string|null}
type Scan={dshHome?:string|undefined;files?:readonly string[];skip?:readonly string[]}

/** 明文凭据文件：官方明文存储及其隔离、原子写残留，以及受管 MCP 一期的旧凭据目录（含 `.tmp` 残留）。 */
const isCopy=(path:string)=>{
 const name=basename(path)
 return name==='.credentials.yaml'||name.startsWith('.credentials.yaml.quarantine-')||/^\.credentials\.yaml\.[0-9a-f]+\.tmp$/.test(name)
  ||(basename(dirname(path))==='credentials'&&basename(dirname(dirname(path)))==='mcp')
}
const realOr=async(path:string)=>realpath(path).catch(()=>path)
/** 目录里有 `.credentials.host.pid` 且对应进程存活：那是另一台正在运行的宿主的 DSH_HOME，其中的明文可能在用。 */
async function runningHost(dir:string):Promise<boolean>{
 const marker=join(dir,'.credentials.host.pid')
 if(!(await lstat(marker).catch(()=>undefined))?.isFile())return false
 const pid=Number((await readFile(marker,'utf8').catch(()=>'')).trim())
 if(!Number.isSafeInteger(pid)||pid<=0)return false
 try{process.kill(pid,0);return true}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM'}
}
const within=(parent:string,child:string)=>{const path=relative(parent,child);return path!==''&&!path.startsWith('..')&&!isAbsolute(path)}

/**
 * 扫描范围（不跟随符号链接，跳过 node_modules）：
 * - 运行目录；DSH_HOME；两者同级时（源码 `.runtime/{teloa,dsh}`、npm `instances/default/{runtime,dsh}`）连同上一级一起扫，
 *   覆盖 `.runtime/backups/*` 等旧副本——上一级是家目录或根目录时不扩大；
 * - 运行目录上一、二级里的 `.runtime-upgrade-backup-*`（源码模式升级备份）；npm 安装的升级前自动备份 `<home>.backups`；
 * - 调用方给出的单个文件（提供方隔离的 `.credentials.yaml.quarantine-*`）。
 * 不进入 `skip` 目录（工作区：用户项目里的同名文件不是 Teloa 的副本，模型也能在那里造文件），
 * 也不进入其它带存活运行标记的 DSH_HOME（另一台正在运行的宿主，明文可能在用）；标记对应进程已退出的照常列入。
 * 标签：运行目录上一级之内用相对路径，其外用绝对路径。
 */
export async function findPlaintextCopies(runtimeRoot:string,exclude:(path:string)=>boolean,scan:Scan={}):Promise<PlaintextCopy[]>{
 // 统一按 realpath 比较与展示（macOS 的 /var 是 /private/var 的链接）
 const root=await realOr(runtimeRoot),base=await realOr(dirname(runtimeRoot)),found=new Map<string,PlaintextCopy>()
 const skip=new Set(await Promise.all((scan.skip??[]).map(realOr)))
 const dshHome=scan.dshHome===undefined?undefined:await realOr(scan.dshHome)
 const add=async(path:string)=>{
  const real=await realpath(path).catch(()=>undefined)
  if(real===undefined||!isCopy(real))return
  // 身份在调用排除回调之前取：擦除时按它核对，扫描之后被换掉的文件或目录一律拒绝。
  const info=await lstat(real).catch(()=>undefined)
  if(!info?.isFile()||exclude(real))return
  const id=createHash('sha256').update(real).digest('hex').slice(0,32)
  found.set(id,{id,label:within(base,real)?relative(base,real):real,path:real,shared:info.nlink>1,dev:info.dev,ino:info.ino})
 }
 const walk=async(dir:string,depth:number):Promise<void>=>{
  if(dir!==dshHome&&await runningHost(dir))return
  let entries
  try{entries=await readdir(dir,{withFileTypes:true})}catch{return}
  for(const entry of entries){
   const path=join(dir,entry.name)
   if(entry.isDirectory()){if(depth>0&&entry.name!=='node_modules'&&!skip.has(path))await walk(path,depth-1);continue}
   if(entry.isFile()&&isCopy(path))await add(path)
  }
 }
 const upgradeBackups=async(dir:string)=>{for(const name of await readdir(dir).catch(()=>[] as string[]))if(name.startsWith('.runtime-upgrade-backup-'))await walk(join(dir,name),5)}
 if(dshHome!==undefined&&dirname(dshHome)===base&&base!==dirname(base)&&base!==await realOr(homedir()))await walk(base,7)
 else{await walk(root,6);if(dshHome!==undefined)await walk(dshHome,3)}
 await upgradeBackups(base);await upgradeBackups(dirname(base))
 if(basename(dirname(base))==='instances')await walk(dirname(dirname(base))+'.backups',6)
 for(const file of scan.files??[])if((await lstat(file).catch(()=>undefined))?.isFile())await add(file)
 return [...found.values()].sort((a,b)=>a.label.localeCompare(b.label))
}

/**
 * 安全擦除后删除：不跟随符号链接（O_NOFOLLOW），只接受链接数为 1 的普通文件（硬链接的原位覆写会波及另一路径），
 * 原位覆写同长度零字节并 fsync（不先截断），再核对路径仍指向同一 inode 后 unlink。打不开或不满足条件的返回 false，原样保留。
 * O_NOFOLLOW 只管最后一段：打开前与 unlink 前都核对所在目录的真实路径仍是扫描时那个，句柄的 dev/ino 必须与扫描时一致，
 * 中间目录在扫描之后被换成链接、或文件被同名文件替换，都拒绝。Node 没有 unlinkat，核对与 unlink 之间仍有极短窗口（纵深，不是边界）。
 */
async function wipeAndRemove(copy:PlaintextCopy):Promise<boolean>{
 const {path}=copy,parent=dirname(path)
 const sameParent=async()=>(await realpath(parent).catch(()=>''))===parent
 if(!await sameParent())return false
 let handle
 try{handle=await open(path,constants.O_RDWR|constants.O_NONBLOCK|(constants.O_NOFOLLOW??0))}catch{return false}
 let ino:number
 try{
  const info=await handle.stat()
  if(!info.isFile()||info.nlink!==1||info.dev!==copy.dev||info.ino!==copy.ino)return false
  ino=info.ino
  for(let offset=0;offset<info.size;){
   const {bytesWritten}=await handle.write(Buffer.alloc(info.size-offset),0,info.size-offset,offset)
   if(bytesWritten<=0)return false
   offset+=bytesWritten
  }
  await handle.sync()
 }catch{return false}finally{await handle.close()}
 const now=await lstat(path).catch(()=>undefined)
 if(now?.ino!==ino||now.dev!==copy.dev||!await sameParent())return false
 try{await unlink(path)}catch{return false}
 return true
}

export function createCredentialStoreHandler(input:{status:()=>Status;runtimeRoot:string;exclude:(path:string)=>boolean;dshHome?:()=>string|undefined;files?:()=>readonly string[];skip?:()=>readonly string[]}){
 const list=()=>findPlaintextCopies(input.runtimeRoot,input.exclude,{dshHome:input.dshHome?.(),files:input.files?.()??[],skip:input.skip?.()??[]})
 const describe=async()=>({...input.status(),copies:(await list()).map(({id,label,shared})=>({id,label,shared}))})
 return async(endpoint:string,payload:unknown)=>{
  const row=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload as Record<string,unknown>:undefined
  if(endpoint==='credential-store/status'){
   if(!row||Object.keys(row).length)throw new WorkError('teloa/invalid-input','密钥存储状态请求格式不正确。')
   return describe()
  }
  if(endpoint==='credential-store/plaintext-copies/delete'){
   const ids=row?.ids
   if(!row||Object.keys(row).join()!=='ids'||!Array.isArray(ids)||!ids.length||ids.length>100||!ids.every(id=>typeof id==='string'&&/^[0-9a-f]{32}$/.test(id)))throw new WorkError('teloa/invalid-input','删除请求格式不正确。')
   // 删除时重新列清单：只删此刻仍在清单里的项（在用文件与排除项实时生效），清单外的 id 静默忽略。
   let refused=0
   for(const copy of await list())if(ids.includes(copy.id)&&!await wipeAndRemove(copy))refused++
   return {...await describe(),refused}
  }
  throw new WorkError('teloa/not-found','未提供此密钥存储接口。')
 }
}
