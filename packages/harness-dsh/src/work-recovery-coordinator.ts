import {WorkError,type WorkControl} from '@teloa/contract'
import type {WorkRecoveryService,WorkResumeInput,TaskRunService} from '@teloa/backend'
import type {WorkAccessLease} from '@teloa/backend'
import {combineWorkAccessLeases} from '@teloa/backend'
import type {NativeInputRestore,NativeInputRestoreInput} from './native-input-checkpoint.ts'

type Permit=Awaited<ReturnType<WorkRecoveryService['begin']>>
/** 在部署已有的完整 checkpoint/roots 恢复策略外叠加当前整项控制票据；不替代原 owner/历史核验。 */
export function controlledWorkRestore(restore:NativeInputRestore,resolve:(input:NativeInputRestoreInput)=>Promise<{permit:Permit;sessionId:string}>,fingerprint:(input:NativeInputRestoreInput)=>string):NativeInputRestore{
 if(typeof restore!=='function'||typeof resolve!=='function'||typeof fingerprint!=='function')throw new WorkError('teloa/unavailable','真实整项恢复与检查点策略尚未装配。')
 return async input=>{
  input.signal.throwIfAborted();const {permit,sessionId}=await resolve(input)
  if(permit.candidate.reason!=='accepted'||sessionId!==input.sessionId||permit.checkpointSha256!==fingerprint(input))throw new WorkError('teloa/version-conflict','恢复票据不匹配当前完整检查点。')
  const control=combineWorkAccessLeases([permit.lease]);control.assertCurrent()
  const base=await restore(input)
  input.signal.throwIfAborted();control.assertCurrent()
  if(!base||!Array.isArray(base.roots)||base.roots.some(root=>root.sessionId!==input.sessionId||typeof root.messageId!=='string'||!root.messageId||typeof root.payloadSha256!=='string'||!/^[a-f0-9]{64}$/.test(root.payloadSha256)||root.nativeRequestId!==null&&(typeof root.nativeRequestId!=='string'||!root.nativeRequestId))||typeof base.assertCurrent!=='function')throw new WorkError('teloa/forbidden','原检查点没有完整持久根授权。')
  const lease=combineWorkAccessLeases([control,base]),roots=Object.freeze(base.roots.map(root=>Object.freeze({...root})))
  return Object.freeze({roots,assertCurrent:()=>{input.signal.throwIfAborted();if(permit.checkpointSha256!==fingerprint(input))throw new WorkError('teloa/version-conflict','恢复检查点发生变化。');lease.assertCurrent();return undefined}})
 }
}
type Ports={service:Pick<WorkRecoveryService,'resume'|'begin'|'record'>;runs:Pick<TaskRunService,'get'>;/** 确定未派发的 prepared Run；端口必须消费 permit.lease 的真实最终同步 guard。 */startUnaccepted:(owner:string,input:{runId:string;lease:WorkAccessLease},signal:AbortSignal)=>Promise<void>;/** 恢复精确 checkpoint，不重新发送原请求。部署 NativeInputRestore 必须核对全部 roots、hash、宿主和控制 lease。 */restoreAccepted:(owner:string,input:{runId:string;sessionId:string;permit:Permit},signal:AbortSignal)=>Promise<void>;/** 仅本次本人批准且已核验宿主的 Goal；缺席不能恢复 Goal。 */resumeGoal?:(owner:string,input:{runId:string;permit:Permit},signal:AbortSignal)=>Promise<void>}

export class WorkRecoveryCoordinator{
 readonly ports:Ports
 constructor(ports:Ports){this.ports=ports}
 async resume(owner:string,input:WorkResumeInput,signal:AbortSignal):Promise<WorkControl>{
  signal.throwIfAborted();const control=await this.ports.service.resume(owner,input)
  for(const runId of input.candidateRunIds){
   signal.throwIfAborted();const permit=await this.ports.service.begin(owner,{requestId:input.requestId,runId})
   if(!permit.dispatch)continue
   try{
    const run=await this.ports.runs.get(owner,{runId});permit.lease.assertCurrent();signal.throwIfAborted()
    if(permit.candidate.reason==='unknown')throw new WorkError('teloa/execution-pending','未知动作不能由恢复协调器重放。')
    if(permit.candidate.reason==='unaccepted'){
     if(run.state!=='prepared')throw new WorkError('teloa/execution-pending','提交状态不能凭未派发候选自动回退，请核对原受理回执。')
     await this.ports.startUnaccepted(owner,{runId,lease:permit.lease},signal)
    }else await this.ports.restoreAccepted(owner,{runId,sessionId:run.sessionId,permit},signal)
    if(permit.candidate.goal){
     if(!this.ports.resumeGoal)throw new WorkError('teloa/unavailable','Goal 明确恢复端口尚未装配。')
     permit.lease.assertCurrent();signal.throwIfAborted();await this.ports.resumeGoal(owner,{runId,permit},signal)
    }
    await this.ports.service.record(owner,{requestId:input.requestId,runId,checkpointSha256:permit.checkpointSha256,state:'applied'})
   }catch(error){
    // 包括接收成功后回包/落库失败；不把恢复异常转为可重复派发。
    await this.ports.service.record(owner,{requestId:input.requestId,runId,checkpointSha256:permit.checkpointSha256,state:'unknown'}).catch(()=>{})
    throw error
   }
  }
  return control
 }
}
