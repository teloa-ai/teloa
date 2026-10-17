import type {GroupMessage} from '@teloa/contract'
import type {GroupSharedResult} from './group-result-index.js'
import {useEffect,useRef,useState} from 'react'
import {ChevronRight} from 'lucide-react'
import {WorkArtifactCard} from './WorkArtifactCard.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ConversationWorkOverview.module.css'

export type GroupResultSummary={state:'loading'}|{state:'ready';title:string;files:{snapshotId:string}[]}|{state:'failed'}
export type GroupWorkResultsProps={groupId:string;rows:readonly GroupSharedResult[];summaries:Readonly<Record<string,GroupResultSummary>>;roleNames:Readonly<Record<string,string>>;openArtifact?:((id:string,version:number)=>void|Promise<void>)|undefined;openMessage:(message:GroupMessage)=>void}
/** 群身份变化重新挂载本地选择，旧 details 的迟到 toggle 不能改新群状态。 */
export function GroupWorkResults(props:GroupWorkResultsProps){return <BoundGroupWorkResults key={props.groupId} {...props}/>}
function BoundGroupWorkResults({groupId,rows,summaries,roleNames,openArtifact,openMessage}:GroupWorkResultsProps){
 const {locale,t,time}=useI18n(),[history,setHistory]=useState({groupId,open:false}),[error,setError]=useState(''),generation=useRef(0)
 useEffect(()=>{generation.current++;setHistory({groupId,open:false});setError('');return()=>{generation.current++}},[groupId])
 const current=rows.filter(row=>!row.historical),historical=rows.filter(row=>row.historical)
 const preview=(row:GroupSharedResult)=>{
  const epoch=generation.current
  void Promise.resolve().then(()=>openArtifact?.(row.reference.id,row.reference.version)).then(()=>{if(epoch===generation.current)setError('')},cause=>{if(epoch===generation.current)setError(localizeWorkError(locale,cause))})
 }
 const card=(row:GroupSharedResult)=>{
  const summary=summaries['artifact:'+row.reference.id+':'+row.reference.version],ready=summary?.state==='ready'
  const title=ready?summary.title:t(summary?.state==='failed'?'collaboration.reference.artifactUnavailable':'collaboration.state.loading')
  const author=row.message.authorId==='self'?t('collaboration.message.self'):roleNames[row.message.authorId]??t('collaboration.message.historicalMember')
  return <div key={JSON.stringify([row.reference.id,row.reference.version])}>
   <WorkArtifactCard label={title} detail={<>v{row.reference.version} · {author}</>} onPreview={ready&&openArtifact?()=>preview(row):undefined}/>
   <div className={css.workMeta}><button type="button" className={css.textButton} onClick={()=>openMessage(row.message)}>{t('collaboration.results.sourceMessage')}</button><time dateTime={row.message.createdAt}>{time(row.message.createdAt)}</time></div>
  </div>
 }
 return <section className={css.section} aria-label={t('collaboration.view.results')}>
  <h2 className={css.heading}>{t('collaboration.view.results')}{current.length>0&&<span className={css.count}>{current.length}</span>}</h2>
  {error&&<p role="alert" className={css.error}>{error}</p>}
  {current.length?<div className={css.artifacts}>{current.map(card)}</div>:<p className={css.note}>{t('collaboration.view.resultsEmpty')}</p>}
  {historical.length>0&&<details key={groupId} className={css.history} open={history.groupId===groupId&&history.open} onToggle={event=>setHistory({groupId,open:event.currentTarget.open})}><summary><ChevronRight size={13}/>{t('knowledge.ui.035')} · {historical.length}</summary><div className={css.artifacts}>{historical.map(card)}</div></details>}
 </section>
}
