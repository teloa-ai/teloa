import type {PreviewTask} from './task-preview.js'

export type HomeColleagueWorkItem=Pick<PreviewTask,'id'|'title'|'assigneeId'|'state'|'updatedAt'>
export type HomeColleagueWork={count:number;colleagueCount:number;latest:readonly HomeColleagueWorkItem[]}
const taskClosed=(state:PreviewTask['state']):boolean=>state==='completed'||state==='cancelled'

/**
 * 首页「同事在做」只读任务台账本身：不从岗位是否在岗、会话是否存在推断忙碌状态。
 * 本人负责、演示任务和已结束任务都不是数字员工正在处理的事实。
 */
export function homeColleagueWork(tasks:readonly PreviewTask[]):HomeColleagueWork{
 const active=tasks.filter(task=>task.storage==='persistent'&&task.assigneeId!=='self'&&!taskClosed(task.state))
 const latest=[...active].sort((left,right)=>Date.parse(right.updatedAt)-Date.parse(left.updatedAt)||left.id.localeCompare(right.id)).slice(0,2)
 return {count:active.length,colleagueCount:new Set(active.map(task=>task.assigneeId)).size,latest}
}
