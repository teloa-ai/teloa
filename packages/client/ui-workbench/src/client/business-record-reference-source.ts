import {encodeBusinessRecordReference,parseBusinessRecordReferences,type BusinessObjectReference} from '@teloa/contract'
import type {InputTriggerSource,ReferenceInsert} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
const source='teloa-business-records'
function canonical(value:string):string{
 const references=parseBusinessRecordReferences(value)
 if(references.length!==1||encodeBusinessRecordReference(references[0]!)!==value)throw Error('业务记录引用损坏，请回到记录详情重新选择。')
 return value
}
/** 显示名称只作为 chip 标签；正式身份由共享编码保留，绝不携带正文或扩大权限。 */
export function businessRecordReferenceInsert(reference:BusinessObjectReference,title:string):ReferenceInsert{
 if(!title.trim()||title.length>240)throw Error('业务记录名称不可用。')
 const ref=encodeBusinessRecordReference(reference)
 return {source,ref,label:title,appearance:'file',clipboardText:ref}
}
/** 记录选择来自正式详情；这里只注册原生持久/发送 codec，不创建第二个对象目录。 */
export function businessRecordReferenceSource():InputTriggerSource{
 return {trigger:'@',name:source,order:11,showGroupTitle:false,candidates:async()=>[],onPick:()=>undefined,
  codec:{clipboardText:canonical,serialize:async(ref,signal)=>{signal.throwIfAborted();return canonical(ref)}},
 }
}
