import {WorkError,type GroupTaskCreateInput,type GroupDispatchItem} from '@teloa/contract'
import type {GroupRoutingOutboxService} from '@teloa/backend'

export type GroupRoutingOutboxPorts={
 outbox:Pick<GroupRoutingOutboxService,'pending'|'claim'|'assertDispatch'|'taskInput'|'receipt'|'reserveSubmission'|'settle'>
 createTask:(owner:string,input:GroupTaskCreateInput,signal:AbortSignal)=>Promise<{taskId:string}>
 prepare:(owner:string,input:{requestId:string;taskId:string;expectedTaskVersion:number},signal:AbortSignal)=>Promise<{runId:string}>
 /** 复用 TaskRunDriver.start 的持久 claim；禁止适配成直接 prompt。 */
 start:(owner:string,runId:string,signal:AbortSignal)=>Promise<{state:string}>
 readRun:(owner:string,runId:string,signal:AbortSignal)=>Promise<{state:string}>
 /** 只核验原 session/nativeRequestId 的回执，不能发送新输入。 */
 reconcile:(owner:string,runId:string,signal:AbortSignal)=>Promise<{state:string}>
 report:(code:string,item:GroupDispatchItem)=>void
 configurationFailed?:(owner:string,item:GroupDispatchItem,signal:AbortSignal)=>Promise<void>
}
const delivered=(state:string|null)=>state!==null&&['accepted','active','ended','withdrawn','configuration_failed'].includes(state)
const blocked=(error:unknown)=>error instanceof WorkError&&['teloa/forbidden','teloa/invalid-input','teloa/storage-corrupt','teloa/conflict','teloa/version-conflict'].includes(error.code)

/** 每位接收者分别恢复。未知提交只核对原 Run；prepared 才证明未取得原生发送权。 */
export async function drainGroupRoutingOutbox(owner:string,ports:GroupRoutingOutboxPorts,signal:AbortSignal,input:{messageId?:string}={}):Promise<void>{
 const pending=await ports.outbox.pending(owner,input)
 for(const candidate of pending){
  signal.throwIfAborted()
  const claimed=await ports.outbox.claim(owner,{itemId:candidate.id,expectedLeaseGeneration:candidate.leaseGeneration})
  if(!claimed)continue
  const fence={itemId:claimed.id,leaseGeneration:claimed.leaseGeneration}
  try{
   let receipt=await ports.outbox.receipt(owner,{itemId:claimed.id})
   if(receipt.runId){
    const fixed=await ports.readRun(owner,receipt.runId,signal)
    if(fixed.state!=='prepared'){
     const current=delivered(fixed.state)?fixed:await ports.reconcile(owner,receipt.runId,signal)
     receipt=await ports.outbox.receipt(owner,{itemId:claimed.id})
     await ports.outbox.settle(owner,{...fence,...receipt,state:delivered(current.state)&&delivered(receipt.state)?'settled':'unknown',reason:delivered(current.state)?null:'teloa/execution-pending'})
     continue
    }
   }
   await ports.outbox.assertDispatch(owner,fence);signal.throwIfAborted()
   if(!receipt.taskId){await ports.createTask(owner,await ports.outbox.taskInput(owner,{itemId:claimed.id}),signal);receipt=await ports.outbox.receipt(owner,{itemId:claimed.id})}
   if(!receipt.taskId)throw new WorkError('teloa/storage-corrupt','创建任务未留下原请求的可信回执。')
   await ports.outbox.assertDispatch(owner,fence);signal.throwIfAborted()
   if(!receipt.runId){await ports.prepare(owner,{requestId:claimed.requestId,taskId:receipt.taskId,expectedTaskVersion:1},signal);receipt=await ports.outbox.receipt(owner,{itemId:claimed.id})}
   if(!receipt.taskId||!receipt.runId)throw new WorkError('teloa/storage-corrupt','准备运行未留下原请求的可信回执。')
   if(delivered(receipt.state)){
    await ports.outbox.settle(owner,{...fence,taskId:receipt.taskId,runId:receipt.runId,state:'settled',reason:null})
    if(receipt.state==='configuration_failed')await ports.configurationFailed?.(owner,claimed,signal)
    continue
   }
   if(receipt.state!=='prepared')throw new WorkError('teloa/execution-pending','原运行正在提交，必须核对其回执。')
   await ports.outbox.reserveSubmission(owner,{...fence,taskId:receipt.taskId,runId:receipt.runId});signal.throwIfAborted()
   const sent=await ports.start(owner,receipt.runId,signal)
   receipt=await ports.outbox.receipt(owner,{itemId:claimed.id})
   await ports.outbox.settle(owner,{...fence,taskId:receipt.taskId,runId:receipt.runId,state:delivered(sent.state)&&delivered(receipt.state)?'settled':'unknown',reason:delivered(sent.state)?null:'teloa/execution-pending'})
   if(sent.state==='configuration_failed')await ports.configurationFailed?.(owner,claimed,signal)
  }catch(error){
   const code=error instanceof WorkError?error.code:'teloa/dependency-unavailable'
   try{
    const receipt=await ports.outbox.receipt(owner,{itemId:claimed.id})
    // submitting 可能已实际受理；即使调用抛出授权/超时错误，也不能据此将原运行当作未发送。
    const state=delivered(receipt.state)?'settled':receipt.state==='submitting'?'unknown':blocked(error)?'blocked':'unknown'
    await ports.outbox.settle(owner,{...fence,taskId:receipt.taskId,runId:receipt.runId,state,reason:code})
   }catch{/* 断线或旧租约回填失败保留持久期限；恢复worker继续核对，不覆盖新世代。 */}
   try{ports.report(code,claimed)}catch{}
   if(signal.aborted)throw error
  }
 }
}

export type GroupRoutingWakePorts={
 outbox:Pick<GroupRoutingOutboxService,'claimWake'|'settleWake'>
 route:(owner:string,messageId:string,signal:AbortSignal)=>Promise<void>
 report:(code:string)=>void
}
/** 启动恢复及周期唤醒调用；route 失败只保留 wake，不重发已经入库的回复。 */
export async function drainGroupRoutingWakes(owner:string,ports:GroupRoutingWakePorts,signal:AbortSignal):Promise<void>{
 for(let count=0;count<100;count++){
  signal.throwIfAborted();const wake=await ports.outbox.claimWake(owner);if(!wake)return
  try{await ports.route(owner,wake.messageId,signal);await ports.outbox.settleWake(owner,{messageId:wake.messageId,leaseGeneration:wake.leaseGeneration,settled:true})}
  catch(error){try{await ports.outbox.settleWake(owner,{messageId:wake.messageId,leaseGeneration:wake.leaseGeneration,settled:false})}catch{};try{ports.report(error instanceof WorkError?error.code:'teloa/dependency-unavailable')}catch{};if(signal.aborted)throw error}
 }
}
