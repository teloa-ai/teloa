import type {AttentionItem} from './attention-item.js'
import type {PreviewRole} from './role-preview.js'
import type {PreviewTask} from './task-preview.js'

export type ExampleDirectoryMode='saved'|'sandbox'

export const exampleDirectoryMode=(hasPersistence:boolean):ExampleDirectoryMode=>hasPersistence?'saved':'sandbox'

export const visibleTaskDirectory=(tasks:readonly PreviewTask[],mode:ExampleDirectoryMode):PreviewTask[]=>
  tasks.filter(task=>mode==='saved'?task.storage==='persistent':task.storage!=='persistent')

export const visibleRoleDirectory=(roles:readonly PreviewRole[],mode:ExampleDirectoryMode):PreviewRole[]=>
  roles.filter(role=>mode==='saved'?role.storage==='persistent':role.storage!=='persistent')

export const visibleAttentionDirectory=(items:readonly AttentionItem[],mode:ExampleDirectoryMode):AttentionItem[]=>
  items.filter(item=>mode==='saved'?item.persistence!=='example':item.persistence==='example')

/**
 * “需要你”是正式的决策队列，不是沙盒目录的另一种视图。
 * 聚合层只放仍待处理的事项；这里再排除演示投影，避免测试数据凭空生成筛选页签。
 */
export const visibleCurrentAttentionDirectory=(items:readonly AttentionItem[]):AttentionItem[]=>
  items.filter(item=>item.persistence!=='example')

/** 页签只来自此刻确实存在的待处理事项，顺序沿用聚合层的优先级顺序。 */
export const currentAttentionKinds=(items:readonly AttentionItem[]):AttentionItem['kind'][]=>
  [...new Set(items.map(item=>item.kind))]
