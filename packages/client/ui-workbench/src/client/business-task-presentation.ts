import {canReceiveTask,type PreviewRole} from './role-preview.ts'
import type {PreviewTask} from './task-preview.js'
import type {BusinessTaskSource} from './business-task-api.ts'
import {objectRefTarget,type ObjectRef} from './business-preview.ts'
import {Fragment,createElement,type ReactNode} from 'react'

export type BusinessTaskMode='real'|'sandbox'

/**
 * 固定业务输入只可能属于正式业务任务。通用任务没有业务对象来源；页面内示例也不能
 * 借正式读口补出一份看似真实的引用。业务范围不能写死为某个行业，否则新增的 AppSec
 * 等范围会在任务本体存在时仍丢失固定输入。
 */
export const shouldLoadBusinessTaskSource=(task:{storage?:string;scope:string}):boolean=>task.storage==='persistent'&&task.scope!=='general'

/**
 * 任务在目录读取后被另一操作删除时，来源读口可以返回 not-found；它和普通任务返回
 * null 都表示“没有可并入的来源”。其余失败（权限、存储损坏、协议错误、网络错误）
 * 必须呈现，不能一并吞成空输入。
 */
export const businessTaskSourceMissing=(error:unknown):boolean=>error!==null&&typeof error==='object'&&'code' in error&&(error as {code?:unknown}).code==='teloa/not-found'

/**
 * 持久调查任务的固定输入。
 *
 * 任务本体（契约 `WorkTask`）只有标题、目标与业务身份，业务对象引用不在里面——它单独记在
 * `business-tasks/source` 那条来源回执上。`projectSavedTask` 因此投不出 `objectRefs`，
 * 任务详情的「固定输入」一栏在持久任务上永远是空的，会话页也就没有可点的业务对象。
 * 这里把来源回执并回台账，是补投影，不是新造事实：引用的每一个字段都来自回执。
 *
 * 标题取对象标识本身：回执里没有对象标题（`BusinessObjectReference` 只有身份与固定摘要），
 * 与其去猜一个好看的名字，不如把真正核对得上的那串标识原样摆出来。
 */
export function withBusinessTaskSource(task:PreviewTask,source:BusinessTaskSource|null):PreviewTask{
 if(!source)return task
 const ref:ObjectRef={scope:source.reference.scope as ObjectRef['scope'],type:source.reference.type,id:source.reference.id,version:source.reference.version,snapshotHash:source.reference.snapshotHash,title:source.reference.id}
 return {...task,objectRefs:[ref],businessSource:objectRefTarget(ref)}
}

/**
 * 可接任务的候选人只按当前对象所属业务范围筛选；动作可用性已经在业务台账层决定。
 */
export const persistentBusinessTaskAssignees=(roles:readonly PreviewRole[],scope:string)=>roles.filter(role=>role.storage==='persistent'&&canReceiveTask(role,scope))


export const businessTasksForMode=(tasks:readonly PreviewTask[],scope:string,mode:BusinessTaskMode)=>tasks.filter(task=>task.scope===scope&&(mode==='real'?task.storage==='persistent':task.storage!=='persistent'))

export function BusinessTaskActionPanel({pending,error,recovery,creation}:{pending:boolean;error:ReactNode;recovery:ReactNode;creation:ReactNode}){
 return createElement(Fragment,null,error,pending?recovery:creation)
}
