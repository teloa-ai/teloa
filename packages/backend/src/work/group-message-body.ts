import {createHash} from 'node:crypto'
import {WorkError,isGroupMessageBody,isGroupMessageBodySummary,type GroupMessageBody,type GroupMessageBodySummary} from '@teloa/contract'

/** 群流不反复读取或传输完整长正文与原始请求；只读摘要、固定全文身份和既有显示字段。 */
export const groupMessageListColumns='id,group_id,root_id,author_id,text,reference_snapshot,mention_snapshot,reply_to_message_id,mention_all,task_id,run_id,created_at,full_text_meta,mention_self'
const corrupt=()=>new WorkError('teloa/storage-corrupt','群消息完整正文与固定记录不一致。')
export const groupMessageTextHash=(text:string):string=>createHash('sha256').update(text).digest('hex')

export function groupMessageBodySnapshot(text:string):{preview:string;body:string|null;summary:GroupMessageBodySummary|null}{
 if(text.length<=8000)return {preview:text,body:null,summary:null}
 // 长正文在群流只放前段；这是显示预算，完整保存不受它限制。
 const end=/[\uD800-\uDBFF]/.test(text[1196]!)?1196:1197
 return {preview:text.slice(0,end)+'\n\n…',body:text,summary:{chars:text.length,sha256:groupMessageTextHash(text)}}
}

/** 历史消息没有全文字段，保持原形状；长消息不能把未知或损坏的摘要冒充已固定全文。 */
export function groupMessageBodyFields(row:Record<string,unknown>):{fullText?:GroupMessageBodySummary}{
 if(row.full_text_meta===null||row.full_text_meta===undefined)return {}
 if(row.author_id==='self'||!isGroupMessageBodySummary(row.full_text_meta))throw corrupt()
 return {fullText:{...row.full_text_meta}}
}

export function readGroupMessageBody(row:Record<string,unknown>):GroupMessageBody{
 const {fullText}=groupMessageBodyFields(row)
 if(!fullText)throw new WorkError('teloa/source-unavailable','这条消息没有单独保存的完整正文。')
 const value={groupId:row.group_id,messageId:row.id,text:row.full_text,...fullText}
 if(!isGroupMessageBody(value)||groupMessageTextHash(value.text)!==fullText.sha256||typeof row.text!=='string'||!row.text.endsWith('\n\n…')||!value.text.startsWith(row.text.slice(0,-3)))throw corrupt()
 return value
}
