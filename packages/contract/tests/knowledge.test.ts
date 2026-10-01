import test from 'node:test'
import assert from 'node:assert/strict'
import {isKnowledgeItem,isKnowledgeVersion,isKnowledgeVersionSummary,verifyKnowledgeVersionContent} from '../src/knowledge.ts'

const item={
 id:'11111111-1111-4111-8111-111111111111',ownerId:'self',sourceId:'22222222-2222-4222-8222-222222222222',sourceType:'paste' as const,
 workspaceId:'default',title:'排障依据',category:'sop' as const,topics:['值班','排障'],scopeIds:['general'],currentVersion:1,status:'active' as const,
 createdAt:'2026-09-12T10:00:00.000Z',updatedAt:'2026-09-12T10:00:00.000Z',
}
const version={
 knowledgeId:item.id,ownerId:item.ownerId,sourceId:item.sourceId,sourceType:'paste' as const,version:1,
 contentHash:'9b58ddba2c5a01a68b829f3975f8d03069de84e1924c8488caff61b0eb20380b',bytes:new TextEncoder().encode('# 排障\n').byteLength,createdAt:item.createdAt,
}

test('知识合同校验可在没有 Node Buffer 的浏览器运行时执行',()=>{
 const prior=Reflect.get(globalThis,'Buffer')
 try{
  Reflect.set(globalThis,'Buffer',undefined)
  assert.equal(isKnowledgeItem(item),true)
  assert.equal(isKnowledgeVersionSummary(version),true)
  assert.equal(isKnowledgeVersion({...version,markdown:'# 排障\n'}),true)
  assert.equal(isKnowledgeVersion({...version,markdown:'# 篡改更多\n'}),false)
 }finally{Reflect.set(globalThis,'Buffer',prior)}
})

test('异步完整性校验拒绝等字节 Markdown 篡改，分类与主题保持独立合同',async()=>{
 assert.equal(await verifyKnowledgeVersionContent({...version,markdown:'# 排障\n'}),true)
 assert.equal(await verifyKnowledgeVersionContent({...version,markdown:'# 篡改\n'}),false)
 assert.equal(isKnowledgeItem({...item,category:'scope'}),false)
 assert.equal(isKnowledgeItem({...item,topics:['重复','重复']}),false)
 assert.equal(isKnowledgeItem({...item,topics:Array.from({length:21},(_,index)=>String(index))}),false)
})

test('粘贴知识单份正文上限为 2 MiB，与检索单来源上限一致',async()=>{
 const {retrievalLimits}=await import('../src/local-retrieval.ts')
 assert.equal(retrievalLimits.maxSourceBytes,2*1024*1024)
 assert.equal(isKnowledgeVersionSummary({...version,bytes:2*1024*1024}),true)
 assert.equal(isKnowledgeVersionSummary({...version,bytes:2*1024*1024+1}),false)
})

test('知识发布回包严格绑定目录头与不可变正文版本',async()=>{
 const module=await import('../src/knowledge.ts') as Record<string,unknown>
 const validate=module.isPasteKnowledge
 assert.equal(typeof validate,'function','知识合同必须提供发布回包校验器')
 if(typeof validate!=='function')return
 const published={item,version:{...version,markdown:'# 排障\n'}}
 assert.equal(validate(published),true)
 assert.equal(validate({...published,item:{...item,currentVersion:2}}),false)
 assert.equal(validate({...published,version:{...published.version,knowledgeId:'33333333-3333-4333-8333-333333333333'}}),false)
 assert.equal(validate({...published,unexpected:true}),false)
})

test('知识修订资源回包严格绑定新知识版本与唯一活动资源投影',async()=>{
 const module=await import('../src/knowledge.ts') as Record<string,unknown>
 const validate=module.isKnowledgeResourceRevision
 assert.equal(typeof validate,'function','知识修订必须提供知识与资源的一体化回包校验器')
 if(typeof validate!=='function')return
 const published={item,version:{...version,markdown:'# 排障\n'}}
 const resource={id:'33333333-3333-4333-8333-333333333333',ownerId:item.ownerId,title:item.title,sourceId:'knowledge_'+item.id,sourceVersion:version.contentHash,scopeIds:['general'],version:1,status:'active',createdAt:item.createdAt,updatedAt:item.createdAt}
 assert.equal(validate({knowledge:published,resource}),true)
 assert.equal(validate({knowledge:published,resource:{...resource,status:'withdrawn'}}),false)
 assert.equal(validate({knowledge:published,resource:{...resource,sourceVersion:'0'.repeat(64)}}),false)
 assert.equal(validate({knowledge:published,resource,unexpected:true}),false)
})

test('知识目录合同锁定稳定空间、父子路径与页面知识引用',async()=>{
 const module=await import('../src/knowledge.ts') as Record<string,unknown>
 const validate=module.isKnowledgeTree
 assert.equal(typeof validate,'function','知识合同必须提供目录树校验器')
 if(typeof validate!=='function')return
 const rootId='root_11111111111111111111111111111111',folderId='33333333-3333-4333-8333-333333333333',pageId='page_11111111-1111-4111-8111-111111111111'
 const space={id:'space_11111111111111111111111111111111',ownerId:'self',workspaceId:'default',title:'知识库',rootNodeId:rootId,directoryRevision:3,scopeIds:['general'],createdAt:item.createdAt,updatedAt:item.updatedAt}
 const nodes=[
  {id:rootId,spaceId:space.id,parentId:null,type:'space',title:'知识库',siblingOrder:0,path:[rootId],createdAt:item.createdAt,updatedAt:item.updatedAt},
  {id:folderId,spaceId:space.id,parentId:rootId,type:'folder',title:'排障',siblingOrder:0,path:[rootId,folderId],createdAt:item.createdAt,updatedAt:item.updatedAt},
  {id:pageId,spaceId:space.id,parentId:folderId,type:'page',title:'排障依据',siblingOrder:0,path:[rootId,folderId,pageId],knowledgeId:item.id,createdAt:item.createdAt,updatedAt:item.updatedAt},
 ]
 assert.equal(validate({space,nodes}),true)
 assert.equal(validate({space,nodes:nodes.map((node,index)=>index===2?{...node,path:[rootId,pageId]}:node)}),false)
 assert.equal(validate({space,nodes:nodes.map((node,index)=>index===2?{...node,knowledgeId:undefined}:node)}),false)
 assert.equal(validate({space,nodes:nodes.map((node,index)=>index===2?{...node,siblingOrder:1}:node)}),false)
 const pageParent={id:'44444444-4444-4444-8444-444444444444',spaceId:space.id,parentId:pageId,type:'folder',title:'非法子目录',siblingOrder:0,path:[rootId,folderId,pageId,'44444444-4444-4444-8444-444444444444'],createdAt:item.createdAt,updatedAt:item.updatedAt}
 assert.equal(validate({space,nodes:[...nodes,pageParent]}),false,'Markdown 页面必须是叶子节点')
})
