import {useEffect,useRef,useState,type ReactNode} from 'react'
import {Copy,Download,Info,MoreHorizontal,Pencil,RotateCcw,Trash2,X} from 'lucide-react'
import type {ResourceUsageTarget,SourceReference,WorkResource} from '@teloa/contract'
import type {ResourceApi} from './resource-api.js'
import {ResourceUsage} from './ResourceUsage.js'
import {LibraryReaderHeader} from './LibraryReaderHeader.js'
import {MarkdownPreview} from './knowledge-markdown.js'
import {knowledgeCopyText} from './knowledge-copy-text.js'
import {libraryReaderText} from './library-reader-copy.js'
import {libraryTextFormat,downloadLibraryText} from './library-text-file.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './KnowledgeDocument.module.css'

/** 内容和引用资格只消费原控制器核验结果；本组件不重绑来源或写原件。 */
export function LibraryLocalDocument({navigation,api,resource,source,text,loading,error,missing,changed,ready,onRetry,onEdit,onRecoverCopy,onCopy,onUse,onWithdraw,openUsage}:{navigation?:ReactNode;api:ResourceApi;resource:WorkResource;source:SourceReference|undefined;text:string|undefined;loading:boolean;error:unknown;missing:boolean;changed:boolean;ready:boolean;onRetry?:(()=>void)|undefined;onEdit?:(()=>void)|undefined;onRecoverCopy?:(()=>void)|undefined;onCopy:()=>void;onUse?:(()=>void)|undefined;onWithdraw:()=>void;openUsage?:((target:ResourceUsageTarget)=>void)|undefined}){
 const {locale,t}=useI18n(),copy=libraryReaderText(locale),format=libraryTextFormat(source?.source),[info,setInfo]=useState(false),[raw,setRaw]=useState(false),[usage,setUsage]=useState(false),infoButton=useRef<HTMLButtonElement>(null)
 const status=resource.status!=='active'?t('knowledge.ui.034'):missing?t('library.sourceUnavailable'):changed?t('library.sourceVersionChanged'):loading?t('library.sourceReading'):error||text===undefined?t('library.sourceReadFailed'):t('knowledge.ui.033')
 const failure=resource.status!=='active'?t('knowledge.local.withdrawn'):missing?t('library.sourceUnavailable'):changed?t('knowledge.local.changed'):error?localizeWorkError(locale,error):undefined
 const closeInfo=()=>{setInfo(false);infoButton.current?.focus()}
 useEffect(()=>{if(!info)return;const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();closeInfo()}};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key)},[info])
 return <section className={css.document} data-library-reader aria-label={t('knowledge.ui.013')}>
  <LibraryReaderHeader navigation={navigation} title={resource.title}>
   <button type="button" disabled={!ready||text===undefined} onClick={()=>{if(ready&&text!==undefined)downloadLibraryText(text,source?.source??resource.title)}}><Download size={16}/>{copy.download}</button>
   <button type="button" title={!onEdit?copy.editUnavailable:undefined} disabled={!ready||!onEdit} onClick={()=>{if(ready)onEdit?.()}}><Pencil size={16}/>{copy.edit}</button>
   <button ref={infoButton} type="button" aria-label={copy.info} aria-expanded={info} onClick={()=>setInfo(value=>!value)}><Info size={17}/></button>
   {onRecoverCopy&&!ready&&<button type="button" onClick={onRecoverCopy}>{knowledgeCopyText(locale).recover}</button>}<details className={css.more}><summary aria-label={t('knowledge.ui.017')}><MoreHorizontal size={18}/></summary><div><button type="button" disabled={!ready} onClick={()=>{if(ready)onCopy()}}><Copy size={15}/>{t('knowledge.ui.016')}</button>{onUse&&<button type="button" disabled={!ready} onClick={()=>{if(ready)onUse()}}>{t('library.use')}</button>}<button type="button" disabled={!ready} onClick={()=>setRaw(value=>!value)}>{raw?copy.read:copy.source}</button><button type="button" disabled={resource.status!=='active'} onClick={onWithdraw}><Trash2 size={15}/>{t('knowledge.ui.022')}</button></div></details>
  </LibraryReaderHeader>
  <div className={info?`${css.body} ${css.bodyWithInspector}`:css.body}><main className={css.canvas} aria-label={copy.files}>
   {failure?<div className={css.inlineFailure}><p role="alert">{failure}</p>{onRetry&&<button type="button" onClick={onRetry}><RotateCcw size={15}/>{t('knowledge.local.retry')}</button>}</div>:loading?<p role="status">{t('knowledge.ui.051')}</p>:text!==undefined?<article className={css.readerContent}>{!raw&&format==='markdown'?<MarkdownPreview markdown={text} images={false}/>:<pre className={css.sourceText}><code>{text}</code></pre>}</article>:<p role="status">{t('knowledge.ui.024')}</p>}
  </main>{info&&<aside className={css.history} aria-label={t('knowledge.ui.025')}><header><strong>{copy.info}</strong><button type="button" aria-label={copy.closeInfo} onClick={closeInfo}><X size={16}/></button></header><dl className={css.pageFacts}><div><dt>{copy.type}</dt><dd>{copy[format]}</dd></div>{text!==undefined&&ready&&<div><dt>{copy.size}</dt><dd>{new TextEncoder().encode(text).length.toLocaleString(locale)} B</dd></div>}<div><dt>{copy.location}</dt><dd>{source?.source??'—'}</dd></div><div><dt>{copy.saved}</dt><dd>{new Intl.DateTimeFormat(locale,{dateStyle:'short',timeStyle:'short'}).format(new Date(resource.updatedAt))}</dd></div></dl><details><summary>{copy.details}</summary><dl className={css.pageFacts}><div><dt>{t('knowledge.ui.032')}</dt><dd>{status}</dd></div><div><dt>{t('knowledge.ui.015')}</dt><dd>{resource.sourceVersion}</dd></div></dl></details><details><summary>{t('knowledge.ui.035')}</summary><p>{t('knowledge.local.versionBoundary')}</p></details><details onToggle={event=>setUsage(event.currentTarget.open)}><summary>{locale.startsWith('en')?'Cited in':locale==='zh-CN'?'使用记录':'使用記錄'}</summary>{usage&&<ResourceUsage resource={resource} api={api} open={openUsage}/>}</details></aside>}</div>
 </section>
}
