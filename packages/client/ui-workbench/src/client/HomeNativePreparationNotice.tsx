import {ActionButton} from '@teloa/client-ui-kit'
import {homeNativeCopy} from './home-native-copy.js'
import type {ProductLocale} from './i18n/locale.js'
import css from './HomeNativeConversation.module.css'

/** 输入恢复错误属于工作台状态，不把内部请求校验说成用户填写错误。 */
export function HomeNativePreparationNotice({locale,error,retry,chooseLocation}:{locale:ProductLocale;error?:'restore'|'location'|undefined;retry:()=>void;chooseLocation:()=>void}){
 if(!error)return <p className={css.notice} role="status">{homeNativeCopy(locale,'preparing')}</p>
 const location=error==='location'
 return <section className={css.recoveryNotice} role="alert">
  <h2>{homeNativeCopy(locale,location?'locationTitle':'restoreFailed')}</h2>
  <p>{homeNativeCopy(locale,location?'locationHelp':'restoreHelp')}</p>
  <div className={css.recoveryActions}>
   <ActionButton className={css.recoveryPrimary} onClick={location?chooseLocation:retry}>{homeNativeCopy(locale,location?'locationTitle':'retry')}</ActionButton>
   {location&&<ActionButton onClick={retry}>{homeNativeCopy(locale,'retry')}</ActionButton>}
  </div>
 </section>
}
