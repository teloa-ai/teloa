import {WorkError,groupWorkContinuationRunRequestId} from '@teloa/contract'
import type {GroupWorkInputService} from '@teloa/backend'
import {deliverGroupRunAppend,type GroupRunAppendPorts} from './group-run-append.ts'

export type GroupWorkInputPorts={
 inputs:Pick<GroupWorkInputService,'pending'|'continueTask'|'settle'>
 /** 复用一键准备：同一 requestId 幂等回到同一 Run（崩溃或丢回包后按原身份取回）。 */
 prepare:(owner:string,input:{requestId:string;taskId:string;expectedTaskVersion:number},signal:AbortSignal)=>Promise<{runId:string}>
 /** 复用 TaskRunDriver.start 的持久 claim；禁止适配成直接 prompt。 */
 start:(owner:string,runId:string,signal:AbortSignal)=>Promise<{state:string}>
 /** 只读原 Run 当前状态与原生请求身份。 */
 readRun:(owner:string,runId:string,signal:AbortSignal)=>Promise<{state:string;nativeRequestId:string}>
 /** 只核验原 session/nativeRequestId 的回执，不能发送新输入。 */
 reconcile:(owner:string,runId:string,signal:AbortSignal)=>Promise<{state:string}>
 /** 经原工作控制停止本轮（先阻止新派发，再取消运行与登记子级）；回执只说明是否已提交控制。 */
 stop:(owner:string,input:{requestId:string;taskId:string},signal:AbortSignal)=>Promise<'accepted'|'unknown'>
 report:(code:string)=>void
 /** 活动 Run 即时追加通道；未装配时只在原 Run 收敛后续办。 */
 append?:Omit<GroupRunAppendPorts,'settle'>
}
const deterministic=(error:unknown)=>error instanceof WorkError&&['teloa/forbidden','teloa/invalid-input','teloa/conflict','teloa/version-conflict','teloa/storage-corrupt'].includes(error.code)
/** 与群派工投递同一判据：原生已受理（或已终结）才算送达。 */
const delivered=(state:string)=>['accepted','active','ended','withdrawn','configuration_failed'].includes(state)

/**
 * 群追加与停止的驱动（规格 §4.4）：只读取回执、调用既有准备/启动/工作控制端口并回填，不拥有模型循环。
 * continue 分阶段推进，每一步都可从持久回执恢复：
 *  reserved →（原 Run 收敛后）continueTask 升同一 taskId 新版本 → continued
 *  continued → 按派生准备身份 prepare（幂等）并先记录 Run 身份 → start 或 reconcile 原 Run → 核实原生受理后 accepted（固定 nativeRequestId）
 * 任一步失败：确定性拒绝记 rejected；结果不明记 unknown 并保留已知 Run 身份，下一轮只按原身份核对，不重新升版本、不新建 Run。
 * 运行中的即时追加先经活动 Run 受控输入通道（group-run-append.ts）；没被原 Run 受理、带新资料或原 Run 已收敛时才续办。
 */
export async function drainGroupWorkInputs(owner:string,ports:GroupWorkInputPorts,signal:AbortSignal):Promise<void>{
 for(const item of await ports.inputs.pending(owner)){
  signal.throwIfAborted()
  let runId=item.runId
  try{
   if(item.operation==='stop'){
    const state=await ports.stop(owner,{requestId:item.requestId,taskId:item.taskId},signal)
    await ports.inputs.settle(owner,{requestId:item.requestId,state,runId:null,reason:state==='unknown'?'teloa/execution-pending':null})
    continue
   }
   // 原 Run 仍在原生处理中且追加不带新资料：先经原生受控输入送进原 Run；已受理或仍在核对时本轮不再续办。
   if(ports.append){
    const outcome=await deliverGroupRunAppend(owner,item,{...ports.append,settle:ports.inputs.settle.bind(ports.inputs)},signal)
    if(outcome==='accepted'||outcome==='pending')continue
   }
   const receipt=await ports.inputs.continueTask(owner,item.requestId)
   if(receipt.state!=='continued'&&receipt.state!=='unknown')continue
   runId=receipt.runId
   if(!runId){
    runId=(await ports.prepare(owner,{requestId:groupWorkContinuationRunRequestId(owner,item.requestId),taskId:receipt.taskId,expectedTaskVersion:receipt.taskVersion},signal)).runId
    await ports.inputs.settle(owner,{requestId:item.requestId,state:'continued',runId,reason:null})
   }
   const run=await ports.readRun(owner,runId,signal)
   const state=run.state==='prepared'?(await ports.start(owner,runId,signal)).state:delivered(run.state)?run.state:(await ports.reconcile(owner,runId,signal)).state
   if(delivered(state))await ports.inputs.settle(owner,{requestId:item.requestId,state:'accepted',runId,nativeRequestId:run.nativeRequestId,reason:null})
   else await ports.inputs.settle(owner,{requestId:item.requestId,state:'unknown',runId,reason:'teloa/execution-pending'})
  }catch(error){
   const code=error instanceof WorkError?error.code:'teloa/dependency-unavailable'
   // 还没有任何 Run 身份时的确定性失败（原任务已变化、无权）才拒绝；已有 Run 时只记未知，按原身份核对。
   try{await ports.inputs.settle(owner,{requestId:item.requestId,state:deterministic(error)&&!runId?'rejected':'unknown',runId:runId??null,reason:code})}catch{/* 回填失败保留原状态，下一轮按原身份核对。 */}
   try{ports.report(code)}catch{}
   if(signal.aborted)throw error
  }
 }
}
