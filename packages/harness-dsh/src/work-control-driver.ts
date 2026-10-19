import {WorkError,type WorkControl} from '@teloa/contract'
import type {WorkControlService,WorkLineageService,TaskRunService,TaskRunRuntimeLinkService,TaskRun} from '@teloa/backend'
import type {TaskRunDriver,TaskRunPorts} from './task-run-driver.ts'
import {taskRunRuntimeId} from './task-run-background.ts'

type Ports={controls:Pick<WorkControlService,'get'|'reconcile'>;runs:Pick<TaskRunService,'get'>;lineage:Pick<WorkLineageService,'descendants'>;driver:Pick<TaskRunDriver,'stop'>;ports:Pick<TaskRunPorts,'stop'|'stopChildren'|'stopState'|'backgroundState'|'subagentState'|'goalObservation'|'events'>;runtimeLinks:Pick<TaskRunRuntimeLinkService,'list'>
 /** 已结束 Run 的持久终态结算证明（宿主提供，复用委托收口同一判据）；缺省时已结束 Run 仍必须经宿主检查器读原生会话。 */
 terminalSettled?:(owner:string,run:TaskRun)=>Promise<boolean>}
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
   if(link.kind==='external'&&['reserved','running','stopping','unknown'].includes(link.payload.status)){
    if(link.payload.status==='unknown'||link.payload.runtimeId!==taskRunRuntimeId)unknown.push('external:'+link.payload.provider+':'+link.payload.reservationId)
    else externalOutstanding=true
   }
  }
  // 未派发或配置失败且无任何 runtime link 的 Run 没有原生会话可读；先收口，避免读取不存在的执行日志而永远停在收尾中。
  if(['prepared','withdrawn','configuration_failed'].includes(run.state)&&links.length===0)return {settled:true,unknownOperationIds:[]}
  // 已结束且宿主已记录原生终态证据的 Run：不再为了宣布停妥去 materialize 旧会话或 Goal 足迹，改以持久终态结算为证
  // （子工作、流程、runtime link 回执、宿主结算、群交付、安全效果，与委托收口同一判据）。link 显示在途/未知、本进程仍在取消它、
  // 或结算不成立时仍保持待核对；暂停闸本身已禁止该 Run 接受新输入。
  if(run.state==='ended'&&run.evidence?.state==='ended'&&!externalOutstanding&&!unknown.length&&!this.pending.has(JSON.stringify([owner,run.id]))&&this.ports.terminalSettled&&await this.ports.terminalSettled(owner,run))return {settled:true,unknownOperationIds:[]}
  if(this.ports.ports.goalObservation){const goal=await this.ports.ports.goalObservation(run,await this.ports.ports.events(run));for(const receipt of goal?.continuations??[])if(['reserved','unknown'].includes(receipt.state))unknown.push('goal:'+receipt.nativeRequestId);if(goal&&goal.goalPhase!=='complete'&&(goal.activation!=='disarmed'||goal.goalPhase==='active'))externalOutstanding=true}
  if(this.pending.has(JSON.stringify([owner,run.id])))externalOutstanding=true
  // 冷宿主、丢失检查器或旧 owner footprint 均不能宣布停止。
  if(!this.ports.ports.stopState||!this.ports.ports.backgroundState||!this.ports.ports.subagentState)return {settled:false,unknownOperationIds:unknown}
  const [host,background,children]=await Promise.all([this.ports.ports.stopState(run),this.ports.ports.backgroundState(run),this.ports.ports.subagentState(run,new AbortController().signal)])
  if(background.ownerOnly)unknown.push('runtime-owner:'+run.id)
  return {settled:!host.running&&host.settledSeq!==null&&!background.outstanding&&children==='none'&&!externalOutstanding&&unknown.length===0,unknownOperationIds:unknown}
 }
}
