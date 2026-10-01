import clsx from 'clsx';
import { ArrowRight, ArrowUpRight, Bell, Plus } from 'lucide-react';
import type { AttentionItem } from './attention-item.js';
import { useRef, useState, type ReactNode } from 'react';
import type { BusinessScopeLabel } from './business-directory.js';
import { businessScopeNames } from './business-directory.js';
import type { IndustryDataSourceInstance } from './industry-data-source-api.js';
import type { IndustryLoadRecord } from './industry-load-api.js';
import type { PreviewRole } from './role-preview.js';
import type { PreviewTask } from './task-preview.js';
import type { CompositionTarget } from './industry-composition.js';
import { businessHomeCards, businessHomeSummaryParts, type BusinessHomeCard } from './business-home-presentation.js';
import { useI18n } from './i18n/provider.js';
import { useDismissible } from './use-dismissible.js';
import { StaffAvatar } from './StaffAvatar.js';
import base from './TaskPage.module.css';
import css from './BusinessHome.module.css';

export type BusinessHomeProps = {
    labels: readonly BusinessScopeLabel[];
    directory: { status: 'loading' | 'ready' | 'failed'; error?: string; retry: () => void };
    roles: readonly PreviewRole[];
    dataSources: readonly IndustryDataSourceInstance[];
    attention: readonly AttentionItem[];
    tasks: readonly PreviewTask[];
    /** 卡摘要那一行的事实来源：已加载的业务内容与持续计划；读不到就整行不摆。 */
    loads?: readonly IndustryLoadRecord[];
    plans?: readonly { scope: string; state: string; title: string }[];
    open: (scope: string) => void;
    openStaff: (scope: string) => void;
    connect: (scope: string) => void;
    addBusiness: () => void;
    creationReady?: boolean;
    /** 摘要每一段点进对应位置；落点由共享分类模块给出，本页不认识具体页面。 */
    goComposition?: (target: CompositionTarget) => void;
    /** 新业务的统一入口由宿主传入；旧市场入口保留为它的一项选择。 */
    createEntry?: ReactNode;
    builderDirectory?: ReactNode;
    market?: () => void;
};

/** 头像串最多五个，多出的折成「+N」——与原型 `.workerRow` 的重叠堆叠同一口径。 */
const AVATAR_LIMIT = 5;

function StaffRow({ staff }: { staff: readonly PreviewRole[] }) {
    const { t, number } = useI18n();
    if (!staff.length) return <span className={css.noStaff}>{t('business.home.noStaff')}</span>;
    const shown = staff.slice(0, AVATAR_LIMIT);
    return <span className={css.staffRow}>
        {shown.map(role => <span key={role.id} className={css.staffAvatar} title={role.name}><StaffAvatar initial={role.name.slice(0, 1)} seed={role.id} size="sm" /></span>)}
        {staff.length > shown.length && <span className={css.staffMore}>{t('business.home.staffMore', { count: number(staff.length - shown.length) })}</span>}
    </span>;
}

/** 范围标签只在模板来源称呼唯一时给出这一位；否则回落通用名词，避免猜测。 */
function SpaceCard({ card, open, openStaff, connect, goComposition }: { card: BusinessHomeCard } & Pick<BusinessHomeProps, 'open' | 'openStaff' | 'connect' | 'goComposition'>) {
    const { t, number } = useI18n();
    const noun = card.sourceNoun ?? t('business.source.noun');
    // 一个东西都没有的业务不摆空摘要；摘要本身在处境句这一块下面，因为按钮不能套按钮。
    const summary = card.composition.length ? businessHomeSummaryParts(card.composition, card.scope, t, number) : [];
    return <article className={css.spaceCard}>
        <button type="button" className={css.spaceOpen} onClick={() => open(card.scope)}>
            <span className={css.spaceName}>{card.title}<ArrowUpRight size={16} /></span>
            <span className={css.spaceSituation}>{t(card.situationKey, { sources: number(card.sources), staff: number(card.staff.length), noun })}</span>
            <span className={css.spaceWork}>{card.working ? t('business.home.working', { count: number(card.working) }) : t('business.home.quiet')}</span>
            <span className={css.spaceLine}>{t(card.lineKey, { noun })}</span>
        </button>
        {summary.length > 0 && <div className={css.spaceComposition}>
            {summary.map((part, index) => part.go
                ? <button key={index} type="button" className={css.compositionPart} onClick={() => goComposition?.(part.go!)}>{part.text}</button>
                : <span key={index} className={css.compositionGap}>{part.text}</span>)}
        </div>}
        <div className={css.spaceFoot}>
            <StaffRow staff={card.staff} />
            <span className={css.grow} />
            {card.attention > 0 && <span className={css.needPill}><Bell size={12} />{t('business.home.waiting', { count: number(card.attention) })}</span>}
            <button type="button" className={css.staffLink} onClick={() => openStaff(card.scope)}>{t('business.home.staff')}<ArrowRight size={14} /></button>
            <button type="button" onClick={() => connect(card.scope)}><Plus size={14} />{t('business.home.connect', { noun })}</button>
        </div>
    </article>;
}

/**
 * 业务台账首页（原型 B3）：按业务范围一张张卡，每张卡先讲此刻的处境，再给一个直接动作。
 * 三个数都来自 `business-home-presentation.ts` 的纯函数，本组件只负责排版与接线。
 */
export function BusinessHome({ labels, directory, roles, dataSources, attention, tasks, loads, plans, open, openStaff, connect, addBusiness, creationReady=true, createEntry, builderDirectory, market, goComposition }: BusinessHomeProps) {
    const { t, locale } = useI18n();
    const names = businessScopeNames(labels, {general:t('business.scope.general'),SOC:t('business.scope.soc'),AppSec:t('business.scope.appsec')});
    const cards = businessHomeCards(labels.map(label=>({...label,title:names[label.scope]??label.title})), { roles, dataSources, attention, tasks, locale, ...(loads ? { loads } : {}), ...(plans ? { plans } : {}) });
    const [createOpen, setCreateOpen] = useState(false);
    const createControlRef = useRef<HTMLDetailsElement>(null);
    useDismissible(createControlRef, createOpen, () => setCreateOpen(false), undefined, 'click');
    return <section className={clsx(base.page, css.page)} aria-label={t('business.home.title')}>
        <div className={css.container}>
            <header className={css.pageHeader}>
                <div>
                    <h1>{t('business.home.title')}</h1>
                    <p className={css.subtitle}>{t('business.home.subtitle')}</p>
                </div>
                {createEntry===undefined
                  ? <div className={css.entryActions}><button type="button" disabled={!creationReady} onClick={addBusiness}>{t(builderDirectory===undefined?'business.home.add':'business.builder.new')}</button>{market&&<button type="button" onClick={market}>{t('business.builder.market')}</button>}</div>
                  : <details ref={createControlRef} className={clsx(css.createControl, createOpen && css.createOpen)} open={createOpen} onToggle={event => setCreateOpen(event.currentTarget.open)}><summary aria-controls="business-create-entry">{t('business.home.add')}</summary><div id="business-create-entry" className={css.create}>{createEntry}</div></details>}
            </header>
            {!creationReady&&<p role="status">{t('business.daily.readyWaiting')}</p>}
            <div className={css.cardList}>
                {directory.status === 'loading' && <div className={css.empty} role="status"><p>{t('business.home.directory.loading')}</p></div>}
                {directory.status === 'failed' && <div className={base.error} role="alert">
                    <strong>{t('business.home.directory.failed')}</strong>
                    {directory.error && <p>{directory.error}</p>}
                    <button type="button" onClick={directory.retry}>{t('common.retry')}</button>
                </div>}
                {directory.status === 'ready' && cards.map(card => <SpaceCard key={card.scope} card={card} open={open} openStaff={openStaff} connect={connect} {...(goComposition ? { goComposition } : {})} />)}
                {directory.status === 'ready' && !cards.length && <div className={css.empty}>
                    <h2>{t('business.home.empty.title')}</h2>
                    <p>{t(builderDirectory===undefined?'business.home.empty.description':'business.builder.newNote')}</p>
                    {builderDirectory===undefined&&<button type="button" disabled={!creationReady} onClick={addBusiness}>{t('business.home.add')}</button>}
                </div>}
            </div>
            {builderDirectory}
        </div>
    </section>;
}
