import {Settings2,PackageCheck} from 'lucide-react'
import {useI18n} from './i18n/provider.js'
import css from './CapabilityCenterHeader.module.css'

/** 浏览与管理共用入口；安装和授权仍由各自真实管理流程处理。 */
export function CapabilityCenterHeader({mode,onMine,onDiscover,onInstallations,onSettings}:{mode:'mine'|'discover';onMine:()=>void;onDiscover:()=>void;onInstallations:()=>void;onSettings:()=>void}){
 const {t}=useI18n()
 return <header className={css.header}>
  <div className={css.heading}><div><h1>{t('capabilityCenter.title')}</h1><p>{t('capabilityCenter.description')}</p></div><div className={css.actions}><button type="button" onClick={onInstallations}><PackageCheck size={16}/>{t('capabilityCenter.installations')}</button><button type="button" onClick={onSettings}><Settings2 size={16}/>{t('capabilityCenter.settings')}</button></div></div>
  <div className={css.modes} role="group" aria-label={t('capabilityCenter.mode')}><button type="button" aria-pressed={mode==='mine'} onClick={onMine}>{t('capabilityCenter.mine')}</button><button type="button" aria-pressed={mode==='discover'} onClick={onDiscover}>{t('capabilityCenter.discover')}</button></div>
 </header>
}
