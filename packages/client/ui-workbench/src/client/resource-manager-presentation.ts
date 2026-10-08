import type {KnowledgeCategory,KnowledgeNode,KnowledgeTree,ResourceDirectory,ResourceDraft,SourceReference,WorkResource} from '@teloa/contract'
import {isLocalMaterialSourceId} from './local-material-registration.ts'

/** 本机原件使用真实资源段；不冒充知识页或生成假的 knowledgeId。 */
export function libraryResourceDirectory(directory:ResourceDirectory,sources:SourceReference[]):ResourceDirectory{
 const include=(row:ResourceDraft|WorkResource)=>isLocalMaterialSourceId(row.sourceId)||sources.some(source=>source.id===row.sourceId&&source.knowledge)
 return {drafts:directory.drafts.filter(include),resources:directory.resources.filter(include)}
}

export const workResourceCategories=[
  {id:'business-context',title:'业务说明',description:'说明业务如何运作、职责与术语。'},
  {id:'policy',title:'制度与规范',description:'沉淀必须遵守的规则与要求。'},
  {id:'sop',title:'SOP 与操作手册',description:'记录可复用的具体处理步骤。'},
  {id:'criteria',title:'标准与判据',description:'明确质量、风险与完成的判断依据。'},
  {id:'reference',title:'案例与参考',description:'保留可借鉴的历史与外部依据。'},
  {id:'template-asset',title:'模板与素材',description:'保存工作时可直接取用的内容。'},
  {id:'system-data-guide',title:'系统与数据说明',description:'帮助理解系统、字段、接口与数据。'},
] as const

export const workResourceSources=[
  {title:'粘贴文本',description:'在会话中整理；未明确保存时仅当前会话可用。'},
  {title:'上传文件',description:'待来源适配接入；不能在此页面假定文件已保存或解析。'},
  {title:'在线文档',description:'待连接与授权接入；Lark 等文档需要先核验访问范围。'},
  {title:'行业模板',description:'固定模板版本可投影到资料目录。'},
  {title:'公共资料',description:'当前可读取项目维护的固定来源。'},
] as const

export const resourceManagerCopy={
  scopeDescription:'集中保存员工和任务可以反复引用的业务知识。',
  sessionEntryDescription:'直接在会话中粘贴文字、文件或链接，并说明“保存到资料”。临时内容默认仅当前会话使用；明确保存后才进入这里。',
  preparingTitle:'待核对版本',
  preparingDescription:'这里显示已有草案与提交状态。目录不作为首要新增入口；提交前不会进入工作引用。',
  availableTitle:'可引用资料',
  availableDescription:'本人核对并提交的固定版本。会话用 @ 引用；员工与任务仍按各自授权范围读取。',
  saveAction:'保存修改',
  submitAction:'加入资料',
} as const

const matches=(values:readonly string[],needle:string)=>values.some(value=>value.toLocaleLowerCase().includes(needle))

type ResourceRow=ResourceDraft|WorkResource
export type ResourceManagerFilters={workspaceId?:string;scopeId?:string;category?:KnowledgeCategory|'all';topic?:string;status?:ResourceStatusDirectoryId;sourceId?:string}

const sourceOf=(row:ResourceRow,sources:SourceReference[])=>sources.find(source=>source.id===row.sourceId)
const categoryLabel=(category:KnowledgeCategory)=>workResourceCategories.find(item=>item.id===category)?.title??category
const managedDirectory=(directory:ResourceDirectory):ResourceDirectory=>({drafts:pendingResourceDrafts(directory),resources:[...activeWorkResources(directory),...withdrawnWorkResources(directory)]})

export type KnowledgeWikiDocument={id:string;title:string;kind:'draft'|'resource';status:'draft'|'active'|'withdrawn'}
export type KnowledgeWikiFolder={id:string;title:string;count:number;documents:KnowledgeWikiDocument[]}
export type KnowledgeWikiWorkspace={id:string;title:string;count:number;folders:KnowledgeWikiFolder[];documents:KnowledgeWikiDocument[]}

export type KnowledgeDirectoryPage={type:'page';id:string;title:string;knowledgeId:string;resourceId:string|undefined;status:'active'|'withdrawn'|'unavailable'}
export type KnowledgeDirectoryBranch={type:'space'|'folder';id:string;title:string;count:number;children:KnowledgeDirectoryEntry[]}
export type KnowledgeDirectoryEntry=KnowledgeDirectoryBranch|KnowledgeDirectoryPage

const resourceForKnowledge=(knowledgeId:string,directory:ResourceDirectory,sources:SourceReference[])=>{
  const knowledgeSources=sources.filter(source=>source.knowledge?.knowledgeId===knowledgeId),sourceIds=new Set(knowledgeSources.map(source=>source.id)),fallbackId=`knowledge_${knowledgeId.toLowerCase()}`
  const matches=directory.resources.filter(resource=>sourceIds.has(resource.sourceId)||resource.sourceId===fallbackId)
  return matches.find(resource=>resource.status==='active'&&knowledgeSources.some(source=>source.id===resource.sourceId&&source.version===resource.sourceVersion))
    ??matches.find(resource=>resource.status==='active')
    ??matches.find(resource=>resource.status==='withdrawn')
}

export function buildKnowledgeDirectoryTree(tree:KnowledgeTree,directory:ResourceDirectory,sources:SourceReference[],query='',visibleResourceIds?:ReadonlySet<string>):KnowledgeDirectoryBranch{
  const root=tree.nodes.find(node=>node.id===tree.space.rootNodeId)!
  const byParent=new Map<string,KnowledgeNode[]>()
  for(const node of tree.nodes){
    if(node.parentId===null)continue
    const siblings=byParent.get(node.parentId)??[]
    siblings.push(node);byParent.set(node.parentId,siblings)
  }
  for(const siblings of byParent.values())siblings.sort((left,right)=>left.siblingOrder-right.siblingOrder||left.id.localeCompare(right.id))
  const needle=query.trim().toLocaleLowerCase()
  const visit=(node:KnowledgeNode,includeDescendants=false):KnowledgeDirectoryEntry|undefined=>{
    if(node.type==='page'){
      const resource=resourceForKnowledge(node.knowledgeId,directory,sources),visible=visibleResourceIds===undefined||resource!==undefined&&visibleResourceIds.has(resource.id),matches=visible&&(!needle||includeDescendants||node.title.toLocaleLowerCase().includes(needle)||resource?.title.toLocaleLowerCase().includes(needle))
      return matches?{type:'page',id:node.id,title:node.title,knowledgeId:node.knowledgeId,resourceId:resource?.id,status:resource?.status??'unavailable'}:undefined
    }
    const matches=includeDescendants||node.title.toLocaleLowerCase().includes(needle),children=(byParent.get(node.id)??[]).map(child=>visit(child,matches)).filter((child):child is KnowledgeDirectoryEntry=>!!child)
    if(node.type!=='space'&&needle&&!matches&&!children.length)return undefined
    const count=children.reduce((sum,child)=>sum+(child.type==='page'?1:child.count),0)
    return {type:node.type,id:node.id,title:node.title,count,children}
  }
  return visit(root) as KnowledgeDirectoryBranch
}

export function defaultKnowledgeSelection(tree:KnowledgeTree,directory:ResourceDirectory,sources:SourceReference[],currentNodeId?:string):{nodeId:string;resourceId:string|undefined}{
  const current=tree.nodes.find(node=>node.id===currentNodeId)
  if(current){
    const resource=current.type==='page'?resourceForKnowledge(current.knowledgeId,directory,sources):undefined
    return {nodeId:current.id,resourceId:resource?.id}
  }
  const firstPage=(branch:KnowledgeDirectoryBranch):KnowledgeDirectoryPage|undefined=>{
    for(const child of branch.children){
      if(child.type==='page'&&child.status==='active')return child
      if(child.type!=='page'){
        const page=firstPage(child)
        if(page)return page
      }
    }
    return undefined
  }
  const page=firstPage(buildKnowledgeDirectoryTree(tree,directory,sources))
  return {nodeId:page?.id??tree.space.rootNodeId,resourceId:page?.resourceId}
}

export function knowledgeBreadcrumbs(tree:KnowledgeTree,nodeId:string):KnowledgeNode[]{
  const byId=new Map(tree.nodes.map(node=>[node.id,node])),node=byId.get(nodeId),root=byId.get(tree.space.rootNodeId)
  if(!node)return root?[root]:[]
  return node.path.map(id=>byId.get(id)).filter((item):item is KnowledgeNode=>!!item)
}

export function canGovernKnowledgeNode(tree:KnowledgeTree,nodeId:string):boolean{
  const node=tree.nodes.find(item=>item.id===nodeId)
  return !!node&&node.type!=='space'
}

export function knowledgeMoveTargets(tree:KnowledgeTree,nodeId:string):{id:string;label:string}[]{
  const node=tree.nodes.find(item=>item.id===nodeId),byId=new Map(tree.nodes.map(item=>[item.id,item]))
  if(!node||node.type==='space')return []
  return tree.nodes.filter(candidate=>(candidate.type==='space'||candidate.type==='folder')&&candidate.id!==node.parentId&&!candidate.path.includes(node.id)).map(candidate=>({id:candidate.id,label:candidate.path.map(id=>byId.get(id)?.title).filter((title):title is string=>!!title).join(' / ')}))
}

const wikiDocument=(row:ResourceRow):KnowledgeWikiDocument=>'requestId' in row
  ?{id:row.id,title:row.title,kind:'draft',status:'draft'}
  :{id:row.id,title:row.title,kind:'resource',status:row.status}

export function buildKnowledgeWikiTree(directory:ResourceDirectory,sources:SourceReference[]){
  const managed=managedDirectory(directory)
  const drafts=managed.drafts.map(wikiDocument).sort((a,b)=>a.title.localeCompare(b.title,'zh-CN'))
  const classified=managed.resources.flatMap(resource=>{
    const knowledge=sourceOf(resource,sources)?.knowledge
    return knowledge?[{resource,knowledge}]:[]
  })
  const workspaceIds=[...new Set(classified.map(row=>row.knowledge.workspaceId))].sort()
  const workspaces:KnowledgeWikiWorkspace[]=workspaceIds.map(workspaceId=>{
    const rows=classified.filter(row=>row.knowledge.workspaceId===workspaceId)
    const documents=rows.map(row=>wikiDocument(row.resource)).sort((a,b)=>a.title.localeCompare(b.title,'zh-CN'))
    return {id:workspaceId,title:resourceWorkspaceLabel(workspaceId),count:documents.length,folders:[],documents}
  })
  return {drafts,workspaces,unclassified:[] as KnowledgeWikiDocument[]}
}

export function filterResourceManagerDirectory(directory:ResourceDirectory,query:string,sources:SourceReference[]=[],filters:ResourceManagerFilters={}):ResourceDirectory{
  const needle=query.trim().toLocaleLowerCase()
  const status=filters.status??'all',base=filterResourceManagerStatus(directory,status)
  const include=(row:ResourceRow)=>{
    const source=sourceOf(row,sources),knowledge=source?.knowledge
    if(filters.workspaceId&&filters.workspaceId!=='all'&&knowledge?.workspaceId!==filters.workspaceId)return false
    if(filters.scopeId&&filters.scopeId!=='all'&&!knowledge?.scopeIds.includes(filters.scopeId))return false
    if(filters.category&&filters.category!=='all'&&knowledge?.category!==filters.category)return false
    if(filters.topic&&filters.topic!=='all'&&!knowledge?.topics.includes(filters.topic))return false
    if(filters.sourceId&&filters.sourceId!=='all'&&row.sourceId!==filters.sourceId)return false
    if(!needle)return true
    return matches([row.title,row.sourceId,row.status,...row.scopeIds,source?.title??'',source?.source??'',knowledge?.workspaceId??'',knowledge?categoryLabel(knowledge.category):'',...(knowledge?.topics??[]),...(knowledge?.scopeIds??[])],needle)
  }
  return {
    drafts:base.drafts.filter(include),
    resources:base.resources.filter(include),
  }
}

export function buildResourceManagerFacets(directory:ResourceDirectory,sources:SourceReference[]){
  const rows=[...managedDirectory(directory).drafts,...managedDirectory(directory).resources]
  const count=(predicate:(row:ResourceRow)=>boolean)=>rows.filter(predicate).length
  const workspaces=[...new Set(rows.map(row=>sourceOf(row,sources)?.knowledge?.workspaceId).filter((id):id is string=>!!id))].sort()
  const scopes=[...new Set(rows.flatMap(row=>sourceOf(row,sources)?.knowledge?.scopeIds??[]))].sort((a,b)=>a==='general'?-1:b==='general'?1:a.localeCompare(b))
  const topics=[...new Set(rows.flatMap(row=>sourceOf(row,sources)?.knowledge?.topics??[]))].sort()
  const sourceIds=[...new Set(rows.map(row=>row.sourceId))]
  return {
    workspaces:[{id:'all',title:'全部工作空间',count:rows.length},...workspaces.map(id=>({id,title:resourceWorkspaceLabel(id),count:count(row=>sourceOf(row,sources)?.knowledge?.workspaceId===id)}))],
    scopes:[{id:'all',title:'全部业务归属',count:rows.length},...scopes.map(id=>({id,title:resourceScopeLabel(id),count:count(row=>sourceOf(row,sources)?.knowledge?.scopeIds.includes(id)??false)}))],
    categories:workResourceCategories.map(item=>({...item,count:count(row=>sourceOf(row,sources)?.knowledge?.category===item.id)})),
    topics:topics.map(id=>({id,title:id,count:count(row=>sourceOf(row,sources)?.knowledge?.topics.includes(id)??false)})),
    sources:sourceIds.map(id=>({id,title:sources.find(source=>source.id===id)?.title??id,count:count(row=>row.sourceId===id)})),
    unclassifiedCount:count(row=>!sourceOf(row,sources)?.knowledge),
    employeeRelationshipAvailable:false as const,
  }
}

export function resourceGovernanceFacts(resource:WorkResource,source:SourceReference|undefined):[string,string][] {
  const knowledge=source?.knowledge
  return [
    ['状态',resource.status==='active'?'可引用':'已撤回'],
    ['工作空间',knowledge?resourceWorkspaceLabel(knowledge.workspaceId):'待接入'],
    ['业务归属',knowledge?knowledge.scopeIds.map(resourceScopeLabel).join(' · '):'待接入'],
    ['主分类',knowledge?categoryLabel(knowledge.category):'待接入'],
    ['主题',knowledge?(knowledge.topics.length?knowledge.topics.join(' · '):'未设置'):'待接入'],
    ['来源',source?.title??resource.sourceId],
    ['固定正文版本',knowledge?`v${knowledge.knowledgeVersion}`:'待接入'],
    ['固定来源版本',resource.sourceVersion],
    ['可用范围',resource.scopeIds.map(resourceScopeLabel).join(' · ')],
    ['资料范围',knowledge?knowledge.scopeIds.map(resourceScopeLabel).join(' · '):'待接入'],
    ['使用员工','待接入'],
    ['使用关系','待接入'],
    ['权限状态','待核验'],
    ['同步状态','待接入'],
  ]
}

export function resourceSourceFacts(source:SourceReference|undefined):[string,string][] {
  const knowledge=source?.knowledge
  return [
    ['工作空间',knowledge?resourceWorkspaceLabel(knowledge.workspaceId):'待接入'],
    ['业务归属',knowledge?knowledge.scopeIds.map(resourceScopeLabel).join(' · '):'待接入'],
    ['主分类',knowledge?categoryLabel(knowledge.category):'待接入'],
    ['主题',knowledge?(knowledge.topics.length?knowledge.topics.join(' · '):'未设置'):'待接入'],
    ['使用员工','待接入'],
    ['权限状态','待核验'],
    ['同步状态','待接入'],
  ]
}

export function resourceListMetadata(row:ResourceRow,source:SourceReference|undefined){
  const knowledge=source?.knowledge
  return `${knowledge?categoryLabel(knowledge.category):'待整理'} · ${source?.title??row.sourceId}`
}

export function pendingResourceDrafts(directory:ResourceDirectory){return directory.drafts.filter(draft=>draft.status==='draft')}

export function activeWorkResources(directory:ResourceDirectory){return directory.resources.filter(resource=>resource.status==='active')}

export function withdrawnWorkResources(directory:ResourceDirectory){return directory.resources.filter(resource=>resource.status==='withdrawn')}

export type ResourceStatusDirectoryId='all'|'draft'|'active'|'withdrawn'

export function resourceStatusDirectory(directory:ResourceDirectory){
  const draft=pendingResourceDrafts(directory).length,active=activeWorkResources(directory).length,withdrawn=withdrawnWorkResources(directory).length
  return [
    {id:'all' as const,title:'全部资料',count:draft+active+withdrawn},
    {id:'draft' as const,title:'待核对',count:draft},
    {id:'active' as const,title:'可引用',count:active},
    {id:'withdrawn' as const,title:'已撤回',count:withdrawn},
  ]
}

export function filterResourceManagerStatus(directory:ResourceDirectory,status:ResourceStatusDirectoryId):ResourceDirectory{
  if(status==='all')return {drafts:pendingResourceDrafts(directory),resources:[...activeWorkResources(directory),...withdrawnWorkResources(directory)]}
  if(status==='draft')return {drafts:pendingResourceDrafts(directory),resources:[]}
  return {drafts:[],resources:status==='active'?activeWorkResources(directory):withdrawnWorkResources(directory)}
}

export function defaultResourceSelection(directory:ResourceDirectory):{kind:'draft';draft:ResourceDraft}|{kind:'resource';resource:WorkResource}|undefined{
  const draft=pendingResourceDrafts(directory)[0]
  if(draft)return {kind:'draft',draft}
  const resource=activeWorkResources(directory)[0]??withdrawnWorkResources(directory)[0]
  return resource?{kind:'resource',resource}:undefined
}

export function resourceScopeLabel(scopeId:string){return scopeId==='general'?'通用':scopeId}

export function resourceWorkspaceLabel(workspaceId:string){return workspaceId==='default'?'当前工作空间':workspaceId}

export function normalizeResourceSourceSelection(sources:SourceReference[],sourceId:string,sourceVersion:string){
  const source=sources.find(candidate=>candidate.id===sourceId)
  if(source)return {id:sourceId,version:sourceVersion}
  return {id:sources[0]?.id??'',version:sources[0]?.version??''}
}
