import {useState,useSyncExternalStore,type ReactNode} from 'react'
import {applicationPresentation,type WorkCapability,type ApplicationCapabilities} from './application-presentation.js'
import {useI18n} from './i18n/provider.js'
import css from './CapabilityNotice.module.css'

export function useApplicationCapability(capability:WorkCapability){
 return useSyncExternalStore(applicationPresentation.subscribe,applicationPresentation.getCapabilitySnapshot,applicationPresentation.getCapabilitySnapshot).capabilities[capability]
}

export function CapabilityNotice({capability,reason:override}:{capability:WorkCapability;reason?:ApplicationCapabilities['reason']}){
 const {t}=useI18n(),snapshot=useSyncExternalStore(applicationPresentation.subscribe,applicationPresentation.getCapabilitySnapshot,applicationPresentation.getCapabilitySnapshot)
 const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false)
 if(snapshot.capabilities[capability]&&!override)return null
 const reason=override??snapshot.reason??'unavailable',subscription=reason==='subscription-required'||reason==='subscription-expired'
 return <aside className={css.notice} aria-label={t('application.capability.aria')}><div role="status"><p>{t('application.capability.'+reason)}</p>{snapshot.capabilities['general-agent']&&<p>{t('application.capability.basic')}</p>}</div><button type="button" disabled={busy||reason==='checking'} onClick={async()=>{setBusy(true);setFailed(false);try{if(subscription)await applicationPresentation.openSubscription();else await applicationPresentation.openAccount()}catch{setFailed(true)}finally{setBusy(false)}}}>{t(subscription?'application.capability.subscription':'application.capability.account')}</button>{failed&&<p role="alert">{t('application.capability.openFailed')}</p>}</aside>
}

// 只包围需要写入的字段；取消、历史、停止及拒绝动作保留在边界外。
export function CapabilityFields({capability,children}:{capability:WorkCapability;children:ReactNode}){
 const allowed=useApplicationCapability(capability)
 return <fieldset className={css.fields} disabled={!allowed}>{children}</fieldset>
}
