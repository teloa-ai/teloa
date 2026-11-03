import {isConversation,type ConversationDirectoryPage} from '@teloa/contract'

export function readConversationDirectoryPage(value:unknown):ConversationDirectoryPage{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['items','nextCursor'].includes(key)))throw Error('工作服务返回的会话目录页格式不正确。')
 const page=value as ConversationDirectoryPage
 if(!Array.isArray(page.items)||!page.items.every(isConversation)||page.items.length>32||new Set(page.items.map(row=>row.sessionId)).size!==page.items.length||page.nextCursor!==undefined&&(typeof page.nextCursor!=='string'||page.nextCursor.length<1||page.nextCursor.length>2048))throw Error('工作服务返回的会话目录页格式不正确。')
 return page
}
