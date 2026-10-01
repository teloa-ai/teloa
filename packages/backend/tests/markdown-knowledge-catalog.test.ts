import test from 'node:test'
import assert from 'node:assert/strict'
import {MarkdownKnowledgeCatalog,markdownKnowledgeReferenceId} from '../src/capabilities/markdown-knowledge-catalog.ts'

const owner='owner',knowledgeId='11111111-1111-4111-8111-111111111111',sourceId='22222222-2222-4222-8222-222222222222',hash='a'.repeat(64)
const item={id:knowledgeId,ownerId:owner,sourceId,sourceType:'paste' as const,workspaceId:'default',title:'发布 SOP',category:'sop' as const,topics:['发布'],scopeIds:['general'],currentVersion:1,status:'active' as const,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z'}
const summary={knowledgeId,ownerId:owner,sourceId,sourceType:'paste' as const,version:1,contentHash:hash,bytes:5,createdAt:'2026-09-12T00:00:00.000Z'}
const actor={ownerId:owner,kind:'human' as const,scopeIds:['general']}
const service=(overrides:Record<string,unknown>={})=>({list:async()=>[item],listVersions:async()=>[summary],readVersion:async()=>({...summary,markdown:'# SOP'}),...overrides})

test('Markdown 目录投影真实范围、类型与主题并按摘要读取固定正文',async()=>{
 const catalog=new MarkdownKnowledgeCatalog(service())
 const list=await catalog.list({actor});assert.deepEqual(list.references[0]?.knowledge,{knowledgeId,knowledgeVersion:1,workspaceId:'default',category:'sop',topics:['发布'],scopeIds:['general']})
 const read=await catalog.read(markdownKnowledgeReferenceId(knowledgeId),hash,{actor,scopeIds:['general']});assert.equal(read.text,'# SOP')
 await assert.rejects(catalog.read(markdownKnowledgeReferenceId(knowledgeId),'0'.repeat(64),{actor,scopeIds:['general']}),{code:'teloa/version-conflict'})
})

test('owner、workspace、scope 或摘要身份不一致均拒绝',async()=>{
 for(const changed of [{...item,ownerId:'other'},{...item,workspaceId:'other'},{...item,scopeIds:['private']}]){
  const catalog=new MarkdownKnowledgeCatalog(service({list:async()=>[changed]}));await assert.rejects(catalog.read(markdownKnowledgeReferenceId(knowledgeId),hash,{actor,scopeIds:['general']}),{code:'teloa/forbidden'})
 }
 const corrupt=new MarkdownKnowledgeCatalog(service({readVersion:async()=>({...summary,contentHash:'0'.repeat(64),markdown:'# SOP'})}));await assert.rejects(corrupt.read(markdownKnowledgeReferenceId(knowledgeId),hash,{actor,scopeIds:['general']}),{code:'teloa/storage-corrupt'})
})

test('Markdown 目录按来源与版本给出登记字节数，不读正文；越权或版本不符不给',async()=>{
 const reads:unknown[]=[],ref={id:markdownKnowledgeReferenceId(knowledgeId),version:hash}
 const catalog=new MarkdownKnowledgeCatalog(service({readVersion:async(...args:unknown[])=>{reads.push(args);throw Error('不应读正文')}}))
 assert.deepEqual([...(await catalog.sizes([ref,{...ref,version:'0'.repeat(64)},{id:'public-guide',version:hash}],{actor,scopeIds:['general']})).entries()],[[ref.id+'@'+hash,5]])
 assert.equal(reads.length,0)
 for(const changed of [{...item,ownerId:'other'},{...item,scopeIds:['private']}]){
  const denied=new MarkdownKnowledgeCatalog(service({list:async()=>[changed]}))
  assert.equal((await denied.sizes([ref],{actor,scopeIds:['general']})).size,0)
 }
 const {combineReferenceCatalogs}=await import('../src/capabilities/industry-reference-catalog.ts')
 const none={list:async()=>({schema:'teloa.reference-list/v1' as const,references:[]}),read:async()=>{throw Error('不应读取')}}
 assert.deepEqual([...(await combineReferenceCatalogs(none,none,catalog).sizes!([ref,{id:'industry_x',version:hash}],{actor,scopeIds:['general']})).entries()],[[ref.id+'@'+hash,5]])
 assert.equal((await combineReferenceCatalogs(none,none).sizes!([ref],{actor})).size,0)
})
