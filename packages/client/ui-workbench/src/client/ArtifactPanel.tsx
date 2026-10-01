import { TaskArtifactPicker, type TaskArtifactPort } from './TaskArtifactPicker.js';
import { artifactDraftKey, clearArtifactRevision, recoverArtifactRevision, hasArtifactRevision, type ArtifactDraft as Draft } from './artifact-drafts.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import clsx from 'clsx';
import { artifactMarkdown, sourceKey, sourceStamp, type ArtifactRef, type ArtifactSource, type ArtifactSourceRef } from './artifact-preview.js';
import { resolveArtifactSource, type ArtifactConversation } from './artifact-source.js';
import type { ArtifactWorkChange } from './artifact-work.js';
import type { TaskPreview } from './task-preview.js';
import { artifactMessageKey, copyArtifactMessages, type NativeArtifactApi } from './artifact-native.js';
import { NativeArtifactPicker, ArtifactMessages } from './NativeArtifactPicker.js';
import { ArtifactFiles } from './ArtifactFiles.js';
import { fileSetKey, type ArtifactFileApi, type ArtifactFileDraft } from './artifact-files.js';
import { ArtifactPanelMoreActions, artifactPanelArtifacts, artifactPanelMoreActions, artifactPanelStart, type ArtifactPanelView } from './artifact-panel-presentation.js';
import base from './TaskPage.module.css';
import css from './ArtifactPanel.module.css';
import {useI18n} from './i18n/provider.js';
import {localizeWorkError} from './i18n/errors.js';
export type ArtifactTarget = {
    source: ArtifactSourceRef;
    artifact?: {id:string;version?:number};
};
export type OpenArtifacts = (source: ArtifactSourceRef, artifact?: ArtifactRef) => void;
const blank: Draft = { title: '', body: '', note: '', feedback: '', feedbackId: '', stamp: '' };
type Props = {
    taskSources: TaskArtifactPort;
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
    state: TaskPreview;
    conversation: ArtifactConversation | undefined;
    nativeArtifacts: NativeArtifactApi;
    artifactFileApi: ArtifactFileApi;
    close: () => void;
    change: (change: ArtifactWorkChange) => Promise<string | void>;
    openSource: (ref: ArtifactSourceRef) => void;
    openTask: (id: string) => void;
};
export function ArtifactPanel({ taskSources, recovery, loadError, target, open = true, state, conversation, nativeArtifacts, artifactFileApi, close, change, openSource, openTask }: Props) {
    const {locale,t}=useI18n();
    const dialog = useRef<HTMLDialogElement>(null), [selected, setSelected] = useState<string | null>(null), [versionNumber, setVersion] = useState(1), [sectionId, setSection] = useState(''), [view, setView] = useState<ArtifactPanelView>('preview'), [error, setError] = useState(''), [notice, setNotice] = useState(''), [drafts, setDrafts] = useState<Record<string, Draft>>({}), [linkId, setLinkId] = useState('');
    const targetKey = target ? JSON.stringify(target) : '';
    const persistentSource = !!target && (target.source.kind === 'session' || target.source.kind === 'task' && state.tasks.some(task => task.id === target.source.id && task.storage === 'persistent'));
    const visibleArtifacts = artifactPanelArtifacts(state.artifacts,persistentSource);
    const rows = target ? visibleArtifacts.filter(item => sourceKey(item.source) === sourceKey(target.source) || item.links.some(link => sourceKey(link.object) === sourceKey(target.source))) : [];
    const rowsKey = rows.map(item => item.id).join('\0');
    const [busy, setBusy] = useState(false), busyRef = useRef(false), currentTarget = useRef(targetKey);
    currentTarget.current = targetKey;
    const [pickerOpen, setPickerOpen] = useState(false);
    const [fileDrafts, setFileDrafts] = useState<Record<string, ArtifactFileDraft>>({});
    useEffect(() => setPickerOpen(false), [targetKey, selected, conversation?.id]);
    useLayoutEffect(() => {
        if (!open || !target) return;
        const start = artifactPanelStart(rows.map(item => ({ id: item.id, primary: item.primary, updatedAt: item.versions.at(-1)!.at, versions:item.versions.map(version=>version.number) })), target?.artifact?.id,!!target?.artifact,target?.artifact?.version);
        const item = rows.find(row => row.id === start.selected);
        setSelected(start.selected);
        setVersion(target?.artifact?.id === start.selected ? (target.artifact.version ?? item?.versions.at(-1)?.number ?? 1) : (item?.links.find(link => target && sourceKey(link.object) === sourceKey(target.source))?.artifactVersion || item?.versions.at(-1)?.number || 1));
        setSection('');
        setView('preview');
        setError('');
        setNotice('');
        setLinkId('');
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
            setView('preview');
            return start.selected;
        });
    }, [rowsKey, targetKey]);
    useLayoutEffect(() => {
        if (!open || !target)
            return;
        const node = dialog.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null, media = window.matchMedia('(max-width:1080px)');
        const show = () => { if (!node)
            return; const focused = node.contains(document.activeElement) ? document.activeElement as HTMLElement : null; node.close(); if (media.matches)
            node.showModal();
        else
            node.show(); focused?.focus(); };
        show();
        media.addEventListener('change', show);
        return () => { media.removeEventListener('change', show); node?.close(); if (previous?.isConnected && previous.getClientRects().length)
            previous.focus(); };
    }, [open, !!target]);
    if (!open || !target)
        return null;
    const fallback = artifactPanelStart(rows.map(item => ({ id: item.id, primary: item.primary, updatedAt: item.versions.at(-1)!.at, versions:item.versions.map(version=>version.number) })), target.artifact?.id,!!target.artifact,target.artifact?.version);
    if(fallback.mode==='missing')return <dialog ref={dialog} className={clsx(base.dialog, css.panel)} aria-label={t("artifact.panel.text.006")}><p role="alert">{t('error.notFound')}</p><button type="button" onClick={close}>{t("artifact.panel.text.009")}</button></dialog>;
    const selectedId = selected && rows.some(item => item.id === selected) ? selected : fallback.selected;
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
    const choose = (id: string, number?: number) => { const item = state.artifacts.find(item => item.id === id)!; setSelected(id); setVersion(number || item.links.find(link => sourceKey(link.object) === sourceKey(target.source))?.artifactVersion || item.versions.at(-1)!.number); setSection(''); setView('preview'); setError(''); setNotice(''); };
    const sourceBody = target.source.kind === 'analysis' ? state.business.runs.find(item => item.id === target.source.id && item.scope === ('scope' in target.source ? target.source.scope : ''))?.result : target.source.kind === 'object' ? state.business.objects.find(item => item.id === target.source.id && 'scope' in target.source && item.scope === target.source.scope && 'objectType' in target.source && item.type === target.source.objectType)?.summary : target.source.kind === 'task' ? state.tasks.find(item => item.id === target.source.id)?.result : target.source.kind === 'run' ? state.continuous.runs.find(item => item.id === target.source.id)?.output : undefined;
    const linkOptions = artifactPanelArtifacts(state.artifacts,persistentSource).flatMap(item => item.versions.filter(v => !v.source.private && v.source.scope === source?.scope).map(v => ({ value: JSON.stringify([item.id, v.number]), artifact: { id: item.id, version: v.number }, label: v.title + ' · v' + v.number })));
    return <dialog ref={dialog} className={clsx(base.dialog, css.panel)} aria-label={t("artifact.panel.text.006")} onCancel={event => { if (busy)
        event.preventDefault();
    else
        close(); }}>
    <header><div><h2>{t("artifact.panel.text.006")}</h2><p>{persistentSource ? t("artifact.panel.text.007") : t("artifact.panel.text.008")}</p></div><button type="button" aria-label={t("artifact.panel.text.009")} disabled={busy} onClick={close}><X size={18}/></button></header>
    <fieldset disabled={busy} className={css.layout}><aside className={css.directory} aria-label={t("artifact.panel.text.010")}>
      <div className={css.directoryTitle}><strong>{t("artifact.panel.text.011")}</strong><span>{rows.length}{t("artifact.panel.text.012")}</span></div>
      {!!recovery?.message && <p role="alert">{localizeWorkError(locale,recovery.message)}</p>}
      {recovery?.pending().map(item => <button type="button" key={item.key} onClick={async () => { if (busyRef.current)
        return; busyRef.current = true; setBusy(true); try {
        const saved = await recovery.resume(item.key);
        if (currentTarget.current === targetKey) {
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
      {rows.map(item => <button type="button" className={css.row} key={item.id} aria-current={item.id === selectedId ? 'page' : undefined} onClick={() => choose(item.id)}><strong>{item.versions.at(-1)!.title}</strong><small>{item.primary ? t("artifact.panel.text.016") : ''}{item.versions.length}{t("artifact.panel.text.017")}{sourceKey(item.source) !== sourceKey(target.source) ? t("artifact.panel.text.018") + item.links.filter(link => sourceKey(link.object) === sourceKey(target.source)).map(link => link.artifactVersion).join('、v') : ''}</small></button>)}
      {!rows.length && <div className={css.directoryEmpty}><strong>{t("artifact.panel.text.019")}</strong><p>{t("artifact.panel.text.020")}</p></div>}
    </aside><article className={css.content} aria-label={t("artifact.panel.text.021")}>
      {loadError && (target.source.kind === 'session' || target.source.kind === 'task') && <p role="alert">{loadError}{t("artifact.panel.text.022")}</p>}{busy && <p role="status">{t("artifact.panel.text.023")}</p>}{error && <p role="alert" className={base.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
      {sourceError && <p role="status">{sourceError}{t("artifact.panel.text.024")}</p>}
      {!artifact ? <section className={css.createMode} aria-label={t("artifact.panel.text.025")}><header><span>{t("artifact.panel.text.026")}</span><h3>{t("artifact.panel.text.027")}</h3><p>{t("artifact.panel.text.028")}</p></header><section className={base.block}><h3>{t("artifact.panel.text.029")}</h3><p>{source?.title || t("artifact.panel.text.030")} · {source?.scope}</p>{source && <button type="button" onClick={() => { openSource(source.ref); close(); }}>{t("artifact.panel.text.031")}</button>}</section><form className={base.form} onSubmit={async (event) => { event.preventDefault(); const id = crypto.randomUUID(); const saved = await act({ type: 'create', id, source: target.source, expectedSource: draft.stamp, title: draft.title, body: draft.body, files: fileDraft.files, ...(draft.messages ? { messages: draft.messages } : {}), now: new Date().toISOString() }); if (saved) {
            clearDraft();
            clearFiles();
            setSelected(typeof saved === 'string' ? saved : id);
            setVersion(1);
            setSection('');
            setView('preview');
        } }}>
        {target.source.kind === 'task' && <TaskArtifactPicker taskId={target.source.id} port={taskSources} native={nativeArtifacts} filesApi={artifactFileApi} messages={draft.messages || []} files={fileDraft.files} setMessages={messages => patch({ messages })} setFiles={files => patchFiles({ files })} enabled={!!source}/>} 
        {target.source.kind === 'session' && <><button type="button" disabled={!source} aria-expanded={pickerOpen} onClick={() => setPickerOpen(value => !value)}>{pickerOpen ? t("artifact.panel.text.032") : t("artifact.panel.text.033")}</button>{pickerOpen && source && <NativeArtifactPicker key={target.source.id} sessionId={target.source.id} api={nativeArtifacts} selected={draft.messages || []} select={message => { try {
            patch({ messages: copyArtifactMessages([...(draft.messages || []), message], target.source) });
            setError('');
        }
        catch (error) {
            setError(localizeWorkError(locale,error));
        } }}/>}<ArtifactMessages messages={draft.messages || []} api={nativeArtifacts} enabled={!!source} remove={message => patch({ messages: (draft.messages || []).filter(item => artifactMessageKey(item) !== artifactMessageKey(message)) })} append={text => { const next = [draft.body, text].filter(Boolean).join('\n\n'); if (next.length > 16000) {
            setError(t("artifact.panel.text.035"));
            return;
        } patch({ body: next }); setError(''); }}/></>}
        {target.source.kind === 'session' && <ArtifactFiles key={fileKey} sessionId={target.source.id} api={artifactFileApi} files={fileDraft.files} enabled={!!source} form={fileDraft.form} changeForm={form => patchFiles({ form })} changeFiles={files => patchFiles({ files })}/>} 
        {sourceBody && <button type="button" disabled={!!draft.body.trim()} onClick={() => patch({ body: sourceBody })}>{t("artifact.panel.text.036")}</button>}<label>{t("artifact.panel.text.037")}<input required maxLength={200} value={draft.title} onChange={event => patch({ title: event.target.value })}/></label><label>{t("artifact.panel.text.038")}<textarea required={!fileDraft.files.length} rows={12} maxLength={16000} value={draft.body} onChange={event => patch({ body: event.target.value })} placeholder={t("artifact.panel.text.039")}/></label>
        <p>{t("artifact.panel.text.040")}</p><button type="submit" disabled={!source || !draft.title.trim() || (!draft.body.trim() && !fileDraft.files.length)}>{persistentSource ? t("artifact.panel.text.041") : t("artifact.panel.text.042")}</button>
      </form></section> : version ? <>
        <header className={css.artifactHeader}><div><span>{artifact.primary ? t("artifact.panel.text.043") : t("artifact.panel.text.006")} · v{version.number}</span><h3>{version.title}</h3><p>{version.author} · {new Date(version.at).toLocaleString(locale)} · {version.note}</p></div></header>
        <nav className={css.tabs} aria-label={t("artifact.panel.text.044")}><button type="button" aria-current={view === 'preview' ? 'page' : undefined} onClick={() => setView('preview')}>{t("artifact.panel.text.045")}</button><button type="button" aria-current={view === 'files' ? 'page' : undefined} onClick={() => setView('files')}>{t("artifact.panel.text.046")}</button><button type="button" aria-current={view === 'versions' ? 'page' : undefined} onClick={() => setView('versions')}>{t("artifact.panel.text.047")}</button></nav>
        {view === 'preview' && <section className={css.preview} aria-label={t("artifact.panel.text.048")}>{version.sections.map(item => <section key={item.id} className={base.block}><h4>{item.title}</h4><p className={css.body}>{item.text}</p><button type="button" onClick={() => { setSection(item.id); setView('versions'); }}>{t("artifact.panel.text.049")}</button></section>)}</section>}
        {view === 'files' && <section className={css.filesView} aria-label={t("artifact.panel.text.046")}><section className={base.block}><h3>{t("artifact.panel.text.029")}</h3><p>{(source || version.source).title} · {(source || version.source).scope}</p>{source && <button type="button" onClick={() => { openSource(source.ref); close(); }}>{t("artifact.panel.text.031")}</button>}<dl className={css.sourceFacts}><dt>{t("artifact.panel.text.050")}</dt><dd>{version.source.ref.kind} · {version.source.ref.id} · {version.source.version}</dd><dt>{t("artifact.panel.text.051")}</dt><dd>{version.source.author}</dd><dt>{t("artifact.panel.text.052")}</dt><dd>{version.source.private ? t("artifact.panel.text.053") : t("artifact.panel.text.054")}</dd></dl>{version.source.evidence.length ? <details><summary>{t("artifact.panel.text.055")}</summary><ul>{version.source.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : <p>{t("artifact.panel.text.056")}</p>}</section>
          <ArtifactMessages key={artifact.id + ':' + version.number} messages={version.messages || []} api={nativeArtifacts} enabled={!!source && source.ref.kind === 'session' && source.ref.id === conversation?.id}/>
          {(artifact.source.kind === 'session' || artifact.source.kind === 'task') ? <section className={base.block}><ArtifactFiles label={t("artifact.panel.text.057") + version.number} sessionId={artifact.source.id} api={artifactFileApi} files={version.files || []} enabled={false} form={{ query: '', candidate: null }} changeForm={() => { }}/>{version.number === latest?.number && !locked && <details><summary>{t("artifact.panel.text.058")}</summary>{artifact.source.kind === 'task' ? <TaskArtifactPicker key={fileKey} filesOnly taskId={artifact.source.id} port={taskSources} native={nativeArtifacts} filesApi={artifactFileApi} messages={[]} files={fileDraft.files} setMessages={() => { }} setFiles={files => patchFiles({ files })} enabled={!!source}/> : <ArtifactFiles key={fileKey} label={t("artifact.panel.text.059")} sessionId={artifact.source.id} api={artifactFileApi} files={fileDraft.files} enabled={!!source} form={fileDraft.form} changeForm={form => patchFiles({ form })} changeFiles={files => patchFiles({ files })}/>}</details>}{version.number === latest?.number && fileSetKey(fileDraft.files) !== fileSetKey(version.files || []) && <div className={base.form}><p>{t("artifact.panel.text.060")}</p><label>{t("artifact.panel.text.061")}<textarea maxLength={4000} value={fileDraft.note} onChange={event => patchFiles({ note: event.target.value })}/></label><button type="button" disabled={!source || locked || !fileDraft.note.trim()} onClick={async () => { if (await act({ type: 'change', id: artifact.id, expectedSource: fileDraft.stamp, change: { type: 'files', expectedVersion: version.number, files: fileDraft.files, note: fileDraft.note, now: new Date().toISOString() } })) {
                clearFiles();
                setVersion(version.number + 1);
            } }}>{artifact.storage === 'persistent' ? t("artifact.panel.text.062") : t("artifact.panel.text.063")}</button><button type="button" onClick={clearFiles}>{t("artifact.panel.text.064")}</button></div>}{version.number !== latest?.number && fileDrafts[fileKey] && (fileSetKey(fileDraft.files) !== fileSetKey(version.files || []) || !!fileDraft.form.candidate) && <details><summary>{t("artifact.panel.text.065")}</summary><ArtifactFiles sessionId={artifact.source.id} api={artifactFileApi} files={fileDraft.files} enabled={false} form={fileDraft.form} changeForm={() => { }}/>{fileDraft.form.candidate && <ArtifactFiles label={t("artifact.panel.text.066")} sessionId={artifact.source.id} api={artifactFileApi} files={[fileDraft.form.candidate]} enabled={false} form={{ query: '', candidate: null }} changeForm={() => { }}/>}<p>{t("artifact.panel.text.067")}</p><button type="button" onClick={clearFiles}>{t("artifact.panel.text.068")}</button></details>}</section> : <section className={base.block}><p>{t("artifact.panel.text.069")}</p></section>}
        </section>}
        {view === 'versions' && <section className={css.versionsView} aria-label={t("artifact.panel.text.047")}><section className={base.block}><h3>{t("artifact.panel.text.070")}</h3><label className={css.version}>{t("artifact.panel.text.071")}<select aria-label={t("artifact.panel.text.072")} value={version.number} onChange={event => { setVersion(Number(event.target.value)); setSection(''); setError(''); setNotice(''); }}>{artifact.versions.map(item => <option key={item.number} value={item.number}>v{item.number} · {item.note}</option>)}</select></label><p>{artifact.versions.length}{t("artifact.panel.text.073")}{version.number}{version.number === latest?.number ? t("artifact.panel.text.074") : t("artifact.panel.text.075")}</p></section>
          {version.sections.map(item => <button type="button" className={css.sectionChoice} key={item.id} aria-pressed={section?.id === item.id} onClick={() => setSection(item.id)}><strong>{item.title}</strong><span>{artifact.feedback.filter(feedback => feedback.version === version.number && feedback.sectionId === item.id).length}{t("artifact.panel.text.076")}</span></button>)}
          {section && <section className={base.block}><h3>{t("artifact.panel.text.077")}{section.title} · v{version.number}</h3><ol>{artifact.feedback.filter(item => item.version === version.number && item.sectionId === section.id).map(item => <li key={item.id}><p>{item.text}</p><small>{item.author} · {new Date(item.at).toLocaleString(locale)}{artifact.versions.some(v => v.feedbackId === item.id) ? t("artifact.panel.text.078") : ''}</small></li>)}</ol><form className={base.form} onSubmit={async (event) => { event.preventDefault(); if (await act({ type: 'change', id: artifact.id, expectedSource: draft.stamp, change: { type: 'feedback', id: crypto.randomUUID(), version: version.number, sectionId: section.id, text: draft.feedback, now: new Date().toISOString() } }))
                patch({ feedback: '' }); }}><label>{t("artifact.panel.text.079")}<textarea required rows={3} maxLength={4000} value={draft.feedback} onChange={event => patch({ feedback: event.target.value })}/></label><button type="submit" disabled={!draft.feedback.trim()}>{artifact.storage === 'persistent' ? t("artifact.panel.text.080") : t("artifact.panel.text.081")}</button></form></section>}
          <details className={clsx(base.block, css.moreActions)}><summary>{t("artifact.panel.text.082")}</summary>
            <ArtifactPanelMoreActions actions={moreActions} activeBoundary={t("artifact.panel.text.121")} lockedBoundary={t("artifact.panel.text.122")}
              link={target.source.kind === 'object' && source && <form className={base.form} onSubmit={async (event) => { event.preventDefault(); const option = linkOptions.find(item => item.value === linkId); if (option && target.source.kind === 'object')
                act({ type: 'link', artifact: option.artifact, object: target.source, now: new Date().toISOString() }); }}><label>{t("artifact.panel.text.083")}<select value={linkId} onChange={event => setLinkId(event.target.value)}><option value="">{t("artifact.panel.text.084")}</option>{linkOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><button disabled={!linkId} type="submit">{t("artifact.panel.text.085")}</button></form>}
              review={reviewTask && <section><h3>{t("artifact.panel.text.086")}</h3><p>{t("artifact.panel.text.087")}</p><button type="button" disabled={reviewTask.reviewArtifact?.id === artifact.id && reviewTask.reviewArtifact.version === version.number} onClick={() => act({ type: 'review', artifact: { id: artifact.id, version: version.number }, expectedTaskVersion: reviewTask.version, now: new Date().toISOString() })}>{t("artifact.panel.text.088")}</button></section>}
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
    </article></fieldset>
  </dialog>;
}
