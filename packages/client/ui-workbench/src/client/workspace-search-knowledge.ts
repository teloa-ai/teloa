import type {KnowledgeCategory,KnowledgeTree,ResourceDirectory,SourceReference} from '@teloa/contract'

export type WorkspaceKnowledgeSearchEntry={
 id:string
 knowledgeId:string
 nodeId:string
 title:string
 resourceTitle:string
 version:number
 category:KnowledgeCategory
 topics:string[]
 scopeIds:string[]
 path:string[]
}

const sameStrings=(left:readonly string[],right:readonly string[])=>left.length===right.length&&left.every((value,index)=>value===right[index])

/**
 * 全局搜索与知识库页面复用同一组服务端事实，只投影当前可引用的 Markdown 页面。
 * 草案、撤回投影、孤立目录节点、不可见来源和版本不一致项都会被排除。
 */
export function searchableKnowledgeDocuments(tree:KnowledgeTree,directory:ResourceDirectory,sources:SourceReference[]):WorkspaceKnowledgeSearchEntry[]{
 const nodes=new Map(tree.nodes.map(node=>[node.id,node]))
 const rows:WorkspaceKnowledgeSearchEntry[]=[]
 for(const node of tree.nodes){
  if(node.type!=='page')continue
  const matchingSources=sources.filter(source=>source.knowledge?.knowledgeId===node.knowledgeId&&source.knowledge.workspaceId===tree.space.workspaceId)
  if(matchingSources.length!==1)continue
  const source=matchingSources[0]!,metadata=source.knowledge!
  const resources=directory.resources.filter(resource=>resource.status==='active'&&resource.sourceId===source.id&&resource.sourceVersion===source.version&&resource.title===source.title&&sameStrings(resource.scopeIds,metadata.scopeIds))
  if(resources.length!==1)continue
  const resource=resources[0]!,path=node.path.map(id=>nodes.get(id)?.title)
  if(path.some(title=>title===undefined))continue
  rows.push({id:resource.id,knowledgeId:node.knowledgeId,nodeId:node.id,title:node.title,resourceTitle:resource.title,version:metadata.knowledgeVersion,category:metadata.category,topics:[...metadata.topics],scopeIds:[...metadata.scopeIds],path:path as string[]})
 }
 return rows
}
