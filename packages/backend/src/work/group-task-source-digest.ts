import {createHash} from 'node:crypto'
import type {GroupTaskSource} from '@teloa/contract'

/** 群消息任务来源用固定字段序列摘要；群历史、任务与运行审计可独立核对。 */
export function groupTaskSourceDigest(source:GroupTaskSource):string{
 return createHash('sha256').update(JSON.stringify([
  source.schema,source.taskId,source.ownerId,source.groupId,source.groupVersion,
  source.messageId,source.rootId,source.messageCreatedAt,source.messageText,
  // group-resource 仍投影成旧算法逐字相同的二元组，历史行的 snapshot_digest 因此一字不变；
  // 只有本期新增的 attachment / artifact 才带上 kind。
  source.references.map(reference=>reference.kind==='group-resource'?[reference.id,reference.version]:[reference.kind,reference.id,reference.version]),
  source.createdAssignee&&[source.createdAssignee.roleId,source.createdAssignee.roleVersion],source.createdAt,
  // v2 才追加关系、上下文模式、尝试世代与执行策略；v1 序列逐字不变。
  ...(source.schema==='teloa.group-task-source/v2'?[[source.replyToMessageId,source.contextMode,source.routingAttemptVersion,source.executionMode,source.trigger]]:[]),
  ...(source.schema==='teloa.group-task-source/v2'&&source.businessTarget?[[source.businessTarget.scope,source.businessTarget.object?[source.businessTarget.object.scope,source.businessTarget.object.type,source.businessTarget.object.id,source.businessTarget.object.version,source.businessTarget.object.snapshotHash]:null]]:[]),
  ...(source.schema==='teloa.group-task-source/v2'&&source.ownerRequest?[[source.ownerRequest.messageId,source.ownerRequest.text,source.ownerRequest.sha256,...(source.ownerRequest.priorRequests?[source.ownerRequest.priorRequests.map(item=>[item.messageId,item.text,item.sha256])]:[])]]:[]),
 ])).digest('hex')
}
