import type { OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
import { BrandLogo,type BrandTheme } from './BrandLogo.js'
import css from './ConversationBrand.module.css'
export function ConversationBrand({size,theme}:OwnerOf<'conversation.hero.brand.mark'>&{theme:BrandTheme}){
  return <span className={css.mark}><BrandLogo theme={theme} height={size}/></span>
}
