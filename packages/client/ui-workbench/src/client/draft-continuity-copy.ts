import type {ProductLocale} from './i18n/locale.js'
const copy={
 continue:['继续回答','繼續回答','Continue answer'],
 help:['在本会话追加续办指令，保留原失败记录；不会重放原请求。','在本對話加入續辦指令，保留原失敗記錄；不會重播原請求。','Add a follow-up in this conversation, keeping the failure. This does not replay the original request.'],
 instruction:['请继续本会话上次因错误中断、尚未完成的回答。以现有记录为准，不要重复已完成或已受理的工具、审批及外部操作；如需重新执行有实际后果的动作，请先说明并等待确认。','請繼續本對話上次因錯誤中斷、尚未完成的回答。以現有記錄為準，不要重複已完成或已受理的工具、審批及外部操作；如需重新執行有實際後果的動作，請先說明並等待確認。','Continue the unfinished answer interrupted by the last error in this conversation. Use the existing record; do not repeat completed or accepted tools, approvals, or external actions. Explain and wait for confirmation before repeating any consequential action.'],
 unavailable:['附件草稿未能可靠保存或恢复，请保留原文件并重新添加。','附件草稿未能可靠儲存或還原，請保留原檔案並重新加入。','The attachment draft could not be saved or restored reliably. Keep the original file and add it again.'],
 unconfirmed:['上次附件发送结果尚未确认，已保留本机副本；请先核对原会话，避免重复发送。','上次附件傳送結果尚未確認，已保留本機副本；請先核對原對話，避免重複傳送。','The previous attachment submission is unconfirmed. Its local copy is kept; check this conversation before sending again.'],
 changed:['当前草稿已变化，未自动加入旧附件；本机副本仍保留，请先核对。','目前草稿已變更，未自動加入舊附件；本機副本仍保留，請先核對。','The draft changed, so saved attachments were not added automatically. Their local copies are kept for review.'],
 missing:['上次附件暂未恢复，请核对或重新添加。','上次附件暫未還原，請核對或重新加入。','Previous attachments have not been restored. Check them or add them again.'],
 failed:['暂时无法继续，请核对当前会话和输入后重试。','暫時無法繼續，請核對目前對話及輸入後重試。','Unable to continue. Check this conversation and its composer, then try again.'],
} as const
export function draftContinuityCopy(locale:ProductLocale,key:keyof typeof copy):string{return copy[key][locale==='zh-CN'?0:locale.startsWith('zh')?1:2]}
