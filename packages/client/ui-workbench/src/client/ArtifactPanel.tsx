import markdownTypography from "./MarkdownTypography.module.css"
import { TaskArtifactPicker, type TaskArtifactPort } from './TaskArtifactPicker.js';
import { artifactDraftKey, clearArtifactRevision, recoverArtifactRevision, hasArtifactRevision, type ArtifactDraft as Draft } from './artifact-drafts.js';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronRight, Download, FileText, Maximize2, Minimize2, Save, Send, X } from 'lucide-react';
import {createPortal} from 'react-dom';
import clsx from 'clsx';
import {ArtifactPanelHeader} from './ArtifactPanelHeader.js';
import { artifactMarkdown, sourceKey, sourceStamp, type ArtifactRef, type ArtifactSource, type ArtifactSourceRef } from './artifact-preview.js';
import { resolveArtifactSource, type ArtifactConversation } from './artifact-source.js';
import type { ArtifactWorkChange } from './artifact-work.js';
import type { TaskPreview } from './task-preview.js';
import { type NativeArtifactApi } from './artifact-native.js';
import { ArtifactMessages } from './NativeArtifactPicker.js';
import {TaskRunArtifactPicker} from './TaskRunArtifactPicker.js';
import {MarkdownPreview} from './knowledge-markdown.js';
import type {TaskRunApi} from './task-run-api.js';
import { ArtifactFiles } from './ArtifactFiles.js';
import { fileSetKey, type ArtifactFileApi, type ArtifactFileDraft } from './artifact-files.js';
import { ArtifactPanelMoreActions, artifactPanelArtifacts, artifactPanelMoreActions, artifactPanelStart, type ArtifactPanelView } from './artifact-panel-presentation.js';
import base from './TaskPage.module.css';
import css from './ArtifactPanel.module.css';
import {useI18n} from './i18n/provider.js';
import {localizeWorkError} from './i18n/errors.js';
import {useBusinessScopes} from './business-scope-context.js';
import type {MethodReuseTarget} from '@teloa/contract';
import {canPrepareArtifactMethodReuse} from './artifact-method-reuse-preparation.ts';
export type ArtifactTarget = {
    source: ArtifactSourceRef;
    artifact?: {id:string;version?:number};
    initialView?: 'files';
    initialAction?: 'prepare';
};
export type OpenArtifacts = (source: ArtifactSourceRef, artifact?: ArtifactRef) => void;
const blank: Draft = { title: '', body: '', note: '', feedback: '', feedbackId: '', stamp: '' };
type Props = {
    messageAuthor?:string|undefined;
    taskSources: TaskArtifactPort;
    taskRuns?: Pick<TaskRunApi,'list'|'chatPresentation'>;
    recovery?: {
        message?: unknown;
        pending: () => {
            key: string;
            title: string;
        }[];
        resume: (key: string) => Promise<{
            id: string;
            version: number;
        }>;
    };
    loadError?: string;
    target: ArtifactTarget | null;
    open?: boolean;
    /** 右栏和更大视图复用同一个实例，版本与反馈草稿不随容器切换重建。 */
    inline?: boolean;
    portal?: HTMLElement | null;
    state: TaskPreview;
    conversation: ArtifactConversation | undefined;
    nativeArtifacts: NativeArtifactApi;
    artifactFileApi: ArtifactFileApi;
    close: () => void;
    change: (change: ArtifactWorkChange) => Promise<string | void>;
    openSource: (ref: ArtifactSourceRef) => void | Promise<void>;
    openTask: (id: string) => void;
    revisionIdentity?:object;
    methodReuseIdentity?:object;
    requestMethodReuse?:(artifactId:string,version:number,target:MethodReuseTarget,mayContinue?:(afterNavigation?:boolean)=>boolean)=>Promise<void>;
    requestRevision?:(artifactId:string,version:number,feedbackId:string,mayContinue?:(afterNavigation?:boolean)=>boolean)=>Promise<void>;
};
export function ArtifactPanel({ messageAuthor, taskSources, taskRuns, recovery, loadError, target, open = true, inline = false, portal, state, conversation, nativeArtifacts, artifactFileApi, close, change, openSource, openTask, requestRevision, revisionIdentity, requestMethodReuse, methodReuseIdentity }: Props) {
    const {locale,t}=useI18n(), scopeNames=useBusinessScopes();
    const dialog = useRef<HTMLDialogElement>(null), [selected, setSelected] = useState<string | null>(null), [versionNumber, setVersion] = useState(1), [sectionId, setSection] = useState(''), [view, setView] = useState<ArtifactPanelView>('preview'), [error, setError] = useState(''), [notice, setNotice] = useState(''), [drafts, setDrafts] = useState<Record<string, Draft>>({}), [linkId, setLinkId] = useState('');
    const [readingSaved,setReadingSaved]=useState(false);
    const targetKey = target ? JSON.stringify(target) : '';
    const composing = useRef(false);
    const persistentSource = !!target && (target.source.kind === 'session' || target.source.kind === 'task' && state.tasks.some(task => task.id === target.source.id && task.storage === 'persistent'));
    const visibleArtifacts = artifactPanelArtifacts(state.artifacts,persistentSource);
    const rows = target ? visibleArtifacts.filter(item => sourceKey(item.source) === sourceKey(target.source) || target.source.kind==='task'&&item.revisions?.some(revision=>revision.taskId===target.source.id) || target.source.kind==='task'&&item.produced?.some(producer=>producer.taskId===target.source.id) || item.links.some(link => sourceKey(link.object) === sourceKey(target.source))) : [];
    // 固定引用可能早于目标版本载入；同一成果新增版本也必须重新核对缺失的初始选择。
    const rowsKey = JSON.stringify(rows.map(item => [item.id,item.versions.map(version=>version.number)]));
    const [busy, setBusy] = useState(false), busyRef = useRef(false), currentTarget = useRef(targetKey);
    currentTarget.current = targetKey;
    const revisionLifetime=useRef(true),revisionPending=useRef<object|null>(null),revisionOwner=useRef({targetKey,open,revisionIdentity,methodReuseIdentity,selected,versionNumber,sectionId});
    const previousRevisionOwner=revisionOwner.current;
    if(previousRevisionOwner.targetKey!==targetKey||previousRevisionOwner.open!==open||previousRevisionOwner.revisionIdentity!==revisionIdentity||previousRevisionOwner.methodReuseIdentity!==methodReuseIdentity||previousRevisionOwner.selected!==selected||previousRevisionOwner.versionNumber!==versionNumber||previousRevisionOwner.sectionId!==sectionId)revisionOwner.current={targetKey,open,revisionIdentity,methodReuseIdentity,selected,versionNumber,sectionId};
    useLayoutEffect(()=>{revisionLifetime.current=true;return()=>{revisionLifetime.current=false}},[]);
    useLayoutEffect(()=>{
        if(revisionPending.current&&revisionPending.current!==revisionOwner.current){revisionPending.current=null;busyRef.current=false;setBusy(false);setError('');setNotice('')}
    },[targetKey,open,revisionIdentity,methodReuseIdentity,selected,versionNumber,sectionId]);
    const [fileDrafts, setFileDrafts] = useState<Record<string, ArtifactFileDraft>>({});
    const [expanded,setExpanded]=useState(false);
    const [showList,setShowList]=useState(!target?.artifact&&!target?.initialAction);
    // Esc 退出放大后焦点回到发起放大的按钮：此时焦点可能已落在 body，关闭再重开的默认交接会把焦点拽进名称输入框。
    const expandToggle=useRef<HTMLButtonElement>(null), restoreToggle=useRef(false);
    const present=(node:ReactNode)=>portal?createPortal(node,portal):node;
    const panelClass=clsx(base.dialog,css.panel,inline&&css.inline,inline&&expanded&&css.expanded);
    useLayoutEffect(() => {
        if (!open || !target) return;
        const start = artifactPanelStart(rows.map(item => ({ id: item.id, primary: item.primary, updatedAt: item.versions.at(-1)!.at, versions:item.versions.map(version=>version.number) })), target?.artifact?.id,!!target?.artifact,target?.artifact?.version);
        const item = rows.find(row => row.id === start.selected);
        setReadingSaved(false);
        setSelected(start.selected);
        setVersion(target?.artifact?.id === start.selected ? (target.artifact.version ?? item?.versions.at(-1)?.number ?? 1) : (item?.links.find(link => target && sourceKey(link.object) === sourceKey(target.source))?.artifactVersion || item?.versions.at(-1)?.number || 1));
        setSection('');
        setView(target.initialView??'preview');
        setError('');
        setNotice('');
        setLinkId('');
        setExpanded(false);
        setShowList(!target.artifact&&!target.initialAction);
        composing.current = false;
    }, [targetKey, open]);
    useEffect(() => {
        if (!target || !rows.length)
            return;
        setSelected(current => {
            if (current && rows.some(item => item.id === current))
                return current;
            const start = artifactPanelStart(rows.map(item => ({ id: item.id, primary: item.primary, updatedAt: item.versions.at(-1)!.at, versions:item.versions.map(version=>version.number) })), target.artifact?.id,!!target.artifact,target.artifact?.version), item = rows.find(row => row.id === start.selected);
            setVersion(target.artifact?.id === start.selected ? (target.artifact.version ?? item?.versions.at(-1)?.number ?? 1) : (item?.versions.at(-1)?.number || 1));
            setSection('');
            setView(target.initialView??'preview');
            return start.selected;
        });
    }, [rowsKey, targetKey]);
    useLayoutEffect(() => {
        if (!open || !target)
            return;
        const node = dialog.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null, media = window.matchMedia('(max-width:1080px)'), narrow = window.matchMedia('(max-width:760px)');
        const show = () => { if (!node)
            return; const focused = node.contains(document.activeElement) ? document.activeElement as HTMLElement : null; node.close(); if (inline ? expanded || narrow.matches : media.matches || !!document.querySelector('dialog[open]:modal'))
            node.showModal();
        else
            node.show(); ((restoreToggle.current ? expandToggle.current : null) || focused || node.querySelector<HTMLElement>('[data-artifact-close]') || node.querySelector<HTMLElement>('header button'))?.focus(); restoreToggle.current = false; };
        show();
        media.addEventListener('change', show);
        narrow.addEventListener('change', show);
        return () => { media.removeEventListener('change', show); narrow.removeEventListener('change', show); node?.close(); if (previous?.isConnected && previous.getClientRects().length)
            previous.focus(); };
    }, [open, targetKey, inline, expanded, portal]);
    useLayoutEffect(()=>{
        if(!open||!target)return;
        let frame=0,attempts=0;
        // 右栏宿主可能下一帧才解除 hidden；只补交给当前预览的返回控件，不夺取已有内部焦点。
        const focus=()=>{
            const node=dialog.current,button=node?.querySelector<HTMLButtonElement>('[data-artifact-close]')??node?.querySelector<HTMLButtonElement>('header button');
            if(!node||!button)return;
            const active=node.ownerDocument.activeElement;
            if(active instanceof HTMLElement&&active!==node&&node.contains(active)&&active.getClientRects().length)return;
            if(button.getClientRects().length)button.focus();if(document.activeElement!==button&&attempts++<2)frame=requestAnimationFrame(focus);
        };
        focus();return()=>cancelAnimationFrame(frame);
    },[open,targetKey,portal]);
    if (!open || !target)
        return null;
    const closingBlocked=busy&&!revisionPending.current;
    const back=()=>{if(!closingBlocked)close()};
    const onKeyDown=(event:KeyboardEvent<HTMLDialogElement>)=>{if(event.key!=='Escape'||event.defaultPrevented)return;if(composing.current||event.nativeEvent.isComposing||event.nativeEvent.keyCode===229){event.stopPropagation();event.preventDefault();return}if(!event.currentTarget.matches(':modal')){event.stopPropagation();event.preventDefault();back()}};
    const onCancel=(event:SyntheticEvent<HTMLDialogElement>)=>{if(event.target!==event.currentTarget)return;event.stopPropagation();event.preventDefault();if(closingBlocked||composing.current)return;if(inline&&expanded){restoreToggle.current=true;setExpanded(false)}else close()};
    const fallback = artifactPanelStart(rows.map(item => ({ id: item.id, primary: item.primary, updatedAt: item.versions.at(-1)!.at, versions:item.versions.map(version=>version.number) })), target.artifact?.id,!!target.artifact,target.artifact?.version);
    if(fallback.mode==='missing')return present(<dialog ref={dialog} className={panelClass} aria-label={t("artifact.panel.text.006")} onKeyDown={onKeyDown} onCancel={onCancel}><p role="alert">{loadError||t('error.notFound')}</p><button type="button" disabled={closingBlocked} onClick={back}>{inline?t('overview.back'):t("artifact.panel.text.009")}</button></dialog>);
    const retainedDraftKey='new:'+sourceKey(target.source);
    const retainedDraft=!readingSaved&&!target.artifact&&(drafts[retainedDraftKey]!==undefined||fileDrafts[retainedDraftKey]!==undefined);
    const selectedId = retainedDraft ? null : selected && rows.some(item => item.id === selected) ? selected : fallback.selected;
    const artifact = state.artifacts.find(item => item.id === selectedId), version = artifact?.versions.find(item => item.number === versionNumber) || artifact?.versions.at(-1), latest = artifact?.versions.at(-1);
    const section = version?.sections.find(item => item.id === sectionId) || version?.sections[0];
    let source: ArtifactSource | undefined, sourceError = '';
    try {
        source = resolveArtifactSource(state, artifact?.source || target.source, conversation);
    }
    catch (error) {
        sourceError = localizeWorkError(locale,error);
    }
    const key = artifact && version ? artifactDraftKey(artifact.id, version.number, section!.id) : 'new:' + sourceKey(target.source);
    const initial: Draft = { ...blank, title: source?.title || '', body: section?.text || '', stamp: source ? sourceStamp(source) : '' };
    const draft = drafts[key] || initial;
    const fileKey = artifact && version ? JSON.stringify([artifact.id, version.number]) : 'new:' + sourceKey(target.source);
    const fileDraft = fileDrafts[fileKey] || { files: version?.files || [], form: { query: '', candidate: null }, note: '', stamp: source ? sourceStamp(source) : '' };
    const patchFiles = (patch: Partial<ArtifactFileDraft>) => setFileDrafts(current => ({ ...current, [fileKey]: { ...(current[fileKey] || fileDraft), ...patch } }));
    const clearFiles = () => setFileDrafts(current => { const next = { ...current }; delete next[fileKey]; return next; });
    const patch = (value: Partial<Draft>) => setDrafts(current => ({ ...current, [key]: { ...(current[key] || initial), ...value } }));
    const clearDraft = () => setDrafts(current => { const next = { ...current }; delete next[key]; return next; });
    const act = async (command: ArtifactWorkChange) => { if (busyRef.current)
        return false; busyRef.current = true; setBusy(true); try {
        const id = await change(command);
        if (currentTarget.current !== targetKey)
            return false;
        setError('');
        setNotice(persistentSource ? t("artifact.panel.text.003") : t("artifact.panel.text.004"));
        return id || true;
    }
    catch (error) {
        if (currentTarget.current === targetKey)
            setError(localizeWorkError(locale,error));
        return false;
    }
    finally {
        busyRef.current = false;
        setBusy(false);
    } };
    const reviewTask = artifact?.source.kind === 'task' ? state.tasks.find(task => task.id === artifact.source.id && task.approvalRequired && !['completed', 'cancelled'].includes(task.state)) : undefined;
    const locked = artifact?.source.kind === 'task' && state.tasks.some(task => task.id === artifact.source.id && ['completed', 'cancelled'].includes(task.state));
    const moreActions = artifactPanelMoreActions(artifact?.storage, locked);
    const markdown = artifact && version ? artifactMarkdown(artifact, version.number,t) : '';
    const choose = (id: string, number?: number) => { setReadingSaved(true); setShowList(false); const item = state.artifacts.find(item => item.id === id)!,same=selected===id; setSelected(id); setVersion(number ?? (same?versionNumber:item.links.find(link => sourceKey(link.object) === sourceKey(target.source))?.artifactVersion ?? item.versions.at(-1)!.number)); if(!same)setSection(''); setView('preview'); setError(''); setNotice(''); };
    const sourceBody = target.source.kind === 'analysis' ? state.business.runs.find(item => item.id === target.source.id && item.scope === ('scope' in target.source ? target.source.scope : ''))?.result : target.source.kind === 'object' ? state.business.objects.find(item => item.id === target.source.id && 'scope' in target.source && item.scope === target.source.scope && 'objectType' in target.source && item.type === target.source.objectType)?.summary : target.source.kind === 'task' ? state.tasks.find(item => item.id === target.source.id)?.result : target.source.kind === 'run' ? state.continuous.runs.find(item => item.id === target.source.id)?.output : undefined;
    const previewBody=drafts[key]?.body??sourceBody??'';
    const savedBody=version?.sections.every((item,index)=>item.id==='section-'+(index+1)&&item.title==='段落 '+(index+1))?version.sections.map(item=>item.text).join('\n\n'):null;
    const linkOptions = artifactPanelArtifacts(state.artifacts,persistentSource).flatMap(item => item.versions.filter(v => !v.source.private && v.source.scope === source?.scope).map(v => ({ value: JSON.stringify([item.id, v.number]), artifact: { id: item.id, version: v.number }, label: v.title + ' · v' + v.number })));
    const goToSource=async(ref:ArtifactSourceRef)=>{try{await openSource(ref);if(currentTarget.current===targetKey)close()}catch(cause){if(currentTarget.current===targetKey)setError(localizeWorkError(locale,cause))}};
    return present(<dialog ref={dialog} className={panelClass} aria-label={t("artifact.panel.text.006")} onKeyDown={onKeyDown} onCancel={onCancel} onCompositionStart={()=>{composing.current=true}} onCompositionEnd={()=>{composing.current=false}}>
    <ArtifactPanelHeader count={rows.length}>
      {artifact&&version&&!showList&&<a aria-label={t('artifactFiles.download')} title={t('artifactFiles.download')} download={'teloa-'+artifact.id.replace(/[^\w-]/g,'_')+'-v'+version.number+'.md'} href={'data:text/markdown;charset=utf-8,'+encodeURIComponent(markdown)}><Download size={16}/></a>}
      {inline&&<button type="button" data-artifact-expand ref={expandToggle} aria-label={t(expanded?'artifactFiles.collapseImage':'artifactFiles.expandImage')} title={t(expanded?'artifactFiles.collapseImage':'artifactFiles.expandImage')} onClick={()=>setExpanded(value=>!value)}>{expanded?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</button>}
      <button type="button" data-artifact-close aria-label={t('artifact.panel.text.009')} disabled={closingBlocked} onClick={back}><X size={18}/></button>
    </ArtifactPanelHeader>
    <fieldset disabled={busy} className={css.layout}><article className={css.content} aria-label={t('artifact.panel.text.021')}>
      {!showList&&rows.length>0&&<button type="button" className={css.back} onClick={()=>setShowList(true)}><ArrowLeft size={15} aria-hidden/>{t('artifact.panel.allResults')}</button>}
      {!!recovery?.message && <p role="alert">{localizeWorkError(locale,recovery.message)}</p>}
      {recovery?.pending().map(item => <button type="button" key={item.key} onClick={async () => { if (busyRef.current)
        return; busyRef.current = true; setBusy(true); try {
        const saved = await recovery.resume(item.key);
        if (currentTarget.current === targetKey) {
            setShowList(false);
            setSelected(saved.id);
            setVersion(saved.version);
            setView('preview');
            setError('');
            setNotice(t("artifact.panel.text.013"));
        }
    }
    catch (cause) {
        if (currentTarget.current === targetKey)
            setError(localizeWorkError(locale,cause));
    }
    finally {
        busyRef.current = false;
        setBusy(false);
    } }}>{t("artifact.panel.text.015")}{item.title}</button>)}
      {loadError && (target.source.kind === 'session' || target.source.kind === 'task') && <p role="alert">{loadError}{t("artifact.panel.text.022")}</p>}{busy && <p role="status">{t("artifact.panel.text.023")}</p>}{error && <p role="alert" className={base.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
      {sourceError && <p role="status">{sourceError}{t("artifact.panel.text.024")}</p>}
      {showList&&rows.length>0?<section className={css.resultList} aria-label={t('artifact.panel.allResults')}>
        <header><h3>{source?.title||t('artifact.panel.text.006')}</h3><p>{t('artifact.panel.listHelp')}</p></header>
        {rows.map(item=>{const linked=item.links.find(link=>sourceKey(link.object)===sourceKey(target.source))?.artifactVersion,current=item.versions.find(row=>row.number===(item.id===selectedId?versionNumber:linked))??item.versions.at(-1)!;return <button type="button" className={css.resultRow} key={item.id} onClick={()=>choose(item.id)}>
          <FileText size={17} aria-hidden/><span><strong>{current.title}</strong><span className={css.resultSummary}>{current.note||current.sections[0]?.text.replace(/[#*`>]/g,'').trim()}</span><small>{item.primary?t('artifact.panel.text.043')+' · ':''}v{current.number} · {current.author} · {t('artifact.panel.text.017',{count:item.versions.length})}</small></span><ChevronRight size={16} aria-hidden/>
        </button>})}
      </section>:!artifact ? <section className={css.createMode} aria-label={t("artifact.panel.text.048")}>
        {target.source.kind==='task'&&persistentSource&&taskRuns&&<TaskRunArtifactPicker preservePreview={!!previewBody||!!fileDraft.files.length} key={sourceKey(target.source)} taskId={target.source.id} api={taskRuns} port={taskSources} native={nativeArtifacts} selected={draft.messages??[]} select={message=>patch({body:message?.text??'',messages:message?[message]:[],stamp:source?sourceStamp(source):''})}/>}
        <header><h3>{drafts[key]?.title||source?.title||t('artifact.panel.text.019')}</h3>{!previewBody&&!fileDraft.files.length&&<p>{t('artifact.panel.emptyHelp')}</p>}</header>
        {previewBody&&<section className={css.preview}><div className={[css.markdown,markdownTypography.typography].join(" ")}><MarkdownPreview markdown={previewBody} images={false}/></div></section>}
        {!!draft.messages?.length&&<ArtifactMessages messages={draft.messages} api={nativeArtifacts} enabled={!!source}/>}
        {!!fileDraft.files.length&&<ArtifactFiles sessionId={target.source.id} api={artifactFileApi} files={fileDraft.files} enabled={false} form={{query:'',candidate:null}} changeForm={()=>{}}/>}

        {source&&!previewBody&&!fileDraft.files.length&&<button type="button" className={css.sourceLink} title={t('artifact.panel.text.031')} onClick={()=>void goToSource(source.ref)}><span>{t('artifact.panel.text.031')}</span><ArrowUpRight size={15} aria-hidden/></button>}
      </section> : version ? <>
        <header className={css.artifactHeader}><div><span>{artifact.primary ? t("artifact.panel.text.043") : t("artifact.panel.text.006")} · v{version.number}</span><h3>{version.title}</h3><p>{version.author} · {new Date(version.at).toLocaleString(locale)} · {version.note}</p></div></header>
        <nav className={css.tabs} aria-label={t("artifact.panel.text.044")}><button type="button" aria-current={view === 'preview' ? 'page' : undefined} onClick={() => setView('preview')}>{t("artifact.panel.text.045")}</button><button type="button" aria-current={view === 'files' ? 'page' : undefined} onClick={() => setView('files')}>{t("artifact.panel.text.046")}</button><button type="button" aria-current={view === 'versions' ? 'page' : undefined} onClick={() => setView('versions')}>{t("artifact.panel.text.047")}</button></nav>
        {view==='preview'&&<div className={css.previewActions}>{moreActions.showLinkAndReview&&reviewTask&&<button type="button" aria-label={t('artifact.panel.text.088')} title={t('artifact.panel.text.088')} disabled={reviewTask.reviewArtifact?.id===artifact.id&&reviewTask.reviewArtifact.version===version.number} onClick={()=>act({type:'review',artifact:{id:artifact.id,version:version.number},expectedTaskVersion:reviewTask.version,now:new Date().toISOString()})}><Send size={16}/></button>}</div>}
        {view === 'preview' && <section className={clsx(css.preview,css.markdown,markdownTypography.typography)} aria-label={t("artifact.panel.text.048")}>{savedBody!==null?<MarkdownPreview markdown={savedBody} images={false}/>:version.sections.map(item => <section key={item.id}><h4>{item.title}</h4><MarkdownPreview markdown={item.text} images={false}/></section>)}</section>}
        {view === 'files' && <section className={css.filesView} aria-label={t("artifact.panel.text.046")}><section className={base.block}><h3>{t("artifact.panel.text.029")}</h3><p>{(source || version.source).title} · {(source || version.source).scope}</p><button type="button" onClick={() => { void goToSource(version.source.ref) }}>{t("artifact.panel.text.031")}</button><dl className={css.sourceFacts}><dt>{t("artifact.panel.text.050")}</dt><dd>{version.source.ref.kind} · {version.source.ref.id} · {version.source.version}</dd><dt>{t("artifact.panel.text.051")}</dt><dd>{version.source.author}</dd><dt>{t("artifact.panel.text.052")}</dt><dd>{version.source.private ? t("artifact.panel.text.053") : t("artifact.panel.text.054")}</dd></dl>{version.source.evidence.length ? <details><summary>{t("artifact.panel.text.055")}</summary><ul>{version.source.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : <p>{t("artifact.panel.text.056")}</p>}</section>
          <ArtifactMessages key={artifact.id + ':' + version.number} messages={version.messages || []} api={nativeArtifacts} enabled={!!source && source.ref.kind === 'session' && source.ref.id === conversation?.id}/>
          {(artifact.source.kind === 'session' || artifact.source.kind === 'task') ? <section className={base.block}><ArtifactFiles label={t("artifact.panel.text.057") + version.number} sessionId={artifact.source.id} api={artifactFileApi} files={version.files || []} enabled={false} form={{ query: '', candidate: null }} changeForm={() => { }}/>{version.number === latest?.number && !locked && <details><summary>{t("artifact.panel.text.058")}</summary>{artifact.source.kind === 'task' ? <TaskArtifactPicker key={fileKey} filesOnly taskId={artifact.source.id} port={taskSources} native={nativeArtifacts} filesApi={artifactFileApi} messages={[]} files={fileDraft.files} setMessages={() => { }} setFiles={files => patchFiles({ files })} enabled={!!source}/> : <ArtifactFiles key={fileKey} label={t("artifact.panel.text.059")} sessionId={artifact.source.id} api={artifactFileApi} files={fileDraft.files} enabled={!!source} form={fileDraft.form} changeForm={form => patchFiles({ form })} changeFiles={files => patchFiles({ files })}/>}</details>}{version.number === latest?.number && fileSetKey(fileDraft.files) !== fileSetKey(version.files || []) && <div className={base.form}><p>{t("artifact.panel.text.060")}</p><label>{t("artifact.panel.text.061")}<textarea maxLength={4000} value={fileDraft.note} onChange={event => patchFiles({ note: event.target.value })}/></label><button type="button" disabled={!source || locked || !fileDraft.note.trim()} onClick={async () => { if (await act({ type: 'change', id: artifact.id, expectedSource: fileDraft.stamp, change: { type: 'files', expectedVersion: version.number, files: fileDraft.files, note: fileDraft.note, now: new Date().toISOString() } })) {
                clearFiles();
                setVersion(version.number + 1);
            } }}>{artifact.storage === 'persistent' ? t("artifact.panel.text.062") : t("artifact.panel.text.063")}</button><button type="button" onClick={clearFiles}>{t("artifact.panel.text.064")}</button></div>}{version.number !== latest?.number && fileDrafts[fileKey] && (fileSetKey(fileDraft.files) !== fileSetKey(version.files || []) || !!fileDraft.form.candidate) && <details><summary>{t("artifact.panel.text.065")}</summary><ArtifactFiles sessionId={artifact.source.id} api={artifactFileApi} files={fileDraft.files} enabled={false} form={fileDraft.form} changeForm={() => { }}/>{fileDraft.form.candidate && <ArtifactFiles label={t("artifact.panel.text.066")} sessionId={artifact.source.id} api={artifactFileApi} files={[fileDraft.form.candidate]} enabled={false} form={{ query: '', candidate: null }} changeForm={() => { }}/>}<p>{t("artifact.panel.text.067")}</p><button type="button" onClick={clearFiles}>{t("artifact.panel.text.068")}</button></details>}</section> : <section className={base.block}><p>{t("artifact.panel.text.069")}</p></section>}
        </section>}
        {view === 'versions' && <section className={css.versionsView} aria-label={t("artifact.panel.text.047")}><section className={base.block}><h3>{t("artifact.panel.text.070")}</h3><label className={css.version}>{t("artifact.panel.text.071")}<select aria-label={t("artifact.panel.text.072")} value={version.number} onChange={event => { setVersion(Number(event.target.value)); setSection(''); setError(''); setNotice(''); }}>{artifact.versions.map(item => <option key={item.number} value={item.number}>v{item.number} · {item.note}</option>)}</select></label><p>{t("artifact.panel.text.073",{count:artifact.versions.length,version:version.number})}{version.number === latest?.number ? t("artifact.panel.text.074") : t("artifact.panel.text.075")}</p></section>
          {version.sections.map(item => <button type="button" className={css.sectionChoice} key={item.id} aria-pressed={section?.id === item.id} onClick={() => setSection(item.id)}><strong>{item.title}</strong><span>{t("artifact.panel.text.076",{count:artifact.feedback.filter(feedback => feedback.version === version.number && feedback.sectionId === item.id).length})}</span></button>)}
          {section && <section className={base.block}><h3>{t("artifact.panel.text.077")}{section.title} · v{version.number}</h3><ol>{artifact.feedback.filter(item => item.version === version.number && item.sectionId === section.id).map(item => <li key={item.id}><p>{item.text}</p><small>{item.author} · {new Date(item.at).toLocaleString(locale)}{artifact.versions.some(v => v.feedbackId === item.id) ? t("artifact.panel.text.078") : ''}</small>{artifact.revisions?.filter(revision=>revision.feedbackId===item.id).map(revision=><p key={revision.id}>{t(revision.state==='conflict'?'artifact.revision.conflict':revision.state==='completed'?'artifact.revision.completed':'artifact.revision.pending')}{revision.taskId&&<button type="button" onClick={()=>openTask(revision.taskId!)}>{t('artifact.revision.openTask')}</button>}</p>)}{requestRevision&&artifact.storage==='persistent'&&version.source.scope==='general'&&version.number===latest?.number&&!artifact.versions.some(v=>v.feedbackId===item.id)&&<button type="button" disabled={busy} onClick={async()=>{
                if(busyRef.current)return;
                const origin=revisionOwner.current;revisionPending.current=origin;busyRef.current=true;setBusy(true);setError('');
                // Frame 只在本次原生导航已提交后允许入口收起；卸载始终撤销后续派发。
                const current=(afterNavigation=false)=>revisionLifetime.current&&(afterNavigation||revisionPending.current===origin&&revisionOwner.current===origin);
                try{await requestRevision(artifact.id,version.number,item.id,current);if(current())setNotice(t('artifact.revision.sent'))}
                catch(cause){if(current())setError(localizeWorkError(locale,cause))}
                finally{if(current()){revisionPending.current=null;busyRef.current=false;setBusy(false)}}
              }}>{t('artifact.revision.send')}</button>}</li>)}</ol><form className={base.form} onSubmit={async (event) => { event.preventDefault(); if (await act({ type: 'change', id: artifact.id, expectedSource: draft.stamp, change: { type: 'feedback', id: crypto.randomUUID(), version: version.number, sectionId: section.id, text: draft.feedback, now: new Date().toISOString() } }))
                patch({ feedback: '' }); }}><label>{t("artifact.panel.text.079")}<textarea required rows={3} maxLength={4000} value={draft.feedback} onChange={event => patch({ feedback: event.target.value })}/></label><button type="submit" disabled={!draft.feedback.trim()}>{artifact.storage === 'persistent' ? t("artifact.panel.text.080") : t("artifact.panel.text.081")}</button></form></section>}
          <details className={clsx(base.block, css.moreActions)}><summary>{t("artifact.panel.text.082")}</summary>
            {requestMethodReuse&&canPrepareArtifactMethodReuse(artifact,version.number)&&<div className={base.buttons}>{(['skill','plan'] as const).map(target=><button key={target} type="button" disabled={busy} title={t('artifact.method.prepareOnly')} onClick={async()=>{
                if(busyRef.current)return;
                const origin=revisionOwner.current;revisionPending.current=origin;busyRef.current=true;setBusy(true);setError('');
                const current=(afterNavigation=false)=>revisionLifetime.current&&(afterNavigation||revisionPending.current===origin&&revisionOwner.current===origin);
                try{await requestMethodReuse(artifact.id,version.number,target,current)}
                catch(cause){if(current()&&!(cause&&typeof cause==='object'&&'code' in cause&&cause.code==='teloa/cancelled'))setError(localizeWorkError(locale,cause))}
                finally{if(current()){revisionPending.current=null;busyRef.current=false;setBusy(false)}}
              }}>{t(target==='skill'?'artifact.method.skill':'artifact.method.plan')}</button>)}</div>}
            <ArtifactPanelMoreActions actions={moreActions} activeBoundary={t("artifact.panel.text.121")} lockedBoundary={t("artifact.panel.text.122")}
              link={target.source.kind === 'object' && source && <form className={base.form} onSubmit={async (event) => { event.preventDefault(); const option = linkOptions.find(item => item.value === linkId); if (option && target.source.kind === 'object')
                act({ type: 'link', artifact: option.artifact, object: target.source, now: new Date().toISOString() }); }}><label>{t("artifact.panel.text.083")}<select value={linkId} onChange={event => setLinkId(event.target.value)}><option value="">{t("artifact.panel.text.084")}</option>{linkOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><button disabled={!linkId} type="submit">{t("artifact.panel.text.085")}</button></form>}
              review={null}
              follow={<section><h3>{t("artifact.panel.text.089")}</h3><p>{t("artifact.panel.text.090")}</p><form className={base.form} onSubmit={async (event) => { event.preventDefault(); const id = crypto.randomUUID(); if (await act({ type: 'follow', id, artifact: { id: artifact.id, version: version.number }, goal: draft.followGoal || '', now: new Date().toISOString() })) {
                close();
                openTask(id);
            } }}><label>{t("artifact.panel.text.091")}<textarea required maxLength={4000} value={draft.followGoal || ''} onChange={event => patch({ followGoal: event.target.value })}/></label><button disabled={!draft.followGoal?.trim()} type="submit">{t("artifact.panel.text.092")}</button></form></section>}
              revision={<>{version.number === latest?.number && section && <details><summary>{t("artifact.panel.text.093")}</summary><form className={base.form} onSubmit={async (event) => { event.preventDefault(); if (await act({ type: 'change', id: artifact.id, expectedSource: draft.stamp, change: { type: 'revise', expectedVersion: version.number, sectionId: section.id, text: draft.body, note: draft.note, ...(draft.feedbackId ? { feedbackId: draft.feedbackId } : {}), now: new Date().toISOString() } })) {
                setDrafts(current => clearArtifactRevision(current, artifact, version.number, section.id));
                setVersion(version.number + 1);
            } }}><label>{t("artifact.panel.text.094")}<textarea required rows={6} maxLength={16000} value={draft.body} onChange={event => patch({ body: event.target.value })}/></label><label>{t("artifact.panel.text.095")}<textarea required maxLength={4000} value={draft.note} onChange={event => patch({ note: event.target.value })}/></label><label>{t("artifact.panel.text.096")}<select value={draft.feedbackId} onChange={event => patch({ feedbackId: event.target.value })}><option value="">{t("artifact.panel.text.097")}</option>{artifact.feedback.filter(item => item.version === version.number && item.sectionId === section.id).map(item => <option key={item.id} value={item.id}>{item.text.slice(0, 80)}</option>)}</select></label><button type="submit" disabled={!source || !draft.body.trim() || !draft.note.trim()}>{artifact.storage === 'persistent' ? t("artifact.panel.text.098") : t("artifact.panel.text.099")}</button><button type="button" onClick={() => setDrafts(current => clearArtifactRevision(current, artifact, version.number, section.id))}>{t("artifact.panel.text.100")}</button></form></details>}{(!section || version.number !== latest?.number) && <p>{t("artifact.panel.text.101")}</p>}</>}
              exportAction={<details><summary>{t("artifact.panel.text.102")}{version.number}</summary><p>{t("artifact.panel.text.103")}</p><div className={base.buttons}><button type="button" onClick={() => { void navigator.clipboard.writeText(markdown).then(() => setNotice(t("artifact.panel.text.104")), () => setError(t("artifact.panel.text.105"))); }}>{t("artifact.panel.text.106")}</button><a download={'teloa-' + artifact.id.replace(/[^\w-]/g, '_') + '-v' + version.number + '.md'} href={'data:text/markdown;charset=utf-8,' + encodeURIComponent(markdown)}>{t("artifact.panel.text.107")}</a></div><textarea aria-label={t("artifact.panel.text.108")} readOnly rows={10} value={markdown}/></details>}/>
          </details>
          {section && latest && (locked || version.number !== latest.number) && hasArtifactRevision(drafts[key], section) && <section className={base.block}><h3>{t("artifact.panel.text.109")}</h3><p>{locked ? t("artifact.panel.text.110") : t("artifact.panel.text.111")}</p><label>{t("artifact.panel.text.112")}<textarea aria-label={t("artifact.panel.text.112")} readOnly rows={5} value={draft.body}/></label><p>{draft.note}</p><label>{t("artifact.panel.text.113")}<textarea aria-label={t("artifact.panel.text.113")} readOnly rows={5} value={latest.sections.find(item => item.id === section.id)?.text || ''}/></label><div className={base.buttons}><button type="button" disabled={!source || locked} onClick={() => { try {
                setDrafts(recoverArtifactRevision(drafts, artifact, version.number, section.id, source!));
                setVersion(latest.number);
                setNotice(t("artifact.panel.text.114"));
                setError('');
            }
            catch (error) {
                setError(localizeWorkError(locale,error));
            } }}>{t("artifact.panel.text.116")}</button><button type="button" onClick={() => { setVersion(latest.number); setError(''); }}>{t("artifact.panel.text.117")}</button></div></section>}
        </section>}
      </> : <p role="alert">{t("artifact.panel.text.118")}</p>}
      {source && (draft.stamp !== sourceStamp(source) || fileDraft.stamp !== sourceStamp(source)) && <section className={base.block}><p>{t("artifact.panel.text.119")}</p><button type="button" onClick={() => { patch({ stamp: sourceStamp(source) }); patchFiles({ stamp: sourceStamp(source) }); }}>{t("artifact.panel.text.120")}</button></section>}
    </article>
        {!(showList&&rows.length>0)&&!artifact&&(previewBody||fileDraft.files.length>0)&&<footer className={css.createActions}>
          {source&&(previewBody.trim()||fileDraft.files.length>0)&&<button type="button" aria-label={t('artifact.panel.text.041')} title={t('artifact.panel.text.041')} onClick={async()=>{const id=crypto.randomUUID();const saved=await act({type:'create',id,source:target.source,expectedSource:draft.stamp,title:draft.title||source.title,body:previewBody,files:fileDraft.files,...(draft.messages?{messages:draft.messages}:{}),now:new Date().toISOString()});if(saved){clearDraft();clearFiles();setShowList(false);setSelected(typeof saved==='string'?saved:id);setVersion(1);setSection('');setView('preview')}}}><Save size={16} aria-hidden/>{t('artifact.panel.text.041')}</button>}
          {previewBody&&<a aria-label={t('artifactFiles.download')} title={t('artifactFiles.download')} download={(source?.title||'teloa-result').replace(/[\/:*?"<>|]/g,'_')+'.md'} href={'data:text/markdown;charset=utf-8,'+encodeURIComponent(previewBody)}><Download size={16} aria-hidden/>{t('artifactFiles.download')}</a>}
        </footer>}
    </fieldset>
  </dialog>);
}
