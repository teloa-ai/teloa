import type {Conversation} from './index.ts'

/** 游标仅延续本人只读目录，不构成会话或执行授权。旧 list 返回值不变。 */
export type ConversationDirectoryPageRequest={limit?:number;cursor?:string}
export type ConversationDirectoryPage={items:Conversation[];nextCursor?:string}
