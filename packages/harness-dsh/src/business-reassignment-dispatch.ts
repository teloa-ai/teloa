import {WorkError,readBusinessReassignmentSnapshot,readBusinessReassignmentReceipt,type BusinessReassignmentSnapshot,type BusinessReassignmentReceipt} from '@teloa/contract'
import {reserveInputFromReassignment,type BusinessReassignmentService,type ReassignmentRunTargets} from '@teloa/backend'
import type {ConversationWorkDispatch,ConversationWorkStatus} from './conversation-work-dispatch.ts'
export type BusinessReassignmentDispatchPorts={
 owner:string
 reassignments:Pick<BusinessReassignmentService,'prepare'|'readReassignmentRuns'|'commit'|'readReceiptForRequest'>
 work:Pick<ConversationWorkDispatch,'stopReassignment'>
 attestReassignmentRuns:(owner:string,targets:ReassignmentRunTargets,signal:AbortSignal)=>Promise<void>
 dispatch:ConversationWorkDispatch['dispatch']
}
/** Native I/O 在后端短事务外；commit 后继续原 reserve/claim，不另建发送机制。 */
export class BusinessReassignmentDispatch{
 readonly ports:BusinessReassignmentDispatchPorts
 constructor(ports:BusinessReassignmentDispatchPorts){this.ports=ports}
 async supersede(value:BusinessReassignmentSnapshot,signal:AbortSignal,revalidate:()=>Promise<void>):Promise<ConversationWorkStatus>{
  const snapshot=readBusinessReassignmentSnapshot(value),input={oldRequestId:snapshot.instruction.selection.oldRequestId,instruction:snapshot.instruction},{ports}=this
  // 只描述本次调用已知事实；不持久化另一套状态，不将提交失回包伪装成回滚。
  const facts:{stopIntent:'not-requested'|'unknown'|'saved';resourcesSettled:boolean;commitState:'not-attempted'|'unknown'|'rejected'|'confirmed';receipt?:BusinessReassignmentReceipt}={stopIntent:'not-requested',resourcesSettled:false,commitState:'not-attempted'}
  const validate=async()=>{signal.throwIfAborted();await revalidate();signal.throwIfAborted()}
  const fixedReceipt=(value:BusinessReassignmentReceipt)=>{
   const result=readBusinessReassignmentReceipt(value)
   if(result.oldRequestId!==input.oldRequestId||result.newRequestId!==snapshot.instruction.requestId||result.oldSessionId!==snapshot.oldSessionId||result.newSessionId!==snapshot.instruction.sessionId||result.scope!==snapshot.scope||result.snapshotHash!==snapshot.snapshotHash)throw new WorkError('teloa/invalid-host-response','改派回执与固定批准不一致，请核对原请求。')
   return result
  }
  const read=async()=>{
   const targets=await ports.reassignments.readReassignmentRuns(ports.owner,input,validate)
   if(targets.oldRequestId!==input.oldRequestId||targets.oldSessionId!==snapshot.oldSessionId||targets.scope!==snapshot.scope||targets.targets.length!==1||targets.targets[0]!.roleId!==snapshot.oldTarget.roleId)throw new WorkError('teloa/invalid-host-response','改派运行授权与本人批准的原交办不一致。')
   await validate();return targets
  }
  try{
   await validate()
   const initial=await read()
   const previous=await ports.reassignments.readReceiptForRequest(ports.owner,snapshot.instruction.requestId)
   if(previous){
    // 同消息失回包恢复只读已有固定链；不再停止旧 Run 或补做一次后继提交。
    facts.commitState='unknown';facts.receipt=fixedReceipt(previous);facts.commitState='confirmed';facts.stopIntent='saved';facts.resourcesSettled=true
   }
   await validate()
   if(!previous){
    await ports.work.stopReassignment(initial,signal,validate,state=>{facts.stopIntent=state})
    await validate()
    const current=await read()
    await ports.attestReassignmentRuns(ports.owner,current,signal)
    // attestor 对 withdrawn/configuration_failed 的跳过不替代 commit 的完整结清闸。
    await validate()
    facts.commitState='unknown'
    let committed:BusinessReassignmentReceipt
    try{committed=await ports.reassignments.commit(ports.owner,input,snapshot,validate)}
    catch(error){
     // 生产 service 的这些业务拒绝发生在 COMMIT 前，并经事务回滚。
     // 连接、宿主、传输或未识别错误一律保留提交未知，不自动读写恢复。
     if(error instanceof WorkError&&['teloa/conflict','teloa/version-conflict','teloa/forbidden','teloa/invalid-input','teloa/invalid-reference','teloa/not-found','teloa/not-bound','teloa/binding-pending','teloa/storage-corrupt'].includes(error.code))facts.commitState='rejected'
     throw error
    }
    facts.receipt=fixedReceipt(committed);facts.commitState='confirmed';facts.resourcesSettled=true
   }
   await validate()
   const receipt=facts.receipt
   if(!receipt)throw new WorkError('teloa/invalid-host-response','后继提交缺少固定回执，请核对原请求。')
   const status=await ports.dispatch(reserveInputFromReassignment(snapshot),signal,validate)
   if(status.requestId!==receipt.newRequestId||status.sessionId!==receipt.newSessionId||status.scope!==receipt.scope)throw new WorkError('teloa/invalid-host-response','后继交办状态与固定回执不一致。')
   return {...status,reassignment:receipt,...(snapshot.reference?{sourceReference:snapshot.reference}:{})}
  }catch(error){
   const oldState=facts.stopIntent==='saved'?(facts.resourcesSettled?'旧交办已停止。':'停止意图已保存，执行资源仍待核对。'):facts.stopIntent==='unknown'?'停止状态待核对。':'本次尚未停止原交办。'
   const successor=facts.commitState==='confirmed'?`后继已创建（${snapshot.instruction.requestId}），执行状态待核对；请使用同一消息继续原后继。`:facts.commitState==='unknown'?'后继提交待核对；请使用同一消息恢复，不要另起交办。':facts.commitState==='rejected'?'本次后继提交被拒，未创建新的后继。':'本次尚未提交后继，未创建新的后继。'
   const detail=error instanceof WorkError?error.message:signal.aborted?'本次操作已取消。':'服务回执暂不可用。'
   throw new WorkError(error instanceof WorkError?error.code:signal.aborted?'teloa/cancelled':'teloa/host-unavailable',oldState+successor+detail,{...(error instanceof WorkError?error.details:{}),reassignment:{oldRequestId:input.oldRequestId,newRequestId:snapshot.instruction.requestId,oldStopIntent:facts.stopIntent,oldResources:facts.resourcesSettled?'settled':'unconfirmed',successor:facts.commitState,...(facts.receipt?{receipt:facts.receipt}:{})}})
  }
 }
}
