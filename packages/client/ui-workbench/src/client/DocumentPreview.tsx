import {useEffect,useRef,useState,type ReactNode} from 'react'
import {ArrowLeft,Download,FileText,Save} from 'lucide-react'
import {MarkdownPreview} from './knowledge-markdown.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ConversationOverviewArtifactPreview.module.css'

export type DocumentPreviewProps=Readonly<{identity:string;label:string;metadata:ReactNode;text:string|null;previewKind:'markdown'|'text'|'image'|'download-only';imageBlob?:Blob|null;backLabel?:string|undefined;onBack:()=>void;onDownload:()=>void|Promise<void>;onSave?:(()=>Promise<void>)|undefined}>
/** 共用只读呈现；来源、固定版本和下载权限由调用方持有，不能从展示内容推断。 */
export function DocumentPreview({identity,label,metadata,text,previewKind,imageBlob,backLabel,onBack,onDownload,onSave}:DocumentPreviewProps){
 const {locale,t}=useI18n(),[view,setView]=useState<'preview'|'source'>('preview'),[imageUrl,setImageUrl]=useState(''),[imageError,setImageError]=useState(false),[error,setError]=useState(''),[downloading,setDownloading]=useState(false)
 const generation=useRef(0),scrolls=useRef({preview:0,source:0}),content=useRef<HTMLDivElement>(null),back=useRef<HTMLButtonElement>(null)
 const [saving,setSaving]=useState(false),[saved,setSaved]=useState(false),savingRef=useRef(false)
 useEffect(()=>{
  back.current?.focus();generation.current++;setView('preview');setImageError(false);setError('');setDownloading(false);setSaving(false);setSaved(false);savingRef.current=false;scrolls.current={preview:0,source:0}
  if(!imageBlob){setImageUrl('');return()=>{generation.current++}}
  const url=URL.createObjectURL(imageBlob);setImageUrl(url);return()=>{generation.current++;URL.revokeObjectURL(url)}
 },[identity,imageBlob])
 useEffect(()=>{if(content.current)content.current.scrollTop=scrolls.current[view]},[view])
 const switchView=(next:'preview'|'source')=>{if(content.current)scrolls.current[view]=content.current.scrollTop;setView(next)}
 const download=()=>{if(downloading)return;const current=generation.current;setDownloading(true);setError('');void Promise.resolve().then(onDownload).catch(cause=>{if(current===generation.current)setError(localizeWorkError(locale,cause))}).finally(()=>{if(current===generation.current)setDownloading(false)})}
 const save=async()=>{if(!onSave||savingRef.current||saved)return;const current=generation.current;savingRef.current=true;setSaving(true);setError('');try{await onSave();if(current===generation.current)setSaved(true)}catch(cause){if(current===generation.current)setError(localizeWorkError(locale,cause))}finally{if(current===generation.current){savingRef.current=false;setSaving(false)}}}
 return <section className={css.root} aria-label={label} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onBack()}}}>
  <header className={css.header}><button ref={back} type="button" className={css.back} onClick={onBack}><ArrowLeft size={15}/>{backLabel??t('overview.back')}</button>
   <h2><FileText size={18}/>{label}</h2><p>{metadata}</p>
   <div className={css.actions}><nav aria-label={t('artifact.panel.text.044')}><button type="button" aria-current={view==='preview'?'page':undefined} onClick={()=>switchView('preview')}>{t('artifact.panel.text.045')}</button>{text!==null&&<button type="button" aria-current={view==='source'?'page':undefined} onClick={()=>switchView('source')}>{t('overview.artifact.sourceText')}</button>}</nav><div>{onSave&&<button type="button" className={css.download} aria-label={t('artifact.panel.text.041')} title={t('artifact.panel.text.041')} disabled={saving||saved} onClick={()=>void save()}><Save size={14}/></button>}<button type="button" className={css.download} disabled={downloading} onClick={download}><Download size={14}/>{t('artifactFiles.download')}</button></div></div>
  </header>
  {error&&<p className={css.error} role="alert">{error}</p>}
  {saved&&<p className={css.notice} role="status">{t('artifact.panel.text.003')}</p>}
  <div ref={content} className={css.content}>
   {view==='source'?<pre className={css.source}>{text}</pre>:previewKind==='markdown'?<article className={css.document}><MarkdownPreview markdown={text??''} images={false}/></article>:previewKind==='text'?<pre className={css.source}>{text}</pre>:previewKind==='image'&&imageUrl?!imageError?<img className={css.image} src={imageUrl} alt={t('artifactFiles.imageAlt',{path:label})} decoding="async" onError={()=>setImageError(true)}/>:<p className={css.notice} role="status">{t('artifactFiles.imageUnavailable')}</p>:<p className={css.notice}>{t('overview.artifact.downloadOnly')}</p>}
  </div>
 </section>
}
