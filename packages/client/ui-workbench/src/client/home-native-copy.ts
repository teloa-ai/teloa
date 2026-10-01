import type {ProductLocale} from './i18n/locale.js'
const copy={
 pendingContext:['上次业务设置尚待核对，请回到原会话重试后再开始。','The previous work context is unconfirmed. Retry in its original conversation first.'],
 differentContext:['会话已绑定其他业务，请回到原会话核对。','This conversation is bound to another business. Check its context before continuing.'],
 scope:['业务','Business'],owner:['指定员工','Assigned employee'],assistant:['主助手','Main assistant'],
 reading:['正在核对业务上下文…','Checking work context…'],saving:['正在保存业务上下文…','Saving work context…'],
 failed:['业务上下文尚未核对，请重试后发送。','Work context is unconfirmed. Retry before sending.'],
 retry:['重试','Retry'],preparing:['正在准备输入…','Preparing the composer…'],
 choose:['请先选择一个执行位置后开始。','Select an execution location to begin.'],
 bound:['业务选择用于定位本次工作，不会扩大读取权限。','The business selection defines this work’s context without granting additional access.'],
 attachments:['刷新前的本地附件未持久保存，请重新添加。','Local attachments from before this reload were not persisted. Add them again.'],
 unknown:['上次发送结果尚未确认。请先核对会话记录，避免重复执行。','The previous submission is unconfirmed. Check the conversation before sending again.'],
 inspect:['核对已接收消息','Check accepted messages'],
 missing:['所选员工已不可用','The selected employee is unavailable'],
} as const
export function homeNativeCopy(locale:ProductLocale,key:keyof typeof copy):string{return copy[key][locale.startsWith('zh')?0:1]}
