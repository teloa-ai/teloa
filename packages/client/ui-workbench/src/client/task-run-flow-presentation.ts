import type {TaskRunFlow} from '@teloa/contract'

const flowStates={active:'taskExecution.flow.state.active',waiting:'taskExecution.flow.state.waiting',failed:'taskExecution.flow.state.failed',completed:'taskExecution.flow.state.completed',compensated:'taskExecution.flow.state.compensated'} as const
const kinds={work:'taskExecution.flow.kind.work',wait_external:'taskExecution.flow.kind.external',human_checkpoint:'taskExecution.flow.kind.review',compensation:'taskExecution.flow.kind.compensation'} as const
const states={blocked:'taskExecution.flow.step.blocked',ready:'taskExecution.flow.step.ready',running:'taskExecution.flow.step.running',waiting:'taskExecution.flow.step.waiting',succeeded:'taskExecution.flow.step.succeeded',failed:'taskExecution.flow.step.failed',cancelled:'taskExecution.flow.step.cancelled',compensated:'taskExecution.flow.step.compensated'} as const

export function taskRunFlowPresentation(flow:TaskRunFlow){
 const titles=new Map(flow.steps.map(step=>[step.id,step.title])),completed=flow.steps.filter(step=>step.state==='succeeded'||step.state==='compensated').length
 return {
  flowId:flow.flowId,stateKey:flowStates[flow.state],definitionVersion:flow.definitionVersion,completed,total:flow.steps.length,updatedAt:flow.updatedAt,
  steps:flow.steps.map(step=>({id:step.id,title:step.title,kindKey:kinds[step.kind],stateKey:step.kind==='compensation'&&step.state==='blocked'?'taskExecution.flow.step.trigger':states[step.state],attempts:step.attempts,dependencies:step.dependsOn.map(id=>titles.get(id)??id),inputSummary:step.inputSummary,outputSummary:step.outputSummary,waitReason:step.waitReason,updatedAt:step.updatedAt})),
 }
}
