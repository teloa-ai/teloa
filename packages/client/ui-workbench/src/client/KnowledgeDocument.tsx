import {libraryLocalCopyJournal} from './library-local-copy-journal.js'
import {knowledgeCopyJournal} from './knowledge-copy-journal.js'
import {verifyKnowledgeVersionContent} from '@teloa/contract'
import {libraryResourceEditJournal,type LibraryResourceEditDraft,type LibraryResourceEditPending} from './library-resource-edit-journal.js'
import {LibrarySourceEditor} from './LibrarySourceEditor.js'
import {LibraryLocalCopyDocument} from './LibraryLocalCopyDocument.js'
import {LibraryLocalDocument} from './LibraryLocalDocument.js'
import {LibraryReaderHeader} from './LibraryReaderHeader.js'
import {libraryReaderText} from './library-reader-copy.js'
import {downloadLibraryText} from './library-text-file.js'
import {MarkdownPreview} from './knowledge-markdown.js'
import {KnowledgeCopyDocument} from './KnowledgeCopyDocument.js'
import {KnowledgeCopyOrigin} from './KnowledgeCopyOrigin.js'
import {knowledgeCopyText} from './knowledge-copy-text.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'
import { useEffect, useMemo, useRef, useState,type ReactNode } from 'react';
import { Check, ChevronRight, Clock3, Copy, Download, History, Info, Pencil, MoreHorizontal, RotateCcw, Save, Trash2 } from 'lucide-react';
import type { ResourceUsageTarget,KnowledgeVersion, KnowledgeVersionSummary, SourceReference, WorkResource } from '@teloa/contract';
import type { ResourceApi } from './resource-api.js';
import {ResourceUsage} from './ResourceUsage.js';
import {isIndustryMaterialSourceId,isLocalMaterialSourceId} from './local-material-registration.ts';
import css from './KnowledgeDocument.module.css';
import {useI18n} from './i18n/provider.js';
import {localizeWorkError} from './i18n/errors.js';
import {businessLibraryText,pinnedKnowledgeVersion} from './business-library-presentation.js';
const displayTime = (value: string, locale: string) => new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const displaySize = (bytes: number, locale: string) => bytes < 1024 ? `${bytes.toLocaleString(locale)} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;

export function KnowledgeDocument({ navigation,onUse,storage,openUsage,onDirtyChange,onReferenceReadyChange,onRetrySource, api, resource, source, onPublished, onCopy, onWithdraw, onNotice, onError }: {
    navigation?:ReactNode;
    onUse?:(()=>void)|undefined;
    storage?:WorkbenchNavigationStorage|undefined;
    openUsage?:((target:ResourceUsageTarget)=>void)|undefined;
    onDirtyChange?:((dirty:boolean)=>void)|undefined;
    onReferenceReadyChange?:((ready:boolean)=>void)|undefined;
    onRetrySource?:(()=>void)|undefined;
    api: ResourceApi;
    resource: WorkResource;
    source: SourceReference | undefined;
    onPublished: (resourceId: string) => Promise<void> | void;
    onCopy: () => void;
    onWithdraw: () => void;
    onNotice: (message: string) => void;
    onError: (message: string) => void;
}) {
    const {locale,t}=useI18n(),copy=businessLibraryText(locale),reader=libraryReaderText(locale);
    const currentIdentity=useRef({api,id:resource.id,owner:resource.ownerId,version:resource.version,sourceId:resource.sourceId,hash:resource.sourceVersion});currentIdentity.current={api,id:resource.id,owner:resource.ownerId,version:resource.version,sourceId:resource.sourceId,hash:resource.sourceVersion};
    const isCurrent=()=>currentIdentity.current.api===api&&currentIdentity.current.id===resource.id&&currentIdentity.current.owner===resource.ownerId&&currentIdentity.current.version===resource.version&&currentIdentity.current.sourceId===resource.sourceId&&currentIdentity.current.hash===resource.sourceVersion;
    const categoryLabels: Record<string, string> = { 'business-context': t("knowledge.ui.001"), policy: t("knowledge.ui.002"), sop: t("knowledge.ui.003"), criteria: t("knowledge.ui.004"), reference: t("knowledge.ui.005"), 'template-asset': t("knowledge.ui.006"), 'system-data-guide': t("knowledge.ui.007") };
const scopeLabel = (value: string) => value === 'general' ? t("knowledge.ui.008") : value;
    const knowledge = source?.knowledge;
    const editJournal=useMemo(()=>libraryResourceEditJournal(api,resource,knowledge?.knowledgeId??'',storage),[api,storage,resource.ownerId,resource.id,resource.version,resource.sourceId,resource.sourceVersion,knowledge?.knowledgeId]);
    const [storedDraft,setStoredDraft]=useState<LibraryResourceEditDraft>(),[draftBlocked,setDraftBlocked]=useState(false);
    const [copyOpen,setCopyOpen]=useState(false);
    const localMaterial = isLocalMaterialSourceId(resource.sourceId);
    const copyJournal=useMemo(()=>localMaterial?libraryLocalCopyJournal(storage,resource):isIndustryMaterialSourceId(resource.sourceId)?knowledgeCopyJournal(storage,resource):undefined,[storage,resource.ownerId,resource.id,resource.version,resource.sourceId,resource.sourceVersion]);
    let recoverCopy=false;try{recoverCopy=copyJournal?.read()?.pending??false}catch{/* 损坏草稿由明确打开后的编辑器阻断；不阻止阅读原版本。 */}

    const localSourceUnavailable = localMaterial && !source;
    const previewSource = localMaterial || isIndustryMaterialSourceId(resource.sourceId);
    const localReadKey = `${resource.ownerId}:${resource.id}:${resource.version}:${resource.sourceVersion}:${resource.status}:${localMaterial?source?.version??'unavailable':''}`;
    const [localReadAttempt,setLocalReadAttempt]=useState(0),[storedLocalContent,setLocalContent]=useState<{key:string;loading:boolean;text?:string;error?:unknown}>();
    const localContent:NonNullable<typeof storedLocalContent>=storedLocalContent?.key===localReadKey?storedLocalContent:{key:localReadKey,loading:true};
    const localErrorCode=localContent.error&&typeof localContent.error==='object'&&'code' in localContent.error?localContent.error.code:undefined;
    const localChanged=source!==undefined&&source.version!==resource.sourceVersion||['teloa/version-conflict','teloa/conflict','teloa/file-changed'].includes(String(localErrorCode));
    // 来源状态只反映原件核验，不随忙碌或副本面板变化。
    const sourceTitle = source?.title ?? resource.sourceId;
    const [versions, setVersions] = useState<KnowledgeVersionSummary[]>([]), [selected, setSelected] = useState<KnowledgeVersion>(), [markdown, setMarkdown] = useState(''), [baseline, setBaseline] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [inspectorOpen, setInspectorOpen] = useState(false);
    const generation = useRef(0), revisionRequest = useRef<string>(crypto.randomUUID()), moreMenu = useRef<HTMLDetailsElement>(null);
    const [previewUnavailable,setPreviewUnavailable]=useState(false),[editingBody,setEditingBody]=useState(false);
    const infoButton=useRef<HTMLButtonElement>(null);
    useEffect(()=>{if(!inspectorOpen)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setInspectorOpen(false);infoButton.current?.focus()}};document.addEventListener('keydown',close);return()=>document.removeEventListener('keydown',close)},[inspectorOpen]);
    const latest = versions.at(-1), dirty = markdown !== baseline, isHistorical = !!latest && selected?.version !== latest.version;
    useEffect(()=>{onDirtyChange?.(dirty&&(!storedDraft||draftBlocked));return ()=>onDirtyChange?.(false)},[dirty,storedDraft,draftBlocked,onDirtyChange]);
    const referenceReady=!copyOpen&&!storedDraft?.pending&&!localSourceUnavailable&&resource.status==='active'&&!dirty&&!busy&&(knowledge?!loading&&selected?.contentHash===resource.sourceVersion:!previewSource||!localContent.loading&&!localContent.error&&!localChanged);
    useEffect(()=>{onReferenceReadyChange?.(referenceReady);return ()=>onReferenceReadyChange?.(false)},[referenceReady,onReferenceReadyChange]);
    const toggleInspector = () => { setInspectorOpen(value => !value); moreMenu.current?.removeAttribute('open'); };
    const checkedVersion=async(version:number,rows:KnowledgeVersionSummary[])=>{const summary=rows.find(row=>row.version===version),value=await api.readKnowledgeVersion(knowledge!.knowledgeId,version);if(!summary||value.ownerId!==resource.ownerId||value.knowledgeId!==knowledge!.knowledgeId||value.sourceId!==summary.sourceId||value.contentHash!==summary.contentHash||value.bytes!==summary.bytes||!await verifyKnowledgeVersionContent(value))throw Object.assign(Error(),{code:'teloa/invalid-host-response'});return value};
    const read = async (version: number) => {
        if (!knowledge)
            return;
        const token = ++generation.current;
        setLoading(true);setPreviewUnavailable(false);
        try {
            const value = await checkedVersion(version,versions);
            if (!isCurrent()||token !== generation.current)
                return;
            setSelected(value);
            setMarkdown(value.markdown);
            setBaseline(value.markdown);
        }
        catch (error) {
            if (isCurrent()&&token === generation.current)
                onError(localizeWorkError(locale,error));
        }
        finally {
            if (isCurrent()&&token === generation.current)
                setLoading(false);
        }
    };
    const refresh = async (preferred?: number) => {
        if (!knowledge) {
            setVersions([]);
            setSelected(undefined);
            setMarkdown('');
            setBaseline('');
            return;
        }
        const token = ++generation.current;
        setLoading(true);setPreviewUnavailable(false);setSelected(undefined);setMarkdown('');setBaseline('');
        try {
            const rows = await api.listKnowledgeVersions(knowledge.knowledgeId);
            let cached:LibraryResourceEditDraft|undefined;try{cached=editJournal.read();setDraftBlocked(false)}catch{setDraftBlocked(true);onError(localizeWorkError(locale,{code:'teloa/storage-corrupt'}))}
            if(cached&&!rows.some(row=>row.version===cached.baseKnowledgeVersion))throw Object.assign(Error(),{code:'teloa/version-conflict'});
            const version = cached?.pending?.kind==='restore'?cached.pending.input.restoreVersion:preferred ?? pinnedKnowledgeVersion(resource,rows);
            if (!isCurrent()||token !== generation.current)
                return;
            setVersions(rows);setStoredDraft(cached);setEditingBody(false);revisionRequest.current=cached?.requestId??crypto.randomUUID();
            if (version) {
                const value = await checkedVersion(version,rows);
                if (!isCurrent()||token !== generation.current)
                    return;
                setSelected(value);
                setMarkdown(value.markdown);
                setBaseline(value.markdown);
            }else setPreviewUnavailable(true);
        }
        catch (error) {
            if (isCurrent()&&token === generation.current){setPreviewUnavailable(true);onError(localizeWorkError(locale,error));}
        }
        finally {
            if (isCurrent()&&token === generation.current)
                setLoading(false);
        }
    };
    useEffect(() => { setBusy(false);revisionRequest.current = crypto.randomUUID(); void refresh(); return () => { generation.current++; }; }, [api,knowledge?.knowledgeId,resource.ownerId,resource.id,resource.version,resource.sourceVersion,editJournal]);
    useEffect(()=>{
        if(!previewSource||knowledge)return;
        const controller=new AbortController(),key=localReadKey;
        setLocalContent({key,loading:true});
        if(resource.status!=='active'||!api.readContent){setLocalContent({key,loading:false,error:{code:'teloa/dependency-unavailable'}});return ()=>controller.abort();}
        void api.readContent(resource,controller.signal).then(value=>{
            if(!controller.signal.aborted)setLocalContent({key,loading:false,text:value.text});
        }).catch(error=>{
            if(!controller.signal.aborted)setLocalContent({key,loading:false,error});
        });
        return ()=>controller.abort();
    },[api,knowledge?.knowledgeId,resource.id,resource.version,resource.sourceVersion,resource.status,resource.ownerId,localReadKey,localReadAttempt]);
    const beginEdit=()=>{if(!selected||draftBlocked)return;const saved=editJournal.read();setStoredDraft(saved);setMarkdown(saved?.markdown??baseline);setEditingBody(true)};
    const changeMarkdown=(value:string)=>{
        if(!selected||!latest||busy||storedDraft?.pending||draftBlocked)return;
        setMarkdown(value);const draft:LibraryResourceEditDraft={knowledgeId:knowledge!.knowledgeId,baseKnowledgeVersion:storedDraft?.baseKnowledgeVersion??latest.version,markdown:value,requestId:storedDraft?.requestId??revisionRequest.current};
        try{editJournal.write(draft);setStoredDraft(draft)}catch{setDraftBlocked(true);onError(t('library.draftStorage'))}
    };
    const save = async () => {
        if(resource.status!=='active'||!knowledge||!latest||!selected||isHistorical||busy||draftBlocked||storedDraft?.pending?.kind==='restore'||!storedDraft?.pending&&(!dirty||!markdown.trim()))return;
        const value:LibraryResourceEditDraft=storedDraft??{knowledgeId:knowledge.knowledgeId,baseKnowledgeVersion:latest.version,markdown,requestId:revisionRequest.current};
        const input=storedDraft?.pending?.kind==='revise'?storedDraft.pending.input:{requestId:value.requestId,knowledgeId:knowledge.knowledgeId,expectedKnowledgeVersion:value.baseKnowledgeVersion,resourceId:resource.id,expectedResourceVersion:resource.version,markdown:value.markdown};
        const pending:LibraryResourceEditPending={kind:'revise',input};
        try{editJournal.write({...value,pending});setStoredDraft({...value,pending})}catch{setDraftBlocked(true);onError(t('library.draftStorage'));return}
        const token=generation.current;setBusy(true);
        try{
            const saved=await api.reviseKnowledgeResource(input),version=saved.knowledge.version;
            editJournal.clear(input.requestId);
            if(!isCurrent()||token!==generation.current)return;
            revisionRequest.current=crypto.randomUUID();setStoredDraft(undefined);setEditingBody(false);setSelected(version);setBaseline(version.markdown);setMarkdown(version.markdown);setVersions(rows=>[...rows.filter(row=>row.version!==version.version),version]);await onPublished(saved.resource.id);
            if(isCurrent()&&token===generation.current)onNotice(t('knowledge.savedNotice',{version:version.version}));
        }catch(error){if(!isCurrent()||token!==generation.current)return;if(error&&typeof error==='object'&&'rejected'in error&&error.rejected===true){editJournal.write(value);setStoredDraft(value)}onError(localizeWorkError(locale,error))}finally{if(isCurrent()&&token===generation.current)setBusy(false)}
    };
    const restore = async () => {
        if (resource.status!=='active' || !knowledge || !latest || !selected || !isHistorical)
            return;
        if(busy||draftBlocked||storedDraft?.pending?.kind==='revise')return;
        const value:LibraryResourceEditDraft=storedDraft??{knowledgeId:knowledge.knowledgeId,baseKnowledgeVersion:latest.version,markdown:selected.markdown,requestId:revisionRequest.current};
        const input=storedDraft?.pending?.kind==='restore'?storedDraft.pending.input:{requestId:value.requestId,knowledgeId:knowledge.knowledgeId,expectedKnowledgeVersion:value.baseKnowledgeVersion,resourceId:resource.id,expectedResourceVersion:resource.version,restoreVersion:selected.version};
        try{editJournal.write({...value,pending:{kind:'restore',input}});setStoredDraft({...value,pending:{kind:'restore',input}})}catch{setDraftBlocked(true);onError(t('library.draftStorage'));return}
        const token=generation.current;
        setBusy(true);
        try {
            const saved = await api.restoreKnowledgeResource(input), version = saved.knowledge.version;editJournal.clear(input.requestId);
            if(!isCurrent()||token!==generation.current)return;
            revisionRequest.current = crypto.randomUUID();setStoredDraft(undefined);
            setSelected(version);
            setBaseline(version.markdown);
            setMarkdown(version.markdown);
            setVersions(rows => [...rows.filter(row => row.version !== version.version), version]);
            await onPublished(saved.resource.id);
            if(isCurrent()&&token===generation.current)onNotice(t('knowledge.restoredNotice',{source:selected.version,version:version.version}));
        }
        catch (error) {
            if(!isCurrent()||token!==generation.current)return;
            onError(localizeWorkError(locale,error));
            // 保留正在查看的历史版本，允许核对后沿原请求重试。
        }
        finally {
            if(isCurrent()&&token===generation.current)setBusy(false);
        }
    };
    if(copyOpen&&localMaterial)return <LibraryLocalCopyDocument navigation={navigation} api={api} resource={resource} storage={storage} onClose={()=>setCopyOpen(false)} onSaved={async id=>{await onPublished(id);setCopyOpen(false);onNotice(knowledgeCopyText(locale).saved)}}/>;
    if(copyOpen)return <KnowledgeCopyDocument navigation={navigation} compact api={api} resource={resource} storage={storage} onClose={()=>setCopyOpen(false)} onSaved={async id=>{await onPublished(id);setCopyOpen(false);onNotice(knowledgeCopyText(locale).saved)}}/>;
    if (!knowledge)return <LibraryLocalDocument navigation={navigation} api={api} resource={resource} source={source} text={localContent.text} loading={localContent.loading} error={localContent.error} missing={localSourceUnavailable} changed={localChanged} ready={referenceReady} onCopy={onCopy} onRecoverCopy={recoverCopy?()=>setCopyOpen(true):undefined} onUse={onUse} onWithdraw={onWithdraw} openUsage={openUsage} onEdit={(localMaterial?api.previewLocalKnowledgeCopy&&api.createLocalKnowledgeCopy:isIndustryMaterialSourceId(resource.sourceId)&&api.previewKnowledgeCopy&&api.createKnowledgeCopy)?()=>setCopyOpen(true):undefined} onRetry={api.readContent?()=>{setLocalReadAttempt(value=>value+1);if(localMaterial)onRetrySource?.()}:undefined}/>
    return <section className={css.document} aria-label={t("knowledge.ui.013")}>
  <LibraryReaderHeader navigation={navigation} title={resource.title}><button type="button" disabled={!selected||loading||previewUnavailable} onClick={()=>{if(selected)downloadLibraryText(markdown,resource.title)}}><Download size={16}/>{reader.download}</button>{!editingBody&&<button type="button" disabled={!selected||isHistorical||resource.status!=='active'||loading} onClick={beginEdit}><Pencil size={16}/>{reader.edit}</button>}<button ref={infoButton} type="button" aria-label={reader.info} aria-expanded={inspectorOpen} onClick={toggleInspector}><Info size={17}/></button><button type="button" disabled={localMaterial&&!referenceReady||resource.status !== 'active'||loading||!!knowledge&&(!selected||selected.contentHash!==resource.sourceVersion)} onClick={()=>{if(!localMaterial||referenceReady)onCopy()}}><Copy size={15}/>{t("knowledge.ui.016")}</button>{editingBody&&<button type="button" disabled={busy} onClick={()=>{setEditingBody(false);setMarkdown(baseline)}}>{reader.cancel}</button>}{editingBody&&<button className={css.save} type="button" disabled={resource.status!=='active'||busy||loading||draftBlocked||isHistorical||storedDraft?.pending?.kind==='restore'||!storedDraft?.pending&&(!dirty||!markdown.trim())} onClick={() => void save()}><Save size={15}/>{busy?t("knowledge.ui.043"):storedDraft?.pending?knowledgeCopyText(locale).recover:reader.version}</button>}<details ref={moreMenu} className={css.more}><summary aria-label={t("knowledge.ui.017")}><MoreHorizontal size={18}/></summary><div><button type="button" aria-label={inspectorOpen ? t("knowledge.ui.018") : t("knowledge.ui.019")} onClick={toggleInspector}><Info size={15}/>{inspectorOpen ? t("knowledge.ui.020") : t("knowledge.ui.021")}</button><button type="button" aria-label={t("knowledge.ui.022")} disabled={busy || resource.status !== 'active'} onClick={onWithdraw}><Trash2 size={15}/>{t("knowledge.ui.022")}</button></div></details></LibraryReaderHeader>
  {inspectorOpen&&<KnowledgeCopyOrigin api={api} knowledgeId={knowledge.knowledgeId}/>}
  {storedDraft?.pending&&!busy&&<p className={css.copyBoundary} role="status">{knowledgeCopyText(locale).unknown}</p>}
  {inspectorOpen&&<p className={css.versionNotice}>{copy.record} v{resource.version}{selected&&<> · {copy.body} v{selected.version}</>}{selected?.contentHash===resource.sourceVersion?' · '+copy.locked:selected?' · '+copy.viewingOther:''}{resource.status!=='active'&&<> · {copy.withdrawn}</>}</p>}
  <div className={inspectorOpen ? `${css.body} ${css.bodyWithInspector}` : css.body}>
   <div className={css.canvas}>{selected && isHistorical && <div className={css.historicalNotice} role="status"><div><strong>{t("knowledge.ui.046")}{selected.version}{t("knowledge.ui.047")}</strong><span>{t("knowledge.ui.048")}</span></div><button type="button" disabled={resource.status!=='active'||busy||loading} onClick={() => void restore()}><RotateCcw size={15}/>{busy ? t("knowledge.ui.049") : t("knowledge.ui.050")}</button></div>}{loading && !selected ? <p className={css.loading} role="status">{t("knowledge.ui.051")}</p> : previewUnavailable||!selected ? <p className={css.loading} role="alert">{copy.missingVersion}</p> : !editingBody?<article className={css.readerContent}><MarkdownPreview markdown={markdown} images={false}/></article>:<LibrarySourceEditor key={`${knowledge.knowledgeId}:${selected?.version ?? 'loading'}`} value={markdown} onChange={changeMarkdown} readOnly={resource.status!=='active'||busy||loading||isHistorical||draftBlocked||!!storedDraft?.pending}/>}</div>
   {inspectorOpen && <aside className={css.history} aria-label={t("knowledge.ui.052")}><header><Info size={17}/><div><strong>{t("knowledge.ui.025")}</strong><small>{t("knowledge.ui.053")}</small></div></header><dl className={css.pageFacts}><div><dt>{t("knowledge.ui.027")}</dt><dd>{sourceTitle}</dd></div><div><dt>{t("knowledge.ui.028")}</dt><dd>{knowledge.workspaceId === 'default' ? t("knowledge.ui.029") : knowledge.workspaceId}</dd></div><div><dt>{t("knowledge.ui.030")}</dt><dd>{knowledge.scopeIds.map(scopeLabel).join(' · ')}</dd></div><div><dt>{t("knowledge.ui.054")}</dt><dd>{categoryLabels[knowledge.category] ?? knowledge.category}</dd></div><div><dt>{t("knowledge.ui.015")}</dt><dd>{resource.sourceVersion.slice(0, 12)}</dd></div></dl><div className={css.versionHeader}><History size={16}/><div><strong>{t("knowledge.ui.035")}</strong><small>{versions.length}{t("knowledge.ui.055")}</small></div></div><div className={css.versionList}>{[...versions].reverse().map(version => { const current = version.version === latest?.version, viewing = selected?.version === version.version; return <button key={version.version} type="button" aria-label={t('knowledge.versionAria',{version:version.version})} aria-current={viewing ? 'true' : undefined} disabled={busy || dirty} onClick={() => void read(version.version)}><span>{current ? <Check size={15}/> : <Clock3 size={15}/>}<strong>v{version.version}</strong>{current && <em>{t("knowledge.ui.056")}</em>}{viewing && !current && <em>{t("knowledge.ui.057")}</em>}</span><small>{displayTime(version.createdAt,locale)} · {displaySize(version.bytes,locale)}</small><ChevronRight size={15}/></button>; })}</div>{dirty && <p className={css.historyHint}>{t("knowledge.ui.058")}</p>}<ResourceUsage resource={resource} api={api} open={openUsage}/></aside>}
  </div>
 </section>;
}
