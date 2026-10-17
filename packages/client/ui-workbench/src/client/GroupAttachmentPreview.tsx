import {useEffect,useRef,useState} from 'react'
import type {GroupAttachment} from '@teloa/contract'
import type {GroupAttachmentApi} from './group-attachment-api.js'
import {ContextDrawer} from './ContextDrawer.js'
import {DocumentPreview} from './DocumentPreview.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './GroupArtifactPreview.module.css'

type Snapshot={blob:Blob;text:string|null;kind:'markdown'|'text'|'image'|'download-only'}
/** 只从当前群附件列表发起；主动文件不嵌入执行，固定字节只读预览或下载。 */
export function GroupAttachmentPreview({file,api,isCurrent,close}:{file:GroupAttachment;api:GroupAttachmentApi;isCurrent:()=>boolean;close:()=>void}){
 const {locale,t}=useI18n(),[snapshot,setSnapshot]=useState<Snapshot>(),[error,setError]=useState(''),current=useRef(isCurrent);current.current=isCurrent
 useEffect(()=>{
  let active=true;setSnapshot(undefined);setError('')
  if(!current.current()||file.state!=='active')return
  void (async()=>{
   const opened=await api.openReference({kind:'attachment',id:file.attachmentId,version:file.version})
   if('kind' in opened)throw Object.assign(Error(),{code:'teloa/source-unavailable'})
   try{
    if(!active||!current.current())return
    const response=await fetch(opened.blobUrl),blob=await response.blob()
    if(!active||!current.current())return
    const image=['image/png','image/jpeg','image/webp'].includes(opened.mime),text=/^(text\/(plain|markdown)|application\/json)$/.test(opened.mime),value=text?new TextDecoder('utf-8',{fatal:true}).decode(await blob.arrayBuffer()):null
    if(active&&current.current())setSnapshot({blob,text:value,kind:image?'image':text?(opened.mime==='text/markdown'?'markdown':'text'):'download-only'})
   }finally{opened.revoke()}
  })().catch(cause=>{if(active&&current.current())setError(localizeWorkError(locale,cause))})
  return()=>{active=false}
 },[api,file.attachmentId,file.version,locale])
 const download=()=>{if(!snapshot||!current.current())throw Object.assign(Error(),{code:'teloa/source-unavailable'});const url=URL.createObjectURL(snapshot.blob),anchor=document.createElement('a');anchor.href=url;anchor.download=file.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),0)}
 return <ContextDrawer title={t('collaboration.view.materials')} close={close}><div className={css.root}>{error?<p role="alert">{error}</p>:snapshot&&current.current()?<DocumentPreview identity={file.attachmentId+':'+file.version} label={file.name} metadata={t('collaboration.attachment.section')} text={snapshot.text} previewKind={snapshot.kind} imageBlob={snapshot.kind==='image'?snapshot.blob:null} backLabel={t('group.materials.back')} onBack={close} onDownload={download}/>:<p role="status">{t('collaboration.state.loading')}</p>}</div></ContextDrawer>
}
