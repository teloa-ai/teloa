import {useEffect,useRef,useState} from 'react'
import {Download,RefreshCw} from 'lucide-react'
import type {BusinessShareApi,CompleteBusinessExportPreview} from './business-share-flow.ts'
import type {CompleteBusinessSnapshot} from './complete-business-source.ts'
import {isIndustryManifest} from './industry-manifest.ts'
import {useBusinessShareMetadata} from './use-business-share-metadata.ts'
import {useI18n} from './i18n/provider.tsx'
import {localizeWorkError} from './i18n/errors.ts'
import base from './TaskPage.module.css'
import css from './BusinessShareForm.module.css'

type Draft={packageId:string;packageVersion:string;title:string;description:string}
type Props={scope:string;api:NonNullable<BusinessShareApi['complete']>;draftKey?:string|undefined}
/** ZIP 来源、预览与下载绑定同一固定内容；更换业务时迟到回包不能覆盖当前预览。 */
export function CompleteBusinessExportForm({scope,api,draftKey}:Props){
 const {t,locale}=useI18n(),identity=useRef({scope,api});identity.current={scope,api}
 const [source,setSource]=useState<CompleteBusinessSnapshot>(),[preview,setPreview]=useState<CompleteBusinessExportPreview>(),[busy,setBusy]=useState<'read'|'plan'|'download'>(),[error,setError]=useState(''),[notice,setNotice]=useState(''),[revision,setRevision]=useState(0)
 const [loadedApi,setLoadedApi]=useState<Props['api']>()
 const {metadata:draft,update}=useBusinessShareMetadata(api,scope,draftKey?draftKey+'/complete':undefined,():Draft=>({packageId:scope.toLowerCase().replace(/_/g,'-')+'-business',packageVersion:'1.0.0',title:t('business.share.defaultName',{scope}),description:t('business.complete.description')}))
 const epoch=useRef(0),acting=useRef(false)
 const isCurrent=(value:number)=>epoch.current===value&&identity.current.api===api&&identity.current.scope===scope
 const currentSource=loadedApi===api&&source?.scope===scope?source:undefined,currentPreview=loadedApi===api&&preview&&isIndustryManifest(preview.item.manifest)&&preview.item.manifest.scope===scope?preview:undefined
 useEffect(()=>{const current=++epoch.current;setLoadedApi(undefined);setSource(undefined);setPreview(undefined);setError('');setNotice('');setBusy('read');acting.current=false;void api.source.read(scope).then(value=>{if(isCurrent(current)){if(value.scope!==scope)throw Object.assign(Error(),{code:'teloa/invalid-host-response'});setSource(value);setLoadedApi(api)}},cause=>{if(isCurrent(current))setError(localizeWorkError(locale,cause))}).catch(cause=>{if(isCurrent(current))setError(localizeWorkError(locale,cause))}).finally(()=>{if(isCurrent(current))setBusy(undefined)});return()=>{epoch.current++}},[api,scope,revision])
 const change=<K extends keyof Draft>(key:K,value:Draft[K])=>{update(key,value);setPreview(undefined);setNotice('')}
 const generate=async()=>{
  if(!currentSource||busy||acting.current||!draft.packageId.trim()||!draft.packageVersion.trim()||!draft.title.trim()||!draft.description.trim())return
  const current=epoch.current;acting.current=true;setBusy('plan');setPreview(undefined);setError('');setNotice('')
  try{const snapshot=await api.source.read(scope);if(!isCurrent(current))return;if(snapshot.scope!==scope)throw Object.assign(Error(),{code:'teloa/invalid-host-response'});const value=await api.plan({...snapshot,...draft});if(isCurrent(current)){if(!isIndustryManifest(value.item.manifest)||value.item.manifest.scope!==scope)throw Object.assign(Error(),{code:'teloa/invalid-host-response'});setSource(snapshot);setPreview(value)}}catch(cause){if(isCurrent(current))setError(localizeWorkError(locale,cause))}finally{if(isCurrent(current)){acting.current=false;setBusy(undefined)}}
 }
 const download=async()=>{
  if(!currentPreview||busy||acting.current)return
  const current=epoch.current;acting.current=true;setBusy('download');setError('');setNotice('')
  try{
   const archive=await api.download(currentPreview.item,currentPreview.inspection.digest,draft.description)
   if(!isCurrent(current))return
   const url=URL.createObjectURL(new Blob([Uint8Array.from(archive.bytes)],{type:'application/zip'})),anchor=document.createElement('a')
   anchor.href=url;anchor.download=archive.name;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),10000)
   setNotice(t('business.share.downloaded'))
  }catch(cause){if(isCurrent(current))setError(localizeWorkError(locale,cause))}finally{if(isCurrent(current)){acting.current=false;setBusy(undefined)}}
 }
 return <section className={css.panel} aria-label={t('business.complete.title')}>
  <header><div><h2>{t('business.complete.title')}</h2><p>{t('business.complete.description')}</p></div><button type="button" disabled={!!busy} onClick={()=>setRevision(value=>value+1)}><RefreshCw size={15}/>{t('taskExecution.refresh')}</button></header>
  <p>{t('business.complete.boundary')}</p>
  {error&&<p className={base.error} role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {busy==='read'?<p role="status">{t('business.share.loading')}</p>:!currentSource?<button type="button" onClick={()=>setRevision(value=>value+1)}>{t('common.retry')}</button>:<>
   <fieldset disabled={!!busy} className={css.form}>
    <label>{t('business.share.packageId')}<input value={draft.packageId} onChange={event=>change('packageId',event.target.value)}/></label>
    <label>{t('business.share.version')}<input value={draft.packageVersion} onChange={event=>change('packageVersion',event.target.value)}/></label>
    <label>{t('business.share.name')}<input value={draft.title} onChange={event=>change('title',event.target.value)}/></label>
    <label>{t('business.share.summary')}<textarea rows={3} value={draft.description} onChange={event=>change('description',event.target.value)}/></label>
   </fieldset>
   {currentPreview&&<div role="status"><p>{t('business.complete.files',{count:currentPreview.fileCount})}</p><ul>{Object.entries(currentPreview.counts).filter(([,count])=>count>0).map(([kind,count])=><li key={kind}>{t(('market.industry.resource.'+kind) as Parameters<typeof t>[0])}: {count}</li>)}</ul></div>}
   <footer><button type="button" disabled={!!busy||!draft.packageId.trim()||!draft.title.trim()||!draft.packageVersion.trim()||!draft.description.trim()} onClick={()=>void generate()}>{busy==='plan'?t('business.share.generating'):t('business.share.generate')}</button>{currentPreview&&<button type="button" disabled={!!busy} onClick={()=>void download()}><Download size={15}/>{busy==='download'?t('business.share.generating'):t('business.complete.download')}</button>}</footer>
  </>}
 </section>
}
