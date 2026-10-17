import {useLayoutEffect, useMemo, useRef, useState, type ReactNode} from 'react'
import clsx from 'clsx'
import {Blocks, Plug, Puzzle} from 'lucide-react'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {staffAvatarSeed} from './staff-avatar-seed.js'
import {sharePackageSummary, type SharePackage, type ShareSummary} from './share-package-plan.js'
import {useI18n} from './i18n/provider.js'
import avatarCss from './StaffAvatar.module.css'
import css from './TemplateShareDrawer.module.css'

type TemplateStatus = 'draft' | 'published' | 'revoked' | 'unconfirmedStatus' | 'preview' | 'addedLabel'

/** 员工保留头像封面；没有员工的包只显示紧凑能力图标，不解引用首位员工。 */
function Cover({summary}: {summary: ShareSummary}) {
 if (summary.subject === 'team') return <div className={css.portraitGroup}>{summary.roles.slice(0, 3).map(role => <span key={role.resourceId} className={css.portrait}><EmployeeAvatar avatarKey={role.avatarKey} size="lg"/></span>)}{summary.roles.length > 3 && <span className={css.portraitMore}>+{summary.roles.length - 3}</span>}</div>
 if (summary.roles[0]) return <div className={css.portrait}><EmployeeAvatar avatarKey={summary.roles[0].avatarKey} size="xl"/></div>
 const Icon = summary.subject === 'mcp' ? Plug : summary.subject === 'app' ? Puzzle : Blocks
 return <Icon className={css.capabilityIcon} size={22} aria-hidden="true"/>
}

/** 分享与接收使用同一张卡，正文和编辑操作留在详情中。 */
export function TemplateShareCard({pkg, status, children}: {pkg: SharePackage; status: TemplateStatus; children: ReactNode}) {
 const {t} = useI18n()
 const [expanded, setExpanded] = useState(false)
 const [clipped, setClipped] = useState(false)
 const description = useRef<HTMLParagraphElement>(null)
 useLayoutEffect(() => {
  const node = description.current
  if (!node || expanded) return
  const measure = () => setClipped(node.scrollHeight > node.clientHeight + 1)
  const observer = new ResizeObserver(measure)
  observer.observe(node)
  measure()
  return () => observer.disconnect()
 }, [pkg.description, expanded])
 const summary = useMemo(() => sharePackageSummary(pkg), [pkg])
 const labels = [['role', 'employee'], ['knowledge', 'knowledge'], ['skill', 'skill'], ['mcp', 'connection'], ['plugin', 'plugin'], ['work-template', 'workTemplate'], ['plan', 'plan']] as const
 const tone = staffAvatarSeed(pkg.id).tone
 const complete = status === 'published' || status === 'addedLabel'
 const compact = summary.roles.length === 0
 const statusBadge = <span className={clsx(css.status, complete && css.statusGood)} role="status"><span aria-hidden="true"/>{t(`templateShare.${status}`)}</span>
 const identity = <><span className={css.subject}>{t(`templateShare.subject.${summary.subject}`)}</span><h3>{pkg.title}</h3></>
 return <article className={clsx(css.card, compact && css.compactCard)}>
  {!compact && <div className={clsx(css.cover, avatarCss['tone' + tone])}>
   {statusBadge}
   <Cover summary={summary}/>
  </div>}
  <div className={css.cardContent}>
   {compact ? <div className={css.compactIdentity}><Cover summary={summary}/><div className={css.identityText}>{identity}</div>{statusBadge}</div> : identity}
   <p ref={description} className={clsx(css.description, !expanded && css.descriptionClamped)}>{pkg.description}</p>
   {(clipped || expanded) && <button type="button" className={css.textButton} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'templateShare.readLess' : 'templateShare.readMore')}</button>}
   <div className={css.cardMeta}><span>v{pkg.version}</span><span aria-hidden="true">·</span>{labels.filter(([kind]) => summary.counts[kind]).map(([kind, label]) => <span key={kind}>{t(`templateShare.${label}`)} {summary.counts[kind]}</span>)}{summary.license && <><span aria-hidden="true">·</span><span>{summary.license}</span></>}</div>
   <div className={css.cardActions}>{children}</div>
  </div>
 </article>
}
