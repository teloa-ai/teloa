import {ToolbarIconButton} from './ToolbarIconButton.js'
import {RefreshCw} from 'lucide-react'
import {useEffect,useRef,useState} from 'react'
import {roleKnowledgeMaxReferences,type EmployeeKnowledgeDocument as EmployeeDocument,type WorkResource} from '@teloa/contract'
import type {LocalRetrievalApi} from './local-retrieval-api.js'
import {useRetrievalSnapshot} from './use-retrieval-snapshot.js'
import type {ResourceApi} from './resource-api.js'
import css from './HomeResourcePicker.module.css'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {oversizedResources} from './resource-full-text.js'
import {useBusinessScopes} from './business-scope-context.js'
import {EmployeeKnowledgeDocument} from './EmployeeKnowledgeDocument.js'
type EmployeeRows={api:ResourceApi;roleId:string;idsKey:string;documents:EmployeeDocument[];loading:boolean;ready:boolean;pending:boolean;error?:string}
const importPending=(error:unknown)=>!!error&&typeof error==='object'&&'details'in error&&!!error.details&&typeof error.details==='object'&&'reason'in error.details&&error.details.reason==='employee-knowledge-import-pending'

export function RoleKnowledge({api,ids,scopes,change,compact=false,retrieval,openRetrieval,role}:{api:ResourceApi;ids:readonly string[];scopes:readonly string[];change?:(ids:string[])=>void;compact?:boolean;retrieval?:LocalRetrievalApi|undefined;openRetrieval?:()=>void;role?:{id:string;name:string}|undefined}){
  const {locale,t}=useI18n()
 const scopeNames=useBusinessScopes(),scopeLabel=(row:WorkResource)=>row.scopeIds.map(scope=>scopeNames[scope]??scope).join('、')
 const [rows,setRows]=useState<WorkResource[]>(),[oversized,setOversized]=useState<Map<string,number>>(new Map()),[error,setError]=useState<string>(),[revision,setRevision]=useState(0),[loading,setLoading]=useState(true)
 const [editing,setEditing]=useState<{api:ResourceApi;roleId:string;resourceId:string}>(),[employeeRows,setEmployeeRows]=useState<EmployeeRows>()
 const roleId=role?.id,idsKey=JSON.stringify(ids),employee=roleId?api.employeeKnowledge:undefined,identity=useRef({api,roleId});identity.current={api,roleId}
 const effective=employeeRows?.api===api&&employeeRows.roleId===roleId&&employeeRows.idsKey===idsKey?employeeRows:undefined
 const employeeLoading=!!employee&&(!effective||effective.loading),documents=effective?.documents??[]
 // 来源目录读不到时不置灰，保存时宿主仍会按同一上限拒绝。
 useEffect(()=>{let live=true;setLoading(true);setError(undefined);void Promise.all([api.directory(),api.sources().catch(()=>[])]).then(([directory,sources])=>{if(live){setRows(directory.resources);setOversized(oversizedResources(directory.resources,sources))}},e=>{if(live)setError(localizeWorkError(locale,e))}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[api,revision])
 useEffect(()=>{
  if(!employee||!roleId){setEmployeeRows(undefined);return}
  let live=true
  setEmployeeRows(previous=>({api,roleId,idsKey,documents:previous?.api===api&&previous.roleId===roleId?previous.documents:[],loading:true,ready:false,pending:false}))
  void Promise.allSettled([employee.list(roleId),employee.list(roleId,{requireReady:true})]).then(([listed,strict])=>{
   if(!live)return
   const current=strict.status==='fulfilled'?strict.value:listed.status==='fulfilled'?listed.value:[]
   if(current.some(row=>row.roleId!==roleId)){setEmployeeRows({api,roleId,idsKey,documents:[],loading:false,ready:false,pending:false,error:localizeWorkError(locale,{code:'teloa/invalid-host-response'})});return}
   const pending=strict.status==='rejected'&&importPending(strict.reason),failure=listed.status==='rejected'&&strict.status==='rejected'?listed.reason:strict.status==='rejected'&&!pending?strict.reason:undefined
   setEmployeeRows({api,roleId,idsKey,documents:current,loading:false,ready:strict.status==='fulfilled',pending,...(failure?{error:localizeWorkError(locale,failure)}:{})})
  })
  return()=>{live=false}
 },[api,employee,roleId,idsKey,revision,locale])
 const available=(row:WorkResource)=>row.status==='active'&&row.scopeIds.every(scope=>scopes.includes(scope))
 const editingId=editing?.api===api&&editing.roleId===roleId&&ids.includes(editing.resourceId)?editing.resourceId:undefined,editingDocument=documents.find(row=>row.resourceId===editingId),editingResource=editingDocument?{...editingDocument.resource,id:editingDocument.resourceId}:undefined
 if(editingResource&&role&&employee)return <EmployeeKnowledgeDocument key={role.id+':'+editingResource.id} api={employee} role={role} resource={editingResource} onClose={()=>{setEditing(undefined);setRevision(value=>value+1)}} onPublished={value=>{if(identity.current.api!==api||identity.current.roleId!==roleId)return;setEmployeeRows(previous=>previous?.api===api&&previous.roleId===roleId?{...previous,documents:previous.documents.map(row=>row.resourceId===value.document.resourceId?value.document:row)}:previous)}}/>
 const retrievalResources=employee?documents.filter(row=>ids.includes(row.resourceId)).map(row=>row.resource):undefined
 return <section className={css.picker} data-compact={compact||undefined} aria-label={t('knowledge.rolePicker')}>{(!compact||!!employee)&&<div className={css.heading}>{!compact?<strong>{t('knowledge.rolePicker')}</strong>:<span/>}<ToolbarIconButton label={t('knowledge.refresh')} icon={RefreshCw} disabled={loading||employeeLoading} onClick={()=>setRevision(n=>n+1)}/></div>}{!compact&&<p className={css.notice}>{t('knowledge.role.notice')}</p>}{(effective?.error||!employee&&error)&&<p role="alert" className={css.error}>{effective?.error??error}</p>}{(employee?employeeLoading:loading)&&<p role="status">{t('knowledge.role.loading')}</p>}{effective?.pending&&<p className={css.notice} role="status">{t('employeeKnowledge.importPending')}</p>}
 <ul className={css.selected}>{ids.map(id=>{const document=employee?documents.find(item=>item.resourceId===id):undefined,row=document?.resource??(!employee?rows?.find(item=>item.id===id):undefined),fallback=rows?.find(item=>item.id===id),removed=!!employee&&!!effective&&!effective.loading&&!effective.error&&!document,name=document?.title??row?.title??(removed?fallback?.title:undefined)??t((employee?employeeLoading:loading)?'knowledge.role.loading':'knowledge.role.missing'),status=removed?t('employeeKnowledge.removed'):document?`${t('employeeKnowledge.current',{version:document.bodyVersion})} · ${scopeLabel(document.resource)} · ${t('employeeKnowledge.index.'+document.indexState as Parameters<typeof t>[0])}`:row?`${t('knowledge.version')} ${row.version} · ${scopeLabel(row)}${row.status==='withdrawn'?t('knowledge.role.withdrawn'):!available(row)?t('knowledge.role.outOfScope'):''}`:t((employee?employeeLoading:loading)?'knowledge.role.loading':'knowledge.role.missing');return <li key={id} data-resource-id={id} data-effective-resource-id={document?.resource.id}><span className={css.resourceCopy}><strong>{name}</strong><small>{status}</small></span>{role&&employee&&document&&available(document.resource)&&<button type="button" disabled={employeeLoading||!effective?.ready} aria-label={t('employeeKnowledge.edit')+' · '+name} onClick={()=>setEditing({api,roleId:role.id,resourceId:id})}>{t('employeeKnowledge.edit')}</button>}{change&&<button type="button" onClick={()=>change(ids.filter(item=>item!==id))} aria-label={t('knowledge.role.removeAria',{name})}>{t('knowledge.remove')}</button>}</li>})}</ul>
 {(employee?retrievalResources!.length>0:ids.length>0)&&retrieval&&<RoleKnowledgeRetrieval api={retrieval} ids={retrievalResources?.map(row=>row.id)??ids} resources={retrievalResources} open={openRetrieval}/>}
 {!ids.length&&<p className={css.muted}>{t('knowledge.role.empty')}</p>}
 {change&&rows&&<div className={css.directory} aria-label={t('knowledge.role.availableAria')}>{rows.filter(available).map(row=><div className={css.resource} key={row.id}><span className={css.resourceCopy}><strong>{row.title}</strong><small>{t('knowledge.version')} {row.version} · {scopeLabel(row)}{oversized.has(row.id)?' · '+t('knowledge.fullTextTooLarge',{size:oversized.get(row.id)!}):''}</small></span><button type="button" disabled={loading||ids.includes(row.id)||ids.length>=roleKnowledgeMaxReferences||oversized.has(row.id)} title={oversized.has(row.id)?t('knowledge.fullTextTooLarge',{size:oversized.get(row.id)!}):ids.length>=roleKnowledgeMaxReferences?t('knowledge.role.limit',{count:roleKnowledgeMaxReferences}):undefined} onClick={()=>change([...ids,row.id])}>{ids.includes(row.id)?t('knowledge.role.selected'):t('knowledge.select')}</button></div>)}{!rows.some(available)&&<p className={css.muted}>{t('knowledge.role.noneAvailable')}</p>}</div>}
 </section>
}

/** 员工资料绑定不等于加入检索；只展示真实索引回执，不暗中下载或创建索引。 */
function RoleKnowledgeRetrieval({api,ids,resources,open}:{api:LocalRetrievalApi;ids:readonly string[];resources?:readonly WorkResource[]|undefined;open?:(()=>void)|undefined}){
 const {locale,t}=useI18n(),snapshot=useRetrievalSnapshot(signal=>api.status(signal),api,true)
 const ready=ids.filter(id=>snapshot.value?.items.some(row=>row.resourceId===id&&row.state==='ready'&&(!resources||resources.some(resource=>resource.id===id&&resource.sourceId===row.sourceId&&resource.version===row.version)))).length
 return <div><p role="status">{snapshot.error?localizeWorkError(locale,snapshot.error):snapshot.value?t('roleDelegation.retrievalReadiness',{ready,total:ids.length}):t('roleDelegation.retrievalChecking')}</p>{snapshot.value&&ready<ids.length&&<p>{t('roleDelegation.retrievalNext')}</p>}{open&&<button type="button" onClick={open}>{t('roleDelegation.openRetrieval')}</button>}</div>
}
