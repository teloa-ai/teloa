import {RoleModelFields} from './RoleModelFields.js'
import {patchRoleModel,roleModelLabel,roleModelsCanSave,type RoleModelLoadState} from './role-models.js'
import type {GroupApi} from './group-api.js';
import {RoleGroupMembership} from './RoleGroupMembership.js';
import {StatusLabel} from './StatusLabel.js'
import type {ScheduleTrigger} from '@teloa/contract';
import { HomeSkillPicker } from './HomeSkillPicker.js';
import type { BindingClient } from './binding-client.js';
import { RoleKnowledge } from './RoleKnowledge.js';
import type { ResourceApi } from './resource-api.js';
import { RoleLifecycle, RoleLifecycleRecovery, type RoleLifecyclePort } from './RoleLifecycle.js';
import { roleLifecyclePath, roleMemoryPath, roleSkillNotice, roleStatusLabel, roleWorkPath, twinDisplayName } from './team-presentation.js';
import type { TwinDraftInput } from './TwinDraftEditor.js';
import { TwinProfile } from './TwinProfile.js';
import { defaultPersonalDisplayName } from './personal-profile.js';
import { useDirectoryFocus } from './directory-focus.js';
import { openDialog } from './dialog-focus.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Bot, Check, ChevronLeft, ChevronRight, Pause, Play, Plus, RefreshCw, Search, Users, X } from 'lucide-react';
import clsx from 'clsx';
import type { CollaborationPreview, CollaborationScope } from './collaboration-preview.js';
import { useBusinessScopes } from './business-scope-context.js';
import { roleScopeOptions } from './role-scope-options.js';
import { roleName, roleStates, type PreviewRole, type RoleFields, type TeamChange } from './role-preview.js';
import { responsibilityGroups, roleFormProgress, runtimeConfigCanSave, runtimeConfigFailed, runtimeConfigLoading, runtimeConfigOptions, runtimeConfigReady, runtimeConfigSummary, type RoleRuntimeConfigApi, type RuntimeConfigLoadState } from './role-runtime-config.js';
import type { CapabilityPreview } from './capability-preview.js';
import type { RoleMemory, RoleDailyLog, RoleDailyLogPruneHint } from '@teloa/contract';
import type { PageCreateDraftPreview } from '@teloa/contract';
import type { RoleMemoryApi } from './role-memory-api.js';
import type { RoleDailyLogApi } from './role-daily-log-api.js';
import { RoleDailyLogPanel } from './RoleDailyLogPanel.js';
import { groupRoleMemories } from './role-memory-grouping.js';
import { attentionKinds, taskNeeds, taskStates, type TaskPreview } from './task-preview.js';
import css from './TaskPage.module.css';
import teamCss from './TeamPage.module.css';
import directoryCss from './DirectoryPane.module.css';
import rosterCss from './StaffRoster.module.css';
import { useI18n } from './i18n/provider.js';
import { localizeWorkError } from './i18n/errors.js';
import {exampleDirectoryMode,visibleRoleDirectory,visibleTaskDirectory,type ExampleDirectoryMode} from './example-directory-presentation.js';
import {readDirectoryFilterCategory,writeDirectoryFilterCategory,type WorkbenchDirectoryNavigation,type WorkbenchDirectoryPatch} from './workbench-navigation-state.js';
import type { BusinessScopeLabel } from './business-directory.js';
import { StaffRoster } from './StaffRoster.js';
import { rosterTotal, rosterHasMultiScope } from './team-roster-grouping.js';
import { roleIsBusy, roleNowDoing, rosterCounts } from './team-roster-counts.ts';
import { readRosterFold, writeRosterFold, type RosterFoldState } from './team-roster-fold.js';
import { StaffAvatar } from './StaffAvatar.js';
import { CreateEntry } from './CreateEntry.js';
import type { PageCreateApi } from './page-create-api.js';
import { createRoleFormInitial } from './page-create-presentation.js';
import { roleTimeline } from './role-timeline.ts';
import { ROLE_PROFILE_SECTIONS, roleProfileSectionKeys, type RoleProfileSection } from './role-profile-sections.ts';
import { STAFF_AVATAR_SHAPES, STAFF_AVATAR_TONES } from './staff-avatar-seed.ts';
import { HIRE_ACTIONS, HIRE_DEFAULT_LIMITS, HIRE_LEVELS, HIRE_PRESETS, hireActionLabel, hireDrifted, hireLevelLabel, hireMergeLimit, hireMergePreset, hirePresetFields, hirePresetLabel, hirePresetRecommendedSkills, type HireAction, type HireAppliedFields, type HireLevel, type HirePreset } from './role-hire-presets.ts';
type Props = {
    savedGroups?:GroupApi;
    navigation?: {state:WorkbenchDirectoryNavigation;change:(patch:WorkbenchDirectoryPatch)=>void};
    work: BindingClient;
    resourceApi: ResourceApi;
    memoryApi?: RoleMemoryApi;
    autoDreamTrigger?: ScheduleTrigger | undefined;
  dailyLogApi?: RoleDailyLogApi;
    runtimeConfigs?: RoleRuntimeConfigApi | undefined;
    capabilityState?: CapabilityPreview | undefined;
    persistence?: {
        assignmentPending: boolean;
        recoverAssignment: () => Promise<string>;
        assign: (role: PreviewRole, fields: {
            title: string;
            goal: string;
            scope: CollaborationScope;
        }) => Promise<string>;
        lifecycle: RoleLifecyclePort;
        pendingFields: () => RoleFields | undefined;
        create: (fields: RoleFields) => Promise<string>;
        edit: (role: PreviewRole, fields: RoleFields) => Promise<void>;
        load: () => void;
        loading: boolean;
        error: string | undefined;
    };
    embedded?: boolean;
    autoFocus?: boolean;
    conversations: (id: string) => ReactNode;
    talk: (id: string) => Promise<boolean>;
    visible: boolean;
    state: TaskPreview;
    collaboration: CollaborationPreview;
    selected: string | null;
    select: (id: string | null) => void;
    change: (change: TeamChange) => void;
    openTask: (id: string) => void;
    openGroup: (id: string) => void;
    resources: () => void;
    nativeSettings: () => void;
    capabilities: (id: string) => ReactNode;
    plans: (id: string) => ReactNode;
    scopeLabels: readonly BusinessScopeLabel[];
    /** 从业务页「查看同事」跳进来时聚焦的业务范围：展开该分区并滚到眼前（透传给 StaffRoster 的既有 focusScope）。 */
    focusScope?: string | null;
    /** 本人用户名（personalProfile.displayName）：分身在名单与个人主页上按「{用户名} 的分身」显示。 */
    profileName?: string;
    pageCreate?: {api:PageCreateApi;prepare:(prompt:{sourceId:string;title:string;text:string})=>void;openMarket:()=>void};
};
type RoleInput = {
    draft: TwinDraftInput | undefined;
    // 「编辑」态提到 RoleInput 里（而不是 RoleDetail 内部 useState），和 draft 同一套外部受控约定，
    // 换选中岗位时随 input 一起重置，行为和旧页签态一致。
    editing: boolean;
};
const emptyInput = (): RoleInput => ({ draft: undefined, editing: false });
const closed = (state: string) => state === 'completed' || state === 'cancelled';
// 身份栏「岗位一句话」只取 role.duty 的第一句；没有明显分句符号时整段落回退。
const firstSentence = (text: string) => text.split(/[。.!?！？\n]/)[0]?.trim() || text.trim();
/** 全宽名单工具行上的三个状态胶囊（原型 数字员工形象.jsx:107 的 statusFilters）。恢复旧筛选记忆时也拿它当白名单。 */
const STATUS_PILL_IDS = ['all', 'busy', 'paused'] as const;
type PendingRoleDraft={initial:RoleFields;resolve:(id:string)=>void;reject:(reason:unknown)=>void}
export function TeamPage({ savedGroups,navigation,work, resourceApi, memoryApi, dailyLogApi, autoDreamTrigger, runtimeConfigs, capabilityState, persistence, embedded = false, autoFocus = true, conversations, talk, visible, state, collaboration, selected, select, change, openTask, openGroup, resources, nativeSettings, capabilities, plans, scopeLabels, focusScope, profileName = defaultPersonalDisplayName, pageCreate }: Props) {
    const { locale, t, list, number } = useI18n();
    const collaborationScopes = useBusinessScopes();
    // 「正在忙」是派生态（不是 role.state），四档筛选与成员行状态点共用同一份人话词条（team.roster.status.*，见 roleStatusLabel）。
    const rosterStatusLabel = (value: 'busy' | PreviewRole['state']) => roleStatusLabel(value, t);
    // 身份筛选（数字员工/分身）在第二期从界面撤掉，但合法值表仍收 employee|twin：旧记忆里带这两个值时
    // 整份 category JSON 才不会被严格校验退回默认，连累 status 与折叠记忆一起丢；读到之后一律按 'all' 用，写回也固定 'all'。
    const restoredFilters=readDirectoryFilterCategory(navigation?.state.category,{status:'all',kind:'all',open:''},{status:['all','busy',...Object.keys(roleStates)],kind:['all','employee','twin']});
    const kind='all' as const;
    // 状态也一样：第一期的筛选弹层有五档，第二期只剩三个胶囊。合法值表保持五档（旧 JSON 才不会整份回退连累 open 折叠记忆），
    // 但恢复时把界面不再暴露的档位（active/retired）折叠回 'all'——否则名单被静默过滤，三个胶囊全是未按下，用户没有任何手段解除。
    const restoredStatus=restoredFilters.status as 'all'|'busy'|PreviewRole['state'];
    const [query, setQuery] = useState(navigation?.state.query??''), [status, setStatus] = useState<'all' | 'busy' | PreviewRole['state']>(STATUS_PILL_IDS.includes(restoredStatus as typeof STATUS_PILL_IDS[number])?restoredStatus:'all'), [creating, setCreating] = useState(false), [createEntryOpen, setCreateEntryOpen] = useState(false);
    const [pendingRoleDraft,setPendingRoleDraft]=useState<PendingRoleDraft>();
    const confirmRoleDraft=(preview:PageCreateDraftPreview)=>new Promise<string>((resolve,reject)=>{
        try{setPendingRoleDraft({initial:createRoleFormInitial(preview),resolve,reject})}
        catch(error){reject(error)}
    });
    // 折叠记忆扩既有 directories.team.category 这份 JSON，不新开 localStorage 键（见计划「决定」第 1 条）。
    const [fold, setFold] = useState<RosterFoldState>(()=>readRosterFold(restoredFilters.open));
    const [directoryMode,setDirectoryMode]=useState<ExampleDirectoryMode>(()=>exampleDirectoryMode(!!persistence));
    const [inputs, setInputs] = useState<Record<string, RoleInput>>({});
    const [recovering, setRecovering] = useState(false), [assignmentError, setAssignmentError] = useState<string>();
    const directoryFocus = useDirectoryFocus(visible, selected ?? undefined, autoFocus);
    // 折叠记忆算出来是空串时干脆不写 open 这个键：空串会被目录筛选的严格校验当成非法值，
    // 连带把同一份 JSON 里的 status/kind 一起退回默认（终审 H1）。没有折叠记忆就等于没有这个键。
    useEffect(()=>{if(!visible)return;const open=writeRosterFold(fold,{status,kind});navigation?.change({query,category:writeDirectoryFilterCategory(open?{status,kind,open}:{status,kind})})},[visible,navigation,query,status,kind,fold]);
    useEffect(()=>{const item=state.roles.find(role=>role.id===selected);if(item)setDirectoryMode(item.storage==='persistent'?'saved':'sandbox')},[selected,state.roles]);
    if (!visible)
        return null;
    // 名单与个人主页显示的分身名字是「{用户名} 的分身」，搜索也按这个名字命中；存储里的 role.name 一并保留在候选里。
    const roleDisplayName=(role:PreviewRole)=>role.kind==='twin'?twinDisplayName(profileName,t):role.name;
    const isSandbox=directoryMode==='sandbox',directoryRoles=visibleRoleDirectory(state.roles,directoryMode),directoryState={...state,roles:directoryRoles,tasks:visibleTaskDirectory(state.tasks,directoryMode)};
    // 「有待办」判据用 roleIsBusy（与分区头三个数同一口径），其余三档仍按 role.state 精确匹配。
    const rows = directoryRoles.filter(role => (status === 'all' || (role.kind === 'employee' && (status === 'busy' ? roleIsBusy(role.id, directoryState.tasks) : role.state === status))) && [roleDisplayName(role), role.name, role.duty, ...role.skills].some(text => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
    const role = directoryRoles.find(item => item.id === selected);
    // 页头说的是「在岗数字员工」，因此只统计 active；暂停只是停止接新任务，仍可聊天，但不算在岗。
    // 分身不是数字员工，不进入人数与待办统计；hasTwin 只决定零员工时能否说明默认分身已经就位。
    // busy 数人、waiting 数事，且都在全局只统计一次——不能按分区求和，跨范围成员会被重复计算。
    const summaryEmployees = directoryRoles.filter(item => item.kind === 'employee' && item.state === 'active');
    const summaryCounts = rosterCounts(summaryEmployees, directoryState.tasks);
    const summaryPeople = summaryCounts.people;
    const summaryBusy = summaryCounts.busy;
    const summaryWaiting = summaryCounts.waiting;
    const hasTwin = directoryRoles.some(item => item.kind === 'twin');
    const summaryKey = summaryPeople===0
      ? (hasTwin?'team.page.summaryNoEmployees':'team.page.summaryEmpty')
      : summaryWaiting>0?'team.page.summary'
      : summaryBusy>0?'team.page.summaryBusy'
      : 'team.page.summaryQuiet';
    // 状态胶囊三档（原型 数字员工形象.jsx:107）：全部 / 正在忙 / 暂停。
    // 第三档用筛选档专用的 team.page.statusPill.paused（「暂停」），不是行尾状态点的「先歇一会」。
    const statusPills = [['all', t('team.page.statusPill.all')], ['busy', rosterStatusLabel('busy')], ['paused', t('team.page.statusPill.paused')]] as const;
    const resetDirectory=()=>{setQuery('');setStatus('all');select(null)};
    const showRoster = !embedded && !role;
    const detailPane = role
      ? <RoleDetail savedGroups={savedGroups} profileName={profileName} work={work} resourceApi={resourceApi} memoryApi={memoryApi} dailyLogApi={dailyLogApi} autoDreamTrigger={autoDreamTrigger} runtimeConfigs={runtimeConfigs} capabilityState={capabilityState} persistence={isSandbox?undefined:persistence} conversations={conversations} {...(!isSandbox?{talk}:{})} input={inputs[role.id] ?? emptyInput()} update={patch => setInputs(current => ({ ...current, [role.id]: { ...(current[role.id] ?? emptyInput()), ...patch } }))} key={role.id} role={role} state={directoryState} collaboration={collaboration} change={change} back={() => select(null)} openTask={openTask} openGroup={openGroup} resources={resources} nativeSettings={nativeSettings} capabilities={capabilities} plans={plans}/>
      : <div className={css.empty}><Bot size={38}/><h2>{t('team.landingTitle')}</h2><p>{t('team.landingDescription')}</p></div>;
    return <section data-team-directory-mode={directoryMode} className={clsx(css.page, css.alignedPage,isSandbox&&css.sandboxMode, teamCss.teamPage, embedded && css.embeddedPage, embedded && teamCss.embeddedTeam)} aria-label={t('navigation.team')}>

    {!isSandbox&&<div className={css.buttons}>{persistence?.assignmentPending && <button type="button" disabled={recovering} onClick={async () => { setRecovering(true); setAssignmentError(undefined); try {
        openTask(await persistence.recoverAssignment());
    }
    catch (e) {
        setAssignmentError(localizeWorkError(locale, e));
    }
    finally {
        setRecovering(false);
    } }}>{t('team.recoverAssignment')}</button>}{assignmentError && <p role="alert">{assignmentError}</p>}{persistence && <RoleLifecycleRecovery api={persistence.lifecycle}/>}{persistence?.pendingFields() && <button type="button" onClick={() => setCreating(true)}>{t('team.continueCreation')}</button>}{persistence?.error && <p role="alert">{persistence.error}</p>}</div>}
    {/* 三态装配（简报 功能验证）：非嵌入未选中＝一页全宽名单；非嵌入已选中＝一页个人主页；嵌入态照旧只有详情。 */}
    <div {...directoryFocus} className={clsx(embedded ? css.layout : showRoster ? teamCss.rosterPage : teamCss.detailPage, embedded && role && css.hasSelection)}>
      {showRoster
        ? <section data-teloa-pane="directory" tabIndex={-1} className={teamCss.rosterPane} aria-label={t('navigation.team')}>
            <header className={teamCss.rosterHead}>
              <div className={teamCss.rosterHeadMain}>
                <span className={css.eyebrow}>{t('team.page.eyebrow')}</span>
                <div className={teamCss.rosterTitleRow}>
                  <Bot size={22} aria-hidden="true"/>
                  <h1>{t('navigation.team')}</h1>
                  {persistence&&!isSandbox&&<button type="button" className={directoryCss.iconAction} disabled={persistence.loading} aria-label={t(persistence.loading ? 'team.loading' : 'team.refresh')} title={t(persistence.loading ? 'team.loading' : 'team.refresh')} onClick={persistence.load}><RefreshCw size={15}/></button>}
                </div>
                <p className={teamCss.rosterSummary}>{t(summaryKey, { people: number(summaryPeople), busy: number(summaryBusy), waiting: number(summaryWaiting) })}</p>
              </div>
              <button type="button" className={teamCss.rosterHire} aria-expanded={pageCreate ? createEntryOpen : undefined} aria-controls={pageCreate ? 'team-create-entry' : undefined} onClick={() => pageCreate ? setCreateEntryOpen(value => !value) : setCreating(true)}><Plus size={16}/>{t('team.action.new')}</button>
            </header>
            <div className={teamCss.rosterBar}>
              <label className={teamCss.rosterSearch}><Search size={16}/><input aria-label={t('team.search')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('team.search')}/>{query && <button type="button" className={teamCss.rosterSearchClear} aria-label={t('team.page.searchClear')} title={t('team.page.searchClear')} onClick={() => setQuery('')}><X size={14}/></button>}</label>
              <span className={teamCss.statusPills} role="group" aria-label={t('team.stateFilter')}>
                {statusPills.map(([id, label]) => <button key={id} type="button" aria-pressed={status === id} onClick={() => setStatus(id)}>{label}</button>)}
              </span>
              {/* 规格 §4.2 总数 chip：count 是筛选后去重的岗位数，countNote 只在有人跨范围时出现（rosterTotal/rosterHasMultiScope 见 team-roster-grouping.ts）。 */}
              <div className={rosterCss.rosterCount}>
                <span aria-describedby={rosterHasMultiScope(rows, scopeLabels) ? 'team-roster-count-note' : undefined}>{t('team.roster.count', { count: number(rosterTotal(rows)) })}</span>
                {rosterHasMultiScope(rows, scopeLabels) && <small id="team-roster-count-note">{t('team.roster.countNote')}</small>}
              </div>
            </div>
            {pageCreate&&persistence&&!isSandbox&&createEntryOpen&&<div id="team-create-entry" className={teamCss.createEntry}><CreateEntry entity="role" api={pageCreate.api} openForm={()=>{setCreateEntryOpen(false);setCreating(true)}} openMarket={()=>{setCreateEntryOpen(false);pageCreate.openMarket()}} prepare={pageCreate.prepare} onConfirm={confirmRoleDraft}/></div>}
            {rows.length > 0
              ? <StaffRoster profileName={profileName} roles={rows} labels={scopeLabels} tasks={directoryState.tasks} {...(focusScope ? { focusScope } : {})} fold={fold} onFoldChange={setFold} searching={!!query.trim()} onSelect={id => select(id)} onHire={() => setCreating(true)}/>
              : <div className={css.empty}><Bot size={30}/><h2>{t(directoryRoles.length ? 'team.empty.noMatch' : 'team.empty.unconfigured')}</h2><p>{t(directoryRoles.length ? 'team.empty.noMatchDescription' : 'team.empty.unconfiguredDescription')}</p>{directoryRoles.length > 0 && <button type="button" onClick={() => { setQuery(''); setStatus('all'); }}>{t('team.empty.reset')}</button>}</div>}
          </section>
        : detailPane}
    </div>
    {(creating||pendingRoleDraft!==undefined) && <RoleForm work={work} resourceApi={resourceApi} runtimeConfigs={runtimeConfigs} initial={pendingRoleDraft?.initial??(isSandbox?undefined:persistence?.pendingFields())} persistent={!!persistence&&!isSandbox} close={() => {if(pendingRoleDraft){pendingRoleDraft.reject({code:'teloa/cancelled'});setPendingRoleDraft(undefined)}setCreating(false)}} save={async (fields) => { try{const id = persistence&&!isSandbox ? await persistence.create(fields) : crypto.randomUUID();if(pendingRoleDraft){const pending=pendingRoleDraft;setPendingRoleDraft(undefined);setCreating(false);pending.resolve(id);return}if(persistence&&!isSandbox){setCreating(false);setQuery('');setStatus('all');select(id);return}change({ type: 'create', id, fields, now: new Date().toISOString() });setCreating(false);setQuery('');setStatus('all');select(id)}catch(error){if(pendingRoleDraft){pendingRoleDraft.reject(error);setPendingRoleDraft(undefined);setCreating(false)}throw error}}}/>}
  </section>;
}
// 导出给 team-profile-sections.test.ts 用 renderToStaticMarkup 直接核对「编辑」态的五组呈现，不必经过 TeamPage 的内部选中态。
export function RoleDetail({ savedGroups,work, resourceApi, memoryApi, dailyLogApi, autoDreamTrigger, runtimeConfigs, capabilityState, persistence, conversations, talk, input, update, role, state, collaboration, change, back, openTask, openGroup, resources, nativeSettings, capabilities, plans, profileName = defaultPersonalDisplayName }: {
    work: BindingClient;
    profileName?: string;
    resourceApi: ResourceApi;
    savedGroups?:GroupApi | undefined;
    memoryApi: Props['memoryApi'];
    dailyLogApi?: Props['dailyLogApi'];
    autoDreamTrigger?: Props['autoDreamTrigger'];
    runtimeConfigs?: RoleRuntimeConfigApi | undefined;
    capabilityState?: CapabilityPreview | undefined;
    persistence: Props['persistence'];
    conversations: Props['conversations'];
    talk?: Props['talk'];
    input: RoleInput;
    update: (patch: Partial<RoleInput>) => void;
    role: PreviewRole;
    state: TaskPreview;
    collaboration: CollaborationPreview;
    change: Props['change'];
    back: () => void;
    openTask: Props['openTask'];
    openGroup: Props['openGroup'];
    resources: Props['resources'];
    nativeSettings: Props['nativeSettings'];
    capabilities: Props['capabilities'];
    plans: Props['plans'];
}) {
    const { locale, t, dateTime, list } = useI18n();
    const collaborationScopes = useBusinessScopes();
    const stamp = (value: string) => dateTime(value, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const [form, setForm] = useState<'edit' | 'retire' | 'assign' | 'memory'>(), [error, setError] = useState<string>(), [chatNotice, setChatNotice] = useState<string>(), [editingRole, setEditingRole] = useState<PreviewRole>();
    const [savedMemories, setSavedMemories] = useState<RoleMemory[]>([]), [memoryLoading, setMemoryLoading] = useState(false), [memoryError, setMemoryError] = useState<string>(), [memoryDiscarded, setMemoryDiscarded] = useState(false);
    // 「它记得的事 / 工作日志」两页签只在同事主页出现（memory 组内），默认停在既有的「它记得的事」。
    const [memoryTab, setMemoryTab] = useState<'note' | 'log'>('note');
    // 「判断力样本」分组要知道「当前有效日志」建议撤回了哪些已确认记忆：取最近一条未丢弃的日志（list 已按 day 倒序）。
    const [currentPruneHints, setCurrentPruneHints] = useState<RoleDailyLogPruneHint[]>([]);
    useEffect(() => { let active = true; if (role.storage !== 'persistent' || !dailyLogApi) { setCurrentPruneHints([]); return; } void dailyLogApi.list(role.id).then(async rows => {
        const kept = rows.find(row => row.state === 'kept');
        if (!kept) { if (active) setCurrentPruneHints([]); return; }
        const log = await dailyLogApi.get(role.id, kept.id);
        if (active) setCurrentPruneHints(log.pruneHints);
    }).catch(() => { if (active) setCurrentPruneHints([]); }); return () => { active = false; }; }, [role.id, role.storage, dailyLogApi]);
    const MEMORY_TABS = ['note', 'log'] as const;
    const moveMemoryTab = (event: React.KeyboardEvent<HTMLButtonElement>) => {
        const index = MEMORY_TABS.indexOf(memoryTab);
        if (event.key === 'ArrowRight') { setMemoryTab(MEMORY_TABS[(index + 1) % MEMORY_TABS.length]!); event.preventDefault(); }
        else if (event.key === 'ArrowLeft') { setMemoryTab(MEMORY_TABS[(index - 1 + MEMORY_TABS.length) % MEMORY_TABS.length]!); event.preventDefault(); }
        else if (event.key === 'Home') { setMemoryTab(MEMORY_TABS[0]!); event.preventDefault(); }
        else if (event.key === 'End') { setMemoryTab(MEMORY_TABS[MEMORY_TABS.length - 1]!); event.preventDefault(); }
    };
    const editing = input.editing, setEditing = (value: boolean) => update({ editing: value });
    const talkDisabledReason=role.storage==='persistent'?undefined:t('team.sandbox.chatUnavailable');
    // 六组折叠 + 「它的变更记录」次级折叠：默认全收起，只在展开时才把 aria-expanded 翻成 true，供屏幕阅读器识别折叠态。
    const [openSections, setOpenSections] = useState<Record<'changes' | RoleProfileSection, boolean>>({ changes: false, how: false, memory: false, tools: false, reading: false, limit: false, runtime: false });
    // `currentTarget` 必须在事件处理器里当场读出来：React 合成事件派发完就把它置空，等到状态更新函数真正执行时它已是 null，
    // 在更新函数里读 `event.currentTarget.open` 会抛 TypeError 并把整个插件槽位打崩（展开第二个分组时必现）。
    const toggleSection = (key: 'changes' | RoleProfileSection) => (event: React.SyntheticEvent<HTMLDetailsElement>) => { const open = event.currentTarget.open; setOpenSections(current => ({ ...current, [key]: open })); };
    const [runtimeState, setRuntimeState] = useState<RuntimeConfigLoadState>({ status: 'idle' });
    useEffect(() => { let active = true; if (!runtimeConfigs) { setRuntimeState({ status: 'idle' }); return; } setRuntimeState(runtimeConfigLoading()); void runtimeConfigs.list().then(value => { if (active)
        setRuntimeState(runtimeConfigReady(value)); }).catch(error => { if (active)
        setRuntimeState(runtimeConfigFailed(error)); }); return () => { active = false; }; }, [runtimeConfigs]);
    // 记忆列表只在打开「编辑」时才加载，避免每次进入个人主页都发起请求（旧六页签时代是切到「记忆」页签才加载，这里换成切到「编辑」）。
    // 分身主页没有「编辑」开关，「判断力样本」页签本身就是这份列表，所以 twin 一进页面就加载。
    useEffect(() => { let active = true; if ((!editing && role.kind !== 'twin') || role.storage !== 'persistent' || !memoryApi)
        return; setMemoryLoading(true); setMemoryError(undefined); void memoryApi.list(role.id).then(rows => { if (active)
        setSavedMemories(rows); }).catch(error => { if (active)
        setMemoryError(localizeWorkError(locale, error)); }).finally(() => { if (active)
        setMemoryLoading(false); }); return () => { active = false; }; }, [editing, role.id, role.storage, memoryApi, locale]);
    const retired = role.state === 'retired', twin = role.kind === 'twin';
    const unfinished = state.tasks.filter(task => task.assigneeId === role.id && !closed(task.state));
    const lifecycle = roleLifecyclePath(role.state,t);
    const lifecyclePending = persistence?.lifecycle.pending?.roleId === role.id;
    const blocker = lifecyclePending ? t('team.detail.blocker.pending') : role.state === 'paused' ? t('team.detail.blocker.paused') : role.state === 'retired' ? t('team.detail.blocker.retired') : t('team.detail.blocker.none');
    const act = (command: TeamChange) => { try {
        change(command);
        setError(undefined);
        return true;
    }
    catch (error) {
        setError(localizeWorkError(locale, error));
        return false;
    } };
    // 身份状态只表示岗位是否在岗，待办工作独立显示。
    const identityStatus = role.state;
    const statusLabel = (value: 'active' | 'busy' | 'paused' | 'retired') => roleStatusLabel(value, t);
    const doingNow = roleNowDoing(role.id, state.tasks);
    const dutyLead = firstSentence(role.duty);
    const timeline = roleTimeline(role.id, state.tasks, state.artifacts.map(item => item.source.kind === 'task' ? { taskId: item.source.id } : {}));
    // 历史关联的工作：旧「工作」页签整块，规格把它挪进「它记得的事」组的折叠小字；群组归属挪到编辑区末尾恢复可达（T3 遗留：openGroup/collaboration/plans 曾是死参数）。
    const related = state.tasks.filter(task => task.assigneeId === role.id || task.authorId === role.id || task.assigneeHistory.includes(role.id));
    const groups = collaboration.groups.filter(group => group.memberIds.includes(role.id));
    // 记忆列表（候选 → 本人确认 → 私有保留或撤回）由同事个人主页的「它记得的事」与分身主页的「判断力样本」共用同一份节点，
    // 分身页面不再重写一遍加载、确认与撤回接线；分身分支的标题与路径说明仍按 twin 取词条（team.detail.tab.judgment / team.memory.twinPath）。
    // source.kind==='daily-digest'/'habit-digest' 读专属词条，sourceAvailable===false 追加 roleMemory.sourceGone
    // （替换原先传给 team.memory.source 的空串 availability）；其余来源类别沿用既有 team.memory.source 整句拼装。
    const memorySourceLabel = (memory: RoleMemory) => {
        if (memory.source.kind === 'daily-digest' || memory.source.kind === 'habit-digest') {
            const base = t(memory.source.kind === 'daily-digest' ? 'roleMemory.sourceDaily' : 'roleMemory.sourceHabit');
            return memory.sourceAvailable ? base : base + ' · ' + t('roleMemory.sourceGone');
        }
        return t('team.memory.source', { title: memory.sourceTitle, kind: memory.source.kind, version: memory.source.version, availability: memory.sourceAvailable ? '' : t('team.memory.sourceUnavailable') });
    };
    // 私有记忆的 30 条上限在服务端只回 teloa/conflict；确认被拒时给出这一处的专属说明，不让本人只看到一句通用冲突。
    const localizeMemoryError = (memory: RoleMemory, error: unknown) =>
        memory.visibility.kind === 'private' && !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'teloa/conflict'
            ? t('roleMemory.privateLimit')
            : localizeWorkError(locale, error);
    const renderSavedMemory = (memory: RoleMemory, suggested = false) => { const path = roleMemoryPath(memory.state, t); return <article className={teamCss.memory} key={memory.id}><header><strong>{memory.title}</strong><span>{path.label} · {t('team.memory.contentVersion', { version: memory.content.version })}</span></header><p>{memory.content.markdown}</p><div className={teamCss.memoryPath}><span>{memorySourceLabel(memory)}</span><span>{path.summary}</span><small>{t('team.memory.next', { next: path.next })}</small></div><small>{memory.visibility.kind === 'private' ? t('team.memory.private') : list(memory.visibility.scopeIds.map(scope => collaborationScopes[scope] ?? scope))} · {stamp(memory.candidateAt)}</small>{suggested && <p className={css.muted}>{t('dailyLog.pruneHintHint')}</p>}{!retired && memory.state !== 'withdrawn' && memoryApi && <div className={css.buttons}>{memory.state === 'candidate' && <button type="button" disabled={!memory.sourceAvailable} onClick={async () => { try { const saved = await memoryApi.confirm(memory.id, memory.stateVersion); setSavedMemories(rows => rows.map(row => row.id === saved.id ? saved : row)); setMemoryError(undefined) } catch (error) { setMemoryError(localizeMemoryError(memory, error)) } }}>{t('team.memory.confirm')}</button>}<button type="button" onClick={async () => { try { const saved = await memoryApi.withdraw(memory.id, memory.stateVersion); setSavedMemories(rows => rows.map(row => row.id === saved.id ? saved : row)); setMemoryError(undefined) } catch (error) { setMemoryError(localizeWorkError(locale, error)) } }}>{t('team.memory.withdraw')}</button></div>}</article> };
    // 分身「Auto Dream · 习惯观察」的「记下来」：把观察日志的一条事实提升为私有记忆候选（T11）。
    // source 恒为 {kind:'habit-digest',id:<日志 id>,version:1}，visibility 恒私有——与简报铁律逐字一致，不接受调用方覆盖。
    const promoteHabit = memoryApi ? async (log: RoleDailyLog, value: { title: string; markdown: string }) => {
        const saved = await memoryApi.create({ roleId: role.id, expectedRoleVersion: role.version, title: value.title, markdown: value.markdown, source: { kind: 'habit-digest', id: log.id, version: 1 }, visibility: { kind: 'private', scopeIds: [] } });
        setSavedMemories(rows => rows.some(row => row.id === saved.id) ? rows.map(row => row.id === saved.id ? saved : row) : [...rows, saved]);
    } : undefined;
    const memorySection = <>
      <header><h3>{t(twin ? 'team.detail.tab.judgment' : 'team.memory.candidate')}</h3>{!retired && <button type="button" onClick={() => setForm('memory')}>{t('team.memory.record')}</button>}</header>
      <p className={css.muted}>{t(twin ? 'team.memory.twinPath' : 'team.memory.rolePath')} {t(role.storage === 'persistent' ? 'team.memory.persistentNote' : 'team.memory.demoNote')}</p>
      {memoryError && <p role="alert">{memoryError}</p>}
      {memoryLoading && <p>{t('team.memory.loading')}</p>}
      {role.storage === 'persistent' ? savedMemories.length ? groupRoleMemories(savedMemories, currentPruneHints).map(group => group.items.length ? <div key={group.id}><h4>{t(group.titleKey as Parameters<typeof t>[0])}</h4>{group.items.map(memory => renderSavedMemory(memory, group.id === 'pruneSuggested'))}</div> : null) : !memoryLoading && <p>{t('team.memory.emptyPersistent')}</p> : role.memories.length ? role.memories.map(memory => { const path = roleMemoryPath(memory.status, t); return <article className={teamCss.memory} key={memory.id}><header><strong>{memory.title}</strong><span>{path.label} · v{memory.version}</span></header><p>{memory.text}</p><div className={teamCss.memoryPath}><span>{t('team.memory.source', { title: memory.source, kind: '', version: '', availability: '' })}</span><span>{path.summary}</span><small>{t('team.memory.next', { next: path.next })}</small></div><small>{memory.scope === 'private' ? t('team.memory.private') : t('team.memory.roleScope')} · {stamp(memory.updatedAt)}</small>{!retired && memory.status !== 'withdrawn' && <div className={css.buttons}>{memory.status === 'candidate' && <button type="button" onClick={() => act({ type: 'memory-decide', roleId: role.id, memoryId: memory.id, expectedVersion: memory.version, action: 'confirm', now: new Date().toISOString() })}>{t('team.memory.confirmDemo')}</button>}<button type="button" onClick={() => act({ type: 'memory-decide', roleId: role.id, memoryId: memory.id, expectedVersion: memory.version, action: 'withdraw', now: new Date().toISOString() })}>{t('team.memory.withdrawDemo')}</button></div>}</article> }) : <p>{t('team.memory.emptyDemo')}</p>}
    </>;
    // 页顶不再常驻 team.detail.version：版本号是系统态，照原型只留返回链接（终审 T5），版本移进「它的变更记录」里的折叠小字。
    return <article data-teloa-pane="detail" tabIndex={-1} className={css.detail} aria-label={t('navigation.team')}><header className={css.detailHeader}><button type="button" className={css.back} onClick={back}><ArrowLeft size={16}/>{t('team.detail.back')}</button></header>
    {error && <div className={css.error} role="alert">{error}<button type="button" aria-label={t('team.detail.closeError')} onClick={() => setError(undefined)}><X size={15}/></button></div>}
    {role.storage === 'persistent' && memoryApi?.recoveryMessage() && <p role="alert">{localizeWorkError(locale, memoryApi.recoveryMessage())} {t('recovery.nextStep')}</p>}
    {role.storage === 'persistent' && memoryApi?.recoveryMessage() && <button type="button" onClick={() => { memoryApi.discard(); setMemoryDiscarded(true); }}>{t('recovery.discard')}</button>}
    {memoryDiscarded && <p role="status">{t('recovery.discarded')}</p>}
    {role.storage === 'persistent' && memoryApi?.pending() && <div className={css.buttons}><button type="button" onClick={async () => { try {
        const saved = await memoryApi.recover();
        if (saved.roleId === role.id)
            setSavedMemories(rows => rows.some(row => row.id === saved.id) ? rows.map(row => row.id === saved.id ? saved : row) : [...rows, saved]);
        setMemoryError(undefined);
    }
    catch (error) {
        setMemoryError(localizeWorkError(locale, error));
    } }}>{t('team.detail.recoverMemory')}</button></div>}
    {memoryError && <p role="alert">{memoryError}</p>}
    {/* 分身整页照原型 原型.jsx:459-462 重做（非嵌入与嵌入态都走这支），其余同事仍是身份栏 + 时间线的两栏个人主页；
        「全部同事」返回、错误条与各个对话框都留在外面，两支共用。 */}
    {twin
      ? <TwinProfile profileName={profileName} role={role} draft={input.draft} update={draft => update({ draft })} save={act} {...(talk?{talk:async()=>{await talk(role.id)}}:talkDisabledReason?{talkDisabledReason}:{})} conversations={role.storage==='persistent'?conversations(role.id):null} samples={memorySection} habits={role.storage==='persistent'&&dailyLogApi?<RoleDailyLogPanel trigger={autoDreamTrigger} roleId={role.id} kind="habit-digest" api={dailyLogApi} memoryApi={memoryApi} {...(promoteHabit?{promote:promoteHabit}:{})}/>:undefined}/>
      : <div className={teamCss.homepage}>
      <aside className={teamCss.identityRail} aria-label={t('team.profile.title')}>
        <StaffAvatar initial={role.name.slice(0, 1)} seed={role.id} size="xl"/>
        <h2>{role.name}</h2>
        <p>{dutyLead}</p>
        <span className={teamCss.identityStatusRow} data-identity-status={identityStatus}><StatusLabel label={statusLabel(identityStatus)} mark={identityStatus==='active'?'enabled':identityStatus==='paused'?'paused':'retired'} tone={identityStatus==='active'?'good':'muted'}/></span>
        <div className={teamCss.identityToday}><small>{t('team.profile.today')}</small><strong>{doingNow ?? t('team.roster.idle')}</strong></div>
        <small className={teamCss.identityOwner}><Users size={13}/>{t('team.profile.owner')}</small>
        {retired ? <div className={teamCss.notice}><strong>{lifecycle.label}</strong><p>{role.retirementReason}</p><p>{lifecycle.summary}</p><p>{t('team.detail.retiredNext', { next: lifecycle.next })}</p>{talk&&<button type="button" className={teamCss.identityPrimary} onClick={()=>{setChatNotice(undefined);void talk(role.id).then(opened=>{if(!opened)setChatNotice(t('team.profile.historyEmpty'))}).catch(error=>setError(localizeWorkError(locale,error)))}}>{t('team.profile.action.history')}</button>}</div> : <div className={teamCss.identityActions}>{/* “找它说话”直接进入最近关联会话；预览身份不接正式会话链路。 */}<button type="button" className={teamCss.identityPrimary} disabled={!talk} title={talkDisabledReason} aria-describedby={talkDisabledReason?`role-chat-note-${encodeURIComponent(role.id)}`:undefined} onClick={()=>{if(!talk)return;setChatNotice(undefined);void talk(role.id).then(opened=>{if(!opened)setChatNotice(t('team.profile.historyEmpty'))}).catch(error=>setError(localizeWorkError(locale,error)))}}>{t('team.profile.action.chat')}</button><button type="button" disabled={role.state !== 'active'} onClick={() => setForm('assign')}>{t('team.profile.action.assign')}</button>{role.storage !== 'persistent' && <><button type="button" onClick={() => act({ type: 'lifecycle', roleId: role.id, expectedVersion: role.version, action: role.state === 'paused' ? 'resume' : 'pause', reason: t(role.state === 'paused' ? 'team.detail.resumeReason' : 'team.detail.pauseReason'), now: new Date().toISOString() })}>{role.state === 'paused' ? <Play size={14}/> : <Pause size={14}/>}{t(role.state === 'paused' ? 'team.profile.action.resume' : 'team.profile.action.pause')}</button><button type="button" disabled={role.storage === 'persistent'} onClick={() => setForm('retire')}>{t('team.profile.action.retire')}</button></>}</div>}
        {chatNotice&&<p role="status" className={teamCss.muted}>{chatNotice}</p>}
        {talkDisabledReason&&<p id={`role-chat-note-${encodeURIComponent(role.id)}`} className={teamCss.muted}>{talkDisabledReason}</p>}
        {role.storage==='persistent'&&<details className={teamCss.chatPanel}><summary>{t('objectConversations.aria')}</summary>{conversations(role.id)}</details>}
        {!retired && <button type="button" className={teamCss.identityEditLink} onClick={() => { setEditingRole(role); setForm('edit'); }}>{t('team.action.edit')}</button>}
        {role.storage === 'persistent' && persistence && <RoleLifecycle role={role} api={persistence.lifecycle}/>}
      </aside>
      <section className={teamCss.homepageBody}>
        <header className={teamCss.homepageHead}><h3>{t('team.profile.timeline.title')}</h3><button type="button" aria-expanded={editing} onClick={() => setEditing(!editing)}>{t(editing ? 'team.profile.viewActivity' : 'team.profile.edit')}</button></header>
        {editing ? <div className={teamCss.sectionList}>
          <details className={teamCss.section} open={openSections.changes} onToggle={toggleSection('changes')}><summary aria-expanded={openSections.changes} aria-controls="role-profile-changes"><strong>{t('team.profile.changes')}</strong></summary><div id="role-profile-changes" className={teamCss.sectionBody}><ol className={css.history}>{role.history.map((item, index) => <li key={index}><span>{item.text}</span><small>{roleName(state.roles, item.actorId, t)} · {stamp(item.at)}</small></li>)}</ol><details><summary>{t('team.history.identity')}</summary><p>{role.id}</p><p>{t('team.detail.version', { version: role.version })}</p></details></div></details>
          {ROLE_PROFILE_SECTIONS.map(section => { const { title, lead } = roleProfileSectionKeys(section), bodyId = `role-profile-${section}`; return <details key={section} className={teamCss.section} open={openSections[section]} onToggle={toggleSection(section)}>
            <summary aria-expanded={openSections[section]} aria-controls={bodyId}><strong>{t(title)}</strong><small>{t(lead)}</small></summary>
            <div id={bodyId} className={teamCss.sectionBody}>
              {section === 'how' && <>
                <h3>{t('team.detail.mission')}</h3><p>{role.duty}</p>
                {role.responsibility ? <dl className={teamCss.responsibilities}>{responsibilityGroups(role.responsibility).filter(group => (['triggers', 'autonomousActions', 'deliveryChecks'] as string[]).includes(group.key)).map(group => <div key={group.key}><dt>{t(group.labelKey)}</dt><dd>{group.items.length ? <ul>{group.items.map(item => <li key={item}>{item}</li>)}</ul> : t('team.detail.notSet')}</dd></div>)}</dl> : <p className={teamCss.inlineNotice}>{t('team.detail.responsibilityMissing')}</p>}
              </>}
              {section === 'memory' && <>
                <nav className={teamCss.tabs} role="tablist" aria-label={t('dailyLog.entry')}>
                  <button type="button" role="tab" id="role-memory-tab-note" aria-selected={memoryTab === 'note'} aria-controls="role-memory-panel-note" tabIndex={memoryTab === 'note' ? 0 : -1} onClick={() => setMemoryTab('note')} onKeyDown={moveMemoryTab}>{t('team.profile.group.memory')}</button>
                  <button type="button" role="tab" id="role-memory-tab-log" aria-selected={memoryTab === 'log'} aria-controls="role-memory-panel-log" tabIndex={memoryTab === 'log' ? 0 : -1} onClick={() => setMemoryTab('log')} onKeyDown={moveMemoryTab}>{t('dailyLog.entry')}</button>
                </nav>
                <div id="role-memory-panel-note" role="tabpanel" aria-labelledby="role-memory-tab-note" hidden={memoryTab !== 'note'}>{memorySection}</div>
                <div id="role-memory-panel-log" role="tabpanel" aria-labelledby="role-memory-tab-log" hidden={memoryTab !== 'log'}>{role.storage === 'persistent' && dailyLogApi ? <RoleDailyLogPanel trigger={autoDreamTrigger} roleId={role.id} kind="daily-digest" api={dailyLogApi} memoryApi={memoryApi}/> : <p className={css.muted}>{t('team.memory.demoNote')}</p>}</div>
                <details className={teamCss.sectionNote}><summary>{t('team.work.related', { count: related.length })}</summary>{related.length ? <div className={teamCss.workList}>{related.map(task => <button type="button" key={task.id} onClick={() => openTask(task.id)}><strong>{task.title}</strong><small>{t(taskStates[task.state])}{taskNeeds(task).length ? ' · ' + taskNeeds(task).map(need => t(attentionKinds[need])).join(' / ') : ''}{t('team.work.owner', { name: roleName(state.roles, task.assigneeId, t) })}{task.assigneeId !== role.id ? t('team.work.historyRelated') : ''}</small></button>)}</div> : <p className={css.muted}>{t('team.work.empty')}</p>}</details>
              </>}
              {section === 'tools' && <>
                <h3>{t('team.detail.defaultSkill')}</h3><p className={css.muted}>{roleSkillNotice(t)}</p>
                <ul>{role.skills.map(skill => <li key={skill}>{skill}</li>)}</ul>{!role.skills.length && <p>{t('team.detail.noSkills')}</p>}
                <button type="button" onClick={nativeSettings}>{t('team.detail.nativeSkills')}</button>
                <div className={teamCss.runtimeSummary}><strong>{runtimeConfigSummary(role.runtimeConfig?.agentPresetId, runtimeState.directory).label}</strong><span>{runtimeConfigSummary(role.runtimeConfig?.agentPresetId, runtimeState.directory).detail}</span></div>
                {capabilities(role.id)}
              </>}
              {section === 'reading' && <>
                <p>{role.dataScope}</p>
                <RoleKnowledge api={resourceApi} ids={role.knowledge} scopes={role.scopes}/>
                <button type="button" onClick={resources}>{t('team.detail.openKnowledge')}</button>
                <dl className={teamCss.facts}><dt>{t('team.detail.businessScope')}</dt><dd>{list(role.scopes.map(scope => collaborationScopes[scope] ?? scope))}</dd></dl>
              </>}
              {section === 'limit' && <>
                {role.responsibility && <dl className={teamCss.responsibilities}>{responsibilityGroups(role.responsibility).filter(group => (['confirmationPoints', 'escalationRules'] as string[]).includes(group.key)).map(group => <div key={group.key}><dt>{t(group.labelKey)}</dt><dd>{group.items.length ? <ul>{group.items.map(item => <li key={item}>{item}</li>)}</ul> : t('team.detail.notSet')}</dd></div>)}</dl>}
                <dl className={teamCss.facts}><dt>{t('team.detail.executionPlane')}</dt><dd>{role.executionScope}</dd><dt>{t('team.detail.knowledgeRead')}</dt><dd>{t('team.detail.knowledgeReadDesc')}</dd><dt>{t('team.detail.toolsConnections')}</dt><dd>{t('team.detail.toolsConnectionsDesc')}</dd><dt>{t('team.detail.formalApproval')}</dt><dd>{t('team.detail.formalApprovalDesc')}</dd></dl>
                <div className={css.buttons}><button type="button" onClick={resources}>{t('team.detail.reviewKnowledge')}</button><button type="button" onClick={nativeSettings}>{t('team.detail.reviewConnections')}</button></div>
                <section className={teamCss.notice}><h3>{t('team.detail.employeeAuthorizationTitle')}</h3><p>{t('team.detail.employeeAuthorizationDesc')}</p></section>
              </>}
              {/* 第六组：身份栏原先常驻的生命周期与状态三问搬到这里（终审 T2），一条不删，只是默认折叠。 */}
              {section === 'runtime' && <dl className={teamCss.facts} aria-label={t('team.detail.identity.status')}>
                <dt>{t('team.detail.lifecycle')}</dt><dd>{lifecycle.summary}</dd>
                <dt>{t('team.detail.actualState')}</dt><dd>{statusLabel(role.state)} · {lifecycle.label}</dd>
                <dt>{t('team.detail.blocker')}</dt><dd>{blocker}</dd>
                <dt>{t('team.detail.next')}</dt><dd>{lifecyclePending ? t('team.detail.pendingStateReview') : lifecycle.next}</dd>
              </dl>}
            </div>
          </details> })}
          {savedGroups?<RoleGroupMembership api={savedGroups} roleId={role.id} open={openGroup}/>:<><section className={css.block}><header><h3>{t('team.work.groups', { count: groups.length })}</h3><p className={teamCss.sectionPath}>{t('team.work.groupsDesc')}</p></header>{groups.map(group => <button type="button" key={group.id} onClick={() => openGroup(group.id)}>{group.name}{retired ? t('team.work.retainedIdentity') : ''}</button>)}{!groups.length && <p className={css.muted}>{t('team.work.noGroups')}</p>}</section></>}
          {plans(role.id)}
        </div> : timeline.length ? <ol className={teamCss.timeline}>{timeline.map(item => {
          const tone = item.kind === 'needsYou' ? 'warn' : item.kind === 'artifact' ? 'good' : undefined;
          const kindLabel = t(item.kind === 'needsYou' ? 'team.profile.timeline.kind.needsYou' : item.kind === 'artifact' ? 'team.profile.timeline.kind.artifact' : 'team.profile.timeline.kind.recent');
          return <li key={item.id}><span className={teamCss.timelineDot} aria-hidden="true"/><button type="button" onClick={() => openTask(item.task.id)}><span className={teamCss.timelineHead}><span className={teamCss.timelineBadge} data-tone={tone}>{kindLabel}</span><time>{stamp(item.task.updatedAt)}</time></span><strong>{item.task.title}</strong><small>{item.task.result || t(taskStates[item.task.state])}</small></button></li>;
        })}</ol> : <div className={css.empty}><Bot size={30}/><h2>{t('team.profile.timeline.empty.title')}</h2><p>{t('team.profile.timeline.empty.description')}</p>{!retired&&<button type="button" disabled={role.state !== 'active'} onClick={() => setForm('assign')}>{t('team.profile.action.assign')}</button>}</div>}
      </section>
    </div>}
    {form === 'edit' && <RoleForm work={work} resourceApi={resourceApi} runtimeConfigs={runtimeConfigs} persistent={role.storage === 'persistent'} role={editingRole ?? role} close={() => setForm(undefined)} save={async (value) => { if (role.storage === 'persistent' && persistence)
        await persistence.edit(editingRole ?? role, value);
    else
        change({ type: 'edit', roleId: role.id, expectedVersion: role.version, ...value, now: new Date().toISOString() }); setForm(undefined); }}/>}
    {form === 'retire' && <RetirementForm plans={state.continuous.plans.filter(plan => plan.fields.roleId === role.id && !plan.archived).map(plan => ({ id: plan.id, title: plan.fields.title }))} role={role} unfinished={unfinished.map(task => ({ id: task.id, title: task.title, needs:list(taskNeeds(task).map(need => t(attentionKinds[need]))) }))} close={() => setForm(undefined)} save={reason => { change({ type: 'lifecycle', roleId: role.id, expectedVersion: role.version, action: 'retire', reason, now: new Date().toISOString() }); setForm(undefined); }}/>}
    {form === 'assign' && <AssignmentForm role={role} close={() => setForm(undefined)} save={async (value) => { let id: string; if (role.storage === 'persistent') {
        if (!persistence)
            throw Error(t('team.assignment.unavailable'));
        id = await persistence.assign(role, value);
    }
    else {
        id = crypto.randomUUID();
        change({ type: 'assign', roleId: role.id, id, ...value, now: new Date().toISOString() });
    } setForm(undefined); openTask(id); }}/>}
    {form === 'memory' && <MemoryForm persistent={role.storage === 'persistent'} twin={twin} scopes={role.scopes} close={() => setForm(undefined)} save={async (value) => { if (role.storage === 'persistent' && memoryApi) {
        try {
            const saved = await memoryApi.create({ roleId: role.id, expectedRoleVersion: role.version, title: value.title, markdown: value.text, source: { kind: 'self-feedback', id: crypto.randomUUID(), version: 1 }, visibility: twin ? { kind: 'private', scopeIds: [] } : { kind: 'role', scopeIds: [value.scope] } });
            setSavedMemories(rows => [...rows, saved]);
            setMemoryError(undefined);
            setForm(undefined);
        }
        catch (error) {
            setMemoryError(localizeWorkError(locale, error));
        }
        return;
    } change({ type: 'memory-add', roleId: role.id, id: crypto.randomUUID(), title: value.title, text: value.text, source: t('team.memory.selfFeedback'), now: new Date().toISOString() }); setForm(undefined); }}/>}
  </article>;
}
function Dialog({ title, close, children, submit, wide=false }: {
    title: string;
    wide?: boolean;
    close: () => void;
    children: ReactNode;
    submit: () => void | Promise<void>;
}) {
    const { locale, t } = useI18n();
    const ref = useRef<HTMLDialogElement>(null), [error, setError] = useState<string>(), [busy, setBusy] = useState(false);
    useEffect(() => openDialog(ref.current, ref.current?.querySelector<HTMLElement>('input, textarea, select')), []);
    return <dialog ref={ref} className={clsx(css.dialog, css.alignedDialog,wide&&teamCss.hireDialog)} aria-label={title} onCancel={event => { if (busy)
        event.preventDefault();
    else
        close(); }}><form className={css.form} onSubmit={event => { event.preventDefault(); if (busy)
        return; setBusy(true); setError(undefined); void Promise.resolve().then(submit).catch(error => setError(localizeWorkError(locale, error))).finally(() => setBusy(false)); }}><header><h2>{title}</h2><button type="button" aria-label={t('team.form.close')} disabled={busy} onClick={close}><X size={18}/></button></header>{error && <p role="alert">{error}</p>}<fieldset disabled={busy} className={teamCss.formBody}>{children}</fieldset></form></dialog>;
}
const emptyResponsibility = () => ({ triggers: [], autonomousActions: [], confirmationPoints: [], escalationRules: [], deliveryChecks: [] });
const responsibilityText = (items: string[]) => items.join('\n');
const responsibilityItems = (value: string) => [...new Set(value.split('\n').map(item => item.trim()).filter(Boolean))];
// 招一位新同事时的 6 个候选形象：照原型 avatarSeed 的排布，shift 由「换一组颜色」驱动；不入库，只在本屏与工牌预览里用。
const hireLooks=(shift:number)=>Array.from({length:6},(_,index)=>({tone:(index+shift)%STAFF_AVATAR_TONES,shape:(index*2+shift)%STAFF_AVATAR_SHAPES}))
// 新建时 role===undefined，步骤外壳换成三问一工牌（规格 §4.6）；编辑既有岗位保持今天的五步一字不改（Q2）。
const HIRE_GATE_STEPS=[0,1,2,4] as const
export function RoleForm({work,resourceApi,runtimeConfigs,initial,persistent=false,role,close,save}:{work:BindingClient;resourceApi:ResourceApi;runtimeConfigs?:RoleRuntimeConfigApi|undefined;initial?:RoleFields|undefined;persistent?:boolean;role?:PreviewRole|undefined;close:()=>void;save:(fields:RoleFields)=>void|Promise<void>}){
  const {t,list}=useI18n()
  const collaborationScopes=useBusinessScopes()
  const mode:'hire'|'edit'=role?'edit':'hire'
  const [step,setStep]=useState(0)
  const [preset,setPreset]=useState<HirePreset>(HIRE_PRESETS[0])
  const [limits,setLimits]=useState<Readonly<Record<HireAction,HireLevel>>>(HIRE_DEFAULT_LIMITS)
  const [look,setLook]=useState(0)
  const [lookShift,setLookShift]=useState(0)
  const chosenLook=hireLooks(lookShift)[look]??{tone:0,shape:0}
  // 切预设/开关/业务范围前如果发现④屏被手动改过（复审 MEDIUM），先记下待确认的目标，等用户点「仍然覆盖」才真的应用。
  const [pendingHireChange,setPendingHireChange]=useState<{kind:'preset';id:HirePreset}|{kind:'limit';action:HireAction;level:HireLevel}|{kind:'scope';scopes:CollaborationScope[]}>()
  const scopeLabelsFor=(scopes:readonly CollaborationScope[])=>scopes.map(scope=>collaborationScopes[scope]??scope)
  // list() 做语言相关的列表拼接（顿号只是中文的分隔符，其它语言要走 Intl.ListFormat）——复审 LOW：
  // 纯函数 hirePresetFields 内部没有 locale 上下文，所以在这里、调用处拼好整句摘要再传进去。
  const scopeSummary=(scopes:readonly CollaborationScope[])=>list(scopeLabelsFor(scopes))
  // 纯函数逐句返回执行边界，拼成一行是界面层的事：分隔符按语言取词条，不写死中文分号。
  const listJoin=t('team.hire.listJoin')
  const joinScope=(fields:HireAppliedFields):RoleFields=>({...fields,executionScope:fields.executionScope.join(listJoin)})
  const [value,setValue]=useState<RoleFields>(role?{name:role.name,kind:role.kind,scopes:role.scopes,duty:role.duty,dataScope:role.dataScope,executionScope:role.executionScope,skills:role.skills,knowledge:role.knowledge,responsibility:role.responsibility??emptyResponsibility(),...(role.runtimeConfig===undefined?{}:{runtimeConfig:role.runtimeConfig})}:initial??joinScope(hireMergePreset({name:'',kind:'employee',scopes:['general'],duty:'',dataScope:t('team.form.defaultDataScope'),executionScope:t('team.form.defaultExecutionScope'),skills:[],knowledge:[],responsibility:emptyResponsibility()},hirePresetFields(HIRE_PRESETS[0],t,scopeSummary(['general'])),HIRE_DEFAULT_LIMITS,t)))
  // 预设基线按「当前选中的预设 + 当前勾选的业务范围」现算，业务范围一变，下次切预设/开关时 dataScope 就会带上新范围（复审 HIGH-1）。
  const presetBase=hirePresetFields(preset,t,scopeSummary(value.scopes))
  const [runtimeState,setRuntimeState]=useState<RuntimeConfigLoadState>({status:'idle'})
  const [runtimeChanged,setRuntimeChanged]=useState(false)
  const [modelState,setModelState]=useState<RoleModelLoadState>({status:'idle'})
  const [modelOpen,setModelOpen]=useState(mode==='edit'||!!value.runtimeConfig?.model||!!value.runtimeConfig?.fallbackModel)
  const [modelRetry,setModelRetry]=useState(0)
  const runtimeDirectory=runtimeState.directory
  const patch=(changes:Partial<RoleFields>)=>setValue(current=>({...current,...changes}))
  const patchRuntime=(agentPresetId:string)=>{setRuntimeChanged(true);setValue(current=>{const next={...current},runtime={...current.runtimeConfig};if(agentPresetId)runtime.agentPresetId=agentPresetId;else delete runtime.agentPresetId;if(Object.keys(runtime).length)next.runtimeConfig=runtime;else delete next.runtimeConfig;return next})}
  // 只有切预设才重置 duty/skills/knowledge/dataScope（复审 HIGH-2：切三段开关不能碰这几个字段，否则会把②屏手改的技能静默清空）。
  const applyPreset=(id:HirePreset)=>{const base=hirePresetFields(id,t,scopeSummary(value.scopes));setPreset(id);setValue(current=>joinScope(hireMergePreset(current,base,limits,t)))}
  const applyLimit=(action:HireAction,level:HireLevel)=>{const next={...limits,[action]:level};setLimits(next);setValue(current=>joinScope(hireMergeLimit(current,presetBase,next,t)))}
  // 勾选业务范围也要现算 dataScope（复审 HIGH-1 补完）：只更新 scopes 与 dataScope，不碰 skills/duty/knowledge/responsibility。
  const applyScope=(scopes:CollaborationScope[])=>{const dataScope=hirePresetFields(preset,t,scopeSummary(scopes)).dataScope;setValue(current=>({...current,scopes,dataScope}))}
  const pickPreset=(id:HirePreset)=>{if(value.duty!==presetBase.duty||value.skills.length>0||value.knowledge.length>0||hireDrifted(value,presetBase,limits,t,listJoin))setPendingHireChange({kind:'preset',id});else applyPreset(id)}
  const toggleLimit=(action:HireAction,level:HireLevel)=>{if(hireDrifted(value,presetBase,limits,t,listJoin))setPendingHireChange({kind:'limit',action,level});else applyLimit(action,level)}
  const toggleScope=(scopeId:CollaborationScope,checked:boolean)=>{const scopes=checked?[...value.scopes,scopeId]:value.scopes.filter(scope=>scope!==scopeId);if(hireDrifted(value,presetBase,limits,t,listJoin))setPendingHireChange({kind:'scope',scopes});else applyScope(scopes)}
  const confirmPendingHireChange=()=>{if(!pendingHireChange)return;if(pendingHireChange.kind==='preset')applyPreset(pendingHireChange.id);else if(pendingHireChange.kind==='limit')applyLimit(pendingHireChange.action,pendingHireChange.level);else applyScope(pendingHireChange.scopes);setPendingHireChange(undefined)}
  // 入职④屏不读取预设目录，agentPresetId 仍按裁定 7 继承默认；模型只在主动展开时读取。
  useEffect(()=>{let active=true;if(step!==3||mode!=='edit'||!runtimeConfigs)return;setRuntimeState(runtimeConfigLoading());void runtimeConfigs.list().then(directory=>{if(active)setRuntimeState(runtimeConfigReady(directory))}).catch(error=>{if(active)setRuntimeState(runtimeConfigFailed(error))});return()=>{active=false}},[step,mode,runtimeConfigs])
  useEffect(()=>{let active=true;if(step!==3||!modelOpen||!runtimeConfigs?.models)return;setModelState({status:'loading'});void runtimeConfigs.models().then(directory=>{if(active)setModelState({status:'ready',directory})}).catch(()=>{if(active)setModelState({status:'error'})});return()=>{active=false}},[step,mode,modelOpen,modelRetry,runtimeConfigs])
  const hireSteps=[['team.hire.step.identity','team.hire.step.identityDesc'],['team.hire.step.job','team.hire.step.jobDesc'],['team.hire.step.limit','team.hire.step.limitDesc'],['team.hire.step.badge','team.hire.step.badgeDesc']] as const
  const editSteps=[['team.form.step.identity','team.form.step.identityDesc'],['team.form.step.scope','team.form.step.scopeDesc'],['team.form.step.capabilities','team.form.step.capabilitiesDesc'],['team.form.step.runtime','team.form.step.runtimeDesc'],['team.form.step.review','team.form.step.reviewDesc']] as const
  const steps=mode==='hire'?hireSteps:editSteps
  const identityReady=!!value.name.trim()&&!!value.duty.trim()
  const scopeReady=value.scopes.length>0&&!!value.dataScope.trim()&&!!value.executionScope.trim()
  const initialAgentPresetId=(role?role.runtimeConfig:initial?.runtimeConfig)?.agentPresetId
  const presetReady=runtimeConfigCanSave({initialAgentPresetId,agentPresetId:value.runtimeConfig?.agentPresetId,changed:runtimeChanged,directory:runtimeDirectory})
  const runtimeReady=presetReady&&roleModelsCanSave(role?role.runtimeConfig:initial?.runtimeConfig,value.runtimeConfig,modelState.directory)
  // 三问只有 4 屏，借用旧五步的门禁判据：①→旧 0、②→旧 1、③无门禁（旧 2）、④→旧 4（同时要 identityReady/scopeReady/runtimeReady）。
  const gateStep=(index:number):number=>mode==='hire'?HIRE_GATE_STEPS[index]??index:index
  const {canContinue,canOpenStep:canOpenStepAt}=roleFormProgress({step:gateStep(step),identityReady,scopeReady,runtimeReady})
  const canOpenStep=(index:number)=>canOpenStepAt(gateStep(index))
  const mustPause=persistent&&role?.state==='active'
  const submit=()=>{if(!canContinue||mustPause&&step===steps.length-1)return;return step<steps.length-1?setStep(step+1):save({...value,skills:value.skills,knowledge:value.knowledge})}
  return <Dialog title={t(role?'team.form.editRole':'team.form.newRole')} wide={!role} close={close} submit={submit}>
    {initial&&!role&&<p>{t('team.form.retryPending')}</p>}
    {mustPause&&<p className={teamCss.inlineNotice} role="status">{t('roleModels.pauseBeforeEdit')}</p>}
    <nav className={clsx(teamCss.roleSteps,mode==='hire'&&teamCss.roleStepsFour)} aria-label={t('team.form.steps')}>
      {steps.map(([title,description],index)=><button key={title} type="button" disabled={index!==step&&!canOpenStep(index)} aria-current={step===index?'step':undefined} onClick={()=>canOpenStep(index)&&setStep(index)}><span>{index<step?<Check size={12}/>:index+1}</span><span><strong>{t(title)}</strong><small>{t(description)}</small></span></button>)}
    </nav>
    <p className={teamCss.stepNote}>{t(persistent?'team.form.savedNote':'team.form.demoNote')} {t('team.form.noGrant')}</p>
    {mode==='hire'&&pendingHireChange&&<div className={teamCss.inlineNotice} role="alert">
      <p>{t('team.hire.drift.message')}</p>
      <div className={css.buttons}><button type="button" onClick={confirmPendingHireChange}>{t('team.hire.drift.confirm')}</button><button type="button" onClick={()=>setPendingHireChange(undefined)}>{t('team.hire.drift.cancel')}</button></div>
    </div>}
    {mode==='edit'&&step===0&&<section className={teamCss.stepPanel} aria-label={t('team.form.step.identity')}>
      <label>{t('team.form.name')}<input required maxLength={80} value={value.name} onChange={event=>patch({name:event.target.value})} placeholder={t('team.form.namePlaceholder')}/></label>
      <label>{t('team.form.kind')}<select disabled={!!role} value={value.kind} onChange={event=>patch({kind:event.target.value as RoleFields['kind']})}><option value="employee">{t('team.form.employee')}</option><option value="twin">{t('team.form.twin')}</option></select></label>
      <label>{t('team.form.mission')}<textarea required rows={3} maxLength={4000} value={value.duty} onChange={event=>patch({duty:event.target.value})} placeholder={t('team.form.missionPlaceholder')}/></label>
      <p className={teamCss.stepHint}>{t('team.form.responsibilityHint')}</p>
      <div className={teamCss.responsibilityEditor}>{responsibilityGroups(value.responsibility??emptyResponsibility()).map(group=><label key={group.key}>{t(group.labelKey)}<textarea rows={2} maxLength={4000} value={responsibilityText(group.items)} onChange={event=>patch({responsibility:{...(value.responsibility??emptyResponsibility()),[group.key]:responsibilityItems(event.target.value)}})}/><small>{t('team.form.onePerLine')}</small></label>)}</div>
      {value.kind==='twin'&&<p className={teamCss.inlineNotice}>{t('team.form.twinNote')}</p>}
    </section>}
    {mode==='hire'&&step===0&&<section className={teamCss.stepPanel} aria-label={t('team.hire.step.identity')}>
      <h1>{t('team.hire.identity.title')}</h1>
      <p>{t('team.hire.identity.subtitle')}</p>
      <label>{t('team.hire.identity.nameLabel')}<input autoFocus required maxLength={80} value={value.name} onChange={event=>patch({name:event.target.value})} placeholder={t('team.hire.identity.namePlaceholder')}/></label>
      <p className={teamCss.stepHint}>{t('team.hire.identity.lookLabel')}<button type="button" onClick={()=>setLookShift(shift=>shift+1)}><RefreshCw size={12}/>{t('team.hire.identity.shuffle')}</button></p>
      <div className={teamCss.lookRow} role="radiogroup" aria-label={t('team.hire.identity.lookGroupAria')}>
        {hireLooks(lookShift).map((item,index)=><button key={index} type="button" role="radio" aria-checked={look===index} aria-label={t('team.hire.identity.lookOptionAria',{index:index+1})} className={clsx(teamCss.lookOption,look===index&&teamCss.lookPicked)} onClick={()=>setLook(index)}><StaffAvatar initial={value.name.trim()?value.name.trim().slice(0,1):'+'} seed={`hire-look-${index}`} tone={item.tone} shape={item.shape} size="lg"/></button>)}
      </div>
    </section>}
    {mode==='edit'&&step===1&&<section className={teamCss.stepPanel} aria-label={t('team.form.step.scope')}>
      <fieldset className={teamCss.scopes}><legend>{t('team.detail.businessScope')}</legend>{roleScopeOptions(collaborationScopes,value.scopes).map(([id,label])=><label key={id}><input type="checkbox" checked={value.scopes.includes(id as CollaborationScope)} onChange={event=>patch({scopes:event.target.checked?[...value.scopes,id as CollaborationScope]:value.scopes.filter(scope=>scope!==id)})}/>{label}</label>)}</fieldset>
      <label>{t('team.form.dataScope')}<textarea required rows={3} maxLength={4000} value={value.dataScope} onChange={event=>patch({dataScope:event.target.value})}/></label>
      <label>{t('team.form.executionScope')}<textarea required rows={3} maxLength={4000} value={value.executionScope} onChange={event=>patch({executionScope:event.target.value})}/></label>
      <p className={teamCss.inlineNotice}>{t('team.form.scopeNote')}</p>
    </section>}
    {mode==='hire'&&step===1&&<section className={teamCss.stepPanel} aria-label={t('team.hire.step.job')}>
      <h1>{t('team.hire.job.title')}</h1>
      <p>{t('team.hire.job.subtitle')}</p>
      <div className={teamCss.jobRow} role="radiogroup" aria-label={t('team.hire.job.pickAria')}>
        {HIRE_PRESETS.map(id=>{const fields=hirePresetFields(id,t);return <button key={id} type="button" role="radio" aria-checked={preset===id} className={clsx(teamCss.jobCard,preset===id&&teamCss.jobPicked)} onClick={()=>pickPreset(id)}>
          <strong>{hirePresetLabel(id,t)}</strong><span>{fields.duty}</span>
          {preset===id&&<span className={teamCss.jobCheck}><Check size={13}/></span>}
        </button>})}
      </div>
      <label>{t('team.form.mission')}<textarea required rows={3} maxLength={4000} value={value.duty} onChange={event=>patch({duty:event.target.value})} placeholder={t('team.form.missionPlaceholder')}/></label>
      <details><summary>{t('team.form.step.capabilities')}</summary>
        <div className={teamCss.capabilityChoice}><div><h3>{t('team.detail.defaultSkill')}</h3><p>{t('team.form.skillNote')}</p></div><HomeSkillPicker work={work} purpose="role" selected={value.skills.map(name=>({name,source:'',provider:''}))} change={skills=>patch({skills:skills.map(skill=>skill.name)})}/></div>
        <div className={teamCss.capabilityChoice}><div><h3>{t('team.form.knowledge')}</h3><p>{t('team.form.knowledgeNote')}</p></div><RoleKnowledge api={resourceApi} ids={value.knowledge} scopes={value.scopes} change={knowledge=>patch({knowledge})}/></div>
      </details>
      <fieldset className={teamCss.scopes}><legend>{t('team.detail.businessScope')}</legend>{roleScopeOptions(collaborationScopes,value.scopes).map(([id,label])=><label key={id}><input type="checkbox" checked={value.scopes.includes(id as CollaborationScope)} onChange={event=>toggleScope(id as CollaborationScope,event.target.checked)}/>{label}</label>)}</fieldset>
    </section>}
    {step===2&&<section className={teamCss.stepPanel} aria-label={t(mode==='hire'?'team.hire.step.limit':'team.form.step.capabilities')}>
      {mode==='edit'?<>
        <div className={teamCss.capabilityChoice}><div><h3>{t('team.detail.defaultSkill')}</h3><p>{t('team.form.skillNote')}</p></div><HomeSkillPicker work={work} purpose="role" selected={value.skills.map(name=>({name,source:'',provider:''}))} change={skills=>patch({skills:skills.map(skill=>skill.name)})}/></div>
        <div className={teamCss.capabilityChoice}><div><h3>{t('team.form.knowledge')}</h3><p>{t('team.form.knowledgeNote')}</p></div><RoleKnowledge api={resourceApi} ids={value.knowledge} scopes={value.scopes} change={knowledge=>patch({knowledge})}/></div><p className={teamCss.inlineNotice}>{roleSkillNotice(t)}</p>
      </>:<>
        <h1>{t('team.hire.limit.title')}</h1>
        <p>{t('team.hire.limit.subtitle')}</p>
        <ul className={teamCss.limitList}>{HIRE_ACTIONS.map(action=><li key={action}>
          <span>{hireActionLabel(action,t)}</span>
          <span className={teamCss.segment} role="radiogroup" aria-label={hireActionLabel(action,t)}>{HIRE_LEVELS.map(level=><button key={level} type="button" role="radio" aria-checked={limits[action]===level} className={clsx(limits[action]===level&&teamCss.segmentOn)} onClick={()=>toggleLimit(action,level)}>{hireLevelLabel(level,t)}</button>)}</span>
        </li>)}</ul>
      </>}
    </section>}
    {step===3&&<section className={teamCss.stepPanel} aria-label={t(mode==='hire'?'team.hire.step.badge':'team.form.step.runtime')}>
      {mode==='hire'?<>
        <h1>{t('team.hire.badge.title')}</h1>
        <p>{t('team.hire.badge.subtitle')}</p>
        <div className={teamCss.previewWrap}>
          <div className={teamCss.badgeCard}>
            <span className={teamCss.badgeHole}/>
            <StaffAvatar initial={value.name.trim()?value.name.trim().slice(0,1):'+'} seed="hire-badge" tone={chosenLook.tone} shape={chosenLook.shape} size="xl"/>
            <strong className={teamCss.badgeName}>{value.name.trim()||t('team.form.unnamed')}</strong>
            <span className={teamCss.badgeJob}>{value.duty}</span>
            <StatusLabel label={roleStatusLabel('active',t)} mark="enabled" tone="good"/>
            <span className={teamCss.chipRow}>{value.skills.slice(0,3).map(skill=><span key={skill} className={teamCss.chip}>{skill}</span>)}</span>
            <span className={teamCss.badgeFoot}><Users size={13}/>{t('team.profile.owner')}</span>
          </div>
          <dl className={teamCss.previewFacts}>
            <dt>{t('team.hire.fact.job')}</dt><dd>{hirePresetLabel(preset,t)}</dd>
            <dt>{t('team.hire.fact.self')}</dt><dd>{list(HIRE_ACTIONS.filter(action=>limits[action]==='self').map(action=>hireActionLabel(action,t)))||t('team.hire.fact.none')}</dd>
            <dt>{t('team.hire.fact.ask')}</dt><dd>{list(HIRE_ACTIONS.filter(action=>limits[action]==='ask').map(action=>hireActionLabel(action,t)))||t('team.hire.fact.none')}</dd>
            <dt>{t('team.hire.fact.never')}</dt><dd>{list(HIRE_ACTIONS.filter(action=>limits[action]==='never').map(action=>hireActionLabel(action,t)))||t('team.hire.fact.none')}</dd>
          </dl>
        </div>
        <p className={teamCss.stepHint}>{t('team.hire.badge.knowledgeNote')}</p>
      </>:<header className={teamCss.runtimeHeader}><div><h3>{t('team.form.step.runtime')}</h3><p>{t('team.form.runtimeNote')}</p></div></header>}
      {/* 入职④屏删「运行配置」select（裁定 7）：runtimeConfig 省略走既有默认，这一整块只在编辑既有岗位时渲染。 */}
      {mode==='edit'&&<>
      {runtimeState.status==='loading'&&<p className={css.muted}>{t('team.form.runtimeLoading')}</p>}{runtimeState.error&&<p className={teamCss.inlineNotice} role="alert">{runtimeState.error}</p>}
      {!runtimeDirectory&&value.runtimeConfig?.agentPresetId&&<div className={teamCss.runtimeSummary}><strong>{t('team.form.runtimePinned',{id:value.runtimeConfig.agentPresetId})}</strong><span>{t('team.form.runtimeMissing')}</span><button type="button" onClick={()=>patchRuntime('')}>{t('team.form.runtimeInherit')}</button></div>}
      {runtimeDirectory&&<><label>{t('team.form.runtimeSelect')}<select value={value.runtimeConfig?.agentPresetId??''} onChange={event=>patchRuntime(event.target.value)}>{runtimeConfigOptions(value.runtimeConfig?.agentPresetId,runtimeDirectory).map(item=><option key={item.id} value={item.id} disabled={item.disabled}>{item.label}</option>)}</select></label>{runtimeDirectory.items.length===0&&<p className={teamCss.inlineNotice}>{t('team.form.runtimeEmpty')}</p>}<div className={teamCss.runtimeSummary}><strong>{runtimeConfigSummary(value.runtimeConfig?.agentPresetId,runtimeDirectory).label}</strong><span>{runtimeConfigSummary(value.runtimeConfig?.agentPresetId,runtimeDirectory).detail}</span>{value.runtimeConfig?.agentPresetId&&<small>{t('team.form.technicalId',{id:value.runtimeConfig.agentPresetId})}</small>}</div>{!presetReady&&<p className={teamCss.inlineNotice} role="alert">{t('team.form.runtimeRequired')}</p>}</>}
      </>}
      {runtimeConfigs?.models&&<details className={teamCss.sectionNote} open={modelOpen} onToggle={event=>setModelOpen(event.currentTarget.open)}><summary>{t('roleModels.title')}</summary><RoleModelFields runtime={value.runtimeConfig} state={modelState} change={(field,model)=>setValue(current=>{const next={...current},runtime=patchRoleModel(current.runtimeConfig,field,model);if(runtime)next.runtimeConfig=runtime;else delete next.runtimeConfig;return next})} retry={()=>setModelRetry(count=>count+1)}/></details>}
      {mode==='hire'&&<details className={teamCss.sectionNote}><summary>{t('team.hire.expand')}</summary>
        <div className={teamCss.responsibilityEditor}>{responsibilityGroups(value.responsibility??emptyResponsibility()).map(group=><label key={group.key}>{t(group.labelKey)}<textarea rows={2} maxLength={4000} value={responsibilityText(group.items)} onChange={event=>patch({responsibility:{...(value.responsibility??emptyResponsibility()),[group.key]:responsibilityItems(event.target.value)}})}/><small>{t('team.form.onePerLine')}</small></label>)}</div>
        <label>{t('team.form.dataScope')}<textarea required rows={3} maxLength={4000} value={value.dataScope} onChange={event=>patch({dataScope:event.target.value})}/></label>
        <label>{t('team.form.executionScope')}<textarea required rows={3} maxLength={4000} value={value.executionScope} onChange={event=>patch({executionScope:event.target.value})}/></label>
      </details>}
    </section>}
    {mode==='edit'&&step===4&&<section className={teamCss.reviewPanel} aria-label={t('team.form.reviewAria')}><header><span className={teamCss.avatar}>{value.name.slice(0,1)||<Bot size={15}/>}</span><div><h3>{value.name||t('team.form.unnamed')}</h3><p>{t(value.kind==='twin'?'team.form.twinShort':'team.form.employee')} · {list(value.scopes.map(scope=>collaborationScopes[scope]??scope))}</p></div></header><dl><dt>{t('team.form.mission')}</dt><dd>{value.duty}</dd><dt>{t('team.form.responsibilityGroups')}</dt><dd>{value.responsibility?responsibilityGroups(value.responsibility).map(group=>`${t(group.labelKey)} ${t(group.items.length?'team.form.set':'team.form.notSet')}`).join(' · '):t('team.form.unstructured')}</dd><dt>{t('team.form.step.runtime')}</dt><dd>{runtimeConfigSummary(value.runtimeConfig?.agentPresetId,runtimeDirectory).label}</dd><dt>{t('roleModels.primary')}</dt><dd>{value.runtimeConfig?.model?roleModelLabel(value.runtimeConfig.model,modelState.directory):t('roleModels.inherit')}</dd><dt>{t('roleModels.fallback')}</dt><dd>{value.runtimeConfig?.fallbackModel?roleModelLabel(value.runtimeConfig.fallbackModel,modelState.directory):t('roleModels.noFallback')}</dd><dt>{t('team.form.dataBoundary')}</dt><dd>{value.dataScope}</dd><dt>{t('team.form.executionBoundary')}</dt><dd>{value.executionScope}</dd><dt>{t('team.form.materials')}</dt><dd>{value.knowledge.length?t('team.form.materialCount',{count:value.knowledge.length}):t('team.form.noneSelected')}</dd><dt>{t('market.industry.resource.skill')}</dt><dd>{value.skills.length?list(value.skills):t('team.form.notDeclared')}</dd></dl><div className={teamCss.nextActions}><strong>{t('team.form.afterSave')}</strong>{[1,2,3,4].map(index=><span key={index}>{t(`team.form.afterSave.${index}` as 'team.form.afterSave.1')}</span>)}</div></section>}
    <footer className={clsx(css.buttons,teamCss.stepFooter)}><button type="button" onClick={step===0?close:()=>setStep(step-1)}>{step===0?t(mode==='hire'?'team.hire.cancel':'team.form.cancel'):<><ChevronLeft size={14}/>{t('team.form.previous')}</>}</button><span>{t('team.form.progress',{current:step+1,total:steps.length})}</span><button type="submit" disabled={!canContinue||mustPause&&step===steps.length-1}>{step===steps.length-1?t(mode==='hire'?'team.hire.submit':persistent?'team.form.saveRole':'team.form.saveDemoRole'):<>{t('team.form.next')}<ChevronRight size={14}/></>}</button></footer>
  </Dialog>
}

// 原型 `岗位生命周期.jsx:6-20` 在计划块之后另有一条 callout：「{N} 项关联操作尚需跟进」，N 取该岗位任务
// 关联的安全动作数（`operations.filter(...['approved','executing','unknown','partial'].includes(status))`）。
// RoleDetail 这一层没有拿到 SecurityActionApi 或跨任务的安全动作聚合（安全动作只在 SecurityActions.tsx 按单个
// taskId 懒加载），算不出真实 N；按裁定「算不出则 N=0 不显示」，这里不渲染该 callout，也不引入取不到值的假计数。
function RetirementForm({role,unfinished,plans,close,save}:{plans:{id:string;title:string}[];role:PreviewRole;unfinished:{id:string;title:string;needs:string}[];close:()=>void;save:(reason:string)=>void}){
  const {t}=useI18n();const [reason,setReason]=useState('')
  return <Dialog title={t('team.retirement.title',{name:role.name})} close={close} submit={()=>save(reason)}><p>{t('team.retirement.path')}</p><div className={teamCss.notice}><strong>{t('team.retirement.work',{count:unfinished.length})}</strong>{unfinished.length>0&&<ul>{unfinished.map(task=><li key={task.id}>{task.title}{task.needs?t('team.retirement.originalNeed',{need:task.needs}):''}</li>)}</ul>}<p>{t('team.retirement.workNote')}</p></div><div className={teamCss.notice}><strong>{t('team.retirement.plans',{count:plans.length})}</strong>{plans.length>0&&<ul>{plans.map(plan=><li key={plan.id}>{plan.title}</li>)}</ul>}<p>{t('team.retirement.plansNote')}</p></div><label>{t('team.retirement.reason')}<textarea required rows={3} maxLength={4000} value={reason} onChange={event=>setReason(event.target.value)}/></label><p>{t('team.retirement.finalNote')}</p><footer className={css.buttons}><button type="button" onClick={close}>{t('team.retirement.back')}</button><button type="submit" disabled={!reason.trim()}>{t('team.retirement.save')}</button></footer></Dialog>
}

function AssignmentForm({role,close,save}:{role:PreviewRole;close:()=>void;save:(value:{title:string;goal:string;scope:CollaborationScope})=>void|Promise<void>}){
  const {t}=useI18n();const collaborationScopes=useBusinessScopes();const [title,setTitle]=useState(''),[goal,setGoal]=useState(''),[scope,setScope]=useState(role.scopes[0]!)
  return <Dialog title={t('team.assignment.title',{name:role.name})} close={close} submit={()=>save({title,goal,scope})}><p>{t('team.assignment.path')}</p><p>{roleWorkPath(role.storage==='persistent',t)}</p><label>{t('team.assignment.name')}<input required maxLength={120} value={title} onChange={event=>setTitle(event.target.value)}/></label><label>{t('team.assignment.goal')}<textarea required rows={4} maxLength={8000} value={goal} onChange={event=>setGoal(event.target.value)}/></label><label>{t('team.assignment.scope')}<select value={scope} onChange={event=>setScope(event.target.value as CollaborationScope)}>{role.scopes.map(id=><option key={id} value={id}>{collaborationScopes[id]??id}</option>)}</select></label><footer className={css.buttons}><button type="button" onClick={close}>{t('team.form.cancel')}</button><button type="submit" disabled={!title.trim()||!goal.trim()}>{t(role.storage==='persistent'?'team.assignment.save':'team.assignment.demo')}</button></footer></Dialog>
}

function MemoryForm({persistent,twin,scopes,close,save}:{persistent:boolean;twin:boolean;scopes:CollaborationScope[];close:()=>void;save:(value:{title:string;text:string;scope:CollaborationScope})=>void|Promise<void>}){
  const {t}=useI18n();const collaborationScopes=useBusinessScopes(),[title,setTitle]=useState(''),[text,setText]=useState(''),[scope,setScope]=useState(scopes[0]!)
  return <Dialog title={t('team.memory.record')} close={close} submit={()=>save({title,text,scope})}><p>{t('team.memory.rolePath')}</p><label>{t('team.memory.record')}<input required maxLength={120} value={title} onChange={event=>setTitle(event.target.value)}/></label><label>{t('team.form.memory.candidateBody')}<textarea required rows={6} maxLength={131072} value={text} onChange={event=>setText(event.target.value)}/></label>{!twin&&<label>{t('team.detail.businessScope')}<select value={scope} onChange={event=>setScope(event.target.value as CollaborationScope)}>{scopes.map(id=><option key={id} value={id}>{collaborationScopes[id]??id}</option>)}</select></label>}<footer className={css.buttons}><button type="button" onClick={close}>{t('team.form.cancel')}</button><button type="submit" disabled={!title.trim()||!text.trim()}>{t(persistent?'team.memory.save':'team.memory.saveDemo')}</button></footer></Dialog>
}
