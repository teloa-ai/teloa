import {resolveProductLocale} from './i18n/locale.ts'

const copy={
 'zh-CN':{empty:'请输入显示名称。',email:'显示名称不能使用邮箱，请填写姓名或昵称。',tooLong:'显示名称最多 40 个字符，请缩短后再保存。'},
 'zh-Hant':{empty:'請輸入顯示名稱。',email:'顯示名稱不能使用電子郵件地址，請填寫姓名或暱稱。',tooLong:'顯示名稱最多 40 個字元，請縮短後再儲存。'},
 en:{empty:'Enter a display name.',email:'Use a name or nickname instead of an email address.',tooLong:'Use a display name of 40 characters or fewer.'},
} as const

export function personalProfileValidationCopy(locale:string){
 const language=resolveProductLocale(locale)
 return copy[language==='zh-CN'?'zh-CN':language.startsWith('zh-')?'zh-Hant':'en']
}
