import { taskNeeds, type PreviewTask } from './task-preview.ts'

export type RoleTimelineKind = 'needsYou' | 'artifact' | 'recent'
export type RoleTimelineItem = { id: string; kind: RoleTimelineKind; task: PreviewTask }

/**
 * 个人主页时间线：全部来自调用方已有的 `state.tasks`/`state.artifacts`，不新增端点（规格 §4.5.1）。
 * 三档顺序固定：待你决定 → 产出 → 最近工作；只列 `assigneeId` 命中的工作——
 * `authorId`/`assigneeHistory` 命中但没接手的历史关联挪去别处（编辑态的折叠小字），不进主时间线，
 * 避免时间线的语义从「它最近做了什么」漂移成「和它有关的一切」。
 */
export function roleTimeline(roleId: string, tasks: readonly PreviewTask[], artifacts: readonly { taskId?: string }[]): RoleTimelineItem[] {
    const owned = tasks.filter(task => task.assigneeId === roleId)
    const hasArtifact = (task: PreviewTask) => artifacts.some(item => item.taskId === task.id)
    // 三档之间的先后由规格固定，档内按最近更新在前：`updatedAt` 是 ISO 串，直接字典序倒排即可；
    // 缺 `updatedAt` 的排在最后（空串永远比 ISO 串小），排序稳定，同刻更新的仍保持调用方给的原序。
    const byRecent = (rows: PreviewTask[]) => [...rows].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    const needsYou = byRecent(owned.filter(task => taskNeeds(task).length > 0))
    const artifactDone = byRecent(owned.filter(task => taskNeeds(task).length === 0 && hasArtifact(task)))
    const recent = byRecent(owned.filter(task => taskNeeds(task).length === 0 && !hasArtifact(task)))
    return [
        ...needsYou.map((task): RoleTimelineItem => ({ id: 'n-' + task.id, kind: 'needsYou', task })),
        ...artifactDone.map((task): RoleTimelineItem => ({ id: 'a-' + task.id, kind: 'artifact', task })),
        ...recent.map((task): RoleTimelineItem => ({ id: 'w-' + task.id, kind: 'recent', task })),
    ]
}
