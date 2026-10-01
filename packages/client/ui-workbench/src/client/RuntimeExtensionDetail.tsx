import {Package} from 'lucide-react'
import type {RuntimeExtension} from './runtime-extensions.js'
import {useI18n} from './i18n/provider.js'
import type {MessageKey} from './i18n/messages.js'
import css from './TeamCapabilitiesPage.module.css'
import base from './TaskPage.module.css'

export const RUNTIME_EXTENSION_STATE_KEYS:Record<RuntimeExtension['runtime'],MessageKey>={active:'extension.running',failed:'extension.failed',loading:'extension.loading',inactive:'extension.inactive',unverified:'extension.unverified'}
export type RuntimeText=NonNullable<NonNullable<RuntimeExtension['meta']>['title']>
export function RuntimeExtensionDetail({item,resolveText,manage}:{item:RuntimeExtension;resolveText:(text:RuntimeText)=>string;manage:()=>void}){
 const {t}=useI18n()
 return <>
  <div className={css.extensionIdentity}><Package size={24} aria-hidden="true"/><div><h2>{item.meta?.title?resolveText(item.meta.title):item.name}</h2><small>{item.name}{item.version?' · '+item.version:''}</small></div></div>
  {(item.meta?.description||item.description)&&<p>{item.meta?.description?resolveText(item.meta.description):item.description}</p>}
  <dl><dt>{t('extension.field.installation')}</dt><dd>{t(item.installed?'extension.installed':'extension.bundled')}</dd><dt>{t('extension.field.enabled')}</dt><dd>{t(item.enabled?'extension.enabled':'extension.disabled')}</dd><dt>{t('extension.field.runtime')}</dt><dd>{t(RUNTIME_EXTENSION_STATE_KEYS[item.runtime])}</dd></dl>
  {item.error?.diagnostic&&<p role="alert">{item.error.diagnostic}</p>}
  <div className={base.buttons}><button type="button" onClick={manage}>{t('extension.runtime.manage')}</button></div>
  <p className={css.registeredNotice}>{t('extension.runtime.boundary')}</p>
  <details className={css.technical}><summary>{t('extension.field.components')} · {item.rows.length}</summary><ul className={css.extensionComponents}>{item.rows.map(row=><li key={row.rowId}><strong>{row.meta?.title?resolveText(row.meta.title):row.rowId}</strong><small>{row.moduleName}</small><span>{t(row.fiberPhase==='active'?'extension.running':row.fiberPhase==='failed'?'extension.failed':row.fiberPhase==='loading'||row.fiberPhase==='unloading'?'extension.loading':row.enabled===false?'extension.inactive':'extension.unverified')}</span></li>)}</ul></details>
 </>
}
