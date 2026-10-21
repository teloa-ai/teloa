import type {ReactNode} from 'react'
import type {GroupMessage,GroupRoutingDecisionView,GroupRoutingStatusView} from '@teloa/contract'
import {ExternalLink} from 'lucide-react'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {DetailsMenu} from './DetailsMenu.js'
import {groupMessageStatusPresentation,groupProgressPresentation,type GroupProgressPerson} from './group-progress-presentation.js'
import {groupRoutingFollowupIsIdle} from './group-routing-view.js'
import css from './CollaborationPage.module.css'

/**
 * 本人消息与员工交接消息下的真实处理状态（规格 §5，N46 轻量化）。只呈现服务端投影：阶段、需要关注的接收者与闭集提示码；
 * 进行中的阶段改由输入框附近的 GroupProgressStatus 聚合，已完成只留原工作入口，不再逐人铺完成清单。
 * 「重新安排」只在服务端判定可重试且群未归档时出现，未知提交只给「查看工作」。忽略这一行不会触发恢复、重发或停止。
 */
export function GroupMessageStatus({status,message,decision,archived,retrying,retryFailed,retry,openTask,resume}:{status:GroupRoutingStatusView;message?:GroupMessage|undefined;decision?:GroupRoutingDecisionView|undefined;archived:boolean;retrying:boolean;retryFailed:boolean;retry:()=>void;openTask?:((taskId:string)=>void)|undefined;resume?:((controlId:string)=>void)|undefined}){
 const {locale,t}=useI18n()
 if(!retrying&&!retryFailed&&groupRoutingFollowupIsIdle(message,decision,status))return <p className={`${css.messageStatus} ${css.messageStatusQuiet}`} role="status" data-tone="quiet">{t('group.status.followup.noCandidate')}</p>
 const view=groupMessageStatusPresentation(status,archived)
 const name=(value:string)=>value||t('collaboration.message.historicalMember')
 // 原工作入口按原 taskId 打开；多位员工各有工作时图标带上归属的员工名。
 const workIcon=(taskId:string,owner?:string)=>{const label=owner===undefined?t('group.status.openWork'):t('group.status.openWorkOf',{name:name(owner)});return <button key={taskId} type="button" className={css.statusIconButton} aria-label={label} title={label} onClick={()=>openTask?.(taskId)}><ExternalLink size={14} aria-hidden/></button>}
 const tasks=openTask?view.tasks:[]
 // 续办被原任务暂停挡住：唯一的下一步是就地打开整项恢复确认（抽屉），点击本身不恢复。
 const resumable=view.hintCode==='continue-paused'&&status.controlId&&resume&&!archived?status.controlId:null
 const detailed=view.phase!==null||view.hintCode!==null||view.recipients.length>0||view.canRetry||retryFailed||retrying
 if(!detailed){
  // 回帖本身就是结果：只留紧凑的查看工作图标，不播报、不写「已完成」。
  if(!tasks.length)return null
  return <div className={css.messageStatus} data-phase={status.phase} data-tone={view.tone}>{tasks.length===1?workIcon(tasks[0]!.taskId):<DetailsMenu className={css.statusWorkMenu} resetKey={`${status.messageId}:${status.attemptVersion}`} closeOnSelect>
   <summary aria-label={t('group.status.openWorks',{count:tasks.length})} title={t('group.status.openWorks',{count:tasks.length})}><ExternalLink size={14} aria-hidden/><span>{tasks.length}</span></summary>
   <div role="menu" aria-label={t('group.status.openWorks',{count:tasks.length})}>{tasks.map(item=><button key={item.taskId} type="button" role="menuitem" aria-label={t('group.status.openWorkOf',{name:name(item.name)})} onClick={()=>openTask?.(item.taskId)}>{name(item.name)}<ExternalLink size={13} aria-hidden/></button>)}</div>
  </DetailsMenu>}</div>
 }
 return <div className={css.messageStatus} role="status" aria-label={t('group.status.label')} data-phase={status.phase} data-tone={view.tone}>
  {view.phase&&<span className={view.tone==='attention'?css.messageStatusPhase:css.messageStatusQuiet}>{t(`group.status.phase.${view.phase}`)}</span>}
  {view.recipients.length>0&&<ul className={css.messageStatusRecipients}>{view.recipients.map(item=><li key={item.roleId}>{t('group.status.recipient',{name:name(item.name),phase:t(`group.status.phase.${item.phase}`)})}{item.taskId&&openTask&&workIcon(item.taskId,item.name)}</li>)}</ul>}
  {/* 路由被工作额度拒绝：复用任务工作额度的同一句说明（原因、范围与「工作额度」入口），不另立群文案。 */}
  {view.hintCode&&<p className={css.messageStatusHint}>{view.hintCode==='budget-exhausted'?localizeWorkError(locale,{code:'teloa/budget-exhausted',details:status.budget??{}}):t(`group.status.hint.${view.hintCode}`)}</p>}
  {retryFailed&&<p className={css.messageStatusHint} role="alert">{t('group.status.retryFailed')}</p>}
  {(view.canRetry||tasks.length>0||resumable)&&<div className={css.messageActions}>
   {resumable&&<button type="button" className={css.replyButton} onClick={()=>resume?.(resumable)}>{t('group.resume.action')}</button>}
   {view.canRetry&&<button type="button" className={css.replyButton} disabled={retrying} onClick={retry}>{t(retrying?'group.status.retrying':'group.status.retry')}</button>}
   {tasks.length===1?workIcon(tasks[0]!.taskId):tasks.map(item=>workIcon(item.taskId,item.name))}
  </div>}
 </div>
}

/**
 * 当前会话输入框附近的一行聚合进行中状态（参照 Grok 群聊的员工头像 + 弱化动态状态）。
 * 只由已取回的 GroupRoutingStatusView 驱动：页面按既有重读节奏刷新投影，这里没有计时器、不重试也不发消息。
 * live region 常驻挂载、内容按需出现；同一文案的重读不改动 DOM，不会反复朗读。动态点仅为装饰且尊重减少动态效果。
 */
export function GroupProgressStatus({statuses,avatar,className}:{statuses:readonly GroupRoutingStatusView[];avatar:(person:GroupProgressPerson)=>ReactNode;className?:string|undefined}){
 const {t}=useI18n()
 const view=groupProgressPresentation(statuses)
 const names=view?.people.map(item=>item.name||t('collaboration.message.historicalMember'))??[]
 const who=names.length===2?t('group.progress.people.two',{first:names[0]!,second:names[1]!}):names[0]
 // 收到、安排与排队是宿主内部过程：不显示过程文案，只留头像与动态点；读屏如实读作「已收到，等待回应」，不称正在输入。
 const waiting=view?.bucket==='routing'
 const phase=view&&!waiting?(view.bucket==='stopping'?t('group.status.phase.stopping'):view.mode==='reply'?t(view.bucket==='delivering'?'group.progress.sending':'group.progress.replying'):view.mode==='work'?t(`group.status.phase.${view.bucket}`):''):''
 return <div className={className?`${css.progress} ${className}`:css.progress} role="status" aria-live="polite" data-bucket={view?.bucket}>
  {view&&<>
   {view.people.length>0&&<span className={css.progressAvatars} aria-hidden="true">{view.people.map(item=><span key={item.roleId}>{avatar(item)}</span>)}</span>}
   {who&&<span className={css.progressPeople}>{who}{view.more>0&&<span className={css.progressMore}>{` +${view.more}`}</span>}</span>}
   {who&&phase&&<span className={css.progressSeparator} aria-hidden="true">·</span>}
   {phase?<span className={css.progressPhase}>{phase}</span>:<span className={css.progressSrOnly}>{t(waiting?'group.progress.waiting':'group.progress.active')}</span>}
   <span className={css.progressDots} aria-hidden="true"><i/><i/><i/></span>
  </>}
 </div>
}
