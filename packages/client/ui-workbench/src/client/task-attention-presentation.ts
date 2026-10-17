import type {TaskAttention} from './task-api.js'
import type {WorkAttentionItem,WorkAttentionReason} from '@teloa/contract'

export type TaskAttentionReasonKey='task.attention.reason.taskBlocked'|'task.attention.reason.executionFailed'|'task.attention.reason.executionConfigurationFailed'|'task.attention.reason.executionCompleted'|'task.attention.reason.taskWaiting'
const reasonKeys:Record<TaskAttention['reason'],TaskAttentionReasonKey>={
 'task-blocked':'task.attention.reason.taskBlocked',
 'execution-failed':'task.attention.reason.executionFailed',
 'execution-configuration-failed':'task.attention.reason.executionConfigurationFailed',
 'execution-completed':'task.attention.reason.executionCompleted',
 'task-waiting':'task.attention.reason.taskWaiting',
}

export function taskAttentionDescription(reason:TaskAttention['reason'],t:(key:TaskAttentionReasonKey)=>string):string{return t(reasonKeys[reason])}

export type WorkAttentionReasonKey=TaskAttentionReasonKey|'attention.work.reason.businessChangeReview'|'attention.work.reason.businessChangeStale'|'attention.work.reason.businessSyncFailed'|'attention.work.reason.pageCreateDraft'
const workReasonKeys:Record<WorkAttentionReason,WorkAttentionReasonKey>={
 ...reasonKeys,
 'business-change-review':'attention.work.reason.businessChangeReview',
 'business-change-stale':'attention.work.reason.businessChangeStale',
 'business-sync-failed':'attention.work.reason.businessSyncFailed',
 'page-create-draft-pending':'attention.work.reason.pageCreateDraft',
}
export const workAttentionReasonKey=(reason:WorkAttentionReason):WorkAttentionReasonKey=>workReasonKeys[reason]
export type WorkAttentionTitleKey='attention.work.title.businessChange'|'attention.work.title.businessSync'
const fallbackTitles:Record<WorkAttentionTitleKey,string>={'attention.work.title.businessChange':'Business changes','attention.work.title.businessSync':'Sync failed'}
/** 真源没有标题字段的两类目录不把技术 ID 当业务名称。完整身份仍在 source 内传回原对象。 */
export function workAttentionTitle(row:WorkAttentionItem,t:(key:WorkAttentionTitleKey)=>string=key=>fallbackTitles[key]):string{
 if(row.source.kind==='business-change-set')return t('attention.work.title.businessChange')
 if(row.source.kind==='business-sync')return t('attention.work.title.businessSync')
 return row.title
}
