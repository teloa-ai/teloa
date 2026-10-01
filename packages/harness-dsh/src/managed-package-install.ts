import {WorkError,isRecord} from '@teloa/contract'
import {readManagedPackageLock,type ManagedPackageLock,type ManagedPackageRecipe} from './managed-package-lock.ts'
export {readManagedPackageLock,managedPackageRegistry,type ManagedPackageLock,type ManagedPackageRecipe} from './managed-package-lock.ts'
import {lstat,mkdir,readFile,readdir,readlink,rename,rm,stat,writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {promisify} from 'node:util'
import {dirname,resolve} from 'node:path'

/** teloaWork.packages.install 只接受这些精确配方（包名、版本、integrity 三者一致）。 */
export const managedPackageAllowlist:readonly ManagedPackageRecipe[]=[
 {package:'@larksuiteoapi/node-sdk',version:'1.74.0',integrity:'sha512-K2WoGy6x97u2kPPSFsu0v9X8CY+0q4OwO3rhXiOSRXYjGS7ovydFpEH07AS5VYcBnbQCoc5sGezo0IEGVViuoA=='},
 // 本地中文检索扩展（@teloa/local-embedding）的推理运行时：确认准备后按需安装，不随应用发行；配方与扩展 runtime/onnxruntime.json 一致。
 {package:'onnxruntime-node',version:'1.30.0',integrity:'sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw=='},
]

// 随附 lock 由 `npm install <pkg>@<version> --ignore-scripts --package-lock-only --save-exact` 在独立空目录生成，逐条带 integrity。
import feishuSdkLock from './managed-package-locks/larksuiteoapi__node-sdk@1.74.0.package-lock.json' with {type:'json'}
import onnxRuntimeNodeLock from './managed-package-locks/onnxruntime-node@1.30.0.package-lock.json' with {type:'json'}

const execFileAsync=promisify(execFile)

const managedPackageLocks:Record<string,ManagedPackageLock>={'@larksuiteoapi/node-sdk@1.74.0':feishuSdkLock,'onnxruntime-node@1.30.0':onnxRuntimeNodeLock}

/** 白名单配方随附的完整 lock（含全部传递依赖）；无随附 lock 返回 undefined。 */
export function managedPackageLock(recipe:ManagedPackageRecipe):ManagedPackageLock|undefined{
 return managedPackageLocks[`${recipe.package}@${recipe.version}`]
}

export function assertAllowedManagedPackage(recipe:ManagedPackageRecipe):void{
 const allowed=managedPackageAllowlist.some(entry=>entry.package===recipe.package&&entry.version===recipe.version&&entry.integrity===recipe.integrity)
 if(!allowed)throw new WorkError('teloa/forbidden','该安装包不在受管安装白名单内。')
}

export function managedPackageDir(root:string,recipe:ManagedPackageRecipe):string{
 return resolve(root,'packages',`${recipe.package.replace(/\//g,'__')}@${recipe.version}`)
}

/**
 * 临时目录超过该时长才视为上次进程崩溃的残留。保留一小时阈值而不是启动时全删：同一运行目录可能有另一宿主进程
 * （例如升级交接期间新旧两个进程、或同机的验收宿主）正在用它安装，按名字一律删除会毁掉对方进行中的安装。
 * 本进程内的超时与失败已在安装路径上同步删掉临时目录，这里只兜底进程在 npm 中途被杀的情形；
 * 一小时远大于 180 秒的安装上限，不会误删仍在进行的安装，代价只是崩溃残留最多多占一小时磁盘。
 */
const staleStagingMs=60*60_000

/** 宿主启动时清扫 root/packages 下残留的 `<包目录>.installing-<uuid>` 临时目录（只删一小时前的）。 */
export async function sweepManagedPackageStaging(root:string,now=Date.now()):Promise<void>{
 const parent=resolve(root,'packages')
 let names:string[]
 try{names=await readdir(parent)}catch{return}
 await Promise.all(names.filter(name=>/\.installing-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)).map(async name=>{
  const path=resolve(parent,name)
  const info=await stat(path).catch(()=>undefined)
  if(info?.isDirectory()&&now-info.mtimeMs>=staleStagingMs)await rm(path,{recursive:true,force:true})
 }))
}

// 包安装依次执行：并发 npm install 会争用缓存与磁盘，也放大恶意配方的资源消耗。受管 MCP 与按需 SDK 共用这一队列。
let installQueue:Promise<unknown>=Promise.resolve()
export function serialInstall<T>(task:()=>Promise<T>):Promise<T>{
 const run=installQueue.then(task,task)
 installQueue=run.catch(()=>{})
 return run
}

// 只传最小必需环境，避免把宿主进程整体环境（凭据、token、内部变量）暴露给 npm 子进程
function npmEnvironment():Record<string,string>{
 const npmEnv:Record<string,string>={}
 for(const key of ['PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMPDIR','TMP','TEMP',
  'NPM_CONFIG_CACHE','NPM_CONFIG_PREFIX','NPM_CONFIG_GLOBALCONFIG',
  'HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy',
  'NODE_EXTRA_CA_CERTS','CAFILE']){
  const v=process.env[key];if(v!==undefined)npmEnv[key]=v
 }
 return npmEnv
}

/**
 * 首次安装（npm ci + 逐条核对）的上限，与建连超时（30 秒）分开计：按需 SDK 与受管 MCP 共用。
 * 取 180 秒的依据：npm ci 要逐个下载并校验 lock 里全部 tarball，首装耗时随包数与网速线性增长——
 * 本机实测 lark-mcp（196 个包）22.8 秒、amap（45 个包）6.6 秒；目录里最大的 lark/notion/exa 为 130–200 个包，
 * 按实测速率在约 1/5 带宽的慢网络上约 2 分钟，180 秒留出余量。之后再连只做毫秒级复核，不受此值影响。
 * 超时以 SIGKILL 终止 npm、清掉半装目录，抛可重试的 install-timeout，不无限占住串行安装队列。
 */
export const managedInstallTimeoutMs=180_000

/** 安装失败的明确错误码（随 WorkError.details 与连接记录下发）：超时与其他失败都可重试。 */
export type ManagedInstallErrorCode='install-timeout'|'install-failed'
const installError=(errorCode:ManagedInstallErrorCode,message:string)=>new WorkError('teloa/dependency-unavailable',message,{errorCode,retryable:true})
export function managedInstallErrorCode(error:unknown):ManagedInstallErrorCode|undefined{
 const code=error instanceof WorkError?error.details?.errorCode:undefined
 return code==='install-timeout'||code==='install-failed'?code:undefined
}

function lockEntries(lock:ManagedPackageLock){
 return Object.entries(lock.packages).filter(([key])=>key!=='')
}

/** 装好的 node_modules/.package-lock.json 与随附 lock 条目集合一致，且逐条 name/version/integrity 相同。 */
async function installedMatchesLock(dir:string,lock:ManagedPackageLock):Promise<boolean>{
 const lockPath=resolve(dir,'node_modules','.package-lock.json')
 if(!existsSync(lockPath))return false
 try{
  const installed=JSON.parse(await readFile(lockPath,'utf8'))
  if(!isRecord(installed)||!isRecord(installed.packages))return false
  const installedPackages=installed.packages
  const expected=lockEntries(lock)
  // 不许多出 lock 之外的条目；optional 条目（平台不符时 npm 跳过）可以缺，装了就必须一致。
  if(Object.keys(installedPackages).some(key=>key!==''&&!Object.hasOwn(lock.packages,key)))return false
  return expected.every(([key,entry])=>{
   const got=installedPackages[key]
   if(got===undefined&&entry.optional===true)return true
   return isRecord(got)&&got.name===entry.name&&got.version===entry.version&&got.integrity===entry.integrity
  })
 }catch{
  return false
 }
}


/**
 * 安装记录：装完且逐条核对通过后写在包目录根（node_modules 之外），记下随附 lock 的摘要与 node_modules 全树摘要。
 * 快路径不信任磁盘上的 .package-lock.json：要求记录存在、lock 摘要等于本次随附 lock，并现场重算全树摘要一致，
 * 否则按随附 lock 重新 npm ci。已知边界：能同时改写 node_modules 与安装记录的本机同用户进程不在防护范围内
 * （目录 0700、位于模型工作区之外）。
 */
const installRecordName='.teloa-install.json'
const lockDigest=(lock:ManagedPackageLock)=>createHash('sha256').update(JSON.stringify(lock)).digest('hex')
/** 全树摘要：按路径排序逐项计入类型、路径、权限位与内容摘要（符号链接计链接目标，不跟随）。 */
async function treeDigest(root:string):Promise<string>{
 const hash=createHash('sha256')
 const walk=async(relative:string):Promise<void>=>{
  for(const name of (await readdir(resolve(root,relative))).sort()){
   const path=relative?relative+'/'+name:name,absolute=resolve(root,path),info=await lstat(absolute)
   if(info.isSymbolicLink())hash.update(`l\0${path}\0${await readlink(absolute)}\0`)
   else if(info.isDirectory()){hash.update(`d\0${path}\0`);await walk(path)}
   else if(info.isFile())hash.update(`f\0${path}\0${(info.mode&0o777).toString(8)}\0${createHash('sha256').update(await readFile(absolute)).digest('hex')}\0`)
   else hash.update(`o\0${path}\0`)
  }
 }
 await walk('')
 return hash.digest('hex')
}
async function installVerified(dir:string,lock:ManagedPackageLock):Promise<boolean>{
 try{
  const record=JSON.parse(await readFile(resolve(dir,installRecordName),'utf8'))
  if(!isRecord(record)||record.lock!==lockDigest(lock)||typeof record.tree!=='string')return false
  if(!(await installedMatchesLock(dir,lock)))return false
  return await treeDigest(resolve(dir,'node_modules'))===record.tree
 }catch{return false}
}


/** 只核对不安装：root/packages 下该配方已按随附 lock 装好且安装记录与全树摘要一致（启用检查用，从不执行 npm）。 */
export async function managedPackageInstalled(root:string,recipe:ManagedPackageRecipe,lock:unknown=managedPackageLock(recipe)):Promise<boolean>{
 return installVerified(managedPackageDir(root,recipe),readManagedPackageLock(lock,recipe))
}

/**
 * 按需受管安装到 root/packages 下并返回安装目录（进串行队列）。
 * 已装目录每次调用都重新核对，通过才直接返回（加载方只能用本函数返回的目录）。
 */
export async function installManagedPackage(root:string,recipe:ManagedPackageRecipe,npmBin='npm',lock:unknown=managedPackageLock(recipe),timeoutMs=managedInstallTimeoutMs):Promise<string>{
 const verifiedLock=readManagedPackageLock(lock,recipe)
 const dir=managedPackageDir(root,recipe)
 if(await installVerified(dir,verifiedLock))return dir
 // 排队期间可能已被前一个相同请求装好：installLockedPackage 先复核。
 return serialInstall(()=>installLockedPackage(dir,recipe,verifiedLock,npmBin,timeoutMs))
}

/**
 * 以随附 lock 在 dir 安装（不排队；调用方负责串行，受管 MCP 已在 serialInstall 内调用）。
 * 先按配方核对 lock；已装且逐条一致直接返回。否则 `npm ci --ignore-scripts` 装到同级临时目录，
 * 逐条核对全部依赖（含传递依赖）的 name/version/integrity 后才改名为 dir；失败删除临时目录，不留半成品。
 * timeoutMs 到时以 SIGKILL 终止 npm，抛 teloa/dependency-unavailable（details.errorCode=install-timeout，可重试），不无限占住串行安装队列。
 */
export async function installLockedPackage(dir:string,recipe:ManagedPackageRecipe,lock:unknown,npmBin='npm',timeoutMs=managedInstallTimeoutMs,onInstall?:()=>unknown):Promise<string>{
 const verifiedLock=readManagedPackageLock(lock,recipe)
 if(await installVerified(dir,verifiedLock))return dir
 // 真正要跑 npm 之前通知调用方（受管 MCP 据此把连接记为「正在安装」）；复核通过的快路径不通知。
 await onInstall?.()
 await mkdir(dirname(dir),{recursive:true,mode:0o700})
 const staging=`${dir}.installing-${randomUUID()}`
 try{
  await mkdir(staging,{mode:0o700})
  const manifest={name:verifiedLock.name,version:verifiedLock.version,private:true,dependencies:verifiedLock.packages['']?.dependencies??{}}
  await writeFile(resolve(staging,'package.json'),JSON.stringify(manifest),'utf8')
  await writeFile(resolve(staging,'package-lock.json'),JSON.stringify(verifiedLock),'utf8')
  // 安全必须项：--ignore-scripts 阻止 postinstall（protobufjs 等带有）执行任意命令；npm ci 只按 lock 取包并校验 integrity。
  await execFileAsync(npmBin,['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:staging,env:npmEnvironment(),timeout:timeoutMs,killSignal:'SIGKILL'}).catch((error:unknown)=>{
   if((error as {killed?:unknown}).killed)throw installError('install-timeout',`安装包 ${recipe.package}@${recipe.version} 超过 ${Math.ceil(timeoutMs/1000)} 秒未装完，已中止并清理未装完的文件；请检查网络后重试。`)
   throw installError('install-failed',`安装包 ${recipe.package}@${recipe.version} 安装失败，已清理未装完的文件；请稍后重试。`)
  })
  if(!(await installedMatchesLock(staging,verifiedLock)))throw installError('install-failed',`安装包 ${recipe.package}@${recipe.version} 依赖核对失败，已清理未装完的文件；请稍后重试。`)
  await writeFile(resolve(staging,installRecordName),JSON.stringify({lock:lockDigest(verifiedLock),tree:await treeDigest(resolve(staging,'node_modules'))}),{encoding:'utf8',mode:0o600})
  await rm(dir,{recursive:true,force:true})
  await rename(staging,dir)
  return dir
 }catch(error){
  await rm(staging,{recursive:true,force:true})
  throw error
 }
}
