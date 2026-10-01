import {useEffect,useRef,useState,type ReactNode} from 'react'
import type {BusinessConfigurationDraftResponseVersioned,BusinessConfigurationPreviewResponse,BusinessConfigurationPageProjectionVersioned,BusinessConfigurationCurrentResponseVersioned,BusinessConfigurationApplyResult,BusinessDashboardResourceDefinition} from '@teloa/contract'
import type {DashboardMarketAdoption} from './business-dashboard-market-journal.js'
import type {BusinessDashboardResourceApi,DashboardApplyInput,DashboardPrepareInput} from './business-dashboard-resource-api.js'
import type {MarketItem} from './market-preview.js'
import type {BusinessScopeLabel} from './business-directory.js'
import {inspectIndustryContent} from './industry-content.js'
import {isIndustryManifest} from './industry-manifest.js'
import {BusinessConfigurationPage} from './BusinessConfigurationPage.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessBuilderPanel.module.css'
import own from './BusinessDashboardMarketPanel.module.css'
const rejected=(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/not-found','teloa/source-unavailable','teloa/version-conflict','teloa/conflict'].includes(String(error.code))
export type BusinessDashboardMarketPanelProps={item:MarketItem;api:BusinessDashboardResourceApi;spaces:readonly BusinessScopeLabel[];colorScheme:'light'|'dark';journalKey?:string;refreshScopes?:(()=>Promise<unknown>)|undefined;onDiscardDraft?:()=>void;openSaved?:(scope:string)=>void;upgrade?:(adoption:{draft:BusinessConfigurationDraftResponseVersioned;result:DashboardMarketAdoption;resource:BusinessDashboardResourceDefinition})=>ReactNode}
/** 添加固定内容只打开此面板；生成草案、预览与本人采用均为独立操作。 */
export function BusinessDashboardMarketPanel({item,api,spaces,colorScheme,openSaved,upgrade,journalKey,onDiscardDraft,refreshScopes}:BusinessDashboardMarketPanelProps){
 const {t}=useI18n(),alive=useRef(true),running=useRef(false)
 const rows=isIndustryManifest(item.manifest)&&item.packageContent?inspectIndustryContent(item.manifest,item.packageContent).filter(row=>row.state==='parsed'&&row.definition?.kind==='business-configuration'):[]
 const contentId=item.contentStorage?.contentId,journalId=journalKey??item.contentStorage?.contentId
 const restored=useRef<{value?:ReturnType<NonNullable<BusinessDashboardResourceApi['journal']>['read']>;error?:unknown}>()
 if(!restored.current){try{restored.current={value:contentId?api.journal?.read(journalId!):undefined}}catch(error){restored.current={error}}}
 const [resourceId,setResourceId]=useState(restored.current.value?.resourceId??restored.current.value?.prepare?.resourceId??rows[0]?.id??''),[scope,setScope]=useState(restored.current.value?.prepare?.target.kind==='existing'?restored.current.value.prepare.target.scope:''),[title,setTitle]=useState(restored.current.value?.prepare?.target.kind==='new'?restored.current.value.prepare.target.title:item.title),[current,setCurrent]=useState<BusinessConfigurationCurrentResponseVersioned|null>(),[mapping,setMapping]=useState<Record<string,string>>({})
 const [draft,setDraft]=useState<BusinessConfigurationDraftResponseVersioned|undefined>(restored.current.value?.draft),[preview,setPreview]=useState<BusinessConfigurationPreviewResponse>(),[page,setPage]=useState<BusinessConfigurationPageProjectionVersioned>(),[result,setResult]=useState<DashboardMarketAdoption|undefined>(restored.current.value?.result),[busy,setBusy]=useState(false),[error,setError]=useState(!!restored.current.error),[pending,setPending]=useState<DashboardApplyInput|undefined>(restored.current.value?.apply)
 const [directoryError,setDirectoryError]=useState(false)
 const selected=rows.find(row=>row.id===resourceId)?.definition,objects=selected?.kind==='business-configuration'?selected.definition.configuration.definitions.filter(row=>row.kind==='object-type'):[]
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[api,item.id])
 useEffect(()=>{let active=true;setCurrent(undefined);setMapping({});if(scope)void api.current({scope}).then(value=>{if(active)setCurrent(value)},()=>{if(active)setError(true)});return()=>{active=false}},[scope,api])
 const act=async(run:()=>Promise<void>)=>{if(running.current)return;running.current=true;setBusy(true);setError(false);try{await run()}catch{if(alive.current)setError(true)}finally{running.current=false;if(alive.current)setBusy(false)}}
 const refreshDirectory=async()=>{
  if(!refreshScopes)return
  try{await refreshScopes();if(alive.current)setDirectoryError(false)}catch{if(alive.current)setDirectoryError(true)}
 }
 const finish=async(value:DashboardMarketAdoption,savedDraft:BusinessConfigurationDraftResponseVersioned)=>{
  if(!alive.current)return
  if(contentId)api.journal?.write(journalId!,{resourceId,draft:savedDraft,result:value})
  setResult(value);setPending(undefined)
  await refreshDirectory()
 }
 const confirmApplied=async(value:BusinessConfigurationDraftResponseVersioned)=>{
  const adopted=await api.adoption({draftId:value.id})
  if(!adopted||adopted.scope!==value.scope||adopted.version!==value.baseVersion+1)throw Error('adoption')
  await finish(adopted,value)
 }
 const preparation=useRef<DashboardPrepareInput|undefined>(restored.current.value?.prepare)
 const prepare=()=>act(async()=>{
  const contentId=item.contentStorage?.contentId
  if(!contentId||!item.packageContent?.hash||!resourceId||scope&&!current)return
  const input=preparation.current??{requestId:crypto.randomUUID(),contentId,contentHash:item.packageContent.hash,resourceId,target:scope?{kind:'existing' as const,scope,expectedVersion:current!.version}:{kind:'new' as const,title:title.trim()},...(scope?{objectMapping:Object.fromEntries(Object.entries(mapping).filter(([,value])=>value))}:{})}
  if(contentId)api.journal?.write(journalId!,{prepare:input})
  preparation.current=input
  let value:BusinessConfigurationDraftResponseVersioned
  try{value=await api.prepare(input)}catch(error){if(rejected(error)){if(contentId)api.journal?.clear(journalId!);preparation.current=undefined}throw error}
  if(contentId)api.journal?.write(journalId!,{resourceId,draft:value})
  if(alive.current){setDraft(value);preparation.current=undefined;setPage(undefined);setPreview(undefined)}
  if(value.status==='applied')await confirmApplied(value)
 })
 const show=async(pageId:string)=>{if(!draft||draft.status!=='draft')return;const projection=await api.page({draftId:draft.id,expectedRevision:draft.revision,pageId});if(projection.configurationHash!==draft.hash)throw Error('stale');if(alive.current)setPage(projection)}
 const check=()=>act(async()=>{if(!draft||draft.status!=='draft')return;const value=await api.preview({draftId:draft.id,expectedRevision:draft.revision});if(value.candidateHash!==draft.hash||value.baseVersion!==draft.baseVersion)throw Error('stale');if(alive.current)setPreview(value);await show(draft.candidate.homePageId??draft.candidate.pages[0]!.id)})
 const save=()=>act(async()=>{if(!draft||draft.status!=='draft'||!preview)return;const input={draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:draft.baseVersion,previewReceipt:preview.receipt,requestId:crypto.randomUUID()};if(contentId)api.journal?.write(journalId!,{resourceId,draft,apply:input});setPending(input);let value:BusinessConfigurationApplyResult;try{value=await api.apply(input)}catch(error){if(rejected(error)){if(contentId)api.journal?.write(journalId!,{resourceId,draft});setPending(undefined)}throw error}if(value.scope!==draft.scope||value.version!==draft.baseVersion+1)throw Error('stale');await finish(value,draft)})
 const recover=()=>act(async()=>{if(!pending)return;const receipt=await api.receipt({requestId:pending.requestId});const value=receipt??await api.apply(pending);if(!draft||value.scope!==draft.scope||value.version!==draft.baseVersion+1)throw Error('stale');await finish(value,draft)})
 useEffect(()=>{const value=restored.current?.value;if(value?.draft?.status==='applied'&&!value.result)void act(()=>confirmApplied(value.draft!));else if(value?.result&&refreshScopes)void act(refreshDirectory)},[api])
 if(!rows.length)return null
 return <section className={css.panel+' '+own.panel} aria-label={t('market.dashboard.use')}>
  <header className={css.header}><div><h2>{t('market.dashboard.use')}</h2><p>{t('market.dashboard.boundary')}</p></div></header>
  {error&&<p role="alert" className={css.error}>{t('business.builder.error')}</p>}
  {directoryError&&<p role="alert" className={css.error}>{t('business.home.directory.failed')} <button type="button" disabled={busy} onClick={()=>void act(refreshDirectory)}>{t('common.retry')}</button></p>}
  {!item.contentStorage?.contentId&&<p role="status">{t('market.dashboard.fixFirst')}</p>}
  {!draft&&<><label>{t('market.presentation.category.dashboard')}<select aria-label={t('market.presentation.category.dashboard')} value={resourceId} disabled={busy||!!preparation.current} onChange={event=>setResourceId(event.target.value)}>{rows.map(row=><option key={row.id} value={row.id}>{row.id}</option>)}</select></label><label>{t('market.dashboard.target')}<select aria-label={t('market.dashboard.target')} value={scope} disabled={busy||!!preparation.current} onChange={event=>setScope(event.target.value)}><option value="">{t('market.dashboard.new')}</option>{spaces.filter(row=>row.scope!=='general').map(row=><option key={row.scope} value={row.scope}>{row.title}</option>)}</select></label>
   {!scope?<label>{t('business.share.name')}<input value={title} maxLength={80} disabled={busy||!!preparation.current} onChange={event=>setTitle(event.target.value)}/></label>:current===null?<p role="status">{t('market.dashboard.noConfiguration')}</p>:current&&<><p>{current.manifest.title} · v{current.version}</p>{objects.map(row=><label key={row.definition.id}>{row.definition.title}<select value={mapping[row.definition.id]??''} disabled={busy||!!preparation.current} onChange={event=>setMapping(value=>({...value,[row.definition.id]:event.target.value}))}><option value="">{t('market.dashboard.keepObject')}</option>{current.manifest.definitions.filter(row=>row.kind==='object-type').map(target=><option key={target.localId} value={target.localId}>{target.localId}</option>)}</select></label>)}</>}
   <footer className={css.footer}><button type="button" disabled={busy||!item.contentStorage?.contentId||!item.packageContent?.hash||!title.trim()||!!restored.current.error||!!scope&&!current} onClick={()=>void prepare()}>{t('market.dashboard.prepare')}</button></footer>
  </>}
  {draft?.status==='applied'&&!result&&<button type="button" disabled={busy} onClick={()=>void act(()=>confirmApplied(draft))}>{t('business.builder.check')}</button>}
  {draft?.status==='draft'&&!result&&<><nav className={css.navigation}>{draft.candidate.pages.map(value=><button type="button" key={value.id} disabled={busy||!!pending||!preview} onClick={()=>void act(()=>show(value.id))}>{value.title}</button>)}</nav><button type="button" disabled={busy||!!pending} onClick={()=>void check()}>{t('business.builder.refresh')}</button>{page&&<BusinessConfigurationPage projection={page} colorScheme={colorScheme}/>}{pending?<p role="status">{t('business.builder.unknown')}<button type="button" disabled={busy} onClick={()=>void recover()}>{t('business.builder.check')}</button></p>:<footer className={css.footer}><button type="button" disabled={busy||!preview||!page} onClick={()=>void save()}>{t('business.builder.save')}</button><button type="button" disabled={busy} onClick={()=>{if(contentId)api.journal?.clear(journalId!);setDraft(undefined);setPreview(undefined);setPage(undefined);onDiscardDraft?.()}}>{t('market.dashboard.cancel')}</button></footer>}</>}
  {result&&<footer className={css.success}><p>{t('business.builder.saved')}</p>{openSaved&&<button type="button" onClick={()=>openSaved(result.scope)}>{t('business.builder.open')}</button>}</footer>}
  {result&&draft&&selected?.kind==='business-configuration'&&upgrade?.({draft,result,resource:selected.definition})}
 </section>
}
