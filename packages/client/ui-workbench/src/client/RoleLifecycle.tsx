import {useApplicationCapability} from './CapabilityNotice.js'
import {applicationPresentation} from './application-presentation.js'
import {useState} from 'react'
import type {PreviewRole} from './role-preview.js'
import type {RoleAction,RoleLifecycleApi} from './role-lifecycle-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'
export type RoleLifecyclePort={pending:ReturnType<RoleLifecycleApi['pending']>;error:unknown;change:(role:PreviewRole,action:RoleAction,reason:string)=>Promise<void>;recover:()=>Promise<void>}
export function RoleLifecycleRecovery({api}:{api:RoleLifecyclePort}){
 const {locale,t}=useI18n()
 const [busy,setBusy]=useState(false),[error,setError]=useState<string>()
 return <>{!!api.error&&<p role="alert">{localizeWorkError(locale,api.error)}</p>}{api.pending&&<div className={css.block}><p>{t('roleLifecycle.pending',{id:api.pending.roleId,version:api.pending.expectedVersion})}</p><p>{api.pending.reason}</p><button type="button" disabled={busy} onClick={async()=>{setBusy(true);setError(undefined);try{await api.recover()}catch(e){setError(localizeWorkError(locale,e))}finally{setBusy(false)}}}>{t('roleLifecycle.recover')}</button>{error&&<p role="alert">{error}</p>}</div>}</>
}
export function RoleLifecycle({role,api}:{role:PreviewRole;api:RoleLifecyclePort}){
 const {locale,t}=useI18n()
 const allowed=useApplicationCapability('people')
 const [action,setAction]=useState<RoleAction>(),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string>()
 if(role.state==='retired')return <p className={css.muted}>{t('roleLifecycle.retired')}</p>
return <section className={css.block} aria-label={t('roleLifecycle.aria')}><p>{t('roleLifecycle.description')}</p><div className={css.buttons}><button disabled={busy||!!api.pending||!!api.error||role.state==='paused'&&!allowed} type="button" onClick={()=>{setAction(role.state==='paused'?'resume':'pause');setError(undefined)}}>{t(role.state==='paused'?'roleLifecycle.resume':'roleLifecycle.pause')}</button><button disabled={busy||!!api.pending||!!api.error} type="button" onClick={()=>{setAction('retire');setError(undefined)}}>{t('roleLifecycle.retire')}</button></div>{action&&<form className={css.form} onSubmit={async event=>{event.preventDefault();if(busy||action==='resume'&&!applicationPresentation.can('people'))return;setBusy(true);setError(undefined);try{await api.change(role,action,reason);setAction(undefined);setReason('')}catch(e){setError(localizeWorkError(locale,e))}finally{setBusy(false)}}}><label>{t('roleLifecycle.reason')}<textarea required maxLength={4000} disabled={busy||action==='resume'&&!allowed} value={reason} onChange={event=>setReason(event.target.value)}/></label>{action==='retire'&&<p>{t('roleLifecycle.retireWarning')}</p>}<div className={css.buttons}><button type="submit" disabled={busy||action==='resume'&&!allowed||!reason.trim()}>{t(busy?'p5.saving':action==='retire'?'roleLifecycle.confirmRetire':action==='pause'?'roleLifecycle.confirmPause':'roleLifecycle.confirmResume')}</button><button type="button" disabled={busy} onClick={()=>setAction(undefined)}>{t('p5.cancel')}</button></div>{error&&<p role="alert">{error}</p>}</form>}</section>
}
