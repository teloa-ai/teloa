/**
 * 输入框「下一条建议」的纯逻辑（不碰 DOM、不调模型）。
 *
 * 设计约束（见 plans/社区版/2026-10-24-输入框下一条建议实施计划.md）：
 * - 建议只能是**用户接下来会说的一句话**，且必须来自已有事实；
 * - 事实不足就返回 null（宁可不显示），不做模板填空、不编造待办；
 * - 采纳、丢弃、开关策略都在这里给出判据，界面层只照做。
 */

export const composerSuggestionMaxChars=200
/** 本地偏好的存储键；默认开（与 Codex 一致）。 */
export const composerSuggestionPreferenceKey='teloa.composer-suggestion.enabled'

export type SuggestionDecision='show'|'hidden-empty'|'hidden-busy'|'hidden-disabled'|'hidden-dismissed'

/** 建议何时该显示：输入框为空、未聚焦、开关打开、本条回复未被丢弃且确有候选。 */
export function shouldShowSuggestion(input:{enabled:boolean;draft:string;focused:boolean;dismissedForAnswer:boolean;text:string|null}):SuggestionDecision{
 if(!input.enabled)return 'hidden-disabled'
 if(input.draft.trim().length>0)return 'hidden-busy'
 if(input.focused)return 'hidden-busy'
 if(input.dismissedForAnswer)return 'hidden-dismissed'
 const text=(input.text??'').trim()
 if(!text)return 'hidden-empty'
 return 'show'
}

/** 偏好读取：只在"明确写过 false"时视为关闭，其余（无记录、坏值）都按默认开。 */
export function readSuggestionEnabled(storage:{getItem:(key:string)=>string|null}|undefined):boolean{
 try{
  const raw=storage?.getItem(composerSuggestionPreferenceKey)
  return raw!=='false'
 }catch{return true}
}
const preferenceListeners=new Set<()=>void>()
/** 同标签页由写入口通知，其他标签页通过浏览器 storage 事件同步。 */
export function subscribeSuggestionEnabled(listener:()=>void):()=>void{
 preferenceListeners.add(listener)
 const onStorage=(event:StorageEvent)=>{if(event.key===composerSuggestionPreferenceKey||event.key===null)listener()}
 globalThis.addEventListener?.('storage',onStorage)
 return()=>{preferenceListeners.delete(listener);globalThis.removeEventListener?.('storage',onStorage)}
}
export function writeSuggestionEnabled(storage:{setItem:(key:string,value:string)=>void}|undefined,enabled:boolean):void{
 try{storage?.setItem(composerSuggestionPreferenceKey,enabled?'true':'false')}catch{/* 受限环境只影响本机偏好，不影响功能本身。 */}
 for(const listener of [...preferenceListeners])listener()
}

/** 候选合格性：单句、不超长、不含换行；不合格一律不显示。 */
export function normalizeSuggestion(raw:string|null|undefined):string|null{
 const flattened=(raw??'').replace(/```[a-z]*/gi,'').replace(/\s*\n+\s*/g,' ').trim().replace(/^["“]|["”]$/g,'').trim()
 if(!flattened||flattened==='NONE')return null
 // 与 Codex 一致：整段建议也接受，只收口长度。
 return flattened.length>composerSuggestionMaxChars?flattened.slice(0,composerSuggestionMaxChars):flattened
}


