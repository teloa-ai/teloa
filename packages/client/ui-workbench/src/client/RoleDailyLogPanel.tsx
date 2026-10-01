import { useEffect, useState } from 'react'
import clsx from 'clsx'
import {Play,ShieldCheck,MessageSquare,FileText,MoreHorizontal,TriangleAlert} from 'lucide-react'
import {autoDreamObservationDay} from './auto-dream-day.js'
import type { RoleDailyLog, RoleDailyLogEvidence, RoleDailyLogKind, RoleDailyLogSummary, RoleMemory, ScheduleTrigger } from '@teloa/contract'
import type { RoleDailyLogApi } from './role-daily-log-api.js'
import type { RoleMemoryApi } from './role-memory-api.js'
import { useI18n } from './i18n/provider.js'
import { localizeWorkError } from './i18n/errors.js'
import css from './RoleDailyLogPanel.module.css'

export type RoleDailyLogPanelProps = {
  trigger?: Pick<ScheduleTrigger,'time'|'timezone'> | undefined
  now?: () => string
  roleId: string
  kind: RoleDailyLogKind
  api: RoleDailyLogApi
  memoryApi: RoleMemoryApi | undefined
  /** 分身侧「记下来」；同事侧不传（同事的候选由小结运行自己提）。 */
  promote?: (log: RoleDailyLog, value: { title: string; markdown: string }) => Promise<void>
}

// 5 个证据类型没有专属词条：按语义就近复用既有既有词条，不新增词条（缺词条铁律）。
const evidenceKindKey = (kind: RoleDailyLogEvidence['kind']) =>
  kind === 'approval' ? 'attention.approval' as const
  : kind === 'group-message' ? 'task.detail.sourceMessage' as const
  : kind === 'run' ? 'taskExecution.title' as const
  : 'task.detail.artifact' as const // artifact / revision：revision 本身就是对某个成果的修订，共用同一个名词。

export function RoleDailyLogPanel({ roleId, kind, api, memoryApi, promote, trigger, now }: RoleDailyLogPanelProps) {
  const { t, locale, dateTime } = useI18n()
  const [logs, setLogs] = useState<RoleDailyLogSummary[]>()
  const [logsError, setLogsError] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [detail, setDetail] = useState<RoleDailyLog>()
  const [detailError, setDetailError] = useState<string>()
  const [memories, setMemories] = useState<RoleMemory[]>()
  const [actionError, setActionError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [recoveryDiscarded, setRecoveryDiscarded] = useState(false)
  const [promoteTitle, setPromoteTitle] = useState('')
  const [promoteMarkdown, setPromoteMarkdown] = useState('')
  const [promoteCount, setPromoteCount] = useState(0)
  const [promoteBusy, setPromoteBusy] = useState(false)
  const [promoteError, setPromoteError] = useState<string>()

  useEffect(() => {
    let active = true
    setLogsError(undefined)
    void api.list(roleId).then(rows => { if (active) setLogs(rows) }).catch(error => { if (active) setLogsError(localizeWorkError(locale, error)) })
    return () => { active = false }
  }, [api, roleId, locale])

  useEffect(() => {
    if (!selected) { setDetail(undefined); return }
    let active = true
    setDetailError(undefined)
    void api.get(roleId, selected).then(log => { if (active) setDetail(log) }).catch(error => { if (active) setDetailError(localizeWorkError(locale, error)) })
    return () => { active = false }
  }, [api, roleId, selected, locale])

  useEffect(() => {
    if (!detail || !memoryApi) { setMemories(undefined); return }
    let active = true
    void memoryApi.list(roleId).then(rows => { if (active) setMemories(rows) }).catch(() => { if (active) setMemories([]) })
    return () => { active = false }
  }, [detail, memoryApi, roleId])

  // 每切一份日志，「记下来」表单重新起草并清空已记下的计数（一份观察最多记 3 条，见 habitLog.promoteLimit）。
  useEffect(() => {
    setPromoteTitle(detail?.title ?? '')
    setPromoteMarkdown(detail?.markdown ?? '')
    setPromoteCount(0)
    setPromoteError(undefined)
  }, [detail?.id])

  const applyMemoryUpdate = (saved: RoleMemory) => setMemories(rows => rows?.map(row => row.id === saved.id ? saved : row))
  const runMemoryAction = async (action: Promise<RoleMemory>) => {
    setBusy(true); setActionError(undefined)
    try { applyMemoryUpdate(await action) }
    catch (error) { setActionError(localizeWorkError(locale, error)) }
    finally { setBusy(false) }
  }
  const applyDiscardedLog = (log: RoleDailyLog) => {
    setLogs(rows => rows?.map(row => row.id === log.id ? { ...row, state: log.state } : row))
    setDetail(current => current && current.id === log.id ? log : current)
  }
  const discardLog = async (logId: string) => {
    setBusy(true); setActionError(undefined)
    try { applyDiscardedLog(await api.discard(logId)) }
    catch (error) { setActionError(localizeWorkError(locale, error)) }
    finally { setBusy(false) }
  }

  const candidates = detail ? (memories ?? []).filter(memory => memory.state !== 'withdrawn' && memory.source.id === detail.id) : []
  const paragraphs = (detail?.markdown ?? '').split(/\n{2,}/).map(part => part.trim()).filter(Boolean)
  // 上限判据与服务端 role-memory.ts 同口径：按 source.kind==='habit-digest'&&source.id===当前日志 数已取到的记忆条数，
  // 刷新后仍生效；promoteCount 只在同一会话里做乐观自增（等下一次 memories 重新拉取前，先挡住本地重复提交）。
  const promotedForDetail = detail ? (memories ?? []).filter(memory => memory.source.kind === 'habit-digest' && memory.source.id === detail.id).length : 0
  const promoteLimitReached = promotedForDetail + promoteCount >= 3
  // 「丢弃这份日志/观察」两个按钮共用一个文案键：习惯观察页读 habitLog.discard（「丢弃这份观察」），同事工作日志页仍读 dailyLog.discard。
  const discardLabelKey = kind === 'habit-digest' ? 'habitLog.discard' as const : 'dailyLog.discard' as const
  // 面板名用两份日志各自的标题（dailyLog.title / habitLog.title）；dailyLog.entry 只作同事主页的页签名。
  const panelTitleKey = kind === 'habit-digest' ? 'habitLog.title' as const : 'dailyLog.title' as const

  const today=trigger?autoDreamObservationDay((now??(()=>new Date().toISOString()))(),trigger):undefined
  const short=(day:string)=>dateTime(day+'T00:00:00.000Z',{month:'2-digit',day:'2-digit',timeZone:'UTC'})
  const remaining=Math.max(0,3-promotedForDetail-promoteCount)
  return <section className={css.panel} aria-label={t(panelTitleKey)}>
    <nav className={css.days} aria-label={t('dailyLog.recentCount',{count:logs?.length??0})}>
      <div className={css.daysHead}><span>{t('dailyLog.recentCount',{count:logs?.length??0})}</span></div>
      {logsError&&<p role="alert">{logsError}</p>}
      <ul className={css.list}>{logs?.map(log=><li key={log.id}><button type="button" className={clsx(css.day,selected===log.id&&css.dayCurrent,log.state==='discarded'&&css.dayOff)} aria-current={selected===log.id?'true':undefined} onClick={()=>{setSelected(log.id);setActionError(undefined)}}><span className={css.dayTitle}><i className={clsx(css.dot,log.state==='discarded'&&css.dotOff)} aria-hidden="true"/>{log.day===today?<strong>{t('dailyLog.today',{date:short(log.day)})}</strong>:short(log.day)}</span><small>{log.title}{log.state==='discarded'&&<> · {t('create.draft.discarded')}</>}</small></button></li>)}</ul>
    </nav>
    <div className={css.card}>
      {logs&&logs.length===0&&<div className={css.empty}><strong>{t(kind==='habit-digest'?'habitLog.emptyTitle':'dailyLog.emptyTitle')}</strong>{kind==='daily-digest'&&<p>{t('dailyLog.empty')}</p>}{trigger&&<p>{t('dailyLog.emptyNext',{time:trigger.time,timezone:trigger.timezone})}</p>}</div>}
      {detailError&&<p role="alert">{detailError}</p>}
      {detail&&<article className={css.detail} aria-label={detail.title}>
        <header className={css.cardHead}><div><p className={css.eyebrow}>{t(panelTitleKey)} · {dateTime(detail.createdAt,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}{kind==='habit-digest'&&<> · {t('habitLog.private')}</>}</p><h3>{detail.title}</h3></div>
          <details className={css.menu}><summary aria-label={t('dailyLog.more')} aria-haspopup="menu"><MoreHorizontal size={16}/></summary><div className={css.menuList} role="menu">
            {detail.state!=='discarded'&&<button type="button" role="menuitem" disabled={busy} onClick={()=>discardLog(detail.id)}>{t(discardLabelKey)}</button>}
      {api.pending() && <button type="button" role="menuitem" aria-label={t('dailyLog.recover')} disabled={busy} onClick={async () => { setBusy(true); setActionError(undefined); try { applyDiscardedLog(await api.recover()) } catch (error) { setActionError(localizeWorkError(locale, error)) } finally { setBusy(false) } }}>{t('dailyLog.recover')}</button>}
            {api.recoveryMessage()!==undefined&&<button type="button" role="menuitem" onClick={()=>{api.discardPending();setRecoveryDiscarded(true)}}>{t('recovery.discard')}</button>}
          </div></details>
        </header>
        {paragraphs.length?paragraphs.map((paragraph,index)=><p key={index}>{paragraph}</p>):<p>{detail.markdown}</p>}
        <section aria-label={t('dailyLog.evidence')}><h4 className={css.sectionTitle}>{t('dailyLog.evidenceCount',{count:detail.evidence.length})}</h4><ul>{detail.evidence.map(item=>{const Icon=item.kind==='run'?Play:item.kind==='approval'?ShieldCheck:item.kind==='group-message'?MessageSquare:FileText;return <li className={css.evidence} key={item.kind+item.id}><Icon size={14} aria-hidden="true"/><span>{item.title}</span><small className={css.evidenceKind}>{t(evidenceKindKey(item.kind))} · v{item.version}</small></li>})}</ul></section>
        <section aria-label={t('dailyLog.candidates')}><h4 className={css.sectionTitle}>{t('dailyLog.candidateCount',{count:candidates.length})}</h4><p>{t('dailyLog.candidateHint')}</p><ul>{candidates.map(memory=><li className={css.candidate} key={memory.id}><span>{memory.title}</span><span>{t(!memory.sourceAvailable?'roleMemory.sourceGone':memory.state==='confirmed'?'team.presentation.memory.confirmed.label':'team.presentation.memory.candidate.label')}</span><span className={css.candidateActions}>
          {memoryApi&&memory.state==='candidate'&&<button type="button" disabled={busy||!memory.sourceAvailable} onClick={()=>runMemoryAction(memoryApi.confirm(memory.id,memory.stateVersion))}>{t('team.memory.confirm')}</button>}
          {memoryApi&&<button type="button" disabled={busy} onClick={()=>runMemoryAction(memoryApi.withdraw(memory.id,memory.stateVersion))}>{t('team.memory.withdraw')}</button>}
        </span></li>)}</ul></section>
        {kind==='habit-digest'&&promote&&<details className={css.fold}><summary aria-disabled={promoteLimitReached||undefined}>{promoteLimitReached?t('habitLog.promoteLimit'):t('habitLog.promoteFold',{count:remaining})}</summary><div className={css.foldForm}>
          {!promoteLimitReached&&<p>{t('habitLog.promoteLimit')}</p>}
        <label>{t('team.memory.record')}<input value={promoteTitle} maxLength={120} onChange={event => setPromoteTitle(event.target.value)} /></label>
        <label>{t('team.form.memory.candidateBody')}<textarea value={promoteMarkdown} onChange={event => setPromoteMarkdown(event.target.value)} /></label>
        {promoteError && <p role="alert">{promoteError}</p>}
        <button type="button" disabled={promoteBusy || promoteLimitReached || !promoteTitle.trim() || !promoteMarkdown.trim()} onClick={async () => {
          setPromoteBusy(true); setPromoteError(undefined)
          try { await promote(detail, { title: promoteTitle.trim(), markdown: promoteMarkdown.trim() }); setPromoteCount(count => count + 1) }
          catch (error) { setPromoteError(localizeWorkError(locale, error)) }
          finally { setPromoteBusy(false) }
        }}>{t('habitLog.promote')}</button>
        </div></details>}
        {detail.pruneHints.length>0&&<section className={css.warn} aria-label={t('dailyLog.pruneHints')}><h4 className={css.sectionTitle}><TriangleAlert size={14}/>{t('dailyLog.pruneHintsCount',{count:detail.pruneHints.length})}</h4><p>{t('dailyLog.pruneHintHint')}</p><ul>{detail.pruneHints.map(hint=>{
          const memory=memories?.find(row=>row.id===hint.memoryId)
          const stale=!memory||memory.state==='withdrawn'||memory.stateVersion!==hint.memoryStateVersion
          return <li key={hint.memoryId} className={stale?css.dayOff:undefined}><span>{hint.reason}</span>{stale&&<span>{t('dailyLog.pruneStale')}</span>}{memoryApi&&<button type="button" disabled={stale||busy} onClick={()=>memory&&runMemoryAction(memoryApi.withdraw(memory.id,memory.stateVersion))}>{t('team.memory.withdraw')}</button>}</li>
        })}</ul></section>}
        {actionError&&<p role="alert">{actionError}</p>}
        {api.recoveryMessage()!==undefined&&<p role="alert">{localizeWorkError(locale,api.recoveryMessage())} {t('recovery.nextStep')}</p>}
        {recoveryDiscarded&&<p role="status">{t('recovery.discarded')}</p>}
      </article>}
    </div>
  </section>
}
