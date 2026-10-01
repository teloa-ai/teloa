import type {PreviewRole} from './role-preview.ts'
import {taskNeeds, type PreviewTask} from './task-preview.ts'

/** 与 `TeamPage.tsx` 现有 `closed` 同一口径（`completed`/`cancelled` 才算结束）；独立导出给分区头三个数复用，避免各处各拷贝一份判断。 */
export const taskClosed=(state:PreviewTask['state']):boolean=>state==='completed'||state==='cancelled'

/** 「有待办」数的是人，「待你处理」数的是事——单位不同是刻意的，与原型逐字一致（规格 §4.4）。 */
export type RosterCounts={people:number;busy:number;waiting:number}

/**
 * 分区头三个数全部由既有 TaskPreview 字段现算，不新增端点（规格 §4.4）：
 * - people：分区筛选后的成员数，直接取数组长度。
 * - busy：成员里「名下存在未结束工作」的人数——数人不数事，一人挂三件未结束的工作也只算一位。
 * - waiting：成员名下 `taskNeeds(task).length>0` 的工作件数——跨成员求和、按件计不去重（含 handoff 推出的那类）。
 * 调用方必须传 `directoryState.tasks`（已按 `directoryMode` 过滤），不能传 `state.tasks`，
 * 否则示例目录里的样例工作会混进正式计数——这条约束靠调用方遵守，本函数只管纯计算，不关心 tasks 的来路。
 */
export function rosterCounts(members:readonly PreviewRole[],tasks:readonly PreviewTask[]):RosterCounts{
  // 分身默认存在但只能代拟，不是可派活的数字员工；它保留在名单人数里，不进入忙碌与待办统计。
  const memberIds=new Set(members.filter(member=>member.kind==='employee').map(member=>member.id))
  const relevant=tasks.filter(task=>memberIds.has(task.assigneeId))
  const busyIds=new Set(relevant.filter(task=>!taskClosed(task.state)).map(task=>task.assigneeId))
  return {people:members.length,busy:busyIds.size,waiting:relevant.filter(task=>taskNeeds(task).length>0).length}
}

/** 身份栏「待办工作」：名下未结束工作里 `updatedAt` 最新的那条标题；没有未结束工作则返回 `undefined`（界面据此显示「手上暂时没有事」）。 */
export function roleNowDoing(roleId:string,tasks:readonly PreviewTask[]):string|undefined{
  const open=tasks.filter(task=>task.assigneeId===roleId&&!taskClosed(task.state))
  if(!open.length)return undefined
  return open.reduce((latest,task)=>Date.parse(task.updatedAt)>Date.parse(latest.updatedAt)?task:latest).title
}

export const roleIsBusy=(roleId:string,tasks:readonly PreviewTask[]):boolean=>tasks.some(task=>task.assigneeId===roleId&&!taskClosed(task.state))
