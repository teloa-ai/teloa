import type {TaskAttention} from './task-api.js'

export type TaskAttentionReasonKey='task.attention.reason.taskBlocked'|'task.attention.reason.executionFailed'|'task.attention.reason.executionConfigurationFailed'|'task.attention.reason.executionCompleted'|'task.attention.reason.taskWaiting'
const reasonKeys:Record<TaskAttention['reason'],TaskAttentionReasonKey>={
 'task-blocked':'task.attention.reason.taskBlocked',
 'execution-failed':'task.attention.reason.executionFailed',
 'execution-configuration-failed':'task.attention.reason.executionConfigurationFailed',
 'execution-completed':'task.attention.reason.executionCompleted',
 'task-waiting':'task.attention.reason.taskWaiting',
}

export function taskAttentionDescription(reason:TaskAttention['reason'],t:(key:TaskAttentionReasonKey)=>string):string{return t(reasonKeys[reason])}
