import type {BusinessScopeKind,BusinessScopeLabel} from './business-directory.js'
import type {PreviewRole} from './role-preview.js'

/** 未登记范围与空 scopes 的兜底分区标识；不用真实业务范围值，避免撞上宿主真实登记的标签。 */
export const ROSTER_OTHER_SECTION='__other__' as const
export type RosterSection={id:string;title:string;kind:BusinessScopeKind|'other';members:PreviewRole[]}

/**
 * 分区维度是业务范围而不是部门：岗位契约（`role-preview.ts` 的 `PreviewRole.scopes`）只有业务范围数组，
 * 没有 `dept` 字段——「部门」是原型 demo 专有的展示概念，正式 UI 唯一能拿到的分组维度就是范围标签（规格 §2.1）。
 *
 * 分区集合与顺序恒跟 `labels`（宿主登记顺序），不额外排序：这与业务范围切换器、已保存目录组标题同源，
 * 三处顺序保持一致比“看起来更整齐”的排序更重要。
 */
export function rosterSections(roles:readonly PreviewRole[],labels:readonly BusinessScopeLabel[],otherTitle:string):RosterSection[]{
 const registered=new Set(labels.map(label=>label.scope))
 const bucket=new Map<string,{title:string;kind:BusinessScopeKind|'other';members:PreviewRole[]}>()
 for(const label of labels)bucket.set(label.scope,{title:label.title,kind:label.kind,members:[]})
 bucket.set(ROSTER_OTHER_SECTION,{title:otherTitle,kind:'other',members:[]})
 for(const role of roles){
  // 跨范围同事在它声明的每一个已登记范围下各出现一次（规格 §4.2 Q4：通讯录里一个人挂两个部门是常态）；
  // 未登记范围（如迁移期的 Design）与空 scopes 一律并入「其他」。
  const ids=role.scopes.length?role.scopes.map(scope=>registered.has(scope)?scope:ROSTER_OTHER_SECTION):[ROSTER_OTHER_SECTION]
  for(const id of new Set(ids))bucket.get(id)!.members.push(role)
 }
 const order=[...labels.map(label=>label.scope),ROSTER_OTHER_SECTION]
 // 空分区不渲染：与原型 `groupsOf(...).filter(group => group.members.length)` 一致。
 return order.map(id=>({id,...bucket.get(id)!})).filter(section=>section.members.length>0)
}

/** 总数 chip 数的是去重后的岗位数：跨范围的人在分区里出现多次，但只是同一个人。 */
export const rosterTotal=(roles:readonly PreviewRole[]):number=>new Set(roles.map(role=>role.id)).size

/** 界面据此决定要不要出那句「分区人数相加会多于总数」的固定说明，不用每次都对比总数和分区人数之和。 */
export function rosterHasMultiScope(roles:readonly PreviewRole[],labels:readonly BusinessScopeLabel[]):boolean{
 const registered=new Set(labels.map(label=>label.scope))
 return roles.some(role=>{
  const ids=new Set(role.scopes.length?role.scopes.map(scope=>registered.has(scope)?scope:ROSTER_OTHER_SECTION):[ROSTER_OTHER_SECTION])
  return ids.size>1
 })
}
