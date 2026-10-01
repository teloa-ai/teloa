import {useI18n} from './i18n/provider.js'
import css from './BusinessConfigurationSurface.module.css'

/** 只展示真实流程状态；正文与附件由唯一原生输入组件持有。 */
export function BusinessDailyStatus({busy,pending,error,disabled=false,recover,retry}:{busy:boolean;pending:{title:string}|null;error?:string|undefined;disabled?:boolean;recover:()=>void;retry:()=>void}){
 const {t}=useI18n()
 if(!busy&&!pending&&!error)return null
 return <section className={css.dailyStatus} aria-label={t('business.daily.status')}>
  {busy&&<p role="status">{t('business.daily.loading')}</p>}
  {pending&&<div><p>{t('business.daily.pending',{title:pending.title})}</p><button type="button" disabled={busy||disabled} onClick={recover}>{t('business.daily.recover')}</button></div>}
  {error&&<p role="alert">{error} <button type="button" disabled={busy||disabled} onClick={retry}>{t('common.retry')}</button></p>}
 </section>
}
