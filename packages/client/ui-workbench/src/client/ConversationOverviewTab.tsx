import {useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import {ArrowLeft,ListTree,RefreshCw} from 'lucide-react'
import {createSnapshotStore,type ObservableSnapshot} from '@deepseek-ai/dsh-client-store'
import type {ISessions,SessionBinding} from '@deepseek-ai/dsh-api-session-controller/client'
import type {IJobs} from '@deepseek-ai/dsh-api-job-controller/client'
import type {SessionId} from '@deepseek-ai/dsh-session/types'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {ToolResourceUseSnapshot,ExternalHarnessWorkView} from '@teloa/contract'
import type {ArtifactApi} from './artifact-api.js'
import type {ArtifactFileApi} from './artifact-files.js'
import type {ConversationOverviewArtifact,ConversationOverviewWork} from './conversation-overview-model.js'
import {createConversationOverviewSession} from './conversation-overview-session.js'
import {conversationOverviewDeliveries} from './conversation-overview-deliveries.js'
import {conversationOverviewArtifactDownload,conversationOverviewFileReference,loadConversationOverviewArtifacts,type ConversationOverviewArtifactReference} from './conversation-overview-artifacts.js'
import {ConversationWorkOverview} from './ConversationWorkOverview.js'
import {ResourceCitationHistory} from './ResourceCitationHistory.js'
import type {ResourceApi} from './resource-api.js'
import {ConversationOverviewArtifactPreview} from './ConversationOverviewArtifactPreview.js'
import {teloaTabHost,teloaTabHostRevision,subscribeTeloaTabHost} from './sidebar-right-tab-host.js'
import {canShowConversationOverview} from './rightbar-width.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ConversationOverviewTab.module.css'

export const CONVERSATION_OVERVIEW_KIND='teloa.overview'
export const CONVERSATION_OVERVIEW_TAB_ID='@teloa/client-ui-workbench/overview'
export type ConversationOverviewTabPorts={sessions:ISessions;jobs:IJobs;connection:ObservableSnapshot<string>;pendingInteraction:ObservableSnapshot<boolean>;artifacts:ArtifactApi;files:ArtifactFileApi;artifactChanges:ObservableSnapshot<number>;resourceHistory?:Pick<ResourceApi,'history'>;readResourceUses:(sessionId:string,signal:AbortSignal)=>Promise<readonly ToolResourceUseSnapshot[]>;readExternalWork?:(sessionId:string,signal:AbortSignal)=>Promise<readonly ExternalHarnessWorkView[]>;stopExternalWork?:(sessionId:string,activationId:string,signal:AbortSignal)=>Promise<void>}
export function ConversationOverviewEntry({sessionId,open}:PropsRuntime<'conversation.session.header.utilities'>&{open:(id:string)=>void}){
 const {t}=useI18n()
 useSyncExternalStore(subscribeTeloaTabHost,teloaTabHostRevision,teloaTabHostRevision)
 const [viewport,setViewport]=useState(window.innerWidth)
 useEffect(()=>{const resize=()=>setViewport(window.innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize)},[])
 const hasRoom=canShowConversationOverview(viewport,teloaTabHost()?.overviewRoom?.canShow()??true)
 return <button type="button" className={css.entry} aria-label={t('overview.title')} title={t(hasRoom?'overview.title':'overview.moreRoom')} disabled={!hasRoom} onClick={()=>{if(hasRoom)open(sessionId)}}><ListTree size={16}/></button>
}
export function ConversationOverviewTitle(){const {t}=useI18n();return <span>{t('overview.title')}</span>}
export function ConversationOverviewTab(props:PropsRuntime<'sidebar.right.pane.tab'>&ConversationOverviewTabPorts){
 useSyncExternalStore(props.sessions.list.subscribe,props.sessions.list.getSnapshot,props.sessions.list.getSnapshot)
 const binding=props.sessions.binding(props.sessionId)
 const {t}=useI18n()
 return binding?<BoundOverview key={props.sessionId} {...props} binding={binding}/>:<p role="status" className={css.notice}>{t('sidebarRight.tab.missingTarget')}</p>
}
function BoundOverview({binding,sessions,jobs,connection,pendingInteraction,artifacts:api,files,artifactChanges,resourceHistory,readResourceUses,readExternalWork,stopExternalWork,useTabInfo}:PropsRuntime<'sidebar.right.pane.tab'>&ConversationOverviewTabPorts&{binding:SessionBinding}){
 const info=useTabInfo(),{t,locale}=useI18n(),sessionId=binding.sessionId
 useSyncExternalStore(subscribeTeloaTabHost,teloaTabHostRevision,teloaTabHostRevision)
 useLayoutEffect(()=>{teloaTabHost()?.overviewRoom?.guard(sessionId)})
 const artifactHost=teloaTabHost()?.artifactPreview,sharedSelection=artifactHost?.target(sessionId),artifactMount=useRef<HTMLDivElement>(null)
 useEffect(()=>{if(artifactHost&&artifactMount.current)return artifactHost.mount(sessionId,artifactMount.current)},[artifactHost,sessionId])
 const results=useMemo(()=>createSnapshotStore<readonly ConversationOverviewArtifact[]>([]),[binding])
 const resourceUses=useMemo(()=>createSnapshotStore<readonly ToolResourceUseSnapshot[]>([]),[binding])
 const externalWorks=useMemo(()=>createSnapshotStore<readonly ExternalHarnessWorkView[]>([]),[binding])
 const external=useMemo(()=>{
  if(!readExternalWork||!stopExternalWork)return undefined
  let mounted=false,request=0
  const current=()=>mounted&&!info.tab.signal.aborted&&sessions.binding(sessionId)===binding
  const refresh=async()=>{
   if(!current()||connection.getSnapshot()!=='connected')return
   const token=++request
   try{const rows=await readExternalWork(sessionId,info.tab.signal);if(current()&&token===request)externalWorks.set(rows)}
   catch(error){if(current()&&token===request)throw error}
  }
  return {state:externalWorks,refresh,mount:()=>{mounted=true;return()=>{mounted=false;request++}},stop:async(parentId:string,activationId:string)=>{
   if(!current()||parentId!==sessionId)throw Object.assign(Error(),{code:'teloa/source-unavailable'})
   await stopExternalWork(parentId,activationId,info.tab.signal);await refresh()
  }}
 },[binding,sessions,connection,externalWorks,readExternalWork,stopExternalWork,info.tab.signal])
 const source=useMemo(()=>createConversationOverviewSession({binding,sessions,jobs,connection,pendingInteraction,artifacts:results,resourceUseSnapshots:resourceUses,...external?{external}:{},executorName:()=>sessions.list.getSnapshot().byId[sessionId]?.title}),[binding,sessions,jobs,connection,pendingInteraction,results,resourceUses,external])
 const snapshot=useSyncExternalStore(source.subscribe,source.getSnapshot,source.getSnapshot)
 const [selection,setSelection]=useState<ConversationOverviewArtifactReference>(),[job,setJob]=useState<ConversationOverviewWork>(),[error,setError]=useState(''),[resourceError,setResourceError]=useState(''),[retry,setRetry]=useState(0)
 const references=useRef(new Map<string,ConversationOverviewArtifactReference>()),reading=useRef(new Map<string,Promise<ConversationOverviewArtifactReference>>()),trigger=useRef<HTMLElement>(),intent=useRef(0)
 const wasShared=useRef(false)
 useLayoutEffect(()=>{if(wasShared.current&&!sharedSelection)trigger.current?.isConnected&&trigger.current.focus();wasShared.current=!!sharedSelection},[!!sharedSelection])
 const available=()=>!info.tab.signal.aborted&&sessions.binding(sessionId)===binding
 useEffect(()=>source.attach(),[source])
 useEffect(()=>{
  if(!external)return
  let active=true,lastFact=-1
  const unmount=external.mount(),catalog=binding.session.projections.faceOf('subagentCatalog')
  const refresh=()=>{
   const rows=catalog.getSnapshot()
   if(!Array.isArray(rows)||!rows.some(row=>row.mode==='external'))return
   void external.refresh().catch(()=>{if(active)externalWorks.set(externalWorks.getSnapshot().map(row=>({...row,status:'unknown',canStop:false})))})
  }
  const facts=()=>{
   const next=Math.max(-1,...binding.eventSource.getSnapshot().entries.flatMap(entry=>entry.type==='event'&&['tool/result','turn/end'].includes(entry.event.type)?[entry.event.seq]:[]))
   if(next!==lastFact){lastFact=next;refresh()}
  }
  const off=[catalog.subscribe(refresh),connection.subscribe(refresh),binding.eventSource.subscribe(facts)]
  const timer=setInterval(()=>{if(externalWorks.getSnapshot().some(row=>['reserved','running','stopping'].includes(row.status)))refresh()},1500)
  refresh()
  return()=>{active=false;unmount();clearInterval(timer);for(const dispose of off)dispose()}
 },[binding,connection,external,externalWorks])
 useEffect(()=>{
  let active=true,request=0,lastKey=''
  const factSeq=(id:SessionId)=>{
   let seq=-1
   for(const entry of sessions.binding(id)?.eventSource.getSnapshot().entries??[])if(entry.type==='event'&&['tool/result','tool/ptc-dispatch','turn/end','subagent/catalog'].includes(entry.event.type))seq=Math.max(seq,entry.event.seq)
   return seq
  }
  const refresh=()=>{
   const view=source.getSnapshot(),children=[...view.running,...view.ended].flatMap(work=>work.childSessionId?[work.childSessionId as SessionId]:[])
   const key=JSON.stringify([connection.getSnapshot(),retry,factSeq(sessionId),...children.map(id=>[id,factSeq(id)])])
   if(key===lastKey)return
   lastKey=key;const token=++request
   if(connection.getSnapshot()!=='connected'||!available())return
   void readResourceUses(sessionId,info.tab.signal).then(rows=>{
    if(active&&token===request&&available()){resourceUses.set(rows);setResourceError('')}
   },cause=>{if(active&&token===request&&available()){lastKey='';setResourceError(localizeWorkError(locale,cause))}})
  }
  const off=[source.subscribe(refresh),connection.subscribe(refresh)]
  refresh()
  return()=>{active=false;request++;for(const dispose of off)dispose()}
 },[binding,source,connection,readResourceUses,resourceUses,locale,retry])
 useEffect(()=>{
  let active=true,request=0,lastKey=''
  const refresh=()=>{
   const events=binding.eventSource.getSnapshot().entries
   const rows=conversationOverviewDeliveries(sessionId,events,sessions.list.getSnapshot().byId[sessionId]?.cwd)
   const current=results.getSnapshot().filter(row=>!row.id.startsWith('["delivery",'))
   results.set([...rows,...current])
   let resultSeq=-1
   // 后台交办以原生消息回流，不一定触发新一轮 turn/end。
   for(const entry of events)if(entry.type==='event'&&(entry.event.type==='turn/end'||entry.event.type==='user/message'&&entry.event.surfaceOp==='append'))resultSeq=Math.max(resultSeq,entry.event.seq)
   const key=JSON.stringify([connection.getSnapshot(),resultSeq,artifactChanges.getSnapshot(),locale,retry])
   if(key===lastKey)return
   lastKey=key;const token=++request
   if(connection.getSnapshot()!=='connected'||!available())return
   void loadConversationOverviewArtifacts(api,sessionId,t).then(value=>{
    if(!active||token!==request||!available())return
    // 已打开的快照独立持有，刷新目录不会把旧预览换成当前文件。
    for(const [id,reference] of value.references)references.current.set(id,reference)
    const deliveries=conversationOverviewDeliveries(sessionId,binding.eventSource.getSnapshot().entries,sessions.list.getSnapshot().byId[sessionId]?.cwd)
    results.set([...deliveries,...value.rows]);setError('')
   },cause=>{if(active&&token===request&&available()){lastKey='';setError(localizeWorkError(locale,cause))}})
  }
  const off=[binding.eventSource.subscribe(refresh),artifactChanges.subscribe(refresh),connection.subscribe(refresh)]
  refresh()
  return()=>{active=false;request++;for(const dispose of off)dispose()}
 },[binding,api,artifactChanges,results,connection,locale,t,retry])
 useEffect(()=>()=>{intent.current++;reading.current.clear();references.current.clear()},[binding])
 const back=()=>{intent.current++;if(artifactHost?.target(sessionId))artifactHost.close(sessionId);setSelection(undefined);setJob(undefined);queueMicrotask(()=>trigger.current?.isConnected&&trigger.current.focus())}
 const resolveFile=async(row:ConversationOverviewArtifact)=>{
  if(!available()||row.sessionId!==sessionId||!source.getSnapshot().artifacts.some(item=>item.id===row.id))throw Object.assign(Error(),{code:'teloa/source-unavailable'})
  const cached=references.current.get(row.id)
  if(cached)return cached
  if(row.id.startsWith('["registered",'))throw Object.assign(Error(),{code:'teloa/source-unavailable'})
  const pending=reading.current.get(row.id)
  if(pending)return pending
  const read=files.read(sessionId,row.path,info.tab.signal).then(file=>{
   if(!available())throw Object.assign(Error(),{code:'teloa/source-unavailable'})
   const reference=conversationOverviewFileReference(row,file)
   references.current.set(row.id,reference);return reference
  })
  reading.current.set(row.id,read)
  try{return await read}finally{if(reading.current.get(row.id)===read)reading.current.delete(row.id)}
 }
 const download=(reference:ConversationOverviewArtifactReference)=>{
  if(!available()||reference.sessionId!==sessionId)throw Object.assign(Error(),{code:'teloa/source-unavailable'})
  const value=conversationOverviewArtifactDownload(reference),url=URL.createObjectURL(new Blob([value.bytes],{type:value.type}))
  const anchor=document.createElement('a');anchor.href=url;anchor.download=value.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),0)
 }
 const preview=async(row:ConversationOverviewArtifact)=>{const token=++intent.current;trigger.current=document.activeElement instanceof HTMLElement?document.activeElement:undefined;const reference=await resolveFile(row);if(available()&&intent.current===token){setJob(undefined);if(reference.artifactId&&reference.version!==undefined&&artifactHost){setSelection(undefined);artifactHost.open(sessionId,{source:reference.source,artifact:{id:reference.artifactId,version:reference.version},...(reference.kind==='file'?{initialView:'files' as const}:{})})}else{if(artifactHost?.target(sessionId))artifactHost.close(sessionId);setSelection(reference)}}}
 const record=(work:ConversationOverviewWork)=>{
  if(!available())throw Object.assign(Error(),{code:'teloa/source-unavailable'})
  intent.current++;setSelection(undefined)
  if(artifactHost?.target(sessionId))artifactHost.close(sessionId)
  trigger.current=document.activeElement instanceof HTMLElement?document.activeElement:undefined
  if(work.childSessionId){
   const address=sessions.subagentAddress(work.childSessionId as SessionId)
   if(!address||address.parentSessionId!==sessionId)throw Object.assign(Error(),{code:'teloa/source-unavailable'})
   const query=new URLSearchParams({parent:address.parentSessionId,mode:address.mode})
   info.tab.actions.openResource(`dsh-resource://subagentchat/session/${encodeURIComponent(address.childSessionId)}?${query}`)
  }else if(work.jobId)setJob(work)
 }
 return <div className={css.root}>
  {(error||resourceError)&&<div className={css.error} role="alert">{[...new Set([error,resourceError].filter(Boolean))].map(value=><p key={value}>{value}</p>)}<button type="button" onClick={()=>setRetry(value=>value+1)}>{t('common.retry')}</button></div>}
  <div className={css.content} hidden={Boolean(selection||job||sharedSelection)}><ConversationWorkOverview snapshot={snapshot} {...(resourceHistory?{citationHistory:<ResourceCitationHistory sessionId={sessionId} api={resourceHistory} revision={JSON.stringify([snapshot.currentRound?.startSeq,snapshot.status,retry])}/>}:{})} onOpenRecord={record} onStopWork={source.stopWork} onReconcileWork={source.reconcileWork} onPreviewArtifact={preview} onDownloadArtifact={async row=>download(await resolveFile(row))}/></div>
  {artifactHost&&api.pendingFor(sessionId).map(item=><button type="button" key={item.key} className={css.entry} aria-label={t('artifact.panel.text.015')+item.title} title={t('artifact.panel.text.015')+item.title} onClick={()=>{if(available()){intent.current++;setSelection(undefined);setJob(undefined);trigger.current=document.activeElement instanceof HTMLElement?document.activeElement:undefined;artifactHost.open(sessionId,{source:{kind:'session',id:sessionId}})}}}><RefreshCw size={15}/></button>)}
  <div ref={artifactMount} className={css.content} hidden={!sharedSelection}/>
  {selection&&<ConversationOverviewArtifactPreview reference={selection} onBack={back} onDownload={download} onSave={artifactHost?.saveFile?async reference=>{const token=intent.current;const current=()=>available()&&intent.current===token;try{const saved=await artifactHost.saveFile!(sessionId,reference.file,current);if(current()){setSelection(undefined);artifactHost.open(sessionId,{source:reference.source,artifact:saved})}}finally{if(available())setRetry(value=>value+1)}}:undefined}/>}
  {job&&<JobRecord jobs={jobs} work={job} signal={info.tab.signal} onBack={back}/>}
 </div>
}
function JobRecord({jobs,work,signal,onBack}:{jobs:IJobs;work:ConversationOverviewWork;signal:AbortSignal;onBack:()=>void}){
 const {t,locale}=useI18n(),state=useSyncExternalStore(jobs.state.subscribe,jobs.state.getSnapshot,jobs.state.getSnapshot),back=useRef<HTMLButtonElement>(null)
 useEffect(()=>{back.current?.focus();if(!work.jobId||signal.aborted)return;return jobs.observe(work.sessionId as SessionId,work.jobId as Parameters<IJobs['observe']>[1])},[jobs,work.jobId,work.sessionId,signal])
 const output=work.jobId?state.observed[work.jobId]:undefined
 return <section className={css.record} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onBack()}}}>
  <header><button ref={back} type="button" onClick={onBack}><ArrowLeft size={15}/>{t('overview.back')}</button><h2>{work.label}</h2></header>
  {output?.gapBefore&&<p className={css.notice}>{t('overview.outputGap')}</p>}
  {output?.error&&<p role="alert" className={css.error}>{localizeWorkError(locale,{code:'teloa/source-unavailable'})}</p>}
  <pre>{output?.text||t('overview.outputEmpty')}</pre>
 </section>
}
