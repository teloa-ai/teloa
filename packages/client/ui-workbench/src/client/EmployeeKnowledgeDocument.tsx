import {useEffect,useMemo,useRef,useState} from 'react'
import {ArrowLeft,Check,Clock3,History,Info,MoreHorizontal,RefreshCw,RotateCcw,Save} from 'lucide-react'
import type {EmployeeKnowledgeContent,EmployeeKnowledgeRevision,EmployeeKnowledgeVersion,WorkResource} from '@teloa/contract'
import type {EmployeeKnowledgeApi,EmployeeKnowledgeCommand,EmployeeKnowledgeDraft} from './employee-knowledge-api.js'
import {KnowledgeMarkdownEditor} from './KnowledgeMarkdownEditor.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './KnowledgeDocument.module.css'

/** 员工知识始终通过同一个正式写入口保存，读取页面不会创建独立副本。 */
export function EmployeeKnowledgeDocument({api,role,resource,onClose,onDirtyChange,onPublished,initialMode='write'}:{api:EmployeeKnowledgeApi;role:{id:string;name:string};resource:WorkResource;initialMode?:'write'|'preview';onClose?:()=>void;onDirtyChange?:((dirty:boolean)=>void)|undefined;onPublished?:((value:EmployeeKnowledgeRevision)=>void|Promise<void>)|undefined}){
 const {locale,t}=useI18n(),target=useMemo(()=>({roleId:role.id,resourceId:resource.id}),[role.id,resource.id])
 const journal=useMemo(()=>api.draft(resource.ownerId,target),[api,resource.ownerId,target]),generation=useRef(0)
 const [head,setHead]=useState<EmployeeKnowledgeContent>(),[selected,setSelected]=useState<EmployeeKnowledgeContent>(),[versions,setVersions]=useState<EmployeeKnowledgeVersion[]>([]),[markdown,setMarkdown]=useState(''),[baseline,setBaseline]=useState(''),[draft,setDraft]=useState<EmployeeKnowledgeDraft>(),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[conflict,setConflict]=useState(false),[blocked,setBlocked]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>(),[inspectorOpen,setInspectorOpen]=useState(false),[attempt,setAttempt]=useState(0)
 const dirty=markdown!==baseline,pending=draft?.pending,historical=!!head&&selected?.bodyVersion!==head.bodyVersion
 const current=(token:number)=>generation.current===token
 const remember=(value:EmployeeKnowledgeDraft)=>{journal.write(value);setDraft(value)}
 useEffect(()=>{onDirtyChange?.(dirty||!!pending);return()=>onDirtyChange?.(false)},[dirty,!!pending,onDirtyChange])
 useEffect(()=>{
  const token=++generation.current;setLoading(true);setBusy(false);setError(undefined);setBlocked(false);setConflict(false);setHead(undefined);setSelected(undefined);setDraft(undefined)
  void (async()=>{
   const [document,history]=await Promise.all([api.read(target),api.versions(target)])
   if(document.resource.ownerId!==resource.ownerId)throw Object.assign(Error(),{code:'teloa/invalid-host-response'})
   let saved:EmployeeKnowledgeDraft|undefined
   try{saved=journal.read()}catch{if(current(token)){setBlocked(true);setError(localizeWorkError(locale,{code:'teloa/storage-corrupt'}))}}
   const value=saved?.pending?.kind==='restore'?await api.read({...target,version:saved.pending.input.restoreVersion}):saved?.base??document
   if(!current(token))return
   setHead(document);setSelected(value);setVersions(history);setBaseline(value.markdown);setMarkdown(saved?.pending?.kind==='restore'?value.markdown:saved?.markdown??value.markdown);setDraft(saved)
   setConflict(!!saved&&!saved.pending&&(saved.base.bodyVersion!==document.bodyVersion||saved.base.contentHash!==document.contentHash))
   if(saved)setNotice(t('employeeKnowledge.draftRecovered'))
  })().catch(cause=>{if(current(token)){setBlocked(true);setError(localizeWorkError(locale,cause))}}).finally(()=>{if(current(token))setLoading(false)})
  return()=>{generation.current++}
 },[api,target,journal,resource.ownerId,attempt])
 const change=(value:string)=>{
  if(!head||!selected||busy||pending||blocked||historical&&!draft)return
  setMarkdown(value)
  if(value===baseline){if(draft)journal.clear(draft.requestId);setDraft(undefined);return}
  remember({ownerId:resource.ownerId,...target,base:draft?.base??head,markdown:value,requestId:draft?.requestId??crypto.randomUUID()})
 }
 const finish=async(value:EmployeeKnowledgeRevision,request:EmployeeKnowledgeCommand,token:number)=>{
  if(value.operation!==request.kind||value.document.resource.ownerId!==resource.ownerId||value.document.bodyVersion!==request.input.expectedBodyVersion+1||value.document.roleId!==role.id||value.document.resourceId!==resource.id)throw Object.assign(Error(),{code:'teloa/invalid-host-response'})
  if(!current(token))return
  journal.clear(request.input.requestId);setDraft(undefined);setHead(value.document);setSelected(value.document);setMarkdown(value.document.markdown);setBaseline(value.document.markdown);setConflict(false);setError(undefined);setNotice(request.kind==='restore'?t('knowledge.restoredNotice',{source:request.input.restoreVersion,version:value.document.bodyVersion}):t('knowledge.savedNotice',{version:value.document.bodyVersion}))
  try{const history=await api.versions(target);if(current(token))setVersions(history)}catch(cause){if(current(token))setError(localizeWorkError(locale,cause))}
  if(current(token))await onPublished?.(value)
 }
 const submit=async(kind:'revise'|'restore',recover=false)=>{
  if(!head||!selected||busy||blocked||conflict)return
  const existing=draft?.pending
  if(existing&&existing.kind!==kind||!existing&&(kind==='revise'?historical||!dirty||!markdown.trim():!historical||dirty))return
  const value=draft??{ownerId:resource.ownerId,...target,base:head,markdown,requestId:crypto.randomUUID()}
  const cas={requestId:value.requestId,...target,expectedBodyVersion:value.base.bodyVersion,expectedContentHash:value.base.contentHash}
  const request:EmployeeKnowledgeCommand=existing??(kind==='revise'?{kind,input:{...cas,markdown:value.markdown}}:{kind,input:{...cas,restoreVersion:selected.bodyVersion}})
  remember({...value,pending:request});setBusy(true);setError(undefined);setNotice(undefined);const token=generation.current
  let receiptAbsent=false
  try{
   const receipt=recover?await api.status(request.input.requestId,target):null
   receiptAbsent=recover&&receipt===null
   const saved=receipt??await (request.kind==='revise'?api.revise(request.input):api.restore(request.input))
   receiptAbsent=false
   await finish(saved,request,token)
  }catch(cause){
   if(current(token)){
    // 重试仅在核对无回执且原写入明确遭遇版本冲突后解锁；其余未知结果保留原命令。
    if(cause&&typeof cause==='object'&&'rejected'in cause&&cause.rejected===true&&(!recover||receiptAbsent&&'code'in cause&&cause.code==='teloa/version-conflict')){
     const {pending:_pending,...editable}=value;remember(editable)
     if('code'in cause&&['teloa/conflict','teloa/version-conflict','teloa/file-changed'].includes(String(cause.code)))setConflict(true)
    }
    setError(localizeWorkError(locale,cause))
   }
  }finally{if(current(token))setBusy(false)}
 }
 const reload=async(keepDraft=false)=>{
  if(busy||pending)return
  const token=generation.current;setBusy(true);setError(undefined)
  try{
   const [value,history]=await Promise.all([api.read(target),api.versions(target)])
   if(!current(token))return
   setHead(value);setSelected(value);setVersions(history);setBaseline(value.markdown)
   if(keepDraft&&draft){const next={...draft,base:value,requestId:crypto.randomUUID()};remember(next);setMarkdown(next.markdown)}else{setMarkdown(value.markdown);if(draft)journal.clear(draft.requestId);setDraft(undefined)}
   setConflict(false)
  }catch(cause){if(current(token))setError(localizeWorkError(locale,cause))}finally{if(current(token))setBusy(false)}
 }
 const read=async(version:number)=>{
  if(busy||dirty||pending)return
  const token=generation.current;setBusy(true);setError(undefined)
  try{const value=await api.read({...target,version});if(current(token)){setSelected(value);setBaseline(value.markdown);setMarkdown(value.markdown)}}catch(cause){if(current(token))setError(localizeWorkError(locale,cause))}finally{if(current(token))setBusy(false)}
 }
 return <section className={css.document} aria-label={t('employeeKnowledge.edit')}>
  <header className={css.documentHeader}><div className={css.titleBlock}><h2>{head?.title??resource.title}</h2><p className={css.employeeScope}>{t('employeeKnowledge.scope',{name:role.name})}</p>{dirty&&<em className={css.dirty}>{t('knowledge.ui.041')}</em>}</div><div className={css.documentActions}>
   {onClose&&<button type="button" disabled={busy} onClick={onClose}><ArrowLeft size={15}/>{t('library.back')}</button>}
   {dirty&&!pending&&<button type="button" disabled={busy} onClick={()=>{if(draft)journal.clear(draft.requestId);setDraft(undefined);setMarkdown(baseline);if(conflict)void reload()}}>{t('knowledge.ui.042')}</button>}
   <button type="button" className={css.save} disabled={busy||loading||blocked||conflict||!!pending||historical||!dirty||!markdown.trim()} onClick={()=>void submit('revise')}><Save size={15}/>{busy?t('knowledge.ui.043'):t('knowledge.ui.044')}</button>
   <details className={css.more}><summary aria-label={t('knowledge.ui.017')}><MoreHorizontal size={18}/></summary><div><button type="button" onClick={()=>setInspectorOpen(value=>!value)}><Info size={15}/>{t(inspectorOpen?'knowledge.ui.020':'knowledge.ui.021')}</button><button type="button" disabled={busy||dirty||!!pending||loading} onClick={()=>void reload()}><RefreshCw size={15}/>{t('employeeKnowledge.refresh')}</button></div></details>
  </div></header>
  <p className={css.versionNotice}>{t(head?.editing==='employee-copy'?'employeeKnowledge.copyBoundary':'employeeKnowledge.forkBoundary')}</p>
  {error&&<p className={css.editMessage} role="alert">{error}{blocked&&<button type="button" onClick={()=>setAttempt(value=>value+1)}>{t('common.retry')}</button>}</p>}
  {notice&&<p className={css.editMessage} role="status">{notice}</p>}
  {journal.warning()&&<p className={css.editMessage} role="status">{t('library.draftStorage')}</p>}
  {pending&&<div className={css.editRecovery} role="status"><p>{t('employeeKnowledge.pending')}</p><button type="button" disabled={busy||loading||blocked} onClick={()=>void submit(pending.kind,true)}><RefreshCw size={15}/>{t('employeeKnowledge.recover')}</button></div>}
  {conflict&&<div className={css.editRecovery} role="alert"><p>{t('employeeKnowledge.conflict')}</p><button type="button" disabled={busy} onClick={()=>void reload(true)}>{t('employeeKnowledge.rebase')}</button></div>}
  {head&&<div className={css.editStatus} role="status"><span>{t('employeeKnowledge.current',{version:head.bodyVersion})}</span><span>{t(`employeeKnowledge.index.${head.indexState}`)}</span>{head.indexState==='pending'&&<button type="button" disabled={busy||dirty||!!pending} onClick={()=>void reload()}>{t('employeeKnowledge.refresh')}</button>}</div>}
  <div className={inspectorOpen?`${css.body} ${css.bodyWithInspector}`:css.body}><div className={css.canvas}>
   {historical&&!draft&&<div className={css.historicalNotice} role="status"><div><strong>{t('knowledge.ui.046')}{selected?.bodyVersion}{t('knowledge.ui.047')}</strong><span>{t('knowledge.ui.048')}</span></div><button type="button" disabled={busy||loading||blocked||!!pending} onClick={()=>void submit('restore')}><RotateCcw size={15}/>{t('knowledge.ui.050')}</button></div>}
   {loading?<p role="status">{t('knowledge.ui.051')}</p>:selected?<KnowledgeMarkdownEditor key={`${role.id}:${resource.id}:${selected.bodyVersion}`} value={markdown} onChange={change} initialMode={initialMode} readOnly={historical&&!draft||busy||blocked||!!pending}/>:<p>{t('knowledge.manager.bodyUnavailable')}</p>}
   {draft&&head&&draft.base.contentHash!==head.contentHash&&<details className={css.latestBody}><summary>{t('employeeKnowledge.current',{version:head.bodyVersion})}</summary><KnowledgeMarkdownEditor value={head.markdown} onChange={()=>{}} readOnly/></details>}
  </div>{inspectorOpen&&<aside className={css.history} aria-label={t('knowledge.ui.052')}><header><History size={17}/><strong>{t('knowledge.ui.035')}</strong></header><dl className={css.pageFacts}><div><dt>{t('employeeKnowledge.target')}</dt><dd>{role.name}</dd></div><div><dt>{t('knowledge.ui.027')}</dt><dd>{resource.title}</dd></div><div><dt>{t('knowledge.ui.015')}</dt><dd>{head?.origin.sourceVersion.slice(0,12)}</dd></div></dl><div className={css.versionList}>{[...versions].sort((a,b)=>b.version-a.version).map(version=><button type="button" key={version.version} disabled={busy||dirty||!!pending} aria-label={t('knowledge.versionAria',{version:version.version})} aria-current={selected?.bodyVersion===version.version?'true':undefined} onClick={()=>void read(version.version)}><span>{version.version===head?.bodyVersion?<Check size={15}/>:<Clock3 size={15}/>}<strong>v{version.version}</strong>{version.version===head?.bodyVersion&&<em>{t('knowledge.ui.056')}</em>}</span><small>{new Intl.DateTimeFormat(locale,{dateStyle:'short',timeStyle:'short'}).format(new Date(version.createdAt))}</small></button>)}</div>{dirty&&<p className={css.historyHint}>{t('knowledge.ui.058')}</p>}</aside>}</div>
 </section>
}
