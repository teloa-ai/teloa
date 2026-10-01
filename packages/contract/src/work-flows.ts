import {WorkError,isRecord} from './index.ts'

export const taskRunFlowStepKinds=['work','wait_external','human_checkpoint','compensation'] as const
export const taskRunFlowStepStates=['blocked','ready','running','waiting','succeeded','failed','cancelled','compensated'] as const
export const taskRunFlowStates=['active','waiting','failed','completed','compensated'] as const

export type TaskRunFlowStepKind=typeof taskRunFlowStepKinds[number]
export type TaskRunFlowStepState=typeof taskRunFlowStepStates[number]
export type TaskRunFlowState=typeof taskRunFlowStates[number]
export type TaskRunFlowStepExecution={kind:'subagent';parentSessionId:string;agentPresetId:string;allowedTools:string[];knowledgeIds:string[];skillNames:string[]}
export type TaskRunFlowStepDefinition={id:string;title:string;kind:TaskRunFlowStepKind;dependsOn:string[];inputSummary:string;compensates?:string;execution?:TaskRunFlowStepExecution}
export type TaskRunFlowDefinition={definitionVersion:number;steps:TaskRunFlowStepDefinition[]}
export type TaskRunFlowStep=TaskRunFlowStepDefinition&{state:TaskRunFlowStepState;attempts:number;outputSummary:string|null;waitReason:string|null;startedAt:string|null;updatedAt:string;completedAt:string|null}
export type TaskRunFlow={flowId:string;runId:string;definitionVersion:number;state:TaskRunFlowState;steps:TaskRunFlowStep[];createdAt:string;updatedAt:string}
export type TaskRunFlowTransitionAction='start'|'wait'|'resume'|'succeed'|'fail'
export type TaskRunFlowTransitionInput={requestId:string;flowId:string;stepId:string;action:TaskRunFlowTransitionAction;expectedAttempts:number;outputSummary?:string;waitReason?:string}

const invalid=()=>new WorkError('teloa/invalid-input','内部 Flow 定义、步骤或依赖格式不正确。')
const exact=(value:unknown,keys:readonly string[])=>isRecord(value)&&Object.keys(value).every(key=>keys.includes(key))
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const natural=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const stableId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][-_a-zA-Z0-9]{0,119}$/.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const name=(value:unknown):value is string=>typeof value==='string'&&/^[-a-zA-Z0-9_.]{1,128}$/.test(value)
const list=(value:unknown,valid:(item:unknown)=>item is string):value is string[]=>Array.isArray(value)&&value.length<=256&&value.every(valid)&&new Set(value).size===value.length

function readExecution(value:unknown):TaskRunFlowStepExecution{
 if(!exact(value,['kind','parentSessionId','agentPresetId','allowedTools','knowledgeIds','skillNames']))throw invalid()
 const row=value as Record<string,unknown>
 if(row.kind!=='subagent'||!name(row.parentSessionId)||typeof row.agentPresetId!=='string'||!/^[a-z0-9][-a-z0-9]{0,119}$/.test(row.agentPresetId)||!list(row.allowedTools,name)||!list(row.knowledgeIds,uuid)||!list(row.skillNames,name))throw invalid()
 return {kind:'subagent',parentSessionId:row.parentSessionId,agentPresetId:row.agentPresetId,allowedTools:[...row.allowedTools],knowledgeIds:[...row.knowledgeIds],skillNames:[...row.skillNames]}
}

function readStepDefinition(value:unknown):TaskRunFlowStepDefinition{
 if(!exact(value,['id','title','kind','dependsOn','inputSummary','compensates','execution']))throw invalid()
 const row=value as Record<string,unknown>
 if(!stableId(row.id)||!text(row.title,160)||!taskRunFlowStepKinds.includes(row.kind as TaskRunFlowStepKind)||!Array.isArray(row.dependsOn)||row.dependsOn.length>100||row.dependsOn.some(item=>!stableId(item))||new Set(row.dependsOn).size!==row.dependsOn.length||!text(row.inputSummary,4000))throw invalid()
 if(row.kind==='compensation'?!stableId(row.compensates):row.compensates!==undefined)throw invalid()
 return {id:row.id,title:row.title,kind:row.kind as TaskRunFlowStepKind,dependsOn:[...row.dependsOn] as string[],inputSummary:row.inputSummary,...(row.compensates===undefined?{}:{compensates:row.compensates as string}),...(row.execution===undefined?{}:{execution:readExecution(row.execution)})}
}

export function readTaskRunFlowDefinition(value:unknown):TaskRunFlowDefinition{
 if(!exact(value,['definitionVersion','steps']))throw invalid()
 const row=value as Record<string,unknown>
 if(!positive(row.definitionVersion)||!Array.isArray(row.steps)||row.steps.length<2||row.steps.length>100)throw invalid()
 const steps=row.steps.map(readStepDefinition),ids=new Set(steps.map(step=>step.id))
 if(ids.size!==steps.length)throw invalid()
 for(const step of steps){
  if(step.dependsOn.includes(step.id)||step.dependsOn.some(id=>!ids.has(id)))throw invalid()
  if(step.kind==='compensation'&&(!ids.has(step.compensates!)||step.dependsOn.includes(step.compensates!)||steps.find(item=>item.id===step.compensates)?.kind==='compensation'))throw invalid()
 }
 const visiting=new Set<string>(),visited=new Set<string>(),byId=new Map(steps.map(step=>[step.id,step]))
 const visit=(id:string)=>{if(visiting.has(id))throw invalid();if(visited.has(id))return;visiting.add(id);for(const dependency of byId.get(id)!.dependsOn)visit(dependency);visiting.delete(id);visited.add(id)}
 for(const step of steps)visit(step.id)
 return {definitionVersion:row.definitionVersion,steps}
}

export function taskRunFlowRequiresFlow(definition:TaskRunFlowDefinition):boolean{
 if(definition.steps.some(step=>step.kind!=='work'))return true
 const siblings=new Map<string,number>()
 for(const step of definition.steps){const key=[...step.dependsOn].sort().join('\0');siblings.set(key,(siblings.get(key)??0)+1)}
 return [...siblings.values()].some(count=>count>1)
}

export function taskRunFlowState(steps:readonly TaskRunFlowStep[]):TaskRunFlowState{
 if(steps.some(step=>step.state==='waiting'))return 'waiting'
 if(steps.some(step=>step.kind==='compensation'&&step.state==='failed'))return 'failed'
 const failed=steps.filter(step=>step.kind!=='compensation'&&step.state==='failed')
 for(const step of failed){
  const compensation=steps.find(candidate=>candidate.kind==='compensation'&&candidate.compensates===step.id)
  if(!compensation||compensation.state==='failed'||compensation.state==='cancelled')return 'failed'
  if(compensation.state!=='compensated')return 'active'
 }
 const work=steps.filter(step=>step.kind!=='compensation')
 if(work.every(step=>['succeeded','failed','cancelled'].includes(step.state))&&steps.filter(step=>step.kind==='compensation').every(step=>step.state==='cancelled'||step.state==='compensated'))return failed.length?'compensated':'completed'
 return 'active'
}

function taskRunFlowCausality(steps:readonly TaskRunFlowStep[]):boolean{
 const byId=new Map(steps.map(step=>[step.id,step])),dependencyComplete=(step:TaskRunFlowStep)=>step.state==='succeeded'||step.state==='compensated'
 for(const step of steps){
  const dependencies=step.dependsOn.map(id=>byId.get(id)!),failedDependency=dependencies.some(item=>item.state==='failed'||item.state==='cancelled'),allDependenciesComplete=dependencies.every(dependencyComplete)
  if(step.kind==='compensation'){
   const target=byId.get(step.compensates!)!,mustCancel=target.state==='succeeded'||target.state==='cancelled'||target.state==='failed'&&failedDependency,canRun=target.state==='failed'&&allDependenciesComplete
   if(step.state==='cancelled'){if(!mustCancel)return false}
   else if(step.state==='blocked'){if(mustCancel||canRun)return false}
   else if(['ready','running','failed','compensated'].includes(step.state)){if(!canRun)return false}
   else return false
   continue
  }
  if(step.state==='compensated'||step.state==='waiting'&&!['wait_external','human_checkpoint'].includes(step.kind))return false
  if(step.state==='cancelled'){if(!failedDependency)return false}
  else if(step.state==='blocked'){if(failedDependency||allDependenciesComplete)return false}
  else if(!allDependenciesComplete)return false
 }
 return true
}

function readFlowStep(value:unknown):TaskRunFlowStep{
 if(!exact(value,['id','title','kind','dependsOn','inputSummary','compensates','execution','state','attempts','outputSummary','waitReason','startedAt','updatedAt','completedAt']))throw invalid()
 const row=value as Record<string,unknown>,definition=readStepDefinition({id:row.id,title:row.title,kind:row.kind,dependsOn:row.dependsOn,inputSummary:row.inputSummary,...(row.compensates===undefined?{}:{compensates:row.compensates}),...(row.execution===undefined?{}:{execution:row.execution})})
 if(!taskRunFlowStepStates.includes(row.state as TaskRunFlowStepState)||!natural(row.attempts)||!(row.outputSummary===null||text(row.outputSummary,4000))||!(row.waitReason===null||text(row.waitReason,2000))||!(row.startedAt===null||stamp(row.startedAt))||!stamp(row.updatedAt)||!(row.completedAt===null||stamp(row.completedAt)))throw invalid()
 return {...definition,state:row.state as TaskRunFlowStepState,attempts:row.attempts,outputSummary:row.outputSummary as string|null,waitReason:row.waitReason as string|null,startedAt:row.startedAt as string|null,updatedAt:row.updatedAt,completedAt:row.completedAt as string|null}
}

export function readTaskRunFlow(value:unknown):TaskRunFlow{
 if(!exact(value,['flowId','runId','definitionVersion','state','steps','createdAt','updatedAt']))throw invalid()
 const row=value as Record<string,unknown>
 if(!uuid(row.flowId)||!uuid(row.runId)||!positive(row.definitionVersion)||!taskRunFlowStates.includes(row.state as TaskRunFlowState)||!Array.isArray(row.steps)||!stamp(row.createdAt)||!stamp(row.updatedAt))throw invalid()
 const steps=row.steps.map(readFlowStep),definition=readTaskRunFlowDefinition({definitionVersion:row.definitionVersion,steps:steps.map(({state:_state,attempts:_attempts,outputSummary:_output,waitReason:_reason,startedAt:_started,updatedAt:_updated,completedAt:_completed,...step})=>step)})
 const state=row.state as TaskRunFlowState,createdAt=Date.parse(row.createdAt),updatedAt=Date.parse(row.updatedAt)
 if(updatedAt<createdAt||taskRunFlowState(steps)!==state||!taskRunFlowCausality(steps))throw invalid()
 for(const step of steps){
  const attempted=!['blocked','ready','cancelled'].includes(step.state),completed=['succeeded','failed','cancelled','compensated'].includes(step.state),hasOutput=['succeeded','failed','compensated'].includes(step.state)
  const stepUpdated=Date.parse(step.updatedAt),started=step.startedAt===null?null:Date.parse(step.startedAt),ended=step.completedAt===null?null:Date.parse(step.completedAt)
  if((step.attempts>0)!==attempted||(step.startedAt!==null)!==attempted||(step.completedAt!==null)!==completed||(step.outputSummary!==null)!==hasOutput||(step.waitReason!==null)!==(step.state==='waiting')||stepUpdated<createdAt||stepUpdated>updatedAt||started!==null&&(started<createdAt||started>stepUpdated)||ended!==null&&(ended<createdAt||ended!==stepUpdated))throw invalid()
 }
 return {flowId:row.flowId,runId:row.runId,definitionVersion:definition.definitionVersion,state,steps,createdAt:row.createdAt,updatedAt:row.updatedAt}
}

export function readTaskRunFlowTransition(value:unknown):TaskRunFlowTransitionInput{
 if(!exact(value,['requestId','flowId','stepId','action','expectedAttempts','outputSummary','waitReason']))throw invalid()
 const row=value as Record<string,unknown>
 if(!uuid(row.requestId)||!uuid(row.flowId)||!stableId(row.stepId)||!['start','wait','resume','succeed','fail'].includes(String(row.action))||!natural(row.expectedAttempts))throw invalid()
 if(row.action==='wait'?!text(row.waitReason,2000)||row.outputSummary!==undefined:['succeed','fail'].includes(String(row.action))?!text(row.outputSummary,4000)||row.waitReason!==undefined:row.outputSummary!==undefined||row.waitReason!==undefined)throw invalid()
 return {requestId:row.requestId,flowId:row.flowId,stepId:row.stepId,action:row.action as TaskRunFlowTransitionAction,expectedAttempts:row.expectedAttempts,...(row.outputSummary===undefined?{}:{outputSummary:row.outputSummary as string}),...(row.waitReason===undefined?{}:{waitReason:row.waitReason as string})}
}
