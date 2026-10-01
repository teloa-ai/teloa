import type { RecoverableRequest } from '@teloa/contract'
type DraftState={draft:string;attachmentIds:readonly string[];phase:string}
export function restoreRecoveredText(request:RecoverableRequest,input:DraftState,running:boolean,actions:{setDraft(text:string):void}):string{
  if(running||input.phase!=='plain')throw Error('输入当前正忙，请结束当前操作后恢复。')
  if(input.draft.length>0||input.attachmentIds.length>0)throw Error('已有草稿或附件，请先保存或清空；也可复制原请求文字。')
  if(!request.text.trim())throw Error('此请求没有可恢复文字，请使用原生附件入口重新添加内容。')
  actions.setDraft(request.text)
  return request.otherContentCount>0?'文字已恢复。原请求另有 '+request.otherContentCount+' 项非文本内容，请从原生附件入口重新添加，核对后再发送。':'文字已恢复，请修正资料引用后再发送。'
}
