import {useEffect,useMemo,useRef,useState} from 'react'
import {ArrowLeft,Download,FileText} from 'lucide-react'
import type {ConversationOverviewRegisteredArtifactRef} from './conversation-overview-artifacts.js'
import {MarkdownPreview} from './knowledge-markdown.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ConversationOverviewArtifactPreview.module.css'

export type ConversationOverviewArtifactPreviewProps=Readonly<{
 reference:ConversationOverviewRegisteredArtifactRef
 onBack:()=>void
 onDownload:(reference:ConversationOverviewRegisteredArtifactRef)=>void|Promise<void>
}>

/** 注册成果的只读快照预览。主动文档只提供文本及下载，不装入活动上下文。 */
export function ConversationOverviewArtifactPreview({reference,onBack,onDownload}:ConversationOverviewArtifactPreviewProps){
 const {locale,t,dateTime}=useI18n(),[view,setView]=useState<'preview'|'source'>('preview'),[imageUrl,setImageUrl]=useState(''),[imageError,setImageError]=useState(false),[error,setError]=useState(''),[downloading,setDownloading]=useState(false)
 const generation=useRef(0),scrolls=useRef({preview:0,source:0}),content=useRef<HTMLDivElement>(null),back=useRef<HTMLButtonElement>(null)
 const imageBlob=useMemo(()=>reference.imageType?new Blob([reference.bytes],{type:reference.imageType}):null,[reference])
 useEffect(()=>{
  back.current?.focus()
  generation.current++;setView('preview');setImageError(false);setError('');setDownloading(false);scrolls.current={preview:0,source:0}
  if(!imageBlob){setImageUrl('');return}
  const url=URL.createObjectURL(imageBlob);setImageUrl(url);return()=>URL.revokeObjectURL(url)
 },[reference.row.id,imageBlob])
 useEffect(()=>{if(content.current)content.current.scrollTop=scrolls.current[view]},[view])
 const switchView=(next:'preview'|'source')=>{if(content.current)scrolls.current[view]=content.current.scrollTop;setView(next)}
 const download=()=>{
  if(downloading)return
  const current=generation.current;setDownloading(true);setError('')
  void Promise.resolve().then(()=>onDownload(reference)).catch(cause=>{if(current===generation.current)setError(localizeWorkError(locale,cause))}).finally(()=>{if(current===generation.current)setDownloading(false)})
 }
 return <section className={css.root} aria-label={reference.row.label} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onBack()}}}>
  <header className={css.header}><button ref={back} type="button" className={css.back} onClick={onBack}><ArrowLeft size={15}/>{t('overview.back')}</button>
   <h2><FileText size={18}/>{reference.row.label}</h2><p>{reference.row.kind}{reference.version!==undefined?<> · v{reference.version}</>:reference.kind==='file'?<> · {t('artifactFiles.snapshotMeta',{bytes:reference.file.bytes,at:dateTime(reference.file.capturedAt)})}</>:null}</p>
   <div className={css.actions}><nav aria-label={t('artifact.panel.text.044')}><button type="button" aria-current={view==='preview'?'page':undefined} onClick={()=>switchView('preview')}>{t('artifact.panel.text.045')}</button>{reference.text!==null&&<button type="button" aria-current={view==='source'?'page':undefined} onClick={()=>switchView('source')}>{t('overview.artifact.sourceText')}</button>}</nav><button type="button" className={css.download} disabled={downloading} onClick={download}><Download size={14}/>{t('artifactFiles.download')}</button></div>
  </header>
  {error&&<p className={css.error} role="alert">{error}</p>}
  <div ref={content} className={css.content}>
   {view==='source'?<pre className={css.source}>{reference.text}</pre>:reference.previewKind==='markdown'?<article className={css.document}><MarkdownPreview markdown={reference.text??''} images={false}/></article>:reference.previewKind==='text'?<pre className={css.source}>{reference.text}</pre>:reference.previewKind==='image'&&imageUrl?!imageError?<img className={css.image} src={imageUrl} alt={t('artifactFiles.imageAlt',{path:reference.row.label})} decoding="async" onError={()=>setImageError(true)}/>:<p className={css.notice} role="status">{t('artifactFiles.imageUnavailable')}</p>:<p className={css.notice}>{t('overview.artifact.downloadOnly')}</p>}
  </div>
 </section>
}
