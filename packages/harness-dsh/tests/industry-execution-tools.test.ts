import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createIndustryExecutionToolHandler} from '../src/industry-execution-tools.ts'

const id='12345678-1234-4234-8234-123456789012',loadId='22345678-1234-4234-8234-123456789012',itemInstanceId='32345678-1234-4234-8234-123456789012'
const contentId='42345678-1234-4234-8234-123456789012',stamp='2026-09-14T00:00:00.000Z'
const record={id,ownerId:'owner',loadId,itemInstanceId,itemLocalId:'isolate-endpoint',contentId,contentHash:'a'.repeat(64),itemVersion:'1.0.0',scope:'space-'+contentId,state:'needs_authorization' as const,revision:1,binding:null,createdAt:stamp,updatedAt:stamp}
const active={...record,state:'active' as const,revision:2,binding:{adapterId:'security-action-http' as const,tools:['security.endpoint.isolate'] as ['security.endpoint.isolate'],definitionHash:'b'.repeat(64)}}
const instantiateInput={requestId:id,loadId,itemInstanceId}

test('行业执行工具入口固定本人并把 AbortSignal 交给真实授权',async()=>{
 const calls:unknown[][]=[]
 const handler=createIndustryExecutionToolHandler('owner',async()=>({
  instantiate:async(...args)=>{calls.push(['instantiate',...args]);return record},
  authorize:async(...args)=>{calls.push(['authorize',...args]);return active},
  get:async(...args)=>{calls.push(['get',...args]);return record},
  list:async(...args)=>{calls.push(['list',...args]);return {items:[record]}},
 }))
 const signal=new AbortController().signal
 assert.deepEqual(await handler('industry-execution-tools/instantiate',instantiateInput),record)
 assert.deepEqual(await handler('industry-execution-tools/authorize',{requestId:id,instanceId:id,expectedRevision:1},signal),active)
 assert.deepEqual(await handler('industry-execution-tools/get',{instanceId:id}),record)
 assert.deepEqual(await handler('industry-execution-tools/list',{}),{items:[record]})
 assert.deepEqual(calls,[['instantiate','owner',instantiateInput],['authorize','owner',{requestId:id,instanceId:id,expectedRevision:1},signal],['get','owner',{instanceId:id}],['list','owner',{}]])
})

test('行业执行工具入口拒绝伪造字段、可用状态与重复映射',async()=>{
 let opened=0
 const unopened=createIndustryExecutionToolHandler('owner',async()=>{opened++;throw Error('不应打开服务')})
 for(const payload of [{...instantiateInput,ownerId:'other'},{...instantiateInput,scope:'general'},{...instantiateInput,itemInstanceId:'bad'}])await assert.rejects(unopened('industry-execution-tools/instantiate',payload),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
 await assert.rejects(unopened('industry-execution-tools/authorize',{requestId:id,instanceId:id,expectedRevision:1,adapterId:'forged'},new AbortController().signal),{code:'teloa/invalid-input'})
 const bad=createIndustryExecutionToolHandler('owner',async()=>({instantiate:async()=>({...record,state:'active'}),authorize:async()=>({...active,binding:{...active.binding,tools:['security.endpoint.delete']}}),get:async()=>({...record,state:'active'}),list:async()=>({items:[record,{...record,id:contentId}]})}))
 await assert.rejects(bad('industry-execution-tools/get',{instanceId:id}),{code:'teloa/invalid-host-response'})
 await assert.rejects(bad('industry-execution-tools/authorize',{requestId:id,instanceId:id,expectedRevision:1},new AbortController().signal),{code:'teloa/invalid-host-response'})
 await assert.rejects(bad('industry-execution-tools/list',{}),{code:'teloa/invalid-host-response'})
})

test('正式宿主在 RPC 前初始化并路由行业执行工具端点',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 const sequence=await readFile(new URL('../../backend/src/work/initialize-database.ts',import.meta.url),'utf8')
 assert.match(sequence,/await initializeIndustryExecutionTools\(pool\)/)
 const initializeIndex=source.indexOf('initializeTeloaDatabase(database.pool')
 const rpcRegistrationIndex=source.indexOf("connection.rpc.handle('/teloa'")
 assert.notEqual(initializeIndex,-1);assert.ok(initializeIndex<rpcRegistrationIndex)
 assert.match(source,/\.\.\.industryExecutionToolEndpoints/)
 assert.match(source,/industryExecutionToolHandler\(endpoint,payload,signal\)/)
 assert.match(source,/IndustryExecutionToolSource\(market,loads\)/)
 assert.match(source,/securityDriver\.readiness\.bind\(securityDriver\)/)
})
