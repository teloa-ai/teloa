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
export function writeSuggestionEnabled(storage:{setItem:(key:string,value:string)=>void}|undefined,enabled:boolean):void{
 try{storage?.setItem(composerSuggestionPreferenceKey,enabled?'true':'false')}catch{/* 受限环境只影响本机偏好，不影响功能本身。 */}
}

/**
 * 从助手最后一条回答里取出一个**可核对**的下一步候选：
 * 只认助手自己提出的问句或明确的"继续做某事"，其余一律 null。
 * 这是没有模型可用时的兜底来源，不代替模型推断。
 */
export function deriveSuggestionFromAnswer(answer:string):string|null{
 const text=(answer??'').trim()
 if(!text)return null
 const tail=text.slice(-400)
 // 1) 助手以问句收尾：把那个问句的用户式回答当作候选。
 const question=tail.match(/([^。！？!?\n]{4,60}[？?])\s*$/)?.[1]?.trim()
 if(question){
  if(/要不要|是否需要|是否要|需不需要|可以吗|行吗|好吗/u.test(question))return '要，请继续。'
  if(/从哪里|在哪|哪个|哪份|哪一条/u.test(question))return null
  return null
 }
 // 2) 助手明确说"提供 X 我就……"：把提供动作当候选。
 if(/请把[^。！？\n]{2,40}(贴|发|放)|把[^。！？\n]{2,40}(贴|发|放)过来/u.test(tail))return '我把材料发给你。'
 // 3) 助手明确指出缺少某份材料：候选就是"我把材料给你"。
 if(/(仍|还)(缺|剩|需要)[^。！？\n]{0,20}(清单|原件|材料|文件|表格)|缺少[^。！？\n]{0,12}(清单|原件|材料|文件)/u.test(tail))return '我把材料发给你。'
 // 4) 助手说还可以继续做某件明确的事。
 if(/需要我[^。！？\n]{2,40}[吗？?]/u.test(tail))return '需要，请继续。'
 return null
}

/** 候选合格性：单句、不超长、不含换行；不合格一律不显示。 */
export function normalizeSuggestion(raw:string|null|undefined):string|null{
 const flattened=(raw??'').replace(/```[a-z]*/gi,'').replace(/\s*\n+\s*/g,' ').trim().replace(/^["“]|["”]$/g,'').trim()
 if(!flattened||flattened==='NONE')return null
 // 与 Codex 一致：整段建议也接受，只收口长度。
 return flattened.length>composerSuggestionMaxChars?flattened.slice(0,composerSuggestionMaxChars):flattened
}


