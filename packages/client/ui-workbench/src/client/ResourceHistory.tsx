import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BookOpen, RefreshCw } from 'lucide-react';
import { ToolbarIconButton } from './ToolbarIconButton.js';
import {ContextDrawer} from './ContextDrawer.js';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ResourceHistoryPage } from '@teloa/contract';
import type { BindingClient } from './binding-client.js';
import type { ResourceApi } from './resource-api.js';
import css from './ResourceHistory.module.css';
import {useI18n} from './i18n/provider.js';
import {localizeWorkError} from './i18n/errors.js';
export function ResourceHistory({ sessionId, api, work }: PropsRuntime<'conversation.session.header.utilities'> & {
    api: Pick<ResourceApi, 'history'>;
    work: BindingClient;
}) {
    const {t}=useI18n();
    const binding = useSyncExternalStore(work.subscribe, work.getSnapshot), ready = binding.status === 'ready' && binding.sessionId === sessionId;
    const [open, setOpen] = useState(false);
    useEffect(() => setOpen(false), [sessionId, ready]);
    return <><button type="button" className={css.trigger} disabled={!ready} aria-label={t('knowledge.ui.079')} title={t('knowledge.ui.079')} aria-expanded={open} onClick={() => setOpen(true)}><BookOpen size={15} aria-hidden="true"/></button>{ready && <HistoryDrawer key={sessionId} open={open} sessionId={sessionId} api={api} close={() => setOpen(false)}/>}</>;
}
function HistoryDrawer({ sessionId, api, close, open }: {
    open: boolean;
    sessionId: string;
    api: Pick<ResourceApi, 'history'>;
    close: () => void;
}) {
    const {locale,t}=useI18n();
    const request = useRef<AbortController>(), generation = useRef(0);
    const [page, setPage] = useState<ResourceHistoryPage>(), [loading, setLoading] = useState(false), [error, setError] = useState<string>();
    const read = async (beforeSeq?: number) => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        const current = ++generation.current;
        setLoading(true);
        setError(undefined);
        try {
            const result = await api.history(sessionId, beforeSeq, controller.signal);
            if (controller.signal.aborted || current !== generation.current)
                return;
            setPage(previous => beforeSeq === undefined || !previous ? result : { ...result, items: [...previous.items, ...result.items.filter(item => !previous.items.some(old => old.messageId === item.messageId))] });
        }
        catch (cause) {
            if (!controller.signal.aborted && current === generation.current)
                setError(localizeWorkError(locale,cause));
        }
        finally {
            if (!controller.signal.aborted && current === generation.current)
                setLoading(false);
        }
    };
    useEffect(() => {
        if (!open) return;
        if (!page) void read();
        return () => { generation.current++; request.current?.abort(); setLoading(false); };
    }, [open, sessionId, api]);
    return <ContextDrawer open={open} title={t("knowledge.ui.081")} close={close}><div className={css.history}>
    {page&&page.items.length>0&&<p className={css.description}>{t("knowledge.ui.082")}</p>}
    <div className={css.body} aria-busy={loading}>
      {page&&page.items.length>0&&<p className={css.hint}>{t("knowledge.ui.084")}</p>}
      {error && <p className={css.error} role="alert">{error}</p>}
      {loading && <p role="status">{t("knowledge.ui.085")}</p>}
      {!loading && !error && page?.items.length === 0 && <div className={css.empty}><BookOpen size={28}/><h3>{t("knowledge.ui.086")}</h3><p>{t("knowledge.ui.087")}</p></div>}
      {page?.items.map(item => <section key={item.messageId} className={css.record} aria-label={t("knowledge.ui.088") + item.messageId}>
        <div className={css.recordHeader}><strong>{item.turn === null ? t("knowledge.ui.089") : t("knowledge.ui.090") + item.turn + t("knowledge.ui.091")}</strong><time dateTime={item.at}>{new Date(item.at).toLocaleString(locale)}</time></div>
        {item.issue && <p role="alert">{item.issue}</p>}
        {item.references.map(ref => <div key={ref.id + '@' + ref.version} className={css.reference}>
          <BookOpen size={17}/><div><strong>{ref.metadata?.title || t("knowledge.ui.092")}</strong><p>{t("knowledge.ui.093")}{ref.version} · {ref.metadata ? t("knowledge.ui.094") : t("knowledge.ui.095")}</p>
            <details><summary>{t("knowledge.ui.096")}</summary><dl><dt>{t("knowledge.ui.097")}</dt><dd>{ref.id}</dd>{ref.metadata && <><dt>{t("knowledge.ui.027")}</dt><dd>{ref.metadata.sourceId}</dd><dt>{t("knowledge.ui.098")}</dt><dd>{ref.metadata.sourceVersion}</dd><dt>{t("knowledge.ui.099")}</dt><dd>{ref.metadata.scopeIds.map(scope => scope === 'general' ? t("knowledge.ui.100") : scope).join(' / ')}</dd></>}<dt>{t("knowledge.ui.101")}</dt><dd>{item.messageId}</dd></dl></details>
          </div>
        </div>)}
      </section>)}
      {page?.nextBeforeSeq !== null && page?.nextBeforeSeq !== undefined && <button type="button" className={css.button} disabled={loading} onClick={() => void read(page.nextBeforeSeq!)}>{t("knowledge.ui.102")}</button>}
    </div><footer><span>{t("knowledge.ui.103")}</span><ToolbarIconButton label={t("knowledge.ui.104")} icon={RefreshCw} disabled={loading} onClick={() => void read()}/></footer>
  </div></ContextDrawer>;
}
