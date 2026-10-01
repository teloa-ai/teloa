import {createServer} from 'node:net'
import {spawn} from 'node:child_process'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import type {InstallState,ProcessIdentity,Status} from './contracts.ts'
import {readPrivateJson,writeInstall} from './state.ts'
import {inspectDatabase,stopDatabase} from './database.ts'
import {command} from './process.ts'

export type ControlRecord=ProcessIdentity&{port:number;secret:string}
export const controlPath=(state:InstallState)=>join(state.layout.instanceRoot,'control.json')
export const sleep=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms))
export const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH'}}
export async function controlRecord(state:InstallState):Promise<ControlRecord|null>{
 let value:any
 try{value=await readPrivateJson(controlPath(state))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw Error('服务身份记录不可读取，拒绝接管。')}
 if(!value||value.installId!==state.id||!Number.isInteger(value.pid)||value.pid<1||!Number.isInteger(value.port)||value.port<1||value.port>65535||typeof value.startedAt!=='string'||typeof value.nonce!=='string'||!/^[a-f0-9]{64}$/.test(value.secret))throw Error('服务身份记录损坏，拒绝接管。')
 return value
}
export async function controlRequest(state:InstallState,action:'status'|'stop'|'open'):Promise<any>{
 const record=await controlRecord(state)
 if(!record)throw Error('服务尚未启动。')
 let response
 try{response=await fetch('http://127.0.0.1:'+record.port+'/'+action,{method:'POST',headers:{authorization:'Bearer '+record.secret,'content-type':'application/json'},body:JSON.stringify({nonce:record.nonce,installId:state.id}),signal:AbortSignal.timeout(action==='stop'?45_000:5000)})}catch{throw Error('服务控制通道失联，无法证明进程身份。')}
 let result:any
 try{result=await response.json()}catch{throw Error('服务身份回包无效。')}
 if(result.nonce!==record.nonce||result.installId!==state.id)throw Error('服务身份回包不符。')
 if(!response.ok||!result.ok)throw Error(typeof result.error==='string'?result.error:'服务操作失败。')
 return result.value
}
export async function portAvailable(port:number):Promise<void>{
 await new Promise<void>((done,fail)=>{
  const server=createServer()
  server.once('error',()=>fail(Error('端口 '+port+' 已被占用或无法绑定；请选择 --port，不会停止占用它的程序。')))
  server.listen(port,'127.0.0.1',()=>server.close(error=>error?fail(error):done()))
 })
}
export async function serviceStatus(state:InstallState):Promise<Status>{
 const base={database:await inspectDatabase(state),version:state.version,port:state.port,activeWork:-1}
 const record=await controlRecord(state)
 if(!record)return {...base,app:'stopped'}
 try{
  const result=await controlRequest(state,'status')
  if(!['starting','ready','failed','stopped','unknown'].includes(result.app)||!Number.isInteger(result.activeWork))throw Error('invalid')
  return {...base,...result}
 }catch{
  if(alive(record.pid))return {...base,app:'unknown'}
  try{await portAvailable(state.port)}catch{return {...base,app:'unknown'}}
  return {...base,app:'stopped'}
 }
}
/** 由调用方持安装互斥锁，涵盖数据库准备与 supervisor 启动。 */
export async function startService(state:InstallState,{timeoutMs=75_000}:{timeoutMs?:number}={}):Promise<Status>{
 if(state.phase==='maintenance')throw Error('安装处于维护状态，不能启动；请用已保存备份恢复到新目录。')
 const status=await serviceStatus(state)
 if(status.app==='ready')return status
 if(status.app==='starting')return waitForReady(state,()=>false,timeoutMs)
 if(status.app==='unknown')throw Error('现有服务失联，无法证明进程身份；拒绝启动第二个实例。')
 await portAvailable(state.port)
 const {runtimeEnvironment}=await import(pathToFileURL(join(state.layout.releaseRoot,'scripts/runtime/profile.mjs')).href)
 await writeInstall({...state,phase:'prepared'})
 const child=spawn(process.execPath,[join(state.layout.releaseRoot,'packages/cli/lib/service-entry.js'),state.layout.home],{cwd:state.layout.workspaceRoot,env:runtimeEnvironment({...state.layout,programRoot:state.layout.releaseRoot,profileName:'teloa'}),detached:true,stdio:'ignore'})
 let spawnError=false
 child.once('error',()=>{spawnError=true})
 child.unref()
 try{return await waitForReady(state,()=>spawnError||child.exitCode!==null||child.signalCode!==null,timeoutMs)}catch(error){
  // 只清理本次亲自创建的进程；先等它退出，调用方才能写入升级失败状态。
  if(child.pid&&child.exitCode===null&&child.signalCode===null){
   child.kill('SIGTERM')
   const deadline=Date.now()+15_000
   while(child.exitCode===null&&child.signalCode===null&&Date.now()<deadline)await sleep(50)
   if(child.exitCode===null&&child.signalCode===null){
    // detached 创建独立进程组；supervisor 卡死时一并结束它的宿主，避免孤儿进程。
    const exited=new Promise<void>(done=>child.once('exit',()=>done()))
    try{process.kill(-child.pid,'SIGKILL')}catch(cause){if((cause as NodeJS.ErrnoException).code!=='ESRCH')throw cause}
    await exited
   }
  }
  throw error
 }
}
async function waitForReady(state:InstallState,exited=()=>false,timeoutMs=75_000):Promise<Status>{
 const deadline=Date.now()+timeoutMs
 while(Date.now()<deadline){
  if(exited())throw Error('后台服务启动失败；请运行 teloa logs 或 doctor 检查。')
  const current=await serviceStatus(state)
  if(current.app==='ready')return current
  if(current.app==='failed')throw Error('应用未通过就绪检查；请运行 teloa logs 检查。')
  await sleep(250)
 }
 throw Error('启动超时；请运行 teloa status 或 logs 查看后台状态。')
}
export async function stopService(state:InstallState):Promise<void>{
 const current=await serviceStatus(state)
 if(current.app==='unknown')throw Error('服务失联，无法证明进程身份；不会向记录的 PID 发送信号。')
 if(current.app!=='stopped')await controlRequest(state,'stop')
 await stopDatabase(state)
 await writeInstall({...state,phase:state.phase==='maintenance'?'maintenance':'stopped'})
}
export async function openService(state:InstallState,{printUrl}:{printUrl:boolean}):Promise<void>{
 const url=await controlRequest(state,'open')
 const parsed=new URL(url)
 if(parsed.origin!=='http://127.0.0.1:'+state.port||parsed.pathname!=='/')throw Error('宿主返回的登录地址不属于当前安装。')
 if(printUrl){console.log(url);return}
 const executable=process.platform==='darwin'?'open':'xdg-open'
 if((await command(executable,[url])).code!==0)throw Error('无法自动打开浏览器；使用 teloa open --print-url 获取本机登录地址。')
}
