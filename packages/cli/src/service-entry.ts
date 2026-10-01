import {createServer} from 'node:http'
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {appendFile,mkdir,stat,rename} from 'node:fs/promises'
import {readInstall,writeInstall,writePrivateJson} from './state.ts'
import {resolveLayout,programRoot} from './layout.ts'
import {verifyRelease} from './releases.ts'
import {prepareNativeLoader} from './native-loader-compat.ts'
import {controlPath,sleep} from './service.ts'
import {databasePool,inspectDatabase} from './database.ts'
import {RuntimeOutput,redactLog} from './diagnostics.ts'
import type {InstallState,Status} from './contracts.ts'

export async function runSupervisor(home:string):Promise<void>{
 process.umask(0o077)
 const manifest=await verifyRelease(programRoot)
 const layout=await resolveLayout({home,version:manifest.version})
 const state=await readInstall(layout)
 if(!state||state.version!==manifest.version||state.phase!=='prepared')throw Error('安装状态与后台服务启动请求不一致。')
 const identity={pid:process.pid,startedAt:new Date().toISOString(),nonce:randomUUID(),installId:state.id}
 const secret=randomBytes(32).toString('hex'),logPath=join(state.layout.instanceRoot,'service.log')
 let logQueue=Promise.resolve()
 const log=(text:string)=>{logQueue=logQueue.then(async()=>{
  if(await stat(logPath).then(s=>s.size>5*1024*1024,()=>false))await rename(logPath,logPath+'.1')
  await appendFile(logPath,redactLog(text),{mode:0o600})
 }).catch(()=>{})}
 let app:Status['app']='starting',startupUrl:string|undefined,cookie:string|undefined,child:ReturnType<typeof import('node:child_process').spawn>|undefined,stopping=false
 const origin='http://127.0.0.1:'+state.port
 const readiness=await import(pathToFileURL(join(programRoot,'scripts/核对宿主就绪.mjs')).href)
 async function rpc(channel:string,method:string):Promise<any>{
  if(!cookie)throw Error('宿主尚未就绪。')
  const rpcId=randomUUID()
  const response=await fetch(origin+channel+'/'+method,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({type:'client-request',rpcId,method,payload:{}}),signal:AbortSignal.timeout(5000)})
  const result=await response.json() as any
  if(!response.ok||result.rpcId!==rpcId||result.result?.ok!==true)throw Error('无法读取运行中工作；已停止维护操作。')
  return result.result.value
 }
 async function activeWork():Promise<number>{
  if(app!=='ready')throw Error('宿主尚未就绪，无法检查运行中工作。')
  const activity=await rpc('/teloa-local-runtime','activity')
  if(!Number.isInteger(activity?.active)||activity.active<0)throw Error('完整运行状态不可读取。')
  const pool=await databasePool(state!)
  try{
   const runs=await pool.query("select count(*)::integer as n from teloa_task_runs where state in ('prepared','submitting','accepted','active')")
   return activity.active+runs.rows[0].n
  }finally{await pool.end()}
 }
 async function snapshot(){
  let active=-1
  if(app==='ready')try{await readiness.probeTeloaChannel(origin,cookie,{timeout:3000});active=await activeWork()}catch{/* 未知不得作为空闲使用。 */}
  return {app:app==='ready'&&active<0?'unknown':app,activeWork:active,database:await inspectDatabase(state!),version:state!.version,port:state!.port}
 }
 let endingChild:Promise<void>|undefined
 async function endChild(){
  if(endingChild)return endingChild
  if(!child||child.exitCode!==null||child.signalCode!==null)return
  return endingChild=(async()=>{
  child.kill('SIGTERM')
  const deadline=Date.now()+10_000
  while(child.exitCode===null&&child.signalCode===null&&Date.now()<deadline)await sleep(100)
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise<void>(done=>child!.once('exit',()=>done()))}
  })()
 }
 const server=createServer(async(req,res)=>{
  const reply=(code:number,value:any)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({...identity,...value}))}
  const supplied=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+secret)
  if(req.method!=='POST'||req.headers.origin||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(403);res.end();return}
  try{
   let body=''
   for await(const chunk of req){body+=chunk;if(body.length>4096)throw Error('控制请求过大。')}
   const request=JSON.parse(body)
   if(request.installId!==state!.id||request.nonce!==identity.nonce)throw Error('控制请求身份不符。')
   if(req.url==='/status')reply(200,{ok:true,value:await snapshot()})
   else if(req.url==='/open'){
    if(app!=='ready'||!startupUrl)throw Error('宿主尚未就绪。')
    reply(200,{ok:true,value:startupUrl})
   }else if(req.url==='/stop'){
    if(stopping)throw Error('服务正在停止。')
    if(app==='starting')throw Error('服务仍在启动，请稍后检查状态。')
    stopping=true
    try{
     if(app==='ready'){
      await rpc('/teloa-local-runtime','quiesce')
      if(await activeWork()>0)throw Error('仍有运行中工作，请先在 Web 中收尾后再停止。')
      await rpc('/teloa-local-runtime','sealed')
     }
    }catch(error){await rpc('/teloa-local-runtime','resume').catch(()=>{});stopping=false;throw error}
    await endChild();app='stopped'
    await writeInstall({...state!,phase:'stopped'})
    reply(200,{ok:true,value:null});server.close();await logQueue
   }else reply(404,{ok:false,error:'不支持的控制命令。'})
  }catch(error){reply(409,{ok:false,error:redactLog((error as Error).message)})}
 })
 // 在任何宿主启动动作之前注册；取消后退出 supervisor，不让异步准备继续启动宿主。
 const terminate=()=>{stopping=true;void endChild().finally(async()=>{server.close();await logQueue;process.exit(0)})}
 process.once('SIGTERM',terminate);process.once('SIGINT',terminate)
 async function assertStartupCurrent(){
  const current=await readInstall(layout)
  if(stopping||!current||current.id!==state!.id||current.version!==state!.version||current.phase!=='prepared')throw Error('后台启动请求已失效。')
 }
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
 await writePrivateJson(controlPath(state),{...identity,port:(server.address() as any).port,secret})
 const fail=async(message:string)=>{
  app='failed';log('启动失败：'+message+'\n');await endChild()
  if(!stopping){const current=await readInstall(layout);if(current?.id===state!.id&&current.version===state!.version&&current.phase==='prepared')await writeInstall({...state!,phase:'failed'})}
 }
 try{
  await prepareNativeLoader(programRoot)
  const {verifyDshPackages}=await import(pathToFileURL(join(programRoot,'scripts/核对DSH依赖.mjs')).href)
  verifyDshPackages()
  const runtime=await import(pathToFileURL(join(programRoot,'scripts/runtime/profile.mjs')).href)
  const runtimeLayout={...state.layout,programRoot,profileName:'teloa'}
  await runtime.prepareRuntimeProfile(runtimeLayout)
  await assertStartupCurrent()
  child=runtime.launchRuntime(runtimeLayout,{port:state.port})
  let resolveUrl:(url:string)=>void,rejectUrl:(error:Error)=>void
  const urlReady=new Promise<string>((resolve,reject)=>{resolveUrl=resolve;rejectUrl=reject})
  // 先处理原始完整行提取本机令牌，再脱敏持久化；原始输出不落盘。
  const lines=new RuntimeOutput(log,line=>{const url=readiness.findStartupUrl(line,'127.0.0.1:'+state.port);if(url&&!startupUrl){startupUrl=url;resolveUrl(url)}})
  child!.stdout!.on('data',chunk=>lines.write('stdout',chunk));child!.stderr!.on('data',chunk=>lines.write('stderr',chunk))
  child!.once('error',()=>rejectUrl(Error('宿主进程无法启动。')))
  child!.once('exit',()=>{lines.end();if(!stopping){app='failed';rejectUrl(Error('宿主进程提前退出。'));log('宿主已退出，请检查日志后重新启动。\n')}})
  const timer=setTimeout(()=>rejectUrl(Error('宿主未在时限内提供启动地址。')),45_000)
  try{
   const url=await urlReady
   cookie=await readiness.authorizeSession(url)
   const deadline=Date.now()+20_000
   for(;;){try{await readiness.probeTeloaChannel(origin,cookie,{timeout:3000});break}catch(error){if(!(error as any).mounting||Date.now()>deadline)throw error;await sleep(250)}}
   await rpc('/teloa-local-runtime','readiness')
   await assertStartupCurrent()
   app='ready';await writeInstall({...state,phase:'ready'});log('Teloa 已就绪：'+origin+'\n')
  }finally{clearTimeout(timer)}
 }catch(error){if(!stopping)await fail(redactLog((error as Error).message))}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 runSupervisor(process.argv[2]!).catch(()=>{process.exitCode=1})
}
