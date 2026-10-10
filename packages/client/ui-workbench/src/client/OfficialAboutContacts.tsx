import {useState,type ReactNode} from 'react'
import {Globe,Mail,MessageSquare} from 'lucide-react'
import css from './AboutSettings.module.css'
import {useI18n} from './i18n/provider.js'
import {TeloaFeedbackForm} from './TeloaFeedback.js'
import {TeloaFeedbackModel} from './TeloaFeedbackClient.js'

// 商业版只使用官方联系；社区构建可以在同一布局中追加社区入口。
export function OfficialAboutContacts({identity,links,actions,children}:{identity?:ReactNode;links?:ReactNode;actions?:ReactNode;children?:ReactNode}){
 const {t}=useI18n()
 const [feedbackOpen,setFeedbackOpen]=useState(false)
 const [feedbackModel]=useState(()=>new TeloaFeedbackModel(undefined,__TELOA_VERSION__))
 return <section className={css.connectionSummary} aria-label={t('about.connections')}>
  {identity}
  <div className={css.contactRow}>
   <div className={css.contactLinks}><a href="https://teloa.ai" target="_blank" rel="noreferrer"><Globe size={14} aria-hidden/>teloa.ai</a>{links}</div>
   {actions}
  </div>
  <div className={css.contactEmails}>
   <div className={css.contactCard}>
    <h3 className={css.contactCardTitle}><MessageSquare size={16} aria-hidden/>{t('about.contactSupport')}</h3>
    <div className={css.contactCardActions}>
     <a href="mailto:support@teloa.ai">support@teloa.ai</a>
     <button type="button" className={css.feedbackButton} onClick={()=>setFeedbackOpen(true)} aria-haspopup="dialog">{t('feedback.open')}</button>
    </div>
   </div>
   <div className={css.contactCard}>
    <h3 className={css.contactCardTitle}><Mail size={16} aria-hidden/>{t('about.contactBusiness')}</h3>
    <div className={css.contactCardActions}><a href="mailto:hi@teloa.ai">hi@teloa.ai</a></div>
   </div>
  </div>
  <p className={css.foundationLine}>{t('about.foundationDescription')}</p>
  {children}
  {feedbackOpen&&<TeloaFeedbackForm model={feedbackModel} onClose={()=>setFeedbackOpen(false)}/>}
 </section>
}
