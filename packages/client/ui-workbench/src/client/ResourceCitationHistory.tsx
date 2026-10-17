import {useEffect,useRef,useState} from 'react'
import {BookOpen,ChevronRight} from 'lucide-react'
import type {ResourceHistoryPage} from '@teloa/contract'
import type {ResourceApi} from './resource-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ResourceCitationHistory.module.css'

/** 原会话的已发生引用事实，收进工作概览；安装清单和当前最新版不能代替它。 */
type Props={sessionId:string;api:Pick<ResourceApi,'history'>;revision:string}
export function ResourceCitationHistory(props:Props){return <BoundCitationHistory key={props.sessionId} {...props}/>}
function BoundCitationHistory({sessionId,api,revision}:Props){
 const {locale,t}=useI18n(),[open,setOpen]=useState(false),[page,setPage]=useState<ResourceHistoryPage>(),[loading,setLoading]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0)
 const request=useRef<AbortController>(),generation=useRef(0)
 const copy=(cn:string,hant:string,en:string)=>locale.startsWith('zh')?(locale.includes('TW')||locale.includes('HK')?hant:cn):en
 const read=async(beforeSeq?:number)=>{
  request.current?.abort();const controller=new AbortController(),token=++generation.current;request.current=controller;setLoading(true);setError('')
  try{
   const value=await api.history(sessionId,beforeSeq,controller.signal)
   if(value.sessionId!==sessionId)throw Object.assign(Error(),{code:'teloa/source-unavailable'})
   if(!controller.signal.aborted&&token===generation.current)setPage(previous=>beforeSeq===undefined||!previous?value:{...value,items:[...previous.items,...value.items.filter(item=>!previous.items.some(old=>old.messageId===item.messageId))]})
  }catch(cause){if(!controller.signal.aborted&&token===generation.current)setError(localizeWorkError(locale,cause))}
  finally{if(!controller.signal.aborted&&token===generation.current)setLoading(false)}
 }
 useEffect(()=>{if(open)void read();return()=>{generation.current++;request.current?.abort()}},[sessionId,api,revision,open,retry])
 // 无引用的普通轮次不占据一张卡；异常记录仍保留，不伪装成没有使用资料。
 const records=page?.items.filter(item=>item.references.length>0||item.issue)??[]
 return <details className={css.root} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary><ChevronRight size={13}/><BookOpen size={14}/>{copy('资料来源','資料來源','Source materials')}{page&&!loading&&<span>{records.reduce((count,item)=>count+item.references.length,0)}</span>}</summary>
  <div className={css.body} aria-busy={loading}>
   <p className={css.hint}>{copy('查看本会话实际使用的资料与固定版本。','查看本對話實際使用的資料與固定版本。','Materials and fixed versions actually used in this conversation.')}</p>
   {loading&&<p role="status">{t('knowledge.ui.085')}</p>}
   {error&&<p role="alert">{error}<button type="button" onClick={()=>setRetry(value=>value+1)}>{t('common.retry')}</button></p>}
   {!loading&&!error&&page&&records.length===0&&<p>{t('knowledge.ui.086')}</p>}
   {records.map(item=><div className={css.record} key={item.messageId}>
    <header><span>{item.turn===null?t('knowledge.ui.089'):t('knowledge.ui.090')+item.turn+t('knowledge.ui.091')}</span><time dateTime={item.at}>{new Date(item.at).toLocaleString(locale)}</time></header>
    {item.issue&&<p role="alert">{item.issue}</p>}
    {item.references.map(ref=><div key={ref.id+'@'+ref.version} className={css.reference}>
     <strong>{ref.metadata?.title||t('knowledge.ui.092')}</strong><span>{t('knowledge.ui.093')}{ref.version}{!ref.metadata&&' · '+t('knowledge.ui.095')}</span>
     <details><summary>{t('knowledge.ui.096')}</summary><dl><dt>{t('knowledge.ui.097')}</dt><dd>{ref.id}</dd>{ref.metadata&&<><dt>{t('knowledge.ui.027')}</dt><dd>{ref.metadata.sourceId}</dd><dt>{t('knowledge.ui.098')}</dt><dd>{ref.metadata.sourceVersion}</dd></>}<dt>{t('knowledge.ui.101')}</dt><dd>{item.messageId}</dd></dl></details>
    </div>)}
   </div>)}
   {page?.nextBeforeSeq!=null&&<button type="button" disabled={loading} onClick={()=>void read(page.nextBeforeSeq!)}>{t('knowledge.ui.102')}</button>}
  </div>
 </details>
}
