import type {GroupRoutingStatusView,GroupTaskSource} from '@teloa/contract'
import type {PreviewTask,TaskSource} from './task-preview.ts'
import type {TeloaTranslate} from './i18n/index.ts'

/**
 * 群消息转出的持久任务只能补拉来源：契约 `WorkTask` 不带群消息来源，来源单独记在
 * `teloa_group_task_sources` 上，由 `groups/tasks/source` 单独读取，`projectSavedTask`
 * 投不出来。没有来源（非群消息任务，或已经补过一次）就不用再问。
 */
export const shouldLoadGroupTaskSource=(task:Pick<PreviewTask,'storage'|'source'|'groupSourceState'>):boolean=>task.storage==='persistent'&&!task.source&&task.groupSourceState!=='absent'&&task.groupSourceState!=='unavailable'

/**
 * 把群消息任务来源回执并回台账；来源记录没有原始作者字段（`GroupTaskSource` 只固定
 * 消息正文与位置，不认作者），`TaskSource.authorId` 因此留空，详情页按缺省不显示这一行。
 */
export function withGroupTaskSource(task:PreviewTask,source:GroupTaskSource|null|undefined):PreviewTask{
 if(!source)return {...task,groupSourceState:source===null?'absent':'pending'}
 const projected:TaskSource={groupId:source.groupId,messageId:source.messageId,rootId:source.rootId,text:source.messageText,trigger:source.trigger,createdAssignee:source.createdAssignee,...(source.schema==='teloa.group-task-source/v2'?{executionMode:source.executionMode}:{})}
 return {...task,source:projected,groupSourceState:'ready'}
}

/** 交流回帖是本轮结果，不是待人工验收的正式工作；未知来源、状态或发布结果均保留原入口。 */
export function isCompletedGroupReply(task:Pick<PreviewTask,'id'|'state'|'contentVersion'|'assigneeId'|'assigneeRoleVersion'|'source'>,statuses:readonly GroupRoutingStatusView[],groupId:string|undefined):boolean{
 const source=task.source
 if(source?.groupId!==groupId||source?.trigger!=='routed'||source.executionMode!=='reply'||!['waiting','completed'].includes(task.state))return false
 // 编辑目标或重新指派岗位后，旧回帖不能消除当前工作的入口；缺失版本也不能视为未变更。
 if(task.contentVersion!==1||!source.createdAssignee||source.createdAssignee.roleId!==task.assigneeId||source.createdAssignee.roleVersion!==task.assigneeRoleVersion)return false
 return statuses.some(status=>status.messageId===source.messageId&&status.recipients.some(recipient=>recipient.taskId===task.id&&recipient.roleId===task.assigneeId&&recipient.executionMode==='reply'&&recipient.phase==='completed'&&!!recipient.runId&&!!recipient.resultMessageId))
}

/** 原群自动回复展示来源意图；目标已编辑时展示当前目标。未确认来源时不猜用途。 */
export function taskGoalText(task:PreviewTask,t:TeloaTranslate):string{
 if(task.source?.trigger==='routed'){
  if(task.contentVersion!==undefined&&task.contentVersion>1)return task.goal
  return task.source.text||t('task.detail.groupReply')
 }
 if(task.storage==='persistent'&&task.groupId&&!task.source&&task.groupSourceState!=='absent')return t(task.groupSourceState==='unavailable'?'task.detail.groupSourceUnavailable':'task.detail.groupSourceLoading')
 return task.goal
}

export function canEditTaskGoal(task:PreviewTask):boolean{
 return task.source?.trigger!=='routed'&&!(task.storage==='persistent'&&task.groupId&&!task.source&&task.groupSourceState!=='absent')
}
