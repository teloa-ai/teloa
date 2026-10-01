import type {Context} from '@deepseek-ai/cordis'
import type {ISidebarRight} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

export const WORK_CONTEXT_INJECT=['sessions','conversation','connection','uiConversation','sidebarRight','uiWorkspace'] as const

/** 声明了 sidebarRight 依赖的子上下文；根上下文没有这项服务。 */
export type WorkContext=Context&{sidebarRight:ISidebarRight}

export function requireSidebarRight(ctx:Context|undefined):ISidebarRight|undefined{
  return ctx?(ctx as WorkContext).sidebarRight:undefined
}

/**
 * 拼 ui-sidebar-documentpreview 认得的会话文件地址。
 * 逐段编码是必须的：parseFileAddress 先按 `/` 切再 decodeURIComponent，
 * 且会在第一个 `?` 或 `#` 处截断，未编码的这两个字符会把路径吃掉。
 */
export function sessionFileAddress(sessionId:string,path:string):string{
  const segments=path.split('/').map(segment=>encodeURIComponent(segment)).join('/')
  return 'dsh-resource://file/session/'+encodeURIComponent(sessionId)+'/'+segments
}
