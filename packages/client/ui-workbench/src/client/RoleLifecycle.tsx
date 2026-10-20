import {useApplicationCapability} from './CapabilityNotice.js'
import {applicationPresentation} from './application-presentation.js'
import {useEffect,useState} from 'react'
import type {PreviewRole} from './role-preview.js'
import type {RoleAction,RoleLifecycleApi} from './role-lifecycle-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {DangerConfirm,type DangerImpact} from './DangerConfirm.js'
import {ListTodo,MessageSquareOff,Users} from 'lucide-react'
import css from './TaskPage.module.css'
export type RoleLifecyclePort={pending:ReturnType<RoleLifecycleApi['pending']>;error:unknown;change:(role:PreviewRole,action:RoleAction,reason:string)=>Promise<void>;recover:()=>Promise<void>}
export type RoleLifecycleDraft={action:RoleAction;reason:string}
export function RoleLifecycleRecovery({api}:{api:RoleLifecyclePort}){
 const {locale,t}=useI18n()
 const [busy,setBusy]=useState(false),[error,setError]=useState<string>()
 return <>{!!api.error&&<p role="alert">{localizeWorkError(locale,api.error)}</p>}{api.pending&&<div className={css.block}><p>{t('roleLifecycle.pending',{id:api.pending.roleId,version:api.pending.expectedVersion})}</p><p>{api.pending.reason}</p><button type="button" disabled={busy} onClick={async()=>{setBusy(true);setError(undefined);try{await api.recover()}catch(e){setError(localizeWorkError(locale,e))}finally{setBusy(false)}}}>{t('roleLifecycle.recover')}</button>{error&&<p role="alert">{error}</p>}</div>}</>
}
/** 退役影响（L3）：未完成任务数取当前任务列表；所在协作群数读到才写数字，未读到写「所在的协作群」。 */
export type RoleRetireImpact={tasks:number;groups?:number|undefined}
export function RoleLifecycle({role,api,draft,onDraft,pending,impact}:{role:PreviewRole;api:RoleLifecyclePort;draft?:RoleLifecycleDraft|undefined;onDraft?:(draft:RoleLifecycleDraft)=>void;pending?:Promise<void>|undefined;impact?:RoleRetireImpact|undefined}){
 const {locale,t}=useI18n()
 const allowed=useApplicationCapability('people')
 const [action,setAction]=useState<RoleAction|undefined>(draft?.action),[reason,setReason]=useState(draft?.reason??''),[busy,setBusy]=useState(!!pending),[error,setError]=useState<string>()
 const choose=(action:RoleAction)=>{setAction(action);setError(undefined);onDraft?.({action,reason})}
 useEffect(()=>{if(!pending)return;let active=true;void pending.then(()=>{if(active){setAction(undefined);setReason('');setBusy(false)}},error=>{if(active){setError(localizeWorkError(locale,error));setBusy(false)}});return()=>{active=false}},[pending,locale])
 if(role.kind==='twin')return <p className={css.muted}>{t('roleDelegation.configureHint')}</p>
 if(role.state==='retired')return <p className={css.muted}>{t('roleLifecycle.retired')}</p>
 const submit=async()=>{if(busy||action==='resume'&&!applicationPresentation.can('people'))return;setBusy(true);setError(undefined);try{await api.change(role,action!,reason);setAction(undefined);setReason('')}catch(e){setError(localizeWorkError(locale,e))}finally{setBusy(false)}}
 const reasonField=<label>{t('roleLifecycle.reason')}<textarea aria-label={t('roleLifecycle.reason')} required maxLength={4000} disabled={busy||action==='resume'&&!allowed} value={reason} onChange={event=>{setReason(event.target.value);onDraft?.({action:action!,reason:event.target.value})}}/></label>
 // 退役不可恢复且牵涉任务交接与协作群（L3）：列出真实影响，输入员工名称后红色终按钮才可用；暂停 / 恢复可逆，仍是行内表单。
 const retireImpacts:DangerImpact[]=[
  {icon:ListTodo,text:impact&&impact.tasks>0?t('roleLifecycle.retireTasks',{count:impact.tasks}):t('roleLifecycle.retireNoTasks')},
  ...(impact?.groups===0?[]:[{icon:Users,text:impact?.groups!==undefined?t('roleLifecycle.retireGroups',{count:impact.groups}):t('roleLifecycle.retireGroupsUnknown')}]),
  {icon:MessageSquareOff,text:t('roleLifecycle.retireKeeps')},
 ]
 return <section className={css.block} aria-label={t('roleLifecycle.aria')}><p>{t('roleLifecycle.description')}</p><div className={css.buttons}><button disabled={busy||!!api.pending||!!api.error||role.state==='paused'&&!allowed} type="button" onClick={()=>choose(role.state==='paused'?'resume':'pause')}>{t(role.state==='paused'?'roleLifecycle.resume':'roleLifecycle.pause')}</button><button disabled={busy||!!api.pending||!!api.error} type="button" onClick={()=>choose('retire')}>{t('roleLifecycle.retire')}</button></div>{action==='retire'?<DangerConfirm title={t('roleLifecycle.retireTitle',{name:role.name})} intro={t('roleLifecycle.retireIntro')} impacts={retireImpacts} note={t('roleLifecycle.retireWarning')} confirmName={role.name} confirmLabel={t(busy?'p5.saving':'roleLifecycle.confirmRetire')} busy={busy} ready={!!reason.trim()} error={error} confirm={()=>void submit()} close={()=>{setAction(undefined);setError(undefined)}}>{reasonField}</DangerConfirm>
  :action&&<form className={css.form} onSubmit={event=>{event.preventDefault();void submit()}}>{reasonField}<div className={css.buttons}><button type="submit" disabled={busy||action==='resume'&&!allowed||!reason.trim()}>{t(busy?'p5.saving':action==='pause'?'roleLifecycle.confirmPause':'roleLifecycle.confirmResume')}</button><button type="button" disabled={busy} onClick={()=>setAction(undefined)}>{t('p5.cancel')}</button></div>{error&&<p role="alert">{error}</p>}</form>}</section>
}
