import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {knowledgeReceiptPresentation} from '../src/client/knowledge-receipt-presentation.ts'

const requestId='11111111-1111-4111-8111-111111111111',knowledgeId='22222222-2222-4222-8222-222222222222',resourceId='33333333-3333-4333-8333-333333333333',hash='a'.repeat(64)
const base={schema:'teloa.knowledge-save-receipt/v1',requestId,title:'发布检查',category:'sop',topics:['发布','核对'],workspaceId:'default',scopeIds:['general'],source:{sessionId:'session-1',messageId:'answer-1',seq:8,selectionHash:hash}}
const english=(key:string)=>({
 'knowledgeReceipt.category.sop':'SOPs and procedures',
 'knowledgeReceipt.scope.general':'General',
 'knowledgeReceipt.stage.resource-applying':'Publish referenceable version',
 'knowledgeReceipt.stage.knowledge-saved':'Create library reference',
}[key]??key)
const chinese=(key:string)=>({
 'knowledgeReceipt.category.sop':'SOP 与操作手册',
 'knowledgeReceipt.scope.general':'通用',
 'knowledgeReceipt.stage.resource-applying':'提交可引用版本',
 'knowledgeReceipt.stage.knowledge-saved':'创建资料引用',
}[key]??key)

test('只有合同完整的 active 回执显示已保存，且呈现真实多维分类和固定版本',()=>{
 const view=knowledgeReceiptPresentation(JSON.stringify({...base,status:'active',knowledge:{id:knowledgeId,version:2,contentHash:hash},resource:{id:resourceId,version:1}}),chinese)
 assert.deepEqual(view,{kind:'active',title:'发布检查',category:'SOP 与操作手册',topics:['发布','核对'],scope:'通用',knowledgeVersion:2,resourceVersion:1,contentHash:'aaaaaaaaaaaa',resourceId})
 assert.equal(knowledgeReceiptPresentation(JSON.stringify({...base,status:'active',knowledge:{id:knowledgeId,version:2,contentHash:hash},resource:null}),chinese),null)
})

test('待恢复和确定失败保持独立状态，不显示成功语义',()=>{
 assert.deepEqual(knowledgeReceiptPresentation(JSON.stringify({...base,status:'needs-recovery',stage:'resource-applying'}),chinese),{kind:'needs-recovery',title:'发布检查',category:'SOP 与操作手册',topics:['发布','核对'],scope:'通用',stage:'提交可引用版本'})
 assert.deepEqual(knowledgeReceiptPresentation(JSON.stringify({...base,status:'failed',stage:'knowledge-saved',error:{code:'teloa/forbidden',message:'来源范围不允许。'}}),chinese),{kind:'failed',title:'发布检查',category:'SOP 与操作手册',topics:['发布','核对'],scope:'通用',stage:'创建资料引用'})
 assert.equal(knowledgeReceiptPresentation('not json',chinese),null)
})

test('知识保存回执按当前语言呈现分类、通用范围和处理阶段',()=>{
 const active=knowledgeReceiptPresentation(JSON.stringify({...base,status:'active',knowledge:{id:knowledgeId,version:2,contentHash:hash},resource:{id:resourceId,version:1}}),english)
 assert.deepEqual(active,{kind:'active',title:'发布检查',category:'SOPs and procedures',topics:['发布','核对'],scope:'General',knowledgeVersion:2,resourceVersion:1,contentHash:'aaaaaaaaaaaa',resourceId})
 const recovery=knowledgeReceiptPresentation(JSON.stringify({...base,status:'needs-recovery',stage:'resource-applying'}),english)
 assert.equal(recovery?.kind==='needs-recovery'?recovery.stage:undefined,'Publish referenceable version')
})

test('确定失败回执不把服务端消息带入界面展示模型',()=>{
 const view=knowledgeReceiptPresentation(JSON.stringify({...base,status:'failed',stage:'knowledge-saved',error:{code:'teloa/forbidden',message:'来源范围不允许。'}}),english)
 assert.equal(view?.kind,'failed')
 assert.equal(view&&'message' in view,false)
})

test('成功回执把真实 resourceId 交给工作资料定位入口',async()=>{
 const source=await readFile(new URL('../src/client/KnowledgeSaveReceiptCard.tsx',import.meta.url),'utf8')
 assert.match(source,/openResources\(receipt\.resourceId\)/)
})
