import {useI18n} from './i18n/provider.js'
import css from './SettingsBrand.module.css'
export function SettingsBrand(_props:{theme:unknown}){
  const {t}=useI18n()
  return <span className={css.header}>{t('shell.settings')}</span>
}
