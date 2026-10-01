import type { PresentedConversation } from './work-presentation.js'
import type { PreviewRole } from './role-preview.js'

type RoleConversationLink = {sessionId:string;active:boolean}

/** 暂停只是不接新任务；聊天能力一直保留到岗位离职。 */
export const roleCanStartConversation=(state:PreviewRole['state']):boolean=>state!=='retired'

/**
 * 从岗位的真实关联中选出最近一条仍有效的原生会话。
 * 不依赖调用方传入顺序：更新时间相同按 conversation id 固定排序，刷新后不会随机跳会话。
 */
export function latestRoleConversation(
  conversations:readonly PresentedConversation[],
  links:readonly RoleConversationLink[],
  archivedSessionIds:readonly string[],
):PresentedConversation|undefined{
  const active=new Set(links.filter(link=>link.active).map(link=>link.sessionId))
  const archived=new Set(archivedSessionIds)
  return conversations
    .filter(row=>row.conversation.status==='ready'&&active.has(row.conversation.sessionId)&&!archived.has(row.conversation.sessionId))
    .sort((a,b)=>b.updatedAt-a.updatedAt||a.conversation.id.localeCompare(b.conversation.id))[0]
}
