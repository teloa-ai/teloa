import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeResourceReference,parseResourceReferences,isResourceDraft,isResourceDirectory,isSourceReference } from '../src/resources.ts'
const id='bc3e088e-dd97-4f4a-b184-f30d9b6a3e70'
test('引用编码保留资源版本、去重同一身份，拒绝破损和过量标记',()=>{
  const ref={id,version:2},token=encodeResourceReference(ref)
  assert.deepEqual(parseResourceReferences('请阅读 '+token+' '+token),[ref])
  assert.deepEqual(parseResourceReferences(token+encodeResourceReference({...ref,version:3})),[ref,{...ref,version:3}])
  assert.throws(()=>parseResourceReferences('[[teloa-resource:'+id+'@0]]'))
  assert.throws(()=>parseResourceReferences('[[teloa-resource:'+id+'@2'))
  assert.throws(()=>parseResourceReferences(Array.from({length:9},(_,i)=>encodeResourceReference({...ref,version:i+1})).join(' ')))
})
test('知识来源投影沿用工作资料主题边界',()=>{
  const source={id:'knowledge_'+id,title:'资料',source:'对话沉淀',version:'a'.repeat(64),bytes:10,knowledge:{knowledgeId:id,knowledgeVersion:1,workspaceId:'default',category:'sop',topics:['发布检查'],scopeIds:['general']}}
  assert.equal(isSourceReference(source),true)
  assert.equal(isSourceReference({...source,unexpectedToken:'secret'}),false)
  assert.equal(isSourceReference({...source,knowledge:{...source.knowledge,ownerId:'forged'}}),false)
  assert.equal(isSourceReference({...source,knowledge:{...source.knowledge,topics:[' 重复']}}),false)
  assert.equal(isSourceReference({...source,knowledge:{...source.knowledge,topics:['重复','重复']}}),false)
  assert.equal(isSourceReference({...source,knowledge:{...source.knowledge,topics:['x'.repeat(81)]}}),false)
})
test('损坏的草案状态和目录不能通过跨边界合同',()=>{
  const draft={id,requestId:id,ownerId:'owner',version:1,status:'draft',title:'资料',sourceId:'reference',sourceVersion:'a'.repeat(64),scopeIds:['general'],createdAt:'2026-09-10T00:00:00Z',updatedAt:'2026-09-10T00:00:00Z'}
  assert.equal(isResourceDraft(draft),true)
  assert.equal(isResourceDraft({...draft,status:'applied'}),false)
  assert.equal(isResourceDraft({...draft,status:'draft',resourceId:id}),false)
  assert.equal(isResourceDirectory({drafts:[draft],resources:[]}),true)
  assert.equal(isResourceDirectory({drafts:[{...draft,status:'ready'}],resources:[]}),false)
})
