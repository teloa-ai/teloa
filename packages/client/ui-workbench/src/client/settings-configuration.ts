import type {ProductLocale} from './i18n/locale.js'

/** 文档站提供中英文；其他界面语言使用英文指引。 */
export function configurationGuideUrl(locale:ProductLocale):string{
  const prefix=locale==='zh-CN'||locale==='zh-Hant'?'':'/en'
  return `https://docs.teloa.ai${prefix}/guides/settings`
}
