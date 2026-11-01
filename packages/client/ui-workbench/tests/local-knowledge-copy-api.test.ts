import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {createResourceApi} from '../src/client/resource-api.ts'
import {isKnowledgeCopyOrigin,isLocalKnowledgeCopyOrigin,isLocalKnowledgeCopyPreview,isLocalKnowledgeCopyResult,type LocalKnowledgeCopyPreview,type LocalKnowledgeCopyResult} from '@teloa/contract'
const hash=(text:string)=>createHash('sha256').update(text).digest('hex'),source='\uFEFF# 原字节\r\n',markdown='# 保存副本\n',stamp='2026-10-28T00:00:00Z',id=randomUUID(),kid=randomUUID(),native=randomUUID()
const origin={kind:'local-material' as const,resourceId:id,resourceVersion:1,sourceId:'local_material_'+randomUUID(),sourceTitle:'登记名称',sourceVersion:hash(source),sourcePath:'docs/原件.md',bytes:Buffer.byteLength(source)}
const preview:LocalKnowledgeCopyPreview={origin,title:'原资料标题',markdown:source,scopeIds:['general']}
const result:LocalKnowledgeCopyResult={origin,knowledge:{item:{id:kid,ownerId:'self',sourceId:native,sourceType:'paste',workspaceId:'default',title:'本人副本',category:'reference',topics:[],scopeIds:['general'],currentVersion:1,status:'active',createdAt:stamp,updatedAt:stamp},version:{knowledgeId:kid,ownerId:'self',sourceId:native,sourceType:'paste',version:1,contentHash:hash(markdown),bytes:Buffer.byteLength(markdown),createdAt:stamp,markdown}},resource:{id:randomUUID(),ownerId:'self',title:'本人副本',sourceId:'knowledge_'+kid,sourceVersion:hash(markdown),scopeIds:['general'],version:1,status:'active',createdAt:stamp,updatedAt:stamp}}
const ref={resourceId:id,expectedResourceVersion:1,sourceVersion:hash(source)},input={...ref,requestId:randomUUID(),title:'本人副本',markdown:'\uFEFF# 保存副本\r\n'}
test('本机副本独立typed API固定原身份和原字节SHA，不借用industry来源',async()=>{
 const calls:unknown[]=[],api=createResourceApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return endpoint==='knowledge/local-copy-preview'?preview:endpoint==='knowledge/local-copy'?result:origin})
 assert.equal(typeof api.previewLocalKnowledgeCopy,'function','本机副本必须接入独立公开RPC')
 assert.deepEqual(await api.previewLocalKnowledgeCopy!(ref),preview);assert.deepEqual(await api.createLocalKnowledgeCopy!(input),result);assert.deepEqual(await api.localKnowledgeCopyOrigin!(kid),origin)
 assert.deepEqual(calls,[['knowledge/local-copy-preview',ref],['knowledge/local-copy',input],['knowledge/local-copy-origin',{knowledgeId:kid}]])
 for(const value of [{...preview,markdown:source.replace(/\r/g,'')},{...preview,markdown:source.replace('原','异')},{...preview,origin:{...origin,resourceId:randomUUID()}},{...preview,origin:{...origin,sourceVersion:'a'.repeat(64)}}])await assert.rejects(createResourceApi(async()=>value).previewLocalKnowledgeCopy!(ref),/格式/)
 for(const value of [{...result,origin:{...origin,resourceVersion:2}},{...result,resource:{...result.resource,sourceId:'knowledge_'+randomUUID()}},{...result,knowledge:{...result.knowledge,version:{...result.knowledge.version,markdown:'# 串正文'}}},{...result,knowledge:{...result.knowledge,version:{...result.knowledge.version,contentHash:'f'.repeat(64)}},resource:{...result.resource,sourceVersion:'f'.repeat(64)}}])await assert.rejects(createResourceApi(async()=>value).createLocalKnowledgeCopy!(input),/格式/)
})
test('local origin仅包含本机事实，拒绝伪许可、包身份、路径越界与串scope投影',()=>{
 assert.equal(isLocalKnowledgeCopyOrigin(origin),true);assert.equal(isKnowledgeCopyOrigin(origin),false);assert.equal(isLocalKnowledgeCopyPreview(preview),true);assert.equal(isLocalKnowledgeCopyResult(result),true)
 for(const bad of [{...origin,license:{status:'declared',value:'MIT'}},{...origin,packageVersion:'1.0.0'},{...origin,sourcePath:'/private/原件.md'},{...origin,sourcePath:'../原件.md'},{...origin,sourceId:'industry_'+randomUUID()},{...origin,bytes:128*1024+1}])assert.equal(isLocalKnowledgeCopyOrigin(bad),false)
 assert.equal(isLocalKnowledgeCopyPreview({...preview,markdown:'# 错误长度'}),false)
 assert.equal(isLocalKnowledgeCopyResult({...result,resource:{...result.resource,scopeIds:['other']}}),false)
})
