import {BookOpen} from 'lucide-react'
import {configurationGuideUrl} from './settings-configuration.js'
import css from './SettingsConfigurationGuide.module.css'
import {useI18n} from './i18n/provider.js'

export function SettingsConfigurationGuide(){
  const {locale,t}=useI18n()
  return <div className={css.help}>
    <a href={configurationGuideUrl(locale)} target="_blank" rel="noopener noreferrer"><BookOpen size={16} aria-hidden/>{t('settings.configurationHelp')}</a>
  </div>
}
