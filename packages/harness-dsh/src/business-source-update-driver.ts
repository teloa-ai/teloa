import {WorkError} from '@teloa/contract'
import {businessTaskSourceUpdateRunRequestId,type BusinessTaskSourceUpdateService} from '@teloa/backend'

export type BusinessTaskSourceUpdatePorts={
 updates:Pick<BusinessTaskSourceUpdateService,'pending'|'continueTask'|'settle'>
 /** 复用一键准备：同一 requestId 幂等回到同一 Run（崩溃或丢回包后按原身份取回）。 */
 prepare:(owner:string,input:{requestId:string;taskId:string;expectedTaskVersion:number},signal:AbortSignal)=>Promise<{runId:string}>
 /** 复用 TaskRunDriver.start 的持久 claim；禁止适配成直接 prompt。 */
 start:(owner:string,runId:string,signal:AbortSignal)=>Promise<{state:string}>
 readRun:(owner:string,runId:string,signal:AbortSignal)=>Promise<{state:string;nativeRequestId:string}>
 reconcile:(owner:string,runId:string,signal:AbortSignal)=>Promise<{state:string}>
 report:(code:string)=>void
}
const deterministic=(error:unknown)=>error instanceof WorkError&&['teloa/forbidden','teloa/invalid-input','teloa/conflict','teloa/version-conflict','teloa/storage-corrupt'].includes(error.code)
/** 只有原生已受理（或受理后结束）的 Run 才算续办送达；withdrawn / configuration_failed 没有受理证明，保守记 needs-user 并保留原 Task/Run，不自动重建。 */
const accepted=(state:string)=>['accepted','active','ended'].includes(state)
const notAccepted=(state:string)=>['withdrawn','configuration_failed'].includes(state)

/**
 * 同一业务对象后续版本的续办驱动：只读取账本、调用既有一键准备/启动端口并回填，不拥有模型循环、不新建任务。
 *  pending →（原 Run 收敛且计划/委托/员工版本仍当前）continueTask 升同一 taskId 新版本 → continued
 *  continued → 按账本派生身份 prepare（幂等）并先记录 Run 身份 → start 或 reconcile → 原生受理后 accepted
 * 失败：还没有 Run 身份的确定性失败记 needs-user（由本人处理）；已有 Run 时保留 continued 并记原因，下一轮只按原身份核对。
 */
export async function drainBusinessTaskSourceUpdates(owner:string,ports:BusinessTaskSourceUpdatePorts,signal:AbortSignal):Promise<void>{
 for(const item of await ports.updates.pending(owner)){
  signal.throwIfAborted()
  let runId=item.runId
  try{
   const receipt=await ports.updates.continueTask(owner,item.id)
   if(receipt.state!=='continued'||receipt.taskVersion===null)continue
   runId=receipt.runId
   if(!runId){
    runId=(await ports.prepare(owner,{requestId:businessTaskSourceUpdateRunRequestId(owner,item.id),taskId:receipt.taskId,expectedTaskVersion:receipt.taskVersion},signal)).runId
    await ports.updates.settle(owner,{id:item.id,state:'continued',runId,reason:null})
   }
   const run=await ports.readRun(owner,runId,signal)
   const state=run.state==='prepared'?(await ports.start(owner,runId,signal)).state:accepted(run.state)||notAccepted(run.state)?run.state:(await ports.reconcile(owner,runId,signal)).state
   // accepted 只表示原生受理；运行是否成功、成果是否达标仍由既有交付复核与本人审批判断，账本不代表质量通过。
   if(accepted(state))await ports.updates.settle(owner,{id:item.id,state:'accepted',runId,reason:null})
   else if(notAccepted(state))await ports.updates.settle(owner,{id:item.id,state:'needs-user',runId,reason:'teloa/run-not-accepted'})
   else await ports.updates.settle(owner,{id:item.id,state:'continued',runId,reason:'teloa/execution-pending'})
  }catch(error){
   const code=error instanceof WorkError?error.code:'teloa/dependency-unavailable'
   try{await ports.updates.settle(owner,{id:item.id,state:deterministic(error)&&!runId?'needs-user':'continued',runId:runId??null,reason:code})}catch{/* 回填失败保留原状态，下一轮按原身份核对。 */}
   try{ports.report(code)}catch{}
   if(signal.aborted)throw error
  }
 }
}
