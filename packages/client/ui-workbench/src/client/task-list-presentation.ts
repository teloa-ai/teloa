import type {AttentionKind,PreviewTask} from './task-preview.js'
import type {TeloaTranslate} from './i18n/index.js'

/** 内部占位值在显示时翻译，业务对象标题仍保留来源原文。 */
export function taskObjectLabel(task:Pick<PreviewTask,'object'|'storage'>,t:TeloaTranslate):string{
  if(task.storage==='persistent'&&task.object==='本机任务')return t('task.rail.source.local')
  if(!task.storage&&task.object==='通用任务')return t('task.approval.object.general')
  return task.object
}

export type TaskRowAttention={kinds:readonly AttentionKind[];reason:'approval'|'error'|'review'|'blocked'|null}

const reasonRank={approval:0,error:1,review:2,blocked:3} as const

/** 置顶权重：approval 0 < error 1 < review 2 < blocked 3 < 无 4；同权重按 updatedAt 降序；再按 id 升序。 */
export function pinRank(attention:TaskRowAttention,state:PreviewTask['state']):number{
  if(attention.reason)return reasonRank[attention.reason]
  return state==='blocked'?reasonRank.blocked:4
}

export function sortTaskRows<T extends {task:PreviewTask;attention:TaskRowAttention}>(rows:readonly T[]):T[]{
  return [...rows].sort((a,b)=>pinRank(a.attention,a.task.state)-pinRank(b.attention,b.task.state)||b.task.updatedAt.localeCompare(a.task.updatedAt)||a.task.id.localeCompare(b.task.id))
}

/** routed = task.source?.trigger==='routed'；filter 'formal' 时 routed 行整组不返回。 */
export function groupTaskRows<T extends {task:PreviewTask}>(rows:readonly T[],filter:'all'|'formal'):{formal:T[];routed:T[]}{
  const formal:T[]=[],routed:T[]=[]
  for(const row of rows)(row.task.source?.trigger==='routed'?routed:formal).push(row)
  return {formal,routed:filter==='formal'?[]:routed}
}

/** ↑↓/Home/End 漫游：返回下一个 index 或 undefined（照 MarketResourceCatalog.tsx:53-57）。 */
export function nextListIndex(key:string,current:number,length:number):number|undefined{
  return key==='ArrowDown'?Math.min(length-1,current+1):key==='ArrowUp'?Math.max(0,current-1):key==='Home'?0:key==='End'?length-1:undefined
}
