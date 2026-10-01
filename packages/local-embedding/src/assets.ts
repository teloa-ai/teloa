import {createHash,randomUUID} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {chmod,mkdir,open,readFile,rename,rm,stat,statfs,writeFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {once} from 'node:events'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {withFileLock,writeFileAtomic} from '@deepseek-ai/dsh-atomic-write'
import type {EmbeddingDownloadFailure,EmbeddingDownloadSource} from '@teloa/contract'
import type {OrtSessionOptions} from './inference.ts'

export type EmbeddingVariant='fp32'|'int8'
/** 清单里全部变体：发行只有 fp32；int8、q4、bnb4 只在 `evaluationOnly`，供验收脚本并测（内存评估）。 */
export type AssetVariant=EmbeddingVariant|'q4'|'bnb4'
export type AssetFile={path:string;variant:string;url:string;bytes:number;sha256:string}
/**
 * 可选下载镜像（审查常量）：hostMap 把官方主机精确改写为镜像主机，路径（含固定修订）逐字不变；
 * redirectHosts 按对固定地址的无凭据 HEAD 实测写入——实测 hf-mirror.com 308 回 huggingface.co，再走官方 CDN（*.hf.co）；
 * 另按设计约束放行镜像自有子域 `*.hf-mirror.com`（国内出口可能跳到镜像 CDN，未实测）。只进镜像表，官方来源不放行镜像主机。
 */
export type AssetMirror={id:string;hostMap:Record<string,string>;redirectHosts:string[]}
/** `runtime/assets.json` 的外形（功能验证 固定常量，经代码审查，不从在线目录读取）。 */
export type AssetsManifest={
 allowedHosts:string[]
 /**
  * Hugging Face 固定地址允许跳转到的官方主机：精确名或 `*.<后缀>`（按标签边界匹配，至少多一级子域）。
  * 实测跳转链 huggingface.co → us.aws.cdn.hf.co；其他地区的 CDN 主机同在 hf.co / huggingface.co 下。完整性仍以固定 sha256 为准。
  */
 redirectHosts:string[]
 mirrors:AssetMirror[]
 defaultVariant:string;variants:string[];files:AssetFile[]
 /** 按变体给出的 ORT 会话选项；缺省为空对象（只传 `executionProviders:['cpu']`）。 */
 sessionOptions?:Partial<Record<AssetVariant,OrtSessionOptions>>
 profile:{dimensions:number;pooling:string;normalize:string;maxTokens:number;queryInstruction:string;documentPrefix:string;padTokenId:number;appendedTokenId:number;kvLayers:number;emptyKvShape:number[]}
 evaluationOnly?:{files:AssetFile[]}
}

/** 某变体需要的全部文件：变体自身的 ONNX 与共享分词文件。fp32 以外的变体只来自 `evaluationOnly`（验收开关下并测）。 */
export function variantFiles(manifest:AssetsManifest,variant:AssetVariant):AssetFile[]{
 const own=(variant==='fp32'?manifest.files:manifest.evaluationOnly?.files??[]).filter(file=>file.variant===variant)
 if(own.length===0)throw new Error(`工件清单没有 ${variant} 变体。`)
 return [...own,...manifest.files.filter(file=>file.variant==='shared')]
}

/** 缓存目录名里的工件修订：该变体全部文件路径与 sha256 的摘要前 16 位，任一文件变化即换目录。 */
export function assetsRevision(files:readonly AssetFile[]):string{
 return createHash('sha256').update(files.map(file=>`${file.path}\0${file.sha256}`).sort().join('\n')).digest('hex').slice(0,16)
}
export function assetsCacheDir(manifest:AssetsManifest,variant:AssetVariant,homePath:(...segments:string[])=>string):string{
 return homePath('teloa-models','embedding','qwen3-embedding-0.6b',assetsRevision(variantFiles(manifest,variant)),variant)
}

/** 主机名匹配：`*.hf.co` 只收 `<一级以上子域>.hf.co`，`hf.co.evil.com`、`evilhf.co` 与裸 `hf.co` 都不匹配。 */
export function hostAllowed(host:string,patterns:readonly string[]):boolean{
 return patterns.some(pattern=>pattern.startsWith('*.')?host.length>pattern.length-1&&host.endsWith(pattern.slice(1)):host===pattern)
}

type Reason=EmbeddingDownloadFailure['reason']
/** 下载失败：只带文件相对路径、来源主机与原因分类，信息里不含 URL 查询参数或底层错误原文。 */
export class AssetDownloadError extends Error{
 readonly resource:string
 readonly source:string
 readonly reason:Reason
 constructor(resource:string,source:string,reason:Reason,detail:string){
  super(`模型文件 ${resource}（来源 ${source}）准备失败：${detail}`)
  this.name='AssetDownloadError'
  this.resource=resource
  this.source=source
  this.reason=reason
 }
}

const markerName='.teloa-assets.json'
type Marker={format:'teloa.local-embedding.cache/v1';files:Record<string,{bytes:number;sha256:string;mtimeMs:number}>}
async function readMarker(dir:string):Promise<Marker>{
 try{
  const value=JSON.parse(await readFile(join(dir,markerName),'utf8')) as Marker
  if(value?.format==='teloa.local-embedding.cache/v1'&&value.files&&typeof value.files==='object')return value
 }catch(error){if((error as {code?:unknown}).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error}
 return {format:'teloa.local-embedding.cache/v1',files:{}}
}
/** 文件已按清单校验过：记录的 sha256 与清单一致，磁盘上大小与修改时间与记录一致。 */
async function recorded(dir:string,marker:Marker,file:AssetFile):Promise<boolean>{
 const row=marker.files[file.path]
 if(!row||row.sha256!==file.sha256||row.bytes!==file.bytes)return false
 const info=await stat(join(dir,file.path)).catch(()=>undefined)
 return info!==undefined&&info.isFile()&&info.size===file.bytes&&info.mtimeMs===row.mtimeMs
}

/**
 * 启用检查：只读缓存目录与校验记录，不联网、不读全文件。目录不存在或任一文件未记录为 `missing`；
 * 目录不可读等存储错误照常抛出，由调用方报告。
 */
export async function inspectAssets(dir:string,files:readonly AssetFile[]):Promise<'complete'|'missing'>{
 const marker=await readMarker(dir)
 for(const file of files)if(!(await recorded(dir,marker,file)))return 'missing'
 return 'complete'
}

const sha256Of=async(path:string):Promise<string>=>{
 const hash=createHash('sha256')
 const handle=await open(path)
 try{for await(const chunk of handle.createReadStream())hash.update(chunk as Buffer)}finally{await handle.close()}
 return hash.digest('hex')
}

const errorCode=(error:unknown):string=>{
 for(let current=error,depth=0;current&&depth<4;current=(current as {cause?:unknown}).cause,depth++){
  const code=(current as {code?:unknown}).code
  if(typeof code==='string')return code
 }
 return ''
}
const classify=(error:unknown):Reason=>{
 const code=errorCode(error)
 if(/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME)$/.test(code))return 'dns'
 if(/TIMEOUT|ETIMEDOUT/.test(code))return 'timeout'
 if(/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL/.test(code))return 'certificate'
 if(/^(ENOSPC|EACCES|EPERM|EROFS|EDQUOT|EISDIR|ENOTDIR)$/.test(code))return 'storage'
 if(/^(ECONNRESET|ECONNREFUSED|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET|UND_ERR_CLOSED)$/.test(code)||error instanceof TypeError)return 'network'
 return 'unknown'
}
const describe:Record<Reason,string>={network:'网络连接中断',dns:'域名解析失败',timeout:'连接超时',certificate:'证书校验失败',http:'服务器响应异常',integrity:'文件校验不符',storage:'写入本机磁盘失败',unknown:'未知错误'}

export type PrepareAssetsOptions={
 dir:string;files:readonly AssetFile[];allowedHosts:readonly string[];redirectHosts:readonly string[]
 /** 本次准备的下载来源，缺省官方；选镜像时只用该镜像的主机与跳转表，文件仍按清单大小与 sha256 核对。 */
 source?:EmbeddingDownloadSource;mirrors?:readonly AssetMirror[]
 signal:AbortSignal;onProgress:(state:{resource:string;completedBytes:number;totalBytes:number})=>void
 /** 注入点：默认 Node 全局 fetch（由 dsh-http-proxy 接管代理）；测试注入回环桩。 */
 fetch?:typeof fetch
 /** 注入点：缓存目录所在卷的可用字节数。 */
 freeBytes?:(dir:string)=>Promise<number>
 progressIntervalMs?:number
}
/**
 * 跨进程准备锁：`withFileLock` 负责互斥（锁文件内容为持有者 PID），持有者拿到锁后另写 `.prepare.owner.json`
 * 记下 PID 与进程启动时间。等锁时每轮先核对：持有者进程已不存在，或同一 PID 的启动时间与记录不符（PID 被复用），
 * 即为强杀遗留的孤儿锁，立即接管；活着的持有者（另一进程正在准备）最多等 60 分钟。
 */
const lockWaitMs=60*60_000,lockPollMs=500,guardStaleMs=10_000
const execFileAsync=promisify(execFile)
/** 进程启动时间（`ps -o lstart=`，秒级文本，C 区域设置）；取不到（无 ps、进程不存在）时为 undefined，只按 PID 判定。 */
export async function processStartTime(pid:number):Promise<string|undefined>{
 try{
  const {stdout}=await execFileAsync('ps',['-o','lstart=','-p',String(pid)],{env:{PATH:process.env.PATH??'/bin:/usr/bin',LC_ALL:'C'},timeout:5000})
  return stdout.trim()||undefined
 }catch{return undefined}
}
const ownerAlive=(pid:number):boolean=>{
 if(pid===process.pid)return true
 try{process.kill(pid,0);return true}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH'}
}
/** 锁文件是孤儿时返回它的身份（inode + 纳秒 mtime），否则 undefined；同一句柄上读内容与 stat。 */
async function orphanLockId(lockPath:string,ownerPath:string):Promise<string|undefined>{
 let handle
 try{handle=await open(lockPath,'r')}catch{return undefined}
 try{
  const [text,info]=await Promise.all([handle.readFile('utf8'),handle.stat({bigint:true})])
  const pid=Number.parseInt(text,10),id=`${info.ino}-${info.mtimeNs}`
  if(!Number.isSafeInteger(pid)||pid<=0)return undefined
  if(!ownerAlive(pid))return id
  const owner=JSON.parse(await readFile(ownerPath,'utf8').catch(()=>'null')) as {pid?:unknown;started?:unknown}|null
  if(owner?.pid===pid&&typeof owner.started==='string'){
   const started=await processStartTime(pid)
   if(started!==undefined&&started!==owner.started)return id
  }
  return undefined
 }catch{return undefined}finally{await handle.close()}
}
/**
 * 孤儿锁接管（与主干凭据存储同一做法）：只有以 O_EXCL 建成接管互斥文件的进程才能删锁，且在互斥文件内重新核对
 * 锁身份仍是同一把孤儿锁才删，不会误删别人刚建的新锁；互斥文件超龄说明接管者崩溃在窗口内，改用下一级，最多三级。
 */
async function takeOverOrphanLock(base:string):Promise<void>{
 const lockPath=`${base}.lock`,ownerPath=`${base}.owner.json`,id=await orphanLockId(lockPath,ownerPath)
 if(id===undefined)return
 const guard=(level:number)=>`${lockPath}.takeover-${id}-${level}`
 for(let level=0;level<3;level++){
  try{await writeFile(guard(level),`${process.pid}\n`,{flag:'wx',mode:0o600})}
  catch{
   const age=await stat(guard(level)).then(info=>Date.now()-info.mtimeMs,()=>undefined)
   if(age===undefined||age<guardStaleMs)return
   continue
  }
  try{if(await orphanLockId(lockPath,ownerPath)===id)await rm(lockPath,{force:true})}
  finally{for(let done=level;done>=0;done--)await rm(guard(done),{force:true})}
  return
 }
}
export const assetDownloadReserveBytes=512*1024*1024
const reserveBytes=assetDownloadReserveBytes
const maxRedirects=5

const volumeFree=async(dir:string)=>{const info=await statfs(dir);return Number(info.bavail)*Number(info.bsize)}

type DownloadRoute={mirror:boolean;allowedHosts:readonly string[];redirectHosts:readonly string[];url:(file:AssetFile)=>URL}
/** 按来源定下载地址与主机表：官方即清单原样；镜像只按 hostMap 精确改写主机，未映射的主机原样保留并在主机校验处被拒。 */
function downloadRoute(options:PrepareAssetsOptions):DownloadRoute{
 const source=options.source??'official'
 if(source==='official')return {mirror:false,allowedHosts:options.allowedHosts,redirectHosts:options.redirectHosts,url:file=>new URL(file.url)}
 const mirror=options.mirrors?.find(row=>row.id===source)
 // 契约层已先拦下未知来源；走到这里仍按可识别的下载失败报出，不回显来源名。
 if(!mirror)throw new AssetDownloadError(options.files[0]?.path??'model',options.allowedHosts[0]??'huggingface.co','http','下载来源不在固定清单内，请改用 Hugging Face 官方来源。')
 return {mirror:true,allowedHosts:Object.values(mirror.hostMap),redirectHosts:mirror.redirectHosts,url:file=>{
  const url=new URL(file.url)
  if(Object.hasOwn(mirror.hostMap,url.hostname))url.hostname=mirror.hostMap[url.hostname]!
  return url
 }}
}

/**
 * 显式准备：在跨进程准备锁内逐个下载缺失文件到同目录唯一 `.partial-*`，边收边算 sha256，
 * 大小与摘要都符合清单才原子改名发布并写校验记录；已记录的文件直接复用。下载前检查可用空间 ≥ 待下载声明字节 + 512 MiB。
 * 只接受清单主机上的 https 地址，跳转只放行固定 HF 主机表；响应超过声明字节立即中止。取消与失败都删除半成品。
 */
export async function prepareAssets(options:PrepareAssetsOptions):Promise<void>{
 const {dir,files,signal}=options
 signal.throwIfAborted()
 const route=downloadRoute(options)
 await mkdir(dir,{recursive:true,mode:0o700})
 await chmod(dir,0o700)
 const base=join(dir,'.prepare'),ownerPath=`${base}.owner.json`,deadline=Date.now()+lockWaitMs
 const work=async()=>{
  signal.throwIfAborted()
  const marker=await readMarker(dir)
  const missing:AssetFile[]=[]
  for(const file of files){
   if(await recorded(dir,marker,file))continue
   // 未记录但已在位（例如上次写记录前退出）：重算摘要，符合即补记录，否则删除重下。
   const path=join(dir,file.path)
   const info=await stat(path).catch(()=>undefined)
   if(info?.isFile()&&info.size===file.bytes&&await sha256Of(path)===file.sha256){await record(dir,marker,file);continue}
   await rm(path,{force:true})
   missing.push(file)
  }
  if(missing.length===0)return
  const need=missing.reduce((sum,file)=>sum+file.bytes,0)+reserveBytes
  const free=await (options.freeBytes??volumeFree)(dir)
  if(free<need)throw new AssetDownloadError(missing[0]!.path,route.url(missing[0]!).hostname,'storage',`磁盘空余不足，需要至少 ${need} 字节（待下载 ${need-reserveBytes} 字节另留 512 MiB），当前可用 ${free} 字节。`)
  for(const file of missing)await download(options,route,file,marker)
 }
 const started=await processStartTime(process.pid)
 for(;;){
  signal.throwIfAborted()
  await takeOverOrphanLock(base)
  let acquired=false
  try{
   return await withFileLock(base,async()=>{
    acquired=true
    await writeFile(ownerPath,JSON.stringify({pid:process.pid,...(started?{started}:{})}),{mode:0o600})
    try{await work()}finally{await rm(ownerPath,{force:true})}
   },{waitMs:lockPollMs})
  }catch(error){
   if(acquired)throw error
   const first=files[0]
   // 锁文件本身写不了（权限、只读卷）：本机存储问题；等满上限：另一进程确实在准备。
   if(errorCode(error)!==''||Date.now()>=deadline){
    if(!first)throw error
    throw new AssetDownloadError(first.path,route.url(first).hostname,'storage',errorCode(error)!==''?'缓存目录的准备锁无法写入。':'另一个 Teloa 进程正在准备同一模型，请稍后重试。')
   }
  }
 }
}

async function record(dir:string,marker:Marker,file:AssetFile):Promise<void>{
 const info=await stat(join(dir,file.path))
 marker.files[file.path]={bytes:file.bytes,sha256:file.sha256,mtimeMs:info.mtimeMs}
 await writeFileAtomic(join(dir,markerName),JSON.stringify(marker,null,1)+'\n',{mode:0o600})
}

async function download(options:PrepareAssetsOptions,route:DownloadRoute,file:AssetFile,marker:Marker):Promise<void>{
 const {dir,signal}=options
 const origin=route.url(file)
 const source=origin.hostname
 // 镜像给出的内容与清单不符时，提示改用官方来源，而不是反复重试同一镜像。
 const fail=(reason:Reason,detail?:string)=>new AssetDownloadError(file.path,source,reason,(detail??describe[reason]+'。')+(route.mirror&&reason==='integrity'?'请改用 Hugging Face 官方来源重试。':''))
 if(origin.protocol!=='https:'||!route.allowedHosts.includes(origin.hostname))throw fail('http','下载地址不在固定来源清单内。')
 const target=join(dir,file.path)
 await mkdir(dirname(target),{recursive:true,mode:0o700})
 const partial=`${target}.partial-${randomUUID()}`
 try{
  let url=origin
  let response:Response
  for(let hop=0;;hop++){
   try{response=await (options.fetch??fetch)(url,{redirect:'manual',signal})}
   catch(error){signal.throwIfAborted();throw fail(classify(error))}
   if(response.status<300||response.status>=400)break
   await response.body?.cancel()
   const location=response.headers.get('location')
   const next=location?new URL(location,url):undefined
   if(!next||next.protocol!=='https:'||!(route.allowedHosts.includes(next.hostname)||hostAllowed(next.hostname,route.redirectHosts)))throw fail('http',`下载被重定向到清单外的地址${next?`（${next.protocol}//${next.hostname}）`:''}，已拒绝。`)
   if(hop>=maxRedirects)throw fail('http','重定向次数过多。')
   url=next
  }
  if(response.status!==200){await response.body?.cancel();throw fail('http',`服务器返回 HTTP ${response.status}。`)}
  const declared=response.headers.get('content-length')
  if(declared!==null&&Number(declared)!==file.bytes){await response.body?.cancel();throw fail('integrity',`服务器声明的大小与清单不符。`)}
  if(!response.body)throw fail('http','服务器没有返回内容。')
  const hash=createHash('sha256')
  const out=createWriteStream(partial,{flags:'wx',mode:0o600})
  let received=0,lastReport=0
  const interval=options.progressIntervalMs??100
  try{
   for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){
    received+=chunk.byteLength
    if(received>file.bytes)throw fail('integrity','响应超出声明字节数，已中止。')
    hash.update(chunk)
    if(!out.write(chunk))await once(out,'drain')
    const now=Date.now()
    if(now-lastReport>=interval){lastReport=now;options.onProgress({resource:file.path,completedBytes:received,totalBytes:file.bytes})}
   }
   out.end()
   await once(out,'finish')
  }catch(error){
   out.destroy()
   if(error instanceof AssetDownloadError)throw error
   signal.throwIfAborted()
   throw fail(classify(error))
  }
  if(received!==file.bytes)throw fail('integrity',`文件大小与清单不符（收到 ${received} 字节，应为 ${file.bytes} 字节）。`)
  if(hash.digest('hex')!==file.sha256)throw fail('integrity','SHA-256 与清单不符。')
  options.onProgress({resource:file.path,completedBytes:received,totalBytes:file.bytes})
  try{await rename(partial,target);await record(dir,marker,file)}
  catch{throw fail('storage')}
 }catch(error){
  await rm(partial,{force:true})
  if(error instanceof AssetDownloadError||signal.aborted)throw error
  throw fail(classify(error))
 }
}
