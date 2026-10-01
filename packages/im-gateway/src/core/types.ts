/**
 * 统一消息模型与渠道适配器契约（规格 §4.2、§7）。三个渠道适配器把平台事件翻译成 ImInbound，
 * 核心只面向本文件的类型工作，不感知平台协议。
 */
import type {ImChannelKind} from '@teloa/contract'

export type ImChatKind='direct'|'group'|'thread'

export type ImInbound={
 channelId:string
 chatId:string
 chatKind:ImChatKind
 messageId:string
 threadId?:string
 replyToId?:string
 sender:{imUserId:string;displayName:string}
 text:string
 mentions:readonly ({kind:'user';imUserId:string;raw:string}|{kind:'botSelf';raw:string})[]
 /** 一期只收不发，不下载。 */
 media:readonly {kind:'image'|'file';name?:string;mime?:string;bytes?:number}[]
 /** callbackToken 为平台回执令牌（tg callback_query.id；slack、feishu 无，为空串）。 */
 action?:{callbackId:string;value:'approve'|'reject';callbackToken:string}
 at:string
 /** 平台原始事件：不持久化、不入审计。 */
 raw:unknown
}

/** approveLabel 缺省表示只给「拒绝」（取不到调用参数时不让在 IM 盲批）。 */
export type ApprovalCard={title:string;lines:readonly string[];callbackId:string;approveLabel?:string;rejectLabel:string}

export type ImChannelCapabilities={text:true;card:boolean;button:boolean;thread:boolean;file:boolean;edit:boolean;maxMessageLength:number;rateLimitPerMinute:number}

export type ImChannelStatus={connected:boolean;lastEventAt?:string;error?:string}

export type ImCredentialEnv=Readonly<Record<string,string>>

export interface ImChannelAdapter{
 readonly id:ImChannelKind
 readonly label:string
 readonly capabilities:ImChannelCapabilities
 start(handler:(m:ImInbound)=>Promise<void>):Promise<void>
 stop():Promise<void>
 send(chatId:string,text:string,opts?:{threadId?:string}):Promise<{messageId:string}>
 sendCard?(chatId:string,card:ApprovalCard,opts?:{threadId?:string}):Promise<{messageId:string}>
 /** 编辑为纯文本即撤按钮。 */
 editMessage?(chatId:string,messageId:string,text:string):Promise<void>
 /** 平台要求的回调确认（tg answerCallbackQuery）。 */
 ack?(m:ImInbound,text?:string):Promise<void>
 status():ImChannelStatus
}

export type AdapterDeps={
 /** 凭据按次读取，不缓存。 */
 env:()=>Promise<ImCredentialEnv>
 log:{info(f:string,...v:unknown[]):void;warn(f:string,...v:unknown[]):void}
 now:()=>Date
 fetch?:typeof fetch
 WebSocketImpl?:typeof WebSocket
 sleep?:(ms:number)=>Promise<void>
}

/** 401/403 → unauthorized；409 → conflict；均不重试。 */
export type ImTerminalError={kind:'unauthorized'|'conflict'|'missing-dependency';message:string}
