import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError} from '@teloa/contract'
import {createIndustryKnowledgeHandler} from '../src/industry-knowledge.ts'

const id='12345678-1234-4234-8234-123456789012',loadId='22345678-1234-4234-8234-123456789012',itemInstanceId='32345678-1234-4234-8234-123456789012',resourceId='42345678-1234-4234-8234-123456789012'
const scope='space-'+loadId,sourceId='industry_'+loadId+'_'+itemInstanceId,stamp='2026-09-12T00:00:00.000Z'
const resource={id:resourceId,ownerId:'owner',title:'研究资料',scopeIds:[scope],sourceId,sourceVersion:'a'.repeat(64),version:1,status:'active',createdAt:stamp,updatedAt:stamp}
const record={id,ownerId:'owner',loadId,itemInstanceId,itemLocalId:'guide',title:'研究资料',scope,sourceId,sourceVersion:'a'.repeat(64),revision:1,state:'active',resource,failure:null,createdAt:stamp,updatedAt:stamp}
const input={requestId:id,loadId,itemInstanceId}
test('行业知识入口固定本人，仅接受加载与映射身份',async()=>{
 const calls:unknown[][]=[]
 const handler=createIndustryKnowledgeHandler('owner',async()=>({instantiate:async(...args)=>{calls.push(args);return record},get:async()=>record,list:async()=>({items:[record]})}))
 assert.deepEqual(await handler('industry-knowledge/instantiate',input),record)
 assert.deepEqual(calls,[['owner',input]])
 assert.deepEqual(await handler('industry-knowledge/get',{instanceId:id}),record)
 assert.deepEqual(await handler('industry-knowledge/list',{}),{items:[record]})
 for(const extra of [{ownerId:'other'},{scope:'general'},{sourceId:'forged'}])await assert.rejects(handler('industry-knowledge/instantiate',{...input,...extra}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('industry-knowledge/instantiate',{...input,itemInstanceId:'bad'}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('industry-knowledge/enable',{}),{code:'teloa/invalid-input'})
 assert.equal(calls.length,1)
})
test('拒绝错误归属、来源范围、状态与版本以及重复映射回包',async()=>{
 const badRecords=[{...record,ownerId:'other'},{...record,scope:''},{...record,scope:'x'.repeat(81)},{...record,sourceId:'public'},{...record,revision:2147483648},{...record,state:'pending'},{...record,resource:{...resource,status:'withdrawn'}},{...record,resource:{...resource,scopeIds:['general']}},{...record,resource:{...resource,ownerId:'other'}},{...record,sourceVersion:'b'.repeat(64)},{...record,failure:{code:'teloa/conflict',message:'错误'}},{...record,extra:true},{...record,resource:{...resource,extra:true}}]
 for(const bad of badRecords){const handler=createIndustryKnowledgeHandler('owner',async()=>({instantiate:async()=>bad,get:async()=>bad,list:async()=>({items:[bad]})}));await assert.rejects(handler('industry-knowledge/get',{instanceId:id}),{code:'teloa/invalid-host-response'})}
 const wrong=createIndustryKnowledgeHandler('owner',async()=>({instantiate:async()=>record,get:async()=>record,list:async()=>({items:[record,{...record,id:resourceId}]})}))
 await assert.rejects(wrong('industry-knowledge/get',{instanceId:resourceId}),{code:'teloa/invalid-host-response'})
 await assert.rejects(wrong('industry-knowledge/instantiate',{...input,loadId:id}),{code:'teloa/invalid-host-response'})
 await assert.rejects(wrong('industry-knowledge/list',{}),{code:'teloa/invalid-host-response'})
})
test('未知结果与明确服务故障保留原错误，不伪造失败实例',async()=>{
 const failure=new WorkError('teloa/storage-unavailable','提交结果需要恢复')
 const handler=createIndustryKnowledgeHandler('owner',async()=>{throw failure})
 await assert.rejects(handler('industry-knowledge/instantiate',input),error=>error===failure)
 await assert.rejects(handler('industry-knowledge/list',{}),error=>error===failure)
 for(const value of [{...record,state:'pending',resource:null},{...record,state:'failed',resource:null,failure:{code:'teloa/source-unavailable',message:'来源暂不可用'}},{...record,state:'withdrawn',resource:{...resource,status:'withdrawn',version:2}}]){
  const restored=createIndustryKnowledgeHandler('owner',async()=>({instantiate:async()=>value,get:async()=>value,list:async()=>({items:[value]})}))
  assert.deepEqual(await restored('industry-knowledge/instantiate',input),value)
 }
})
