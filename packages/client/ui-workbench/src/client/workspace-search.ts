import type {PresentedConversation} from './work-presentation.ts'
import type {PreviewTask} from './task-preview.ts'
import type {PreviewRole} from './role-preview.ts'
import type {CollaborationGroup} from './collaboration-preview.ts'
import type {BusinessScopeLabel} from './business-directory.ts'
import type {MessageKey} from './i18n/messages.ts'
import type {WorkspaceKnowledgeSearchEntry} from './workspace-search-knowledge.js'
import type {WorkspaceCapabilityOpenTarget,WorkspaceCapabilitySearchRow} from './workspace-capability-search.js'

/** 全局搜索只接收市场当前目录已经呈现的本地化条目，不自行生成候选项。 */
export type WorkspaceMarketSearchEntry={id:string;title:string;summary:string}

export type WorkspaceSearchSource={
 conversations:readonly PresentedConversation[]
 tasks:readonly Pick<PreviewTask,'storage'|'id'|'title'|'goal'|'state'|'scope'>[]
 roles:readonly Pick<PreviewRole,'storage'|'id'|'name'|'duty'|'state'>[]
 groups:readonly (Pick<CollaborationGroup,'id'|'name'|'announcement'|'archived'>&{storage?:'persistent'})[]
 spaces:readonly (Pick<BusinessScopeLabel,'scope'|'title'>&{storage?:'persistent'})[]
  knowledge:readonly WorkspaceKnowledgeSearchEntry[]
  capabilities:readonly WorkspaceCapabilitySearchRow[]
  market:readonly WorkspaceMarketSearchEntry[]
}
export const workspaceSearchKinds={conversation:'workDirectory.conversation',task:'attention.source.task',group:'shell.messageType.group',role:'navigation.team',business:'navigation.spaces',knowledge:'navigation.resources',capability:'navigation.capabilities',market:'navigation.market'} as const satisfies Record<string,MessageKey>
export type WorkspaceSearchResult={key:string;kind:keyof typeof workspaceSearchKinds;id:string;title:string;detailKey:MessageKey;open?:WorkspaceCapabilityOpenTarget}
export type WorkspaceSearchKindFilter='all'|WorkspaceSearchResult['kind']
export function filterWorkspaceSearchResults(rows:readonly WorkspaceSearchResult[],kind:WorkspaceSearchKindFilter):WorkspaceSearchResult[]{
 return kind==='all'?[...rows]:rows.filter(row=>row.kind===kind)
}
/** 会话由调用方传入已接入且未归档的目录；不扩大原生私人会话可见范围。 */
export function searchWorkspace(source:WorkspaceSearchSource,query:string):WorkspaceSearchResult[]{
 const needle=query.trim().toLocaleLowerCase()
 const rows:WorkspaceSearchResult[]=[]
 const add=(kind:WorkspaceSearchResult['kind'],id:string,title:string,detailKey:MessageKey,extra='')=>{
  if([title,id,extra].some(text=>text.toLocaleLowerCase().includes(needle)))rows.push({key:kind+':'+id,kind,id,title,detailKey})
 }
 const conversationKeys:Record<PresentedConversation['status'],MessageKey>={pending:'workDirectory.status.pending',running:'workDirectory.status.running',blank:'workDirectory.status.blank',idle:'workDirectory.status.idle',unknown:'workDirectory.status.unknown'}
 const taskKeys:Record<PreviewTask['state'],MessageKey>={ready:'status.ready',running:'status.running',paused:'status.paused',waiting:'status.waiting',blocked:'status.blocked',completed:'status.completed',cancelled:'status.cancelled'}
 const roleKeys:Record<PreviewRole['state'],MessageKey>={active:'status.enabled',paused:'status.paused',retired:'status.archived'}
 for(const row of source.conversations)if(row.conversation.status==='ready')add('conversation',row.conversation.id,row.title,conversationKeys[row.status])
 for(const row of source.tasks)if(row.storage==='persistent')add('task',row.id,row.title,taskKeys[row.state],row.goal)
 for(const row of source.groups)if(row.storage==='persistent'&&!row.archived)add('group',row.id,row.name,'workspaceSearch.detail.group',row.announcement)
 for(const row of source.roles)if(row.storage==='persistent')add('role',row.id,row.name,roleKeys[row.state],row.duty)
 for(const row of source.spaces)if(row.storage==='persistent')add('business',row.scope,row.title,'workspaceSearch.detail.business')
 for(const row of source.knowledge)add('knowledge',row.id,row.title,'workspaceSearch.detail.knowledge',[row.resourceTitle,row.knowledgeId,row.nodeId,String(row.version),...row.path,...row.topics,...row.scopeIds,row.category].join(' '))
 const capabilityKeys:Record<WorkspaceCapabilitySearchRow['type'],MessageKey>={skill:'workspaceSearch.detail.skill',plugin:'workspaceSearch.detail.plugin',mcp:'workspaceSearch.detail.mcp'}
 for(const row of source.capabilities){
  if([row.title,row.id,row.detail].some(text=>text.toLocaleLowerCase().includes(needle)))rows.push({key:'capability:'+row.key,kind:'capability',id:row.id,title:row.title,detailKey:capabilityKeys[row.type],open:row.open})
 }
 for(const row of source.market)add('market',row.id,row.title,'workspaceSearch.detail.market',row.summary)
 return rows
}
