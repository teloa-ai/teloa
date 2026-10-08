import {createHash} from 'node:crypto'
import {WorkError,type TaskRunFlow,type TaskRunFlowDefinition,type TaskRunFlowStep,taskRunFlowRequiresFlow} from '@teloa/contract'
import type {TaskRunFlowService} from '@teloa/backend'
export type TaskRunFlowDriverPorts={
 admit:(owner:string,runId:string,signal:AbortSignal)=>Promise<void>
 start:(owner:string,input:{runId:string;flowId:string;step:TaskRunFlowStep;reservationId:string},signal:AbortSignal)=>Promise<void>
 read:(owner:string,input:{runId:string;reservationId:string},signal:AbortSignal)=>Promise<{state:'pending'|'completed'|'failed'|'unknown';summary:string|null}>
}
const request=(flowId:string,stepId:string,attempt:number,action:string)=>{const hex=createHash('sha256').update(JSON.stringify([flowId,stepId,attempt,action])).digest('hex');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-8'+hex.slice(17,20)+'-'+hex.slice(20,32)}
/** 仅真实并行/等待/checkpoint 使用 Flow；普通顺序仍由 Goal 负责。未知回执不重派。 */
export class TaskRunFlowDriver{
 readonly service:Pick<TaskRunFlowService,'get'|'create'|'transition'|'transitionVerified'>&Partial<Pick<TaskRunFlowService,'readWait'|'completeWait'>>;readonly ports:TaskRunFlowDriverPorts
 constructor(service:TaskRunFlowDriver['service'],ports:TaskRunFlowDriverPorts){this.service=service;this.ports=ports}
 async create(owner:string,input:{requestId:string;runId:string}&TaskRunFlowDefinition,signal:AbortSignal):Promise<TaskRunFlow>{if(!taskRunFlowRequiresFlow(input))throw new WorkError('teloa/invalid-input','普通顺序工作应使用 Goal。');signal.throwIfAborted();await this.ports.admit(owner,input.runId,signal);return this.service.create(owner,input)}
 async tick(owner:string,runId:string,signal:AbortSignal):Promise<TaskRunFlow|null>{
  signal.throwIfAborted();let flow=await this.service.get(owner,{runId});if(!flow||flow.state==='completed'||flow.state==='compensated')return flow
  for(const current of flow.steps){signal.throwIfAborted()
   if(current.state==='ready'){
    await this.ports.admit(owner,runId,signal)
    flow=await this.service.transition(owner,{requestId:request(flow.flowId,current.id,current.attempts,'start'),flowId:flow.flowId,stepId:current.id,action:'start',expectedAttempts:current.attempts})
    const step=flow.steps.find(s=>s.id===current.id)!
    if(step.kind==='wait_external'||step.kind==='human_checkpoint'){flow=await this.service.transition(owner,{requestId:request(flow.flowId,step.id,step.attempts,'wait'),flowId:flow.flowId,stepId:step.id,action:'wait',expectedAttempts:step.attempts,waitReason:step.inputSummary});continue}
    if(!step.execution)throw new WorkError('teloa/forbidden','执行步骤尚未绑定真实子工作配置。')
    await this.ports.start(owner,{runId,flowId:flow.flowId,step,reservationId:'flow:'+flow.flowId+':'+step.id+':'+step.attempts},signal)
   }else if(current.state==='waiting'&&this.service.readWait&&this.service.completeWait){
    const receipt=await this.service.readWait(owner,{runId,flowId:flow.flowId,stepId:current.id,expectedAttempts:current.attempts})
    if(receipt){await this.ports.admit(owner,runId,signal);flow=await this.service.completeWait(owner,{requestId:request(flow.flowId,current.id,current.attempts,'event:'+receipt.eventId),flowId:flow.flowId,stepId:current.id,expectedAttempts:current.attempts,eventId:receipt.eventId})}
   }else if(current.state==='running'&&current.execution){
    const reservationId='flow:'+flow.flowId+':'+current.id+':'+current.attempts,receipt=await this.ports.read(owner,{runId,reservationId},signal)
    if(receipt.state==='completed'&&receipt.summary){flow=await this.service.transitionVerified(owner,{requestId:request(flow.flowId,current.id,current.attempts,'succeed'),flowId:flow.flowId,stepId:current.id,action:'succeed',expectedAttempts:current.attempts,outputSummary:receipt.summary},{reservationId})}
    else if(receipt.state==='failed'&&receipt.summary)flow=await this.service.transition(owner,{requestId:request(flow.flowId,current.id,current.attempts,'fail'),flowId:flow.flowId,stepId:current.id,action:'fail',expectedAttempts:current.attempts,outputSummary:receipt.summary})
   }
  }return flow
 }
}
