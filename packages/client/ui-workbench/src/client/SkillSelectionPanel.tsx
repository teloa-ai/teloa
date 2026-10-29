import {useEffect,useRef,useState} from 'react'
import type {SkillInstallationRecord} from './skill-install-api.js'
import type {SkillSelectionApi,SkillSelection,SkillSelectionPreview} from './skill-selection-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './MarketPage.module.css'

/** 默认选择只影响后续解析；安装、旧加载引用与历史 Run 各自保留。 */
export function SkillSelectionPanel({api,record,onChanged}:{api:SkillSelectionApi;record:SkillInstallationRecord;onChanged:()=>void}){
 const {t,locale}=useI18n(),[selection,setSelection]=useState<SkillSelection>(),[preview,setPreview]=useState<SkillSelectionPreview>(),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0),[settled,setSettled]=useState(false)
 const generation=useRef(0),operation=useRef(false),mounted=useRef(true)
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 useEffect(()=>{
  const token=++generation.current;setLoading(true);setPreview(undefined);setConfirmed(false);setError('');setSelection(undefined)
  void api.get(record).then(value=>{if(token===generation.current)setSelection(value)},cause=>{if(token===generation.current)setError(localizeWorkError(locale,cause))}).finally(()=>{if(token===generation.current)setLoading(false)})
  return()=>{generation.current++}
 },[api,record.id,record.version,record.ownerId,record.bundleHash,record.trustHash,record.native.name,revision,locale])
 const run=async(action:(isCurrent:()=>boolean)=>Promise<void>)=>{
  if(operation.current)return
  const token=generation.current;operation.current=true;setBusy(true);setError('')
  try{await action(()=>mounted.current&&token===generation.current)}catch(cause){if(mounted.current&&token===generation.current)setError(localizeWorkError(locale,cause))}finally{operation.current=false;if(mounted.current)setBusy(false)}
 }
 const pending=api.pending(),recoveryError=api.recoveryMessage(),pendingHere=!!pending&&pending.ownerId===record.ownerId&&pending.command.nativeName===record.native.name&&pending.command.targetInstallationId===record.id,otherPending=!!pending&&!pendingHere
 const current=selection?.installationId===record.id
 const previewMatches=!!preview&&preview.target.id===record.id&&preview.target.ownerId===record.ownerId&&preview.target.version===record.version&&preview.target.bundleHash===record.bundleHash&&preview.target.trustHash===record.trustHash&&preview.target.native.name===record.native.name
 const apply=(recover:boolean)=>run(async isCurrent=>{
  if(!recover&&!previewMatches)throw Object.assign(Error('Selection preview changed'),{code:'teloa/version-conflict'})
  const result=recover?await api.recover(record):await api.change(preview!,record)
  if(!isCurrent())return
  setSelection(result.current);setPreview(undefined);setConfirmed(false);setSettled(true);onChanged()
 })
 const side=(label:string,installation:SkillInstallationRecord)=><section><h4>{label}</h4><p>{installation.source.resourceId} · {t('market.skill.selection.resourceVersion',{version:installation.source.resourceVersion})}</p><dl><dt>{t('market.skill.selection.publisher')}</dt><dd>{installation.trust?.publisher??t('market.skill.selection.undeclared')}</dd><dt>{t('market.skill.selection.bundleHash')}</dt><dd>{installation.bundleHash}</dd><dt>{t('market.skill.selection.trustHash')}</dt><dd>{installation.trustHash??t('market.skill.selection.undeclared')}</dd></dl></section>
 return <section className={css.sheet} aria-label={t('market.skill.selection.title')}>
  <h3>{t('market.skill.selection.title')}</h3>
  {loading?<p role="status">{t('market.skill.selection.loading')}</p>:selection&&<p role="status">{t(current?'market.skill.selection.current':'market.skill.selection.otherCurrent')}</p>}
  <p>{t('market.skill.selection.boundary')}</p>
  {settled&&<p role="status">{t('market.skill.selection.settled')}</p>}
  {(error||recoveryError)&&<p role="alert">{error||localizeWorkError(locale,recoveryError)}</p>}
  {otherPending&&<p role="status">{t('market.skill.selection.otherPending')}</p>}
  {pendingHere&&<p role="status">{t('market.skill.selection.pending')}</p>}
  {preview&&<section aria-label={t('market.skill.selection.previewTitle')}>
   <h4>{t('market.skill.selection.previewTitle')}</h4>
   {side(t('market.skill.selection.before'),preview.current)}{side(t('market.skill.selection.after'),preview.target)}
   <p>{t('market.skill.selection.keptUsages',{count:preview.impact.industryUsages.length})}</p>
   {preview.impact.target.availability==='disabled'&&<p role="alert">{t('market.skill.selection.targetDisabled')}</p>}
   <label><input type="checkbox" checked={confirmed} disabled={busy||!!pending||!!recoveryError} onChange={event=>setConfirmed(event.target.checked)}/>{t('market.skill.selection.confirmMeaning')}</label>
   <div className={css.buttons}><button type="button" disabled={busy||!!pending||!!recoveryError||!confirmed||!previewMatches||preview.impact.target.availability!=='enabled'} onClick={()=>void apply(false)}>{t('market.skill.selection.confirm')}</button><button type="button" disabled={busy||!!pending} onClick={()=>{setPreview(undefined);setConfirmed(false)}}>{t('market.common.cancel')}</button></div>
  </section>}
  <div className={css.buttons}>
   {!preview&&selection&&!current&&<button type="button" disabled={loading||busy||!!pending||!!recoveryError} onClick={()=>void run(async isCurrent=>{const result=await api.preview(record);if(!isCurrent())return;setPreview(result);setConfirmed(false);setSettled(false)})}>{t('market.skill.selection.preview')}</button>}
   {pendingHere&&<button type="button" disabled={busy||!!recoveryError} onClick={()=>void apply(true)}>{t('market.skill.selection.recover')}</button>}
   <button type="button" disabled={busy||loading} onClick={()=>{setRevision(value=>value+1);setSettled(false)}}>{t('market.skill.selection.refresh')}</button>
   {(pendingHere||recoveryError)&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{api.discard(record);setRevision(value=>value+1);setSettled(false)})}>{t('market.skill.selection.discard')}</button>}
  </div>
  {(pendingHere||recoveryError)&&<p>{t('market.skill.selection.discardBoundary')}</p>}
 </section>
}
