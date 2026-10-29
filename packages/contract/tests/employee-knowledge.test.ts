import test from 'node:test'
import assert from 'node:assert/strict'
import {isEmployeeKnowledgeContent,isEmployeeKnowledgeDocument,isEmployeeKnowledgeRevision,isEmployeeKnowledgeVersion} from '../src/employee-knowledge.ts'

const roleId='a0000000-0000-4000-8000-000000000001',resourceId='a0000000-0000-4000-8000-000000000002',knowledgeId='a0000000-0000-4000-8000-000000000003',headId='a0000000-0000-4000-8000-000000000004',requestId='a0000000-0000-4000-8000-000000000005'
const contentHash='a'.repeat(64),stamp='2026-10-29T00:00:00.000Z',markdown='中文正文'
const resource={id:headId,ownerId:'local:owner',version:1,status:'active',title:'退款规则',sourceId:'knowledge_'+knowledgeId,sourceVersion:contentHash,scopeIds:['general'],createdAt:stamp,updatedAt:stamp}
const document={roleId,resourceId,documentId:'industry_source',knowledgeId,title:resource.title,bodyVersion:2,contentHash,bytes:new TextEncoder().encode(markdown).byteLength,resource,origin:{resourceId,sourceId:'industry_source',sourceVersion:'b'.repeat(64)},editing:'employee-copy',indexState:'pending'}

test('员工知识合同绑定原授权身份、独立来源和真实正文字节数',()=>{
 assert.equal(isEmployeeKnowledgeDocument(document),true)
 assert.equal(isEmployeeKnowledgeContent({...document,markdown}),true)
 assert.equal(isEmployeeKnowledgeContent({...document,markdown,ownerId:'forged'}),false)
 assert.equal(isEmployeeKnowledgeContent({...document,markdown,bytes:markdown.length}),false)
 assert.equal(isEmployeeKnowledgeDocument({...document,resource:{...resource,sourceId:'knowledge_'+resourceId}}),false)
 assert.equal(isEmployeeKnowledgeDocument({...document,origin:{...document.origin,resourceId:headId}}),false)
 assert.equal(isEmployeeKnowledgeDocument({...document,resource:{...resource,sourceVersion:'c'.repeat(64)}}),false)
 assert.equal(isEmployeeKnowledgeDocument({...document,title:'其他资料'}),false)
})

test('新导入基线可沿原身份映射新资料，并以v1和fork-on-write回读',()=>{
 const imported={...document,knowledgeId:null,bodyVersion:1,editing:'fork-on-write',resource:{...resource,sourceId:'industry_candidate'},origin:{...document.origin,sourceId:'industry_candidate'}}
 assert.equal(isEmployeeKnowledgeContent({...imported,markdown}),true)
 assert.equal(isEmployeeKnowledgeDocument({...imported,knowledgeId}),false)
})

test('员工副本仅v1可复用来源和摘要均匹配的原资源，后续版本仍须指向受管副本',()=>{
 const baseline={...document,bodyVersion:1,contentHash:document.origin.sourceVersion,resource:{...resource,id:resourceId,sourceId:document.origin.sourceId,sourceVersion:document.origin.sourceVersion}}
 assert.equal(isEmployeeKnowledgeContent({...baseline,markdown}),true)
 assert.equal(isEmployeeKnowledgeDocument({...baseline,bodyVersion:2}),false)
 assert.equal(isEmployeeKnowledgeDocument({...baseline,resource:{...baseline.resource,sourceId:'other_source'}}),false)
 assert.equal(isEmployeeKnowledgeDocument({...baseline,origin:{...baseline.origin,sourceVersion:'c'.repeat(64)}}),false)
 assert.equal(isEmployeeKnowledgeDocument({...baseline,knowledgeId:null}),false)
})

test('回执与历史摘要严格校验未知字段、操作、正文版本和索引状态',()=>{
 const result={requestId,operation:'revise',forked:true,document:{...document,markdown}}
 assert.equal(isEmployeeKnowledgeRevision(result),true)
 assert.equal(isEmployeeKnowledgeRevision({...result,operation:'delete'}),false)
 assert.equal(isEmployeeKnowledgeRevision({...result,document:{...result.document,indexState:'saved'}}),false)
 const version={version:2,contentHash,bytes:document.bytes,createdAt:stamp,resourceId:headId}
 assert.equal(isEmployeeKnowledgeVersion(version),true)
 assert.equal(isEmployeeKnowledgeVersion({...version,markdown}),false)
 assert.equal(isEmployeeKnowledgeVersion({...version,version:0}),false)
})
