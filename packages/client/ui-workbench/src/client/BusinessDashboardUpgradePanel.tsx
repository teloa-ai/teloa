import {useEffect,useRef,useState} from 'react'
import {ArrowRight} from 'lucide-react'
import {compareSemver,type BusinessConfigurationDraftResponseVersioned,type BusinessDashboardResourceDefinition} from '@teloa/contract'
import type {BusinessDashboardResourceApi,DashboardUpgradeInput,DashboardUpgradeConflict,DashboardUpgradeChoice} from './business-dashboard-resource-api.js'
import type {DashboardMarketAdoption,DashboardMarketPending} from './business-dashboard-market-journal.js'
import type {MarketItem} from './market-preview.js'
import type {BusinessScopeLabel} from './business-directory.js'
import {inspectIndustryContent} from './industry-content.js'
import {isIndustryManifest} from './industry-manifest.js'
import {BusinessDashboardMarketPanel} from './BusinessDashboardMarketPanel.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessDashboardUpgradePanel.module.css'
type Adoption={draft:BusinessConfigurationDraftResponseVersioned;result:DashboardMarketAdoption;resource:BusinessDashboardResourceDefinition}
type Props={item:MarketItem;candidates:readonly MarketItem[];api:BusinessDashboardResourceApi;adoption:Adoption;hydrate:(item:MarketItem)=>Promise<MarketItem>;spaces:readonly BusinessScopeLabel[];refreshScopes?:(()=>Promise<unknown>)|undefined;colorScheme:'light'|'dark';openSaved?:(scope:string)=>void}
/** 升级只能从原本人采用记录发起；固定新版后仍逐项比较，不沿用目录的「已添加」记号。 */
export function BusinessDashboardUpgradePanel(props:Props){
 const {t}=useI18n(),{item,api,adoption}=props,contentId=item.contentStorage?.contentId
 const [open,setOpen]=useState(false),[selected,setSelected]=useState(''),[candidate,setCandidate]=useState<MarketItem>(),[candidateVersion,setCandidateVersion]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(false),[conflicts,setConflicts]=useState<DashboardUpgradeConflict[]>([]),[choices,setChoices]=useState<Record<string,DashboardUpgradeChoice>>({}),[prepared,setPrepared]=useState<MarketItem>(),[locked,setLocked]=useState(false)
 const pending=useRef<DashboardMarketPending['upgrade']>(),running=useRef(false),alive=useRef(true)
 const draftJournalKey=(id:string)=>'upgrade:'+adoption.draft.id+':'+id
 const options=props.candidates.filter(value=>value.contentStorage?.contentId&&value.contentStorage.contentId!==contentId&&isIndustryManifest(value.manifest)&&value.manifest.resources.some(resource=>resource.kind==='business-configuration'&&(resource.source.kind==='public'?resource.source.id:resource.id)===adoption.resource.id&&compareSemver(resource.version,adoption.resource.version)>0))
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const act=async(run:()=>Promise<void>)=>{if(running.current)return;running.current=true;setBusy(true);setError(false);try{await run()}catch{if(alive.current)setError(true)}finally{running.current=false;if(alive.current)setBusy(false)}}
 const read=async(value:MarketItem)=>{
  const fixed=await props.hydrate(value)
  if(!fixed.contentStorage?.contentId||fixed.contentStorage.contentId!==value.contentStorage?.contentId||!fixed.packageContent||!isIndustryManifest(fixed.manifest))throw Error('candidate')
  const resource=fixed.manifest.resources.find(row=>row.kind==='business-configuration'&&(row.source.kind==='public'?row.source.id:row.id)===adoption.resource.id&&compareSemver(row.version,adoption.resource.version)>0)
  const inspection=resource&&inspectIndustryContent(fixed.manifest,fixed.packageContent).find(row=>row.id===resource.id)
  if(inspection?.state!=='parsed'||inspection.definition?.kind!=='business-configuration'||inspection.definition.definition.id!==adoption.resource.id)throw Error('candidate')
  return {fixed,resource:resource!,version:inspection.definition.definition.version}
 }
 const start=()=>act(async()=>{
  if(!contentId)return
  const stored=api.journal?.read(contentId)?.upgrade
  pending.current=stored
  setOpen(true);setLocked(!!stored&&!stored.draftId)
  if(stored){
   const option=options.find(value=>value.contentStorage?.contentId===stored.request.candidateContentId);if(!option)throw Error('source')
   const {fixed,version}=await read(option);if(fixed.packageContent!.hash!==stored.request.candidateContentHash||version!==stored.candidateVersion)throw Error('changed')
   setSelected(option.contentStorage!.contentId);setCandidate(fixed);setCandidateVersion(version);setChoices(stored.request.choices??{})
   if(stored.draftId){const saved=api.journal?.read(draftJournalKey(option.contentStorage!.contentId));if(saved?.draft?.id!==stored.draftId)throw Error('draft');setPrepared(fixed)}
  }
 })
 const choose=(id:string)=>{setSelected(id);setCandidate(undefined);setCandidateVersion('');setConflicts([]);setChoices({});pending.current=undefined;if(!id)return;void act(async()=>{const option=options.find(value=>value.contentStorage!.contentId===id);if(!option)throw Error('source');const {fixed,version}=await read(option);if(alive.current){setCandidate(fixed);setCandidateVersion(version)}})}
 const prepare=()=>act(async()=>{
  if(!contentId||!candidate)return
  let intention=pending.current
  if(!intention){
   const current=await api.current({scope:adoption.result.scope});if(!current)throw Error('configuration')
   const {fixed,resource,version}=await read(candidate)
   intention={request:{requestId:crypto.randomUUID(),adoptionId:adoption.draft.id,candidateContentId:fixed.contentStorage!.contentId,candidateContentHash:fixed.packageContent!.hash,resourceId:resource.id,expectedConfigurationVersion:current.version},candidateVersion:version}
  }
  const request=locked?intention.request:{...intention.request,...(Object.keys(choices).length?{choices}:{})}
  intention={...intention,request};pending.current=intention
  const original=api.journal?.read(contentId)??{draft:adoption.draft,result:adoption.result}
  api.journal?.write(contentId,{...original,upgrade:intention});setLocked(true)
  let value:Awaited<ReturnType<BusinessDashboardResourceApi['prepareUpgrade']>>
  try{value=await api.prepareUpgrade(request)}catch(error){
   if(error&&typeof error==='object'&&'code' in error&&['teloa/version-conflict','teloa/source-unavailable','teloa/invalid-input','teloa/forbidden','teloa/conflict'].includes(String(error.code))){const {upgrade:_,...adopted}=original;api.journal?.write(contentId,adopted);pending.current=undefined;setLocked(false);setConflicts([]);setChoices({})}throw error
  }
  if(!alive.current)return
  if(value.draft){
   if(value.draft.scope!==adoption.result.scope)throw Error('scope')
   // 先保存新草案，再给原采用记录加指针；故障不移除原采用事实。
   api.journal?.write(draftJournalKey(request.candidateContentId),{resourceId:request.resourceId,draft:value.draft})
   api.journal?.write(contentId,{...original,upgrade:{...intention,draftId:value.draft.id}})
   setPrepared(candidate);setLocked(false)
  }else{setConflicts(value.conflicts);setLocked(false)}
 })
 const close=()=>{if(locked)return;if(contentId){const stored=api.journal?.read(contentId);if(stored){const {upgrade:_,...original}=stored;api.journal?.write(contentId,original)}}setOpen(false);setCandidate(undefined);setSelected('');setConflicts([]);setChoices({});pending.current=undefined}
 if(prepared)return <BusinessDashboardMarketPanel journalKey={draftJournalKey(prepared.contentStorage!.contentId)} onDiscardDraft={()=>{setPrepared(undefined);close()}} key={prepared.contentStorage!.contentId} item={prepared} api={api} refreshScopes={props.refreshScopes} spaces={props.spaces} colorScheme={props.colorScheme} {...(props.openSaved?{openSaved:props.openSaved}:{})}/>
 return <section className={css.panel} aria-label={t('market.dashboard.upgrade')}>
  {!open?<button type="button" disabled={busy||!api.journal||!contentId} onClick={()=>void start()}>{t('market.dashboard.upgrade')}</button>:<><header><h3>{t('market.dashboard.upgrade')}</h3><p className={css.versionChange}>{adoption.resource.id} · v{adoption.resource.version} <ArrowRight size={14} role="img" aria-label={t('presentation.changeTo')}/> {candidateVersion||'…'}</p></header><p>{t('market.dashboard.upgradeBoundary')}</p>
   <label>{t('market.dashboard.candidate')}<select aria-label={t('market.dashboard.candidate')} value={selected} disabled={busy||locked} onChange={event=>choose(event.target.value)}><option value="">{t('market.industry.update.choose')}</option>{options.map(option=><option key={option.contentStorage!.contentId} value={option.contentStorage!.contentId}>{option.title} · v{option.version}</option>)}</select></label>
   {!options.length&&<p role="status">{t('market.dashboard.noCandidate')}</p>}{candidate&&<dl><dt>{t('business.share.version')}</dt><dd>{candidateVersion}</dd><dt>SHA-256</dt><dd>{candidate.packageContent!.hash}</dd></dl>}
   {conflicts.map(row=><fieldset key={row.key}><legend>{row.kind??row.entity} · {row.id}</legend><div className={css.diff}><section><h4>{t('market.dashboard.local')}</h4><pre>{JSON.stringify(row.current,null,2)}</pre></section><section><h4>{t('market.dashboard.incoming')}</h4><pre>{JSON.stringify(row.incoming,null,2)}</pre></section></div><label><input type="radio" name={row.key} checked={choices[row.key]==='keep-local'} disabled={busy||locked} onChange={()=>setChoices(value=>({...value,[row.key]:'keep-local'}))}/>{t('market.industry.update.keepLocal')}</label><label><input type="radio" name={row.key} checked={choices[row.key]==='use-incoming'} disabled={busy||locked} onChange={()=>setChoices(value=>({...value,[row.key]:'use-incoming'}))}/>{t('market.industry.update.useCandidate')}</label></fieldset>)}
   {locked&&<p role="status">{t('market.dashboard.upgradeUnknown')}</p>}{error&&<p role="alert">{t('business.builder.error')}</p>}
   <footer><button type="button" disabled={busy||!candidate||!locked&&conflicts.some(row=>!choices[row.key])} onClick={()=>void prepare()}>{locked?t('market.dashboard.checkDraft'):t('market.dashboard.prepare')}</button><button type="button" disabled={busy||locked} onClick={close}>{t('market.dashboard.cancel')}</button></footer>
  </>}
 </section>
}
