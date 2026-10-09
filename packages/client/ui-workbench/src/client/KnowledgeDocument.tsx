import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Clock3, Copy, History, Info, MoreHorizontal, RotateCcw, Save, Trash2 } from 'lucide-react';
import type { KnowledgeVersion, KnowledgeVersionSummary, SourceReference, WorkResource } from '@teloa/contract';
import type { ResourceApi } from './resource-api.js';
import { KnowledgeMarkdownEditor } from './KnowledgeMarkdownEditor.js';
import {isLocalMaterialSourceId} from './local-material-registration.ts';
import css from './KnowledgeDocument.module.css';
import {useI18n} from './i18n/provider.js';
import {localizeWorkError} from './i18n/errors.js';
const displayTime = (value: string, locale: string) => new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const displaySize = (bytes: number, locale: string) => bytes < 1024 ? `${bytes.toLocaleString(locale)} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;

export function KnowledgeDocument({ onDirtyChange, api, resource, source, onPublished, onCopy, onWithdraw, onNotice, onError }: {
    onDirtyChange?:((dirty:boolean)=>void)|undefined;
    api: ResourceApi;
    resource: WorkResource;
    source: SourceReference | undefined;
    onPublished: (resourceId: string) => Promise<void> | void;
    onCopy: () => void;
    onWithdraw: () => void;
    onNotice: (message: string) => void;
    onError: (message: string) => void;
}) {
    const {locale,t}=useI18n();
    const currentIdentity=useRef({api,id:resource.id,owner:resource.ownerId});currentIdentity.current={api,id:resource.id,owner:resource.ownerId};
    const isCurrent=()=>currentIdentity.current.api===api&&currentIdentity.current.id===resource.id&&currentIdentity.current.owner===resource.ownerId;
    const categoryLabels: Record<string, string> = { 'business-context': t("knowledge.ui.001"), policy: t("knowledge.ui.002"), sop: t("knowledge.ui.003"), criteria: t("knowledge.ui.004"), reference: t("knowledge.ui.005"), 'template-asset': t("knowledge.ui.006"), 'system-data-guide': t("knowledge.ui.007") };
const scopeLabel = (value: string) => value === 'general' ? t("knowledge.ui.008") : value;
    const knowledge = source?.knowledge;
    const localMaterial = isLocalMaterialSourceId(resource.sourceId);
    const localReadKey = `${resource.ownerId}:${resource.id}:${resource.version}:${resource.sourceVersion}:${resource.status}`;
    const [localReadAttempt,setLocalReadAttempt]=useState(0),[storedLocalContent,setLocalContent]=useState<{key:string;loading:boolean;text?:string;error?:unknown}>();
    const localContent:NonNullable<typeof storedLocalContent>=storedLocalContent?.key===localReadKey?storedLocalContent:{key:localReadKey,loading:true};
    const localErrorCode=localContent.error&&typeof localContent.error==='object'&&'code' in localContent.error?localContent.error.code:undefined;
    const localChanged=source!==undefined&&source.version!==resource.sourceVersion||['teloa/version-conflict','teloa/conflict','teloa/file-changed'].includes(String(localErrorCode));
    const sourceTitle = source?.title ?? resource.sourceId;
    const [versions, setVersions] = useState<KnowledgeVersionSummary[]>([]), [selected, setSelected] = useState<KnowledgeVersion>(), [markdown, setMarkdown] = useState(''), [baseline, setBaseline] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [inspectorOpen, setInspectorOpen] = useState(false);
    const generation = useRef(0), revisionRequest = useRef(crypto.randomUUID()), moreMenu = useRef<HTMLDetailsElement>(null);
    const latest = versions.at(-1), dirty = markdown !== baseline, isHistorical = !!latest && selected?.version !== latest.version;
    useEffect(()=>{onDirtyChange?.(dirty);return ()=>onDirtyChange?.(false)},[dirty,onDirtyChange]);
    const toggleInspector = () => { setInspectorOpen(value => !value); moreMenu.current?.removeAttribute('open'); };
    const read = async (version: number) => {
        if (!knowledge)
            return;
        const token = ++generation.current;
        setLoading(true);
        try {
            const value = await api.readKnowledgeVersion(knowledge.knowledgeId, version);
            if (token !== generation.current)
                return;
            setSelected(value);
            setMarkdown(value.markdown);
            setBaseline(value.markdown);
        }
        catch (error) {
            if (token === generation.current)
                onError(localizeWorkError(locale,error));
        }
        finally {
            if (token === generation.current)
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
        setLoading(true);
        try {
            const rows = await api.listKnowledgeVersions(knowledge.knowledgeId), version = preferred ?? rows.at(-1)?.version;
            if (token !== generation.current)
                return;
            setVersions(rows);
            if (version) {
                const value = await api.readKnowledgeVersion(knowledge.knowledgeId, version);
                if (token !== generation.current)
                    return;
                setSelected(value);
                setMarkdown(value.markdown);
                setBaseline(value.markdown);
            }
        }
        catch (error) {
            if (token === generation.current)
                onError(localizeWorkError(locale,error));
        }
        finally {
            if (token === generation.current)
                setLoading(false);
        }
    };
    useEffect(() => { setBusy(false);revisionRequest.current = crypto.randomUUID(); void refresh(); return () => { generation.current++; }; }, [api,knowledge?.knowledgeId,resource.ownerId]);
    useEffect(()=>{
        if(!localMaterial||knowledge)return;
        const controller=new AbortController(),key=localReadKey;
        setLocalContent({key,loading:true});
        if(resource.status!=='active'||!api.readContent){setLocalContent({key,loading:false,error:{code:'teloa/dependency-unavailable'}});return ()=>controller.abort();}
        void api.readContent(resource,controller.signal).then(value=>{
            if(!controller.signal.aborted)setLocalContent({key,loading:false,text:value.text});
        }).catch(error=>{
            if(!controller.signal.aborted)setLocalContent({key,loading:false,error});
        });
        return ()=>controller.abort();
    },[api,knowledge?.knowledgeId,resource.id,resource.version,resource.sourceVersion,resource.status,resource.ownerId,localReadAttempt]);
    const save = async () => {
        if (!knowledge || !latest || !selected || isHistorical || !dirty || !markdown.trim())
            return;
        const token=generation.current;
        setBusy(true);
        try {
            const saved = await api.reviseKnowledgeResource({ requestId: revisionRequest.current, knowledgeId: knowledge.knowledgeId, expectedKnowledgeVersion: latest.version, resourceId: resource.id, expectedResourceVersion: resource.version, markdown }), version = saved.knowledge.version;
            if(!isCurrent()||token!==generation.current)return;
            revisionRequest.current = crypto.randomUUID();
            setSelected(version);
            setBaseline(version.markdown);
            setMarkdown(version.markdown);
            setVersions(rows => [...rows.filter(row => row.version !== version.version), version]);
            await onPublished(saved.resource.id);
            if(isCurrent()&&token===generation.current)onNotice(t('knowledge.savedNotice',{version:version.version}));
        }
        catch (error) {
            if(!isCurrent()||token!==generation.current)return;
            onError(localizeWorkError(locale,error));
            await refresh().catch(() => { });
        }
        finally {
            if(isCurrent()&&token===generation.current)setBusy(false);
        }
    };
    const restore = async () => {
        if (!knowledge || !latest || !selected || !isHistorical)
            return;
        const token=generation.current;
        setBusy(true);
        try {
            const saved = await api.restoreKnowledgeResource({ requestId: revisionRequest.current, knowledgeId: knowledge.knowledgeId, expectedKnowledgeVersion: latest.version, resourceId: resource.id, expectedResourceVersion: resource.version, restoreVersion: selected.version }), version = saved.knowledge.version;
            if(!isCurrent()||token!==generation.current)return;
            revisionRequest.current = crypto.randomUUID();
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
            await refresh().catch(() => { });
        }
        finally {
            if(isCurrent()&&token===generation.current)setBusy(false);
        }
    };
    if (!knowledge)
        return <section className={css.document} aria-label={t("knowledge.ui.013")}>
  <header className={css.documentHeader}><div className={css.titleBlock}><span>{localMaterial?t('knowledge.local.preview'):t("knowledge.ui.014")}</span><h2>{resource.title}</h2></div><div className={css.documentActions}>{localMaterial&&api.readContent&&<button type="button" disabled={resource.status!=='active'||localContent.loading} onClick={()=>setLocalReadAttempt(value=>value+1)}><RotateCcw size={15}/>{t('knowledge.local.retry')}</button>}<button type="button" disabled={resource.status !== 'active'} onClick={onCopy}><Copy size={15}/>{t("knowledge.ui.016")}</button><details ref={moreMenu} className={css.more}><summary aria-label={t("knowledge.ui.017")}><MoreHorizontal size={18}/></summary><div><button type="button" aria-label={inspectorOpen ? t("knowledge.ui.018") : t("knowledge.ui.019")} onClick={toggleInspector}><Info size={15}/>{inspectorOpen ? t("knowledge.ui.020") : t("knowledge.ui.021")}</button><button type="button" aria-label={t("knowledge.ui.022")} disabled={resource.status !== 'active'} onClick={onWithdraw}><Trash2 size={15}/>{t("knowledge.ui.022")}</button></div></details></div></header>
  {localMaterial&&<p className={css.versionNotice}>{t('knowledge.local.previewBoundary')}</p>}
  <div className={inspectorOpen ? `${css.body} ${css.bodyWithInspector}` : css.body}>{localMaterial?<div className={css.canvas}>{resource.status!=='active'?<p className={css.loading}>{t('knowledge.local.withdrawn')}</p>:localChanged?<p className={css.loading} role="alert">{t('knowledge.local.changed')}</p>:localContent.loading?<p className={css.loading} role="status">{t("knowledge.ui.051")}</p>:localContent.text!==undefined?<KnowledgeMarkdownEditor key={localReadKey} value={localContent.text} readOnly onChange={()=>{}}/>:<div className={css.unavailable}><p role="alert">{!api.readContent?t('knowledge.local.unavailable'):localizeWorkError(locale,localContent.error)}</p></div>}</div>:<article className={css.readonlyCanvas}><div><FileTextFallback /><h3>{t("knowledge.ui.023")}</h3><p>{t("knowledge.ui.024")}</p></div></article>}{inspectorOpen && <aside className={css.history} aria-label={t("knowledge.ui.025")}><header><Info size={17}/><div><strong>{t("knowledge.ui.025")}</strong><small>{t("knowledge.ui.026")}</small></div></header><dl className={css.pageFacts}><div><dt>{t("knowledge.ui.027")}</dt><dd>{sourceTitle}</dd></div><div><dt>{t("knowledge.ui.028")}</dt><dd>{t("knowledge.ui.029")}</dd></div><div><dt>{t("knowledge.ui.030")}</dt><dd>{resource.scopeIds.map(scopeLabel).join(' · ') || t("knowledge.ui.031")}</dd></div><div><dt>{t("knowledge.ui.032")}</dt><dd>{resource.status === 'active' ? t("knowledge.ui.033") : t("knowledge.ui.034")}</dd></div><div><dt>{t("knowledge.ui.015")}</dt><dd>{resource.sourceVersion.slice(0, 12)}</dd></div></dl><div className={css.versionHeader}><History size={16}/><div><strong>{localMaterial?t('knowledge.local.fileVersion'):t("knowledge.ui.035")}</strong><small>{localMaterial?t('knowledge.local.versionBoundary'):t("knowledge.ui.036")}</small></div></div></aside>}</div>
 </section>;
    return <section className={css.document} aria-label={t("knowledge.ui.013")}>
  <header className={css.documentHeader}><div className={css.titleBlock}><span>{t("knowledge.ui.037")}</span><h2>{resource.title}</h2>{dirty && !isHistorical && <em className={css.dirty}>{t("knowledge.ui.041")}</em>}</div><div className={css.documentActions}><button type="button" disabled={resource.status !== 'active'} onClick={onCopy}><Copy size={15}/>{t("knowledge.ui.016")}</button>{dirty && !isHistorical && <button type="button" disabled={busy} onClick={() => setMarkdown(baseline)}>{t("knowledge.ui.042")}</button>}<button className={css.save} type="button" disabled={busy || loading || isHistorical || !dirty || !markdown.trim()} onClick={() => void save()}><Save size={15}/>{busy ? t("knowledge.ui.043") : t("knowledge.ui.044")}</button><details ref={moreMenu} className={css.more}><summary aria-label={t("knowledge.ui.017")}><MoreHorizontal size={18}/></summary><div><button type="button" aria-label={inspectorOpen ? t("knowledge.ui.018") : t("knowledge.ui.019")} onClick={toggleInspector}><Info size={15}/>{inspectorOpen ? t("knowledge.ui.020") : t("knowledge.ui.021")}</button><button type="button" aria-label={t("knowledge.ui.022")} disabled={busy || resource.status !== 'active'} onClick={onWithdraw}><Trash2 size={15}/>{t("knowledge.ui.022")}</button></div></details></div></header>
  {source && resource.sourceVersion !== source.version && <p className={css.versionNotice}>{t("knowledge.ui.045")}</p>}
  <div className={inspectorOpen ? `${css.body} ${css.bodyWithInspector}` : css.body}>
   <div className={css.canvas}>{selected && isHistorical && <div className={css.historicalNotice} role="status"><div><strong>{t("knowledge.ui.046")}{selected.version}{t("knowledge.ui.047")}</strong><span>{t("knowledge.ui.048")}</span></div><button type="button" disabled={busy} onClick={() => void restore()}><RotateCcw size={15}/>{busy ? t("knowledge.ui.049") : t("knowledge.ui.050")}</button></div>}{loading && !selected ? <p className={css.loading}>{t("knowledge.ui.051")}</p> : <KnowledgeMarkdownEditor key={`${knowledge.knowledgeId}:${selected?.version ?? 'loading'}`} value={markdown} onChange={setMarkdown} readOnly={busy || isHistorical}/>}</div>
   {inspectorOpen && <aside className={css.history} aria-label={t("knowledge.ui.052")}><header><Info size={17}/><div><strong>{t("knowledge.ui.025")}</strong><small>{t("knowledge.ui.053")}</small></div></header><dl className={css.pageFacts}><div><dt>{t("knowledge.ui.027")}</dt><dd>{sourceTitle}</dd></div><div><dt>{t("knowledge.ui.028")}</dt><dd>{knowledge.workspaceId === 'default' ? t("knowledge.ui.029") : knowledge.workspaceId}</dd></div><div><dt>{t("knowledge.ui.030")}</dt><dd>{knowledge.scopeIds.map(scopeLabel).join(' · ')}</dd></div><div><dt>{t("knowledge.ui.054")}</dt><dd>{categoryLabels[knowledge.category] ?? knowledge.category}</dd></div><div><dt>{t("knowledge.ui.015")}</dt><dd>{resource.sourceVersion.slice(0, 12)}</dd></div></dl><div className={css.versionHeader}><History size={16}/><div><strong>{t("knowledge.ui.035")}</strong><small>{versions.length}{t("knowledge.ui.055")}</small></div></div><div className={css.versionList}>{[...versions].reverse().map(version => { const current = version.version === latest?.version, viewing = selected?.version === version.version; return <button key={version.version} type="button" aria-label={t('knowledge.versionAria',{version:version.version})} aria-current={viewing ? 'true' : undefined} disabled={busy || dirty} onClick={() => void read(version.version)}><span>{current ? <Check size={15}/> : <Clock3 size={15}/>}<strong>v{version.version}</strong>{current && <em>{t("knowledge.ui.056")}</em>}{viewing && !current && <em>{t("knowledge.ui.057")}</em>}</span><small>{displayTime(version.createdAt,locale)} · {displaySize(version.bytes,locale)}</small><ChevronRight size={15}/></button>; })}</div>{dirty && <p className={css.historyHint}>{t("knowledge.ui.058")}</p>}</aside>}
  </div>
 </section>;
}
function FileTextFallback() { return <span className={css.readonlyIcon} aria-hidden="true">MD</span>; }
