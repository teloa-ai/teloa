import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {SidebarRightTabDefinition} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import {openRetrievalCitation,readRetrievalSourceAddress,readProjectCitation,resolveRetrievalCitation,retainRetrievalCitationNavigation,retrievalCitationTabId,retrievalCitationTabKind,retrievalTurnCitations,projectTurnAliasCitations,taskTurnCitations,readTaskCitation,type RetrievalCitationPort} from './retrieval-citations.js'
import type {ProjectContextCitation} from '@teloa/contract'
import {watchCitationActivation,type CitationActivationState} from './citation-activation.js'
import {useI18n} from './i18n/provider.js'
import css from './RetrievalCitation.module.css'

export function retrievalCitationTabDefinition(label:(address:string)=>string):SidebarRightTabDefinition{
 return {id:retrievalCitationTabId,kind:retrievalCitationTabKind,patterns:['dsh-resource://teloa-source/**'],canOpen:address=>!!readRetrievalSourceAddress(address),title:label}
}
/** 列出可信工具命中及被官方安全渲染为文字的原轮次来源，点击复用同一原生页签。 */
export function RetrievalSourceLinks({turn,port}:PropsRuntime<'conversation.chat.turnTail'>&{port:RetrievalCitationPort}){
 const {t}=useI18n(),history=useSyncExternalStore(port.events.subscribe,port.events.getSnapshot),[failed,setFailed]=useState(false)
 const anchor=useRef<HTMLSpanElement>(null)
 useEffect(()=>{const container=anchor.current?.closest<HTMLElement>('[data-chat-flow]');return container?retainRetrievalCitationNavigation(container,port):undefined},[port])
 const rows=turn.status==='closed'?retrievalTurnCitations(history.entries,port.sessionId,turn.turn):[]
 const tasks=turn.status==='closed'?taskTurnCitations(history.entries,turn.turn):[]
 const aliases=useMemo(()=>turn.status==='closed'?projectTurnAliasCitations(history.entries,port.sessionId,turn.turn):[],[history,port.sessionId,turn.turn,turn.status])
 return <><span ref={anchor} hidden/>{(rows.length>0||aliases.length>0||tasks.length>0)&&port.current()&&<section className={css.links} aria-label={t('retrieval.citation.sources')}><span>{t('retrieval.citation.sources')}</span>{rows.map(({path,reference})=><button type="button" key={path} onClick={()=>{setFailed(false);void openRetrievalCitation(port,path).catch(()=>{if(port.current())setFailed(true)})}}>{reference.title}<small>v{reference.resourceVersion}</small></button>)}{tasks.map(({path,title,version})=><button type="button" key={path} onClick={()=>{setFailed(false);void openRetrievalCitation(port,path).catch(()=>{if(port.current())setFailed(true)})}}>{title}<small>v{version}</small></button>)}{aliases.map(({path,source})=><button type="button" key={path} onClick={()=>{setFailed(false);void openRetrievalCitation(port,path,turn.turn).catch(()=>{if(port.current())setFailed(true)})}}>{source.title}<small>v{source.version}</small></button>)}{failed&&<span role="status">{t('retrieval.citation.unavailable')}</span>}</section>}</>
}
export function RetrievalCitationTab({sessionId,useTabInfo,port}:PropsRuntime<'sidebar.right.pane.tab'>&{port:RetrievalCitationPort}){
 const info=useTabInfo()
 return <RetrievalCitationContent sessionId={sessionId} address={info.tab.navigation.address} port={port} visible={info.tab.visible}/>
}
export function RetrievalCitationContent({sessionId,address,port,visible=true}:{sessionId:string;address:string;port:RetrievalCitationPort;visible?:boolean}){
 const route=readRetrievalSourceAddress(address)
 if(route?.task)return <TaskCitationContent key={address} address={address} sessionId={sessionId} port={port} visible={visible}/>
 if(route?.project)return <ProjectCitationContent key={address} address={address} sessionId={sessionId} port={port} visible={visible}/>
 return <RetrievalExcerptContent sessionId={sessionId} address={address} port={port} visible={visible}/>
}
function ProjectCitationContent({sessionId,address,port,visible}:{sessionId:string;address:string;port:RetrievalCitationPort;visible:boolean}){
 const {t}=useI18n(),[visibility,setVisibility]=useState(()=>document.visibilityState),[revision,setRevision]=useState(0)
 useSyncExternalStore(port.events.subscribe,port.events.getSnapshot)
 const current=visible&&port.current()&&visibility!=='hidden',lease=useMemo(()=>({}),[address,sessionId,port,current,revision])
 const [state,setState]=useState<{lease:object;value:ProjectContextCitation|null}|null>(null)
 // 返回原页签或窗口后重新核对当前可见性；读取期间不复用上次已展示的正文。
 useEffect(()=>{const refresh=()=>{setVisibility(document.visibilityState);setRevision(value=>value+1)}
  window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh)
  return()=>{window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh)}
 },[])
 useEffect(()=>{const abort=new AbortController(),request=readRetrievalSourceAddress(address)?.project
  if(!request||sessionId!==port.sessionId||!current){setState({lease,value:null});return}
  void readProjectCitation(port,request,abort.signal).then(value=>{if(!abort.signal.aborted)setState({lease,value})},()=>{if(!abort.signal.aborted)setState({lease,value:null})})
  return()=>abort.abort()
 },[address,sessionId,port,current,lease])
 if(!current||state?.lease===lease&&!state.value)return <p className={css.unavailable} role="status">{t('retrieval.citation.unavailable')}</p>
 if(!state||state.lease!==lease)return <p className={css.unavailable} role="status">{t('retrieval.citation.loading')}</p>
 const source=state.value!
 return <article className={css.source} aria-label={t('retrieval.citation.original')}><header><h2>{source.title}</h2><span>{t('retrieval.citation.version',{version:source.version})}</span></header><p className={css.caption}>{t(source.currentVersion>source.version?'retrieval.citation.projectUpdated':'retrieval.citation.projectSnapshot',{version:source.currentVersion})}</p><pre>{source.markdown}</pre></article>
}
/** 生命周期租约变化在渲染时即隐藏上一份正文，事件重验期间只显示加载态。 */
function useCitationSource<T>(port:RetrievalCitationPort,visible:boolean,read:(signal:AbortSignal)=>Promise<T>){
 const lease=useMemo(()=>({}),[port,read,visible]),[state,setState]=useState<{lease:object;result:CitationActivationState<T>}|null>(null)
 useEffect(()=>watchCitationActivation({focus:window,visibility:document,visible:()=>visible&&document.visibilityState!=='hidden',current:port.current,read,publish:result=>setState({lease,result})}),[lease,port,read,visible])
 return state?.lease===lease?state.result:{status:'loading'} as CitationActivationState<T>
}
function TaskCitationContent({sessionId,address,port,visible}:{sessionId:string;address:string;port:RetrievalCitationPort;visible:boolean}){
 const {t}=useI18n(),history=useSyncExternalStore(port.events.subscribe,port.events.getSnapshot)
 const read=useMemo(()=>async(signal:AbortSignal)=>{
  const request=readRetrievalSourceAddress(address)?.task
  if(!request||request.sessionId!==sessionId)throw Error('unavailable')
  return readTaskCitation(port,request,signal)
 },[address,sessionId,port,history])
 const state=useCitationSource(port,visible,read)
 if(!visible||!port.current()||state.status==='unavailable')return <p className={css.unavailable} role="status">{t('retrieval.citation.unavailable')}</p>
 if(state.status!=='ready')return <p className={css.unavailable} role="status">{t('retrieval.citation.loading')}</p>
 const source=state.value
 return <article className={css.source} aria-label={t('retrieval.citation.original')}><header><h2>{source.title}</h2><span>{t('retrieval.citation.version',{version:source.resourceVersion})}</span></header><p className={css.caption}>{t('retrieval.citation.snapshot')}</p><pre>{source.text}</pre></article>
}
function RetrievalExcerptContent({sessionId,address,port,visible}:{sessionId:string;address:string;port:RetrievalCitationPort;visible:boolean}){
 const {t}=useI18n(),history=useSyncExternalStore(port.events.subscribe,port.events.getSnapshot)
 const target=useMemo(()=>{const route=readRetrievalSourceAddress(address);return route?.sessionId===sessionId&&port.sessionId===sessionId?resolveRetrievalCitation(history.entries,sessionId,route.path):undefined},[history,sessionId,address,port])
 const read=useMemo(()=>async(signal:AbortSignal)=>{
  if(!target||!await port.available(target.resourceId,target.resourceVersion,target.sourceVersion))throw Error('unavailable')
  signal.throwIfAborted()
  const route=readRetrievalSourceAddress(address),current=route?resolveRetrievalCitation(port.events.getSnapshot().entries,sessionId,route.path):undefined
  if(!current||JSON.stringify(current)!==JSON.stringify(target))throw Error('unavailable')
  return current
 },[target,port,address,sessionId])
 const state=useCitationSource(port,visible,read)
 if(!visible||!target||!port.current()||state.status==='unavailable')return <p className={css.unavailable} role="status">{t('retrieval.citation.unavailable')}</p>
 if(state.status!=='ready')return <p className={css.unavailable} role="status">{t('retrieval.citation.loading')}</p>
 return <article className={css.source} aria-label={t('retrieval.citation.original')}><header><h2>{target.title}</h2><span>{t('retrieval.citation.version',{version:target.resourceVersion})}</span></header><p className={css.caption}>{t('retrieval.citation.snapshot')}</p>{target.excerpts.map(excerpt=><section key={excerpt.chars.join('-')}><header>{excerpt.heading&&<strong>{excerpt.heading}</strong>}<span>{t('retrieval.citation.lines',{start:excerpt.lines[0]+1,end:excerpt.lines[1]+1})}</span></header><pre>{excerpt.text}</pre></section>)}</article>
}
