import {isIndustryManifest} from './industry-manifest.ts'
import {capabilityIcons} from './capability-icons.js'
import clsx from 'clsx'
import {ArrowUpRight, Boxes, Check, Plus, RefreshCw, TriangleAlert, type LucideIcon} from 'lucide-react'
import type { MarketItem } from './market-preview.js'
import type { IndustryLoadRecord } from './industry-load-api.js'
import type { IndustryResourceKind } from './industry-manifest.js'
import { marketCatalogItemCopy, type MarketCategory } from './market-home-presentation.js'
import { composeFromManifest, compositionSummary } from './industry-composition.js'
import { solutionInstalled, solutionMark, type SolutionMark } from './market-solution-presentation.js'
import { StaffAvatar } from './StaffAvatar.js'
import { staffAvatarSeed } from './staff-avatar-seed.js'
import { useI18n } from './i18n/provider.js'
import type { TeloaTranslate } from './i18n/index.js'
import css from './MarketPage.module.css'
import staffCss from './StaffAvatar.module.css'

const markIcon: Record<SolutionMark, LucideIcon> = { added: Check, restart: RefreshCw, available: Plus, conflict: TriangleAlert }
const markLabelKey: Record<SolutionMark, Parameters<TeloaTranslate>[0]> = {
 added: 'market.solution.mark.added' as Parameters<TeloaTranslate>[0],
 restart: 'market.solution.mark.restart' as Parameters<TeloaTranslate>[0],
 available: 'market.solution.mark.available' as Parameters<TeloaTranslate>[0],
 conflict: 'market.mark.conflict' as Parameters<TeloaTranslate>[0],
}
const containsKey = 'market.solution.contains' as Parameters<TeloaTranslate>[0]

// 状态用记号不用状态句：已添加 ✓ / 需重启 ↻ / 可添加 + / 有冲突 !；title 给悬停，srOnly 给读屏。
// 通用目录卡（MarketPage 的 MarketCards）也要这个记号替掉状态句，所以对外导出。
/** 记号的文字（读屏与拼可访问名用）。 */
export const stateMarkLabel = (mark: SolutionMark, t: TeloaTranslate) => t(markLabelKey[mark])

export function StateMark({ mark, t }: { mark: SolutionMark; t: TeloaTranslate }) {
 const Icon = markIcon[mark], label = t(markLabelKey[mark])
 return <span className={clsx(css.mark, css['mark_' + mark])} title={label}><Icon size={13} /><span className={css.srOnly}>{label}</span></span>
}

// 条目卡左侧 40px 形象：同事是本人形象，其余用类型图标。图标只是装饰，类型本身在详情里有文字。
const rowIcon: Partial<Record<IndustryResourceKind | MarketCategory, LucideIcon>> = capabilityIcons

/** 条目卡的形象位，资源目录（`IndustryResourceKind`）与通用目录（`MarketCategory`）共用一处，两边形象不会长歪。 */
export function ItemArt({ kind, title, seed }: { kind: IndustryResourceKind | MarketCategory; title: string; seed: string }) {
 if (kind === 'role' || kind === 'agent') return <StaffAvatar initial={[...title][0] ?? ''} seed={seed} size="md" />
 const Icon = rowIcon[kind] ?? Boxes
 return <span className={css.itemArt} aria-hidden="true"><Icon size={17} /></span>
}

export type SolutionCardsProps = {
 items: readonly MarketItem[]
 loads: readonly IndustryLoadRecord[]
 selectedId: string | undefined
 open: (id: string) => void
}

/**
 * App Store 式方案卡：先看「一句话得到什么」，状态用记号不用状态句。
 * 「包含」是七行分类法的名词计数摘要，与产品页、业务卡读同一个共享模块；左侧插画是纯 CSS 三点图形，
 * 色档按 staffAvatarSeed 从条目 id 稳定派生，直接复用同事头像那六档身份色，不另写一份颜色。
 */
export function SolutionCards({ items, loads, selectedId, open }: SolutionCardsProps) {
 const { locale, t } = useI18n()
 return <div className={css.bundleGrid}>{items.map(item => {
  const copy = marketCatalogItemCopy(item, locale)
  const manifest = isIndustryManifest(item.manifest) ? item.manifest : undefined
  // 没有清单就没有可说的组成，整行不渲染，不显示「0 位同事」。
  const contains = manifest ? compositionSummary(composeFromManifest(manifest), t, value => value.toLocaleString(locale)) : ''
  const loaded = solutionInstalled(item, loads)
  const mark = solutionMark({ loaded, restartRequired: false })
  return <button type="button" key={item.id} data-teloa-entry={item.id} className={css.bundleCard} aria-label={copy.title} aria-current={selectedId === item.id ? 'page' : undefined} onClick={() => open(item.id)}>
   <span className={clsx(css.bundleArt, staffCss['tone' + staffAvatarSeed(item.id).tone])} aria-hidden="true"><span /><span /><span /></span>
   <span className={css.bundleMain}>
    <span className={css.bundleTop}><strong>{copy.title}</strong><StateMark mark={mark} t={t} /></span>
    <span className={css.bundlePitch}>{copy.summary}</span>
    {contains && <span className={css.bundleContains}>{t(containsKey, { list: contains })}</span>}
   </span>
   <ArrowUpRight size={16} />
  </button>
 })}</div>
}
