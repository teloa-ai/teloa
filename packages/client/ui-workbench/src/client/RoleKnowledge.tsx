import {ToolbarIconButton} from './ToolbarIconButton.js'
import {RefreshCw} from 'lucide-react'
import {useEffect,useState} from 'react'
import {roleKnowledgeMaxReferences,type WorkResource} from '@teloa/contract'
import type {LocalRetrievalApi} from './local-retrieval-api.js'
import {useRetrievalSnapshot} from './use-retrieval-snapshot.js'
import type {ResourceApi} from './resource-api.js'
import css from './HomeResourcePicker.module.css'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {oversizedResources} from './resource-full-text.js'
import {useBusinessScopes} from './business-scope-context.js'

export function RoleKnowledge({api,ids,scopes,change,compact=false,retrieval,openRetrieval}:{api:ResourceApi;ids:readonly string[];scopes:readonly string[];change?:(ids:string[])=>void;compact?:boolean;retrieval?:LocalRetrievalApi|undefined;openRetrieval?:()=>void}){
  const {locale,t}=useI18n()
 const scopeNames=useBusinessScopes(),scopeLabel=(row:WorkResource)=>row.scopeIds.map(scope=>scopeNames[scope]??scope).join('、')
 const [rows,setRows]=useState<WorkResource[]>(),[oversized,setOversized]=useState<Map<string,number>>(new Map()),[error,setError]=useState<string>(),[revision,setRevision]=useState(0),[loading,setLoading]=useState(true)
 // 来源目录读不到时不置灰，保存时宿主仍会按同一上限拒绝。
 useEffect(()=>{let live=true;setLoading(true);setError(undefined);void Promise.all([api.directory(),api.sources().catch(()=>[])]).then(([directory,sources])=>{if(live){setRows(directory.resources);setOversized(oversizedResources(directory.resources,sources))}},e=>{if(live)setError(localizeWorkError(locale,e))}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[api,revision])
 const available=(row:WorkResource)=>row.status==='active'&&row.scopeIds.every(scope=>scopes.includes(scope))
 return <section className={css.picker} data-compact={compact||undefined} aria-label={t('knowledge.rolePicker')}>{!compact&&<><div className={css.heading}><strong>{t('knowledge.rolePicker')}</strong><ToolbarIconButton label={t('knowledge.refresh')} icon={RefreshCw} disabled={loading} onClick={()=>setRevision(n=>n+1)}/></div><p className={css.notice}>{t('knowledge.role.notice')}</p></>}{error&&<p role="alert" className={css.error}>{error}</p>}{loading&&<p role="status">{t('knowledge.role.loading')}</p>}
 <ul className={css.selected}>{ids.map(id=>{const row=rows?.find(item=>item.id===id),name=row?.title??(loading?t('knowledge.role.loading'):t('knowledge.role.missing')),status=row?`${t('knowledge.version')} ${row.version} · ${scopeLabel(row)}${row.status==='withdrawn'?t('knowledge.role.withdrawn'):!available(row)?t('knowledge.role.outOfScope'):''}`:t(loading?'knowledge.role.loading':'knowledge.role.missing');return <li key={id}><span className={css.resourceCopy}><strong>{name}</strong><small>{status}</small></span>{change&&<button type="button" onClick={()=>change(ids.filter(item=>item!==id))} aria-label={t('knowledge.role.removeAria',{name})}>{t('knowledge.remove')}</button>}</li>})}</ul>
 {ids.length>0&&retrieval&&<RoleKnowledgeRetrieval api={retrieval} ids={ids} open={openRetrieval}/>}
 {!ids.length&&<p className={css.muted}>{t('knowledge.role.empty')}</p>}
 {change&&rows&&<div className={css.directory} aria-label={t('knowledge.role.availableAria')}>{rows.filter(available).map(row=><div className={css.resource} key={row.id}><span className={css.resourceCopy}><strong>{row.title}</strong><small>{t('knowledge.version')} {row.version} · {scopeLabel(row)}{oversized.has(row.id)?' · '+t('knowledge.fullTextTooLarge',{size:oversized.get(row.id)!}):''}</small></span><button type="button" disabled={loading||ids.includes(row.id)||ids.length>=roleKnowledgeMaxReferences||oversized.has(row.id)} title={oversized.has(row.id)?t('knowledge.fullTextTooLarge',{size:oversized.get(row.id)!}):ids.length>=roleKnowledgeMaxReferences?t('knowledge.role.limit',{count:roleKnowledgeMaxReferences}):undefined} onClick={()=>change([...ids,row.id])}>{ids.includes(row.id)?t('knowledge.role.selected'):t('knowledge.select')}</button></div>)}{!rows.some(available)&&<p className={css.muted}>{t('knowledge.role.noneAvailable')}</p>}</div>}
 </section>
}

/** 员工资料绑定不等于加入检索；只展示真实索引回执，不暗中下载或创建索引。 */
function RoleKnowledgeRetrieval({api,ids,open}:{api:LocalRetrievalApi;ids:readonly string[];open?:(()=>void)|undefined}){
 const {locale,t}=useI18n(),snapshot=useRetrievalSnapshot(signal=>api.status(signal),api,true)
 const ready=ids.filter(id=>snapshot.value?.items.some(row=>row.resourceId===id&&row.state==='ready')).length
 return <div><p role="status">{snapshot.error?localizeWorkError(locale,snapshot.error):snapshot.value?t('roleDelegation.retrievalReadiness',{ready,total:ids.length}):t('roleDelegation.retrievalChecking')}</p>{snapshot.value&&ready<ids.length&&<p>{t('roleDelegation.retrievalNext')}</p>}{open&&<button type="button" onClick={open}>{t('roleDelegation.openRetrieval')}</button>}</div>
}
