import { initialBusinessSpaces,type BusinessScopeLabel } from './business-directory.ts'
import { type CollaborationPreview } from './collaboration-preview.ts'
import type { PreviewRole } from './role-preview.ts'

export const marketTargetKinds = ['business', 'role', 'group'] as const
export type MarketTargetRef = { kind: typeof marketTargetKinds[number]; id: string; scope: string; version: number; title: string }
export type MarketTarget = MarketTargetRef & { availability: 'active' | 'paused' | 'retired' | 'archived' }
export type MarketTargetCheck =
  | { status: 'unselected' | 'current' | 'missing' | 'changed'; params: Record<string, never> }
  | { status: 'unavailable'; params: { state: Exclude<MarketTarget['availability'], 'active'> } }

export class MarketTargetCheckError extends Error {
  readonly code = 'teloa/market-target-check'
  readonly check: MarketTargetCheck

  constructor(check: MarketTargetCheck) {
    super(`market-target/${check.status}`)
    this.name = 'MarketTargetCheckError'
    this.check = check
  }
}

export const marketTargetKey = (target: Pick<MarketTargetRef, 'kind' | 'id' | 'scope'>) => JSON.stringify([target.kind, target.id, target.scope])

/**
 * 仅投影当前界面目录，不产生组织授权或运行时绑定。
 *
 * 业务目标按业务范围标签身份识别：`marketTargetKey` 由 `[kind,id,scope]` 组成，
 * 业务目标的 `id` 与 `scope` 都是标签本身，所以一个标签就是一个目标，不需要版本。
 * `version` 恒为 1 只是为了与岗位 / 群组共用 `MarketTargetRef` 的形状——
 * 标签没有版本，`checkMarketTarget` 的 `changed` 分支对业务目标因此永远不成立，
 * 标签改标题或计数不会把已冻结的使用意图判成失效。
 */
export function marketTargets(roles: readonly PreviewRole[], collaboration: CollaborationPreview,labels:readonly BusinessScopeLabel[]=initialBusinessSpaces()): MarketTarget[] {
  return [
    ...labels.map((label): MarketTarget => ({ kind: 'business', id: label.scope, scope:label.scope, title:label.title, version:1, availability: 'active' })),
    ...roles.flatMap(role => role.scopes.map((scope): MarketTarget => ({ kind: 'role', id: role.id, scope, title: role.name, version: role.version, availability: role.state }))),
    ...collaboration.groups.map((group): MarketTarget => ({ kind: 'group', id: group.id, scope: group.scope, title: group.name, version: group.version, availability: group.archived ? 'archived' : 'active' })),
  ]
}

export function checkMarketTarget(ref: MarketTargetRef | undefined, targets: readonly MarketTarget[]): MarketTargetCheck {
  if (!ref) return { status: 'unselected', params: {} }
  const target = targets.find(target => marketTargetKey(target) === marketTargetKey(ref))
  if (!target) return { status: 'missing', params: {} }
  if (target.availability !== 'active') {
    return { status: 'unavailable', params: { state: target.availability } }
  }
  if (target.version !== ref.version) return { status: 'changed', params: {} }
  return { status: 'current', params: {} }
}

export function freezeMarketTarget(ref: MarketTargetRef, targets: readonly MarketTarget[]): MarketTargetRef {
  const check = checkMarketTarget(ref, targets)
  if (check.status !== 'current') throw new MarketTargetCheckError(check)
  const target = targets.find(target => marketTargetKey(target) === marketTargetKey(ref))!
  return { kind: target.kind, id: target.id, scope: target.scope, version: target.version, title: target.title }
}
