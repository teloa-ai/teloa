import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {createResourceApi} from '../src/client/resource-api.ts'
import {knowledgeCopyJournal} from '../src/client/knowledge-copy-journal.ts'
import type {KnowledgeCopyPreview,KnowledgeCopyResult,WorkResource} from '@teloa/contract'
const markdown='# 固定SOP',hash=createHash('sha256').update(markdown).digest('hex'),stamp='2026-10-26T00:00:00Z',id=randomUUID(),kid=randomUUID(),native=randomUUID()
const original:WorkResource={id,ownerId:'self',title:'SOP',sourceId:'industry_'+randomUUID()+'_'+randomUUID(),sourceVersion:hash,scopeIds:['general'],version:1,status:'active',createdAt:stamp,updatedAt:stamp}
const origin={resourceId:id,resourceVersion:1,sourceId:original.sourceId,sourceTitle:'原SOP',sourceVersion:hash,contentId:randomUUID(),contentHash:'a'.repeat(64),packageVersion:'1.0.0',localId:'sop',publisher:'合成作者',license:{status:'declared' as const,value:'MIT'}}
const preview:KnowledgeCopyPreview={origin,title:original.title,markdown,scopeIds:['general']}
const result:KnowledgeCopyResult={origin,knowledge:{item:{id:kid,ownerId:'self',sourceId:native,sourceType:'paste',workspaceId:'default',title:'独立副本',category:'reference',topics:[],scopeIds:['general'],currentVersion:1,status:'active',createdAt:stamp,updatedAt:stamp},version:{knowledgeId:kid,ownerId:'self',sourceId:native,sourceType:'paste',version:1,contentHash:hash,bytes:Buffer.byteLength(markdown),createdAt:stamp,markdown}},resource:{...original,id:randomUUID(),title:'独立副本',sourceId:'knowledge_'+kid}}
const ref={resourceId:id,expectedResourceVersion:1,sourceVersion:hash},input={...ref,requestId:randomUUID(),title:'独立副本',markdown}
test('副本API沿固定资料身份读预览、创建和来源，拒绝错误摘要或串对象回包',async()=>{
 const calls:unknown[]=[],api=createResourceApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return endpoint==='knowledge/copy-preview'?preview:endpoint==='knowledge/copy'?result:origin})
 assert.deepEqual(await api.previewKnowledgeCopy!(ref),preview);assert.deepEqual(await api.createKnowledgeCopy!(input),result);assert.deepEqual(await api.knowledgeCopyOrigin!(kid),origin)
 assert.deepEqual(calls,[['knowledge/copy-preview',ref],['knowledge/copy',input],['knowledge/copy-origin',{knowledgeId:kid}]])
 for(const response of [{...preview,markdown:'# 串正文'},{...preview,origin:{...origin,resourceId:randomUUID()}},{...preview,origin:{...origin,sourceVersion:'b'.repeat(64)}}])await assert.rejects(createResourceApi(async()=>response).previewKnowledgeCopy!(ref),/格式/)
 for(const response of [{...result,resource:{...result.resource,sourceId:'knowledge_'+randomUUID()}},{...result,origin:{...origin,resourceVersion:2}},{...result,knowledge:{...result.knowledge,version:{...result.knowledge.version,markdown:'# 串正文',bytes:Buffer.byteLength('# 串正文')}}}])await assert.rejects(createResourceApi(async()=>response).createKnowledgeCopy!(input),/格式/)
})
test('副本草稿按本人和原版本恢复，pending固定请求，无法持久化/损坏不丢弃重建',()=>{
 const data=new Map<string,string>(),storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)},removeItem:(key:string)=>{data.delete(key)}},journal=knowledgeCopyJournal(storage,original),draft={preview,title:'独立副本',markdown,requestId:input.requestId,pending:true}
 journal.write(draft);assert.deepEqual(knowledgeCopyJournal(storage,original).read(),draft);assert.deepEqual(journal.input(draft),input)
 assert.equal(knowledgeCopyJournal(storage,{...original,ownerId:'other'}).read(),undefined);assert.deepEqual(knowledgeCopyJournal(storage,{...original,version:2,status:'withdrawn'}).read(),draft);assert.deepEqual(knowledgeCopyJournal(storage,{...original,version:2,status:'withdrawn'}).input(draft),input);assert.equal(knowledgeCopyJournal(storage,{...original,sourceVersion:'f'.repeat(64)}).read(),undefined)
 assert.throws(()=>knowledgeCopyJournal(undefined,original).write(draft),/本地存储/);assert.throws(()=>knowledgeCopyJournal({...storage,setItem:()=>{throw Error('quota')}},original).write(draft),/quota/)
 const key=[...data.keys()][0]!;data.set(key,'{broken');assert.throws(()=>journal.read());assert.equal(data.get(key),'{broken')
})
