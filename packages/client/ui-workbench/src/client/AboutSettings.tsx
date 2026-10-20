import {useSyncExternalStore} from 'react'
import {BrandLogo,type BrandTheme} from './BrandLogo.js'
import css from './AboutSettings.module.css'
import {useI18n} from './i18n/provider.js'
import {applicationPresentation,applicationProductName} from './application-presentation.js'
import {AboutContacts} from './AboutContacts.js'

// 展示三个版本的产品定位；当前版本只用行背景与读屏文本标记，不代表功能授权，不提供购买动作。
const PLAN_CARDS=[
  {id:'community',product:'Free',audience:'about.editions.community.audience',usage:'about.editions.community.usage'},
  {id:'pro',product:'Pro',audience:'about.editions.pro.audience',usage:'about.editions.pro.usage'},
  {id:'enterprise',product:'Enterprise',audience:'about.editions.enterprise.audience',usage:'about.editions.enterprise.usage'},
] as const

export function AboutSettings({theme}:{theme:BrandTheme}){
  const application=useSyncExternalStore(applicationPresentation.subscribe,applicationPresentation.getSnapshot,applicationPresentation.getSnapshot)
  const {locale,t}=useI18n()
  return <section className={css.about} aria-label={t('about.studio')}>
    <h2 className={css.pageTitle}>{t('settings.about')}</h2>
    <header className={css.brandHeader}><div className={css.identity}><div className={css.brandRow}><div className={css.brandName}><BrandLogo theme={theme} height={19}/></div></div><p>{t('about.studio')}</p></div><div className={css.release}><span>v{__TELOA_VERSION__}</span><span>{t('about.local')}</span></div><p className={css.headerTagline}>{t('about.tagline')}</p></header>
    <section className={css.plansSection} aria-label={t('about.plans.title')}>
      <div className={css.plansHeader}>
        <h2>{t('about.plans.title')}</h2>
      </div>
      <table className={css.editionsTable} aria-label={t('about.plans.title')}><thead><tr><th scope="col">{t('about.editions.version')}</th><th scope="col">{t('about.editions.audience')}</th><th scope="col">{t('about.editions.usage')}</th></tr></thead><tbody>
        {PLAN_CARDS.map(card=>{const current=card.product===application.product;return <tr key={card.id} className={current?css.editionCurrent:undefined} aria-current={current?'true':undefined}><th scope="row"><strong>{applicationProductName(card.product,locale)}</strong>{current&&<span className={css.srOnly}>{t('about.plans.current')}</span>}</th><td>{t(card.audience)}</td><td>{t(card.usage)}</td></tr>})}
      </tbody></table>
      <p className={css.plansMore}><a href="https://teloa.ai" target="_blank" rel="noreferrer">{t('about.plans.more')} teloa.ai</a></p>
    </section>
    <AboutContacts/>
  </section>
}
