import {useSyncExternalStore} from 'react'
import {Check} from 'lucide-react'
import {BrandLogo,type BrandTheme} from './BrandLogo.js'
import css from './AboutSettings.module.css'
import {useI18n} from './i18n/provider.js'
import {applicationPresentation,applicationProductName} from './application-presentation.js'
import {AboutContacts} from './AboutContacts.js'

// 展示三个版本的产品定位；当前身份标记不代表功能授权，不提供购买动作。
const PLAN_CARDS=[
  {id:'community',product:'Free',position:'about.plans.card.community.position',tagline:'about.plans.card.community.tagline',items:['about.plans.card.community.item1','about.plans.card.community.item2','about.plans.card.community.item3','about.plans.card.community.item4']},
  {id:'pro',product:'Pro',position:'about.plans.card.pro.position',tagline:'about.plans.card.pro.tagline',items:['about.plans.card.pro.item1','about.plans.card.pro.item2','about.plans.card.pro.item3','about.plans.card.pro.item4','about.plans.card.pro.item5','about.plans.card.pro.item6']},
  {id:'enterprise',product:'Enterprise',position:'about.plans.card.enterprise.position',tagline:'about.plans.card.enterprise.tagline',items:['about.plans.card.enterprise.item1','about.plans.card.enterprise.item2','about.plans.card.enterprise.item3','about.plans.card.enterprise.item4','about.plans.card.enterprise.item5','about.plans.card.enterprise.item6']},
] as const

export function AboutSettings({theme}:{theme:BrandTheme}){
  const application=useSyncExternalStore(applicationPresentation.subscribe,applicationPresentation.getSnapshot,applicationPresentation.getSnapshot)
  const {locale,t}=useI18n()
  return <section className={css.about} aria-label={t('about.studio')}>
    <header className={css.brandHeader}><div className={css.identity}><div className={css.brandRow}><div className={css.brandName}><BrandLogo theme={theme} height={19}/></div></div><p>{t('about.studio')}</p></div><div className={css.release}><span>v{__TELOA_VERSION__}</span><span>{t('about.local')}</span></div><p className={css.headerTagline}>{t('about.tagline')}</p></header>
    <section className={css.plansSection} aria-label={t('about.plans.title')}>
      <div className={css.plansHeader}>
        <h2>{t('about.plans.title')}</h2>
      </div>
      <div className={css.plansGrid}>
        {PLAN_CARDS.map(card=><article key={card.id} className={card.product===application.product?`${css.planCard} ${css.planCardCurrent}`:css.planCard}>
          <span className={css.planBadge}>{t(card.product===application.product?'about.plans.current':card.position)}</span>
          <strong className={css.planName}>{applicationProductName(card.product,locale)}</strong>
          {'tagline' in card&&<p className={css.planTagline}>{t(card.tagline)}</p>}
          <ul>{card.items.map(item=><li key={item}><Check size={14} aria-hidden/>{t(item)}</li>)}</ul>
        </article>)}
      </div>
      <p className={css.plansNote}>{t('about.plans.relation')} <span className={css.plansMore}>{t('about.plans.more')}<a href="https://teloa.ai" target="_blank" rel="noreferrer">teloa.ai</a></span></p>
    </section>
    <AboutContacts/>
  </section>
}
