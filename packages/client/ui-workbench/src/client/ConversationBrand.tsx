import type { OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {BrandTheme} from './BrandLogo.js'
import css from './ConversationBrand.module.css'
import {ConversationWelcome} from './ConversationWelcome.js'
export function ConversationBrand(_owner:OwnerOf<'conversation.hero.brand.mark'>&{theme:BrandTheme}){
  return <span className={css.mark} data-teloa-welcome><ConversationWelcome/></span>
}
