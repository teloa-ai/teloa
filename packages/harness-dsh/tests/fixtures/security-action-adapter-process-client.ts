import {fork} from 'node:child_process'
import {once} from 'node:events'
import type {SecurityExecutionReceipt} from '@teloa/contract'

/** 多个真实宿主子进程只读同一份已落盘派发，不把前一实例的内存交给后一实例。 */
export async function runAdapterProcess(connection:{baseUrl:string;token:string},dispatchFile:string,method:'execute'|'observe'){
 const child=fork(new URL('./security-action-adapter-process.ts',import.meta.url),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']})
 const exited=once(child,'exit')
 try{
  const result=await new Promise<{pid:number;receipt:SecurityExecutionReceipt|null}>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('宿主进程核验超时。')),5000)
   child.once('error',()=>{clearTimeout(timer);reject(Error('宿主进程无法启动。'))})
   child.once('exit',()=>{clearTimeout(timer);reject(Error('宿主进程未返回结果。'))})
   child.once('message',(message:unknown)=>{clearTimeout(timer);const row=message as {error?:boolean;pid:number;receipt:SecurityExecutionReceipt|null};if(row.error)reject(Error('宿主进程核验失败。'));else resolve({pid:row.pid,receipt:row.receipt})})
   child.send({...connection,dispatchFile,method})
  })
  await exited
  return result
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited}}
}
