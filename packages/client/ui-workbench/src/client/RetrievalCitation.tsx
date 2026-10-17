import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {SidebarRightTabDefinition} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import {openRetrievalCitation,readRetrievalSourceAddress,resolveRetrievalCitation,retainRetrievalCitationNavigation,retrievalCitationTabId,retrievalCitationTabKind,retrievalTurnCitations,type RetrievalCitationPort} from './retrieval-citations.js'
import {useI18n} from './i18n/provider.js'
import css from './RetrievalCitation.module.css'

export function retrievalCitationTabDefinition(label:(address:string)=>string):SidebarRightTabDefinition{
 return {id:retrievalCitationTabId,kind:retrievalCitationTabKind,patterns:['dsh-resource://teloa-source/**'],canOpen:address=>!!readRetrievalSourceAddress(address),title:label}
}
/** 只列真实工具命中的简短来源标签，点击复用同一原生页签。 */
export function RetrievalSourceLinks({turn,port}:PropsRuntime<'conversation.chat.turnTail'>&{port:RetrievalCitationPort}){
 const {t}=useI18n(),history=useSyncExternalStore(port.events.subscribe,port.events.getSnapshot),[failed,setFailed]=useState(false)
 const anchor=useRef<HTMLSpanElement>(null)
 useEffect(()=>{const container=anchor.current?.closest<HTMLElement>('[data-chat-flow]');return container?retainRetrievalCitationNavigation(container,port):undefined},[port])
 const rows=turn.status==='closed'?retrievalTurnCitations(history.entries,port.sessionId,turn.turn):[]
 return <><span ref={anchor} hidden/>{rows.length>0&&port.current()&&<section className={css.links} aria-label={t('retrieval.citation.sources')}><span>{t('retrieval.citation.sources')}</span>{rows.map(({path,reference})=><button type="button" key={path} onClick={()=>{setFailed(false);void openRetrievalCitation(port,path).catch(()=>{if(port.current())setFailed(true)})}}>{reference.title}<small>v{reference.resourceVersion}</small></button>)}{failed&&<span role="status">{t('retrieval.citation.unavailable')}</span>}</section>}</>
}
export function RetrievalCitationTab({sessionId,useTabInfo,port}:PropsRuntime<'sidebar.right.pane.tab'>&{port:RetrievalCitationPort}){
 const info=useTabInfo()
 return <RetrievalCitationContent sessionId={sessionId} address={info.tab.navigation.address} port={port}/>
}
export function RetrievalCitationContent({sessionId,address,port}:{sessionId:string;address:string;port:RetrievalCitationPort}){
 const {t}=useI18n(),history=useSyncExternalStore(port.events.subscribe,port.events.getSnapshot),[available,setAvailable]=useState<boolean|null>(null)
 const target=useMemo(()=>{const route=readRetrievalSourceAddress(address);return route?.sessionId===sessionId&&port.sessionId===sessionId?resolveRetrievalCitation(history.entries,sessionId,route.path):undefined},[history,sessionId,address,port])
 useEffect(()=>{let live=true;setAvailable(null)
  if(target&&port.current())void port.available(target.resourceId).then(ok=>{if(live)setAvailable(ok&&port.current())},()=>{if(live)setAvailable(false)});else setAvailable(false)
  return ()=>{live=false}
 },[target,port])
 if(!target||available===false||!port.current())return <p className={css.unavailable} role="status">{t('retrieval.citation.unavailable')}</p>
 if(available===null)return <p className={css.unavailable} role="status">{t('retrieval.citation.loading')}</p>
 return <article className={css.source} aria-label={t('retrieval.citation.original')}><header><h2>{target.title}</h2><span>{t('retrieval.citation.version',{version:target.resourceVersion})}</span></header><p className={css.caption}>{t('retrieval.citation.snapshot')}</p>{target.excerpts.map(excerpt=><section key={excerpt.chars.join('-')}><header>{excerpt.heading&&<strong>{excerpt.heading}</strong>}<span>{t('retrieval.citation.lines',{start:excerpt.lines[0]+1,end:excerpt.lines[1]+1})}</span></header><pre>{excerpt.text}</pre></section>)}</article>
}
