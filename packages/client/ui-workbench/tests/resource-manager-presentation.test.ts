import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import type {KnowledgeTree,ResourceDirectory,SourceReference} from '@teloa/contract'
import {activeWorkResources,buildKnowledgeDirectoryTree,buildKnowledgeWikiTree,buildResourceManagerFacets,canGovernKnowledgeNode,defaultKnowledgeSelection,defaultResourceSelection,filterResourceManagerDirectory,filterResourceManagerStatus,knowledgeBreadcrumbs,knowledgeMoveTargets,normalizeResourceSourceSelection,pendingResourceDrafts,resourceManagerCopy,resourceGovernanceFacts,resourceListMetadata,resourceScopeLabel,resourceStatusDirectory,withdrawnWorkResources,workResourceCategories,workResourceSources} from '../src/client/resource-manager-presentation.ts'

const directory:ResourceDirectory={
  drafts:[
    {id:'10000000-0000-4000-8000-000000000001',ownerId:'self',requestId:'20000000-0000-4000-8000-000000000001',title:'安全调查手册',sourceId:'security',sourceVersion:'a'.repeat(64),scopeIds:['SOC'],version:2,status:'applied',createdAt:'2026-09-12T00:00:00Z',updatedAt:'2026-09-12T00:00:00Z',resourceId:'30000000-0000-4000-8000-000000000001'},
    {id:'10000000-0000-4000-8000-000000000002',ownerId:'self',requestId:'20000000-0000-4000-8000-000000000002',title:'会议约定',sourceId:'general',sourceVersion:'b'.repeat(64),scopeIds:['general'],version:1,status:'draft',createdAt:'2026-09-12T00:00:00Z',updatedAt:'2026-09-12T00:00:00Z'},
  ],
  resources:[
    {id:'30000000-0000-4000-8000-000000000001',ownerId:'self',title:'安全调查手册',sourceId:'security',sourceVersion:'a'.repeat(64),scopeIds:['SOC'],version:1,status:'active',createdAt:'2026-09-12T00:00:00Z',updatedAt:'2026-09-12T00:00:00Z'},
    {id:'30000000-0000-4000-8000-000000000002',ownerId:'self',title:'设计规范',sourceId:'design',sourceVersion:'c'.repeat(64),scopeIds:['Design'],version:1,status:'withdrawn',createdAt:'2026-09-12T00:00:00Z',updatedAt:'2026-09-12T00:00:00Z'},
  ],
}

const sources:SourceReference[]=[
  {id:'security',title:'SOC 调查手册来源',source:'resource/security',version:'a'.repeat(64),bytes:12,knowledge:{knowledgeId:'40000000-0000-4000-8000-000000000001',knowledgeVersion:4,workspaceId:'default',category:'sop',topics:['调查','事件响应'],scopeIds:['SOC','AppSec']}},
  {id:'design',title:'设计规范旧来源',source:'resource/design',version:'c'.repeat(64),bytes:13},
  {id:'general',title:'通用资料来源',source:'resource/general',version:'b'.repeat(64),bytes:14,knowledge:{knowledgeId:'40000000-0000-4000-8000-000000000002',knowledgeVersion:2,workspaceId:'default',category:'policy',topics:['协作'],scopeIds:['general']}},
]

const knowledgeTree:KnowledgeTree={
  space:{id:'space_default',ownerId:'self',workspaceId:'default',title:'知识库',rootNodeId:'root_default',directoryRevision:8,scopeIds:['general'],createdAt:'2026-09-12T00:00:00Z',updatedAt:'2026-09-12T00:00:00Z'},
  nodes:[
    {id:'root_default',spaceId:'space_default',parentId:null,type:'space',title:'知识库',siblingOrder:0,path:['root_default'],createdAt:'2026-09-12T00:00:00Z',updatedAt:'2026-09-12T00:00:00Z'},
    {id:'folder_security',spaceId:'space_default',parentId:'root_default',type:'folder',title:'安全运营',siblingOrder:0,path:['root_default','folder_security'],createdAt:'2026-09-12T00:00:00Z',updatedAt:'2026-09-12T00:00:00Z'},
    {id:'folder_incident',spaceId:'space_default',parentId:'folder_security',type:'folder',title:'事件响应',siblingOrder:0,path:['root_default','folder_security','folder_incident'],createdAt:'2026-09-12T00:00:00Z',updatedAt:'2026-09-12T00:00:00Z'},
    {id:'page_security',spaceId:'space_default',parentId:'folder_incident',type:'page',title:'真实调查页面',siblingOrder:0,path:['root_default','folder_security','folder_incident','page_security'],knowledgeId:'40000000-0000-4000-8000-000000000001',createdAt:'2026-09-12T00:00:00Z',updatedAt:'2026-09-12T00:00:00Z'},
    {id:'page_missing',spaceId:'space_default',parentId:'root_default',type:'page',title:'待恢复页面',siblingOrder:1,path:['root_default','page_missing'],knowledgeId:'50000000-0000-4000-8000-000000000001',createdAt:'2026-09-12T00:00:00Z',updatedAt:'2026-09-12T00:00:00Z'},
  ],
}

test('知识目录严格保留后端真实递归层级，并按知识身份关联 Markdown 页面',()=>{
  const tree=buildKnowledgeDirectoryTree(knowledgeTree,directory,sources,'')
  assert.equal(tree.id,'root_default')
  assert.equal(tree.children[0]?.type,'folder')
  const security=tree.children[0]
  assert.equal(security?.type==='folder'&&security.children[0]?.type,'folder')
  const incident=security?.type==='folder'?security.children[0]:undefined
  const page=incident?.type==='folder'?incident.children[0]:undefined
  assert.deepEqual(page,{type:'page',id:'page_security',title:'真实调查页面',knowledgeId:'40000000-0000-4000-8000-000000000001',resourceId:'30000000-0000-4000-8000-000000000001',status:'active'})
  assert.deepEqual(tree.children[1],{type:'page',id:'page_missing',title:'待恢复页面',knowledgeId:'50000000-0000-4000-8000-000000000001',resourceId:undefined,status:'unavailable'})
})

test('知识目录优先关联当前正文的 active 投影，不让历史 withdrawn 版本抢占页面',()=>{
  const current={...directory.resources[0]!,id:'30000000-0000-4000-8000-000000000011',sourceVersion:'d'.repeat(64)}
  const history={...directory.resources[0]!,status:'withdrawn' as const}
  const currentSources=sources.map(source=>source.id==='security'?{...source,version:'d'.repeat(64)}:source)
  const reordered={...directory,resources:[history,current,...directory.resources.slice(1)]}
  const tree=buildKnowledgeDirectoryTree(knowledgeTree,reordered,currentSources)
  const security=tree.children[0]
  const incident=security?.type==='folder'?security.children[0]:undefined
  const page=incident?.type==='folder'?incident.children[0]:undefined
  assert.deepEqual(page,{type:'page',id:'page_security',title:'真实调查页面',knowledgeId:'40000000-0000-4000-8000-000000000001',resourceId:current.id,status:'active'})
})

test('知识目录搜索保留命中页面的完整祖先路径，不把兄弟页面带入结果',()=>{
  const tree=buildKnowledgeDirectoryTree(knowledgeTree,directory,sources,'调查')
  assert.deepEqual(tree.children.map(node=>node.title),['安全运营'])
  const security=tree.children[0]
  const incident=security?.type==='folder'?security.children[0]:undefined
  assert.deepEqual(incident?.type==='folder'?incident.children.map(node=>node.title):[],['真实调查页面'])
})

test('知识目录应用分面时只保留匹配资料对应的页面和祖先路径',()=>{
  const tree=buildKnowledgeDirectoryTree(knowledgeTree,directory,sources,'',new Set([directory.resources[0]!.id]))
  assert.deepEqual(tree.children.map(item=>item.id),['folder_security'])
  const security=tree.children[0]
  assert.equal(security?.type,'folder')
  assert.deepEqual(security?.type==='folder'&&security.children[0]?.type==='folder'&&security.children[0].children.map(item=>item.id),['page_security'])
})

test('知识面包屑直接来自真实节点路径，目录根与未知节点回到知识库',()=>{
  assert.deepEqual(knowledgeBreadcrumbs(knowledgeTree,'page_security').map(item=>[item.id,item.title,item.type]),[
    ['root_default','知识库','space'],
    ['folder_security','安全运营','folder'],
    ['folder_incident','事件响应','folder'],
    ['page_security','真实调查页面','page'],
  ])
  assert.deepEqual(knowledgeBreadcrumbs(knowledgeTree,'missing').map(item=>item.title),['知识库'])
})

test('知识目录治理保护根节点，移动文件夹时排除自身、后代与当前父目录',()=>{
  assert.equal(canGovernKnowledgeNode(knowledgeTree,'root_default'),false)
  assert.equal(canGovernKnowledgeNode(knowledgeTree,'folder_security'),true)
  assert.deepEqual(knowledgeMoveTargets(knowledgeTree,'folder_security').map(item=>[item.id,item.label]),[])
  assert.deepEqual(knowledgeMoveTargets(knowledgeTree,'page_security').map(item=>[item.id,item.label]),[
    ['root_default','知识库'],
    ['folder_security','知识库 / 安全运营'],
  ])
})

test('知识库首次进入自动打开第一篇可引用文档，刷新时保留用户当前目录',()=>{
  assert.deepEqual(defaultKnowledgeSelection(knowledgeTree,directory,sources),{
    nodeId:'page_security',resourceId:'30000000-0000-4000-8000-000000000001',
  })
  assert.deepEqual(defaultKnowledgeSelection(knowledgeTree,directory,sources,'folder_incident'),{
    nodeId:'folder_incident',resourceId:undefined,
  })
  assert.deepEqual(defaultKnowledgeSelection(knowledgeTree,directory,sources,'page_security'),{
    nodeId:'page_security',resourceId:'30000000-0000-4000-8000-000000000001',
  })
  assert.deepEqual(defaultKnowledgeSelection(knowledgeTree,{drafts:[],resources:[]},sources),{
    nodeId:'root_default',resourceId:undefined,
  })
})

test('工作资料管理搜索同时筛选草案和可引用资料并忽略首尾空格与大小写',()=>{
  assert.deepEqual(filterResourceManagerDirectory(directory,'  SECURITY  '),{drafts:[],resources:[directory.resources[0]]})
  assert.deepEqual(filterResourceManagerDirectory(directory,'设计'),{drafts:[],resources:[directory.resources[1]]})
  assert.deepEqual(filterResourceManagerDirectory(directory,'  '),{drafts:[directory.drafts[1]],resources:directory.resources})
})

test('工作资料按工作空间、业务归属、主分类、主题、状态与来源做交集筛选',()=>{
  assert.deepEqual(filterResourceManagerDirectory(directory,'',sources,{workspaceId:'default',scopeId:'SOC',category:'sop',topic:'调查',status:'active',sourceId:'security'}),{drafts:[],resources:[directory.resources[0]]})
  assert.deepEqual(filterResourceManagerDirectory(directory,'事件响应',sources,{workspaceId:'default',scopeId:'AppSec'}),{drafts:[],resources:[directory.resources[0]]})
  assert.deepEqual(filterResourceManagerDirectory(directory,'',sources,{workspaceId:'default',scopeId:'SOC',category:'policy'}),{drafts:[],resources:[]})
})

test('工作空间目录只来自显式资料元数据，旧来源保留但不从标题猜归属和分类',()=>{
  const facets=buildResourceManagerFacets(directory,sources)
  assert.deepEqual(facets.workspaces.map(item=>[item.id,item.title,item.count]),[['all','全部工作空间',3],['default','当前工作空间',2]])
  assert.deepEqual(facets.scopes.map(item=>[item.id,item.count]),[['all',3],['general',1],['AppSec',1],['SOC',1]])
  assert.equal(facets.unclassifiedCount,1)
  assert.equal(facets.categories.find(item=>item.id==='sop')?.count,1)
  assert.equal(facets.categories.find(item=>item.id==='policy')?.count,1)
  assert.deepEqual(facets.topics.map(item=>item.id),['事件响应','协作','调查'])
  assert.equal(facets.employeeRelationshipAvailable,false)
})

test('知识库目录按工作空间与业务范围形成 Wiki 页面树，资料类型不混入层级',()=>{
  const tree=buildKnowledgeWikiTree(directory,sources)
  assert.deepEqual(tree.drafts.map(item=>item.title),['会议约定'])
  assert.deepEqual(tree.workspaces.map(item=>[item.id,item.title,item.count]),[['default','当前工作空间',1]])
  assert.deepEqual(tree.workspaces[0]?.folders,[])
  assert.deepEqual(tree.workspaces[0]?.documents.map(item=>item.title),['安全调查手册'])
  assert.deepEqual(tree.unclassified,[])
  assert.equal(JSON.stringify(tree).includes('SOP 与操作手册'),false)
  assert.equal(JSON.stringify(tree).includes('AppSec'),false)
})

test('工作资料详情使用显式知识元数据，缺失治理信息明确标为待接入或待核验',()=>{
  const known=Object.fromEntries(resourceGovernanceFacts(directory.resources[0]!,sources[0]))
  assert.equal(known['工作空间'],'当前工作空间')
  assert.equal(known['业务归属'],'SOC · AppSec')
  assert.equal(known['主分类'],'SOP 与操作手册')
  assert.equal(known['固定正文版本'],'v4')
  assert.equal(known['主题'],'调查 · 事件响应')
  assert.equal(known['使用员工'],'待接入')
  assert.equal(known['权限状态'],'待核验')
  assert.equal(known['同步状态'],'待接入')
  const legacy=Object.fromEntries(resourceGovernanceFacts(directory.resources[1]!,sources[1]))
  assert.equal(legacy['业务归属'],'待接入')
  assert.equal(legacy['主分类'],'待接入')
  assert.equal(legacy['主题'],'待接入')
})

test('知识库用简单语言解释知识沉淀与引用',()=>{
  assert.match(resourceManagerCopy.scopeDescription,/业务知识/)
  assert.match(resourceManagerCopy.scopeDescription,/员工和任务/)
  assert.equal(resourceManagerCopy.preparingTitle,'待核对版本')
  assert.match(resourceManagerCopy.preparingDescription,/提交前不会进入工作引用/)
  assert.equal(resourceManagerCopy.availableTitle,'可引用资料')
  assert.match(resourceManagerCopy.availableDescription,/会话用 @ 引用/)
  assert.equal(resourceManagerCopy.submitAction,'加入资料')
})

test('工作资料目录把会话作为新增入口，并区分资料用途与来源维度',()=>{
  assert.match(resourceManagerCopy.sessionEntryDescription,/会话/)
  assert.match(resourceManagerCopy.sessionEntryDescription,/仅当前会话/)
  assert.deepEqual(workResourceCategories.map(category=>category.title),[
    '业务说明','制度与规范','SOP 与操作手册','标准与判据','案例与参考','模板与素材','系统与数据说明',
  ])
  assert.deepEqual(workResourceSources.map(source=>source.title),['粘贴文本','上传文件','在线文档','行业模板','公共资料'])
  assert.match(workResourceSources[0]!.description,/当前会话/)
  assert.match(workResourceSources[1]!.description,/待来源适配接入/)
  assert.match(workResourceSources[2]!.description,/待连接与授权接入/)
})

test('知识列表只展示类型与来源，复杂治理字段留在详情',()=>{
  assert.equal(resourceListMetadata(directory.resources[0]!,sources[0]),'SOP 与操作手册 · SOC 调查手册来源')
  assert.equal(resourceListMetadata(directory.resources[1]!,sources[1]),'待整理 · 设计规范旧来源')
})

test('待提交区域不把已提交版本重复展示成待处理项',()=>{
  assert.deepEqual(pendingResourceDrafts(directory),[directory.drafts[1]])
})

test('可引用目录与历史目录按资源状态分组，没有可引用资料时仍能核对撤回历史',()=>{
  assert.deepEqual(activeWorkResources(directory),[directory.resources[0]])
  assert.deepEqual(withdrawnWorkResources(directory),[directory.resources[1]])
  assert.deepEqual(defaultResourceSelection({...directory,drafts:[]}),{kind:'resource',resource:directory.resources[0]})
  assert.deepEqual(defaultResourceSelection({drafts:[],resources:[directory.resources[1]!]}),{kind:'resource',resource:directory.resources[1]})
})

test('默认选择优先待核对草案，再选择可引用资料',()=>{
  assert.deepEqual(defaultResourceSelection(directory),{kind:'draft',draft:directory.drafts[1]})
})

test('界面把通用范围标识转换为用户术语',()=>{
  assert.equal(resourceScopeLabel('general'),'通用')
  assert.equal(resourceScopeLabel('SOC'),'SOC')
})

test('来源失效时回退到当前第一个可用来源，并保留仍可用来源的固定版本',()=>{
  const sources=[
    {id:'general',title:'公共资料',source:'resource/公共资料',version:'a'.repeat(64),bytes:12},
    {id:'industry',title:'行业模板',source:'industry',version:'b'.repeat(64),bytes:13},
  ]
  assert.deepEqual(normalizeResourceSourceSelection(sources,'gone','c'.repeat(64)),{id:'general',version:'a'.repeat(64)})
  assert.deepEqual(normalizeResourceSourceSelection(sources,'industry','d'.repeat(64)),{id:'industry',version:'d'.repeat(64)})
  assert.deepEqual(normalizeResourceSourceSelection([], 'gone','c'.repeat(64)),{id:'',version:''})
})

test('三栏目录用真实状态收拢对象并给出准确计数',()=>{
  assert.deepEqual(resourceStatusDirectory(directory).map(item=>[item.id,item.count]),[['all',3],['draft',1],['active',1],['withdrawn',1]])
  assert.deepEqual(filterResourceManagerStatus(directory,'draft'),{drafts:[directory.drafts[1]],resources:[]})
  assert.deepEqual(filterResourceManagerStatus(directory,'active'),{drafts:[],resources:[directory.resources[0]]})
  assert.deepEqual(filterResourceManagerStatus(directory,'withdrawn'),{drafts:[],resources:[directory.resources[1]]})
})

test('正式知识库采用 Wiki 目录、文档正文和版本信息的稳定布局',async()=>{
  const source=await readFile(new URL('../src/client/ResourceManager.tsx',import.meta.url),'utf8')
  assert.match(source,/aria-label=\{t\('knowledge\.directory'\)\}/)
  assert.match(source,/WikiKnowledgeTree/)
  assert.match(source,/api\.knowledgeTree\(\)/)
  assert.match(source,/buildKnowledgeDirectoryTree/)
  assert.match(source,/knowledgeBreadcrumbs/)
  assert.match(source,/api\.createKnowledgeFolder/)
  assert.match(source,/api\.renameKnowledgeNode/)
  assert.match(source,/api\.moveKnowledgeNode/)
  assert.doesNotMatch(source,/disabled=\{!page\.resourceId\}/)
  assert.match(source,/t\('knowledge\.manager\.bodyUnavailable'\)/)
  assert.match(source,/setSelectedNodeId\(page\.id\)/)
  assert.match(source,/className=\{css\.wikiTree\}/)
  assert.doesNotMatch(source,/role="tree(?:item)?"/)
  assert.doesNotMatch(source,/aria-label="知识筛选"/)
  assert.match(source,/aria-label=\{t\('knowledge\.manager\.detailAria'\)\}/)
  assert.doesNotMatch(source,/>筛选当前目录</)
  assert.match(source,/t\('knowledge\.manager\.sourceFacts'\)/)
  assert.match(source,/KnowledgeDocument/)
  assert.doesNotMatch(source,/使用员工待接入/)
  assert.doesNotMatch(source,/本人 · 资料治理/)
  assert.doesNotMatch(source,/旧资料缺少/)
  assert.doesNotMatch(source,/aria-label="知识列表"/)
})

test('资料目录不把分面筛选暴露在阅读目录中，资料树始终按完整层级呈现',async()=>{
  const source=await readFile(new URL('../src/client/ResourceManager.tsx',import.meta.url),'utf8')
  assert.match(source,/filterResourceManagerDirectory\(knowledgeDirectory,'',sources\)/)
  assert.match(source,/buildKnowledgeDirectoryTree\(knowledgeTree,knowledgeDirectory,sources\)/)
  assert.doesNotMatch(source,/ResourceManagerFacetFilters/)
  assert.doesNotMatch(source,/DirectoryFilterPopover/)
})

test('会话回执的资料目标会刷新目录并精确选中，不被待核对草案抢占',async()=>{
  const source=await readFile(new URL('../src/client/ResourceManager.tsx',import.meta.url),'utf8')
  assert.match(source,/targetResource/)
  assert.match(source,/inspectResource\(resource\)/)
  assert.doesNotMatch(source,/setQuery\(''\)/)
  assert.match(source,/void refresh\(\)/)
})

test('知识深链只在新资源选中态提交后清理一次性目标',async()=>{
  const source=await readFile(new URL('../src/client/ResourceManager.tsx',import.meta.url),'utf8')
  const success=source.match(/if\(targetResource\)\{const resource=.*?if\(resource\)\{(.*?)\}else/s)?.[1]??''
  assert.ok(success,'应存在知识资源深链成功分支')
  assert.doesNotMatch(success,/clearTarget\(\)/,'异步刷新内立即清理会触发携带旧选择的第二次刷新')
  assert.match(source,/useEffect\(\(\)=>\{if\(targetResource&&selectedResourceId===targetResource\.id\)clearTarget\(\)\}/,'只有新资源已经成为实际选中项后才能清理目标')
})
