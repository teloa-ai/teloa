import {createHash} from 'node:crypto'
import {WorkError,MARKET_CATALOG_MAX_FILE_SIZE,MARKET_CATALOG_MAX_TOTAL_SIZE,MARKET_CATALOG_MAX_FILES,MARKET_CATALOG_FORBIDDEN_EXTENSIONS} from '@teloa/contract'
import type {MarketCatalogUpstreamClawHub} from '@teloa/contract'

const CLAWHUB_HOST='clawhub.ai'
const CLAWHUB_BASE=`https://${CLAWHUB_HOST}`
// 单文件时限：防上游对某个文件不回包或慢速滴流，把整次安装拖住。单文件上限 2 MiB，
// 30 秒相当于最低约 70 KB/s，正常网络远用不到；超过即视为上游不可用。
const FILE_TIMEOUT_MS=30_000
// 总时限 = 基础 + 每文件 × 文件数：防整次下载无限拖延，同时让耗时额度与实际要装的文件数成正比。
// 基础 120 秒沿用原固定总时限，保证小技能不比以前更严；每文件 0.5 秒让 500 个文件（上限）最多再加 250 秒。
const BASE_DEADLINE_MS=120_000
const PER_FILE_MS=500
// 并发数：防同时对 ClawHub 开过多连接；4 路足以让小文件流水取完。
const CONCURRENCY=4

const sha256=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex')
const unavailable=(msg:string)=>new WorkError('teloa/source-unavailable',msg)

function validateClawHubUrl(url:string):void{
 let parsed:URL
 try{parsed=new URL(url)}catch{throw unavailable('ClawHub 请求地址无效。')}
 if(parsed.protocol!=='https:')throw unavailable('ClawHub 请求地址必须使用 HTTPS。')
 if(parsed.hostname!==CLAWHUB_HOST)throw unavailable('ClawHub 请求地址主机不在白名单内。')
 if(parsed.port)throw unavailable('ClawHub 请求地址不允许指定端口。')
 if(parsed.username||parsed.password)throw unavailable('ClawHub 请求地址不允许包含用户信息。')
}

function validateFilePath(filePath:string):void{
 if(MARKET_CATALOG_FORBIDDEN_EXTENSIONS.test(filePath))throw unavailable('ClawHub 文件路径包含禁止扩展名。')
 const parts=filePath.split('/')
 if(parts.some(p=>p.startsWith('.')))throw unavailable('ClawHub 文件路径不允许含点文件或隐藏目录。')
}

/** 从 ClawHub 拉取一个文件，核对 sha256 和 size，返回字节。边读边计数，超过上限即中止。 */
async function fetchClawHubFile(
 slug:string,owner:string,version:string,filePath:string,
 expectedSha256:string,expectedSize:number,
 signal:AbortSignal,
 fetchImpl:typeof fetch,
):Promise<{path:string;bytes:Uint8Array}>{
 if(expectedSize>MARKET_CATALOG_MAX_FILE_SIZE)throw unavailable(`ClawHub 文件声明大小超过 2 MiB 上限：${filePath}`)
 validateFilePath(filePath)
 const url=`${CLAWHUB_BASE}/api/v1/skills/${encodeURIComponent(slug)}/file?owner=${encodeURIComponent(owner)}&version=${encodeURIComponent(version)}&path=${encodeURIComponent(filePath)}`
 validateClawHubUrl(url)
 let response:Response
 try{response=await fetchImpl(url,{signal,redirect:'error'})}catch(err){
  if(err instanceof Error&&err.name==='AbortError')throw unavailable('ClawHub 请求超时。')
  throw unavailable('ClawHub 连接失败。')
 }
 if(!response.ok){
  // 报错前主动关掉响应体，不靠随后的整体中止连带回收连接。
  await response.body?.cancel().catch(()=>{})
  if(response.status===404)throw unavailable(`ClawHub 文件不存在：${filePath}`)
  throw unavailable(`ClawHub 返回 HTTP ${response.status}。`)
 }
 const reader=response.body?.getReader()
 if(!reader)throw unavailable('ClawHub 响应体不可读。')
 // 回包不可信：响应头已回、响应体卡住时，不依赖 fetch 实现把 signal 绑到 body，自己在中止时取消读取。
 const cancelOnAbort=()=>{reader.cancel().catch(()=>{})}
 signal.addEventListener('abort',cancelOnAbort,{once:true})
 if(signal.aborted)cancelOnAbort()
 const chunks:Uint8Array[]=[]
 let totalRead=0
 try{
  while(true){
   const {done,value}=await reader.read()
   if(done)break
   totalRead+=value.byteLength
   if(totalRead>MARKET_CATALOG_MAX_FILE_SIZE){
    try{await reader.cancel()}catch{/* 取消时忽略异常 */}
    throw unavailable(`ClawHub 文件超过 2 MiB 上限：${filePath}`)
   }
   chunks.push(value)
  }
 }catch(err){
  if(err instanceof WorkError)throw err
  throw unavailable('ClawHub 响应体读取失败。')
 }finally{
  signal.removeEventListener('abort',cancelOnAbort)
 }
 // 取消后 read 会以 done 结束，不能当作读完。
 if(signal.aborted)throw unavailable('ClawHub 请求超时。')
 const bytes=new Uint8Array(totalRead)
 let offset=0
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
 if(bytes.byteLength!==expectedSize)throw unavailable(`ClawHub 文件大小不一致：${filePath}（期望 ${expectedSize}，实际 ${bytes.byteLength}）`)
 const actual=sha256(bytes)
 if(actual!==expectedSha256)throw unavailable(`ClawHub 文件摘要不一致：${filePath}`)
 return {path:filePath,bytes}
}

/** 拉取 ClawHub 技能的所有文件，逐文件核对 sha256 和 size。
 * 4 路工作池逐个取文件，每个文件单独计时；任一文件失败即中止其余请求。
 * options 仅供测试注入。 */
export async function downloadClawHubSkill(
 source:MarketCatalogUpstreamClawHub,
 options:{fileTimeoutMs?:number;baseDeadlineMs?:number;perFileMs?:number;fetch?:typeof fetch}={},
):Promise<{path:string;bytes:Uint8Array}[]>{
 const {owner,slug,version,files}=source
 if(!files.length)throw unavailable('上游资源无文件列表。')
 if(files.length>MARKET_CATALOG_MAX_FILES)throw unavailable(`上游资源文件数超过 ${MARKET_CATALOG_MAX_FILES} 上限。`)
 const totalDeclaredSize=files.reduce((sum,f)=>sum+f.size,0)
 if(totalDeclaredSize>MARKET_CATALOG_MAX_TOTAL_SIZE)throw unavailable('上游资源声明总大小超过 20 MiB 上限。')
 const fileTimeoutMs=options.fileTimeoutMs??FILE_TIMEOUT_MS
 const deadlineMs=(options.baseDeadlineMs??BASE_DEADLINE_MS)+(options.perFileMs??PER_FILE_MS)*files.length
 const fetchImpl=options.fetch??fetch
 const overall=new AbortController()
 let deadlineHit=false
 const timer=setTimeout(()=>{deadlineHit=true;overall.abort()},deadlineMs)
 const results:{path:string;bytes:Uint8Array}[]=new Array(files.length)
 let next=0
 let failure:WorkError|undefined
 const worker=async()=>{
  while(!failure&&next<files.length){
   const index=next++
   const file=files[index]!
   const fileTimeout=AbortSignal.timeout(fileTimeoutMs)
   try{
    results[index]=await fetchClawHubFile(slug,owner,version,file.path,file.sha256,file.size,AbortSignal.any([overall.signal,fileTimeout]),fetchImpl)
   }catch(err){
    if(failure)return
    failure=deadlineHit?unavailable(`ClawHub 下载总时长超限（${files.length} 个文件）`)
     :fileTimeout.aborted?unavailable(`ClawHub 文件下载超时：${file.path}`)
     :err instanceof WorkError?err
     :unavailable('ClawHub 文件下载失败。')
    overall.abort()
    return
   }
  }
 }
 try{
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,files.length)},worker))
 }finally{
  clearTimeout(timer)
 }
 if(failure)throw failure
 return results
}
