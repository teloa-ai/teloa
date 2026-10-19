import {useEffect,useLayoutEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {ArrowLeft,Download,Maximize2,Minimize2,X} from 'lucide-react'
import {ArtifactPanelHeader} from './ArtifactPanelHeader.js'
import {GroupWorkResults,type GroupWorkResultsProps} from './GroupWorkResults.js'
import {MarkdownPreview} from './knowledge-markdown.js'
import type {Artifact} from './artifact-preview.js'
import panelCss from './ArtifactPanel.module.css'
import baseCss from './TaskPage.module.css'
import {ContextDrawer} from './ContextDrawer.js'
import {ConversationOverviewArtifactPreview} from './ConversationOverviewArtifactPreview.js'
import {conversationOverviewArtifactDownload,projectRegisteredArtifactVersions,type ConversationOverviewRegisteredArtifactRef} from './conversation-overview-artifacts.js'
import type {ArtifactReference,GroupAttachmentApi} from './group-attachment-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './GroupArtifactPreview.module.css'

/** 只读本群已共享的固定版本；不加载来源成果目录，不提供反馈或版本改写。 */
type RailProps=Partial<Pick<GroupWorkResultsProps,'groupId'|'rows'|'summaries'|'roleNames'|'openArtifact'|'openMessage'>> & {inline?:boolean|undefined;portal?:HTMLElement|null|undefined}
export function GroupArtifactPreview({api,reference,isCurrent,close,...rail}:RailProps&{api:GroupAttachmentApi;reference:ArtifactReference;isCurrent:()=>boolean;close:()=>void}){
 const {locale,t}=useI18n(),[references,setReferences]=useState<ConversationOverviewRegisteredArtifactRef[]>([]),[selected,setSelected]=useState(0),[error,setError]=useState(''),[artifact,setArtifact]=useState<Artifact>()
 const current=useRef(isCurrent);current.current=isCurrent
 useEffect(()=>{
  const abort=new AbortController()
  setReferences([]);setSelected(0);setError('');setArtifact(undefined)
  if(!current.current())return()=>abort.abort()
  void api.readArtifactVersion(reference,abort.signal).then(artifact=>{
   if(abort.signal.aborted||!current.current())return
   if(artifact.id!==reference.id||artifact.versions.length!==1||artifact.versions[0]?.number!==reference.version||(artifact.source.kind!=='session'&&artifact.source.kind!=='task'))throw Error()
   const projected=projectRegisteredArtifactVersions(artifact.source,[artifact],t)
   setReferences([...projected.references.values()]);setArtifact(artifact)
  }).catch(cause=>{if(!abort.signal.aborted&&current.current())setError(localizeWorkError(locale,cause))})
  return()=>abort.abort()
 },[api,reference.id,reference.version,locale,t])
 const download=(item:ConversationOverviewRegisteredArtifactRef)=>{
  if(!current.current()||!references.includes(item))return
  const result=conversationOverviewArtifactDownload(item),url=URL.createObjectURL(new Blob([result.bytes],{type:result.type})),anchor=document.createElement('a')
  try{anchor.href=url;anchor.download=result.name;anchor.click()}finally{URL.revokeObjectURL(url)}
 }
 if(rail.inline)return <GroupResultRail {...rail} reference={reference} artifact={artifact} references={references} selected={selected} select={setSelected} error={error} isCurrent={isCurrent} close={close} download={download}/>
 return <ContextDrawer title={t('collaboration.reference.openArtifact')+' · v'+reference.version} close={close}>
  <div className={css.root}>
   {error?<p role="alert" className={css.notice}>{error}</p>:!references.length?<p role="status" className={css.notice}>{t('collaboration.state.loading')}</p>:<>
    {references.length>1&&<nav className={css.files} aria-label={t('artifactFiles.file')}>{references.map((item,index)=><button type="button" key={item.row.id} aria-current={index===selected?'page':undefined} onClick={()=>setSelected(index)}>{item.row.label}</button>)}</nav>}
    <div className={css.preview}><ConversationOverviewArtifactPreview reference={references[selected]!} backLabel={locale==='zh-CN'?'返回群讨论':locale.startsWith('zh')?'返回群討論':'Back to group discussion'} onBack={close} onDownload={download}/></div>
   </>}
  </div>
 </ContextDrawer>
}

/** 复用 C 的并栏和标题；所有内容仍来自群已共享固定版本的只读口。 */
function GroupResultRail({portal,groupId='',rows=[],summaries={},roleNames={},openArtifact,openMessage,reference,artifact,references,selected,select,error,isCurrent,close,download}:RailProps&{reference:ArtifactReference;artifact:Artifact|undefined;references:ConversationOverviewRegisteredArtifactRef[];selected:number;select:(index:number)=>void;error:string;isCurrent:()=>boolean;close:()=>void;download:(item:ConversationOverviewRegisteredArtifactRef)=>void}){
 const {t,dateTime}=useI18n(),dialog=useRef<HTMLDialogElement>(null),[expanded,setExpanded]=useState(false),[list,setList]=useState(false),[view,setView]=useState<'preview'|'files'|'versions'>('preview')
 const current=useRef(isCurrent);current.current=isCurrent
 useLayoutEffect(()=>{
  const node=dialog.current;if(!node)return
  const previous=document.activeElement instanceof HTMLElement?document.activeElement:null
  if(expanded)node.showModal();else node.open=true
  const frame=requestAnimationFrame(()=>node.querySelector<HTMLButtonElement>('[data-artifact-close]')?.focus({preventScroll:true}))
  return()=>{cancelAnimationFrame(frame);node.close();if(previous?.isConnected)previous.focus({preventScroll:true})}
 },[portal,expanded])
 if(!portal)return null
 const version=artifact?.versions[0],count=rows.filter(row=>!row.historical).length,stop=()=>{if(expanded)setExpanded(false);else close()}
 const choose=(id:string,number:number)=>{if(current.current()){setList(false);void openArtifact?.(id,number)}}
 return createPortal(<dialog ref={dialog} className={[baseCss.dialog,panelCss.panel,panelCss.inline,expanded?panelCss.expanded:''].join(' ')} aria-label={t('artifact.panel.text.006')} onCancel={event=>{event.preventDefault();stop()}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();stop()}}}>
  <ArtifactPanelHeader count={count}>{!list&&references[0]&&<button type="button" aria-label={t('artifactFiles.download')} title={t('artifactFiles.download')} onClick={()=>download(references[0]!)}><Download size={16}/></button>}<button type="button" aria-label={t(expanded?'artifactFiles.collapseImage':'artifactFiles.expandImage')} onClick={()=>setExpanded(value=>!value)}>{expanded?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</button><button type="button" data-artifact-close aria-label={t('artifact.panel.text.009')} onClick={close}><X size={18}/></button></ArtifactPanelHeader>
  <div className={panelCss.layout}><article className={panelCss.content} aria-label={t('artifact.panel.text.021')}>
   {error?<p role="alert">{error}</p>:list?<GroupWorkResults groupId={groupId} rows={rows} summaries={summaries} roleNames={roleNames} openArtifact={choose} openMessage={message=>{if(current.current()){close();openMessage?.(message)}}}/>:!version?<p role="status">{t('collaboration.state.loading')}</p>:<>
    <button type="button" className={panelCss.back} onClick={()=>setList(true)}><ArrowLeft size={14}/>{t('artifact.panel.allResults')}</button>
    <header className={panelCss.artifactHeader}><span>{t('artifact.panel.text.006')} · v{reference.version}</span><h3>{version.title}</h3><p>{version.author} · {dateTime(version.at)} · {t('collaboration.results.sharedOnly')}</p></header>
    <nav className={panelCss.tabs} aria-label={t('artifact.panel.text.044')}>{(['preview','files','versions'] as const).map(tab=><button key={tab} type="button" aria-current={view===tab?'page':undefined} onClick={()=>setView(tab)}>{t(tab==='preview'?'artifact.panel.text.045':tab==='files'?'artifact.panel.text.046':'artifact.panel.text.070')}</button>)}</nav>
    {view==='preview'&&<div className={panelCss.markdown}>{version.sections.map(section=><section key={section.id}><h3>{section.title}</h3><MarkdownPreview markdown={section.text} images={false}/></section>)}</div>}
    {view==='files'&&<div><p>{version.source.title}</p>{references.map((item,index)=><button type="button" className={panelCss.sectionChoice} key={item.row.id} onClick={()=>{if(current.current())select(index)}}>{item.row.label}</button>)}{references[selected]&&<ConversationOverviewArtifactPreview reference={references[selected]!} backLabel={t('artifact.panel.text.045')} onBack={()=>setView('preview')} onDownload={download}/>}</div>}
    {view==='versions'&&<div><p>{t('collaboration.results.sharedOnly')}</p>{rows.filter(row=>row.reference.id===reference.id).map(row=><button type="button" className={panelCss.sectionChoice} key={row.reference.version} onClick={()=>choose(row.reference.id,row.reference.version)}>v{row.reference.version}</button>)}</div>}
   </>}
  </article></div>
 </dialog>,portal)
}
