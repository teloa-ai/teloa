import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react'
import {isLocalKnowledgeCopyResult,type WorkResource} from '@teloa/contract'
import type {ResourceApi} from './resource-api.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'
import {libraryLocalCopyJournal,type LibraryLocalCopyDraft} from './library-local-copy-journal.js'
import {LibraryReaderHeader} from './LibraryReaderHeader.js'
import {LibrarySourceEditor} from './LibrarySourceEditor.js'
import {libraryReaderText} from './library-reader-copy.js'
import {knowledgeCopyText} from './knowledge-copy-text.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './KnowledgeDocument.module.css'

export function LibraryLocalCopyDocument({navigation,api,resource,storage,onClose,onSaved}:{navigation?:ReactNode;api:ResourceApi;resource:WorkResource;storage:WorkbenchNavigationStorage|undefined;onClose:()=>void;onSaved:(id:string)=>Promise<void>|void}){
 const {locale,t}=useI18n(),copy=libraryReaderText(locale),legacy=knowledgeCopyText(locale),journal=useMemo(()=>libraryLocalCopyJournal(storage,resource),[storage,resource.ownerId,resource.id,resource.version,resource.sourceId,resource.sourceVersion])
 const [draft,setDraft]=useState<LibraryLocalCopyDraft>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[blocked,setBlocked]=useState(false),[reading,setReading]=useState(true),[readAttempt,setReadAttempt]=useState(0)
 const identity=useRef({api,owner:resource.ownerId,id:resource.id,version:resource.version,sourceId:resource.sourceId,hash:resource.sourceVersion});identity.current={api,owner:resource.ownerId,id:resource.id,version:resource.version,sourceId:resource.sourceId,hash:resource.sourceVersion}
 const mounted=useRef(false),current=()=>mounted.current&&identity.current.api===api&&identity.current.owner===resource.ownerId&&identity.current.id===resource.id&&identity.current.version===resource.version&&identity.current.sourceId===resource.sourceId&&identity.current.hash===resource.sourceVersion
 useEffect(()=>{mounted.current=true;let live=true;setDraft(undefined);setError('');setBusy(false);setBlocked(false);setReading(true);void(async()=>{
  const stored=journal.read();if(stored){if(live)setDraft(stored);return}
  if(!api.previewLocalKnowledgeCopy)throw Object.assign(Error(),{code:'teloa/dependency-unavailable'})
  const preview=await api.previewLocalKnowledgeCopy({resourceId:resource.id,expectedResourceVersion:resource.version,sourceVersion:resource.sourceVersion})
  if(!live||!current())return
  if(preview.origin.resourceId!==resource.id||preview.origin.resourceVersion!==resource.version||preview.origin.sourceId!==resource.sourceId||preview.origin.sourceVersion!==resource.sourceVersion||JSON.stringify(preview.scopeIds)!==JSON.stringify(resource.scopeIds))throw Object.assign(Error(),{code:'teloa/invalid-host-response'})
  const value={preview,title:preview.title,markdown:preview.markdown,requestId:crypto.randomUUID(),pending:false};journal.write(value);if(live)setDraft(value)
 })().catch(cause=>{if(live&&current()){setBlocked(true);setError(localizeWorkError(locale,cause))}}).finally(()=>{if(live&&current())setReading(false)});return()=>{live=false;mounted.current=false}},[api,journal,readAttempt])
 const remember=(value:LibraryLocalCopyDraft)=>{setDraft(value);try{journal.write(value);setBlocked(false);setError('');return true}catch(cause){setBlocked(true);setError(t('library.draftStorage'));return false}}
 const save=async()=>{
  if(!draft||busy||blocked||!draft.title.trim()||!draft.markdown.trim()||!api.createLocalKnowledgeCopy)return
  const pending={...draft,pending:true};if(!remember(pending))return;setBusy(true)
  try{
   const result=await api.createLocalKnowledgeCopy(journal.input(pending))
   if(!isLocalKnowledgeCopyResult(result)||result.resource.ownerId!==resource.ownerId||(['kind','resourceId','resourceVersion','sourceId','sourceTitle','sourceVersion','sourcePath','bytes'] as const).some(key=>result.origin[key]!==pending.preview.origin[key])||JSON.stringify(result.resource.scopeIds)!==JSON.stringify(pending.preview.scopeIds)||JSON.stringify(result.knowledge.item.scopeIds)!==JSON.stringify(pending.preview.scopeIds))throw Object.assign(Error(),{code:'teloa/invalid-host-response'})
   journal.clear(pending.requestId);if(current())await onSaved(result.resource.id)
  }catch(cause){if(current()){if(cause&&typeof cause==='object'&&'rejected'in cause&&cause.rejected===true)remember({...pending,pending:false});setError(localizeWorkError(locale,cause))}}finally{if(current())setBusy(false)}
 }
 return <section className={css.document} data-library-reader aria-label={copy.copy}>
  <LibraryReaderHeader navigation={navigation} title={resource.title}><button type="button" disabled={busy} onClick={onClose}>{copy.cancel}</button><button className={css.save} type="button" disabled={busy||blocked||!draft||!draft.title.trim()||!draft.markdown.trim()} onClick={()=>void save()}>{busy?legacy.pending:draft?.pending?legacy.recover:copy.copy}</button></LibraryReaderHeader>
  <p className={css.copyBoundary}>{copy.copyBoundary}</p>{error&&<div className={css.inlineFailure} role="alert"><p>{error}</p>{!draft&&!reading&&<button type="button" onClick={()=>setReadAttempt(value=>value+1)}>{t('common.retry')}</button>}</div>}{draft?.pending&&!busy&&<p className={css.copyBoundary} role="status">{legacy.unknown}</p>}
  {!draft?(reading?<p className={css.loading} role="status">{legacy.loading}</p>:null):<><label className={css.copyTitle}>{legacy.name}<input value={draft.title} maxLength={200} disabled={busy||draft.pending||blocked} onChange={event=>remember({...draft,title:event.target.value})}/></label><LibrarySourceEditor value={draft.markdown} readOnly={busy||draft.pending||blocked} onChange={markdown=>remember({...draft,markdown})}/><details className={css.copyDetails}><summary>{copy.details}</summary><dl className={css.pageFacts}><div><dt>{copy.location}</dt><dd>{draft.preview.origin.sourcePath}</dd></div><div><dt>{t('knowledge.ui.015')}</dt><dd>{draft.preview.origin.sourceVersion}</dd></div><div><dt>{t('knowledge.ui.030')}</dt><dd>{draft.preview.scopeIds.join(' · ')}</dd></div></dl></details></>}
 </section>
}
