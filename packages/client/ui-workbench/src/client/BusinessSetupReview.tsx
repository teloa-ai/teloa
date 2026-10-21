import {useEffect,useMemo,useRef,useState} from 'react'
import type {BusinessBuilderApi} from './business-builder-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'

export type BusinessSetupReviewItem=Awaited<ReturnType<BusinessBuilderApi['setupPlans']>>['items'][number]
/** 定义及员工方案复核沿原搭建会话；与记录写入变更集分别读取。 */
export function BusinessSetupReview({api,scope,open,adjust}:{api:BusinessBuilderApi;scope:string;open:(item:BusinessSetupReviewItem,current:()=>boolean)=>Promise<void>;adjust:()=>void}){
 const {t,locale}=useI18n(),origin=useMemo(()=>({}),[api,scope]),live=useRef(origin),mounted=useRef(false);live.current=origin
 const [read,setRead]=useState<{origin:object;items:BusinessSetupReviewItem[]}>(),[error,setError]=useState(''),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false)
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 useEffect(()=>{
  const abort=new AbortController();setError('');setBusy(false)
  void api.setupPlans({scope},abort.signal).then(value=>{if(!abort.signal.aborted&&live.current===origin)setRead({origin,items:value.items})},error=>{if(!abort.signal.aborted&&live.current===origin)setError(localizeWorkError(locale,error))})
  return()=>abort.abort()
 },[api,scope,origin,revision,locale])
 const items=read?.origin===origin?read.items:undefined
 const inspect=async(item:BusinessSetupReviewItem)=>{
  if(busy)return
  const current=()=>mounted.current&&live.current===origin
  setBusy(true);setError('')
  try{await open(item,current)}catch(error){if(current())setError(localizeWorkError(locale,error))}finally{if(current())setBusy(false)}
 }
 return <section aria-label={t('business.more.changes')}>
  {error&&<p role="alert">{error} <button type="button" onClick={()=>setRevision(value=>value+1)}>{t('common.retry')}</button></p>}
  {!items&&!error&&<p role="status">{t('business.builder.loading')}</p>}
  {items&&(!items.length?<><p>{t('business.more.noSetupChanges')}</p><button type="button" onClick={adjust}>{t('business.more.openBuilder')}</button></>:<><p>{t('business.more.setupChangesNote')}</p><ul>{items.map(item=><li key={item.draftId}><strong>{item.title}</strong> <button type="button" disabled={busy} onClick={()=>void inspect(item)}>{t('business.plan.review')}</button></li>)}</ul></>)}
 </section>
}
