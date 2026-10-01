import { openDialog } from './dialog-focus.js'
import { ArrowRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { bindingFormKey, type BindingForms, type BindingForm } from './capability-work.js'
import { type BindingChange, type BindingFields, type CapabilityBinding, type CapabilityPreview } from './capability-preview.js'
import { checkMarketTarget, type MarketTarget, type MarketTargetRef } from './market-target.js'
import type { PreviewTask } from './task-preview.js'
import base from './TaskPage.module.css'
import css from './MarketPage.module.css'
import type { TeloaTranslate } from './i18n/index.js'
import { useI18n } from './i18n/provider.js'
import { localizeWorkError } from './i18n/errors.js'
import {marketTargetCheckLabel,marketTargetKindLabel} from './i18n/market-target.js'

export type CapabilityBindingsProps = {
  state: CapabilityPreview; selected: string | null; selectedVersion:number|null; select: (id: string | null, version?:number) => void;
  forms:BindingForms; editForm:(binding:CapabilityBinding,version:number,patch:Partial<Pick<BindingForm,'fields'|'note'>>)=>void; clearForm:(id:string,version:number)=>void; rebaseForm:(binding:CapabilityBinding,version:number)=>void; attention:()=>void;
  change: (change: BindingChange) => void; targets: MarketTarget[]; tasks: PreviewTask[];
  openTarget: (target: MarketTargetRef) => void; openTask: (id: string) => void;
  market: (itemId?: string, intentId?: string) => void; nativeSettings: () => void;
}

export function CapabilityTargetPanel({ state, kind, id, scope, targets, open, market }: { state: CapabilityPreview; kind: MarketTargetRef['kind']; id: string; scope?: string; targets: MarketTarget[]; open: (id: string) => void; market: () => void }) {
  const {t}=useI18n()
  const rows = state.bindings.filter(binding => binding.target.kind === kind && binding.target.id === id && (!scope || binding.target.scope === scope))
  return <section className={css.bindingSummary} aria-label={t('capability.targetPanel.aria')}><h3>{t('capability.targetPanel.title')}</h3><p>{t('capability.targetPanel.description')}</p>{rows.map(binding => {const version=binding.versions.find(row=>row.version===binding.activeVersion)??binding.versions.at(-1);return <div key={binding.id}><button type="button" onClick={() => open(binding.id)}><strong>{binding.title}</strong><small>{binding.target.scope} · {availabilityLabel(binding,targets,t)}</small></button>{version&&<details><summary>{t('capability.scope.view')}</summary><p>{t(binding.activeVersion===null?'capability.version.candidate':'capability.version.lastActive')} v{version.version} · {t(usageKey(version.fields.usage))}</p><p>{t('capability.runtimeRef.prefix')}{version.fields.runtimeRef||t('capability.notSpecified')}</p><p>{t('capability.dataScope.prefix')}{version.fields.dataScope}</p><p>{t('capability.executionScope.prefix')}{version.fields.executionScope}</p><p>{t('capability.target.summary',{title:binding.target.title,version:binding.target.version})}</p></details>}</div>})}{!rows.length && <p>{t('capability.targetPanel.empty')}</p>}<button type="button" onClick={market}>{t('capability.market.select')}</button></section>
}

export function CapabilityBindings(props: CapabilityBindingsProps) {
  const {t}=useI18n()
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('current')
  const binding = props.state.bindings.find(binding => binding.id === props.selected)
  const rows = props.state.bindings.filter(binding => (filter === 'all' || (filter === 'removed' ? binding.removed : !binding.removed)) && [binding.title, binding.target.title, binding.id].some(text => text.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim())))
  return <section className={base.page} aria-label={t('capability.binding.aria')}>
    <div className={base.preview}><strong>{t('capability.demo.label')}</strong><span>{t('capability.demo.description')}</span></div>
    <header className={base.pageHeader}><div><h1>{t('capability.binding.title')}</h1><p>{t('capability.binding.description')}</p></div><button type="button" onClick={() => props.market()}>{t('capability.market.add')}</button></header>
    <div className={css.content}>{binding ? <BindingDetail key={binding.id} {...props} binding={binding}/> : props.selected ? <div className={base.empty}><h2>{t('capability.missing')}</h2><button type="button" onClick={() => props.select(null)}>{t('capability.directory.back')}</button></div> : <>
      <div className={css.filters}><input aria-label={t('capability.search.aria')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('capability.search.placeholder')}/><select aria-label={t('capability.filter.aria')} value={filter} onChange={event => setFilter(event.target.value)}><option value="current">{t('capability.filter.current')}</option><option value="removed">{t('capability.filter.removed')}</option><option value="all">{t('capability.filter.all')}</option></select></div>
      <div className={css.list}>{rows.map(row => <button type="button" key={row.id} onClick={() => props.select(row.id)}><span><strong>{row.title}</strong><small>{marketTargetKindLabel(t,row.target.kind)} · {row.target.title} · {row.target.scope} · {t('capability.target.version')} v{row.target.version}</small><small>{availabilityLabel(row,props.targets,t)}</small></span></button>)}</div>
      {!rows.length && <div className={base.empty}><h2>{t('capability.empty.title')}</h2><p>{t('capability.empty.description')}</p><button type="button" onClick={() => props.market()}>{t('capability.market.browse')}</button></div>}
    </>}</div>
  </section>
}

function BindingDetail({ binding, ...props }: CapabilityBindingsProps & { binding: CapabilityBinding }) {
  const {t,locale,dateTime}=useI18n()
  const [error, setError] = useState(''), [confirm, setConfirm] = useState<'disable' | 'remove' | null>(null)
  const versionNumber=props.selectedVersion??binding.versions.length
  const version=binding.versions.find(version=>version.version===versionNumber),active=binding.versions.find(version=>version.version===binding.activeVersion)
  if(!version)return <div className={base.empty} role="alert"><h2>{t('capability.version.missing')}</h2><p>{t('capability.version.noFallback')}</p><button type="button" onClick={()=>props.select(binding.id)}>{t('capability.version.current')}</button><button type="button" onClick={props.attention}>{t('capability.attention.back')}</button></div>
  const form=props.forms[bindingFormKey(binding.id,versionNumber)],fields=form?.fields??version.fields,note=form?.note??''
  const dirty=JSON.stringify(fields)!==JSON.stringify(version.fields),conflict=!!form&&form.baseRevision!==binding.revision
  const setNote=(value:string)=>props.editForm(binding,versionNumber,{note:value})
  const targetCheck = checkMarketTarget(binding.target, props.targets), targetCurrent = targetCheck.status === 'current'
  const activeLabel=t(!binding.disabled&&!binding.removed&&targetCurrent?'capability.version.activeLabel':'capability.version.lastActive')
  const related = props.tasks.filter(task => !['completed', 'cancelled'].includes(task.state) && (binding.target.kind === 'role' ? task.assigneeId === binding.target.id : binding.target.kind === 'group' ? task.source?.groupId === binding.target.id : task.scope === binding.target.scope))
  const act = (change: BindingChange) => { try { props.change({...change,now:new Date().toISOString()}); if(change.type==='check')props.clearForm(binding.id,versionNumber);setError(''); return true } catch (error) { setError(localizeWorkError(locale,error)); return false } }
  const command = { id: binding.id, expectedRevision: binding.revision, now: new Date().toISOString() }
  return <article className={css.detail} aria-label={t('capability.detail.aria')}>
    <div className={base.buttons}><button type="button" onClick={() => props.select(null)}>{t('capability.directory.back')}</button><button type="button" onClick={props.attention}>{t('capability.attention.back')}</button></div><h2>{binding.title}</h2><p>{availabilityLabel(binding,props.targets,t)}</p><small>{binding.id} · {t('capability.revision',{revision:binding.revision})}</small>
    {error && <p role="alert" className={css.notice}>{error}</p>}
    <div className={css.tags}><span>{marketTargetKindLabel(t,binding.target.kind)} · {binding.target.title}</span><span>{binding.target.scope}</span><span>{t('capability.target.version')} v{binding.target.version}</span><span>{t('capability.source')} {binding.source.itemVersion}</span></div>
    <div className={css.columns}><div><section className={css.sheet}>
      <h3>{t('capability.config.title')}</h3><label>{t('capability.config.viewVersion')} <select aria-label={t('capability.config.versionAria')} value={versionNumber} onChange={event => { props.select(binding.id,Number(event.target.value));setError('') }}>{binding.versions.map(version => <option key={version.version} value={version.version}>v{version.version}{version.version === binding.activeVersion ? ' · '+activeLabel : ''}{props.forms[bindingFormKey(binding.id,version.version)]?' · '+t('capability.config.unsaved'):''}</option>)}</select></label>
      {form&&<p role="status">{t('capability.config.unsavedDescription')}</p>}
      {conflict&&<div className={css.notice} role="alert"><p>{t('capability.config.conflict',{baseRevision:form.baseRevision,revision:binding.revision})}</p><button type="button" disabled={binding.removed} onClick={()=>props.rebaseForm(binding,versionNumber)}>{t('capability.config.rebase')}</button></div>}
      <BindingEditor fields={fields} removed={binding.removed} blocked={conflict} change={fields=>props.editForm(binding,versionNumber,{fields})} reset={()=>props.clearForm(binding.id,versionNumber)} save={fields => { if (act({ ...command, expectedRevision:form?.baseRevision??binding.revision, type: 'edit', fields })) { props.clearForm(binding.id,versionNumber);props.select(binding.id,binding.versions.length + 1) } }}/>
      <p>{t('capability.runtimeRef.description')}</p><button type="button" onClick={props.nativeSettings}>{t('capability.runtime.manage')}</button>
    </section><section className={css.sheet}><h3>{t('capability.change.title')}</h3>{dirty&&<p>{t('capability.change.savedOnly')}</p>}<p>{active?t('capability.change.compare',{activeLabel,activeVersion:active.version,selectedVersion:version.version}):t('capability.change.noActive')}</p><dl>{(['runtimeRef', 'usage', 'dataScope', 'executionScope'] as const).map(key => <div key={key}><dt>{t(fieldKey(key))}</dt><dd>{active?(key==='usage'?t(usageKey(active.fields.usage)):active.fields[key]||t('capability.notConfigured')):t('capability.notConfigured')} <ArrowRight size={12} role="img" aria-label={t('presentation.changeTo')} className={css.changeArrow}/> {key==='usage'?t(usageKey(version.fields.usage)):version.fields[key]||t('capability.toFill')}</dd></div>)}</dl><p>{t('capability.change.permissionNotice')}</p></section>
    <section className={css.sheet}><h3>{t('capability.history.title')}</h3><ol>{binding.history.map((entry, index) => <li key={index}><p>{entry.text}</p><small>{dateTime(entry.at)}</small></li>)}</ol></section></div>
    <aside><section className={css.sheet}><h3>{t('capability.verification.title')}</h3><p>{marketTargetCheckLabel(t,targetCheck)}</p><p>{version.check?t('capability.verification.result',{version:version.version,result:t(version.check.result==='passed'?'capability.result.passed':'capability.result.failed'),note:version.check.note}):t('capability.verification.unchecked')}</p>
      <label className={base.form}>{t('capability.verification.note')}<textarea aria-label={t('capability.verification.noteAria')} rows={3} maxLength={2000} value={note} disabled={binding.removed} onChange={event => setNote(event.target.value)} placeholder={t('capability.verification.placeholder')}/></label>
      {dirty && <p role="status">{t('capability.verification.unsaved')}</p>}
      <div className={base.buttons}>{(['passed', 'failed'] as const).map(result => <button type="button" key={result} disabled={conflict || dirty || binding.removed || !targetCurrent || !note.trim()} onClick={() => act({ ...command, type: 'check', version: versionNumber, result, note })}>{t(result==='passed'?'capability.action.checkPassed':'capability.action.checkFailed')}</button>)}</div>
      <button type="button" disabled={conflict || dirty || binding.removed || !targetCurrent || version.check?.result !== 'passed' || (binding.activeVersion === versionNumber && !binding.disabled)} onClick={() => act({ ...command, type: 'activate', version: versionNumber })}>{t('capability.action.activate',{version:versionNumber})}</button><p>{t('capability.action.activateNotice')}</p>
    </section><section className={css.sheet}><h3>{t('capability.sourceTarget.title')}</h3><p>{t('capability.sourceTarget.summary',{intentVersion:binding.source.intentVersion,itemVersion:binding.source.itemVersion})}</p><div className={base.buttons}><button type="button" onClick={() => props.market(binding.source.itemId, binding.source.intentId)}>{t('capability.sourceTarget.viewSource')}</button><button type="button" onClick={() => props.openTarget(binding.target)}>{t('capability.sourceTarget.viewTarget')}</button></div></section>
    <section className={css.sheet}><h3>{t('capability.lifecycle.title')}</h3><p>{t('capability.lifecycle.description')}</p><p>{t('capability.lifecycle.related',{count:related.length})}</p>{related.map(task => <p key={task.id}><button type="button" onClick={() => props.openTask(task.id)}>{task.title}</button></p>)}<div className={base.buttons}><button type="button" disabled={binding.removed || binding.disabled} onClick={() => {setError('');setConfirm('disable')}}>{t('capability.action.disable')}</button><button type="button" disabled={binding.removed || (binding.activeVersion !== null && !binding.disabled)} onClick={() => {setError('');setConfirm('remove')}}>{t('capability.action.remove')}</button></div></section></aside></div>
    {confirm && <BindingLifecycleDialog error={error} action={confirm} close={() => setConfirm(null)} save={reason => { if (act({ ...command, type: confirm, reason })) setConfirm(null) }}/>}</article>
}

function BindingEditor({ fields: draft, save, removed, blocked, change: setDraft, reset }: { fields: BindingFields; save: (fields: BindingFields) => void; removed: boolean; blocked:boolean; change:(fields:BindingFields)=>void; reset:()=>void }) {
  const {t}=useI18n()
  return <form className={base.form} onSubmit={event => { event.preventDefault(); save(draft) }}><label>{t('capability.field.runtimeRef')}<input required maxLength={300} disabled={removed} value={draft.runtimeRef} onChange={event => setDraft({ ...draft, runtimeRef: event.target.value })} placeholder={t('capability.field.runtimeRefPlaceholder')}/></label><label>{t('capability.field.usage')}<select disabled={removed} value={draft.usage} onChange={event => setDraft({ ...draft, usage: event.target.value as BindingFields['usage'] })}><option value="read">{t('capability.usage.read')}</option><option value="draft">{t('capability.usage.draft')}</option><option value="execute">{t('capability.usage.executeApproval')}</option></select></label><label>{t('capability.field.dataScope')}<textarea required rows={3} maxLength={2000} disabled={removed} value={draft.dataScope} onChange={event => setDraft({ ...draft, dataScope: event.target.value })}/></label><label>{t('capability.field.executionScope')}<textarea required rows={3} maxLength={2000} disabled={removed} value={draft.executionScope} onChange={event => setDraft({ ...draft, executionScope: event.target.value })}/></label><div className={base.buttons}><button type="submit" disabled={removed||blocked}>{t('capability.action.saveVersion')}</button><button type="button" disabled={removed} onClick={reset}>{t('capability.action.reset')}</button></div></form>
}

function BindingLifecycleDialog({ action, close, save, error }: { error:string; action: 'disable' | 'remove'; close: () => void; save: (reason: string) => void }) {
  const {t}=useI18n()
  const dialog = useRef<HTMLDialogElement>(null), [reason, setReason] = useState('')
  useEffect(() => openDialog(dialog.current,dialog.current?.querySelector('textarea')), [])
  const title=t(action==='disable'?'capability.dialog.disable':'capability.dialog.remove')
  return <dialog ref={dialog} className={base.dialog} onCancel={close} aria-label={title}><form className={base.form} onSubmit={event => { event.preventDefault(); save(reason) }}><h2>{title}</h2><p>{t('capability.dialog.description')}</p>{error&&<p role="alert">{error}</p>}<label>{t('capability.dialog.reason')}<textarea required rows={3} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)}/></label><div className={base.buttons}><button type="button" onClick={close}>{t('capability.dialog.cancel')}</button><button type="submit" disabled={!reason.trim()}>{t(action==='disable'?'capability.dialog.confirmDisable':'capability.dialog.confirmRemove')}</button></div></form></dialog>
}

const usageKey=(usage:BindingFields['usage'])=>`capability.usage.${usage}` as const
const fieldKey=(field:keyof BindingFields)=>`capability.field.${field}` as const
function availabilityLabel(binding:CapabilityBinding,targets:readonly MarketTarget[],t:TeloaTranslate):string{
  if(binding.removed)return t('capability.availability.removed')
  if(binding.disabled)return t('capability.availability.disabled')
  const target=checkMarketTarget(binding.target,targets)
  if(target.status!=='current')return marketTargetCheckLabel(t,target)
  if(binding.activeVersion===null)return t('capability.availability.pending')
  const active=binding.versions.find(version=>version.version===binding.activeVersion)
  if(active?.check?.result!=='passed')return t('capability.availability.failed')
  return t(binding.activeVersion!==binding.versions.length?'capability.availability.activeNewer':'capability.availability.active',{version:binding.activeVersion})
}
