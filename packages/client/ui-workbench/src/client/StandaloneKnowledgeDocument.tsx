import {useEffect,useMemo,useRef,useState} from 'react'
import {Check,Clock3,History,Info,MoreHorizontal,RotateCcw,Save} from 'lucide-react'
import {verifyKnowledgeVersionContent,type KnowledgeVersion,type KnowledgeVersionSummary,type PasteKnowledge,type SourceReference} from '@teloa/contract'
import type {ResourceApi} from './resource-api.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'
import {createKnowledgeEditJournal,type KnowledgeEditDraft,type KnowledgeEditPending} from './knowledge-edit-journal.js'
import {KnowledgeMarkdownEditor} from './KnowledgeMarkdownEditor.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './KnowledgeDocument.module.css'

/** 原知识正文复用既有 Markdown 阅读/编辑区域；没有工作资料时不显示引用或撤回授权动作。 */
export function StandaloneKnowledgeDocument({api,ownerId,source,title,storage,onPublished,onError,onNotice}:{api:ResourceApi;ownerId:string;source:SourceReference;title:string;storage:WorkbenchNavigationStorage|undefined;onPublished:()=>Promise<void>;onError:(message:string)=>void;onNotice:(message:string)=>void}){
 const {locale,t}=useI18n(),id=source.knowledge!.knowledgeId
 const scopeLabel=(value:string)=>value==='general'?t('knowledge.ui.008'):value
 const identity=useRef({api,ownerId,id});identity.current={api,ownerId,id}
 const generation=useRef(0),journal=useMemo(()=>createKnowledgeEditJournal(api,ownerId,id,storage),[api,ownerId,id,storage])
 const current=(token:number)=>generation.current===token&&identity.current.api===api&&identity.current.ownerId===ownerId&&identity.current.id===id
 const [versions,setVersions]=useState<KnowledgeVersionSummary[]>([]),[selected,setSelected]=useState<KnowledgeVersion>(),[markdown,setMarkdown]=useState(''),[baseline,setBaseline]=useState(''),[draft,setDraft]=useState<KnowledgeEditDraft>(),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[blocked,setBlocked]=useState(false),[inspectorOpen,setInspectorOpen]=useState(true),[storageWarning,setStorageWarning]=useState(false)
 const head=versions.reduce<KnowledgeVersionSummary|undefined>((latest,row)=>!latest||row.version>latest.version?row:latest,undefined),dirty=markdown!==baseline,historical=!!head&&selected?.version!==head.version,pending=draft?.pending
 const remember=(value:KnowledgeEditDraft)=>{journal.write(value);setDraft(value);setStorageWarning(journal.warning())}
 const checkedVersion=async(version:number,rows:KnowledgeVersionSummary[])=>{
  const summary=rows.find(row=>row.version===version),value=await api.readKnowledgeVersion(id,version)
  if(!summary||value.ownerId!==ownerId||value.sourceId!==summary.sourceId||value.contentHash!==summary.contentHash||value.bytes!==summary.bytes||!await verifyKnowledgeVersionContent(value))throw Object.assign(Error(),{code:'teloa/invalid-host-response'})
  return value
 }
 useEffect(()=>{
  const token=++generation.current;setLoading(true);setBusy(false);setBlocked(false)
  void (async()=>{
   const rows=await api.listKnowledgeVersions(id)
   if(rows.some(row=>row.ownerId!==ownerId||row.knowledgeId!==id))throw Object.assign(Error(),{code:'teloa/invalid-host-response'})
   let saved:KnowledgeEditDraft|undefined
   try{saved=journal.read()}catch{if(current(token)){setBlocked(true);onError(localizeWorkError(locale,{code:'teloa/storage-corrupt'}))}}
   const version=saved?.pending?.kind==='restore'?saved.pending.input.version:saved?.base.version??source.knowledge!.knowledgeVersion
   if(saved&&!rows.some(row=>row.version===saved.base.version&&row.sourceId===saved.base.sourceId&&row.contentHash===saved.base.contentHash))throw Object.assign(Error(),{code:'teloa/invalid-host-response'})
   const value=await checkedVersion(version,rows)
   if(!saved&&value.contentHash!==source.version)throw Object.assign(Error(),{code:'teloa/version-conflict'})
   if(!current(token))return
   setVersions(rows);setSelected(value);setBaseline(value.markdown);setMarkdown(saved?.pending?.kind==='restore'?value.markdown:saved?.markdown??value.markdown);setDraft(saved);setStorageWarning(journal.warning())
   if(saved&&!saved.pending&&rows.some(row=>row.version>saved.base.version))onError(localizeWorkError(locale,{code:'teloa/version-conflict'}))
  })().catch(error=>{if(current(token)){setBlocked(true);onError(localizeWorkError(locale,error))}}).finally(()=>{if(current(token))setLoading(false)})
  return()=>{generation.current++}
 },[api,ownerId,id,source.version,journal])
 const change=(value:string)=>{
  if(!selected||busy||pending||blocked)return
  setMarkdown(value)
  if(value===baseline){if(draft)journal.clear(draft.requestId);setDraft(undefined);return}
  const {markdown:_markdown,...base}=selected
  remember({base:draft?.base??base,markdown:value,requestId:draft?.requestId??crypto.randomUUID()})
 }
 const finish=async(saved:PasteKnowledge,request:KnowledgeEditPending,token:number)=>{
  if(saved.item.ownerId!==ownerId||saved.version.sourceId!==(draft?.base.sourceId??selected?.sourceId))throw Object.assign(Error(),{code:'teloa/invalid-host-response'})
  if(!current(token))return
  journal.clear(request.input.requestId);setDraft(undefined);setSelected(saved.version);setMarkdown(saved.version.markdown);setBaseline(saved.version.markdown);setVersions(rows=>[...rows.filter(row=>row.version!==saved.version.version),saved.version]);setStorageWarning(journal.warning())
  await onPublished()
  if(current(token))onNotice(request.kind==='revise'?t('knowledge.savedNotice',{version:saved.version.version}):t('knowledge.restoredNotice',{source:request.input.version,version:saved.version.version}))
 }
 const submit=async(kind:'revise'|'restore')=>{
  if(busy||blocked||!selected||!head)return
  const existing=draft?.pending
  if(existing&&existing.kind!==kind)return
  if(!existing&&(kind==='revise'?historical||!dirty||!markdown.trim():!historical||dirty))return
  const {markdown:_markdown,...selectedBase}=selected
  const base=kind==='restore'?head:selectedBase
  const value=draft??{base,markdown,requestId:crypto.randomUUID()}
  const request:KnowledgeEditPending=existing??(kind==='revise'?{kind,input:{requestId:value.requestId,knowledgeId:id,expectedVersion:value.base.version,markdown:value.markdown}}:{kind,input:{requestId:value.requestId,knowledgeId:id,expectedVersion:head.version,version:selected.version}})
  remember({...value,pending:request});setBusy(true);onError('');const token=generation.current
  try{await finish(request.kind==='revise'?await api.reviseStandaloneKnowledge(request.input):await api.restoreStandaloneKnowledge(request.input),request,token)}catch(error){if(current(token)){if(error&&typeof error==='object'&&'rejected' in error&&error.rejected===true){const {pending:_pending,...editable}=value;remember(editable)}onError(localizeWorkError(locale,error))}}finally{if(current(token))setBusy(false)}
 }
 const read=async(version:number)=>{
  if(busy||dirty||pending)return
  const token=++generation.current;setLoading(true)
  try{const value=await checkedVersion(version,versions);if(current(token)){setSelected(value);setMarkdown(value.markdown);setBaseline(value.markdown)}}catch(error){if(current(token))onError(localizeWorkError(locale,error))}finally{if(current(token))setLoading(false)}
 }
 return <section className={css.document} aria-label={t('knowledge.ui.013')}>
  <header className={css.documentHeader}><div className={css.titleBlock}><span>{t('library.savedKnowledge')}</span><h2>{title}</h2>{dirty&&<em className={css.dirty}>{t('knowledge.ui.041')}</em>}</div><div className={css.documentActions}>{dirty&&!pending&&<button type="button" onClick={()=>change(baseline)}>{t('knowledge.ui.042')}</button>}<button type="button" className={css.save} disabled={busy||loading||blocked||pending?.kind==='restore'||!pending&&(historical||!dirty||!markdown.trim())} onClick={()=>void submit('revise')}><Save size={15}/>{busy?t('knowledge.ui.043'):t('knowledge.ui.044')}</button><details className={css.more}><summary aria-label={t('knowledge.ui.017')}><MoreHorizontal size={18}/></summary><div><button type="button" onClick={()=>setInspectorOpen(value=>!value)}><Info size={15}/>{t(inspectorOpen?'knowledge.ui.020':'knowledge.ui.021')}</button></div></details></div></header>
  <p className={css.versionNotice}>{t('library.standaloneBoundary')}</p>{storageWarning&&<p role="status">{t('library.draftStorage')}</p>}
  <div className={inspectorOpen?`${css.body} ${css.bodyWithInspector}`:css.body}><div className={css.canvas}>{historical&&<div className={css.historicalNotice} role="status"><div><strong>{t('knowledge.ui.046')}{selected?.version}{t('knowledge.ui.047')}</strong><span>{t('knowledge.ui.048')}</span></div><button type="button" disabled={busy||loading||blocked||!!pending&&pending.kind!=='restore'} onClick={()=>void submit('restore')}><RotateCcw size={15}/>{busy?t('knowledge.ui.049'):t('knowledge.ui.050')}</button></div>}{loading&&!selected?<p role="status">{t('knowledge.ui.051')}</p>:selected?<KnowledgeMarkdownEditor key={`${id}:${selected.version}`} value={markdown} onChange={change} readOnly={historical||busy||loading||blocked||!!pending}/>:<p role="alert">{t('knowledge.manager.bodyUnavailable')}</p>}</div>
   {inspectorOpen&&<aside className={css.history} aria-label={t('knowledge.ui.052')}><header><Info size={17}/><div><strong>{t('knowledge.ui.025')}</strong><small>{t('library.standaloneBoundary')}</small></div></header><dl className={css.pageFacts}><div><dt>{t('knowledge.ui.027')}</dt><dd>{source.title}</dd></div><div><dt>{t('knowledge.ui.030')}</dt><dd>{source.knowledge!.scopeIds.map(scopeLabel).join(' · ')}</dd></div><div><dt>{t('knowledge.ui.015')}</dt><dd>{selected?.contentHash.slice(0,12)}</dd></div></dl><div className={css.versionHeader}><History size={16}/><strong>{t('knowledge.ui.035')}</strong></div><div className={css.versionList}>{[...versions].sort((a,b)=>b.version-a.version).map(version=><button key={version.version} type="button" aria-label={t('knowledge.versionAria',{version:version.version})} aria-current={selected?.version===version.version?'true':undefined} disabled={busy||dirty||!!pending} onClick={()=>void read(version.version)}><span>{version.version===head?.version?<Check size={15}/>:<Clock3 size={15}/>}<strong>v{version.version}</strong>{version.version===head?.version&&<em>{t('knowledge.ui.056')}</em>}</span><small>{new Intl.DateTimeFormat(locale,{dateStyle:'short',timeStyle:'short'}).format(new Date(version.createdAt))}</small></button>)}</div>{dirty&&<p className={css.historyHint}>{t('knowledge.ui.058')}</p>}</aside>}
  </div>
 </section>
}
