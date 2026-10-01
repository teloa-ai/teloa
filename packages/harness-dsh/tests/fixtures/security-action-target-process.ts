import {createServer,type ServerResponse} from 'node:http'
import {readFile,open,rename} from 'node:fs/promises'
import {dirname} from 'node:path'
import {randomUUID} from 'node:crypto'
import type {SecurityActionDispatch} from '@teloa/contract'
import type {TargetState,TargetFaults} from './security-action-conformance.ts'

let store='',token='',defective:string|undefined,state:TargetState={operations:{},requests:[]},faults:TargetFaults={}
let serial:Promise<unknown>=Promise.resolve()
function queued<T>(fn:()=>Promise<T>):Promise<T>{const result=serial.then(fn);serial=result.catch(()=>{});return result}
async function persist(){
 const temp=`${store}.${randomUUID()}.tmp`,file=await open(temp,'wx',0o600)
 try{await file.writeFile(JSON.stringify(state));await file.sync()}finally{await file.close()}
 await rename(temp,store)
 const directory=await open(dirname(store),'r');try{await directory.sync()}finally{await directory.close()}
}
function canonical(value:unknown):string{
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`
 if(value!==null&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
 return JSON.stringify(value)
}
function receipt(dispatch:SecurityActionDispatch,result:'accepted'|'succeeded'|'failed'){
 return {operationId:dispatch.operationId,actionId:dispatch.actionId,receiptId:randomUUID(),state:result,detail:result==='accepted'?'已受理，尚未确认效果。':'已核验目标效果。',targets:dispatch.targets.map(id=>({id,state:result==='accepted'?'unknown':result})),observedAt:new Date().toISOString()}
}
function json(response:ServerResponse,value:unknown,status=200){response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value))}
let barrier:Array<()=>void>=[]
let firstDispatchBarrier:{operationId:string;arrivals:Array<()=>void>}|undefined
const server=createServer(async(request,response)=>{
 try{
  let raw='';for await(const chunk of request)raw+=chunk
  const path=request.url!,method=request.method!,authenticated=request.headers.authorization===`Bearer ${token}`,key=typeof request.headers['idempotency-key']==='string'?request.headers['idempotency-key']:null
  if(method==='POST'&&firstDispatchBarrier?.operationId===key){
   const current=firstDispatchBarrier
   await new Promise<void>(resolve=>{current.arrivals.push(resolve);if(current.arrivals.length===2){firstDispatchBarrier=undefined;for(const release of current.arrivals)release()}})
  }
  // 缺陷目标故意在事务／锁外判断不存在，再让出执行；并发请求可同时作出首次写入决定。
  const absentBeforeLock=method==='POST'&&key!==null&&!state.operations[key]
  if(defective==='concurrent-first-effect')await Promise.resolve()
  const outcome=await queued(async()=>{
   state.requests.push({path,method,key,body:raw,authenticated})
   if(!authenticated){await persist();return {status:401,value:{error:'拒绝访问'}}}
   if(method==='GET'&&path==='/v1/security-actions/capabilities'){await persist();return {status:200,value:{schema:'teloa.security-action-capabilities/v1',idempotency:{key:'operationId',persistence:'durable',sameRequest:'same-operation',differentRequest:'conflict'}}}}
   if(method==='GET'&&path.startsWith('/v1/security-actions/operations/')){
    const operation=state.operations[path.slice('/v1/security-actions/operations/'.length)]
    const lost=faults.loseGet;faults.loseGet=false;await persist()
    return {status:operation?200:404,value:operation?.receipt??{},lost,barrier:!!faults.getBarrier}
   }
   if(method==='POST'&&path==='/v1/security-actions'){
    const dispatch=JSON.parse(raw) as SecurityActionDispatch
    if(key!==dispatch.operationId){await persist();return {status:400,value:{error:'身份不一致'}}}
    const body=canonical(dispatch),existing=state.operations[dispatch.operationId]
    if(existing&&existing.body!==body){await persist();return {status:409,value:{error:'原操作绑定不同内容'}}}
    const mode=faults.mode??'succeeded'
    const operation=existing??{body,receipt:receipt(dispatch,mode),effectCount:mode==='accepted'?0:1}
    if(existing&&(defective==='repeat-effect'||defective==='concurrent-first-effect'&&absentBeforeLock))operation.effectCount++
    state.operations[dispatch.operationId]=operation
    const lost=faults.losePost;faults.losePost=false;await persist()
    return {status:operation.receipt.state==='accepted'?202:200,value:operation.receipt,lost}
   }
   await persist();return {status:404,value:{}}
  })
  if(outcome.barrier){await new Promise<void>(resolve=>{barrier.push(resolve);if(barrier.length===faults.getBarrier){faults.getBarrier=0;const waiting=barrier;barrier=[];for(const release of waiting)release()}})}
  if(outcome.lost){response.destroy();return}
  json(response,outcome.value,outcome.status)
 }catch{json(response,{error:'目标处理失败'},500)}
})
process.on('message',(message:{id:number;command:string;value:unknown})=>{
 void (async()=>{
  let result:unknown=null
  if(message.command==='start'){
   const config=message.value as {store:string;token:string;port:number;defective?:string}
   store=config.store;token=config.token;defective=config.defective
   try{state=JSON.parse(await readFile(store,'utf8')) as TargetState}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
   if(defective==='volatile')state.operations={}
   await persist();await new Promise<void>(resolve=>server.listen(config.port,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error();result={port:address.port}
  }else if(message.command==='armConcurrentDispatch'){
   const input=message.value as {operationId:string}
   if(firstDispatchBarrier||state.operations[input.operationId])throw Error()
   firstDispatchBarrier={operationId:input.operationId,arrivals:[]}
  }else if(message.command==='configure'){faults={...faults,...message.value as TargetFaults}}
  else if(message.command==='settle'){
   const input=message.value as {operationId:string;state:'succeeded'|'failed'}
   await queued(async()=>{const operation=state.operations[input.operationId];if(!operation)throw Error();if(operation.receipt.state==='accepted'){operation.receipt=receipt(JSON.parse(operation.body) as SecurityActionDispatch,input.state);operation.effectCount++;await persist()}})
  }else throw Error()
  process.send?.({id:message.id,value:result})
 })().catch(()=>process.send?.({id:message.id,error:true}))
})
