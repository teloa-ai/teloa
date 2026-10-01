import {createHash} from 'node:crypto'
import type {BusinessTaskSource} from './business-tasks.ts'

/** 保持既有来源记录的数组顺序与裸 hex 编码，不能替换为对象序列化。 */
export function businessTaskSourceDigest(source:BusinessTaskSource):string{
 return createHash('sha256').update(JSON.stringify([source.schema,source.taskId,source.ownerId,source.sourceId,source.reference.scope,source.reference.type,source.reference.id,source.reference.version,source.reference.snapshotHash,source.createdAssignee&&[source.createdAssignee.roleId,source.createdAssignee.roleVersion],source.createdAt])).digest('hex')
}
