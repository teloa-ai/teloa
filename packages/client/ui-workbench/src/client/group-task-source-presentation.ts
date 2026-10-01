import type {GroupTaskSource} from '@teloa/contract'
import type {PreviewTask,TaskSource} from './task-preview.ts'

/**
 * 群消息转出的持久任务只能补拉来源：契约 `WorkTask` 不带群消息来源，来源单独记在
 * `teloa_group_task_sources` 上，由 `groups/tasks/source` 单独读取，`projectSavedTask`
 * 投不出来。没有来源（非群消息任务，或已经补过一次）就不用再问。
 */
export const shouldLoadGroupTaskSource=(task:Pick<PreviewTask,'storage'|'source'>):boolean=>task.storage==='persistent'&&!task.source

/**
 * 把群消息任务来源回执并回台账；来源记录没有原始作者字段（`GroupTaskSource` 只固定
 * 消息正文与位置，不认作者），`TaskSource.authorId` 因此留空，详情页按缺省不显示这一行。
 */
export function withGroupTaskSource(task:PreviewTask,source:GroupTaskSource|null):PreviewTask{
 if(!source)return task
 const projected:TaskSource={groupId:source.groupId,messageId:source.messageId,rootId:source.rootId,text:source.messageText,trigger:source.trigger}
 return {...task,source:projected}
}
