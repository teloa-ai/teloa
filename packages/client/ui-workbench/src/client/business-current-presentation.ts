import type { PreviewTask } from './task-preview.js'

/** 当前业务只读取已保存任务；页面演示项和其他业务范围都不能混进来。 */
export const businessScopeTasks = (tasks: readonly PreviewTask[], scope: string): readonly PreviewTask[] =>
    [...tasks.filter(task => task.storage === 'persistent' && task.scope === scope)]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))

/** 结项和取消是历史，不冒充“正在处理”。 */
export const businessCurrentTasks = (tasks: readonly PreviewTask[], scope: string): readonly PreviewTask[] =>
    businessScopeTasks(tasks, scope).filter(task => task.state !== 'completed' && task.state !== 'cancelled')

/** 需要人工处理的任务既可能显式带 need，也可能停在等待或阻塞状态。 */
export const businessCurrentWaiting = (tasks: readonly PreviewTask[], scope: string): readonly PreviewTask[] =>
    businessCurrentTasks(tasks, scope).filter(task => task.need !== null || task.state === 'waiting' || task.state === 'blocked')

/** 做过的事只呈现已经结项的正式任务；取消项仍是历史，但不混进已完成成果。 */
export const businessCompletedTasks = (tasks: readonly PreviewTask[], scope: string): readonly PreviewTask[] =>
    businessScopeTasks(tasks, scope).filter(task => task.state === 'completed' || task.state === 'cancelled')
