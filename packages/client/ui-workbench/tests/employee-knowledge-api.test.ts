import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash} from 'node:crypto'
import {createEmployeeKnowledgeApi} from '../src/client/employee-knowledge-api.ts'
const roleId='10000000-0000-4000-8000-000000000001',resourceId='20000000-0000-4000-8000-000000000001',requestId='30000000-0000-4000-8000-000000000001',at='2026-10-29T00:00:00.000Z',markdown='# 员工资料',contentHash=createHash('sha256').update(markdown).digest('hex')
const resource={id:resourceId,ownerId:'self',title:'资料',sourceId:'industry_source',sourceVersion:contentHash,scopeIds:['general'],version:1,status:'active' as const,createdAt:at,updatedAt:at}
const document={roleId,resourceId,documentId:'industry_source',knowledgeId:null,title:'资料',bodyVersion:1,contentHash,bytes:Buffer.byteLength(markdown),resource,origin:{resourceId,sourceId:resource.sourceId,sourceVersion:contentHash},editing:'fork-on-write' as const,indexState:'not-enrolled' as const,markdown}
test('员工知识目录可显式要求导入完成，普通读取不携带该参数',async()=>{
 const calls:unknown[]=[],api=createEmployeeKnowledgeApi(async(endpoint,input)=>{calls.push([endpoint,input]);return [document]})
 await api.list(roleId);await api.list(roleId,{requireReady:true})
 assert.deepEqual(calls,[['employee-knowledge/list',{roleId}],['employee-knowledge/list',{roleId,requireReady:true}]])
})
test('员工知识读取绑定角色与原资料，校验正文摘要并拒绝跨员工回包',async()=>{
 const calls:unknown[]=[],api=createEmployeeKnowledgeApi(async(endpoint,input)=>{calls.push([endpoint,input]);return document})
 assert.deepEqual(await api.read({roleId,resourceId}),document);assert.deepEqual(calls,[['employee-knowledge/read',{roleId,resourceId}]])
 for(const value of [{...document,roleId:requestId},{...document,resourceId:requestId,origin:{...document.origin,resourceId:requestId}},{...document,markdown:'错误正文'},{...document,contentHash:'a'.repeat(64),resource:{...resource,sourceVersion:'a'.repeat(64)}}])await assert.rejects(createEmployeeKnowledgeApi(async()=>value).read({roleId,resourceId}))
})
test('员工知识保存与核对原请求，验证CAS递增、操作与目标',async()=>{
 const next={...document,bodyVersion:2,knowledgeId:requestId,resource:{...resource,sourceId:'knowledge_'+requestId},editing:'employee-copy' as const},receipt={requestId,operation:'revise' as const,forked:true,document:next},input={requestId,roleId,resourceId,expectedBodyVersion:1,expectedContentHash:contentHash,markdown},calls:unknown[]=[]
 const api=createEmployeeKnowledgeApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return receipt})
 assert.deepEqual(await api.revise(input),receipt);assert.deepEqual(await api.status(requestId,{roleId,resourceId}),receipt)
 assert.deepEqual(calls,[['employee-knowledge/revise',input],['employee-knowledge/status',{requestId}]])
 for(const value of [{...receipt,requestId:roleId},{...receipt,operation:'restore'},{...receipt,document:{...next,bodyVersion:3}},{...receipt,document:{...next,roleId:requestId}}])await assert.rejects(createEmployeeKnowledgeApi(async()=>value).revise(input))
 assert.equal(await createEmployeeKnowledgeApi(async()=>null).status(requestId,{roleId,resourceId}),null)
})
test('员工草稿按本人、员工和资料隔离，卸载重开保留原CAS与未知请求',()=>{
 const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}}
 const api=createEmployeeKnowledgeApi(async()=>null,storage),journal=api.draft('self',{roleId,resourceId}),draft={ownerId:'self',roleId,resourceId,base:document,markdown:'修改稿',requestId,pending:{kind:'revise' as const,input:{requestId,roleId,resourceId,expectedBodyVersion:1,expectedContentHash:contentHash,markdown:'修改稿'}}}
 journal.write(draft);assert.equal(api.draft('other',{roleId,resourceId}).read(),undefined);assert.equal(api.draft('self',{roleId:requestId,resourceId}).read(),undefined)
 const recovered=createEmployeeKnowledgeApi(async()=>null,storage).draft('self',{roleId,resourceId});assert.deepEqual(recovered.read(),draft)
 recovered.clear(roleId);assert.ok(recovered.read());recovered.clear(requestId);assert.equal(recovered.read(),undefined)
})
