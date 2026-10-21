import {useEffect,useRef,useState} from 'react'
import type {BusinessSetupHistory} from '@teloa/contract'
import type {BusinessBuilderApi} from './business-builder-api.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessSetupManualEditor.module.css'

/** 只读正式配置版本；回到旧版须由宿主打开新草案，随后复核/采用成新版本。 */
export function BusinessSetupHistoryPanel({api,scope,onRestore,current}:{api:BusinessBuilderApi;scope:string;onRestore:(version:number,hash:string)=>Promise<void>;current?:()=>boolean}){
 const {t}=useI18n(),[history,setHistory]=useState<BusinessSetupHistory>(),[busy,setBusy]=useState(false),[error,setError]=useState(false),epoch=useRef(0),flight=useRef(false)
 const load=async(beforeVersion?:number)=>{if(flight.current)return;const generation=epoch.current;flight.current=true;setBusy(true);setError(false);try{const next=await api.setupHistory({scope,...(beforeVersion?{beforeVersion}:{})});if(generation===epoch.current&&current?.()!==false)setHistory(previous=>beforeVersion&&previous?{...next,items:[...previous.items,...next.items]}:next)}catch{if(generation===epoch.current&&current?.()!==false)setError(true)}finally{if(generation===epoch.current){flight.current=false;setBusy(false)}}}
 useEffect(()=>{const generation=++epoch.current;flight.current=false;setHistory(undefined);void load();return()=>{if(epoch.current===generation)epoch.current++}},[api,scope])
 const restore=async(version:number,hash:string)=>{if(flight.current||current?.()===false)return;const generation=epoch.current;flight.current=true;setBusy(true);setError(false);try{await onRestore(version,hash)}catch{if(generation===epoch.current&&current?.()!==false)setError(true)}finally{if(generation===epoch.current){flight.current=false;setBusy(false)}}}
 return <section className={css.editor} aria-label={t('business.history.title')}><h3>{t('business.history.title')}</h3><p>{t('business.history.note')}</p>{error&&<p role="alert">{t('business.manual.error')}</p>}{!history&&<button disabled={busy} onClick={()=>void load()}>{t('business.manual.reload')}</button>}
  {history?.items.map(row=><div key={row.version} className={css.item}><strong>{row.title} · v{row.version}</strong><p>{new Date(row.createdAt).toLocaleString()} · {t('business.history.pages',{count:row.pages})}</p>{row.version===history.currentVersion?<span>{t('business.history.current')}</span>:<button disabled={busy} onClick={()=>void restore(row.version,row.hash)}>{t('business.history.restore')}</button>}</div>)}
  {history?.beforeVersion&&<button disabled={busy} onClick={()=>void load(history.beforeVersion!)}>{t('business.history.more')}</button>}
 </section>
}
