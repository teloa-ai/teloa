/**
 * IM 侧写操作的确定性 requestId（评审 H3）：IM 发起的 Teloa 写操作经 teloaWork.invoke 直达、不登记待恢复表，
 * 幂等由本函数保证——同一 IM 消息重放得到同一 id，由各端点自身的 requestId 去重语义兜底。
 * chatId 参与派生：Telegram message_id、Slack ts 只在聊天／频道内唯一。
 * 输出为 RFC 4122 v5 形态，满足 conversations.ts validRequestId 与 collaboration.ts uuid() 同一正则。
 */
import {createHash} from 'node:crypto'

export function imRequestId(channelId:string,chatId:string,messageId:string,step?:string):string{
 const bytes=createHash('sha256').update(`${channelId}:${chatId}:${messageId}${step===undefined?'':':'+step}`).digest().subarray(0,16)
 bytes[6]=(bytes[6]!&0x0f)|0x50
 bytes[8]=(bytes[8]!&0x3f)|0x80
 const hex=bytes.toString('hex')
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}
