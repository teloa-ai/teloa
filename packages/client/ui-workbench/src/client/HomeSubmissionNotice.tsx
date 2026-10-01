import {useEffect,useState,useSyncExternalStore} from 'react'
import type {HomeSubmissionMonitor} from './home-native-submission.js'
import {homeNativeCopy} from './home-native-copy.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './HomeNativeConversation.module.css'

export function HomeSubmissionNotice({monitor}:{monitor:HomeSubmissionMonitor}){
 const {locale}=useI18n(),unknown=useSyncExternalStore(monitor.subscribe,monitor.getSnapshot)
 const [checking,setChecking]=useState(false),[error,setError]=useState<string>()
 useEffect(()=>monitor.attach(),[monitor])
 if(!unknown)return null
 return <div className={css.context} role="alert"><p>{homeNativeCopy(locale,'unknown')} <button type="button" disabled={checking} onClick={()=>{setChecking(true);setError(undefined);void monitor.check().catch(cause=>setError(localizeWorkError(locale,cause))).finally(()=>setChecking(false))}}>{homeNativeCopy(locale,'inspect')}</button></p>{error&&<p>{error}</p>}</div>
}
