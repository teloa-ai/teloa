import {LibraryReaderHeader} from './LibraryReaderHeader.js'
import {LibrarySourceEditor} from './LibrarySourceEditor.js'
import {libraryReaderText} from './library-reader-copy.js'
import {useBusinessScopes} from './business-scope-context.js'
import {KnowledgeCopyFacts} from './KnowledgeCopyOrigin.js'
import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react'
import {sameKnowledgeCopyOrigin,type WorkResource} from '@teloa/contract'
import type {ResourceApi} from './resource-api.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'
import {knowledgeCopyJournal,type KnowledgeCopyDraft} from './knowledge-copy-journal.js'
import {knowledgeCopyText} from './knowledge-copy-text.js'
import {KnowledgeMarkdownEditor} from './KnowledgeMarkdownEditor.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './KnowledgeDocument.module.css'
export function KnowledgeCopyDocument({compact=false,navigation,api,resource,storage,onClose,onSaved}:{compact?:boolean;navigation?:ReactNode;api:ResourceApi;resource:WorkResource;storage:WorkbenchNavigationStorage|undefined;onClose:()=>void;onSaved:(id:string)=>Promise<void>|void}){
 const {locale,t}=useI18n(),scopeNames=useBusinessScopes(),text=knowledgeCopyText(locale),reader=libraryReaderText(locale),journal=useMemo(()=>knowledgeCopyJournal(storage,resource),[storage,resource.ownerId,resource.id,resource.version,resource.sourceVersion])
 const [draft,setDraft]=useState<KnowledgeCopyDraft>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[blocked,setBlocked]=useState(false)
 const identity=useRef({api,owner:resource.ownerId,id:resource.id,version:resource.version,sourceId:resource.sourceId,hash:resource.sourceVersion});identity.current={api,owner:resource.ownerId,id:resource.id,version:resource.version,sourceId:resource.sourceId,hash:resource.sourceVersion}
 const active=useRef(false),current=()=>active.current&&identity.current.api===api&&identity.current.owner===resource.ownerId&&identity.current.id===resource.id&&identity.current.version===resource.version&&identity.current.sourceId===resource.sourceId&&identity.current.hash===resource.sourceVersion
 useEffect(()=>{active.current=true;let cancelled=false;void(async()=>{const saved=journal.read();if(saved){if(!cancelled)setDraft(saved);return}const preview=await api.previewKnowledgeCopy!({resourceId:resource.id,expectedResourceVersion:resource.version,sourceVersion:resource.sourceVersion});const value={preview,title:preview.title,markdown:preview.markdown,requestId:crypto.randomUUID(),pending:false};journal.write(value);if(!cancelled)setDraft(value)})().catch(cause=>{if(!cancelled){setBlocked(true);setError(cause instanceof Error?cause.message:localizeWorkError(locale,cause))}});return()=>{cancelled=true;active.current=false}},[api,journal])
 const remember=(value:KnowledgeCopyDraft)=>{setDraft(value);try{journal.write(value);setBlocked(false);setError('');return true}catch(cause){setBlocked(true);setError(cause instanceof Error?cause.message:localizeWorkError(locale,cause));return false}}
 const save=async()=>{
  if(!draft||busy||blocked||!draft.title.trim()||!draft.markdown.trim())return
  const pending={...draft,pending:true};if(!remember(pending))return
  setBusy(true)
  try{
   const result=await api.createKnowledgeCopy!(journal.input(pending))
   if(result.resource.ownerId!==resource.ownerId||result.origin.sourceId!==resource.sourceId||JSON.stringify(result.resource.scopeIds)!==JSON.stringify(pending.preview.scopeIds)||!sameKnowledgeCopyOrigin(result.origin,pending.preview.origin))throw Object.assign(Error(),{code:'teloa/invalid-host-response'})
   journal.clear(pending.requestId)
   if(current())await onSaved(result.resource.id)
  }catch(cause){if(current()){
   // 明确拒绝可继续编辑；网络失败/回执未知必须锁定原输入，禁止另造请求。
   if(cause&&typeof cause==='object'&&'rejected' in cause&&cause.rejected===true)remember({...pending,pending:false})
   setError(localizeWorkError(locale,cause))
  }}finally{if(current())setBusy(false)}
 }
 if(compact)return <section className={css.document} data-library-reader aria-label={text.title}>
  <LibraryReaderHeader navigation={navigation} title={resource.title}><button type="button" disabled={busy} onClick={onClose}>{reader.cancel}</button><button className={css.save} type="button" disabled={busy||blocked||!draft||!draft.title.trim()||!draft.markdown.trim()} onClick={()=>void save()}>{busy?text.pending:draft?.pending?text.recover:reader.copy}</button></LibraryReaderHeader>
  <p className={css.copyBoundary}>{reader.copyBoundary}</p>{error&&<p className={css.inlineFailure} role="alert">{error}</p>}{draft?.pending&&!busy&&<p role="status">{text.unknown}</p>}
  {!draft?<p className={css.loading} role="status">{text.loading}</p>:<><label className={css.copyTitle}>{text.name}<input maxLength={200} value={draft.title} disabled={busy||draft.pending||blocked} onChange={event=>remember({...draft,title:event.target.value})}/></label><LibrarySourceEditor value={draft.markdown} readOnly={busy||draft.pending||blocked} onChange={markdown=>remember({...draft,markdown})}/><details className={css.copyDetails}><summary>{reader.details}</summary><KnowledgeCopyFacts origin={draft.preview.origin}/><p>{text.scope}: {draft.preview.scopeIds.map(scope=>scopeNames[scope]??(scope==='general'?t('business.scope.general'):scope)).join(' · ')}</p></details></>}
 </section>
 return <section className={css.document} aria-label={text.title}>
  <header className={css.documentHeader}><div className={css.titleBlock}><h2>{text.title}</h2></div><div className={css.documentActions}><button type="button" disabled={busy} onClick={onClose}>{text.cancel}</button><button className={css.save} type="button" disabled={busy||blocked||!draft||!draft.title.trim()||!draft.markdown.trim()} onClick={()=>void save()}>{busy?text.pending:draft?.pending?text.recover:text.save}</button></div></header>
  <p className={css.versionNotice}>{text.boundary}</p>{error&&<p role="alert">{error}</p>}{draft?.pending&&!busy&&<p role="status">{text.unknown}</p>}
  {!draft?<p role="status">{text.loading}</p>:<><label className={css.copyName}>{text.name}<input maxLength={200} value={draft.title} disabled={busy||draft.pending||blocked} onChange={event=>remember({...draft,title:event.target.value})}/></label><KnowledgeCopyFacts origin={draft.preview.origin}/><dl className={css.pageFacts}><div><dt>{text.scope}</dt><dd>{draft.preview.scopeIds.map(scope=>scopeNames[scope]??(scope==='general'?t('business.scope.general'):scope)).join(' · ')}</dd></div></dl><KnowledgeMarkdownEditor value={draft.markdown} readOnly={busy||draft.pending||blocked} onChange={markdown=>remember({...draft,markdown})}/></>}
 </section>
}
