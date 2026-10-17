import {roleSupportsScope,type Group} from '@teloa/contract'
import type {BusinessTarget} from './business-preview.js'
import type {AttentionItem} from './attention-item.js'
import type {PreviewTask} from './task-preview.js'
import type {PreviewRole} from './role-preview.js'
import {businessScopeTasks} from './business-current-presentation.ts'

/** 业务面只投影平台已保存身份与工作，不生成另一套行业员工或示例统计。 */
export function businessWorkspaceProjection(scope:string,tasks:readonly PreviewTask[],roles:readonly PreviewRole[],attention:readonly AttentionItem[]){
 const saved=businessScopeTasks(tasks,scope)
 return {
  current:saved.filter(task=>task.state!=='completed'&&task.state!=='cancelled'),
  completed:saved.filter(task=>task.state==='completed'),
  roles:roles.filter(role=>role.storage==='persistent'&&role.kind==='employee'&&role.state!=='retired'&&roleSupportsScope(role.scopes,scope)),
  attention:attention.filter(item=>item.scope===scope&&item.persistence!=='example').sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)),
 }
}
export const businessWorkspaceGroups=(groups:readonly Group[],scope:string)=>groups.filter(group=>group.scope===scope&&!group.archived)

const businessSections=['overview','data','dashboards','employees','groups','projects'] as const
const generalSections=['overview','employees','groups','projects'] as const
/** general 是通用协作范围，业务数据仍属于明确登记的业务；旧目标不触发禁止的数据接口。 */
export const businessWorkspaceSections=(scope:string)=>scope==='general'?generalSections:businessSections
export const businessWorkspaceSection=(scope:string,section:BusinessTarget['section']):BusinessTarget['section']=>scope==='general'&&section!=='work'&&!generalSections.some(value=>value===section)?'overview':section
