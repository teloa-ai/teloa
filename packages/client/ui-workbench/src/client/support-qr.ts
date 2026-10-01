import type {ProductLocale} from './i18n/locale.js'

export type SupportQrKind='wechat'|'paypal'

export function isMainlandChineseProductLocale(locale:ProductLocale):boolean{
  return locale==='zh-CN'
}

/** 只在简体中文大陆界面显示微信收款码；其他地区统一显示 PayPal。 */
export function supportQrKind(locale:ProductLocale):SupportQrKind{
  return isMainlandChineseProductLocale(locale)?'wechat':'paypal'
}
