import {useEffect,useState,useSyncExternalStore} from 'react'
import type {HomeSubmissionMonitor} from './home-native-submission.js'
import {homeNativeCopy} from './home-native-copy.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import dock from './ComposerDock.module.css'

/** 提交结果未知或网络中断时，先说明发送失败与草稿保留；网络恢复后仍提供原生核对入口。 */
export function HomeSubmissionNotice({monitor}:{monitor:HomeSubmissionMonitor}){
 const {locale}=useI18n(),unknown=useSyncExternalStore(monitor.subscribe,monitor.getSnapshot)
 const [checking,setChecking]=useState(false),[error,setError]=useState<string>()
 const [online,setOnline]=useState(()=>typeof navigator==='undefined'?true:navigator.onLine)
 useEffect(()=>monitor.attach(),[monitor])
 useEffect(()=>{
  if(typeof window==='undefined')return
  const update=()=>setOnline(navigator.onLine)
  window.addEventListener('online',update);window.addEventListener('offline',update);update()
  return ()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update)}
 },[])
 const offline=!online
 if(!unknown&&!offline)return null
 const check=()=>{setChecking(true);setError(undefined);void monitor.check().catch(cause=>setError(localizeWorkError(locale,cause))).finally(()=>setChecking(false))}
 return <div className={`${dock.strip} ${dock.warn}`} role="alert">
  {offline&&<p>{homeNativeCopy(locale,'offlineSend')} <button type="button" disabled={checking} onClick={check}>{homeNativeCopy(locale,'retry')}</button></p>}
  {unknown&&!offline&&<p>{homeNativeCopy(locale,'unknown')} <button type="button" disabled={checking} onClick={check}>{homeNativeCopy(locale,'inspect')}</button></p>}
  {unknown&&offline&&<p>{homeNativeCopy(locale,'unknown')}</p>}
  {error&&<p>{error}</p>}
 </div>
}
