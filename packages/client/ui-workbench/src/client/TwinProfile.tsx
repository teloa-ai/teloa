import {Fingerprint, LockKeyhole} from 'lucide-react'
import {Fragment, useId, useRef, useState, type KeyboardEvent, type ReactNode} from 'react'
import clsx from 'clsx'
import {TwinDraftEditor, type TwinDraftInput} from './TwinDraftEditor.js'
import type {PreviewRole, TeamChange} from './role-preview.js'
import {twinDisplayName} from './team-presentation.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import teamCss from './TeamPage.module.css'
import css from './TwinProfile.module.css'

const TWIN_TABS=['draft','samples','habits','boundary'] as const
type TwinTab=typeof TWIN_TABS[number]
// 页签标题：「判断力样本」复用既有 team.detail.tab.judgment；「Auto Dream · 习惯观察」读 habitLog.title。不再新开同义词条。
const TAB_TITLES={draft:'team.twin.tab.draft',samples:'team.detail.tab.judgment',habits:'habitLog.title',boundary:'team.twin.tab.boundary'} as const

/**
 * 分身个人主页照原型 原型.jsx:459-462 的 twinView 重做：人类头像 + 「{本人} 的分身」+「代拟阶段」，
 * 四页签「代拟工作 / 判断力样本 / Auto Dream · 习惯观察 / 授权边界」。
 *
 * 四个页签的正文一次全渲染、非当前页签用 `hidden` 收起：既保住读屏与静态渲染的可核对性，
 * 也省掉一份只为切页签而存在的挂载/卸载逻辑。
 *
 * 代拟稿的写入路径一字不改——仍然是既有的 `TwinDraftEditor`（`role.draft` / `input.draft` / `update` / `save`），
 * 这里只把它包进原型的「代拟 · 未发送」卡片形态里。`samples`/`habits` 与 `conversations` 由 `RoleDetail` 传入现成节点，
 * 记忆列表、习惯观察日志与关联会话都不在这里重写一遍。`habits` 不传时该页签按钮 `disabled`，
 * `TWIN_TABS` 仍固定四项——不按是否传入做条件分支，避免键盘环绕的下标错位。
 */
export function TwinProfile({profileName,role,draft,update,save,talk,talkDisabledReason,conversations,samples,habits}:{
  profileName:string
  role:PreviewRole
  draft:TwinDraftInput|undefined
  update:(draft:TwinDraftInput|undefined)=>void
  save:(command:TeamChange)=>boolean
  talk?:()=>Promise<void>
  talkDisabledReason?:string
  conversations:ReactNode
  samples:ReactNode
  /** 由 RoleDetail 传入的 <RoleDailyLogPanel kind='habit-digest' …/>；不传时该页签不渲染内容且按钮 disabled。 */
  habits?:ReactNode
}){
  const {locale,t}=useI18n()
  const [tab,setTab]=useState<TwinTab>('draft')
  const [chatError,setChatError]=useState('')
  const tabId=useId()
  const tabButtons=useRef<Partial<Record<TwinTab,HTMLButtonElement|null>>>({})
  const twinName=twinDisplayName(profileName,t)
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
  // 授权边界五条照原型的 dl 逐条走词条；两条带本人/分身名字的用参数插值，不在词条里写死示例名。
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
        <span className={clsx(teamCss.avatar,teamCss.human,css.avatar)}>{profileName.slice(0,1)}<Fingerprint size={12}/></span>
        <div className={css.identityText}>
          <h1>{twinName}<span className={css.stage}>{t('team.twin.stage')}</span></h1>
          <p>{t('team.twin.subtitle',{name:profileName})}</p>
        </div>
      </div>
      <nav className={css.tabs} role="tablist" aria-label={t('team.twin.tabsAria')}>
        {TWIN_TABS.map(item=><button key={item} ref={node=>{tabButtons.current[item]=node}} id={`${tabId}-tab-${item}`} type="button" role="tab" aria-selected={tab===item} aria-controls={`${tabId}-panel-${item}`} tabIndex={tab===item?0:-1} disabled={!tabEnabled(item)} onKeyDown={event=>moveTab(event,item)} onClick={()=>setTab(item)}>{t(TAB_TITLES[item])}</button>)}
      </nav>
    </header>

    <section id={`${tabId}-panel-draft`} className={css.panel} role="tabpanel" aria-labelledby={`${tabId}-tab-draft`} tabIndex={0} hidden={tab!=='draft'}>
      <article className={css.message}>
        <span className={clsx(teamCss.avatar,teamCss.human,css.messageAvatar)} aria-hidden="true">{profileName.slice(0,1)}<Fingerprint size={10}/></span>
        <div className={css.messageBody}>
        <header>
          <strong>{twinName}</strong>
          <small>{t('team.twin.stage')}</small>
        </header>
        <p>{t('team.twin.chat.lead')}</p>
        <div className={css.draftCard}>
          <span className={css.draftBadge}>{t('team.twin.draft.badge')}</span>
          <h3>{t('team.twin.draft.title')}</h3>
          <p>{role.draft?.body??t('team.twin.draft.empty')}</p>
          <details className={css.draftEditor}>
            <summary>{t('team.twin.draft.edit')}</summary>
            <TwinDraftEditor role={role} input={draft} update={update} save={save}/>
          </details>
        </div>
        </div>
      </article>
      <p className={css.note}>{t('team.twin.chat.note')}</p>
      {chatError&&<p role="alert">{chatError}</p>}
      {talkDisabledReason&&<p id={`${tabId}-talk-note`} className={css.note}>{talkDisabledReason}</p>}
      <button type="button" className={css.chatToggle} disabled={!talk} title={talkDisabledReason} aria-describedby={talkDisabledReason?`${tabId}-talk-note`:undefined} onClick={()=>{if(!talk)return;setChatError('');void talk().catch(error=>setChatError(localizeWorkError(locale,error)))}}>{t('team.profile.action.chat')}</button>
      {conversations&&<details className={css.chatPanel}><summary>{t('objectConversations.aria')}</summary>{conversations}</details>}
    </section>

    <section id={`${tabId}-panel-samples`} className={css.panel} role="tabpanel" aria-labelledby={`${tabId}-tab-samples`} tabIndex={0} hidden={tab!=='samples'}>{samples}</section>

    <section id={`${tabId}-panel-habits`} className={css.panel} role="tabpanel" aria-labelledby={`${tabId}-tab-habits`} tabIndex={0} hidden={tab!=='habits'}>
      <p className={css.note}>{t('habitLog.hint')}</p>
      <p className={css.note}>{t('habitLog.private')}</p>
      {habits}
    </section>

    <section id={`${tabId}-panel-boundary`} className={css.panel} role="tabpanel" aria-labelledby={`${tabId}-tab-boundary`} tabIndex={0} hidden={tab!=='boundary'}>
      <h2>{t('team.twin.boundary.title')}</h2>
      <dl className={teamCss.facts}>{boundary.map(([term,description,params])=><Fragment key={term}><dt>{t(term)}</dt><dd>{params?t(description,params):t(description)}</dd></Fragment>)}</dl>
      <p className={css.note}>{t('roleGrant.web.twinNote')}</p>
      <p className={css.callout}><LockKeyhole size={18}/>{t('team.twin.boundary.callout')}</p>
    </section>
  </div>
}
