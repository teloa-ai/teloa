import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError,type KnowledgeItem} from '@teloa/contract'
import {MarkdownKnowledgeCatalog,markdownKnowledgeReferenceId} from '../src/capabilities/markdown-knowledge-catalog.ts'

const owner='owner',knowledgeId='11111111-1111-4111-8111-111111111111',sourceId='22222222-2222-4222-8222-222222222222',hash='a'.repeat(64)
const item={id:knowledgeId,ownerId:owner,sourceId,sourceType:'paste' as const,workspaceId:'default',title:'发布 SOP',category:'sop' as const,topics:['发布'],scopeIds:['general'],currentVersion:1,status:'active' as const,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z'}
const summary={knowledgeId,ownerId:owner,sourceId,sourceType:'paste' as const,version:1,contentHash:hash,bytes:5,createdAt:'2026-09-12T00:00:00.000Z'}
const actor={ownerId:owner,kind:'human' as const,scopeIds:['general']}
const service=(overrides:Record<string,unknown>={})=>({list:async()=>[item],get:async()=>item,listVersions:async()=>[summary],readVersion:async()=>({...summary,markdown:'# SOP'}),...overrides})

test('Markdown 目录投影真实范围、类型与主题并按摘要读取固定正文',async()=>{
 const catalog=new MarkdownKnowledgeCatalog(service())
 const list=await catalog.list({actor});assert.deepEqual(list.references[0]?.knowledge,{knowledgeId,knowledgeVersion:1,workspaceId:'default',category:'sop',topics:['发布'],scopeIds:['general']})
 const read=await catalog.read(markdownKnowledgeReferenceId(knowledgeId),hash,{actor,scopeIds:['general']});assert.equal(read.text,'# SOP')
 await assert.rejects(catalog.read(markdownKnowledgeReferenceId(knowledgeId),'0'.repeat(64),{actor,scopeIds:['general']}),{code:'teloa/version-conflict'})
})

test('owner、workspace、scope 或摘要身份不一致均拒绝',async()=>{
 for(const changed of [{...item,ownerId:'other'},{...item,workspaceId:'other'},{...item,scopeIds:['private']}]){
  const catalog=new MarkdownKnowledgeCatalog(service({get:async()=>changed}));await assert.rejects(catalog.read(markdownKnowledgeReferenceId(knowledgeId),hash,{actor,scopeIds:['general']}),{code:'teloa/forbidden'})
 }
 const corrupt=new MarkdownKnowledgeCatalog(service({readVersion:async()=>({...summary,contentHash:'0'.repeat(64),markdown:'# SOP'})}));await assert.rejects(corrupt.read(markdownKnowledgeReferenceId(knowledgeId),hash,{actor,scopeIds:['general']}),{code:'teloa/storage-corrupt'})
})

test('逐项固定正文读取只取指定知识，不重复扫描本人全目录',async()=>{
 const ids=Array.from({length:40},(_,index)=>`11111111-1111-4111-8111-${String(index).padStart(12,'0')}`),calls:string[]=[]
 const catalog=new MarkdownKnowledgeCatalog(service({
  list:async()=>{throw Error('逐项读取不应列出全部知识')},
  get:async(_actor:unknown,input:{knowledgeId:string})=>{calls.push(input.knowledgeId);return {...item,id:input.knowledgeId}},
  listVersions:async(_actor:unknown,input:{knowledgeId:string})=>[{...summary,knowledgeId:input.knowledgeId}],
  readVersion:async(_actor:unknown,input:{knowledgeId:string})=>({...summary,knowledgeId:input.knowledgeId,markdown:'# SOP'}),
 }))
 for(const id of ids)assert.equal((await catalog.read(markdownKnowledgeReferenceId(id),hash,{actor,scopeIds:['general']})).text,'# SOP')
 assert.deepEqual(calls,ids)
})

test('指定知识读取逐次核对撤回、范围、身份和固定版本，不缓存旧授权或正文',async()=>{
 let current:KnowledgeItem={...item},body={...summary,markdown:'# SOP'},reads=0,visible=true
 const catalog=new MarkdownKnowledgeCatalog(service({get:async()=>{if(!visible)throw new WorkError('teloa/forbidden','知识已撤回或当前不可见。');return current},readVersion:async()=>{reads++;return body}})),read=()=>catalog.read(markdownKnowledgeReferenceId(knowledgeId),hash,{actor,scopeIds:['general']})
 await read();assert.equal(reads,1)
 visible=false;await assert.rejects(read(),{code:'teloa/forbidden'});assert.equal(reads,1);visible=true
 for(const changed of [{...item,scopeIds:['private']},{...item,ownerId:'other'},{...item,workspaceId:'other'},{...item,id:sourceId}]){
  current=changed;await assert.rejects(read(),{code:'teloa/forbidden'});assert.equal(reads,1)
 }
 current={...item,currentVersion:2};body={...summary,contentHash:'b'.repeat(64),markdown:'# changed'}
 await assert.rejects(read(),{code:'teloa/storage-corrupt'});assert.equal(reads,2)
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
