import type { Conversation } from '@teloa/contract'

type NativeSummary = { id:string; title?:string; running:boolean; blank:boolean; updatedAt:number }
export type WorkFilter = 'all'|'running'|'blank'
export type PresentedConversation = {
  conversation:Conversation
  title:string
  updatedAt:number
  status:'pending'|'running'|'blank'|'idle'|'unknown'
  snippet?:string
}
export const workStatusLabels:Record<PresentedConversation['status'],string>={pending:'workDirectory.status.pending',running:'workDirectory.status.running',blank:'workDirectory.status.blank',idle:'workDirectory.status.idle',unknown:'workDirectory.status.unknown'}

/** 只投影已获准的工作绑定；原生摘要提供展示信息，不产生新的绑定或授权。 */
export function presentConversations(rows:readonly Conversation[],native:readonly NativeSummary[],query='',filter:WorkFilter='all',content?:ReadonlyMap<string,string>):PresentedConversation[] {
  const summaries=new Map(native.map(item=>[item.id,item])),needle=query.trim().toLocaleLowerCase()
  return rows.map(conversation=>{
    const summary=summaries.get(conversation.sessionId)
    const title=summary?.title?.trim()||conversation.title
    const updatedAt=summary&&Number.isFinite(summary.updatedAt)&&summary.updatedAt>0?summary.updatedAt:Date.parse(conversation.createdAt)
    const status:PresentedConversation['status']=conversation.status==='pending'?'pending':!summary?'unknown':summary.running?'running':summary.blank?'blank':'idle'
    const snippet=needle&&conversation.status==='ready'?content?.get(conversation.sessionId):undefined
    return {conversation,title,updatedAt,status,...(snippet!==undefined?{snippet}:{})}
  }).filter(item=>(filter==='all'||item.status===filter)&&(!needle||item.snippet!==undefined||[item.title,item.conversation.title,item.conversation.id,item.conversation.sessionId].some(value=>value.toLocaleLowerCase().includes(needle))))
    .sort((a,b)=>b.updatedAt-a.updatedAt||a.conversation.id.localeCompare(b.conversation.id))
}

export type ConversationWorkspace={workspaceId:string;title:string;path:string;sessionIds:readonly string[]}
export type DirectoryWorkspace={kind:'all'}|{kind:'unassigned'}|{kind:'workspace';id:string}
export function organizeConversations(items:readonly PresentedConversation[],workspaces:readonly ConversationWorkspace[],selection:DirectoryWorkspace,order:'recent'|'manual'):PresentedConversation[]{
  if(selection.kind==='all')return [...items]
  if(selection.kind==='unassigned'){
    const assigned=new Set(workspaces.flatMap(row=>row.sessionIds))
    return items.filter(item=>!assigned.has(item.conversation.sessionId))
  }
  const workspace=workspaces.find(row=>row.workspaceId===selection.id)
  if(!workspace)return []
  const positions=new Map(workspace.sessionIds.map((id,index)=>[id,index]))
  const rows=items.filter(item=>positions.has(item.conversation.sessionId))
  return order==='manual'?rows.sort((a,b)=>positions.get(a.conversation.sessionId)!-positions.get(b.conversation.sessionId)!):rows
}
