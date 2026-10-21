import {LockKeyhole, MessageCircle, Phone} from 'lucide-react'
import {Fragment, useId, useRef, useState, type KeyboardEvent, type ReactNode} from 'react'
import {TwinDraftEditor, type TwinDraftInput} from './TwinDraftEditor.js'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import type {PreviewRole, TeamChange} from './role-preview.js'
import type {RoleDelegationMessageKey} from './i18n/locales/role-delegation.js'
import {twinDisplayName} from './team-presentation.js'
import {personalAvatarInitials,personalDisplayName} from './personal-profile.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {twinDraftCopy} from './i18n/locales/twin-drafts.js'
import teamCss from './TeamPage.module.css'
import {TwinAvatar} from './TwinAvatar.js'
import {employeeCopy} from './employee-copy.js'
import css from './TwinProfile.module.css'

const TWIN_TABS=['draft','samples','habits','boundary'] as const
type TwinTab=typeof TWIN_TABS[number]
// 页签标题：「判断力样本」复用既有 team.detail.tab.judgment；1.0 页签只写「习惯观察」，面板内仍由 habitLog 词条说明 Auto Dream 来源。
const TAB_TITLES={draft:'team.twin.tab.draft',samples:'team.detail.tab.judgment',habits:'team.twin.tab.habits',boundary:'team.twin.tab.boundary'} as const
const SHORT_STAGE:Partial<Record<RoleDelegationMessageKey,RoleDelegationMessageKey>>={
 'roleDelegation.status.draft':'roleDelegation.overview.stageDraft','roleDelegation.status.active':'roleDelegation.overview.stageActive',
 'roleDelegation.status.awaitingConsent':'roleDelegation.overview.stagePending','roleDelegation.status.paused':'roleDelegation.overview.stagePaused',
 'roleDelegation.status.ended':'roleDelegation.overview.stageEnded','roleDelegation.status.stale':'roleDelegation.overview.stageReview',
}

/** 分身沿用代拟、样本、习惯与授权路径；切页保留正文和草稿，联系动作复用平台图标。 */
export function TwinProfile({profileName,profileInitials=personalAvatarInitials(profileName),role,draft,update,save,talk,phone,talkDisabledReason,conversations,samples,sampleCount,habits,delegation,executionStatus,assign,draftWorkspace,draftCount}:{
  profileName:string
  profileInitials?:string
  role:PreviewRole
  draft:TwinDraftInput|undefined
  update:(draft:TwinDraftInput|undefined)=>void
  save:(command:TeamChange)=>boolean
  talk?:()=>Promise<void>
  phone?:()=>Promise<void>
  talkDisabledReason?:string
  conversations:ReactNode
  samples:ReactNode
  /** 已读取的判断力样本条数；未读完时不传，页签不显示计数。 */
  sampleCount?:number
  /** 由 RoleDetail 传入的 <RoleDailyLogPanel kind='habit-digest' …/>；不传时该页签不渲染内容且按钮 disabled。 */
  habits?:ReactNode
  /** 可信委托服务的现有授权管理节点；不改变代拟、样本与习惯观察路径。 */
  delegation?:ReactNode
  executionStatus?:RoleDelegationMessageKey
  assign?:()=>void
  draftWorkspace?:ReactNode
  draftCount?:number|undefined
}){
  const {locale,t}=useI18n()
  profileName=personalDisplayName(profileName,t('profile.account'))
  const [tab,setTab]=useState<TwinTab>('draft')
  const [chatError,setChatError]=useState('')
  const tabId=useId()
  const tabButtons=useRef<Partial<Record<TwinTab,HTMLButtonElement|null>>>({})
  const twinName=twinDisplayName(profileName,t)
  // 真实分身计数由持久目录提供，旧本地演示仍只取已有那一稿。
  const tabCount:Partial<Record<TwinTab,number>>={...(draftCount===undefined?(role.storage!=='persistent'?{draft:role.draft?1:0}:{}):{draft:draftCount}),...(sampleCount!==undefined?{samples:sampleCount}:{})}
  // habits 未传时该页签按钮 disabled：键盘环绕要跳过它，否则会「选中」一个点不了的页签。
  const tabEnabled=(item:TwinTab)=>!(item==='habits'&&!habits)
  const step=(from:number,delta:number):TwinTab=>{
    let index=from
    for(let guard=0;guard<TWIN_TABS.length;guard++){
      index=(index+delta+TWIN_TABS.length)%TWIN_TABS.length
      if(tabEnabled(TWIN_TABS[index]!))return TWIN_TABS[index]!
    }
    return TWIN_TABS[from]!
  }
  const moveTab=(event:KeyboardEvent<HTMLButtonElement>,current:TwinTab)=>{
    const index=TWIN_TABS.indexOf(current)
    const next=event.key==='Home'?step(-1,1):event.key==='End'?step(TWIN_TABS.length,-1):event.key==='ArrowLeft'?step(index,-1):event.key==='ArrowRight'?step(index,1):undefined
    if(!next)return
    event.preventDefault();setTab(next);tabButtons.current[next]?.focus()
  }
  // 未接委托时保留五条边界；接入后由委托组件说明执行范围，其余本人/分身边界仍保留。
  const boundary=[
    ['team.twin.boundary.canTerm','team.twin.boundary.canDesc',undefined],
    ['team.twin.boundary.approvalTerm','team.twin.boundary.approvalDesc',{name:profileName}],
    ['team.twin.boundary.identityTerm','team.twin.boundary.identityDesc',{name:twinName}],
    ['team.twin.boundary.memoryTerm','team.twin.boundary.memoryDesc',undefined],
    ['team.twin.boundary.delegationTerm','team.twin.boundary.delegationDesc',undefined],
  ] as const
  return <div className={css.twin}>
    <header className={css.head}>
      <div className={css.identity}>
        <TwinAvatar initials={profileInitials}/>
        <div className={css.identityText}>
          <h1>{twinName}<span className={css.stage} title={executionStatus?t(executionStatus):undefined}>{t(executionStatus?(SHORT_STAGE[executionStatus]??executionStatus):'team.twin.stage')}</span></h1>
          <p>{t('team.twin.subtitle',{name:profileName})}</p>
        </div>
        <ToolbarIconButton label={t('team.profile.action.chat')} icon={MessageCircle} disabled={!talk} aria-describedby={talkDisabledReason?`${tabId}-talk-note`:undefined} onClick={()=>{if(!talk)return;setChatError('');void talk().catch(error=>setChatError(localizeWorkError(locale,error)))}}/>
        {phone&&<ToolbarIconButton label={employeeCopy(locale,'call')} icon={Phone} onClick={()=>{setChatError('');void phone().catch(error=>setChatError(localizeWorkError(locale,error)))}}/>}
      </div>
      {chatError&&<p role="alert" className={css.note}>{chatError}</p>}
      {talkDisabledReason&&<p id={`${tabId}-talk-note`} className={css.note}>{talkDisabledReason}</p>}
      <nav className={css.tabs} role="tablist" aria-label={t('team.twin.tabsAria')}>
        {TWIN_TABS.map(item=><button key={item} ref={node=>{tabButtons.current[item]=node}} id={`${tabId}-tab-${item}`} type="button" role="tab" aria-selected={tab===item} aria-controls={`${tabId}-panel-${item}`} tabIndex={tab===item?0:-1} disabled={!tabEnabled(item)} data-count={tabCount[item]?tabCount[item]:undefined} onKeyDown={event=>moveTab(event,item)} onClick={()=>setTab(item)}>{t(TAB_TITLES[item])}</button>)}
      </nav>
    </header>

    <section id={`${tabId}-panel-draft`} className={css.panel} role="tabpanel" aria-labelledby={`${tabId}-tab-draft`} tabIndex={0} hidden={tab!=='draft'}>
      {draftWorkspace??(role.storage==='persistent'?<p role="status" className={css.note}>{twinDraftCopy(locale,'serviceUnready')}</p>:<>
      <article className={css.draftCard}>
        <header className={css.draftHeading}>
          <h3>{t('team.twin.draft.title')}</h3>
          <span className={css.draftBadge}>{t('team.twin.draft.badge')}</span>
        </header>
          <p className={role.draft?css.draftBody:undefined}>{role.draft?.body??t('team.twin.draft.empty')}</p>
          <details className={css.draftEditor}>
            <summary>{t('team.twin.draft.edit')}</summary>
            <TwinDraftEditor role={role} input={draft} update={update} save={save}/>
          </details>
      </article>
      </>)}
      <p className={css.note}>{t('team.twin.chat.note')}</p>
      {conversations&&<div className={css.chatPanel}>{conversations}</div>}
    </section>

    <section id={`${tabId}-panel-samples`} className={css.panel} role="tabpanel" aria-labelledby={`${tabId}-tab-samples`} tabIndex={0} hidden={tab!=='samples'}>{samples}</section>

    <section id={`${tabId}-panel-habits`} className={css.panel} role="tabpanel" aria-labelledby={`${tabId}-tab-habits`} tabIndex={0} hidden={tab!=='habits'}>
      <p className={css.note}>{t('habitLog.hint')}</p>
      <p className={css.note}>{t('habitLog.private')}</p>
      {habits}
    </section>

    <section id={`${tabId}-panel-boundary`} className={css.panel} role="tabpanel" aria-labelledby={`${tabId}-tab-boundary`} tabIndex={0} hidden={tab!=='boundary'}>
      {!delegation&&<h2>{t('team.twin.boundary.title')}</h2>}
      {delegation}
      {assign&&<button type="button" onClick={assign}>{t('roleDelegation.taskCreate')}</button>}
      {!delegation&&<dl className={teamCss.facts}>{boundary.map(([term,description,params])=><Fragment key={term}><dt>{t(term)}</dt><dd>{params?t(description,params):t(description)}</dd></Fragment>)}</dl>}
      {!delegation&&<p className={css.note}>{t('roleGrant.web.twinNote')}</p>}
      {!delegation&&<p className={css.callout}><LockKeyhole size={18}/>{t('team.twin.boundary.callout')}</p>}
    </section>
  </div>
}
