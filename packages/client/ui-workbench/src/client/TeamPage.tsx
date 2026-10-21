import {TwinDraftWorkspace,type TwinDraftWorkspacePort} from './TwinDraftWorkspace.js'
import {RoleMemory as RoleMemoryEditor} from './RoleMemory.js'
import {skillDisplayTitle,type RoleSkillTitleReader,type SkillDisplayTitle} from './capability-skill-runtime.js';
import {directoryChoiceCopy} from './directory-choice-copy.js';
import type {RosterSort} from './team-roster-grouping.js';
import {EmployeeProfileEditor,type EmployeeProfileFields} from './EmployeeProfileEditor.js'
import {EmployeeDevices,EmployeeMailDrawer} from './EmployeeDevices.js'
import {DetailsMenu} from './DetailsMenu.js'
import {EmployeeGroupInvite} from './EmployeeGroupInvite.js'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {EmployeeWorkOverview,type EmployeeArtifactOpen} from './EmployeeWorkOverview.js'
import {EmployeeGrantedTools} from './EmployeeGrantedTools.js'
import {employeeCoworkers} from './employee-work-presentation.js'
import type {ArtifactApi} from './artifact-api.js'
import type {TaskRunApi} from './task-run-api.js'
import {EmployeeAvatarPicker} from './EmployeeAvatarPicker.js'
import {employeeCopy} from './employee-copy.js'
import {ContextDrawer} from './ContextDrawer.js'
import {EmployeeTemplateShare,TeamTemplateShare,useTemplateShare,type ShareBridge} from './EmployeeTemplateShare.js'
import {readSharePackage} from './share-package-plan.js'
import {CreateEntry} from './CreateEntry.js'
import {EmployeeCreateEntry} from './EmployeeCreateEntry.js'
import type {PageCreateEntity} from '@teloa/contract'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'
import {CapabilityFields,CapabilityNotice,useApplicationCapability} from './CapabilityNotice.js'
import {applicationPresentation,type WorkCapability} from './application-presentation.js'
import {RoleModelFields} from './RoleModelFields.js'
import {patchRoleModel,roleModelLabel,roleModelsCanSave,type RoleModelLoadState} from './role-models.js'
import type {GroupApi} from './group-api.js';
import {RoleGroupMembership} from './RoleGroupMembership.js';
import {RoleDelegation,roleDelegationStatus} from './RoleDelegation.js'
import type {RoleDelegationApi,RoleDelegationRead} from './role-delegation-api.js'
import type {RoleToolGrantApi} from './role-tool-grant-api.js'
import {StatusLabel} from './StatusLabel.js'
import {DisabledReason} from './DisabledReason.js'
import type {ScheduleTrigger} from '@teloa/contract';
import { HomeSkillPicker } from './HomeSkillPicker.js';
import type { BindingClient } from './binding-client.js';
import { RoleKnowledge } from './RoleKnowledge.js';
import type { ResourceApi } from './resource-api.js';
import { RoleLifecycle, RoleLifecycleRecovery, type RoleLifecycleDraft, type RoleLifecyclePort } from './RoleLifecycle.js';
import { roleLifecyclePath, roleMemoryPath, roleMemorySourceTitle, roleSkillNotice, roleStatusLabel, roleWorkPath, twinDisplayName } from './team-presentation.js';
import { planDisplayTitle } from './plan-source-presentation.js';
import type { TwinDraftInput } from './TwinDraftEditor.js';
import { TwinProfile } from './TwinProfile.js';
import { defaultPersonalDisplayName, personalAvatarInitials, personalDisplayName } from './personal-profile.js';
import { useDirectoryFocus } from './directory-focus.js';
import { openDialog } from './dialog-focus.js';
import { useDialogDismiss } from './use-dialog-dismiss.js';
import {RoleProfileDrawer} from './RoleProfileDrawer.js';
import { Children, isValidElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {createRoleFormDrafts,useRoleFormDraft} from './role-form-drafts.js'
import { Activity, Archive, ArrowLeft, ArrowUpRight, BookOpen, Bot, Brain, Check, ChevronLeft, ChevronRight, History, ListPlus, MessagesSquare, Pause, Play, Plus, RefreshCw, Route, ScrollText, Search, ShieldCheck, UserCog, Users, Wrench, X, MessageCircle, Phone, Download, Pencil, MoreHorizontal, Share2, Sparkles, Zap } from 'lucide-react';
import {ToolbarIconButton} from './ToolbarIconButton.js';
import clsx from 'clsx';
import type { CollaborationPreview, CollaborationScope } from './collaboration-preview.js';
import { useBusinessScopes } from './business-scope-context.js';
import { roleScopeOptions } from './role-scope-options.js';
import { roleName, roleStates, type PreviewRole, type RoleFields, type TeamChange } from './role-preview.js';
import { responsibilityGroups, roleFormProgress, runtimeConfigCanSave, runtimeConfigFailed, runtimeConfigLoading, runtimeConfigOptions, runtimeConfigReady, runtimeConfigSummary, type RoleRuntimeConfigApi, type RuntimeConfigLoadState } from './role-runtime-config.js';
import type { CapabilityPreview } from './capability-preview.js';
import type { RoleMemory, RoleDailyLog, RoleDailyLogPruneHint } from '@teloa/contract';
import type { RoleMemoryApi } from './role-memory-api.js';
import type { RoleDailyLogApi } from './role-daily-log-api.js';
import { RoleDailyLogPanel } from './RoleDailyLogPanel.js';
import { groupRoleMemories } from './role-memory-grouping.js';
import { attentionKinds, taskNeeds, taskStates, type TaskPreview } from './task-preview.js';
import css from './TaskPage.module.css';
import teamCss from './TeamPage.module.css';
import directoryCss from './DirectoryPane.module.css';
import rosterCss from './StaffRoster.module.css';
import light from './light-actions.module.css';
import { useI18n } from './i18n/provider.js';
import { localizeWorkError } from './i18n/errors.js';
import {exampleDirectoryMode,visibleRoleDirectory,visibleTaskDirectory,type ExampleDirectoryMode} from './example-directory-presentation.js';
import {readDirectoryFilterCategory,writeDirectoryFilterCategory,type WorkbenchDirectoryNavigation,type WorkbenchDirectoryPatch} from './workbench-navigation-state.js';
import type { BusinessScopeLabel } from './business-directory.js';
import { StaffRoster } from './StaffRoster.js';
import { rosterTotal,rosterShowsRetired } from './team-roster-grouping.js';
import { roleIsBusy, roleNowDoing, rosterCounts } from './team-roster-counts.ts';
import { readRosterFold, writeRosterFold, type RosterFoldState } from './team-roster-fold.js';
import type { PageCreateApi } from './page-create-api.js';
import { HIRE_ACTIONS, HIRE_DEFAULT_LIMITS, HIRE_LEVELS, HIRE_PRESETS, hireActionLabel, hireDrifted, hireLevelLabel, hireMergeLimit, hireMergePreset, hirePresetFields, type HireAction, type HireAppliedFields, type HireLevel } from './role-hire-presets.ts';
type Props = {
    twinDrafts?:TwinDraftWorkspacePort|undefined;
    taskRuns?:TaskRunApi|undefined;
    employeeArtifacts?:Pick<ArtifactApi,'listByRole'>|undefined;
    openEmployeeArtifact?:EmployeeArtifactOpen|undefined;
    skillTitleReader?:RoleSkillTitleReader|undefined;
    templateSharing?:{storage:WorkbenchNavigationStorage;bridge?:ShareBridge|undefined;receive:()=>void};
    delegations?:RoleDelegationApi|undefined;
    roleTools?:RoleToolGrantApi|undefined;
    delegationChanged?:(read:RoleDelegationRead)=>void;
    savedGroups?:GroupApi;
    navigation?: {state:WorkbenchDirectoryNavigation;change:(patch:WorkbenchDirectoryPatch)=>void};
    work: BindingClient;
    resourceApi: ResourceApi;
    memoryApi?: RoleMemoryApi;
    autoDreamTrigger?: ScheduleTrigger | undefined;
    dailyLogSchedule?: ((roleId:string)=>{state:'active'|'paused'|'archived'|'unknown';nextAt?:string|null;trigger?:Pick<ScheduleTrigger,'time'|'timezone'>}|undefined) | undefined;
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
        assignConfirmed?: (role:PreviewRole,fields:{title:string;goal:string;scope:CollaborationScope})=>Promise<string>;
        lifecycle: RoleLifecyclePort;
        pendingFields: () => RoleFields | undefined;
        create: (fields: RoleFields) => Promise<string>;
        edit: (role: PreviewRole, fields: RoleFields) => Promise<void>;
        updateProfile?: (role: PreviewRole, fields: Pick<RoleFields,'name'|'avatarKey'>) => Promise<void>;
        load: () => void;
        loading: boolean;
        error: string | undefined;
    };
    embedded?: boolean;
    autoFocus?: boolean;
    conversations: (id: string) => ReactNode;
    talk: (id: string) => Promise<boolean>;
    phone?:((id:string)=>Promise<void>)|undefined;
    visible: boolean;
    state: TaskPreview;
    collaboration: CollaborationPreview;
    selected: string | null;
    select: (id: string | null) => void;
    change: (change: TeamChange) => void;
    openTask: (id: string) => void;
    openGroup: (id: string) => void;
    openBusiness?: ((scope: string) => void) | undefined;
    resources: () => void;
    nativeSettings: () => void;
    capabilities: (id: string) => ReactNode;
    plans: (id: string) => ReactNode;
    scopeLabels: readonly BusinessScopeLabel[];
    /** 从业务页「查看同事」跳进来时聚焦的业务范围：展开该分区并滚到眼前（透传给 StaffRoster 的既有 focusScope）。 */
    focusScope?: string | null;
    /** 本人用户名（personalProfile.displayName）：分身在名单与个人主页上按「{用户名} 的分身」显示。 */
    profileName?: string;
    profileInitials?: string;
    pageCreate?: {api:PageCreateApi;prepare:(prompt:{sourceId:string;title:string;text:string},scope?:CollaborationScope)=>void|Promise<void>;openMarket:()=>void};
};
type AssignmentFields={title:string;goal:string;scope:CollaborationScope}
type MemoryFields={title:string;text:string;scope:CollaborationScope}
type ActionDraft<T>={role:PreviewRole;value:T;pending?:Promise<void>}
type ActionDrafts={assign?:ActionDraft<AssignmentFields>|undefined;memory?:ActionDraft<MemoryFields>|undefined;lifecycle?:ActionDraft<RoleLifecycleDraft>|undefined}
type ActionInputs=WeakMap<object,WeakMap<object,Map<string,ActionDrafts>>>
type ActionView=({kind:'assign';draft:ActionDraft<AssignmentFields>}|{kind:'memory';draft:ActionDraft<MemoryFields>})&{owner:object;key:string}
const employeeProfileSections=['how','tools','reading','limit','runtime','changes'] as const
type EmployeeProfileSection=typeof employeeProfileSections[number]
const employeeProfileSectionViews={how:{copy:'profileHow',icon:Route},tools:{copy:'profileTools',icon:Wrench},reading:{copy:'profileMaterials',icon:BookOpen},limit:{copy:'profileLimits',icon:ShieldCheck},runtime:{copy:'profileActivity',icon:Activity},changes:{copy:'profileChanges',icon:History}} as const
const roleEditDrafts=createRoleFormDrafts<{role:PreviewRole;fields:RoleFields|undefined}>()
const roleSkillQueryDrafts=createRoleFormDrafts<string>()
function submitActionDraft<T>(draft:ActionDraft<T>,run:()=>Promise<void>,clear:()=>void){
 if(draft.pending)return draft.pending
 const pending=Promise.resolve().then(run).then(clear);draft.pending=pending
 void pending.then(()=>{delete draft.pending},()=>{delete draft.pending})
 return pending
}
type RoleInput = {
    draft: TwinDraftInput | undefined;
    profileEdit?:{role:PreviewRole;fields:EmployeeProfileFields}|undefined;
    actionDrafts?:ActionInputs;
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
export function TeamPage({ twinDrafts,employeeArtifacts,openEmployeeArtifact,taskRuns,skillTitleReader,phone,templateSharing,delegations,roleTools,delegationChanged,savedGroups,navigation,work, resourceApi, memoryApi, dailyLogApi, autoDreamTrigger, dailyLogSchedule, runtimeConfigs, capabilityState, persistence, embedded = false, autoFocus = true, conversations, talk, visible, state, collaboration, selected, select, change, openTask, openGroup, openBusiness, resources, nativeSettings, capabilities, plans, scopeLabels, focusScope, profileName = defaultPersonalDisplayName, profileInitials = personalAvatarInitials(profileName), pageCreate }: Props) {
    const { locale, t, list, number } = useI18n();
    const allowed=useApplicationCapability('people');
    profileName = personalDisplayName(profileName, t('profile.account'));
    const collaborationScopes = useBusinessScopes();
    // 「正在忙」是派生态（不是 role.state），四档筛选与成员行状态点共用同一份人话词条（team.roster.status.*，见 roleStatusLabel）。
    const rosterStatusLabel = (value: 'busy' | PreviewRole['state']) => roleStatusLabel(value, t);
    // 身份筛选（数字员工/分身）在第二期从界面撤掉，但合法值表仍收 employee|twin：旧记忆里带这两个值时
    // 整份 category JSON 才不会被严格校验退回默认，连累 status 与折叠记忆一起丢；读到之后一律按 'all' 用，写回也固定 'all'。
    const restoredFilters=readDirectoryFilterCategory(navigation?.state.category,{status:'all',kind:'all',open:'',business:'all',sort:'name'},{business:['all',...scopeLabels.map(label=>label.scope)],status:['all','busy',...Object.keys(roleStates)],kind:['all','employee','twin'],sort:['name','duty']});
    const kind='all' as const;
    // 状态也一样：第一期的筛选弹层有五档，第二期只剩三个胶囊。合法值表保持五档（旧 JSON 才不会整份回退连累 open 折叠记忆），
    // 但恢复时把界面不再暴露的档位（active/retired）折叠回 'all'——否则名单被静默过滤，三个胶囊全是未按下，用户没有任何手段解除。
    const restoredStatus=restoredFilters.status as 'all'|'busy'|PreviewRole['state'];
    const [sort,setSort]=useState<RosterSort>(restoredFilters.sort as RosterSort);
    const [businessFilter,setBusinessFilter]=useState(focusScope??restoredFilters.business);
    const [query, setQuery] = useState(navigation?.state.query??''), [status, setStatus] = useState<'all' | 'busy' | PreviewRole['state']>(STATUS_PILL_IDS.includes(restoredStatus as typeof STATUS_PILL_IDS[number])?restoredStatus:'all'), [creating, setCreating] = useState(false);
    // 折叠记忆扩既有 directories.team.category 这份 JSON，不新开 localStorage 键（见计划「决定」第 1 条）。
    useEffect(()=>{if(focusScope)setBusinessFilter(focusScope)},[focusScope]);
    const [fold, setFold] = useState<RosterFoldState>(()=>readRosterFold(restoredFilters.open));
    // 退役员工默认不进普通名单；这个开关只在本次停留有效，不写进目录筛选记忆（旧 JSON 的五档合法值表不动）。
    const [showRetired,setShowRetired]=useState(false);
    const [directoryMode,setDirectoryMode]=useState<ExampleDirectoryMode>(()=>exampleDirectoryMode(!!persistence));
    const [creationDraft,setCreationDraft]=useState<RoleFields>();
    // 团队分享与自然语言模板草案都在名单页头发起；草案只保存静态模板，预览在分享抽屉中进行。
    const [sharingTeam,setSharingTeam]=useState(false),[describing,setDescribing]=useState(false);
    const sharedTemplates=useTemplateShare();
    const [inputs, setInputs] = useState<Record<string, RoleInput>>({});
    const [recovering, setRecovering] = useState(false), [assignmentError, setAssignmentError] = useState<string>();
    const directoryFocus = useDirectoryFocus(visible, embedded?selected??undefined:undefined, autoFocus);
    // 折叠记忆算出来是空串时干脆不写 open 这个键：空串会被目录筛选的严格校验当成非法值，
    // 连带把同一份 JSON 里的 status/kind 一起退回默认（终审 H1）。没有折叠记忆就等于没有这个键。
    useEffect(()=>{if(!visible)return;const open=writeRosterFold(fold,{status,kind});navigation?.change({query,category:writeDirectoryFilterCategory(open?{status,kind,open,business:businessFilter,sort}:{status,kind,business:businessFilter,sort})})},[visible,navigation,query,status,kind,fold,businessFilter,sort]);
    useEffect(()=>{const item=state.roles.find(role=>role.id===selected);if(item)setDirectoryMode(item.storage==='persistent'?'saved':'sandbox')},[selected,state.roles]);
    if (!visible)
        return null;
    // 名单与个人主页显示的分身名字是「{用户名} 的分身」，搜索也按这个名字命中；存储里的 role.name 一并保留在候选里。
    const roleDisplayName=(role:PreviewRole)=>role.kind==='twin'?twinDisplayName(profileName,t):role.name;
    const isSandbox=directoryMode==='sandbox',directoryRoles=visibleRoleDirectory(state.roles,directoryMode),directoryState={...state,roles:directoryRoles,tasks:visibleTaskDirectory(state.tasks,directoryMode)};
    // 「有待办」判据用 roleIsBusy（与分区头三个数同一口径），其余三档仍按 role.state 精确匹配。
    const searching=!!query.trim();
    const rows = directoryRoles.filter(role => rosterShowsRetired(role,{searching,showRetired,selected}) && (businessFilter==='all'||role.scopes.includes(businessFilter)) && (status === 'all' || (role.kind === 'employee' && (status === 'busy' ? roleIsBusy(role.id, directoryState.tasks) : role.state === status))) && [roleDisplayName(role), role.name, role.duty, ...role.skills].some(text => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
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
    const retiredCount=directoryRoles.filter(item=>item.kind==='employee'&&item.state==='retired').length;
    const resetDirectory=()=>{setQuery('');setStatus('all');select(null)};
    const showRoster = !embedded;
    const detailPane = role
      ? <RoleDetail twinDrafts={isSandbox?undefined:twinDrafts} employeeArtifacts={employeeArtifacts} openEmployeeArtifact={openEmployeeArtifact} openRole={select} taskRuns={taskRuns} skillTitleReader={skillTitleReader} templateSharing={isSandbox?undefined:templateSharing} delegations={isSandbox?undefined:delegations} roleTools={roleTools} delegationChanged={delegationChanged} savedGroups={savedGroups} profileName={profileName} profileInitials={profileInitials} work={work} resourceApi={resourceApi} memoryApi={memoryApi} dailyLogApi={dailyLogApi} autoDreamTrigger={autoDreamTrigger} dailyLogSchedule={dailyLogSchedule} runtimeConfigs={runtimeConfigs} capabilityState={capabilityState} persistence={isSandbox?undefined:persistence} conversations={conversations} {...(!isSandbox?{talk,phone}:{})} input={inputs[role.id] ?? emptyInput()} update={patch => setInputs(current => ({ ...current, [role.id]: { ...(current[role.id] ?? emptyInput()), ...patch } }))} key={role.id} role={role} businessContext={businessFilter==='all'?undefined:businessFilter} state={directoryState} collaboration={collaboration} change={change} back={() => select(null)} openTask={openTask} openGroup={openGroup} openBusiness={isSandbox?undefined:openBusiness} resources={resources} nativeSettings={nativeSettings} capabilities={capabilities} plans={plans}/>
      : <div className={css.empty}><Bot size={38}/><h2>{t('team.landingTitle')}</h2></div>;
    return <section data-team-directory-mode={directoryMode} className={clsx(css.page, css.alignedPage,isSandbox&&css.sandboxMode, teamCss.teamPage, embedded && css.embeddedPage, embedded && teamCss.embeddedTeam)} aria-label={t('navigation.team')}>{!selected&&<CapabilityNotice capability="people"/>}

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
                <div className={teamCss.rosterTitleRow}>
                  <h1>{t('navigation.team')}</h1>
                  {persistence&&!isSandbox&&<button type="button" className={directoryCss.iconAction} disabled={persistence.loading} aria-label={t(persistence.loading ? 'team.loading' : 'team.refresh')} title={t(persistence.loading ? 'team.loading' : 'team.refresh')} onClick={persistence.load}><RefreshCw size={15}/></button>}
                </div>
                <p className={teamCss.rosterSummary}>{t(summaryKey, { people: number(summaryPeople), busy: number(summaryBusy), waiting: number(summaryWaiting) })}</p>
              </div>
              <div className={teamCss.rosterActions}>{templateSharing&&<ToolbarIconButton label={t('templateShare.import')} icon={Download} onClick={templateSharing.receive}/>}
              {templateSharing&&!isSandbox&&sharedTemplates&&directoryRoles.some(item=>item.storage==='persistent'&&item.kind==='employee'&&item.state!=='retired')&&<ToolbarIconButton label={t('templateShare.shareTeam')} icon={Share2} onClick={()=>setSharingTeam(true)}/>}
              {templateSharing&&!isSandbox&&sharedTemplates&&pageCreate&&<ToolbarIconButton label={t('templateShare.describe')} icon={Sparkles} aria-pressed={describing} onClick={()=>setDescribing(value=>!value)}/>}
              <button type="button" className={teamCss.rosterHire} disabled={!allowed} onClick={() => setCreating(true)}><Plus size={16}/>{t('team.action.new')}</button></div>
            </header>
            {describing&&pageCreate&&sharedTemplates&&<div><CreateEntry entity={'share' as PageCreateEntity} directSentence descriptionPlaceholderKey="create.sentence.placeholder.employee" sentenceDraft={{key:'teloa.team-template-creation-input/v1',storage:sharedTemplates.storage}} api={pageCreate.api} prepare={prompt=>pageCreate.prepare({...prompt,text:t('market.create.defaultEmployeePrompt')+'\n\n'+prompt.text})} openMarket={pageCreate.openMarket} renderConfirmation={({preview})=><button type="button" onClick={()=>{try{sharedTemplates.openDraft(readSharePackage((JSON.parse(preview.draft.body) as {package:unknown}).package))}catch{setAssignmentError(t('templateShare.invalid'))}}}>{t('templateShare.previewShare')}</button>}/></div>}
            <div className={teamCss.rosterBar}>
              <label className={teamCss.rosterSearch}><Search size={16}/><input aria-label={t('team.search')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('team.search')}/>{query && <button type="button" className={teamCss.rosterSearchClear} aria-label={t('team.page.searchClear')} title={t('team.page.searchClear')} onClick={() => setQuery('')}><X size={14}/></button>}</label>
              <label className={teamCss.businessFilter}>{employeeCopy(locale,'business')}<select value={businessFilter} onChange={event=>setBusinessFilter(event.target.value)}><option value="all">{employeeCopy(locale,'allBusinesses')}</option>{scopeLabels.map(label=><option key={label.scope} value={label.scope}>{collaborationScopes[label.scope]??label.title}</option>)}</select></label>
              <span className={teamCss.statusPills} role="group" aria-label={t('team.stateFilter')}>
                {statusPills.map(([id, label]) => <button key={id} type="button" aria-pressed={status === id} onClick={() => setStatus(id)}>{label}</button>)}
              </span>
              {retiredCount>0&&<ToolbarIconButton label={showRetired?t('team.page.retired.hide'):t('team.page.retired.show',{count:number(retiredCount)})} icon={Archive} aria-pressed={showRetired} data-roster-retired-toggle onClick={()=>setShowRetired(value=>!value)}/>}
              <label className={rosterCss.sortControl}><span>{directoryChoiceCopy(locale,'sort')}</span><select aria-label={directoryChoiceCopy(locale,'sort')} value={sort} onChange={event=>setSort(event.target.value as RosterSort)}><option value="name">{directoryChoiceCopy(locale,'name')}</option><option value="duty">{directoryChoiceCopy(locale,'duty')}</option></select></label>
              {/* 目录总数按员工身份去重。 */}
              <div className={rosterCss.rosterCount}>
                <span>{t('team.roster.count', { count: number(rosterTotal(rows)) })}</span>
              </div>
            </div>

            {rows.length > 0
              ? <StaffRoster sort={sort} onOpenTask={openTask} onPhone={isSandbox||!phone?undefined:id=>{void phone(id).catch(error=>setAssignmentError(localizeWorkError(locale,error)))}} profileName={profileName} profileInitials={profileInitials} roles={rows} labels={scopeLabels} tasks={directoryState.tasks} {...(focusScope ? { focusScope } : {})} fold={fold} onFoldChange={setFold} searching={searching} onSelect={id => select(id)} onTalk={isSandbox?undefined:id=>{void talk(id).then(opened=>{if(!opened)setAssignmentError(t('team.profile.historyEmpty'))}).catch(error=>setAssignmentError(localizeWorkError(locale,error)))}} onHire={() => {if(applicationPresentation.can('people'))setCreating(true)}}/>
              : <div className={css.empty}><Bot size={30}/><h2>{t(directoryRoles.length ? 'team.empty.noMatch' : 'team.empty.unconfigured')}</h2><p>{t(directoryRoles.length ? 'team.empty.noMatchDescription' : 'team.empty.unconfiguredDescription')}</p>{directoryRoles.length > 0 && <button type="button" onClick={() => { setQuery(''); setStatus('all'); setBusinessFilter('all'); }}>{t('team.empty.reset')}</button>}</div>}
          </section>
        : detailPane}
    </div>
    {!embedded&&role&&<RoleProfileDrawer kind={role.kind} title={roleDisplayName(role)} close={()=>select(null)}>{detailPane}</RoleProfileDrawer>}
    {sharingTeam&&sharedTemplates&&<TeamTemplateShare origin="directory" roles={directoryRoles.filter(item=>item.storage==='persistent'&&(businessFilter==='all'||item.scopes.includes(businessFilter)))} open close={()=>setSharingTeam(false)} scope={businessFilter==='all'?'general':businessFilter} title={businessFilter==='all'?t('navigation.team'):collaborationScopes[businessFilter]??scopeLabels.find(label=>label.scope===businessFilter)?.title??businessFilter}/>}
    {creating&&pageCreate&&persistence&&!isSandbox&&!persistence.pendingFields()
      ?<EmployeeCreateEntry api={pageCreate.api} scope={businessFilter==='all'?'general':businessFilter} scopeName={collaborationScopes[businessFilter==='all'?'general':businessFilter]??businessFilter} storage={templateSharing?.storage??sharedTemplates?.storage} prepare={pageCreate.prepare} create={persistence.create} close={()=>setCreating(false)} created={select}/>
      :creating&&<RoleForm work={work} resourceApi={resourceApi} runtimeConfigs={runtimeConfigs} initial={(!isSandbox?persistence?.pendingFields():undefined)??creationDraft} onDraft={setCreationDraft} retryPending={!isSandbox&&!!persistence?.pendingFields()} persistent={!!persistence&&!isSandbox} close={()=>setCreating(false)} save={async fields=>{
      if(!applicationPresentation.can('people'))return
      const id=persistence&&!isSandbox?await persistence.create(fields):crypto.randomUUID()
      if(!persistence||isSandbox)change({type:'create',id,fields,now:new Date().toISOString()})
      setCreationDraft(undefined);setCreating(false);select(id)
    }}/>}
  </section>;
}
// 导出给 team-profile-sections.test.ts 用 renderToStaticMarkup 直接核对「编辑」态的五组呈现，不必经过 TeamPage 的内部选中态。
export function RoleDetail({ twinDrafts,employeeArtifacts,openEmployeeArtifact,openRole,taskRuns,skillTitleReader,phone,templateSharing,delegations,roleTools,delegationChanged,savedGroups,work, resourceApi, memoryApi, dailyLogApi, autoDreamTrigger, dailyLogSchedule, runtimeConfigs, capabilityState, persistence, conversations, talk, input, update, role, businessContext, state, collaboration, change, back, openTask, openGroup, openBusiness, resources, nativeSettings, capabilities, plans, profileName = defaultPersonalDisplayName, profileInitials = personalAvatarInitials(profileName) }: {
    twinDrafts?:TwinDraftWorkspacePort|undefined;
    openRole?:Props['select']|undefined;
    taskRuns?:TaskRunApi|undefined;
    employeeArtifacts?:Pick<ArtifactApi,'listByRole'>|undefined;
    openEmployeeArtifact?:EmployeeArtifactOpen|undefined;
    work: BindingClient;
    skillTitleReader?:RoleSkillTitleReader|undefined;
    templateSharing?:Props['templateSharing'];
    delegations?:RoleDelegationApi|undefined;
    roleTools?:RoleToolGrantApi|undefined;
    delegationChanged?:((read:RoleDelegationRead)=>void)|undefined;
    profileName?: string;
    profileInitials?: string;
    resourceApi: ResourceApi;
    savedGroups?:GroupApi | undefined;
    memoryApi: Props['memoryApi'];
    dailyLogApi?: Props['dailyLogApi'];
    autoDreamTrigger?: Props['autoDreamTrigger'];
    dailyLogSchedule?: Props['dailyLogSchedule'];
    runtimeConfigs?: RoleRuntimeConfigApi | undefined;
    capabilityState?: CapabilityPreview | undefined;
    persistence: Props['persistence'];
    conversations: Props['conversations'];
    talk?: Props['talk'];
    phone?: Props['phone'];
    input: RoleInput;
    update: (patch: Partial<RoleInput>) => void;
    role: PreviewRole;
    businessContext?:string|undefined;
    state: TaskPreview;
    collaboration: CollaborationPreview;
    change: Props['change'];
    back: () => void;
    openTask: Props['openTask'];
    openGroup: Props['openGroup'];
    openBusiness?: Props['openBusiness'];
    resources: Props['resources'];
    nativeSettings: Props['nativeSettings'];
    capabilities: Props['capabilities'];
    plans: Props['plans'];
}) {
    const { locale, t, dateTime, list } = useI18n();
    const [twinDraftCount,setTwinDraftCount]=useState<number>();
    const titleKey=JSON.stringify([role.id,role.version,role.skills]),titleOriginRef=useRef<{reader:RoleSkillTitleReader|undefined;work:BindingClient;key:string}>()
    if(!titleOriginRef.current||titleOriginRef.current.reader!==skillTitleReader||titleOriginRef.current.work!==work||titleOriginRef.current.key!==titleKey)titleOriginRef.current={reader:skillTitleReader,work,key:titleKey}
    const titleOrigin=titleOriginRef.current
    const [titleRead,setTitleRead]=useState<{origin:typeof titleOrigin;titles:readonly SkillDisplayTitle[]}>()
    useEffect(()=>{let active=true;if(skillTitleReader)void skillTitleReader.read(role).then(titles=>{if(active&&titleOriginRef.current===titleOrigin)setTitleRead({origin:titleOrigin,titles})},()=>{});return()=>{active=false}},[titleOrigin])
    const skillTitles=titleRead?.origin===titleOrigin?titleRead.titles:[]

    const allowed=useApplicationCapability('people');
    profileName = personalDisplayName(profileName, t('profile.account'));
    const collaborationScopes = useBusinessScopes();
    const stamp = (value: string) => dateTime(value, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const [sharing,setSharing]=useState(false);
    const [detailTab,setDetailTab]=useState<'work'|'collaboration'|'capabilities'>('work');
    const [membershipRevision,setMembershipRevision]=useState(0),[savedMemberships,setSavedMemberships]=useState<{id:string;name:string;scope:string}[]>(),[membershipError,setMembershipError]=useState<string>();
    useEffect(()=>{let active=true;if(!savedGroups)return;setSavedMemberships(undefined);setMembershipError(undefined);void savedGroups.list().then(async({items})=>{const rows:{id:string;name:string;scope:string}[]=[];for(let start=0;start<items.length;start+=4){const batch=await Promise.all(items.slice(start,start+4).map(group=>savedGroups.get(group.id)));for(const {group,members} of batch)if(members.some(member=>member.roleId===role.id))rows.push({id:group.id,name:group.name,scope:group.scope})}return rows}).then(items=>{if(active)setSavedMemberships(items)},error=>{if(active)setMembershipError(localizeWorkError(locale,error))});return()=>{active=false}},[savedGroups,role.id,membershipRevision,locale]);
    const detailTabs=['work','collaboration','capabilities'] as const;
    const moveDetailTab=(event:React.KeyboardEvent<HTMLButtonElement>)=>{const index=detailTabs.indexOf(detailTab);let next=index;if(event.key==='ArrowRight')next=(index+1)%3;else if(event.key==='ArrowLeft')next=(index+2)%3;else if(event.key==='Home')next=0;else if(event.key==='End')next=2;else return;event.preventDefault();setDetailTab(detailTabs[next]!);event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus()};
    const [form, setForm] = useState<'edit' | 'profile' | 'invite' | 'retire' | 'assign' | 'memory'>(), [error, setError] = useState<string>(), [chatNotice, setChatNotice] = useState<string>()
    const [actionView,setActionView]=useState<ActionView>()
    const actionInputs=input.actionDrafts??new WeakMap<object,WeakMap<object,Map<string,ActionDrafts>>>(),actionKey=JSON.stringify([role.id,role.storage??'sandbox',businessContext??null])
    const actionContext=useRef({work,memoryApi,key:actionKey,epoch:0}),actionViewRef=useRef(actionView),actionMounted=useRef(true)
    if(actionContext.current.work!==work||actionContext.current.memoryApi!==memoryApi||actionContext.current.key!==actionKey)actionContext.current={work,memoryApi,key:actionKey,epoch:actionContext.current.epoch+1}
    actionViewRef.current=actionView
    const actionOrigin=actionContext.current,isActionCurrent=()=>actionMounted.current&&actionContext.current===actionOrigin
    useEffect(()=>{actionMounted.current=true;return()=>{actionMounted.current=false}},[])
    // work 是稳定连接；persistence 只是父层每次渲染重建的适配器，不能用它识别本人。
    const actionDrafts=(owner:object)=>{let owners=actionInputs.get(work);if(!owners){owners=new WeakMap();actionInputs.set(work,owners)}let contexts=owners.get(owner);if(!contexts){contexts=new Map();owners.set(owner,contexts)}let drafts=contexts.get(actionKey);if(!drafts){drafts={};contexts.set(actionKey,drafts)}return drafts}
    const publishDraft=()=>{if(isActionCurrent())update({actionDrafts:actionInputs})}
    const closeAction=(view:ActionView)=>{if(isActionCurrent()&&actionViewRef.current===view)setForm(undefined)}
    const openAssignment=()=>{const drafts=actionDrafts(work);drafts.assign??={role,value:{title:'',goal:'',scope:role.scopes[0]!}};publishDraft();setActionView({kind:'assign',draft:drafts.assign,owner:work,key:actionKey});setForm('assign')}
    const openMemory=()=>{const owner=memoryApi??work,drafts=actionDrafts(owner);drafts.memory??={role,value:{title:'',text:'',scope:role.scopes[0]!}};publishDraft();setActionView({kind:'memory',draft:drafts.memory,owner,key:actionKey});setForm('memory')}
    // N13（可选）：编辑窗口外点/Esc 只收起，未保存修改留到下次打开；保存成功后清空。
    const [roleEditSlot,roleEdit]=useRoleFormDraft(roleEditDrafts,work,actionKey),[editingRole,setEditingRole]=useState<PreviewRole>()
    const setEditDraft=useCallback((fields:RoleFields)=>{const original=roleEditSlot.read().value;if(original&&original.fields!==fields)roleEditSlot.set({...original,fields})},[roleEditSlot])
    // 轻量编辑的草稿与版本保存在父层原员工输入中，关详情或切员工也能恢复，不跨员工混用。
    const profileDraft=input.profileEdit?.fields;
    const openRoleEditor=()=>{if(!roleEditSlot.read().value)roleEditSlot.set({role,fields:undefined});setForm('edit')};
    const [savedMemories, setSavedMemories] = useState<RoleMemory[]>([]), [memoryLoading, setMemoryLoading] = useState(false), [memoryError, setMemoryError] = useState<string>(), [memoryDiscarded, setMemoryDiscarded] = useState(false);
    const [profilePanel,setProfilePanel]=useState<'memory'|'log'|'plans'|'conversations'|'management'|'permissions'>();
    const [mailOpen,setMailOpen]=useState(false);
    const profileMenu=useRef<HTMLDetailsElement>(null);
    const profilePanelLabels={memory:t('team.profile.group.memory'),log:t('dailyLog.entry'),plans:t('navigation.plans'),conversations:t('objectConversations.aria'),management:employeeCopy(locale,'management'),permissions:employeeCopy(locale,'profilePermissions')};
    const openProfilePanel=(panel:NonNullable<typeof profilePanel>)=>{profileMenu.current?.removeAttribute('open');profileMenu.current?.querySelector('summary')?.focus();setProfilePanel(panel)};
    // 「判断力样本」分组要知道「当前有效日志」建议撤回了哪些已确认记忆：取最近一条未丢弃的日志（list 已按 day 倒序）。
    const [currentPruneHints, setCurrentPruneHints] = useState<RoleDailyLogPruneHint[]>([]);
    useEffect(() => { let active = true; if (role.storage !== 'persistent' || !dailyLogApi) { setCurrentPruneHints([]); return; } void dailyLogApi.list(role.id).then(async rows => {
        const kept = rows.find(row => row.state === 'kept');
        if (!kept) { if (active) setCurrentPruneHints([]); return; }
        const log = await dailyLogApi.get(role.id, kept.id);
        if (active) setCurrentPruneHints(log.pruneHints);
    }).catch(() => { if (active) setCurrentPruneHints([]); }); return () => { active = false; }; }, [role.id, role.storage, dailyLogApi]);
    const talkDisabledReason=role.storage==='persistent'?undefined:t('team.sandbox.chatUnavailable');
    const [runtimeState, setRuntimeState] = useState<RuntimeConfigLoadState>({ status: 'idle' });
    useEffect(() => { let active = true; if (!runtimeConfigs) { setRuntimeState({ status: 'idle' }); return; } setRuntimeState(runtimeConfigLoading()); void runtimeConfigs.list().then(value => { if (active)
        setRuntimeState(runtimeConfigReady(value)); }).catch(error => { if (active)
        setRuntimeState(runtimeConfigFailed(error,locale)); }); return () => { active = false; }; }, [runtimeConfigs,locale]);
    // 员工记忆是可读资料，进入详情即可加载；与编辑和执行权限分开。
    useEffect(() => { let active = true; if (role.storage !== 'persistent' || !memoryApi)
        return; setMemoryLoading(true); setMemoryError(undefined); void memoryApi.list(role.id).then(rows => { if (active)
        setSavedMemories(rows); }).catch(error => { if (active)
        setMemoryError(localizeWorkError(locale, error)); }).finally(() => { if (active)
        setMemoryLoading(false); }); return () => { active = false; }; }, [role.id, role.storage, memoryApi, locale]);
    const retired = role.state === 'retired', twin = role.kind === 'twin';
    const [delegationRead,setDelegationRead]=useState<RoleDelegationRead>();
    const delegationNode=role.storage==='persistent'&&delegations?<RoleDelegation overview={twin} role={role} api={delegations} toolGrants={roleTools} resources={resourceApi} groups={savedGroups} changed={value=>{setDelegationRead(value);delegationChanged?.(value)}} configuration={()=> <section className={css.block}><h3>{t('roleDelegation.configure')}</h3><button type="button" disabled={!allowed||!persistence} onClick={openRoleEditor}>{t('team.action.edit')}</button>{twin&&capabilities(role.id)}{savedGroups&&<RoleGroupMembership api={savedGroups} roleId={role.id} open={openGroup}/>}</section>}/>:undefined;
    const unfinished = state.tasks.filter(task => task.assigneeId === role.id && !closed(task.state));
    const lifecycle = roleLifecyclePath(role.state,t);
    const lifecyclePending = persistence?.lifecycle.pending?.roleId === role.id;
    const blocker = lifecyclePending ? t('team.detail.blocker.pending') : role.state === 'paused' ? t('team.detail.blocker.paused') : role.state === 'retired' ? t('team.detail.blocker.retired') : t('team.detail.blocker.none');
    const act = (command: TeamChange) => { if(!applicationPresentation.can('people')&&(['create','edit','assign','memory-add','draft'].includes(command.type)||command.type==='lifecycle'&&command.action==='resume'||command.type==='memory-decide'&&command.action==='confirm'))return false;try {
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
    const detailedDuty=role.duty.trim().replace(/[。.!?！？]+$/u,'')===dutyLead?undefined:role.duty;
    const workMode=runtimeConfigSummary(role.runtimeConfig?.agentPresetId,runtimeState.directory,locale);
    const workModeNotice=runtimeState.status==='error'?runtimeState.error:workMode.health==='unavailable'?workMode.detail:undefined;
    // 所有相关工作在工作页签展示一次，群成员关系独立展示，不改变业务范围。
    const related = state.tasks.filter(task => task.assigneeId === role.id || task.authorId === role.id || task.assigneeHistory.includes(role.id));
    const groups = collaboration.groups.filter(group => group.memberIds.includes(role.id));
    const coworkers=employeeCoworkers(role.id,related,state.roles);
    // 记忆列表（候选 → 本人确认 → 私有保留或撤回）由同事个人主页的「它记得的事」与分身主页的「判断力样本」共用同一份节点，
    // 分身页面不再重写一遍加载、确认与撤回接线；分身分支的标题与路径说明仍按 twin 取词条（team.detail.tab.judgment / team.memory.twinPath）。
    // source.kind==='daily-digest'/'habit-digest' 读专属词条，sourceAvailable===false 追加 roleMemory.sourceGone
    // （替换原先传给 team.memory.source 的空串 availability）；其余来源类别沿用既有 team.memory.source 整句拼装。
    const memorySourceLabel = (memory: RoleMemory) => {
        if (memory.source.kind === 'daily-digest' || memory.source.kind === 'habit-digest') {
            const base = t(memory.source.kind === 'daily-digest' ? 'roleMemory.sourceDaily' : 'roleMemory.sourceHabit');
            return memory.sourceAvailable ? base : base + ' · ' + t('roleMemory.sourceGone');
        }
        return t('team.memory.source', { title: roleMemorySourceTitle(memory, t), kind: memory.source.kind, version: memory.source.version, availability: memory.sourceAvailable ? '' : t('team.memory.sourceUnavailable') });
    };
    // 私有记忆的 30 条上限在服务端只回 teloa/conflict；确认被拒时给出这一处的专属说明，不让本人只看到一句通用冲突。
    const localizeMemoryError = (memory: RoleMemory, error: unknown) =>
        memory.visibility.kind === 'private' && !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'teloa/conflict'
            ? t('roleMemory.privateLimit')
            : localizeWorkError(locale, error);
    const renderSavedMemory = (memory: RoleMemory, suggested = false) => { const path = roleMemoryPath(memory.state, t); return <article className={teamCss.memory} key={memory.id}><header><strong>{memory.title}</strong><span>{path.label} · {t('team.memory.contentVersion', { version: memory.content.version })}</span></header><p>{memory.content.markdown}</p><div className={teamCss.memoryPath}><span>{memorySourceLabel(memory)}</span><span>{path.summary}</span><small>{t('team.memory.next', { next: path.next })}</small></div><small>{memory.visibility.kind === 'private' ? t('team.memory.private') : list(memory.visibility.scopeIds.map(scope => collaborationScopes[scope] ?? scope))} · {stamp(memory.candidateAt)}</small>{suggested && <p className={css.muted}>{t('dailyLog.pruneHintHint')}</p>}{memoryApi&&<RoleMemoryEditor memory={memory} api={memoryApi} disabled={!allowed||retired||memory.state==='withdrawn'} onSaved={saved=>{setSavedMemories(rows=>rows.map(row=>row.id===saved.id&&row.ownerId===saved.ownerId&&row.roleId===saved.roleId&&saved.content.version>=row.content.version&&saved.stateVersion>=row.stateVersion?saved:row));setMemoryError(undefined)}}/>}{!retired && memory.state !== 'withdrawn' && memoryApi && <div className={css.buttons}>{memory.state === 'candidate' && <button type="button" disabled={!allowed||!memory.sourceAvailable} onClick={async () => {if(!applicationPresentation.can('people'))return;try { const saved = await memoryApi.confirm(memory.id, memory.stateVersion); setSavedMemories(rows => rows.map(row => row.id === saved.id ? saved : row)); setMemoryError(undefined) } catch (error) { setMemoryError(localizeMemoryError(memory, error)) } }}>{t('team.memory.confirm')}</button>}<button type="button" onClick={async () => { try { const saved = await memoryApi.withdraw(memory.id, memory.stateVersion); setSavedMemories(rows => rows.map(row => row.id === saved.id ? saved : row)); setMemoryError(undefined) } catch (error) { setMemoryError(localizeWorkError(locale, error)) } }}>{t('team.memory.withdraw')}</button></div>}</article> };
    // 分身「Auto Dream · 习惯观察」的「记下来」：把观察日志的一条事实提升为私有记忆候选（T11）。
    // source 恒为 {kind:'habit-digest',id:<日志 id>,version:1}，visibility 恒私有——与简报铁律逐字一致，不接受调用方覆盖。
    const promoteHabit = memoryApi ? async (log: RoleDailyLog, value: { title: string; markdown: string }) => {
        if(!applicationPresentation.can('people'))return;const saved = await memoryApi.create({ roleId: role.id, expectedRoleVersion: role.version, title: value.title, markdown: value.markdown, source: { kind: 'habit-digest', id: log.id, version: 1 }, visibility: { kind: 'private', scopeIds: [] } });
        setSavedMemories(rows => rows.some(row => row.id === saved.id) ? rows.map(row => row.id === saved.id ? saved : row) : [...rows, saved]);
    } : undefined;
    const memorySection = <>
      <header><h3>{t(twin ? 'team.detail.tab.judgment' : 'team.memory.candidate')}</h3>{!retired && <button type="button" disabled={!allowed} onClick={openMemory}>{t('team.memory.record')}</button>}</header>
      <p className={css.muted}>{t(twin ? 'team.memory.twinPath' : 'team.memory.rolePath')} {t(role.storage === 'persistent' ? 'team.memory.persistentNote' : 'team.memory.demoNote')}</p>
      {memoryError && <p role="alert">{memoryError}</p>}
      {memoryLoading && <p>{t('team.memory.loading')}</p>}
      {role.storage === 'persistent' ? savedMemories.length ? groupRoleMemories(savedMemories, currentPruneHints).map(group => group.items.length ? <div key={group.id}><h4>{t(group.titleKey as Parameters<typeof t>[0])}</h4>{group.items.map(memory => renderSavedMemory(memory, group.id === 'pruneSuggested'))}</div> : null) : !memoryLoading && <p>{t('team.memory.emptyPersistent')}</p> : role.memories.length ? role.memories.map(memory => { const path = roleMemoryPath(memory.status, t); return <article className={teamCss.memory} key={memory.id}><header><strong>{memory.title}</strong><span>{path.label} · v{memory.version}</span></header><p>{memory.text}</p><div className={teamCss.memoryPath}><span>{t('team.memory.source', { title: memory.source, kind: '', version: '', availability: '' })}</span><span>{path.summary}</span><small>{t('team.memory.next', { next: path.next })}</small></div><small>{memory.scope === 'private' ? t('team.memory.private') : t('team.memory.roleScope')} · {stamp(memory.updatedAt)}</small>{!retired && memory.status !== 'withdrawn' && <div className={css.buttons}>{memory.status === 'candidate' && <button type="button" disabled={!allowed} onClick={() => act({ type: 'memory-decide', roleId: role.id, memoryId: memory.id, expectedVersion: memory.version, action: 'confirm', now: new Date().toISOString() })}>{t('team.memory.confirmDemo')}</button>}<button type="button" onClick={() => act({ type: 'memory-decide', roleId: role.id, memoryId: memory.id, expectedVersion: memory.version, action: 'withdraw', now: new Date().toISOString() })}>{t('team.memory.withdrawDemo')}</button></div>}</article> }) : <p>{t('team.memory.emptyDemo')}</p>}
    </>;
    const managementSection=<div className={teamCss.managementActions}>
        <section className={teamCss.managementSummary}><h3>{employeeCopy(locale,'profileHow')}</h3><p>{role.duty}</p><dl className={teamCss.facts}><dt>{t('team.detail.businessScope')}</dt><dd>{list(role.scopes.map(scope=>collaborationScopes[scope]??scope))}</dd><dt>{t('team.detail.executionPlane')}</dt><dd>{role.executionScope}</dd><dt>{employeeCopy(locale,'profileActivity')}</dt><dd>{statusLabel(role.state)}</dd><dt>{employeeCopy(locale,'profileAllTasks')}</dt><dd>{related.length}</dd></dl></section>
        {!retired && <button type="button" className={teamCss.identityEditLink} disabled={!allowed} onClick={openRoleEditor}>{t('team.action.edit')}</button>}
        {role.storage!=='persistent'&&!retired&&<><button type="button" disabled={!allowed&&role.state==='paused'} onClick={()=>act({type:'lifecycle',roleId:role.id,expectedVersion:role.version,action:role.state==='paused'?'resume':'pause',reason:t(role.state==='paused'?'team.detail.resumeReason':'team.detail.pauseReason'),now:new Date().toISOString()})}>{t(role.state==='paused'?'team.profile.action.resume':'team.profile.action.pause')}</button><button type="button" onClick={()=>setForm('retire')}>{t('team.profile.action.retire')}</button></>}
        {templateSharing&&role.storage==='persistent'&&<><button type="button" onClick={()=>setSharing(true)}>{t('templateShare.create')}</button></>}
        {role.storage === 'persistent' && persistence && <RoleLifecycle key={actionOrigin.epoch} role={role} impact={{tasks:unfinished.length,groups:savedMemberships?.length}} draft={actionDrafts(work).lifecycle?.value} pending={actionDrafts(work).lifecycle?.pending} onDraft={value=>{const drafts=actionDrafts(work);if(drafts.lifecycle)drafts.lifecycle.value=value;else drafts.lifecycle={role,value};publishDraft()}} api={{...persistence.lifecycle,change:async(_role,action,reason)=>{
          const drafts=actionDrafts(work),draft=drafts.lifecycle
          if(!draft)throw Error(t('team.assignment.unavailable'))
          await submitActionDraft(draft,()=>persistence.lifecycle.change(draft.role,action,reason),()=>{if(drafts.lifecycle===draft)drafts.lifecycle=undefined;publishDraft()})
        }}}/>}
        </div>;
    // 页顶不再常驻 team.detail.version：版本号是系统态，照原型只留返回链接（终审 T5），版本移进「它的变更记录」里的折叠小字。
    return <article data-teloa-pane="detail" tabIndex={-1} className={clsx(css.detail,teamCss.roleDetail)} aria-label={t('navigation.team')}><CapabilityNotice capability="people"/><header className={css.detailHeader}><button type="button" className={css.back} onClick={back}><ArrowLeft size={16}/>{t('team.detail.back')}</button></header>
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
    {/* 分身保留既有专属流程，数字员工详情按工作、协作与能力页签组织；
        「全部同事」返回、错误条与各个对话框都留在外面，两支共用。 */}
    {twin
      ? <TwinProfile {...(twinDrafts?{draftWorkspace:<TwinDraftWorkspace port={twinDrafts} roleId={role.id} roleVersion={role.version} retired={retired} count={setTwinDraftCount}/>,draftCount:twinDraftCount}:{})} {...(phone&&!retired&&role.storage==='persistent'?{phone:()=>phone(role.id)}:{})} profileName={profileName} profileInitials={profileInitials} role={role} draft={input.draft} update={draft => update({ draft })} save={act} {...(talk?{talk:async()=>{await talk(role.id)}}:talkDisabledReason?{talkDisabledReason}:{})} conversations={role.storage==='persistent'?conversations(role.id):null} samples={memorySection} {...(role.storage!=='persistent'?{sampleCount:role.memories.length}:!memoryLoading&&!memoryError?{sampleCount:savedMemories.length}:{})} delegation={delegationNode} {...(delegationNode?{executionStatus:roleDelegationStatus(role,delegationRead)}:{})} {...(!retired&&role.state==='active'&&allowed&&persistence?.assignConfirmed?{assign:()=>setForm('assign')}:{})} habits={role.storage==='persistent'&&dailyLogApi?<RoleDailyLogPanel trigger={autoDreamTrigger} {...(dailyLogSchedule?{schedule:dailyLogSchedule(role.id)}:{})} roleId={role.id} kind="habit-digest" api={dailyLogApi} memoryApi={memoryApi} {...(promoteHabit?{promote:promoteHabit}:{})}/>:undefined}/>
      : <div className={teamCss.homepage}>
      <aside className={teamCss.identityRail} aria-label={t('team.profile.title')}>
        {/* 1.0 员工抽屉：居中身份区；动作只留「发消息」「通话」「⋯」，编辑、邀请、云电脑、邮箱与档案面板收进「⋯」。 */}
        <div className={teamCss.identityHero}>
        <EmployeeAvatar avatarKey={role.avatarKey} size="xl"/>
        <h2>{role.name}</h2>
        <div className={teamCss.identityChips}>
          <span className={teamCss.scopeNames} aria-label={employeeCopy(locale,'servingBusinesses')}>{role.scopes.length?role.scopes.map(scope=>openBusiness
            ? <button type="button" key={scope} data-current-scope={scope===businessContext?true:undefined} aria-label={scope===businessContext?`${collaborationScopes[scope]??scope} · ${employeeCopy(locale,'currentBusiness')}`:undefined} onClick={()=>openBusiness(scope)}>{collaborationScopes[scope]??scope}</button>
            : <span key={scope} title={scope===businessContext?employeeCopy(locale,'currentBusiness'):undefined}>{collaborationScopes[scope]??scope}</span>):employeeCopy(locale,'noBusiness')}</span>
          <span className={teamCss.identityStatusRow} data-identity-status={identityStatus}><StatusLabel label={statusLabel(identityStatus)} mark={identityStatus==='active'?'enabled':identityStatus==='paused'?'paused':'retired'} tone={identityStatus==='active'?'good':'muted'}/></span>
        </div>
        <p>{dutyLead}</p>
        <div className={teamCss.identityActions} aria-label={t('team.profile.title')}>
          <button type="button" className={teamCss.primaryPill} disabled={!talk} aria-describedby={talkDisabledReason?`role-chat-note-${encodeURIComponent(role.id)}`:undefined} onClick={()=>{if(!talk)return;setChatNotice(undefined);void talk(role.id).then(opened=>{if(!opened)setChatNotice(t('team.profile.historyEmpty'))}).catch(error=>setError(localizeWorkError(locale,error)))}}><MessageCircle size={14} aria-hidden/>{retired?t('team.profile.action.history'):employeeCopy(locale,'message')}</button>
          <button type="button" className={teamCss.outlinePill} disabled={!phone||retired||role.storage!=='persistent'} aria-describedby={!phone?`role-phone-note-${encodeURIComponent(role.id)}`:undefined} onClick={()=>{void phone?.(role.id).catch(error=>setError(localizeWorkError(locale,error)))}}><Phone size={14} aria-hidden/>{employeeCopy(locale,'call')}</button>
          <DetailsMenu menuRef={profileMenu} className={teamCss.profileMenu} resetKey={role.id} closeOnSelect>
            <summary aria-label={employeeCopy(locale,'moreActions')} title={employeeCopy(locale,'moreActions')}><MoreHorizontal size={16}/></summary>
            <div role="menu">
              <button type="button" disabled={!allowed||retired||!savedGroups} onClick={()=>setForm('invite')}><Users size={14} aria-hidden/>{employeeCopy(locale,'inviteTitle')}</button>
              <EmployeeDevices role={role} variant="menu" openMail={()=>setMailOpen(true)}/>
              {!retired&&<button type="button" disabled={!allowed} onClick={()=>{setEditingRole(input.profileEdit?.role??role);setForm('profile')}}><Pencil size={14} aria-hidden/>{employeeCopy(locale,'editProfile')}</button>}
              <span className={teamCss.menuDivider} aria-hidden="true"/>
              {(['memory','log','plans','conversations'] as const).filter(panel=>panel!=='conversations'||role.storage==='persistent').map(panel=>{const Icon={memory:Brain,log:ScrollText,plans:Zap,conversations:MessagesSquare}[panel];return <button type="button" key={panel} onClick={()=>openProfilePanel(panel)}><Icon size={14}/>{profilePanelLabels[panel]}</button>})}
              {!retired&&<button type="button" disabled={!allowed||role.state!=='active'} onClick={openAssignment}><ListPlus size={14}/>{t('team.profile.action.assign')}</button>}
              <button type="button" onClick={()=>openProfilePanel('management')}><UserCog size={14}/>{profilePanelLabels.management}</button>
              <button type="button" onClick={()=>openProfilePanel('permissions')}><ShieldCheck size={14}/>{profilePanelLabels.permissions}</button>
              {templateSharing&&role.storage==='persistent'&&<button type="button" onClick={()=>setSharing(true)}><Share2 size={14}/>{employeeCopy(locale,'profileShare')}</button>}
            </div>
          </DetailsMenu>
        </div>
        {!phone&&<DisabledReason id={`role-phone-note-${encodeURIComponent(role.id)}`} className={teamCss.reasonNote}>{employeeCopy(locale,'phoneUnavailable')}</DisabledReason>}
        {chatNotice&&<p role="status" className={teamCss.muted}>{chatNotice}</p>}
        {talkDisabledReason&&<DisabledReason id={`role-chat-note-${encodeURIComponent(role.id)}`} className={teamCss.reasonNote}>{talkDisabledReason}</DisabledReason>}
        </div>
        <div className={teamCss.identityToday}><small>{t('team.profile.today')}</small><strong>{doingNow ?? t('team.roster.idle')}</strong></div>
        <small className={teamCss.identityOwner}><Users size={13}/>{t('team.profile.owner')}</small>
        {retired&&<div className={teamCss.notice}><strong>{lifecycle.label}</strong><p>{role.retirementReason}</p><p>{lifecycle.summary}</p><p>{t('team.detail.retiredNext', { next: lifecycle.next })}</p></div>}
      </aside>
      {mailOpen&&<EmployeeMailDrawer role={role} close={()=>setMailOpen(false)}/>}
      <section className={teamCss.homepageBody}>
        <nav className={teamCss.tabs} role="tablist" aria-label={employeeCopy(locale,'detailTabs')}>
          {detailTabs.map(tab=><button key={tab} type="button" role="tab" id={`employee-detail-tab-${tab}`} aria-controls={`employee-detail-panel-${tab}`} aria-selected={detailTab===tab} tabIndex={detailTab===tab?0:-1} onClick={()=>setDetailTab(tab)} onKeyDown={moveDetailTab}>{employeeCopy(locale,tab==='work'?'workTab':tab==='collaboration'?'collaborationTab':'capabilities')}{tab==='work'&&related.length>0?` (${related.length})`:tab==='collaboration'&&(savedGroups?savedMemberships?.length:groups.length)?` (${savedGroups?savedMemberships?.length:groups.length})`:''}</button>)}
        </nav>
        <div id="employee-detail-panel-work" role="tabpanel" aria-labelledby="employee-detail-tab-work" hidden={detailTab!=='work'}>
          <EmployeeWorkOverview active={detailTab==='work'} artifacts={employeeArtifacts} openArtifact={openEmployeeArtifact} role={role} tasks={related} state={state} runs={taskRuns} scopeName={scope=>collaborationScopes[scope]??scope} openTask={openTask} resources={resources}/>
        </div>
        <div id="employee-detail-panel-collaboration" role="tabpanel" aria-labelledby="employee-detail-tab-collaboration" hidden={detailTab!=='collaboration'}>
          <div className={teamCss.profileSections}><section><header><h3>{employeeCopy(locale,'groups')}</h3><button type="button" disabled={!allowed||retired||!savedGroups} onClick={()=>setForm('invite')}>{employeeCopy(locale,'inviteTitle')}</button></header><div className={teamCss.employeeWork}>{membershipError?<p role="alert">{membershipError}<button type="button" onClick={()=>setMembershipRevision(value=>value+1)}>{t('common.retry')}</button></p>:savedGroups&&!savedMemberships?<p role="status">{t('team.loading')}</p>:(savedGroups?savedMemberships??[]:groups).length?(savedGroups?savedMemberships??[]:groups).map(group=><button type="button" key={group.id} onClick={()=>openGroup(group.id)}><strong>{group.name}</strong><small>{collaborationScopes[group.scope]??group.scope}</small></button>):<p className={css.muted}>{employeeCopy(locale,'noGroups')}</p>}</div></section><section><header><h3>{employeeCopy(locale,'profileCoworkers')}</h3></header>{coworkers.length?coworkers.map(({role:peer,count})=><button type="button" className={teamCss.profileRow} key={peer.id} disabled={!openRole} onClick={()=>openRole?.(peer.id)}><EmployeeAvatar avatarKey={peer.avatarKey}/><span><strong>{peer.name}</strong><small>{employeeCopy(locale,'profileSharedTasks').replace('{count}',String(count))}</small></span></button>):<p className={css.muted}>{employeeCopy(locale,'profileNoCoworkers')}</p>}</section><section><header><h3>{employeeCopy(locale,'profileBusinessScope')}</h3></header><div className={teamCss.resourceChips}>{role.scopes.map(scope=><button type="button" key={scope} disabled={!openBusiness} onClick={()=>openBusiness?.(scope)}>{collaborationScopes[scope]??scope}</button>)}</div></section></div>
        </div>
        <div id="employee-detail-panel-capabilities" role="tabpanel" aria-labelledby="employee-detail-tab-capabilities" hidden={detailTab!=='capabilities'}>
          <div className={teamCss.profileSections}>
          {employeeProfileSections.map(section => { const {copy}=employeeProfileSectionViews[section],bodyId=`role-profile-${section}`; return <section id={`role-profile-section-${section}`} key={section} aria-labelledby={`${bodyId}-heading`}>
            <header><h3 id={`${bodyId}-heading`}>{employeeCopy(locale,copy)}</h3>{section==='how'&&!retired&&<button type="button" disabled={!allowed} onClick={openRoleEditor}>{t('team.action.edit')}</button>}{section==='tools'&&<button type="button" onClick={()=>openProfilePanel('permissions')}>{profilePanelLabels.permissions}</button>}{section==='reading'&&<ToolbarIconButton label={employeeCopy(locale,'profileManageMaterials')} icon={BookOpen} onClick={resources}/>}</header>
            <div id={bodyId} className={teamCss.profileSectionBody}>
              {section === 'how' && <>
                {detailedDuty&&(detailedDuty.length>480?<details><summary>{employeeCopy(locale,'profileFullDuty')}</summary><p>{detailedDuty}</p></details>:<p>{detailedDuty}</p>)}
                {role.responsibility ? <dl className={teamCss.responsibilities}>{responsibilityGroups(role.responsibility).filter(group => (['triggers', 'autonomousActions', 'deliveryChecks'] as string[]).includes(group.key)).map(group => <div key={group.key}><dt>{t(group.labelKey)}</dt><dd>{group.items.length ? <ul>{group.items.map(item => <li key={item}>{item}</li>)}</ul> : t('team.detail.notSet')}</dd></div>)}</dl> : <p className={teamCss.inlineNotice}>{t('team.detail.responsibilityMissing')}</p>}
              </>}
              {section === 'tools' && <>
                <div className={teamCss.resourceChips}>{role.skills.map(skill=><button type="button" key={skill} title={skill} onClick={nativeSettings}><Wrench size={13}/>{skillDisplayTitle(skillTitles,{name:skill})}</button>)}</div>
                {!role.skills.length&&<p className={teamCss.muted}>{employeeCopy(locale,'profileNoSkills')}</p>}
                <EmployeeGrantedTools role={role} api={roleTools} open={()=>openProfilePanel('permissions')}/>
                <p className={teamCss.muted}>{workModeNotice??workMode.label}</p>
              </>}
              {section === 'reading' && <>
                <p>{role.dataScope}</p>
                <RoleKnowledge compact api={resourceApi} ids={role.knowledge} scopes={role.scopes}/>
              </>}
              {section === 'limit' && <>
                {role.responsibility && <dl className={teamCss.responsibilities}>{responsibilityGroups(role.responsibility).filter(group => (['confirmationPoints', 'escalationRules'] as string[]).includes(group.key)).map(group => <div key={group.key}><dt>{t(group.labelKey)}</dt><dd>{group.items.length ? <ul>{group.items.map(item => <li key={item}>{item}</li>)}</ul> : t('team.detail.notSet')}</dd></div>)}</dl>}
                <dl className={teamCss.facts}><dt>{t('team.detail.executionPlane')}</dt><dd>{role.executionScope}</dd><dt>{t('team.detail.knowledgeRead')}</dt><dd>{t('team.detail.knowledgeReadDesc')}</dd><dt>{t('team.detail.toolsConnections')}</dt><dd>{t('team.detail.toolsConnectionsDesc')}</dd><dt>{t('team.detail.formalApproval')}</dt><dd>{t('team.detail.formalApprovalDesc')}</dd></dl>
                <p className={teamCss.profileBoundary}>{t('team.detail.employeeAuthorizationDesc')}</p>
              </>}
              {/* 原身份栏的生命周期与状态三问保留在活动状态，未知回执与操作仍由原子组件处理。 */}
              {section === 'runtime' && <><dl className={teamCss.facts} aria-label={t('team.detail.identity.status')}>
                <dt>{t('team.detail.lifecycle')}</dt><dd>{lifecycle.summary}</dd>
                <dt>{t('team.detail.actualState')}</dt><dd>{statusLabel(role.state)} · {lifecycle.label}</dd>
                <dt>{t('team.detail.blocker')}</dt><dd>{blocker}</dd>
                <dt>{t('team.detail.next')}</dt><dd>{lifecyclePending ? t('team.detail.pendingStateReview') : lifecycle.next}</dd>
              </dl></>}
              {section==='changes'&&<><ol className={css.history}>{role.history.map((item,index)=><li key={index}><span>{item.text}</span><small>{roleName(state.roles,item.actorId,t)} · {stamp(item.at)}</small></li>)}</ol><details><summary>{t('team.history.identity')}</summary><p>{role.id}</p><p>{t('team.detail.version',{version:role.version})}</p></details></>}
            </div>
          </section> })}
          </div>
        </div>
      </section>
    </div>}
    {!twin&&<ContextDrawer compact open={profilePanel==='permissions'} title={profilePanelLabels.permissions} close={()=>setProfilePanel(undefined)}><div className={teamCss.profilePanelBody}>{delegationNode}{capabilities(role.id)}</div></ContextDrawer>}
    {!twin&&profilePanel&&profilePanel!=='permissions'&&<ContextDrawer compact title={profilePanelLabels[profilePanel]} close={()=>setProfilePanel(undefined)}><div className={teamCss.profilePanelBody}>
      {profilePanel==='memory'?memorySection:profilePanel==='log'?role.storage==='persistent'&&dailyLogApi?<RoleDailyLogPanel trigger={autoDreamTrigger} {...(dailyLogSchedule?{schedule:dailyLogSchedule(role.id)}:{})} roleId={role.id} kind="daily-digest" api={dailyLogApi} memoryApi={memoryApi}/>:<p className={css.muted}>{t('team.memory.demoNote')}</p>:profilePanel==='plans'?plans(role.id):profilePanel==='conversations'?conversations(role.id):managementSection}
    </div></ContextDrawer>}
    {templateSharing&&role.storage==='persistent'&&<EmployeeTemplateShare role={role} open={sharing} close={()=>setSharing(false)} storage={templateSharing.storage} bridge={templateSharing.bridge}/>}
    {form==='profile'&&<EmployeeProfileEditor role={editingRole??role} initial={profileDraft} onDraft={fields=>update({profileEdit:fields?{role:editingRole??role,fields}:undefined})} close={()=>setForm(undefined)} save={async value=>{const baseline=editingRole??role;if(baseline.storage==='persistent'){if(!persistence)throw Error(t('team.assignment.unavailable'));if(value.duty===baseline.duty){if(!persistence.updateProfile)throw Error(t('team.assignment.unavailable'));await persistence.updateProfile(baseline,{name:value.name,...(value.avatarKey?{avatarKey:value.avatarKey}:{})})}else await persistence.edit(baseline,value)}else change({type:'edit',roleId:baseline.id,expectedVersion:baseline.version,...value,now:new Date().toISOString()});update({profileEdit:undefined});setEditingRole(undefined)}}/>}
    {form==='invite'&&savedGroups&&<EmployeeGroupInvite role={role} api={savedGroups} close={()=>setForm(undefined)} invited={()=>{setMembershipRevision(value=>value+1);setDetailTab('collaboration')}}/>}
    {form==='edit'&&roleEdit.value&&<RoleForm skillTitles={roleEdit.value.role.version===role.version?skillTitles:[]} key={actionOrigin.epoch} work={work} resourceApi={resourceApi} runtimeConfigs={runtimeConfigs} persistent={role.storage==='persistent'} role={{...roleEdit.value.role,...roleEdit.value.fields}} pending={roleEdit.pending} discard={roleEdit.value.role.version!==role.version?()=>{roleEditSlot.set(undefined);setForm(undefined)}:undefined} onDraft={setEditDraft} close={()=>setForm(undefined)} save={async value=>{
      const original=roleEdit.value!
      await roleEditSlot.run(original,async()=>{if(original.role.storage==='persistent'){if(!persistence)throw Error(t('team.assignment.unavailable'));await persistence.edit(original.role,value)}else change({type:'edit',roleId:original.role.id,expectedVersion:original.role.version,...value,now:new Date().toISOString()})})
      if(isActionCurrent())setForm(current=>current==='edit'?undefined:current)
    }}/>}
    {form === 'retire' && <RetirementForm plans={state.continuous.plans.filter(plan => plan.fields.roleId === role.id && !plan.archived).map(plan => ({ id: plan.id, title: planDisplayTitle(plan.fields.title, plan.systemDigest, t) }))} role={role} unfinished={unfinished.map(task => ({ id: task.id, title: task.title, needs:list(taskNeeds(task).map(need => t(attentionKinds[need]))) }))} close={() => setForm(undefined)} save={reason => { change({ type: 'lifecycle', roleId: role.id, expectedVersion: role.version, action: 'retire', reason, now: new Date().toISOString() }); setForm(undefined); }}/>}
    {form==='assign'&&actionView?.kind==='assign'&&actionView.owner===work&&actionView.key===actionKey&&<AssignmentForm key={actionOrigin.epoch} role={role} initial={actionView.draft.value} onDraft={value=>{actionView.draft.value=value;publishDraft()}} pending={actionView.draft.pending} close={()=>closeAction(actionView)} save={async value=>{
      const view=actionView,draft=view.draft,drafts=actionDrafts(work)
      await submitActionDraft(draft,async()=>{let id:string;if(draft.role.storage==='persistent'){if(!persistence)throw Error(t('team.assignment.unavailable'));if(draft.role.kind==='twin'){if(!persistence.assignConfirmed)throw Error(t('roleDelegation.unavailable'));id=await persistence.assignConfirmed(draft.role,value)}else id=await persistence.assign(draft.role,value)}else{id=crypto.randomUUID();change({type:'assign',roleId:draft.role.id,id,...value,now:new Date().toISOString()})}if(isActionCurrent())openTask(id)},()=>{if(drafts.assign===draft)drafts.assign=undefined;publishDraft()})
      closeAction(view)
    }}/>}
    {form==='memory'&&actionView?.kind==='memory'&&actionView.owner===(memoryApi??work)&&actionView.key===actionKey&&<MemoryForm key={actionOrigin.epoch} persistent={role.storage==='persistent'} twin={twin} scopes={role.scopes} initial={actionView.draft.value} onDraft={value=>{actionView.draft.value=value;publishDraft()}} pending={actionView.draft.pending} close={()=>closeAction(actionView)} save={async value=>{
      const view=actionView,draft=view.draft,drafts=actionDrafts(memoryApi??work)
      await submitActionDraft(draft,async()=>{if(draft.role.storage==='persistent'){if(!memoryApi)throw Error(t('team.assignment.unavailable'));const saved=await memoryApi.create({roleId:draft.role.id,expectedRoleVersion:draft.role.version,title:value.title,markdown:value.text,source:{kind:'self-feedback',id:crypto.randomUUID(),version:1},visibility:draft.role.kind==='twin'?{kind:'private',scopeIds:[]}:{kind:'role',scopeIds:[value.scope]}});if(isActionCurrent()){setSavedMemories(rows=>[...rows,saved]);setMemoryError(undefined)}}else change({type:'memory-add',roleId:draft.role.id,id:crypto.randomUUID(),title:value.title,text:value.text,source:t('team.memory.selfFeedback'),now:new Date().toISOString()})},()=>{if(drafts.memory===draft)drafts.memory=undefined;publishDraft()})
      closeAction(view)
    }}/>}
  </article>;
}
function Dialog({ title, close, children, submit, pending, wide=false, drawer=false, capability, noValidate=false }: {
    title: string;
    wide?: boolean;
    drawer?: boolean;
    capability?: WorkCapability;
    noValidate?: boolean;
    close: () => void;
    children: ReactNode;
    submit: () => void | Promise<void>;
    pending?:Promise<void>|undefined;
}) {
    const { locale, t } = useI18n();
    const capabilityAllowed=useApplicationCapability(capability??'general-agent'),allowed=!capability||capabilityAllowed;
    const ref = useRef<HTMLDialogElement>(null), [error, setError] = useState<string>(), [busy, setBusy] = useState(!!pending);
    // 外点、Esc 只收起窗口；草稿由内容自己通过 onDraft 保留，提交仍只经表单 submit。忙碌中不关闭。
    const dismissEvents=useDialogDismiss(close,!busy);
    useEffect(() => {if(!drawer)return openDialog(ref.current, ref.current?.querySelector<HTMLElement>('input, textarea, select'))}, [drawer]);
    useEffect(()=>{if(!pending)return;let active=true;void pending.then(()=>{if(active)close()},error=>{if(active){setError(localizeWorkError(locale,error));setBusy(false)}});return()=>{active=false}},[pending,locale]);
    const form=<form className={css.form} noValidate={noValidate} onSubmit={event => { event.preventDefault(); if (busy||capability&&!applicationPresentation.can(capability))
        return; setError(undefined); try { const result=submit(); if(result){setBusy(true);void Promise.resolve(result).catch(error=>setError(localizeWorkError(locale,error))).finally(()=>setBusy(false));} } catch(error){setError(localizeWorkError(locale,error))} }}>{!drawer&&<header><h2>{title}</h2><button type="button" aria-label={t('team.form.close')} disabled={busy} onClick={close}><X size={18}/></button></header>}{error && <p role="alert">{error}</p>}<fieldset disabled={busy} className={teamCss.formBody}>{capability&&!allowed&&<CapabilityNotice capability={capability}/>} {Children.map(children,child=>capability&&!(isValidElement(child)&&child.type==='footer')?<CapabilityFields capability={capability}>{child}</CapabilityFields>:child)}</fieldset></form>;
    return drawer?<ContextDrawer title={title} close={close} canClose={!busy}>{form}</ContextDrawer>:<dialog ref={ref} className={clsx(css.dialog, css.alignedDialog,wide&&teamCss.hireDialog)} aria-label={title} {...dismissEvents}>{form}</dialog>;
}
const emptyResponsibility = () => ({ triggers: [], autonomousActions: [], confirmationPoints: [], escalationRules: [], deliveryChecks: [] });
const responsibilityText = (items: string[]) => items.join('\n');
const responsibilityItems = (value: string) => [...new Set(value.split('\n').map(item => item.trim()).filter(Boolean))];
// 新建时 role===undefined，步骤外壳换成三问一工牌（规格 §4.6）；编辑既有岗位保持今天的五步一字不改（Q2）。
const HIRE_GATE_STEPS=[0,1,2,4] as const
export function RoleForm({skillTitles,work,resourceApi,runtimeConfigs,initial,persistent=false,role,pending,discard,close,save,onDraft,retryPending=true}:{skillTitles?:readonly SkillDisplayTitle[]|undefined;work:BindingClient;resourceApi:ResourceApi;runtimeConfigs?:RoleRuntimeConfigApi|undefined;initial?:RoleFields|undefined;onDraft?:((fields:RoleFields)=>void)|undefined;pending?:Promise<void>|undefined;discard?:(()=>void)|undefined;retryPending?:boolean;persistent?:boolean;role?:PreviewRole|undefined;close:()=>void;save:(fields:RoleFields)=>void|Promise<void>}){
  const [skillQuerySlot,skillQueryDraft]=useRoleFormDraft(roleSkillQueryDrafts,work,JSON.stringify(role?['role',role.id]:['new']))
  const initialFields=useRef(initial).current
  const allowed=useApplicationCapability('people')
  const {t,list,locale}=useI18n()
  const collaborationScopes=useBusinessScopes()
  const mode:'hire'|'edit'=role?'edit':'hire'
  const [step,setStep]=useState(0)
  const preset=HIRE_PRESETS[0]
  const [limits,setLimits]=useState<Readonly<Record<HireAction,HireLevel>>>(()=>{
    const restored={...HIRE_DEFAULT_LIMITS}
    if(initialFields)for(const action of HIRE_ACTIONS){
      if(initialFields.executionScope.includes(t(`team.hire.action.${action}.never`)))restored[action]='never'
      else if(initialFields.responsibility?.confirmationPoints.includes(t(`team.hire.action.${action}.ask`)))restored[action]='ask'
      else if(initialFields.responsibility?.autonomousActions.includes(t(`team.hire.action.${action}.self`)))restored[action]='self'
    }
    return restored
  })
  const [sourceMode,setSourceMode]=useState<'describe'|'import'>('describe')
  const [sourceFile,setSourceFile]=useState('')
  const [sourceError,setSourceError]=useState<string>()
  const [readingSource,setReadingSource]=useState(false)
  const importGeneration=useRef(0)
  useEffect(()=>()=>{importGeneration.current++},[])
  const [validationError,setValidationError]=useState<string>()
  const nameRef=useRef<HTMLInputElement>(null),dutyRef=useRef<HTMLTextAreaElement>(null),dataRef=useRef<HTMLTextAreaElement>(null),executionRef=useRef<HTMLTextAreaElement>(null),scopeRef=useRef<HTMLInputElement>(null)
  useEffect(()=>{
   if(!validationError)return
   const target=validationError===employeeCopy(locale,'nameRequired')?nameRef.current:validationError===employeeCopy(locale,'dataRequired')?dataRef.current:validationError===employeeCopy(locale,'executionRequired')?executionRef.current:validationError===employeeCopy(locale,'scopeRequired')?scopeRef.current:dutyRef.current
   const disclosure=target?.closest('details');if(disclosure)disclosure.open=true
   target?.focus()
  },[step,validationError,locale])
  // 切预设/开关/业务范围前如果发现④屏被手动改过（复审 MEDIUM），先记下待确认的目标，等用户点「仍然覆盖」才真的应用。
  const [pendingHireChange,setPendingHireChange]=useState<{kind:'limit';action:HireAction;level:HireLevel}|{kind:'scope';scopes:CollaborationScope[]}>()
  const scopeLabelsFor=(scopes:readonly CollaborationScope[])=>scopes.map(scope=>collaborationScopes[scope]??scope)
  // list() 做语言相关的列表拼接（顿号只是中文的分隔符，其它语言要走 Intl.ListFormat）——复审 LOW：
  // 纯函数 hirePresetFields 内部没有 locale 上下文，所以在这里、调用处拼好整句摘要再传进去。
  const scopeSummary=(scopes:readonly CollaborationScope[])=>list(scopeLabelsFor(scopes))
  // 纯函数逐句返回执行边界，拼成一行是界面层的事：分隔符按语言取词条，不写死中文分号。
  const listJoin=t('team.hire.listJoin')
  const joinScope=(fields:HireAppliedFields):RoleFields=>({...fields,executionScope:fields.executionScope.join(listJoin)})
  const [value,setValue]=useState<RoleFields>(role?{...(role.avatarKey===undefined?{}:{avatarKey:role.avatarKey}),name:role.name,kind:role.kind,scopes:role.scopes,duty:role.duty,dataScope:role.dataScope,executionScope:role.executionScope,skills:role.skills,knowledge:role.knowledge,responsibility:role.responsibility??emptyResponsibility(),...(role.runtimeConfig===undefined?{}:{runtimeConfig:role.runtimeConfig})}:initialFields??({...joinScope(hireMergePreset({name:'',avatarKey:'general',kind:'employee',scopes:['general'],duty:'',dataScope:t('team.form.defaultDataScope'),executionScope:t('team.form.defaultExecutionScope'),skills:[],knowledge:[],responsibility:emptyResponsibility()},hirePresetFields(HIRE_PRESETS[0],t,scopeSummary(['general'])),HIRE_DEFAULT_LIMITS,t)),duty:''}))
  useEffect(()=>{onDraft?.(value)},[value,onDraft])
  // 预设基线按「当前选中的预设 + 当前勾选的业务范围」现算，业务范围一变，下次切预设/开关时 dataScope 就会带上新范围（复审 HIGH-1）。
  const presetBase=hirePresetFields(preset,t,scopeSummary(value.scopes))
  const [runtimeState,setRuntimeState]=useState<RuntimeConfigLoadState>({status:'idle'})
  const [runtimeChanged,setRuntimeChanged]=useState(false)
  const [modelState,setModelState]=useState<RoleModelLoadState>({status:'idle'})
  const [modelOpen,setModelOpen]=useState(mode==='edit'||!!value.runtimeConfig?.model||!!value.runtimeConfig?.fallbackModel)
  const [modelRetry,setModelRetry]=useState(0)
  const runtimeDirectory=runtimeState.directory
  const patch=(changes:Partial<RoleFields>)=>{setValidationError(undefined);if(changes.duty!==undefined)setSourceError(undefined);setValue(current=>({...current,...changes}))}
  const patchRuntime=(agentPresetId:string)=>{setRuntimeChanged(true);setValue(current=>{const next={...current},runtime={...current.runtimeConfig};if(agentPresetId)runtime.agentPresetId=agentPresetId;else delete runtime.agentPresetId;if(Object.keys(runtime).length)next.runtimeConfig=runtime;else delete next.runtimeConfig;return next})}
  const applyLimit=(action:HireAction,level:HireLevel)=>{const next={...limits,[action]:level};setLimits(next);setValue(current=>joinScope(hireMergeLimit(current,presetBase,next,t)))}
  // 勾选业务范围也要现算 dataScope（复审 HIGH-1 补完）：只更新 scopes 与 dataScope，不碰 skills/duty/knowledge/responsibility。
  const applyScope=(scopes:CollaborationScope[])=>{const dataScope=hirePresetFields(preset,t,scopeSummary(scopes)).dataScope;setValue(current=>({...current,scopes,dataScope}))}
  const toggleLimit=(action:HireAction,level:HireLevel)=>{if(limits[action]===level){setPendingHireChange(undefined);return}if(hireDrifted(value,presetBase,limits,t,listJoin))setPendingHireChange({kind:'limit',action,level});else applyLimit(action,level)}
  const toggleScope=(scopeId:CollaborationScope,checked:boolean)=>{const scopes=checked?[...value.scopes,scopeId]:value.scopes.filter(scope=>scope!==scopeId);if(hireDrifted(value,presetBase,limits,t,listJoin))setPendingHireChange({kind:'scope',scopes});else applyScope(scopes)}
  const confirmPendingHireChange=()=>{if(!pendingHireChange)return;if(pendingHireChange.kind==='limit')applyLimit(pendingHireChange.action,pendingHireChange.level);else applyScope(pendingHireChange.scopes);setPendingHireChange(undefined)}
  // 入职④屏不读取预设目录，agentPresetId 仍按裁定 7 继承默认；模型只在主动展开时读取。
  useEffect(()=>{let active=true;if(step!==3||mode!=='edit'||!runtimeConfigs)return;setRuntimeState(runtimeConfigLoading());void runtimeConfigs.list().then(directory=>{if(active)setRuntimeState(runtimeConfigReady(directory))}).catch(error=>{if(active)setRuntimeState(runtimeConfigFailed(error,locale))});return()=>{active=false}},[step,mode,runtimeConfigs,locale])
  useEffect(()=>{let active=true;if(step!==3||!modelOpen||!runtimeConfigs?.models)return;setModelState({status:'loading'});void runtimeConfigs.models().then(directory=>{if(active)setModelState({status:'ready',directory})}).catch(()=>{if(active)setModelState({status:'error'})});return()=>{active=false}},[step,mode,modelOpen,modelRetry,runtimeConfigs])
  const hireSteps=[['team.hire.step.identity','team.hire.step.identityDesc'],['team.hire.step.job','team.hire.step.jobDesc'],['team.hire.step.limit','team.hire.step.limitDesc'],['team.hire.step.badge','team.hire.step.badgeDesc']] as const
  const editSteps=[['team.form.step.identity','team.form.step.identityDesc'],['team.form.step.scope','team.form.step.scopeDesc'],['team.form.step.capabilities','team.form.step.capabilitiesDesc'],['team.form.step.runtime','team.form.step.runtimeDesc'],['team.form.step.review','team.form.step.reviewDesc']] as const
  const steps=mode==='hire'?hireSteps:editSteps
  const identityReady=!!value.name.trim()&&(mode==='hire'&&step===0||!!value.duty.trim())
  const scopeReady=value.scopes.length>0&&!!value.dataScope.trim()&&!!value.executionScope.trim()
  const initialAgentPresetId=(role?role.runtimeConfig:initialFields?.runtimeConfig)?.agentPresetId
  const presetReady=runtimeConfigCanSave({initialAgentPresetId,agentPresetId:value.runtimeConfig?.agentPresetId,changed:runtimeChanged,directory:runtimeDirectory})
  const runtimeReady=presetReady&&roleModelsCanSave(role?role.runtimeConfig:initialFields?.runtimeConfig,value.runtimeConfig,modelState.directory)
  // 三问只有 4 屏，借用旧五步的门禁判据：①→旧 0、②→旧 1、③无门禁（旧 2）、④→旧 4（同时要 identityReady/scopeReady/runtimeReady）。
  const gateStep=(index:number):number=>mode==='hire'?HIRE_GATE_STEPS[index]??index:index
  const {canContinue:progressContinue,canOpenStep:canOpenStepAt}=roleFormProgress({step:gateStep(step),identityReady,scopeReady,runtimeReady})
  const canContinue=progressContinue&&(mode!=='hire'||step===0||!!value.duty.trim())
  const canOpenStep=(index:number)=>canOpenStepAt(gateStep(index))&&(mode!=='hire'||index<=1||!!value.duty.trim())
  const moveLimit=(event:React.KeyboardEvent<HTMLButtonElement>,action:HireAction,index:number)=>{
   const count=HIRE_LEVELS.length
   const next=event.key==='ArrowRight'||event.key==='ArrowDown'?(index+1)%count:event.key==='ArrowLeft'||event.key==='ArrowUp'?(index+count-1)%count:event.key==='Home'?0:event.key==='End'?count-1:undefined
   if(next===undefined)return
   event.preventDefault();toggleLimit(action,HIRE_LEVELS[next]!)
   event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="radio"]')[next]?.focus()
  }
  const mustPause=persistent&&role?.state==='active'
  const submit=()=>{
   if(!value.name.trim()){setValidationError(employeeCopy(locale,'nameRequired'));setStep(0);nameRef.current?.focus();return}
   if((mode==='edit'||step>0)&&!value.duty.trim()){setValidationError(employeeCopy(locale,'dutyRequired'));setStep(mode==='hire'?1:0);dutyRef.current?.focus();return}
   if(step>0&&!value.scopes.length){setValidationError(employeeCopy(locale,'scopeRequired'));setStep(1);return}
   if(step>0&&!value.dataScope.trim()){setValidationError(employeeCopy(locale,'dataRequired'));setStep(mode==='hire'?3:1);return}
   if(step>0&&!value.executionScope.trim()){setValidationError(employeeCopy(locale,'executionRequired'));setStep(mode==='hire'?3:1);return}
   if(step===steps.length-1&&!runtimeReady){setModelOpen(true);setValidationError(t('roleModels.confirmBeforeSave'));setStep(3);return}
   setValidationError(undefined)
   if(readingSource||sourceMode==='import'&&sourceError||!applicationPresentation.can('people')||!canContinue||mustPause&&step===steps.length-1)return;return step<steps.length-1?setStep(step+1):save({...value,name:value.name.trim(),duty:value.duty.trim(),skills:value.skills,knowledge:value.knowledge})}
  // 员工配置保留 required，由上述校验统一提示并聚焦，避免原生气泡抢先拦截。
  return <Dialog pending={pending} noValidate capability="people" title={t(role?'team.form.editRole':'team.form.newRole')} drawer={!!role} wide={!role} close={close} submit={submit}>
    {discard&&<div className={teamCss.inlineNotice}><p>{t('roleDelegation.status.stale')}</p><button type="button" onClick={discard}>{t('collaboration.resources.discardDraft')}</button></div>}
    {validationError&&<p className={teamCss.inlineNotice} role="alert">{validationError}</p>}
    {initialFields&&!role&&<p>{retryPending?t('team.form.retryPending'):employeeCopy(locale,'draftRestored')}</p>}
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
      <label>{t('team.form.name')}<input ref={nameRef} aria-invalid={!!validationError&&!value.name.trim()} required maxLength={80} value={value.name} onChange={event=>patch({name:event.target.value})} placeholder={t('team.form.namePlaceholder')}/></label>
      {value.kind==='employee'&&<EmployeeAvatarPicker value={value.avatarKey} name={value.name} onChange={avatarKey=>patch({avatarKey})}/>}
      <label>{t('team.form.kind')}<select disabled={!!role} value={value.kind} onChange={event=>patch({kind:event.target.value as RoleFields['kind']})}><option value="employee">{t('team.form.employee')}</option><option value="twin">{t('team.form.twin')}</option></select></label>
      <label>{t('team.form.mission')}<textarea ref={dutyRef} aria-invalid={!!validationError&&!value.duty.trim()} required rows={3} maxLength={4000} value={value.duty} onChange={event=>patch({duty:event.target.value})} placeholder={t('team.form.missionPlaceholder')}/></label>
      <p className={teamCss.stepHint}>{t('team.form.responsibilityHint')}</p>
      <div className={teamCss.responsibilityEditor}>{responsibilityGroups(value.responsibility??emptyResponsibility()).map(group=><label key={group.key}>{t(group.labelKey)}<textarea rows={2} maxLength={4000} value={responsibilityText(group.items)} onChange={event=>patch({responsibility:{...(value.responsibility??emptyResponsibility()),[group.key]:responsibilityItems(event.target.value)}})}/><small>{t('team.form.onePerLine')}</small></label>)}</div>
      {value.kind==='twin'&&<p className={teamCss.inlineNotice}>{t('team.form.twinNote')}</p>}
    </section>}
    {mode==='hire'&&step===0&&<section className={teamCss.stepPanel} aria-label={t('team.hire.step.identity')}>
      <h1>{t('team.hire.identity.title')}</h1>

      <label>{t('team.hire.identity.nameLabel')}<input ref={nameRef} aria-invalid={!!validationError&&!value.name.trim()} autoFocus required maxLength={80} value={value.name} onChange={event=>patch({name:event.target.value})} placeholder={t('team.hire.identity.namePlaceholder')}/></label>
      <EmployeeAvatarPicker value={value.avatarKey} name={value.name} onChange={avatarKey=>patch({avatarKey})}/>
    </section>}
    {mode==='edit'&&step===1&&<section className={teamCss.stepPanel} aria-label={t('team.form.step.scope')}>
      <fieldset className={teamCss.scopes}><legend>{t('team.detail.businessScope')}</legend>{roleScopeOptions(collaborationScopes,value.scopes).map(([id,label])=><label key={id}><input ref={value.scopes.length?undefined:scopeRef} type="checkbox" checked={value.scopes.includes(id as CollaborationScope)} onChange={event=>patch({scopes:event.target.checked?[...value.scopes,id as CollaborationScope]:value.scopes.filter(scope=>scope!==id)})}/>{label}</label>)}</fieldset>
      <label>{t('team.form.dataScope')}<textarea ref={dataRef} required rows={3} maxLength={4000} value={value.dataScope} onChange={event=>patch({dataScope:event.target.value})}/></label>
      <label>{t('team.form.executionScope')}<textarea ref={executionRef} required rows={3} maxLength={4000} value={value.executionScope} onChange={event=>patch({executionScope:event.target.value})}/></label>
      <p className={teamCss.inlineNotice}>{t('team.form.scopeNote')}</p>
    </section>}
    {mode==='hire'&&step===1&&<section className={teamCss.stepPanel} aria-label={t('team.hire.step.job')}>
      <h1>{t('team.hire.job.title')}</h1>
      <p>{employeeCopy(locale,'sourceNotice')}</p>
      <div className={teamCss.sourceModes} role="group" aria-label={employeeCopy(locale,'sourceLabel')}>
        <button type="button" aria-pressed={sourceMode==='describe'} onClick={()=>{importGeneration.current++;setReadingSource(false);setSourceError(undefined);setSourceMode('describe')}}>{employeeCopy(locale,'describe')}</button>
        <button type="button" aria-pressed={sourceMode==='import'} onClick={()=>setSourceMode('import')}>{employeeCopy(locale,'importSop')}</button>
      </div>
      {sourceMode==='import'&&<><label>{employeeCopy(locale,'importSop')}<input type="file" accept=".txt,.md,text/plain,text/markdown" disabled={readingSource} onChange={async event=>{
       const file=event.target.files?.[0],token=++importGeneration.current
       setSourceError(undefined);setSourceFile('')
       if(!file)return
       if(!/\.(txt|md)$/i.test(file.name)||file.size>32000){setSourceError(employeeCopy(locale,'importInvalid'));return}
       setReadingSource(true)
       try{const bytes=await file.arrayBuffer(),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).trim();if(!text||text.length>4000||text.includes('\0'))throw Error();if(token!==importGeneration.current)return;patch({duty:text});setSourceFile(file.name)}
       catch{if(token===importGeneration.current)setSourceError(employeeCopy(locale,'importInvalid'))}
       finally{if(token===importGeneration.current)setReadingSource(false)}
      }}/></label><p className={teamCss.stepHint}>{employeeCopy(locale,'importHint')}</p>{readingSource&&<p role="status">{employeeCopy(locale,'importing')}</p>}{sourceFile&&<p>{sourceFile}</p>}{sourceError&&<p role="alert">{sourceError}</p>}</>}
      <label>{t('team.form.mission')}<textarea ref={dutyRef} aria-invalid={!!validationError&&!value.duty.trim()} required rows={3} maxLength={4000} value={value.duty} onChange={event=>patch({duty:event.target.value})} placeholder={t('team.form.missionPlaceholder')}/></label>
      <details><summary>{t('team.form.step.capabilities')}</summary>
        <div className={teamCss.capabilityChoice}><div><h3>{t('team.detail.defaultSkill')}</h3></div><HomeSkillPicker skillTitles={skillTitles} work={work} purpose="role" query={skillQueryDraft.value??''} onQueryChange={query=>skillQuerySlot.set(query)} selected={value.skills.map(name=>({name,source:'',provider:''}))} change={skills=>patch({skills:skills.map(skill=>skill.name)})}/></div>
        <div className={teamCss.capabilityChoice}><div><h3>{t('team.form.knowledge')}</h3></div><RoleKnowledge api={resourceApi} ids={value.knowledge} scopes={value.scopes} change={knowledge=>patch({knowledge})}/></div>
      </details>
      <fieldset className={teamCss.scopes}><legend>{t('team.detail.businessScope')}</legend>{roleScopeOptions(collaborationScopes,value.scopes).map(([id,label])=><label key={id}><input ref={value.scopes.length?undefined:scopeRef} type="checkbox" checked={value.scopes.includes(id as CollaborationScope)} onChange={event=>toggleScope(id as CollaborationScope,event.target.checked)}/>{label}</label>)}</fieldset>
    </section>}
    {step===2&&<section className={teamCss.stepPanel} aria-label={t(mode==='hire'?'team.hire.step.limit':'team.form.step.capabilities')}>
      {mode==='edit'?<>
        <div className={teamCss.capabilityChoice}><div><h3>{t('team.detail.defaultSkill')}</h3></div><HomeSkillPicker skillTitles={skillTitles} work={work} purpose="role" query={skillQueryDraft.value??''} onQueryChange={query=>skillQuerySlot.set(query)} selected={value.skills.map(name=>({name,source:'',provider:''}))} change={skills=>patch({skills:skills.map(skill=>skill.name)})}/></div>
        <div className={teamCss.capabilityChoice}><div><h3>{t('team.form.knowledge')}</h3></div><RoleKnowledge api={resourceApi} ids={value.knowledge} scopes={value.scopes} change={knowledge=>patch({knowledge})}/></div><p className={teamCss.inlineNotice}>{roleSkillNotice(t)}</p>
      </>:<>
        <h1>{t('team.hire.limit.title')}</h1>
        <p>{t('team.hire.limit.subtitle')}</p>
        <ul className={teamCss.limitList}>{HIRE_ACTIONS.map(action=><li key={action}>
          <span>{hireActionLabel(action,t)}</span>
          <span className={teamCss.segment} role="radiogroup" aria-label={hireActionLabel(action,t)}>{HIRE_LEVELS.map((level,index)=><button key={level} type="button" role="radio" aria-checked={limits[action]===level} tabIndex={limits[action]===level?0:-1} onKeyDown={event=>moveLimit(event,action,index)} onClick={()=>toggleLimit(action,level)}>{hireLevelLabel(level,t)}</button>)}</span>
        </li>)}</ul>
      </>}
    </section>}
    {step===3&&<section className={teamCss.stepPanel} aria-label={t(mode==='hire'?'team.hire.step.badge':'team.form.step.runtime')}>
      {mode==='hire'?<>
        <h1>{t('team.hire.badge.title')}</h1>

        <div className={teamCss.previewWrap}>
          <div className={teamCss.badgeCard}>
            <span className={teamCss.badgeHole}/>
            <EmployeeAvatar avatarKey={value.avatarKey} size="xl"/>
            <strong className={teamCss.badgeName}>{value.name.trim()||t('team.form.unnamed')}</strong>
            <span className={teamCss.badgeJob}>{value.duty}</span>
            <StatusLabel label={employeeCopy(locale,'draft')} mark="inactive" tone="muted"/>
            <span className={teamCss.chipRow}>{value.skills.slice(0,3).map(skill=><span key={skill} className={teamCss.chip}>{skill}</span>)}</span>
            <span className={teamCss.badgeFoot}><Users size={13}/>{t('team.profile.owner')}</span>
          </div>
          <dl className={teamCss.previewFacts}>
            <dt>{employeeCopy(locale,'sourceLabel')}</dt><dd>{sourceFile||employeeCopy(locale,'manual')}</dd>
            <dt>{t('team.hire.fact.self')}</dt><dd>{list(HIRE_ACTIONS.filter(action=>limits[action]==='self').map(action=>hireActionLabel(action,t)))||t('team.hire.fact.none')}</dd>
            <dt>{t('team.hire.fact.ask')}</dt><dd>{list(HIRE_ACTIONS.filter(action=>limits[action]==='ask').map(action=>hireActionLabel(action,t)))||t('team.hire.fact.none')}</dd>
            <dt>{t('team.hire.fact.never')}</dt><dd>{list(HIRE_ACTIONS.filter(action=>limits[action]==='never').map(action=>hireActionLabel(action,t)))||t('team.hire.fact.none')}</dd>
          </dl>
        </div>

      </>:<header className={teamCss.runtimeHeader}><div><h3>{t('team.form.step.runtime')}</h3></div></header>}
      {/* 入职④屏删「运行配置」select（裁定 7）：runtimeConfig 省略走既有默认，这一整块只在编辑既有岗位时渲染。 */}
      {mode==='edit'&&<>
      {runtimeState.status==='loading'&&<p className={css.muted}>{t('team.form.runtimeLoading')}</p>}{runtimeState.error&&<p className={teamCss.inlineNotice} role="alert">{runtimeState.error}</p>}
      {!runtimeDirectory&&value.runtimeConfig?.agentPresetId&&<div className={teamCss.runtimeSummary}><strong>{t('team.form.runtimePinned',{id:value.runtimeConfig.agentPresetId})}</strong><span>{t('team.form.runtimeMissing')}</span><button type="button" onClick={()=>patchRuntime('')}>{t('team.form.runtimeInherit')}</button></div>}
      {runtimeDirectory&&<><label>{t('team.form.runtimeSelect')}<select value={value.runtimeConfig?.agentPresetId??''} onChange={event=>patchRuntime(event.target.value)}>{runtimeConfigOptions(value.runtimeConfig?.agentPresetId,runtimeDirectory,locale).map(item=><option key={item.id} value={item.id} disabled={item.disabled}>{item.label}</option>)}</select></label>{runtimeDirectory.items.length===0&&<p className={teamCss.inlineNotice}>{t('team.form.runtimeEmpty')}</p>}<div className={teamCss.runtimeSummary}><strong>{runtimeConfigSummary(value.runtimeConfig?.agentPresetId,runtimeDirectory,locale).label}</strong><span>{runtimeConfigSummary(value.runtimeConfig?.agentPresetId,runtimeDirectory,locale).detail}</span></div>{!presetReady&&<p className={teamCss.inlineNotice} role="alert">{t('team.form.runtimeRequired')}</p>}</>}
      </>}
      {runtimeConfigs?.models&&<details className={teamCss.sectionNote} open={modelOpen} onToggle={event=>setModelOpen(event.currentTarget.open)}><summary>{t('roleModels.title')}</summary><RoleModelFields runtime={value.runtimeConfig} state={modelState} change={(field,model)=>setValue(current=>{const next={...current},runtime=patchRoleModel(current.runtimeConfig,field,model);if(runtime)next.runtimeConfig=runtime;else delete next.runtimeConfig;return next})} retry={()=>setModelRetry(count=>count+1)}/></details>}
      {mode==='hire'&&<details className={teamCss.sectionNote}><summary>{t('team.hire.expand')}</summary>
        <div className={teamCss.responsibilityEditor}>{responsibilityGroups(value.responsibility??emptyResponsibility()).map(group=><label key={group.key}>{t(group.labelKey)}<textarea rows={2} maxLength={4000} value={responsibilityText(group.items)} onChange={event=>patch({responsibility:{...(value.responsibility??emptyResponsibility()),[group.key]:responsibilityItems(event.target.value)}})}/><small>{t('team.form.onePerLine')}</small></label>)}</div>
        <label>{t('team.form.dataScope')}<textarea ref={dataRef} required rows={3} maxLength={4000} value={value.dataScope} onChange={event=>patch({dataScope:event.target.value})}/></label>
        <label>{t('team.form.executionScope')}<textarea ref={executionRef} required rows={3} maxLength={4000} value={value.executionScope} onChange={event=>patch({executionScope:event.target.value})}/></label>
      </details>}
    </section>}
    {mode==='edit'&&step===4&&<section className={teamCss.reviewPanel} aria-label={t('team.form.reviewAria')}><header><span className={teamCss.avatar}>{value.name.slice(0,1)||<Bot size={15}/>}</span><div><h3>{value.name||t('team.form.unnamed')}</h3><p>{t(value.kind==='twin'?'team.form.twinShort':'team.form.employee')} · {list(value.scopes.map(scope=>collaborationScopes[scope]??scope))}</p></div></header><dl><dt>{t('team.form.mission')}</dt><dd>{value.duty}</dd><dt>{t('team.form.responsibilityGroups')}</dt><dd>{value.responsibility?responsibilityGroups(value.responsibility).map(group=>`${t(group.labelKey)} ${t(group.items.length?'team.form.set':'team.form.notSet')}`).join(' · '):t('team.form.unstructured')}</dd><dt>{t('team.form.step.runtime')}</dt><dd>{runtimeConfigSummary(value.runtimeConfig?.agentPresetId,runtimeDirectory,locale).label}</dd><dt>{t('roleModels.primary')}</dt><dd>{value.runtimeConfig?.model?roleModelLabel(value.runtimeConfig.model,modelState.directory):t('roleModels.inherit')}</dd><dt>{t('team.form.dataBoundary')}</dt><dd>{value.dataScope}</dd><dt>{t('team.form.executionBoundary')}</dt><dd>{value.executionScope}</dd><dt>{t('team.form.materials')}</dt><dd>{value.knowledge.length?t('team.form.materialCount',{count:value.knowledge.length}):t('team.form.noneSelected')}</dd><dt>{t('market.industry.resource.skill')}</dt><dd>{value.skills.length?list(value.skills):t('team.form.notDeclared')}</dd></dl><div className={teamCss.nextActions}><strong>{t('team.form.afterSave')}</strong>{[1,2,3,4].map(index=><span key={index}>{t(`team.form.afterSave.${index}` as 'team.form.afterSave.1')}</span>)}</div></section>}
    <footer className={clsx(css.buttons,teamCss.stepFooter)}><button type="button" onClick={step===0?close:()=>setStep(step-1)}>{step===0?t(mode==='hire'?'team.hire.cancel':'team.form.cancel'):<><ChevronLeft size={14}/>{t('team.form.previous')}</>}</button><span>{t('team.form.progress',{current:step+1,total:steps.length})}</span><button type="submit" disabled={!allowed||readingSource||mustPause&&step===steps.length-1}>{step===steps.length-1?t(mode==='hire'?'team.hire.submit':persistent?'team.form.saveRole':'team.form.saveDemoRole'):<>{t('team.form.next')}<ChevronRight size={14}/></>}</button></footer>
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

function AssignmentForm({role,initial,onDraft,pending,close,save}:{role:PreviewRole;initial?:AssignmentFields;onDraft?:(value:AssignmentFields)=>void;pending?:Promise<void>|undefined;close:()=>void;save:(value:AssignmentFields)=>void|Promise<void>}){
  const allowed=useApplicationCapability('people')
  const {t}=useI18n();const collaborationScopes=useBusinessScopes();const [value,setValue]=useState<AssignmentFields>(initial??{title:'',goal:'',scope:role.scopes[0]!}),{title,goal,scope}=value,[twinConfirmed,setTwinConfirmed]=useState(false)
  const change=(value:AssignmentFields)=>{setTwinConfirmed(false);setValue(value);onDraft?.(value)}
  return <Dialog drawer pending={pending} capability="people" title={t('team.assignment.title',{name:role.name})} close={close} submit={()=>{if(applicationPresentation.can('people')&&(role.kind!=='twin'||twinConfirmed))return save({title,goal,scope})}}><p>{t('team.assignment.path')}</p><p>{roleWorkPath(role.storage==='persistent',t)}</p><label>{t('team.assignment.name')}<input required maxLength={120} value={title} onChange={event=>change({...value,title:event.target.value})}/></label><label>{t('team.assignment.goal')}<textarea aria-label={t('team.assignment.goal')} required rows={4} maxLength={8000} value={goal} onChange={event=>change({...value,goal:event.target.value})}/></label><label>{t('team.assignment.scope')}<select value={scope} onChange={event=>change({...value,scope:event.target.value as CollaborationScope})}>{role.scopes.map(id=><option key={id} value={id}>{collaborationScopes[id]??id}</option>)}</select></label>{role.kind==='twin'&&<label><input type="checkbox" checked={twinConfirmed} onChange={event=>setTwinConfirmed(event.target.checked)}/>{t('roleDelegation.taskConfirm')}</label>}<footer className={css.buttons}><button type="button" onClick={close}>{t('team.form.cancel')}</button><button type="submit" disabled={!allowed||!title.trim()||!goal.trim()||role.kind==='twin'&&!twinConfirmed}>{t(role.kind==='twin'?'roleDelegation.taskCreate':role.storage==='persistent'?'team.assignment.save':'team.assignment.demo')}</button></footer></Dialog>
}

function MemoryForm({persistent,twin,scopes,initial,onDraft,pending,close,save}:{persistent:boolean;twin:boolean;scopes:CollaborationScope[];initial?:MemoryFields;onDraft?:(value:MemoryFields)=>void;pending?:Promise<void>|undefined;close:()=>void;save:(value:MemoryFields)=>void|Promise<void>}){
  const allowed=useApplicationCapability('people')
  const {t}=useI18n();const collaborationScopes=useBusinessScopes(),[value,setValue]=useState<MemoryFields>(initial??{title:'',text:'',scope:scopes[0]!}),{title,text,scope}=value
  const change=(value:MemoryFields)=>{setValue(value);onDraft?.(value)}
  return <Dialog pending={pending} capability="people" title={t('team.memory.record')} close={close} submit={()=>{if(applicationPresentation.can('people'))return save({title,text,scope})}}><p>{t('team.memory.rolePath')}</p><label>{t('team.memory.record')}<input required maxLength={120} value={title} onChange={event=>change({...value,title:event.target.value})}/></label><label>{t('team.form.memory.candidateBody')}<textarea aria-label={t('team.form.memory.candidateBody')} required rows={6} maxLength={131072} value={text} onChange={event=>change({...value,text:event.target.value})}/></label>{!twin&&<label>{t('team.detail.businessScope')}<select value={scope} onChange={event=>change({...value,scope:event.target.value as CollaborationScope})}>{scopes.map(id=><option key={id} value={id}>{collaborationScopes[id]??id}</option>)}</select></label>}<footer className={css.buttons}><button type="button" onClick={close}>{t('team.form.cancel')}</button><button type="submit" disabled={!allowed||!title.trim()||!text.trim()}>{t(persistent?'team.memory.save':'team.memory.saveDemo')}</button></footer></Dialog>
}
