import {useEffect,useRef,useState} from 'react'
import {ContextDrawer} from './ContextDrawer.js'
import {ConversationOverviewArtifactPreview} from './ConversationOverviewArtifactPreview.js'
import {conversationOverviewArtifactDownload,projectRegisteredArtifactVersions,type ConversationOverviewRegisteredArtifactRef} from './conversation-overview-artifacts.js'
import type {ArtifactReference,GroupAttachmentApi} from './group-attachment-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './GroupArtifactPreview.module.css'

/** 只读本群已共享的固定版本；不加载来源成果目录，不提供反馈或版本改写。 */
export function GroupArtifactPreview({api,reference,isCurrent,close}:{api:GroupAttachmentApi;reference:ArtifactReference;isCurrent:()=>boolean;close:()=>void}){
 const {locale,t}=useI18n(),[references,setReferences]=useState<ConversationOverviewRegisteredArtifactRef[]>([]),[selected,setSelected]=useState(0),[error,setError]=useState('')
 const current=useRef(isCurrent);current.current=isCurrent
 useEffect(()=>{
  const abort=new AbortController()
  setReferences([]);setSelected(0);setError('')
  if(!current.current())return()=>abort.abort()
  void api.readArtifactVersion(reference,abort.signal).then(artifact=>{
   if(abort.signal.aborted||!current.current())return
   if(artifact.id!==reference.id||artifact.versions.length!==1||artifact.versions[0]?.number!==reference.version||(artifact.source.kind!=='session'&&artifact.source.kind!=='task'))throw Error()
   const projected=projectRegisteredArtifactVersions(artifact.source,[artifact],t)
   setReferences([...projected.references.values()])
  }).catch(cause=>{if(!abort.signal.aborted&&current.current())setError(localizeWorkError(locale,cause))})
  return()=>abort.abort()
 },[api,reference.id,reference.version,locale,t])
 const download=(item:ConversationOverviewRegisteredArtifactRef)=>{
  if(!current.current()||!references.includes(item))return
  const result=conversationOverviewArtifactDownload(item),url=URL.createObjectURL(new Blob([result.bytes],{type:result.type})),anchor=document.createElement('a')
  try{anchor.href=url;anchor.download=result.name;anchor.click()}finally{URL.revokeObjectURL(url)}
 }
 return <ContextDrawer title={t('collaboration.reference.openArtifact')+' · v'+reference.version} close={close}>
  <div className={css.root}>
   {error?<p role="alert" className={css.notice}>{error}</p>:!references.length?<p role="status" className={css.notice}>{t('collaboration.state.loading')}</p>:<>
    {references.length>1&&<nav className={css.files} aria-label={t('artifactFiles.file')}>{references.map((item,index)=><button type="button" key={item.row.id} aria-current={index===selected?'page':undefined} onClick={()=>setSelected(index)}>{item.row.label}</button>)}</nav>}
    <div className={css.preview}><ConversationOverviewArtifactPreview reference={references[selected]!} backLabel={locale==='zh-CN'?'返回群讨论':locale.startsWith('zh')?'返回群討論':'Back to group discussion'} onBack={close} onDownload={download}/></div>
   </>}
  </div>
 </ContextDrawer>
}
