import {useApplicationCapability} from './CapabilityNotice.js'
import {StatusLabel} from './StatusLabel.js'
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronRight, Fingerprint, Plus, UserRound } from 'lucide-react';
import type { BusinessScopeLabel } from './business-directory.js';
import type { PreviewRole } from './role-preview.js';
import type { PreviewTask } from './task-preview.js';
import { rosterSections } from './team-roster-grouping.js';
import { ROSTER_FOLD_LIMIT, rosterFoldToggle, rosterSectionOpen, type RosterFoldState } from './team-roster-fold.js';
import { rosterCounts, roleNowDoing } from './team-roster-counts.ts';
import { useI18n } from './i18n/provider.js';
import { twinDisplayName } from './team-presentation.js';
import { defaultPersonalDisplayName, personalAvatarInitials, personalDisplayName } from './personal-profile.js';
import { StaffAvatar } from './StaffAvatar.js';
import teamCss from './TeamPage.module.css';
import rosterCss from './StaffRoster.module.css';

export type StaffRosterProps = {
    roles: readonly PreviewRole[];
    labels: readonly BusinessScopeLabel[];
    tasks: readonly PreviewTask[];
    focusScope?: string;
    fold: RosterFoldState;
    onFoldChange: (next: RosterFoldState) => void;
    searching: boolean;
    onSelect: (id: string) => void;
    onHire: () => void;
    /** 本人用户名：分身在名单里按「{用户名} 的分身」显示，不用存储里第一人称的 role.name。 */
    profileName?: string;
    profileInitials?: string;
};

/** 分身是默认代拟身份，不进入数字员工的在岗状态机；数字员工才显示四档运行状态。 */
const rosterMemberStatus = (role: PreviewRole): 'twin' | 'retired' | 'paused' | 'active' =>
    role.kind === 'twin' ? 'twin' : role.state === 'retired' ? 'retired' : role.state === 'paused' ? 'paused' : 'active';

/** 分区副标题三档（规格 §4.2）：兜底的「其他」分区没有来源可讲，不给副标题。 */
const SECTION_KIND_KEYS = { builtin: 'team.roster.section.builtin', domain: 'team.roster.section.domain', legacy: 'team.roster.section.legacy' } as const;

/** 成员行副文案取岗位一句话的首句：与个人主页身份栏同一口径，不再把 scopes 原值当人话展示。 */
export const dutyLead = (duty: string) => duty.split(/[。.!?！？\n]/)[0]?.trim() ?? '';

/**
 * 同事目录从「一条条平列的岗位行」改成按业务范围分区的通讯录（规格 §四）。
 * 分区头三个数与成员行的「今天在做」/状态点全部来自 `team-roster-counts.ts` 的纯函数——
 * 三个数只吃调用方传入的 `tasks`（要求是 `directoryState.tasks`），不新增端点、不在这里重新过滤示例数据。
 */
export function StaffRoster({ roles, labels, tasks, focusScope, fold, onFoldChange, searching, onSelect, onHire, profileName = defaultPersonalDisplayName, profileInitials = personalAvatarInitials(profileName) }: StaffRosterProps) {
 const allowed=useApplicationCapability('people')
    const { t, number } = useI18n();
    profileName = personalDisplayName(profileName, t('profile.account'));
    const focusRef = useRef<HTMLElement>(null);
    const [appliedFocus, setAppliedFocus] = useState<string>();
    const sections = rosterSections(roles, labels, t('team.roster.other'));
    const statusLabel = (status: ReturnType<typeof rosterMemberStatus>) => t(
        status === 'twin' ? 'team.roster.status.twin' : status === 'retired' ? 'team.roster.status.retired' : status === 'paused' ? 'team.roster.status.paused' : 'team.roster.status.active'
    );
    // 依赖只放这个布尔而不是 sections 数组：sections 每次渲染都是新数组，进依赖表会让 effect 每帧重跑；
    // 聚焦分区真正影响这段逻辑的只有「它默认是否展开」，人数跨过阈值时这个布尔自然跟着变。
    const focusedMembers = focusScope ? sections.find(item => item.id === focusScope)?.members.length : undefined;
    const focusDefaultOpen = focusedMembers === undefined ? undefined : focusedMembers <= ROSTER_FOLD_LIMIT;
    useEffect(() => {
        if (!focusScope) { setAppliedFocus(undefined); return; }
        if (focusDefaultOpen === undefined || appliedFocus === focusScope) return;
        // 聚焦只消费一次；之后用户仍可折起，离开业务入口再回来会重新聚焦。
        setAppliedFocus(focusScope);
        // 规格 §4.3：聚焦跳转不能只是临时把分区撑开——离开聚焦态之后仍要保持展开，所以要把这次强制展开写回记忆，
        // 不能每次都无条件切换（否则重复触发同一个 focusScope 会来回翻转）：只在当前记忆算出来的效果不是「展开」时才切一次。
        if (focusDefaultOpen !== undefined && fold.toggled.includes(focusScope) === focusDefaultOpen) onFoldChange(rosterFoldToggle(fold, focusScope));
        focusRef.current?.scrollIntoView({ block: 'nearest' });
    }, [focusScope, focusDefaultOpen, appliedFocus]);
    // 第二期 A2-1：名单不再是侧栏里的可滚动列表，而是整页一列（滚动交给页面容器 TeamPage.module.css 的 .rosterPage）。
    return <div className={rosterCss.rosterStack}>
        {sections.map(section => {
            const focused = section.id === focusScope;
            const open = rosterSectionOpen({ sectionId: section.id, members: section.members.length, searching, focused: focused && appliedFocus !== focusScope, fold });
            const { people, busy, waiting } = rosterCounts(section.members, tasks);
            // 三个数是给人读的量词，走当地数字格式（千分位/本地数字系统），不直接把 JS 数字塞进句子。
            const counts = t('team.roster.section.counts', { people: number(people), busy: number(busy), waiting: number(waiting) });
            const panelId = 'staff-roster-' + encodeURIComponent(section.id);
            return <section key={section.id} className={rosterCss.group} aria-label={section.title} ref={focused ? focusRef : undefined}>
                {/* 搜索态用 aria-disabled 而不是 disabled：分区头仍要留在可聚焦序列里，读屏用户能读到标题与三个数。 */}
                <button type="button" className={rosterCss.groupHead} aria-expanded={open} aria-controls={panelId} aria-label={t(open ? 'team.roster.section.collapse' : 'team.roster.section.expand', { name: section.title })} aria-disabled={searching ? 'true' : undefined} onClick={() => { if (!searching) onFoldChange(rosterFoldToggle(fold, section.id)); }}>
                    <ChevronRight size={15} className={clsx(rosterCss.chevron, open && rosterCss.chevronOpen)} />
                    <span className={rosterCss.groupName}>
                        <strong className={rosterCss.groupTitle}>{section.title}</strong>
                        {section.kind !== 'other' && <small className={rosterCss.groupKind}>{t(SECTION_KIND_KEYS[section.kind])}</small>}
                    </span>
                    <span className={rosterCss.groupCounts}>{counts}</span>
                </button>
                {open && <div id={panelId} className={rosterCss.personList}>{section.members.map(item => {
                    // 分身头像使用本人姓名缩写；无姓名时与个人主页同用通用用户图标。
                    const status = rosterMemberStatus(item), lead = dutyLead(item.duty), name = item.kind === 'twin' ? twinDisplayName(profileName, t) : item.name;
                    return <button type="button" key={item.id} data-teloa-entry={item.id} className={rosterCss.personRow} onClick={() => onSelect(item.id)}>
                        {item.kind === 'twin' ? <span className={clsx(teamCss.avatar, teamCss.human)} aria-hidden="true">{profileInitials || <UserRound size={14}/>}<Fingerprint size={10} /></span> : <StaffAvatar initial={name.slice(0, 1)} seed={item.id} size="md" />}
                        <span className={rosterCss.personMain}>
                            <strong>{name}</strong>
                            {lead && <small>{lead}</small>}
                        </span>
                        <span className={rosterCss.personNow}>{roleNowDoing(item.id, tasks) ?? t('team.roster.idle')}</span>
                        <span className={rosterCss.status} data-roster-status={status}>{status==='twin'?<><Fingerprint size={12} aria-hidden="true"/>{statusLabel(status)}</>:<StatusLabel label={statusLabel(status)} mark={status==='active'?'enabled':status==='paused'?'paused':'retired'} tone={status==='active'?'good':'muted'}/>}</span>
                        <ChevronRight size={16} className={rosterCss.personChevron} />
                    </button>;
                })}</div>}
            </section>;
        })}
        {/* 招聘卡照原型 数字员工形象.jsx:79：圆形加号 + 标题 + 一句「三步就能上班」的小字。 */}
        <button type="button" className={rosterCss.hireCard} disabled={!allowed} onClick={onHire}>
            <span className={rosterCss.hireIcon} aria-hidden="true"><Plus size={20} /></span>
            <span className={rosterCss.hireText}><strong>{t('team.action.new')}</strong><small>{t('team.page.hireHint')}</small></span>
        </button>
    </div>;
}
