/**
 * 群消息关系（规格 §3.2）：引用回复与结构化全员点名只描述「这条消息在回应谁」，不授予任何工具或资料权限。
 * 直接接收者由宿主按固定优先级判定：本人明确全员 → 结构化 @ → 引用回复的员工 → 普通语义选人。
 */
export type GroupDirectRecipientMode='semantic'|'direct'|'blocked'
export type GroupDirectRecipients={mode:GroupDirectRecipientMode;recipientIds:string[];unavailableIds:string[]}

/**
 * 纯函数：只在调用方已算好的有效候选（群成员 ∩ 在岗 ∩ 群授权可发言可自动运行）里选，不引入新成员。
 * 被点名者不可回应时保留在 `unavailableIds`，不悄悄换成别的员工；没有任何结构化目标时才回 `semantic`。
 */
export function resolveGroupDirectRecipients(input:{mentionIds:readonly string[];replyAuthorRoleId:string|null;candidateIds:readonly string[];mentionAll:boolean;mentionAllAllowed:boolean}):GroupDirectRecipients{
 const candidates=new Set(input.candidateIds)
 if(input.mentionAll){
  if(!input.mentionAllAllowed||!candidates.size)return {mode:'blocked',recipientIds:[],unavailableIds:[]}
  return {mode:'direct',recipientIds:[...candidates],unavailableIds:[]}
 }
 const named=[...new Set(input.mentionIds.length?input.mentionIds:input.replyAuthorRoleId?[input.replyAuthorRoleId]:[])]
 if(!named.length)return {mode:'semantic',recipientIds:[],unavailableIds:[]}
 const recipientIds=named.filter(id=>candidates.has(id)),unavailableIds=named.filter(id=>!candidates.has(id))
 return {mode:recipientIds.length?'direct':'blocked',recipientIds,unavailableIds}
}

/**
 * 已存消息行的关系列投影：没有关系时一个键都不出，旧消息与旧客户端看到的形状不变。
 * 后端各读表函数共用这一份，避免各抄一份列名与缺省规则。
 */
export function groupMessageRelationFields(replyTo:unknown,mentionAll:unknown):{replyToMessageId?:string;mentionAll?:true}{
 return {...(replyTo===null||replyTo===undefined?{}:{replyToMessageId:String(replyTo)}),...(mentionAll===true?{mentionAll:true as const}:{})}
}
