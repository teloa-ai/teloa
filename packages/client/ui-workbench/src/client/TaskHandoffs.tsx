import {useState} from 'react'
import type {TaskHandoffTarget} from '@teloa/contract'
import type {HandoffApi,HandoffRequest,TaskHandoff} from './handoff-api.js'
import type {PreviewTask} from './task-preview.js'
import {canReceiveTask,roleName,type PreviewRole} from './role-preview.js'
import {shouldShowHandoffForm} from './task-detail-presentation.js'
import {activeHandoffCandidates,activeHandoffState,canResolveHandoff} from './task-handoff-presentation.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'

export type HandoffPort={rows:TaskHandoff[];known:boolean;loading:boolean;error:string|undefined;pending:ReturnType<HandoffApi['pending']>;changePending:ReturnType<HandoffApi['pendingChange']>;changeError:unknown;load:()=>Promise<void>;resolve:(id:string,request:HandoffRequest)=>Promise<void>;recover:()=>Promise<void>;change:(taskId:string,expectedTaskVersion:number,target:TaskHandoffTarget,note:string)=>Promise<void>;recoverChange:()=>Promise<void>}

export function TaskHandoffs({api,tasks,roles,selected,select}:{api:HandoffPort;tasks:PreviewTask[];roles:PreviewRole[];selected:string|null;select:(id:string)=>void}){
 const {locale,t}=useI18n(),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[mode,setMode]=useState<'role'|'self'|null>(null)
 const run=async(operation:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError(undefined);try{await operation()}catch(e){setError(localizeWorkError(locale,e))}finally{setBusy(false)}}
 const rows=api.rows.filter(row=>row.status==='pending'&&(!selected||row.taskId===selected)),pending=api.pending?.taskId===selected?api.pending:undefined
 if(!selected&&!rows.length&&!api.pending&&!api.loading&&!api.error)return null
 if(selected){
  const row=rows[0],task=tasks.find(candidate=>candidate.id===selected)
  if(!row&&!pending&&!api.loading&&!api.error&&task&&api.known)return <ActiveHandoffControl api={api} task={task} roles={roles}/>
  if(!row&&!pending&&!api.loading&&!api.error)return null
  // 锚点给“需要你”卡里的“交由另一岗位”定位：跳到详情后要能直接落到交接段，而不是让人自己找。
  return <section className={css.handoffPanel} data-teloa-handoff-section aria-label={t('task.detail.handoffWork')}>
   {row?<><header><div><span className={css.sectionEyebrow}>{t('task.detail.arrangeSuccessor')}</span><h3>{t('task.detail.successorPlaceholder')}</h3></div><span className={css.badge}>{t('task.detail.handoffPending')}</span></header><p>{row.reason}</p><p className={css.muted}>{t('task.detail.handoffDescription')}</p></>:<header><div><span className={css.sectionEyebrow}>{t('task.detail.handoffWork')}</span><h3>{t(api.loading?'collaboration.state.loading':'error.storageUnavailable')}</h3></div></header>}
   {api.error&&<p role="alert">{api.error}</p>}{error&&<p role="alert">{error}</p>}
   {pending&&<div className={css.pendingAction}><p>{t('collaboration.pending.description')}</p><button type="button" disabled={busy} onClick={()=>void run(api.recover)}>{t('collaboration.action.recover')}</button></div>}
   {row&&task&&<div className={css.handoffChoices} aria-label={t('task.detail.handoffForm')}><button type="button" aria-pressed={mode==='role'} disabled={busy||!!pending||!!api.error} onClick={()=>setMode(value=>value==='role'?null:'role')}><strong>{t('task.detail.arrangeSuccessor')}</strong><span>{t('task.detail.successorPlaceholder')}</span></button><button type="button" aria-pressed={mode==='self'} disabled={busy||!!pending||!!api.error} onClick={()=>setMode(value=>value==='self'?null:'self')}><strong>{t('collaboration.message.selfRole')}</strong><span>{t('task.detail.handoffDescription')}</span></button></div>}
   {row&&task&&shouldShowHandoffForm(true,mode!==null)&&mode==='role'&&<HandoffForm key={row.id+':'+task.version} row={row} task={task} roles={roles} disabled={busy||!!pending||!!api.error} save={request=>api.resolve(task.id,request)}/>} 
   {row&&task&&shouldShowHandoffForm(true,mode!==null)&&mode==='self'&&<SelfTakeoverForm key={row.id+':self:'+task.version} row={row} task={task} disabled={busy||!!pending||!!api.error} save={request=>api.resolve(task.id,request)}/>} 
   {api.error&&<button className={css.quietAction} type="button" disabled={busy||api.loading} onClick={()=>void run(api.load)}>{t('common.retry')}</button>}
  </section>
 }
 return <section className={css.block} aria-label={t('task.detail.handoffWork')}><header><h3>{t('task.detail.handoffWork')} · {rows.length}</h3><button className={css.quietAction} type="button" disabled={busy||api.loading} onClick={()=>void run(api.load)}>{t(api.loading?'collaboration.state.loading':'collaboration.action.refresh')}</button></header>{api.error&&<p role="alert">{api.error}</p>}{error&&<p role="alert">{error}</p>}{api.pending&&<><p>{api.pending.request.note}</p><button type="button" disabled={busy} onClick={()=>void run(api.recover)}>{t('collaboration.action.recover')}</button></>}{rows.map(row=>{const task=tasks.find(value=>value.id===row.taskId);return <div className={css.handoffRow} key={row.id}><button type="button" onClick={()=>select(row.taskId)}>{task?.title??row.taskId} · {roleName(roles,row.fromRoleId,t)}</button><p>{row.reason}</p></div>})}{!api.loading&&!api.error&&!rows.length&&<p className={css.muted}>{t('task.detail.noSuccessor')}</p>}</section>
}

function ActiveHandoffControl({api,task,roles}:{api:HandoffPort;task:PreviewTask;roles:PreviewRole[]}){
 const {locale,t}=useI18n(),pending=api.changePending,activeState=activeHandoffState(task,{passivePending:false,recovering:!!pending||!!api.changeError})
 const [expanded,setExpanded]=useState(false),[targetId,setTargetId]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string>()
 const candidates=activeHandoffCandidates(task,roles),target=candidates.find(candidate=>candidate.id===targetId),candidateName=(candidate:typeof candidates[number])=>candidate.kind==='self'?t('taskHandoff.self'):candidate.name
 if(!activeState.visible)return null
 const operate=async(operation:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError(undefined);try{await operation();setExpanded(false)}catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false)}}
 // 锚点 `data-teloa-handoff-section` 全页只应有一个：决策卡的“交由另一岗位”靠 querySelector 找它。
 // 这一处（在岗负责人控件）与 :23 那一处（待处理交接段）由 activeState.visible 与交接单的有无
 // 互斥决定，两者不会同时渲染；新增第三处之前必须先确认这条互斥仍然成立。
 return <section className={css.assigneeControl} data-teloa-handoff-section aria-label={t('task.detail.handoffForm')}><header><div><span>{t('task.detail.currentOwnerLabel')}</span><strong>{roleName(roles,task.assigneeId,t)}</strong></div>{activeState.reason!=='recovery'&&<button type="button" aria-expanded={expanded} disabled={busy||activeState.disabled} onClick={()=>setExpanded(value=>!value)}>{t(expanded?'task.detail.collapseHandoff':'task.detail.expandHandoff')}</button>}</header>
  {activeState.reason==='recovery'&&pending&&<div className={css.pendingAction}><p>{t('collaboration.pending.description')}</p><button type="button" disabled={busy} onClick={()=>void operate(api.recoverChange)}>{t('collaboration.action.recover')}</button></div>}
  {!!api.changeError&&<p role="alert">{localizeWorkError(locale,api.changeError)}</p>}{error&&<p role="alert">{error}</p>}
  {expanded&&<form className={css.assigneeForm} aria-label={t('task.detail.handoffForm')} onSubmit={event=>{event.preventDefault();if(!target)return;const value:TaskHandoffTarget=target.kind==='self'?{kind:'self'}:{kind:'role',roleId:target.id,expectedRoleVersion:target.version};void operate(()=>api.change(task.id,task.version,value,note))}}><label>{t('task.detail.successorRole')}<select aria-label={t('task.detail.successorRole')} value={targetId} disabled={busy} onChange={event=>setTargetId(event.target.value)}><option value="">{t('task.detail.successorPlaceholder')}</option>{candidates.map(candidate=><option key={candidate.kind+':'+candidate.id} value={candidate.id}>{candidateName(candidate)}</option>)}</select></label><div className={css.assigneeReview}><span>{t('task.detail.currentOwnerLabel')}<strong>{roleName(roles,task.assigneeId,t)}</strong></span><span>{t('task.detail.successorRole')}<strong>{target?candidateName(target):t('task.detail.successorPlaceholder')}</strong></span></div><label>{t('task.detail.handoffNote')}<textarea required maxLength={4000} rows={3} disabled={busy} value={note} onChange={event=>setNote(event.target.value)}/></label><p className={css.muted}>{t('handoff.active.boundary')}</p><div className={css.assigneeActions}><button type="button" disabled={busy} onClick={()=>setExpanded(false)}>{t('collaboration.form.cancel')}</button><button type="submit" disabled={busy||!target||!note.trim()}>{t('task.detail.confirmHandoff')}</button></div></form>}
 </section>
}

function HandoffForm({row,task,roles,disabled,save}:{row:TaskHandoff;task:PreviewTask;roles:PreviewRole[];disabled:boolean;save:(request:HandoffRequest)=>Promise<void>}){
 const {locale,t}=useI18n(),[target,setTarget]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string>()
 const candidates=roles.filter(role=>role.storage==='persistent'&&role.id!==row.fromRoleId&&canReceiveTask(role,task.scope)),role=candidates.find(value=>value.id===target)
 if(!canResolveHandoff(task,row.fromRoleId))return <p>{t('task.detail.noSuccessor')}</p>
 return <form className={css.form} aria-label={t('task.detail.handoffForm')} onSubmit={async event=>{event.preventDefault();if(busy||disabled||!role)return;setBusy(true);setError(undefined);try{await save({handoffId:row.id,expectedTaskVersion:task.version,toRoleId:role.id,expectedRoleVersion:role.version,note})}catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false)}}}><label>{t('task.detail.successorRole')}<select value={target} disabled={busy||disabled} onChange={event=>setTarget(event.target.value)}><option value="">{t('task.detail.successorPlaceholder')}</option>{candidates.map(value=><option key={value.id} value={value.id}>{value.name}</option>)}</select></label><label>{t('task.detail.handoffNote')}<textarea required maxLength={4000} disabled={busy||disabled} value={note} onChange={event=>setNote(event.target.value)}/></label><button type="submit" disabled={busy||disabled||!role||!note.trim()}>{t('task.detail.confirmHandoff')}</button>{error&&<p role="alert">{error}</p>}<p className={css.muted}>{t('task.detail.handoffDescription')}</p></form>
}

function SelfTakeoverForm({row,task,disabled,save}:{row:TaskHandoff;task:PreviewTask;disabled:boolean;save:(request:HandoffRequest)=>Promise<void>}){
 const {locale,t}=useI18n(),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string>()
 if(!canResolveHandoff(task,row.fromRoleId))return <p>{t('task.detail.noSuccessor')}</p>
 return <form className={css.form} aria-label={t('task.detail.handoffForm')} onSubmit={async event=>{event.preventDefault();if(busy||disabled)return;setBusy(true);setError(undefined);try{await save({handoffId:row.id,expectedTaskVersion:task.version,target:{kind:'self'},note})}catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false)}}}><p>{t('handoff.active.boundary')}</p><label>{t('task.detail.handoffNote')}<textarea required maxLength={4000} disabled={busy||disabled} value={note} onChange={event=>setNote(event.target.value)}/></label><button type="submit" disabled={busy||disabled||!note.trim()}>{t('task.detail.confirmTakeOver')}</button>{error&&<p role="alert">{error}</p>}</form>
}
