import assistantAvatar from '../brand/companion/icon.webp'
import {useI18n} from './i18n/provider.js'
import {conversationHeaderCopy} from './conversation-header-copy.js'
import css from './ConversationWelcome.module.css'

export function ConversationWelcome(){
  const {locale}=useI18n()
  return <span className={css.welcome}><img src={assistantAvatar} alt=""/><span role="heading" aria-level={1} className={css.headline}>{conversationHeaderCopy(locale,'greeting')}</span><span className={css.subtitle}>{conversationHeaderCopy(locale,'welcome')}</span></span>
}
