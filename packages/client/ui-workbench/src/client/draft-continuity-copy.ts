import type {ProductLocale} from './i18n/locale.js'
const copy={
 saved:['有 {count} 份保存的附件待确认','有 {count} 份已儲存附件待確認','{count} saved attachments to review'],
 add:['添加到当前草稿','加入目前草稿','Add to current draft'],
 remove:['移除','移除','Remove'],
 download:['保存原文件','儲存原檔案','Save original file'],
 reviewHelp:['确认添加只加入当前草稿，不会发送。','確認加入只會加入目前草稿，不會傳送。','Adding only places the file in this draft. It does not send it.'],
 fileType:['文件','檔案','File'],

 answerIncomplete:['本次回答未完成','本次回答未完成','This answer did not complete'],
 continue:['重试回答','重試回答','Retry answer'],
 help:['重新提交此失败请求的原文，保留原失败记录；会创建新请求，不会重复已完成的工具。','重新提交此失敗請求的原文，保留原失敗記錄；會建立新請求，不會重複已完成的工具。','Resubmit the original text as a new request and keep the failure. Available only when this failed turn ran no tools.'],
 unavailable:['附件草稿未能可靠保存或恢复，请保留原文件并重新添加。','附件草稿未能可靠儲存或還原，請保留原檔案並重新加入。','The attachment draft could not be saved or restored reliably. Keep the original file and add it again.'],
 unconfirmed:['上次附件发送结果尚未确认，已保留本机副本；请先核对原会话，避免重复发送。','上次附件傳送結果尚未確認，已保留本機副本；請先核對原對話，避免重複傳送。','The previous attachment submission is unconfirmed. Its local copy is kept; check this conversation before sending again.'],
 changed:['当前草稿已变化，未自动加入旧附件；本机副本仍保留，请先核对。','目前草稿已變更，未自動加入舊附件；本機副本仍保留，請先核對。','The draft changed, so saved attachments were not added automatically. Their local copies are kept for review.'],
 missing:['上次附件暂未恢复，请核对或重新添加。','上次附件暫未還原，請核對或重新加入。','Previous attachments have not been restored. Check them or add them again.'],
 failed:['暂时无法继续，请核对当前会话和输入后重试。','暫時無法繼續，請核對目前對話及輸入後重試。','Unable to continue. Check this conversation and its composer, then try again.'],
} as const
export function draftContinuityCopy(locale:ProductLocale,key:keyof typeof copy):string{return copy[key][locale==='zh-CN'?0:locale.startsWith('zh')?1:2]}
