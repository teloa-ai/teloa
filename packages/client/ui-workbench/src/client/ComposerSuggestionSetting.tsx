import {useSyncExternalStore} from 'react'
import {useI18n} from './i18n/provider.js'
import {readSuggestionEnabled,writeSuggestionEnabled,subscribeSuggestionEnabled} from './composer-suggestion.ts'

/**
 * 设置项：「显示下一条建议」。默认开；只影响灰字提示，不影响任何对话能力。
 * 文案走正式词条表（简/繁/英，其余语言回退英文）。
 */
export function ComposerSuggestionSetting(){
 const {t}=useI18n()
 const enabled=useSyncExternalStore(subscribeSuggestionEnabled,()=>readSuggestionEnabled(globalThis.localStorage),()=>true)
 return <section>
  <label style={{display:'flex',alignItems:'center',gap:8}}>
   <input type="checkbox" checked={enabled} onChange={event=>{const next=event.target.checked;writeSuggestionEnabled(globalThis.localStorage,next)}}/>
   <span>{t('composerSuggestion.title')}</span>
  </label>
  <p style={{margin:'4px 0 0',color:'var(--teloa-muted)',fontSize:'var(--teloa-font-caption)'}}>{t('composerSuggestion.detail')}</p>
 </section>
}
