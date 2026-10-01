import {scrubbedParentEnv,type SubprocessHandle,type SubprocessSpawnSpec} from '@deepseek-ai/dsh-subprocess'
import type {EmbeddingEngine,EmbeddingKind} from './service.ts'
import type {WorkerConfig} from './inference.ts'

/** 推理子进程只需要这些环境变量：可执行路径、临时目录、区域与时区（Windows 另需系统目录）。 */
const workerEnvNames=['PATH','HOME','USERPROFILE','TMPDIR','TMP','TEMP','LANG','LC_ALL','LC_CTYPE','TZ','SYSTEMROOT','WINDIR']
/**
 * 白名单构造子进程环境：`ctx.subprocess` 以官方清洗后的父环境为底再合入 spec.env，这里把底里白名单外的每个名字
 * 都写成 undefined 墓碑移除（含宿主从工作区 .env 合入的 OMP_*、ORT_*、NODE_OPTIONS、代理等），只留必需变量与 ELECTRON_RUN_AS_NODE。
 */
export function workerEnvironment(parent:Readonly<Record<string,string|undefined>>=process.env):NodeJS.ProcessEnv{
 const env:NodeJS.ProcessEnv={}
 for(const name of new Set([...Object.keys(parent),...Object.keys(scrubbedParentEnv())]))env[name]=undefined
 for(const name of workerEnvNames){const value=parent[name];if(value!==undefined)env[name]=value}
 env.ELECTRON_RUN_AS_NODE='1'
 return env
}

/** 单行帧上限：32 条 × 1024 维 float32 的 base64 约 175 KB，留足余量。 */
const maxLineBytes=1024*1024

/**
 * 以 `process.execPath <worker> <config>` 经宿主 `ctx.subprocess.spawn` 启动推理子进程（环境按白名单构造，
 * 见 workerEnvironment），等到 `{"ready":true}` 再返回。之后每次 embed 写一行请求、读一行响应；
 * 格式错、错误类别、进程退出或截止时间到都拒绝，由调用方回收进程。
 */
export async function startWorkerEngine(options:{spawn:(spec:SubprocessSpawnSpec)=>SubprocessHandle;workerPath:string;config:WorkerConfig;cwd:string;signal:AbortSignal;graceMs?:number}):Promise<EmbeddingEngine>{
 options.signal.throwIfAborted()
 const handle=options.spawn({
  argv:[process.execPath,options.workerPath,JSON.stringify(options.config)],
  cwd:options.cwd,
  graceMs:options.graceMs??2000,
  env:workerEnvironment(),
  stdio:{stdin:'pipe',stdout:'pipe',stderr:{maxBytes:64*1024}},
 })
 let exited=false
 const done=handle.done.then(()=>{exited=true},()=>{exited=true})
 const waiters:((line:string|undefined)=>void)[]=[]
 const lines:string[]=[]
 let buffer=''
 let broken=false
 const push=(line:string|undefined)=>{const waiter=waiters.shift();if(waiter)waiter(line);else if(line!==undefined)lines.push(line)}
 handle.stdout!.setEncoding('utf8')
 handle.stdout!.on('data',(chunk:string)=>{
  buffer+=chunk
  for(let end=buffer.indexOf('\n');end>=0;end=buffer.indexOf('\n')){push(buffer.slice(0,end));buffer=buffer.slice(end+1)}
  if(buffer.length>maxLineBytes){broken=true;buffer='';handle.terminate()}
 })
 void done.then(()=>{while(waiters.length)push(undefined)})
 handle.stdin!.on('error',()=>{})
 const next=(signal:AbortSignal)=>new Promise<string>((resolve,reject)=>{
  if(lines.length){resolve(lines.shift()!);return}
  if(exited||broken){reject(new Error('推理进程已退出。'));return}
  const abort=()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(signal.reason)}
  const waiter=(line:string|undefined)=>{signal.removeEventListener('abort',abort);line===undefined?reject(new Error('推理进程已退出。')):resolve(line)}
  signal.addEventListener('abort',abort,{once:true})
  waiters.push(waiter)
 })
 const close=async()=>{
  handle.stdin?.end()
  handle.terminate()
  await handle.waitForExit().catch(()=>false)
  await done
 }
 try{
  const ready=JSON.parse(await next(options.signal)) as unknown
  if(typeof ready!=='object'||ready===null||(ready as {ready?:unknown}).ready!==true)throw new Error('推理进程就绪帧格式不正确。')
 }catch(error){
  await close()
  if(options.signal.aborted)throw options.signal.reason
  throw error instanceof SyntaxError?new Error('推理进程就绪帧格式不正确。'):error
 }
 let sequence=0
 const dimensions=options.config.dimensions
 return {
  exited:done,
  close,
  async embed(kind:EmbeddingKind,texts:string[],signal:AbortSignal){
   const id=++sequence
   handle.stdin!.write(JSON.stringify({id,kind,texts})+'\n')
   const response=JSON.parse(await next(signal)) as {id?:unknown;vectors?:unknown;truncated?:unknown;error?:unknown}
   if(response.id!==id)throw new Error('推理响应与请求不对应。')
   if(response.error!==undefined)throw new Error('推理进程报告失败。')
   if(typeof response.vectors!=='string'||!Number.isSafeInteger(response.truncated))throw new Error('推理响应格式不正确。')
   const bytes=Buffer.from(response.vectors,'base64')
   if(bytes.byteLength!==texts.length*dimensions*4)throw new Error('推理响应向量长度不符。')
   const flat=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength))
   return {vectors:texts.map((_,index)=>flat.slice(index*dimensions,(index+1)*dimensions)),truncated:response.truncated as number}
  },
 }
}
