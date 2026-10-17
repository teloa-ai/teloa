import type {ProductLocale} from './i18n/locale.js'

/** 交接恢复必须说明当前操作，不能复用群创建或消息发送的说明。 */
export function handoffRecoveryDescription(locale:ProductLocale):string{
 if(locale==='zh-CN')return '上次交接的结果尚未确认。核对原请求后再调整负责人。'
 if(locale==='zh-Hant'||locale==='zh-TW'||locale==='zh-HK')return '上次交接的結果尚未確認。核對原請求後再調整負責人。'
 return 'The previous handoff has not been confirmed. Check that request before changing the owner.'
}
