import {useEffect,useRef,useState} from 'react'
import type {EmbeddingProviderId} from '@teloa/contract'
import type {LocalRetrievalApi,RetrievalModelStatus} from './local-retrieval-api.js'
import type {BundledExtensionsApi} from './bundled-extensions-api.js'
import {BundledExtensionsSection} from './BundledExtensionsSection.js'
import {LocalRetrievalModelPanel} from './LocalRetrievalModelPanel.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './LocalModelsSettings.module.css'

export type LocalRetrievalSettingsProps={api:LocalRetrievalApi;activation?:BundledExtensionsApi|undefined;visible?:boolean;focus?:number|undefined;requestedProvider?:EmbeddingProviderId|undefined}
/** 内置检索模型与 Ollama 同归本地模型设置；进入、切模型与刷新均只读，不承接自动加入资料。 */
export function LocalRetrievalSettings({api,activation,visible=true,focus,requestedProvider}:LocalRetrievalSettingsProps){
 const {t,locale}=useI18n(),root=useRef<HTMLElement>(null),[provider,setProvider]=useState<EmbeddingProviderId|undefined>(requestedProvider),[retry,setRetry]=useState(0)
 const [read,setRead]=useState<{api:LocalRetrievalApi;provider:EmbeddingProviderId|undefined;status?:RetrievalModelStatus;error?:string}>()
 useEffect(()=>{if(focus!==undefined)setProvider(requestedProvider)},[focus,requestedProvider])
 useEffect(()=>{
  const controller=new AbortController();setRead(undefined)
  if(visible)void api.modelStatus(controller.signal,provider).then(status=>{if(!controller.signal.aborted)setRead({api,provider,status})},cause=>{if(!controller.signal.aborted)setRead({api,provider,error:localizeWorkError(locale,cause)})})
  return()=>controller.abort()
 },[api,provider,retry,visible,locale])
 useEffect(()=>{if(visible&&focus!==undefined){root.current?.focus();root.current?.scrollIntoView?.({block:'start'})}},[visible,focus])
 const current=read?.api===api&&read.provider===provider?read:undefined,status=current?.status,p=status?.enabled?status.provider:undefined
 const refresh=()=>setRetry(value=>value+1)
 return <section className={`${css.page} ${css.retrievalSettings}`} ref={root} tabIndex={-1} data-entry-id="teloa.local-retrieval" aria-label={t('retrieval.resources.model')}>
  <header className={css.header}><h2>{t('retrieval.resources.model')}</h2><button type="button" onClick={refresh}>{t('collaboration.action.refresh')}</button></header>
  {activation?<BundledExtensionsSection api={activation} embedded onChanged={refresh}/>:<p role="status">{t('retrieval.resources.activationUnavailable')}</p>}
  {current?.error&&<p role="alert">{current.error} <button type="button" onClick={refresh}>{t('common.retry')}</button></p>}
  {!current&&visible&&<p role="status">{t('retrieval.phase.checking')}</p>}
  {visible&&p&&<LocalRetrievalModelPanel key={p.catalogId+'@'+p.catalogVersion+'@'+p.profileHash} api={api} catalogId={p.catalogId} catalogVersion={p.catalogVersion} compact embedded autoConfirm={false} onBack={refresh} onExtensions={refresh} onProviderChange={setProvider}/>}
 </section>
}
