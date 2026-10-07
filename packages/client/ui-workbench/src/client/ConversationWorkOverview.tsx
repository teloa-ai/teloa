import {useEffect,useRef,useState,type ReactNode} from 'react'
import {ArrowLeft,Bot,CheckCircle2,ChevronRight,Circle,Download,ExternalLink,FileText,Globe,Plug,Puzzle,Search,Square,Terminal,WandSparkles} from 'lucide-react'
import type {ConversationOverviewArtifact,ConversationOverviewSnapshot,ConversationOverviewStatus,ConversationOverviewStep,ConversationOverviewWork} from './conversation-overview-model.js'
import type {ConversationOverviewResourceGroup} from './conversation-overview-resources.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import type {OverviewMessageKey} from './i18n/locales/overview.js'
import css from './ConversationWorkOverview.module.css'

export type ConversationWorkOverviewProps=Readonly<{
 snapshot:ConversationOverviewSnapshot
 onOpenRecord:(work:ConversationOverviewWork)=>void|Promise<void>
 onStopWork:(work:ConversationOverviewWork)=>void|Promise<void>
 onReconcileWork?:(work:ConversationOverviewWork)=>void|Promise<void>
 onPreviewArtifact:(artifact:ConversationOverviewArtifact)=>void|Promise<void>
 onDownloadArtifact?:(artifact:ConversationOverviewArtifact)=>void|Promise<void>
}>
type StopRequest=Readonly<{status:'requesting'|'sent'|'unknown';sourceStatus:ConversationOverviewStatus}>
/** 只本地化宿主已记录的官方来源，不按工具名或插件显示名猜身份。 */
const resourceLabelKey=(resource:ConversationOverviewResourceGroup):OverviewMessageKey|undefined=>{
 if(resource.kind==='search')return 'overview.resource.search'
 if(resource.kind!=='plugin')return undefined
 switch(resource.provider){
  case '@deepseek-ai/dsh-tool-bash':return 'overview.resource.commands'
  case '@deepseek-ai/dsh-tool-fs':return 'overview.resource.files'
  case '@deepseek-ai/dsh-tool-present':return 'overview.resource.deliveries'
  default:return undefined
 }
}

/** 只投影 Harness 的会话事实；分栏、浮动、扩大与窄窗行为由原生右栏承载。 */
export function ConversationWorkOverview(props:ConversationWorkOverviewProps){
 const {snapshot}=props,{locale,t}=useI18n()
 const [resourceId,setResourceId]=useState<string>(),[error,setError]=useState(''),[requests,setRequests]=useState<ReadonlyMap<string,StopRequest>>(new Map())
 const [earlierOpen,setEarlierOpen]=useState(false),[endedOpen,setEndedOpen]=useState(false),[versionsOpen,setVersionsOpen]=useState(false)
 const trigger=useRef<HTMLButtonElement>(),back=useRef<HTMLButtonElement>(null),generation=useRef(0)
 const resource=snapshot.usageGroups.find(group=>group.id===resourceId)
 const currentArtifacts=snapshot.artifacts.filter(artifact=>!artifact.isHistorical),historicalArtifacts=snapshot.artifacts.filter(artifact=>artifact.isHistorical)
 const resourceLabel=(resource:ConversationOverviewResourceGroup)=>{const key=resourceLabelKey(resource);return key?t(key):resource.name}
 useEffect(()=>{
  generation.current++;setResourceId(undefined);setError('');setRequests(new Map());setEarlierOpen(false);setEndedOpen(false);setVersionsOpen(false)
 },[snapshot.sessionId])
 useEffect(()=>{
  setRequests(previous=>{
   const next=new Map(previous)
   for(const [id,request] of next){const work=snapshot.running.find(item=>item.id===id);if(!work||work.status!==request.sourceStatus)next.delete(id)}
   return next.size===previous.size?previous:next
  })
 },[snapshot])
 useEffect(()=>{if(resource)back.current?.focus()},[resourceId])
 const closeResource=()=>{setResourceId(undefined);queueMicrotask(()=>trigger.current?.isConnected&&trigger.current.focus())}
 useEffect(()=>{if(resourceId&&!resource)closeResource()},[resourceId,resource])
 const invoke=(action:()=>void|Promise<void>)=>{
  const current=generation.current
  void Promise.resolve().then(action).then(()=>{if(current===generation.current)setError('')},cause=>{if(current===generation.current)setError(localizeWorkError(locale,cause))})
 }
 const stop=(work:ConversationOverviewWork)=>{
  if(requests.has(work.id))return
  const current=generation.current
  setRequests(previous=>new Map(previous).set(work.id,{status:'requesting',sourceStatus:work.status}));setError('')
  void Promise.resolve().then(()=>props.onStopWork(work)).then(()=>{
   if(current===generation.current)setRequests(previous=>previous.has(work.id)?new Map(previous).set(work.id,{status:'sent',sourceStatus:work.status}):previous)
  },()=>{
   if(current===generation.current)setRequests(previous=>previous.has(work.id)?new Map(previous).set(work.id,{status:'unknown',sourceStatus:work.status}):previous)
  })
 }
 const reconcile=(work:ConversationOverviewWork)=>invoke(async()=>{
  await props.onReconcileWork?.(work)
  setRequests(previous=>{const next=new Map(previous);next.delete(work.id);return next})
 })
 const hasWork=Boolean(snapshot.progress.current.length||snapshot.progress.earlier.length||snapshot.progress.goal||snapshot.running.length||snapshot.ended.length||snapshot.artifacts.length||snapshot.usageGroups.length)
 const statusLabel=(status:ConversationOverviewStatus|'pending')=>{
  switch(status){
   case 'running':return t('status.running')
   case 'completed':return t('status.completed')
   case 'failed':return t('status.failed')
   case 'idle':return t('overview.status.idle')
   case 'pending':return t('overview.status.pending')
   case 'waiting':return t('overview.status.waiting')
   case 'stopping':return t('overview.status.stopping')
   case 'stopped':return t('overview.status.stopped')
   case 'unknown':return t('overview.status.unknown')
  }
 }
 const steps=(items:readonly ConversationOverviewStep[])=>items.map(step=><li key={step.id} className={css.step} data-step-status={step.status}>
  <span className={css.stepIcon}>{step.status==='completed'?<CheckCircle2 size={16}/>:step.status==='running'?<Circle size={12}/>:<Circle size={7}/>}</span>
  <div><span>{step.content}</span><small>{statusLabel(step.status)}</small></div>
 </li>)
 const workCard=(work:ConversationOverviewWork)=>{
  const request=requests.get(work.id),status=request?.status==='unknown'?'unknown':work.status
  return <article key={work.id} className={css.workCard} data-work-status={status}>
   <div className={css.workTitle}>{work.kind==='subagent'?<Bot size={16}/>:<Terminal size={16}/>}<strong>{work.label}</strong>
    {work.canStop&&status!=='unknown'&&<button type="button" className={css.iconButton} aria-label={t('overview.stopAria',{name:work.label})} disabled={Boolean(request)||work.status==='stopping'} onClick={()=>stop(work)}><Square size={13}/></button>}
   </div>
   {work.detail&&<p className={css.workDescription}>{work.detail}</p>}
   {work.progress&&work.progress!==work.detail&&<p className={css.workDescription}>{work.progress}</p>}
   <div className={css.workMeta}><span className={css.status} data-status={status}>{statusLabel(status)}</span>
    {work.canOpenRecord&&<button type="button" className={css.textButton} onClick={()=>invoke(()=>props.onOpenRecord(work))}>{t('overview.record')}</button>}
    {status==='unknown'&&props.onReconcileWork&&<button type="button" className={css.textButton} onClick={()=>reconcile(work)}>{t('overview.reconcile')}</button>}
   </div>
   {request&&request.status!=='unknown'&&<p className={css.note} role="status">{t(request.status==='requesting'?'overview.stopRequesting':'overview.stopAwaiting')}</p>}
   {status==='unknown'&&<p className={css.note}>{t('overview.unknownHint')}</p>}
  </article>
 }
 const artifactCard=(artifact:ConversationOverviewArtifact)=><article key={artifact.id} className={css.artifactCard}>
  <button type="button" className={css.artifactPreview} aria-label={t('overview.previewAria',{name:artifact.label})} onClick={()=>invoke(()=>props.onPreviewArtifact(artifact))}>
   <span className={css.fileIcon}><FileText size={22}/></span><span className={css.fileInfo}><strong>{artifact.label}</strong><small>{artifact.kind}{artifact.status!=='unknown'&&<> · {t(artifact.status==='draft'?'overview.artifact.draft':'overview.artifact.final')}</>}{artifact.version&&<> · {artifact.version}</>}</small></span><ChevronRight size={15}/>
  </button>
  {props.onDownloadArtifact&&<button type="button" className={css.iconButton} aria-label={t('overview.downloadAria',{name:artifact.label})} onClick={()=>invoke(()=>props.onDownloadArtifact!(artifact))}><Download size={16}/></button>}
 </article>
 return <section className={css.root} aria-label={t('overview.title')}>
  {error&&<p role="alert" className={css.error}>{error}</p>}
  <div className={css.overview} hidden={Boolean(resource)}>
   {!hasWork?<div className={css.empty}>{snapshot.status!=='idle'&&<span className={css.status} data-status={snapshot.status}>{statusLabel(snapshot.status)}</span>}<p>{t('overview.empty')}</p></div>:<>
    {(snapshot.progress.current.length>0||snapshot.progress.earlier.length>0||snapshot.progress.goal)&&<section className={css.section} aria-label={t('overview.progress')}>
     <SectionHeading label={t('overview.progress')}><span className={css.status} data-status={snapshot.status}>{statusLabel(snapshot.status)}</span></SectionHeading>
     {snapshot.progress.earlier.length>0&&<details className={css.history} open={earlierOpen} onToggle={event=>setEarlierOpen(event.currentTarget.open)}><summary><ChevronRight size={13}/>{t('overview.earlierSteps',{count:snapshot.progress.earlier.length})}</summary><ol className={css.timeline}>{steps(snapshot.progress.earlier)}</ol></details>}
     {snapshot.progress.goal&&<div className={css.goal}><strong>{snapshot.progress.goal.objective}</strong>{snapshot.progress.goal.blockedReason&&<p className={css.note}>{snapshot.progress.goal.blockedReason}</p>}</div>}
     {snapshot.progress.current.length>0&&<ol className={css.timeline}>{steps(snapshot.progress.current)}</ol>}
    </section>}
    <section className={css.section} aria-label={t('overview.running')}>
     <SectionHeading label={t('overview.running')} count={snapshot.running.filter(work=>work.status==='running'||work.status==='stopping').length}/>
     {snapshot.running.length?<div className={css.workList}>{snapshot.running.map(workCard)}</div>:<p className={css.note}>{t('overview.noRunning')}</p>}
     {snapshot.ended.length>0&&<details className={css.history} open={endedOpen} onToggle={event=>setEndedOpen(event.currentTarget.open)}><summary><ChevronRight size={13}/>{t('overview.endedWork',{count:snapshot.ended.length})}</summary><div className={css.workList}>{snapshot.ended.map(workCard)}</div></details>}
    </section>
    {snapshot.artifacts.length>0&&<section className={css.section} aria-label={t('overview.artifacts')}>
     <SectionHeading label={t('overview.artifacts')} count={currentArtifacts.length}/>
     {currentArtifacts.length>0&&<div className={css.artifacts}>{currentArtifacts.map(artifactCard)}</div>}
     {historicalArtifacts.length>0&&<details className={css.history} open={versionsOpen} onToggle={event=>setVersionsOpen(event.currentTarget.open)}><summary><ChevronRight size={13}/>{t('knowledge.ui.035')} · {historicalArtifacts.length}</summary><div className={css.artifacts}>{historicalArtifacts.map(artifactCard)}</div></details>}
    </section>}
    <section className={css.section} aria-label={t('overview.usage')}>
     <SectionHeading label={t('overview.usage')}/><p className={css.scope}>{t('overview.usageScope')}</p>
     {snapshot.usageGroups.length?<div className={css.resourceList}>{snapshot.usageGroups.map(group=><button key={group.id} type="button" className={css.resourceRow} onClick={event=>{trigger.current=event.currentTarget;setResourceId(group.id)}}>
      <ResourceIcon kind={group.kind}/><span>{resourceLabel(group)}</span><span className={css.resourceValue}>{t('overview.resourceRecords',{count:group.evidence.length})}</span><ChevronRight size={14}/>
     </button>)}</div>:<p className={css.note}>{t('overview.noUsage')}</p>}
    </section>
   </>}
  </div>
  {resource&&<div className={css.resourceDetail} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();closeResource()}}}>
   <header className={css.detailHeader}><button ref={back} type="button" className={css.backButton} onClick={closeResource}><ArrowLeft size={15}/>{t('overview.back')}</button><h2><ResourceIcon kind={resource.kind}/>{resourceLabel(resource)}</h2><p className={css.scope}>{t('overview.usageScope')}</p></header>
   <ResourceDetails resource={resource}/>
  </div>}
 </section>
}

function SectionHeading({label,count,children}:{label:string;count?:number;children?:ReactNode}){
 return <h2 className={css.heading}>{label}{count!==undefined&&count>0&&<span className={css.count}>{count}</span>}{children}</h2>
}
function ResourceIcon({kind}:{kind:ConversationOverviewResourceGroup['kind']}){
 return kind==='search'?<Globe size={16}/>:kind==='skill'?<WandSparkles size={16}/>:kind==='mcp'?<Plug size={16}/>:<Puzzle size={16}/>
}
function ResourceDetails({resource}:{resource:ConversationOverviewResourceGroup}){
 const {t,time}=useI18n()
 const safeLink=(value:string)=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:undefined}catch{return undefined}}
 return <div className={css.detailContent}>{resource.evidence.map(event=><article key={event.id} className={css.event}>
  <div className={css.eventHeading}><strong>{event.executorName||t('overview.executorUnknown')}</strong><span className={css.status} data-status={event.status}>{event.status==='completed'?t('status.completed'):event.status==='failed'?t('status.failed'):event.status==='read'?t('overview.resource.read'):event.status==='injected'?t('overview.resource.injected'):t('overview.status.pending')}</span></div>
  <div className={css.eventMeta}>{Number.isFinite(event.timestamp)&&<time dateTime={new Date(event.timestamp).toISOString()}>{time(event.timestamp)}</time>}{event.toolName&&<code>{event.toolName}</code>}</div>
  {event.queries?.map((query,index)=><p key={index} className={css.query}><Search size={14}/><span>{query}</span></p>)}
  {event.sources&&event.sources.length>0&&<div className={css.sources}><h3>{t('overview.resource.sources')}</h3>{event.sources.map((source,index)=>{const href=safeLink(source.url);return <div key={index} className={css.source}>{href?<a href={href} target="_blank" rel="noopener noreferrer"><span>{source.title||source.url}</span><ExternalLink size={12}/></a>:<strong>{source.title||source.url}</strong>}<small>{source.url}</small>{source.snippet&&<p>{source.snippet}</p>}</div>})}</div>}
  {event.truncated&&<p className={css.note}>{t('overview.resource.truncated')}</p>}
 </article>)}</div>
}
