import {ActionButton} from '@teloa/client-ui-kit'
import {useRef,useState} from 'react'
import {Play,X} from 'lucide-react'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import {ContextDrawer} from './ContextDrawer.js'
import {BundledExtensionsSection} from './BundledExtensionsSection.js'
import type {BundledExtensionsApi} from './bundled-extensions-api.js'
import {WorkError,type EmbeddingProviderId,type WorkResource} from '@teloa/contract'
import type {LocalRetrievalApi,RetrievalStatus} from './local-retrieval-api.js'
import {LocalRetrievalModelPanel,type RetrievalTranslate} from './LocalRetrievalModelPanel.js'
import {useRetrievalSnapshot} from './use-retrieval-snapshot.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './LocalRetrieval.module.css'

/**
 * 资料页顶部只呈现用途、份数与每份资料的状态；首次准备按加入意图就地完成。
 * 重建收进「更多」，整理进行中的「停止整理」就近可点；索引块数只在「详细信息」里。加入与移出仍按资料来源生效。
 */
export function LocalRetrievalResourcesPresentation({status,resource,busy,error,readFailed,settingsBusy,pending,onResume,onAbandon,t,onEnroll,onRemove,onReindex,onCancel,onModelSettings}:{status?:RetrievalStatus|undefined;resource?:WorkResource|undefined;busy:boolean;error:string;readFailed?:boolean;settingsBusy?:boolean;pending?:{title:string}|undefined;onResume?:()=>void;onAbandon?:()=>void;t:RetrievalTranslate;onEnroll:(sourceId:string)=>void;onRemove:(sourceId:string)=>void;onReindex:()=>void;onCancel:()=>void;onModelSettings?:()=>void}){
 const enrolled=!!resource&&!!status?.items.some(item=>item.sourceId===resource.sourceId)
 const listed=!!resource&&!!status?.items.some(item=>item.resourceId===resource.id)
 // 选中的资料已在已加入列表里就不再单独占一行；未加入、已撤回或只有同来源其他版本在列表里时，单独给它一行。
 const selectedRow=resource&&!listed?{title:resource.title,sourceId:resource.sourceId,label:resource.status!=='active'?t('retrieval.index.unavailable'):enrolled?t('retrieval.resources.enrolled'):t('retrieval.index.excluded')}:undefined
 const itemLabel=(state:RetrievalStatus['items'][number]['state'])=>state==='unavailable'?t('retrieval.index.unavailable'):t('retrieval.resources.enrolled')+' · '+t('retrieval.index.'+state)
 const readOnly=busy||!status||!!readFailed
 // 加入与移出按来源生效：同一来源有多份资料时写明会一起移出。
 const sourceCount=(sourceId:string)=>status?.items.filter(row=>row.sourceId===sourceId&&row.resourceId!==null).length??0
 const together=(sourceId:string)=>sourceCount(sourceId)>1&&<small className={css.together}>{t('retrieval.resources.sourceImpact',{count:sourceCount(sourceId)})}</small>
 return <section className={`${css.panel} ${css.compact} ${css.search}`} aria-label={t('retrieval.resources.title')} data-retrieval-resources>
  <header className={css.searchHeader}>
   <div className={css.searchIntro}><strong>{t('retrieval.resources.title')}</strong><p>{t('retrieval.resources.summary')}</p></div>
   <div className={css.searchTools}>
    {status?<span role="status" className={css.count}>{t('retrieval.resources.counts',{sources:status.enrolled})}</span>:<span className={css.count}>{t('retrieval.phase.checking')}</span>}
    {status?.building&&<ActionButton className={css.button} disabled={busy} onClick={onCancel}>{t(busy?'retrieval.resources.working':'retrieval.resources.cancel')}</ActionButton>}
    {status&&!status.building&&<details className={css.more} data-retrieval-more><summary>{t('retrieval.resources.more')}</summary><div className={css.moreMenu}>{onModelSettings&&<ActionButton className={css.menuItem} disabled={(settingsBusy??busy)||!!readFailed} onClick={(event?:{currentTarget:HTMLElement})=>{const menu=event?.currentTarget.closest('details');menu?.querySelector('summary')?.focus();menu?.removeAttribute('open');onModelSettings()}}>{t('retrieval.resources.settings')}</ActionButton>}<ActionButton className={css.menuItem} disabled={busy||status.enrolled===0||!!readFailed} onClick={(event?:{currentTarget:HTMLElement})=>{event?.currentTarget.closest('details')?.removeAttribute('open');onReindex()}}>{t(busy?'retrieval.resources.working':'retrieval.resources.rebuild')}</ActionButton></div></details>}
   </div>
  </header>
  {error&&<p role="alert" className={css.error}>{error}</p>}
  {pending&&<div className={css.row} role="status"><span className={css.rowText}>{t('retrieval.resources.pending',{title:pending.title})}</span>{onResume&&<ToolbarIconButton label={t('retrieval.resources.resume')} icon={Play} disabled={busy} onClick={onResume}/>}{onAbandon&&<ToolbarIconButton label={t('retrieval.resources.abandon')} icon={X} disabled={busy} onClick={onAbandon}/>}</div>}
  {(selectedRow||!!status?.items.length)&&<ul className={css.rows}>
   {selectedRow&&<li className={css.row} aria-current="true"><span className={css.rowText}>{selectedRow.title+' · '+selectedRow.label}{enrolled&&together(selectedRow.sourceId)}</span>{enrolled
    ?<ActionButton className={css.button} aria-label={t('retrieval.resources.removeAria',{title:selectedRow.title})} disabled={readOnly} onClick={()=>onRemove(selectedRow.sourceId)}>{t('retrieval.resources.remove')}</ActionButton>
    :<ActionButton className={css.button} aria-label={t('retrieval.resources.enrollAria',{title:selectedRow.title})} disabled={readOnly||!!pending||resource?.status!=='active'} onClick={()=>onEnroll(selectedRow.sourceId)}>{t('retrieval.resources.enroll')}</ActionButton>}</li>}
   {status?.items.map(row=>{const title=row.title??t('retrieval.index.unavailable');return <li key={row.resourceId??row.sourceId} className={css.row} aria-current={resource&&row.resourceId===resource.id?'true':undefined}><span className={css.rowText}>{title+' · '+itemLabel(row.state)}{together(row.sourceId)}</span><ActionButton className={css.button} aria-label={t('retrieval.resources.removeAria',{title})} disabled={busy||!!readFailed} onClick={()=>onRemove(row.sourceId)}>{t('retrieval.resources.remove')}</ActionButton></li>})}
  </ul>}
  {status&&status.items.length>0&&<details className={css.info}><summary>{t('retrieval.resources.details')}</summary><ul>{status.items.map(row=><li key={row.resourceId??row.sourceId}>{row.title??t('retrieval.index.unavailable')} · {t('retrieval.index.'+row.state)}{row.chunkCount!==null&&` · ${t('retrieval.resources.chunks',{count:row.chunkCount})}`}</li>)}</ul><p>{t('retrieval.resources.totalChunks',{chunks:status.chunks})}</p></details>}
 </section>
}
export function LocalRetrievalResources({api,resource,visible,activationApi}:{api:LocalRetrievalApi;resource?:WorkResource|undefined;visible:boolean;activationApi?:BundledExtensionsApi|undefined}){
 const {locale,t}=useI18n(),snapshot=useRetrievalSnapshot(signal=>api.status(signal),api,visible)
 const [setup,setSetup]=useState<{catalogId:string;catalogVersion:string;profileHash:string}>(),[settingsOpen,setSettingsOpen]=useState<boolean>()
 const [pending,setPending]=useState<{sourceId:string;title:string}>(),[joining,setJoining]=useState(false),joiningRef=useRef(false)
 const readSettings=(providerId?:EmbeddingProviderId)=>{
  void snapshot.run(async signal=>{
   const model=await api.modelStatus(signal,providerId);signal.throwIfAborted()
   if(!model.enabled||!model.provider)setSetup(undefined)
   else{const provider=model.provider;setSetup({catalogId:provider.catalogId,catalogVersion:provider.catalogVersion,profileHash:provider.profileHash})}
   return api.status(signal)
  })
 }
 const openSettings=(providerId?:EmbeddingProviderId)=>{setSettingsOpen(true);readSettings(providerId)}
 const abandon=()=>{if(!joiningRef.current)setPending(undefined)}
 const enroll=(sourceId:string)=>void snapshot.run(async signal=>{
  if(pending||joiningRef.current)return api.status(signal)
  const model=await api.modelStatus(signal)
  signal.throwIfAborted()
  if(model.enabled&&model.provider&&['ready','standby'].includes(model.provider.preparation.phase))return api.enroll(sourceId,signal)
  setPending({sourceId,title:resource?.sourceId===sourceId?resource.title:snapshot.value?.items.find(row=>row.sourceId===sourceId)?.title??t('retrieval.resources.title')})
  const provider=model.provider
  setSetup(model.enabled&&provider?{catalogId:provider.catalogId,catalogVersion:provider.catalogVersion,profileHash:provider.profileHash}:undefined)
  setSettingsOpen(true);return api.status(signal)
 })
 // 原资料意图与模型状态分开；关闭抽屉不卸载在途准备，明确取消才放弃续办。
 return <><LocalRetrievalResourcesPresentation status={snapshot.value} resource={resource} busy={snapshot.busy||joining} pending={pending} settingsBusy={snapshot.busy||joining} onResume={()=>openSettings()} onAbandon={abandon} readFailed={snapshot.readFailed} error={snapshot.error?localizeWorkError(locale,snapshot.error):''} t={t as RetrievalTranslate} onModelSettings={()=>openSettings()} onEnroll={enroll} onRemove={id=>void snapshot.run(signal=>api.remove(id,signal))} onReindex={()=>void snapshot.run(signal=>api.reindex(signal))} onCancel={()=>void snapshot.run(signal=>api.cancel(signal))}/>
 {settingsOpen!==undefined&&<ContextDrawer className={css.settingsDrawer??''} open={!!settingsOpen&&visible} title={t('retrieval.model.title')} close={()=>setSettingsOpen(false)}>
  {activationApi?<BundledExtensionsSection api={activationApi} embedded onChanged={()=>readSettings()}/>:<p role="status">{t('retrieval.resources.activationUnavailable')}</p>}
  {!!snapshot.error&&<p role="alert" className={css.error}>{localizeWorkError(locale,snapshot.error)}</p>}
  {setup&&<LocalRetrievalModelPanel key={setup.catalogId} api={api} catalogId={setup.catalogId} catalogVersion={setup.catalogVersion} compact embedded onProviderChange={!pending?openSettings:undefined} providerChangeBusy={snapshot.busy||joining} onBack={()=>{abandon();setSetup(undefined);setSettingsOpen(false)}} onExtensions={()=>readSettings()} onReady={pending?async signal=>{
   if(joiningRef.current)return
   joiningRef.current=true;setJoining(true)
   try{
    const current=await api.modelStatus(signal)
    if(current.provider?.catalogId!==setup.catalogId||current.provider.catalogVersion!==setup.catalogVersion||current.provider.profileHash!==setup.profileHash)throw new WorkError('teloa/conflict','')
    signal.throwIfAborted();await api.enroll(pending.sourceId,signal);signal.throwIfAborted();setPending(undefined);setSetup(undefined);setSettingsOpen(false)
   }finally{joiningRef.current=false;setJoining(false)}
  }:undefined}/>}</ContextDrawer>}</>
}
