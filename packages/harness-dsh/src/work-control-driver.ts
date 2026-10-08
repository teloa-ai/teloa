import {WorkError,type WorkControl} from '@teloa/contract'
import type {WorkControlService,WorkLineageService,TaskRunService,TaskRunRuntimeLinkService} from '@teloa/backend'
import type {TaskRunDriver,TaskRunPorts} from './task-run-driver.ts'

type Ports={controls:Pick<WorkControlService,'get'|'reconcile'>;runs:Pick<TaskRunService,'get'>;lineage:Pick<WorkLineageService,'descendants'>;driver:Pick<TaskRunDriver,'stop'>;ports:Pick<TaskRunPorts,'stop'|'stopChildren'|'stopState'|'backgroundState'|'subagentState'|'goalObservation'|'events'>;runtimeLinks:Pick<TaskRunRuntimeLinkService,'list'>}
/** 取消回执与收尾证明分开：取消已递交不等于外部动作撤销或孩子停止。 */
export class WorkControlDriver{
 readonly ports:Ports
 private readonly pending=new Map<string,number>()
 constructor(ports:Ports){this.ports=ports}
 async apply(owner:string,control:WorkControl,signal:AbortSignal):Promise<WorkControl>{
  signal.throwIfAborted();const current=await this.ports.controls.get(owner,{controlId:control.id})
  if(current.ownerId!==owner||current.generation!==control.generation)throw new WorkError('teloa/version-conflict','工作控制已变化，旧取消回调已失效。')
  if(!['pausing','stopping'].includes(current.state))return current
  const {runIds}=await this.ports.lineage.descendants(owner,{controlId:control.id})
  await Promise.allSettled(runIds.map(async runId=>{
   const key=JSON.stringify([owner,runId]);this.pending.set(key,(this.pending.get(key)??0)+1)
   try{
   signal.throwIfAborted();const run=await this.ports.runs.get(owner,{runId})
   const latest=await this.ports.controls.get(owner,{controlId:control.id});if(latest.generation!==current.generation||latest.state!==current.state)throw new WorkError('teloa/version-conflict','工作取消世代已变化。')
   if(current.state==='stopping'){
    if(run.state==='prepared')return // 未派发由控制栅栏禁止启动；不伪造原生停止回执。
    await this.ports.driver.stop(owner,{runId},signal)
   }else{
    if(['prepared','withdrawn','configuration_failed'].includes(run.state))return
    // 暂停保留 Run 与原请求：不能使用会写 stop_requested_at 的业务 stop。
    const result=await Promise.allSettled([this.ports.ports.stop(run,signal),this.ports.ports.stopChildren?.(run,signal)])
    const failed=result.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason
   }
   }finally{const count=(this.pending.get(key)??1)-1;if(count)this.pending.set(key,count);else this.pending.delete(key)}
  }))
  signal.throwIfAborted();return this.ports.controls.reconcile(owner,{controlId:control.id,generation:control.generation})
 }
 async inspectRun(owner:string,input:{runId:string;action:'pause'|'stop';generation:number}):Promise<{settled:boolean;unknownOperationIds:string[]}>{
  const run=await this.ports.runs.get(owner,{runId:input.runId}),links=await this.ports.runtimeLinks.list(owner,{runId:run.id}),unknown:string[]=[]
  let externalOutstanding=false
  for(const link of links){
   if(link.kind==='browser'&&link.payload.status==='dirty')unknown.push('browser:'+link.payload.dispatchId)
   if(link.kind==='job'&&link.payload.record==='job'&&['running','stopping'].includes(link.payload.status))externalOutstanding=true
  }
  if(this.ports.ports.goalObservation){const goal=await this.ports.ports.goalObservation(run,await this.ports.ports.events(run));for(const receipt of goal?.continuations??[])if(['reserved','unknown'].includes(receipt.state))unknown.push('goal:'+receipt.nativeRequestId);if(goal&&goal.goalPhase!=='complete'&&(goal.activation!=='disarmed'||goal.goalPhase==='active'))externalOutstanding=true}
  if(this.pending.has(JSON.stringify([owner,run.id])))externalOutstanding=true
  if(['prepared','withdrawn','configuration_failed'].includes(run.state)&&links.length===0)return {settled:true,unknownOperationIds:[]}
  // 冷宿主、丢失检查器或旧 owner footprint 均不能宣布停止。
  if(!this.ports.ports.stopState||!this.ports.ports.backgroundState||!this.ports.ports.subagentState)return {settled:false,unknownOperationIds:unknown}
  const [host,background,children]=await Promise.all([this.ports.ports.stopState(run),this.ports.ports.backgroundState(run),this.ports.ports.subagentState(run,new AbortController().signal)])
  if(background.ownerOnly)unknown.push('runtime-owner:'+run.id)
  return {settled:!host.running&&host.settledSeq!==null&&!background.outstanding&&children==='none'&&!externalOutstanding&&unknown.length===0,unknownOperationIds:unknown}
 }
}
