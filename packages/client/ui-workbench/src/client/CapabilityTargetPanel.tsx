import {useI18n} from './i18n/provider.js'
import css from './MarketPage.module.css'

/**
 * 岗位、群和业务页只呈现正式能力使用关系的事实边界。持久化绑定服务尚未接入时，
 * 这里只能给出明确空态与市场入口，不能读取 CapabilityBindings 的页面内演示状态。
 */
export function CapabilityTargetPanel({market}:{market:()=>void}){
 const {t}=useI18n()
 return <section className={css.bindingSummary} aria-label={t('capability.targetPanel.aria')}>
  <h3>{t('capability.targetPanel.title')}</h3>
  <p>{t('capability.targetPanel.description')}</p>
  <p>{t('capability.targetPanel.empty')}</p>
  <button type="button" onClick={market}>{t('capability.market.select')}</button>
 </section>
}
