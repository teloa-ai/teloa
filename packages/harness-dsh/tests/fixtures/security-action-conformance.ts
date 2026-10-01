import assert from 'node:assert/strict'
import {fork,type ChildProcess} from 'node:child_process'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {SecurityActionHttpAdapter} from '../../src/security-action-http-adapter.ts'
import type {SecurityActionAdapter} from '../../src/security-action-execution.ts'
import type {SecurityActionDispatch} from '@teloa/contract'

export type TargetState={
 operations:Record<string,{body:string;receipt:Record<string,unknown>;effectCount:number}>
 requests:Array<{method:string;path:string;key:string|null;body:string;authenticated:boolean}>
}
export type TargetFaults={mode?:'accepted'|'succeeded'|'failed';losePost?:boolean;loseGet?:boolean;getBarrier?:number}
/** 外部测试环境可实现同一控制端口；所有控制都必须指向实际 adapter 使用的同一目标与存储。 */
export type SecurityActionConformanceTarget={
 adapter():SecurityActionAdapter
 restart():Promise<void>
 snapshot():Promise<TargetState>
 pid():number
 /** 在实际 HTTP 入口等待同一新 operation 的两个首次 POST 到齐，再同时放行。 */
 armConcurrentDispatch(operationId:string):Promise<void>
}

/** 同一环境/版本部署门禁：能力声明本身不能满足这些持久行为断言。 */
export async function runSecurityActionConformance(target:SecurityActionConformanceTarget,dispatch:SecurityActionDispatch){
 const signal=()=>new AbortController().signal
 let adapter=target.adapter()
 assert.deepEqual(await adapter.ready(signal()),{ready:true})
 assert.equal(await adapter.observe(dispatch,signal()),null)
 const first=await adapter.execute(dispatch,signal())
 assert.equal(first.status,'succeeded')
 assert.deepEqual(await adapter.execute(structuredClone(dispatch),signal()),first)
 assert.equal((await target.snapshot()).operations[dispatch.operationId]?.effectCount,1)
 await assert.rejects(adapter.execute({...dispatch,params:{...dispatch.params,reason:'不同内容必须冲突'}},signal()),{code:'teloa/conflict'})
 const beforePid=target.pid();await target.restart();const afterPid=target.pid()
 assert.notEqual(beforePid,afterPid)
 adapter=target.adapter()
 assert.deepEqual(await adapter.ready(signal()),{ready:true})
 assert.deepEqual(await adapter.observe(dispatch,signal()),first)
 assert.deepEqual(await adapter.execute(dispatch,signal()),first)
 const operation=(await target.snapshot()).operations[dispatch.operationId]
 assert.equal(operation?.effectCount,1)
 assert.deepEqual(JSON.parse(operation!.body),dispatch)
 // 顺序场景已经写过原 operation，不能用它证明首次写入的并发互斥。
 const concurrent={...structuredClone(dispatch),operationId:randomUUID(),actionId:randomUUID()}
 assert.equal((await target.snapshot()).operations[concurrent.operationId],undefined)
 assert.equal(await adapter.observe(concurrent,signal()),null)
 await target.armConcurrentDispatch(concurrent.operationId)
 const [left,right]=await Promise.all([
  adapter.execute(structuredClone(concurrent),signal()),
  target.adapter().execute(structuredClone(concurrent),signal()),
 ])
 assert.equal(left.status,'succeeded')
 assert.deepEqual(left,right)
 const concurrentState=await target.snapshot(),concurrentOperation=concurrentState.operations[concurrent.operationId]
 assert.equal(concurrentOperation?.effectCount,1)
 assert.deepEqual(JSON.parse(concurrentOperation!.body),concurrent)
 const posts=concurrentState.requests.filter(request=>request.method==='POST'&&request.key===concurrent.operationId)
 assert.equal(posts.length,2)
 assert.equal(posts[0]!.body,posts[1]!.body)
 for(const post of posts){assert.equal(post.authenticated,true);assert.deepEqual(JSON.parse(post.body),concurrent)}
 assert.deepEqual(await adapter.observe(concurrent,signal()),left)
 const concurrentBeforePid=target.pid();await target.restart();const concurrentAfterPid=target.pid()
 assert.notEqual(concurrentBeforePid,concurrentAfterPid)
 adapter=target.adapter()
 assert.deepEqual(await adapter.ready(signal()),{ready:true})
 assert.deepEqual(await adapter.observe(concurrent,signal()),left)
 assert.equal((await target.snapshot()).operations[concurrent.operationId]?.effectCount,1)
 assert.deepEqual(await adapter.execute(concurrent,signal()),left)
 assert.equal((await target.snapshot()).operations[concurrent.operationId]?.effectCount,1)
 return {effectCount:operation!.effectCount,beforePid,afterPid,concurrentOperationId:concurrent.operationId,concurrentBeforePid,concurrentAfterPid}
}

/** 真子进程、随机 loopback 端口、独立目录；重启通过 SIGKILL，不复用进程内 Map。 */
export async function persistentSecurityActionTarget(options:{token:string;defective?:'repeat-effect'|'volatile'|'concurrent-first-effect'}){
 const directory=await mkdtemp(join(tmpdir(),'teloa-security-target-')),store=join(directory,'target.json')
 let child:ChildProcess,port=0,nextId=0
 const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
 async function call(command:string,value?:unknown):Promise<unknown>{
  const id=++nextId
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('目标控制请求超时。 '))},5000);pending.set(id,{resolve,reject,timer});child.send({id,command,value})})
 }
 async function start(){
  child=fork(new URL('./security-action-target-process.ts',import.meta.url),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']})
  child.on('message',(message:unknown)=>{const result=message as {id:number;value:unknown;error?:boolean},item=pending.get(result.id);if(!item)return;pending.delete(result.id);clearTimeout(item.timer);if(result.error)item.reject(Error('目标控制请求失败。'));else item.resolve(result.value)})
  child.on('exit',()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('目标进程已退出。'))}pending.clear()})
  const started=await call('start',{store,port,token:options.token,defective:options.defective}) as {port:number}
  port=started.port
 }
 async function stop(){if(child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.kill('SIGKILL');await exited}
 try{await start()}catch(error){if(child!)await stop();await rm(directory,{recursive:true,force:true});throw error}
 return {
  connection:()=>({baseUrl:`http://127.0.0.1:${port}`,token:options.token}),
  adapter:()=>new SecurityActionHttpAdapter({baseUrl:`http://127.0.0.1:${port}`,token:options.token}),
  pid:()=>child.pid!,
  armConcurrentDispatch:async(operationId:string)=>{await call('armConcurrentDispatch',{operationId})},
  restart:async()=>{await stop();await start()},
  configure:async(faults:TargetFaults)=>{await call('configure',faults)},
  settle:async(operationId:string,state:'succeeded'|'failed')=>{await call('settle',{operationId,state})},
  snapshot:async():Promise<TargetState>=>JSON.parse(await readFile(store,'utf8')) as TargetState,
  close:async()=>{await stop();await rm(directory,{recursive:true,force:true})},
 }
}
