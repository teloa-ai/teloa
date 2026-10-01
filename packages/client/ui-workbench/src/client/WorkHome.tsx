import {useState,useSyncExternalStore} from 'react'
import {ArrowRight,CalendarClock,CheckSquare,ChevronRight,FileText,MessageSquare} from 'lucide-react'
import type {UseSessions} from '@deepseek-ai/dsh-client-ui-session/client'
import type {Conversation} from '@teloa/contract'
import type {BindingClient} from './binding-client.js'
import type {ConversationManagement} from './conversation-management.js'
import {presentConversations,type PresentedConversation} from './work-presentation.js'
import css from './WorkHome.module.css'
import {attentionStatusText,planStatusText,type AttentionStatus,type PlanStatus} from './work-home-status.js'
import {taskStates,type PreviewTask} from './task-preview.js'
import {visibleTaskDirectory} from './example-directory-presentation.js'
import type {PreviewRole} from './role-preview.js'
import {useBusinessScopes} from './business-scope-context.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {homeRecentContext,homeTaskContext} from './home-recent-context.js'
import {homeColleagueWork} from './home-colleague-work.js'
import {personalProfile} from './personal-profile.js'
import type {ObjectConversationLink} from './object-conversations.js'

const workStatusKeys:Record<PresentedConversation['status'],'workDirectory.status.pending'|'workDirectory.status.running'|'workDirectory.status.blank'|'workDirectory.status.idle'|'workDirectory.status.unknown'>={
  pending:'workDirectory.status.pending',running:'workDirectory.status.running',blank:'workDirectory.status.blank',idle:'workDirectory.status.idle',unknown:'workDirectory.status.unknown',
}

export type HomeCreationKind='task'|'group'|'role'
type Props={current:string|undefined;visible:boolean;work:BindingClient;management:ConversationManagement;useSessions:UseSessions;workTasks:readonly PreviewTask[];colleagues:readonly Pick<PreviewRole,'id'|'name'|'scopes'>[];conversationLinks:readonly ObjectConversationLink[];open:()=>void;openTask:(id:string)=>void;openTasks:()=>void;plans:()=>void;attention:()=>void;attentionStatus:AttentionStatus;planStatus:PlanStatus}

export function WorkHome({current,visible,work,management,useSessions,workTasks,colleagues,conversationLinks,open,openTask,openTasks,plans,attention,attentionStatus,planStatus}:Props) {
  const {locale,t,dateTime}=useI18n()
  const directory=useSyncExternalStore(work.subscribe,work.getDirectorySnapshot)
  const native=useSessions(value=>value.byId)
  const managed=useSyncExternalStore(management.subscribe,management.getSnapshot)
  const scopeNames=useBusinessScopes()
  const profile=useSyncExternalStore(personalProfile.subscribe,personalProfile.getSnapshot,personalProfile.getSnapshot)
  const colleagueWork=homeColleagueWork(workTasks)
  const [conversationError,setConversationError]=useState<string>(),[opening,setOpening]=useState<string>()
  const attentionHeading=attentionStatusText(attentionStatus,t)
  const rows=managed.baseline?presentConversations(directory.rows,Object.values(native),'','all').filter(row=>row.status!=='blank'&&!managed.archived.includes(row.conversation.sessionId)):[]
  // 「继续工作」与原型同构：未结束的任务和会话同列按更新时间倒序，右上角「全部 N 项」进入任务目录。
  const savedTasks=visibleTaskDirectory(workTasks,'saved')
  const recent=[
    ...rows.map(item=>({kind:'conversation' as const,key:item.conversation.id,order:item.conversation.id,updatedAt:item.updatedAt,item})),
    ...savedTasks.filter(task=>task.state!=='completed'&&task.state!=='cancelled').map(task=>({kind:'task' as const,key:'task-'+task.id,order:task.id,updatedAt:Date.parse(task.updatedAt),task})),
  ].sort((left,right)=>right.updatedAt-left.updatedAt||left.order.localeCompare(right.order)).slice(0,5)
  const recentContext=(conversation:Conversation)=>{
    const context=homeRecentContext(conversation,conversationLinks,workTasks,colleagues,scopeNames,profile.displayName)
    return context?t('home.recent.context',context):t('home.recent.genericContext')
  }
  const taskContext=(task:PreviewTask)=>{
    const context=homeTaskContext(task,colleagues,scopeNames,profile.displayName)
    return context?t('home.recent.context',context):t('navigation.tasks')
  }
  const openWork=async(conversation:Conversation)=>{
    setConversationError(undefined);setOpening(conversation.id)
    try {await work.openConversation(conversation);if(work.getSnapshot().sessionId===conversation.sessionId)open()}
    catch(error){setConversationError(localizeWorkError(locale,error))}
    finally{setOpening(undefined)}
  }
  if(!visible)return null
  return <section className={css.page} aria-label={t('navigation.home')}>
    <div className={css.content}>
      {colleagueWork.count>0&&<p className={css.eyebrow}>{t('home.overview.colleaguesActiveDescription',{count:colleagueWork.count,people:colleagueWork.colleagueCount})}</p>}
      <section className={css.attentionStrip} aria-label={t('home.overview.attention')}>
        <strong>{attentionHeading}</strong>
        <button type="button" className={css.inlineLink} onClick={attention}>{t('home.handleTogether')}<ArrowRight size={15} aria-hidden="true"/></button>
      </section>
      <section className={css.recent} aria-label={t('home.continue')}>
        <header className={css.sectionHeading}><h2>{t('home.continue')}</h2><button type="button" className={css.inlineLink} onClick={openTasks}>{t('task.action.viewAll',{count:savedTasks.length})}<ArrowRight size={14}/></button></header>
        {Boolean(directory.error||conversationError)&&<div role="alert" className={css.error}><p>{conversationError??localizeWorkError(locale,directory.error)}</p>{Boolean(directory.error)&&<button type="button" className={css.textButton} onClick={()=>void work.refreshDirectory()}>{t('common.retry')}</button>}</div>}
        {!managed.baseline&&recent.length===0?<p role="status" className={css.empty}>{t('workDirectory.syncing')}</p>:(directory.status==='idle'||directory.status==='loading')&&directory.rows.length===0&&recent.length===0?<p role="status" className={css.empty}>{t('navigation.reading')}</p>:recent.length===0?<div className={css.empty}><MessageSquare size={25} aria-hidden="true"/><h3>{t(directory.status==='failed'?'home.recent.unavailableTitle':'home.emptyStart')}</h3><p>{t(directory.status==='failed'?'home.recent.unavailableDescription':'home.emptyDescription')}</p></div>:<ul className={css.rows}>{recent.map(row=>row.kind==='task'?<li key={row.key}><button type="button" className={css.row} aria-label={t('home.recent.open',{title:row.task.title})} onClick={()=>openTask(row.task.id)}><CheckSquare size={18} aria-hidden="true"/><div className={css.rowTitle}><strong>{row.task.title}</strong><span>{taskContext(row.task)}</span></div><span className={css.status}>{t(taskStates[row.task.state])}</span><time dateTime={new Date(row.updatedAt).toISOString()}>{dateTime(row.updatedAt,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</time><ChevronRight size={15} aria-hidden="true"/></button></li>:<li key={row.key}><button type="button" className={css.row} disabled={!managed.ready||opening!==undefined} aria-label={t('home.recent.open',{title:row.item.title})} aria-current={row.item.conversation.sessionId===current?'true':undefined} onClick={()=>void openWork(row.item.conversation)}><FileText size={18} aria-hidden="true"/><div className={css.rowTitle}><strong>{row.item.title}</strong><span>{recentContext(row.item.conversation)}{row.item.conversation.sessionId===current?` · ${t('home.recent.current')}`:''}</span></div><span className={css.status}>{opening===row.item.conversation.id?t('home.recent.opening'):t(workStatusKeys[row.item.status])}</span><time dateTime={new Date(row.updatedAt).toISOString()}>{dateTime(row.updatedAt,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</time><ChevronRight size={15} aria-hidden="true"/></button></li>)}</ul>}
      </section>
      <section className={css.backgroundNote} aria-label={t('continuous.v2.title')}>
        <CalendarClock size={17} aria-hidden="true"/>
        <p>{planStatusText({...planStatus,examplePlans:0,exampleRuns:0},t)}</p>
        <button type="button" className={css.inlineLink} onClick={plans}>{t('work.overview.managePlans')}<ArrowRight size={14} aria-hidden="true"/></button>
      </section>
    </div>
  </section>
}
