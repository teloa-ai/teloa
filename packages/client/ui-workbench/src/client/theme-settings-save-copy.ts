import {resolveProductLocale} from './i18n/locale.js'

const en={unknown:'We cannot confirm whether the change was saved. Check the current value before trying again.',saving:'Saving…'}
const zh:typeof en={unknown:'暂时无法确认是否已保存，请核对当前值后再试。',saving:'正在保存…'}
const hant:typeof en={unknown:'暫時無法確認是否已儲存，請核對目前的設定值後再試。',saving:'正在儲存…'}
export function themeSettingsSaveCopy(locale:string){
 const active=resolveProductLocale(locale)
 return active==='zh-CN'?zh:active==='zh-Hant'||active==='zh-TW'||active==='zh-HK'?hant:en
}
