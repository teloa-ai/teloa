/**
 * 建议可见时的按键路由（纯函数，便于直接测）。
 *
 * 只有 Tab 与 Escape 会被这一层"吃掉"：
 * - Tab：采纳（把建议放进草稿），返回 'accept'，**不发送**；
 * - Escape：丢弃本条建议；
 * - 任何可打印字符/回车：不拦截，交给输入框本身（本人输入即接管）。
 */
export type SuggestionKeyOutcome='accept'|'dismiss'|'pass'

export function routeSuggestionKey(input:{key:string;visible:boolean;composing?:boolean;modifier?:boolean}):SuggestionKeyOutcome{
 if(!input.visible||input.composing===true)return 'pass'
 // Tab 组合键（Shift+Tab 等）留给浏览器/输入框，不抢。
 if(input.key==='Tab'&&input.modifier!==true)return 'accept'
 if(input.key==='Escape')return 'dismiss'
 return 'pass'
}

/** 无障碍提示：让读屏用户知道这是建议、按 Tab 采纳、不会自动发送。 */


