import assert from 'node:assert/strict'
import test from 'node:test'
import {pinnedKnowledgeVersion,libraryPreparationRequest} from '../src/client/business-library-presentation.ts'
import {libraryRows} from '../src/client/library-views.ts'

test('固定正文按原资源摘要定位，版本不存在不能替换为当前正文',()=>{
 const rows=[{version:1,contentHash:'old'},{version:2,contentHash:'new'}] as any
 assert.equal(pinnedKnowledgeVersion({sourceVersion:'old'} as any,rows),1)
 assert.equal(pinnedKnowledgeVersion({sourceVersion:'missing'} as any,rows),undefined)
})
test('资料准备保留目标空间路径和保存意图，业务不扩展到其他范围',()=>{
 const tree={space:{id:'personal',rootNodeId:'root',scopeIds:['security']},nodes:[{id:'root',title:'个人空间',type:'space',path:['root']},{id:'folder',title:'研判资料',type:'folder',path:['root','folder']}] } as any
 const request=libraryPreparationRequest(tree,'folder','zh-CN')
 assert.equal(request.scope,'security')
 assert.equal(request.parentNodeId,'folder')
 assert.equal(request.spacePath,'个人空间 / 研判资料')
 assert.match(request.goal,/整理并保存资料/)
 assert.match(request.goal,/确认/)
})
test('目录位置使用真实空间路径，版本不冒用最新来源版本',()=>{
 const resource={id:'r',title:'同名资料',sourceId:'knowledge_k',sourceVersion:'old',version:1,status:'withdrawn',scopeIds:['general']} as any
 const source={id:'knowledge_k',source:'knowledge:k@2',version:'new',knowledge:{knowledgeId:'k',knowledgeVersion:2}} as any
 const tree={nodes:[{id:'root',title:'个人空间',type:'space'},{id:'folder',title:'方案',type:'folder'},{id:'page',title:'同名资料',type:'page',knowledgeId:'k',path:['root','folder','page']}]} as any
 const [row]=libraryRows({drafts:[],resources:[resource]},[source],{view:'mine',query:'',preferences:{recent:[],favorites:[]},tree})
 assert.equal(row?.location,'个人空间 / 方案')
 assert.equal(row?.knowledgeVersion,undefined)
 assert.equal(row?.version,1)
})
