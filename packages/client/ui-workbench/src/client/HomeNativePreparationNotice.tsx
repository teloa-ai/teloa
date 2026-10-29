import {useEffect,useState} from 'react'
import {ActionButton} from '@teloa/client-ui-kit'
import {homeNativeCopy} from './home-native-copy.js'
import type {ProductLocale} from './i18n/locale.js'
import css from './HomeNativeConversation.module.css'

/** 输入恢复错误属于工作台状态，不把内部请求校验说成用户填写错误。 */
export function HomeNativePreparationNotice({locale,error,retry,reload,ready,chooseLocation,resetKey=0,preparationTimeoutMs=12000}:{locale:ProductLocale;error?:'restore'|'location'|'slow'|undefined;retry:()=>void;reload:()=>void;ready:boolean;chooseLocation:()=>void;resetKey?:number;preparationTimeoutMs?:number}){
 // 首页准备可能被上游状态反复重排而一直不进入 ready；由提示本身兜底到点给出可恢复动作，避免永久“正在准备”。
 const [timedOut,setTimedOut]=useState(false)
 useEffect(()=>{setTimedOut(false);if(error)return;const timer=setTimeout(()=>setTimedOut(true),preparationTimeoutMs);return()=>clearTimeout(timer)},[error,resetKey,preparationTimeoutMs])
 const shown=error??(timedOut?'slow':undefined)
 if(!shown)return <p className={css.notice} role="status">{homeNativeCopy(locale,'preparing')}</p>
 const location=shown==='location',slow=shown==='slow'
 return <section className={css.recoveryNotice} role={slow?'status':'alert'}>
  <h2>{homeNativeCopy(locale,location?'locationTitle':slow?'restoreSlow':'restoreFailed')}</h2>
  <p>{homeNativeCopy(locale,location?'locationHelp':slow?'restoreSlowHelp':ready?'restoreHelp':'reloadHelp')}</p>
  <div className={css.recoveryActions}>
   {location?<><ActionButton className={css.recoveryPrimary} onClick={chooseLocation}>{homeNativeCopy(locale,'locationTitle')}</ActionButton><ActionButton onClick={retry}>{homeNativeCopy(locale,'retry')}</ActionButton></>:<><ActionButton className={css.recoveryPrimary} onClick={ready?retry:reload}>{homeNativeCopy(locale,ready?'retry':'reload')}</ActionButton>{ready&&<ActionButton onClick={reload}>{homeNativeCopy(locale,'reload')}</ActionButton>}</>}
  </div>
 </section>
}
