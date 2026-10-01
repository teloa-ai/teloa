import test from 'node:test'
import assert from 'node:assert/strict'
import {filterWorkspaceSearchResults,searchWorkspace} from '../src/client/workspace-search.ts'
import {searchableKnowledgeDocuments} from '../src/client/workspace-search-knowledge.ts'
const source={conversations:[],tasks:[{storage:'persistent' as const,id:'same',title:'研究任务',goal:'核对公开证据',state:'ready' as const,scope:'general' as const}],roles:[{storage:'persistent' as const,id:'same',name:'研究岗位',duty:'核对来源',state:'paused' as const}],groups:[{storage:'persistent' as const,id:'same',name:'研究协作',announcement:'项目沟通',archived:false}],spaces:[{storage:'persistent' as const,scope:'space-research' as const,title:'研究业务'}],knowledge:[],capabilities:[{key:'skill:20000000-0000-4000-8000-000000000001',id:'20000000-0000-4000-8000-000000000001',type:'skill' as const,title:'事件报告',detail:'生成可审阅报告',open:{kind:'installation' as const,id:'skill:20000000-0000-4000-8000-000000000001' as const}}],market:[{id:'market-security-solution',title:'SOC 告警研判方案',summary:'分析告警并形成可审阅结论'}]}
test('搜索按对象分类并保留稳定身份，同名同ID不混淆',()=>{
 const result=searchWorkspace(source,'  研究 ')
 assert.deepEqual(result.map(row=>[row.kind,row.id]),[['task','same'],['group','same'],['role','same'],['business','space-research']])
 assert.equal(new Set(result.map(row=>row.key)).size,4)
 assert.equal(result.find(row=>row.kind==='role')?.detailKey,'status.paused')
})

test('全局搜索分类只收窄当前结果且不改动原顺序',()=>{
 const rows=searchWorkspace(source,'研究')
 assert.deepEqual(filterWorkspaceSearchResults(rows,'all'),rows)
 assert.deepEqual(filterWorkspaceSearchResults(rows,'task').map(row=>row.kind),['task'])
 assert.deepEqual(filterWorkspaceSearchResults(rows,'group').map(row=>row.kind),['group'])
 assert.deepEqual(rows.map(row=>row.kind),['task','group','role','business'])
})

test('知识搜索只投影可访问目录中的当前 active Markdown 页面，并保留可打开的资源身份',()=>{
 const knowledgeId='11111111-1111-4111-8111-111111111111',resourceId='22222222-2222-4222-8222-222222222222',withdrawnId='33333333-3333-4333-8333-333333333333',hash='a'.repeat(64),now='2026-09-14T00:00:00.000Z'
 const tree={space:{id:'knowledge-space-default',ownerId:'owner',workspaceId:'default',title:'团队知识',rootNodeId:'knowledge-root-default',directoryRevision:1,scopeIds:['general'],createdAt:now,updatedAt:now},nodes:[
  {id:'knowledge-root-default',spaceId:'knowledge-space-default',parentId:null,type:'space' as const,title:'团队知识',siblingOrder:0,path:['knowledge-root-default'],createdAt:now,updatedAt:now},
  {id:'security-guides',spaceId:'knowledge-space-default',parentId:'knowledge-root-default',type:'folder' as const,title:'安全手册',siblingOrder:0,path:['knowledge-root-default','security-guides'],createdAt:now,updatedAt:now},
  {id:'knowledge-page-'+knowledgeId,spaceId:'knowledge-space-default',parentId:'security-guides',type:'page' as const,title:'告警研判流程',siblingOrder:0,path:['knowledge-root-default','security-guides','knowledge-page-'+knowledgeId],knowledgeId,createdAt:now,updatedAt:now},
  {id:'knowledge-page-44444444-4444-4444-8444-444444444444',spaceId:'knowledge-space-default',parentId:'security-guides',type:'page' as const,title:'仅有目录的页面',siblingOrder:1,path:['knowledge-root-default','security-guides','knowledge-page-44444444-4444-4444-8444-444444444444'],knowledgeId:'44444444-4444-4444-8444-444444444444',createdAt:now,updatedAt:now},
 ]}
 const sourceId='knowledge_'+knowledgeId,sources=[{id:sourceId,title:'SOC 告警研判',source:'knowledge:'+knowledgeId+'@2',version:hash,bytes:128,knowledge:{knowledgeId,knowledgeVersion:2,workspaceId:'default',category:'sop' as const,topics:['SOC','告警'],scopeIds:['general']}}]
 const base={ownerId:'owner',version:1,title:'SOC 告警研判',sourceId,sourceVersion:hash,scopeIds:['general'],createdAt:now,updatedAt:now}
 const directory={drafts:[{...base,id:'55555555-5555-4555-8555-555555555555',requestId:'66666666-6666-4666-8666-666666666666',status:'draft' as const}],resources:[{...base,id:withdrawnId,status:'withdrawn' as const},{...base,id:resourceId,status:'active' as const}]}
 const rows=searchableKnowledgeDocuments(tree,directory,sources)
 assert.deepEqual(rows,[{id:resourceId,knowledgeId,nodeId:'knowledge-page-'+knowledgeId,title:'告警研判流程',resourceTitle:'SOC 告警研判',version:2,category:'sop',topics:['SOC','告警'],scopeIds:['general'],path:['团队知识','安全手册','告警研判流程']}])
 const searchSource={...source,knowledge:rows,market:[]}
 assert.deepEqual(searchWorkspace(searchSource,'安全手册').map(row=>[row.kind,row.id]),[['knowledge',resourceId]])
 assert.deepEqual(searchWorkspace(searchSource,'SOC').map(row=>[row.kind,row.id]),[['knowledge',resourceId]])
 assert.equal(searchWorkspace(searchSource,knowledgeId)[0]?.id,resourceId)

 assert.deepEqual(searchableKnowledgeDocuments(tree,{...directory,resources:[{...base,id:resourceId,status:'active' as const,sourceVersion:'b'.repeat(64)}]},sources),[],'正文版本与活动投影不一致时不能进入搜索')
 assert.deepEqual(searchableKnowledgeDocuments(tree,directory,[{...sources[0]!,knowledge:{...sources[0]!.knowledge!,workspaceId:'another'}}]),[],'其它工作空间来源不能进入搜索')
 assert.deepEqual(searchableKnowledgeDocuments(tree,{...directory,resources:[{...base,id:resourceId,status:'active' as const,scopeIds:['SOC']}]},sources),[],'越出当前知识来源范围的投影不能进入搜索')
})

test('全局搜索排除页面示例与未持久化对象',()=>{
 const preview={...source,
  tasks:[...source.tasks,{id:'preview-task',title:'研究示例任务',goal:'示例',state:'ready' as const,scope:'general' as const}],
  roles:[...source.roles,{id:'preview-role',name:'研究示例岗位',duty:'示例',state:'active' as const}],
  groups:[...source.groups,{id:'preview-group',name:'研究示例群',announcement:'示例',archived:false}],
  spaces:[...source.spaces,{scope:'space-preview' as const,title:'研究示例业务'}],
 }
 assert.deepEqual(searchWorkspace(preview,'研究示例').map(row=>row.id),[])
})
test('搜索可匹配工作目标，忽略归档群，空查询列出全部，不改动输入目录',()=>{
 const before=structuredClone(source)
 assert.deepEqual(searchWorkspace(source,'公开证据').map(row=>row.kind),['task'])
 assert.deepEqual(searchWorkspace({...source,groups:[{...source.groups[0]!,archived:true}]},'研究').map(row=>row.kind),['task','role','business'])
 assert.ok(searchWorkspace(source,'  ').length>=searchWorkspace(source,'研究').length,'空查询照原型列出全部条目')
 assert.deepEqual(searchWorkspace(source,'  '),searchWorkspace(source,''))
 assert.deepEqual(source,before)
})

test('搜索真实团队能力的名称和说明，结果携带原能力的稳定打开目标',()=>{
 const result=searchWorkspace(source,'可审阅报告')
 assert.deepEqual(result,[{key:'capability:skill:20000000-0000-4000-8000-000000000001',kind:'capability',id:'20000000-0000-4000-8000-000000000001',title:'事件报告',detailKey:'workspaceSearch.detail.skill',open:{kind:'installation',id:'skill:20000000-0000-4000-8000-000000000001'}}])
})

test('市场分组只搜索当前传入的可见条目，使用稳定条目 id 与本地化标题和摘要',()=>{
 const result=searchWorkspace(source,'可审阅结论')
 assert.deepEqual(result,[{key:'market:market-security-solution',kind:'market',id:'market-security-solution',title:'SOC 告警研判方案',detailKey:'workspaceSearch.detail.market'}])
 assert.deepEqual(filterWorkspaceSearchResults(searchWorkspace(source,'SOC'),'market').map(row=>row.id),['market-security-solution'])
 assert.deepEqual(searchWorkspace({...source,market:[]},'SOC').filter(row=>row.kind==='market'),[],'移出当前市场目录后不残留搜索结果')
})

import {presentConversations} from '../src/client/work-presentation.ts'
import type {Conversation} from '@teloa/contract'
test('会话搜索只返回完成绑定的目录项，不从原生摘要引入私人会话',()=>{
 const ready:Conversation={id:'work-ready',sessionId:'ready',requestedSessionId:'ready',ownerId:'owner',title:'研究会话',scopeIds:['general'],version:1,status:'ready',createdAt:'2026-09-11T00:00:00Z'}
 const conversations=presentConversations([ready,{...ready,id:'work-pending',sessionId:'pending',status:'pending'}],[{id:'private',title:'研究私密会话',running:false,blank:false,updatedAt:1}])
 assert.deepEqual(searchWorkspace({...source,conversations},'研究').filter(row=>row.kind==='conversation').map(row=>row.id),['work-ready'])
})
