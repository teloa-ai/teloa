import {useEffect,useRef,useState,useSyncExternalStore} from 'react'
import {CalendarClock,Clock,ChevronRight} from 'lucide-react'
import type {ToolCallViewProps} from '@deepseek-ai/dsh-client-ui-tool/client'
import {readSavedPlan,type PlanApi} from './plan-api.js'
import {plansForConversation,conversationTurnPlanIds,type ConversationPlanEvents,type ConversationPlanDirectory} from './conversation-plans.js'
import {triggerLabel} from './continuous-preview.js'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {PlanScheduleSummary} from './plan-schedule-summary.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ConversationPlanCard.module.css'

export function ConversationPlanClock({sessionId,directory}:{sessionId:string;directory:ConversationPlanDirectory}){
 const snapshot=useSyncExternalStore(directory.subscribe,directory.getSnapshot),{t,locale}=useI18n(),zh=locale.startsWith('zh'),hant=locale.startsWith('zh-TW')||locale.startsWith('zh-HK')||locale.startsWith('zh-Hant'),[open,setOpen]=useState(false),anchor=useRef<HTMLDivElement>(null)
 const plans=snapshot.status==='ready'?plansForConversation(snapshot.plans,sessionId):[]
 useEffect(()=>{if(!open)return;const dismiss=(event:PointerEvent)=>{if(!anchor.current?.contains(event.target as Node))setOpen(false)};document.addEventListener('pointerdown',dismiss);return()=>document.removeEventListener('pointerdown',dismiss)},[open])
 if(!plans.length)return null
 const title=plans.map(plan=>`${plan.title} · ${triggerLabel(plan.trigger,t)} · ${t(plan.state==='active'?'status.enabled':'status.paused')}`).join('\n')
 return <div ref={anchor} className={css.clockAnchor} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setOpen(false);anchor.current?.querySelector('button')?.focus()}}}>
  <button type="button" className={css.clock} data-active={plans.some(plan=>plan.state==='active')} title={title} aria-label={zh?`${hant?'查看定時計劃':'查看定时计划'}（${plans.length}）`:`View scheduled plans (${plans.length})`} {...(plans.length>1?{'aria-expanded':open,'aria-haspopup':'dialog' as const}:{})} onClick={event=>{event.stopPropagation();if(plans.length===1)directory.open(plans[0]!.id);else setOpen(value=>!value)}}><Clock size={14} aria-hidden/>{plans.length>1&&<small>{plans.length}</small>}</button>
  {open&&plans.length>1&&<div className={css.planMenu} role="dialog" aria-label={zh?(hant?'會話定時計劃':'会话定时计划'):'Conversation schedules'}>{plans.map(plan=><button type="button" key={plan.id} onClick={()=>{setOpen(false);directory.open(plan.id)}}><strong>{plan.title}</strong><small>{triggerLabel(plan.trigger,t)} · {t(plan.state==='active'?'status.enabled':'status.paused')}</small></button>)}</div>}
 </div>
}

export function ConversationPlanCard({block,phase,inspect,directory,api,roleName}:{directory:ConversationPlanDirectory;api:PlanApi;roleName:(id:string)=>Promise<string>} & ToolCallViewProps){
 const {locale}=useI18n(),zh=locale.startsWith('zh'),snapshot=useSyncExternalStore(directory.subscribe,directory.getSnapshot)
 let planId:string|undefined
 if(phase==='result'&&!block.isError)try{const value:unknown=JSON.parse(block.content.filter(item=>item.type==='text').map(item=>item.text).join('\n'));if(value&&typeof value==='object'&&'plan' in value)planId=readSavedPlan(value.plan).id}catch{/* 不能核对的回执保留原始工具详情。 */}
 useEffect(()=>{if(planId)void directory.refresh().catch(()=>{})},[planId,directory])
 if(phase!=='result')return <p role="status">{zh?'正在保存定时计划…':'Saving scheduled plan…'}</p>
 if(!planId)return <div className={css.card}><p>{zh?(block.isError?'定时计划操作未完成。':'无法核对定时计划回执。'):'Unable to verify the scheduled plan.'}</p>{inspect&&<button type="button" onClick={inspect}>{zh?'查看详情':'Details'}</button>}</div>
 const plan=snapshot.plans.find(row=>row.id===planId)
 return plan?<SavedConversationPlanCard key={plan.id} plan={plan} directory={directory} api={api} roleName={roleName}/>:<section className={css.card}><p role="status">{zh?'正在读取定时计划…':'Loading scheduled plan…'}</p>{snapshot.status==='failed'&&<button type="button" onClick={()=>void directory.refresh().catch(()=>{})}>{zh?'重新读取':'Retry'}</button>}</section>
}

export function SavedConversationPlanCard({plan,directory,api,roleName}:{plan:ReturnType<typeof readSavedPlan>;directory:ConversationPlanDirectory;api:PlanApi;roleName:(id:string)=>Promise<string>}){
 const {locale,t,dateTime}=useI18n(),zh=locale.startsWith('zh'),hant=locale.startsWith('zh-TW')||locale.startsWith('zh-HK')||locale.startsWith('zh-Hant'),[name,setName]=useState(''),[schedule,setSchedule]=useState<PlanScheduleSummary>(),[error,setError]=useState('')
 const copy=(cn:string,tw:string,en:string)=>zh?(hant?tw:cn):en
 useEffect(()=>{let live=true;setName('');if(plan.roleId===null)return()=>{live=false};void roleName(plan.roleId).then(value=>{if(live)setName(value)},()=>{});return()=>{live=false}},[plan.roleId,roleName])
 useEffect(()=>{let live=true;setSchedule(undefined);setError('');const load=()=>{void api.schedule(plan.id).then(value=>{if(live){setSchedule(value);setError('')}},cause=>{if(live){setSchedule(undefined);setError(localizeWorkError(locale,cause))}})};load();const timer=plan.state==='active'?setInterval(()=>{if(!document.hidden)load()},10000):undefined;return()=>{live=false;clearInterval(timer)}},[api,plan.id,plan.version,plan.state,locale])
 const responsible=plan.executor?t('continuous.ownerAgent'):name
 const state=t(plan.state==='active'?'status.enabled':plan.state==='archived'?'status.archived':'status.paused'),next=schedule?.available?schedule.overview?.nextAt:null
 return <section className={css.card} aria-label={copy('定时任务卡片','定時任務卡片','Scheduled task')} data-plan-id={plan.id}>
  <button type="button" className={css.open} onClick={()=>directory.open(plan.id)} aria-label={copy('打开计划：','開啟計劃：','Open schedule: ')+plan.title}>
   <span className={css.emblem}><CalendarClock size={19} aria-hidden/></span>
   <span className={css.heading}><strong>{plan.title}</strong><small>{triggerLabel(plan.trigger,t)}</small></span>
   <span className={css.state} data-active={plan.state==='active'}>{state}</span><ChevronRight size={16} aria-hidden/>
  </button>
  <footer><span>{responsible}{responsible&&' · '}{plan.state!=='active'?(plan.state==='paused'?copy('暂停中','暫停中','Paused'):copy('已归档','已封存','Archived')):next?copy('下次：','下次：','Next: ')+dateTime(next,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):copy('下次运行待核对','下次執行待核對','Next run unavailable')}</span><small>{copy('独立任务','獨立任務','Independent runs')}</small></footer>
  {error&&<small className={css.error} role="alert">{error}<button type="button" onClick={()=>directory.open(plan.id)}>{copy('查看计划','查看計劃','View schedule')}</button></small>}
 </section>
}

export function ConversationPlanTurnCards({turn,directory,api,roleName,events}:PropsRuntime<'conversation.chat.turnTail'>&{directory:ConversationPlanDirectory;api:PlanApi;roleName:(id:string)=>Promise<string>;events:{subscribe:(listener:()=>void)=>()=>void;getSnapshot:()=>ConversationPlanEvents}}){
 const history=useSyncExternalStore(events.subscribe,events.getSnapshot),ids=turn.status==='closed'?conversationTurnPlanIds(history.entries,turn.turn):[],snapshot=useSyncExternalStore(directory.subscribe,directory.getSnapshot)
 useEffect(()=>{if(ids.length)void directory.refresh().catch(()=>{})},[directory,ids.join(',')])
 return <>{ids.map(id=>{const plan=snapshot.plans.find(row=>row.id===id);return plan?<SavedConversationPlanCard key={id} plan={plan} directory={directory} api={api} roleName={roleName}/>:null})}</>
}
