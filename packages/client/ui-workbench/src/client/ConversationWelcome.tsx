import {EmployeeAvatar} from './EmployeeAvatar.js'
import {useI18n} from './i18n/provider.js'
import {conversationHeaderCopy} from './conversation-header-copy.js'
import css from './ConversationWelcome.module.css'

export function ConversationWelcome(){
  const {locale}=useI18n()
  return <span className={css.welcome}><EmployeeAvatar assistant size="lg"/><span role="heading" aria-level={1} className={css.headline}>{conversationHeaderCopy(locale,'greeting')}</span><span className={css.subtitle}>{conversationHeaderCopy(locale,'welcome')}</span></span>
}
