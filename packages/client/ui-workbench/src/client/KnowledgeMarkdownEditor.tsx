import { useRef, useState } from 'react';
import { Bold, Code, Eye, Heading2, Italic, Link, List, ListOrdered, Pencil, Quote } from 'lucide-react';
import { applyMarkdownCommand, MarkdownPreview, type MarkdownCommand } from './knowledge-markdown.js';
import css from './KnowledgeMarkdownEditor.module.css';
import {useI18n} from './i18n/provider.js';
import {localizeWorkError} from './i18n/errors.js';
import type {MessageKey} from './i18n/messages.js';

const placeholderKeys={
    heading:'knowledge.markdown.placeholder.heading',bold:'knowledge.markdown.placeholder.text',italic:'knowledge.markdown.placeholder.text',quote:'knowledge.markdown.placeholder.text',code:'knowledge.markdown.placeholder.text',link:'knowledge.markdown.placeholder.link','unordered-list':'knowledge.markdown.placeholder.listItem','ordered-list':'knowledge.markdown.placeholder.listItem',
} as const satisfies Record<MarkdownCommand,MessageKey>;

export function KnowledgeMarkdownEditor({ value, onChange, readOnly = false }: {
    value: string;
    onChange: (value: string) => void;
    readOnly?: boolean;
}) {
    const {locale,t}=useI18n();
    const tools: Array<{
    command: MarkdownCommand;
    label: string;
    icon: typeof Bold;
}> = [
    { command: 'heading', label: t("knowledge.ui.059"), icon: Heading2 }, { command: 'bold', label: t("knowledge.ui.060"), icon: Bold }, { command: 'italic', label: t("knowledge.ui.061"), icon: Italic }, { command: 'quote', label: t("knowledge.ui.062"), icon: Quote }, { command: 'code', label: t("knowledge.ui.063"), icon: Code }, { command: 'link', label: t("knowledge.ui.064"), icon: Link }, { command: 'unordered-list', label: t("knowledge.ui.065"), icon: List }, { command: 'ordered-list', label: t("knowledge.ui.066"), icon: ListOrdered },
];
    const [mode, setMode] = useState<'write' | 'preview'>('preview'), textarea = useRef<HTMLTextAreaElement>(null);
    const command = (name: MarkdownCommand) => {
        const node = textarea.current;
        if (!node || readOnly)
            return;
        const edit = applyMarkdownCommand(value, node.selectionStart, node.selectionEnd, name, t(placeholderKeys[name]));
        onChange(edit.value);
        requestAnimationFrame(() => { node.focus(); node.setSelectionRange(edit.selectionStart, edit.selectionEnd); });
    };
    return <section className={css.editor} aria-label={t("knowledge.ui.067")}>
  <header><div className={css.tabs} role="tablist" aria-label={t("knowledge.ui.068")}><button id="knowledge-write-tab" type="button" role="tab" aria-controls="knowledge-write-panel" aria-selected={mode === 'write'} onClick={() => setMode('write')}><Pencil size={15}/>{readOnly ? t("knowledge.ui.069") : t("knowledge.ui.070")}</button><button id="knowledge-preview-tab" type="button" role="tab" aria-controls="knowledge-preview-panel" aria-selected={mode === 'preview'} onClick={() => setMode('preview')}><Eye size={15}/>{t("knowledge.ui.071")}</button></div><span className={css.format}>{readOnly ? t("knowledge.ui.072") : 'Markdown'}</span>{mode === 'write' && !readOnly && <div className={css.toolbar} role="toolbar" aria-label={t("knowledge.ui.073")}>{tools.map(tool => <button key={tool.command} type="button" title={tool.label} aria-label={tool.label} onClick={() => command(tool.command)}><tool.icon size={16}/></button>)}</div>}</header>
  {mode === 'write' ? <textarea id="knowledge-write-panel" role="tabpanel" aria-labelledby="knowledge-write-tab" ref={textarea} value={value} readOnly={readOnly} spellCheck="true" aria-label={t("knowledge.ui.074")} placeholder={t("knowledge.ui.075")} onChange={event => onChange(event.target.value)}/> : <article id="knowledge-preview-panel" role="tabpanel" aria-labelledby="knowledge-preview-tab" className={css.preview} aria-label={t("knowledge.ui.076")}><MarkdownPreview markdown={value} images={false}/></article>}
  <footer><span>{t("knowledge.ui.077")}</span><span>{t('knowledge.characterCount',{count:value.length.toLocaleString(locale)})}</span></footer>
 </section>;
}
