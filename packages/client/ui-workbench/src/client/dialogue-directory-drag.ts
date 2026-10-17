import {dialogueEntryKey,type DialogueEntry} from './dialogue-organization.ts'

export const dialogueDragType='application/x-teloa-dialogue'
export const encodeDialogueDrag=(entry:DialogueEntry)=>JSON.stringify(entry)

/** 拖动只组织本目录中已经展示的原对象；外部数据不能创建关联或扩大可见范围。 */
export function resolveDialogueDrop(raw:string,active:DialogueEntry|undefined,visible:readonly DialogueEntry[]):DialogueEntry|undefined{
 if(!active||!visible.some(entry=>dialogueEntryKey(entry)===dialogueEntryKey(active)))return
 try{
  const value=JSON.parse(raw)
  if(!value||Object.keys(value).sort().join(',')!=='id,kind'||value.id!==active.id||value.kind!==active.kind)return
  return active
 }catch{return}
}
