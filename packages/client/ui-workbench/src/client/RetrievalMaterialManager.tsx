import {useEffect,useMemo,useRef,useState} from 'react'
import {retrievalLimits,type WorkResource} from '@teloa/contract'
import {ContextDrawer} from './ContextDrawer.js'
import {useCollectionWindow} from './collection-window.js'
import {useI18n} from './i18n/provider.js'
import {formatDateTime} from './i18n/format.js'
import type {RetrievalStatus} from './local-retrieval-api.js'
import css from './LocalRetrieval.module.css'

type Material={sourceId:string;title:string;resources:Set<string>;enrolled:boolean;available:boolean;contexts:Set<string>;updatedAt?:string;state?:RetrievalStatus['items'][number]['state']}
/** 加入及移出都按来源生效，同来源多个资料只提交一次。 */
export function RetrievalMaterialManager({resources,resourceContext,status,busy,error,readOnly,modelReady,close,apply}:{resources:readonly WorkResource[];resourceContext?:ReadonlyMap<string,string>|undefined;status:RetrievalStatus;busy:boolean;error:string;readOnly:boolean;modelReady:boolean;close:()=>void;apply:(action:'enroll'|'remove',sourceIds:string[])=>Promise<boolean>}){
 const {locale,t}=useI18n(),search=useRef<HTMLInputElement>(null),master=useRef<HTMLInputElement>(null),pending=useRef(false)
 const [query,setQuery]=useState(''),[selected,setSelected]=useState<Set<string>>(()=>new Set()),[working,setWorking]=useState(false),[notice,setNotice]=useState('')
 const rows=useMemo(()=>{
  const sources=new Map<string,Material>()
  for(const resource of resources){if(resource.status!=='active')continue;let row=sources.get(resource.sourceId);if(!row){row={sourceId:resource.sourceId,title:resource.title,resources:new Set(),enrolled:false,available:true,contexts:new Set()};sources.set(resource.sourceId,row)}row.resources.add(resource.id);row.contexts.add(resourceContext?.get(resource.id)??'v'+resource.version);if(!row.updatedAt||resource.updatedAt>row.updatedAt)row.updatedAt=resource.updatedAt}
  for(const item of status.items){let row=sources.get(item.sourceId);if(!row){row={sourceId:item.sourceId,title:item.title??t('retrieval.manage.unavailable',{index:sources.size+1}),resources:new Set(),enrolled:true,available:false,contexts:new Set()};sources.set(item.sourceId,row)}row.enrolled=true;row.state=item.state;if(item.resourceId)row.resources.add(item.resourceId)}
  return [...sources.values()].sort((a,b)=>a.title.localeCompare(b.title)||(a.updatedAt??'').localeCompare(b.updatedAt??'')||a.sourceId.localeCompare(b.sourceId))
 },[resources,resourceContext,status,t])
 const labels=useMemo(()=>{
  const counts=new Map<string,number>();for(const row of rows)counts.set(row.title,(counts.get(row.title)??0)+1)
  return new Map(rows.map(row=>{const duplicate=(counts.get(row.title)??0)>1,context=[...row.contexts,...(duplicate&&row.updatedAt?[t('retrieval.manage.updated',{time:formatDateTime(locale,row.updatedAt,{dateStyle:'short',timeStyle:'short'})})]:[])].join(' · ');return [row.sourceId,{context,choice:duplicate?[row.title,context].filter(Boolean).join(' · '):row.title}]}))
 },[rows,locale,t])
 const context=(row:Material)=>labels.get(row.sourceId)!.context,choiceTitle=(row:Material)=>labels.get(row.sourceId)!.choice
 const identity=JSON.stringify(rows.map(row=>row.sourceId))
 useEffect(()=>{const available=new Set(rows.map(row=>row.sourceId));setSelected(current=>new Set([...current].filter(id=>available.has(id))))},[identity])
 const filtered=rows.filter(row=>[row.title,...row.contexts].some(value=>value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))),page=useCollectionWindow(filtered,row=>row.sourceId)
 const chosen=rows.filter(row=>selected.has(row.sourceId)),toEnroll=chosen.filter(row=>!row.enrolled&&row.available),toRemove=chosen.filter(row=>row.enrolled)
 const shownSelected=filtered.filter(row=>selected.has(row.sourceId)).length,all=!!filtered.length&&shownSelected===filtered.length,hidden=chosen.length-shownSelected
 const limit=toEnroll.length+status.enrolled>retrievalLimits.maxEnrollments,locked=busy||working||readOnly
 useEffect(()=>{if(master.current)master.current.indeterminate=shownSelected>0&&!all},[shownSelected,all])
 const toggle=(id:string,checked:boolean)=>{setNotice('');setSelected(current=>{const next=new Set(current);if(checked)next.add(id);else next.delete(id);return next})}
 const submit=async(action:'enroll'|'remove')=>{
  const ids=(action==='enroll'?toEnroll:toRemove).map(row=>row.sourceId)
  if(pending.current||locked||!ids.length||action==='enroll'&&(!modelReady||limit))return
  pending.current=true;setWorking(true);setNotice('')
  try{if(await apply(action,ids)){setSelected(current=>new Set([...current].filter(id=>!ids.includes(id))));setNotice(t(action==='enroll'?'retrieval.manage.enrolled':'retrieval.manage.removed',{count:ids.length}))}}
  finally{pending.current=false;setWorking(false)}
 }
 return <ContextDrawer title={t('retrieval.manage.title')} close={close} initialFocus={search} canClose={!busy&&!working}>
  <div className={css.bulkManager}>
   <p className={css.bulkHint}>{t('retrieval.manage.boundary')}</p>
   <label className={css.bulkSearch}>{t('retrieval.manage.search')}<input ref={search} type="search" value={query} disabled={locked} onChange={event=>setQuery(event.target.value)}/></label>
   <div className={css.bulkSelection}><label><input ref={master} type="checkbox" checked={all} disabled={locked||!filtered.length} onChange={event=>{const checked=event.target.checked;setNotice('');setSelected(current=>{const next=new Set(current);for(const row of filtered)if(checked)next.add(row.sourceId);else next.delete(row.sourceId);return next})}}/>{t('retrieval.manage.all',{count:filtered.length})}</label>{!!chosen.length&&<button type="button" disabled={locked} onClick={()=>{setSelected(new Set());setNotice('')}}>{t('retrieval.manage.clear')}</button>}</div>
   <ul className={css.bulkRows} aria-label={t('retrieval.manage.materials')}>
    {page.items.map(row=><li key={row.sourceId}><label className={css.bulkChoice}><input type="checkbox" aria-label={t('retrieval.manage.choose',{title:choiceTitle(row)})} checked={selected.has(row.sourceId)} disabled={locked} onChange={event=>toggle(row.sourceId,event.target.checked)}/><span><strong>{row.title}</strong>{context(row)&&<small>{context(row)}</small>}<small>{row.enrolled?t('retrieval.resources.enrolled')+(row.state?' · '+t('retrieval.index.'+row.state):''):t('retrieval.index.excluded')}{row.resources.size>1?' · '+t('retrieval.manage.sameSource',{count:row.resources.size}):''}</small></span></label></li>)}
   </ul>
   {!filtered.length&&<p>{t('retrieval.manage.empty')}</p>}
   {page.more&&<button type="button" className={css.button} disabled={locked} onClick={page.showMore}>{t('retrieval.manage.more',{shown:page.shown,total:page.total})}</button>}
   <footer className={css.bulkFooter}>
    <p role="status">{notice||t('retrieval.manage.selected',{count:chosen.length})}{hidden>0?' · '+t('retrieval.manage.hidden',{count:hidden}):''}</p>
    {error&&<p role="alert" className={css.error}>{error}</p>}
    {limit&&<p>{t('retrieval.manage.limit',{count:retrievalLimits.maxEnrollments})}</p>}
    {!modelReady&&!!toEnroll.length&&<p>{t('retrieval.trial.notReady')}</p>}
    <div><button type="button" className={css.button} disabled={locked||!toRemove.length} onClick={()=>void submit('remove')}>{t('retrieval.manage.remove',{count:toRemove.length})}</button><button type="button" className={css.primary} disabled={locked||!toEnroll.length||!modelReady||limit} onClick={()=>void submit('enroll')}>{t(working?'retrieval.resources.working':'retrieval.manage.enroll',working?{}:{count:toEnroll.length})}</button></div>
   </footer>
  </div>
 </ContextDrawer>
}
