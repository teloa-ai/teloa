import {resolveProductLocale} from './i18n/locale.ts'

const copy={
 'zh-CN':'该员工同适用主题的记忆重复或冲突。请在员工记忆中编辑或撤回相关条目后重试。',
 'zh-Hant':'這位員工同適用主題的記憶重複或衝突。請到員工記憶編輯或撤回相關條目後重試。',
 en:'This employee has duplicate or conflicting memories for the same applicable topic. In employee memory, edit or withdraw the affected entries, then try again.',
} as const

export function roleMemoryConflictCopy(locale:string):string{
 const language=resolveProductLocale(locale)
 return copy[language==='zh-CN'?'zh-CN':language.startsWith('zh-')?'zh-Hant':'en']
}
