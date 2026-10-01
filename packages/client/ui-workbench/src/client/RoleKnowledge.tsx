import {useEffect,useState} from 'react'
import type {WorkResource} from '@teloa/contract'
import type {ResourceApi} from './resource-api.js'
import css from './HomeResourcePicker.module.css'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {oversizedResources} from './resource-full-text.js'

export function RoleKnowledge({api,ids,scopes,change}:{api:ResourceApi;ids:readonly string[];scopes:readonly string[];change?:(ids:string[])=>void}){
  const {locale,t}=useI18n()
 const [rows,setRows]=useState<WorkResource[]>(),[oversized,setOversized]=useState<Map<string,number>>(new Map()),[error,setError]=useState<string>(),[revision,setRevision]=useState(0),[loading,setLoading]=useState(true)
 // 来源目录读不到时不置灰，保存时宿主仍会按同一上限拒绝。
 useEffect(()=>{let live=true;setLoading(true);setError(undefined);void Promise.all([api.directory(),api.sources().catch(()=>[])]).then(([directory,sources])=>{if(live){setRows(directory.resources);setOversized(oversizedResources(directory.resources,sources))}},e=>{if(live)setError(localizeWorkError(locale,e))}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[api,revision])
 const available=(row:WorkResource)=>row.status==='active'&&row.scopeIds.every(scope=>scopes.includes(scope))
 return <section className={css.picker} aria-label={t('knowledge.rolePicker')}><div className={css.heading}><strong>{t('knowledge.rolePicker')}</strong><button type="button" disabled={loading} onClick={()=>setRevision(n=>n+1)}>{t('knowledge.refresh')}</button></div><p className={css.notice}>{t('knowledge.role.notice')}</p>{error&&<p role="alert" className={css.error}>{error}</p>}{loading&&<p role="status">{t('knowledge.role.loading')}</p>}
 <ul className={css.selected}>{ids.map(id=>{const row=rows?.find(item=>item.id===id),name=row?.title??id,status=row?`${t('knowledge.version')} ${row.version}${row.status==='withdrawn'?t('knowledge.role.withdrawn'):!available(row)?t('knowledge.role.outOfScope'):''}`:t('knowledge.role.missing');return <li key={id}><span className={css.resourceCopy}><strong>{name}</strong><small>{status}</small></span>{change&&<button type="button" onClick={()=>change(ids.filter(item=>item!==id))} aria-label={t('knowledge.role.removeAria',{name})}>{t('knowledge.remove')}</button>}</li>})}</ul>
 {!ids.length&&<p className={css.muted}>{t('knowledge.role.empty')}</p>}
 {change&&rows&&<div className={css.directory} aria-label={t('knowledge.role.availableAria')}>{rows.filter(available).map(row=><div className={css.resource} key={row.id}><span className={css.resourceCopy}><strong>{row.title}</strong><small>{t('knowledge.version')} {row.version}{oversized.has(row.id)?' · '+t('knowledge.fullTextTooLarge',{size:oversized.get(row.id)!}):''}</small></span><button type="button" disabled={loading||ids.includes(row.id)||ids.length>=8||oversized.has(row.id)} title={oversized.has(row.id)?t('knowledge.fullTextTooLarge',{size:oversized.get(row.id)!}):ids.length>=8?t('knowledge.role.limit'):undefined} onClick={()=>change([...ids,row.id])}>{ids.includes(row.id)?t('knowledge.role.selected'):t('knowledge.select')}</button></div>)}{!rows.some(available)&&<p className={css.muted}>{t('knowledge.role.noneAvailable')}</p>}</div>}
 </section>
}
