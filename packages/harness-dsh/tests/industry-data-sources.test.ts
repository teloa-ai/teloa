import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {WorkError} from '@teloa/contract'
import {createIndustryDataSourceHandler} from '../src/industry-data-sources.ts'

const id='12345678-1234-4234-8234-123456789012',loadId='22345678-1234-4234-8234-123456789012',itemInstanceId='32345678-1234-4234-8234-123456789012'
const contentId='42345678-1234-4234-8234-123456789012',stamp='2026-09-14T00:00:00.000Z'
const record={id,ownerId:'owner',loadId,itemInstanceId,itemLocalId:'alerts',contentId,contentHash:'a'.repeat(64),itemVersion:'1.0.0',scope:'space-'+contentId,state:'needs_authorization' as const,revision:1,binding:null,createdAt:stamp,updatedAt:stamp}
const active={...record,state:'active' as const,revision:2,binding:{sourceId:'security-alert-http',scopes:['SOC'],definitionHash:'b'.repeat(64),probedAt:stamp}}
const instantiateInput={requestId:id,loadId,itemInstanceId}
const authorizeInput={requestId:loadId,instanceId:id,expectedRevision:1}

test('行业数据源入口固定本人及四个请求形状',async()=>{
 const calls:unknown[][]=[]
 const handler=createIndustryDataSourceHandler('owner',async()=>({
  instantiate:async(...args)=>{calls.push(['instantiate',...args]);return record},
  get:async(...args)=>{calls.push(['get',...args]);return record},
  list:async(...args)=>{calls.push(['list',...args]);return {items:[record]}},
  authorize:async(...args)=>{calls.push(['authorize',...args]);return active},
 }))
 const signal=new AbortController().signal
 assert.deepEqual(await handler('industry-data-sources/instantiate',instantiateInput),record)
 assert.deepEqual(await handler('industry-data-sources/get',{instanceId:id}),record)
 assert.deepEqual(await handler('industry-data-sources/list',{}),{items:[record]})
 assert.deepEqual(await handler('industry-data-sources/authorize',authorizeInput,signal),active)
 assert.deepEqual(calls,[
  ['instantiate','owner',instantiateInput],
  ['get','owner',{instanceId:id}],
  ['list','owner',{}],
  ['authorize','owner',authorizeInput,signal],
 ])
})

test('伪造身份、映射、授权状态及未知字段在调用服务前拒绝',async()=>{
 let opened=0
 const handler=createIndustryDataSourceHandler('owner',async()=>{opened++;throw Error('不应打开服务')})
 for(const payload of [{...instantiateInput,ownerId:'other'},{...instantiateInput,scope:'general'},{...instantiateInput,itemLocalId:'other'},{...instantiateInput,itemInstanceId:'bad'}])await assert.rejects(handler('industry-data-sources/instantiate',payload),{code:'teloa/invalid-input'})
 for(const payload of [{...authorizeInput,expectedRevision:0},{...authorizeInput,expectedRevision:2147483647},{...authorizeInput,state:'active'},{...authorizeInput,revision:2},{...authorizeInput,requestId:'bad'}])await assert.rejects(handler('industry-data-sources/authorize',payload,new AbortController().signal),{code:'teloa/invalid-input'})
 await assert.rejects(handler('industry-data-sources/get',{instanceId:id,ownerId:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('industry-data-sources/list',{ownerId:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('industry-data-sources/revoke',{}),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
})

test('拒绝错误归属、固定映射、状态、revision 与时间戳回包',async()=>{
 const badRecords=[
  {...record,ownerId:'other'},
  {...record,itemLocalId:'bad/id'},
  {...record,contentId:'bad'},
  {...record,contentHash:'A'.repeat(64)},
  {...record,itemVersion:'latest'},
  {...record,scope:''},
  {...record,scope:'x'.repeat(81)},
  {...record,state:'pending'},
  {...record,revision:0},
  {...record,revision:2147483648},
  {...record,revision:2},
  {...record,binding:active.binding},
  {...active,binding:null},
  {...active,revision:1},
  {...active,binding:{...active.binding,scopes:[]}},
  {...active,binding:{...active.binding,definitionHash:'B'.repeat(64)}},
  {...active,binding:{...active.binding,probedAt:'2026-09-14'}},
  {...active,binding:{...active.binding,extra:true}},
  {...record,createdAt:'2026-09-14'},
  {...record,updatedAt:'2026-09-13T00:00:00.000Z'},
  {...record,extra:true},
 ]
 for(const bad of badRecords){
  const handler=createIndustryDataSourceHandler('owner',async()=>({instantiate:async()=>bad,get:async()=>bad,list:async()=>({items:[bad]}),authorize:async()=>bad}))
  await assert.rejects(handler('industry-data-sources/get',{instanceId:id}),{code:'teloa/invalid-host-response'})
 }
 const wrong=createIndustryDataSourceHandler('owner',async()=>({instantiate:async()=>record,get:async()=>record,list:async()=>({items:[record,{...record,id:contentId}]}),authorize:async()=>active}))
 await assert.rejects(wrong('industry-data-sources/get',{instanceId:contentId}),{code:'teloa/invalid-host-response'})
 await assert.rejects(wrong('industry-data-sources/instantiate',{...instantiateInput,loadId:id}),{code:'teloa/invalid-host-response'})
 await assert.rejects(wrong('industry-data-sources/list',{}),{code:'teloa/invalid-host-response'})
})

test('授权只接受目标实例的 active 下一 revision 与合法数据源身份，服务错误原样保留',async()=>{
 const other=createIndustryDataSourceHandler('owner',async()=>({instantiate:async()=>record,get:async()=>record,list:async()=>({items:[record]}),authorize:async()=>({...active,binding:{...active.binding,sourceId:'ticket-http'}})}))
 assert.deepEqual(await other('industry-data-sources/authorize',authorizeInput,new AbortController().signal),{...active,binding:{...active.binding,sourceId:'ticket-http'}})
 for(const bad of [record,{...active,revision:3},{...active,id:contentId},{...active,binding:{...active.binding,sourceId:'-bad'}}]){
  const handler=createIndustryDataSourceHandler('owner',async()=>({instantiate:async()=>record,get:async()=>record,list:async()=>({items:[record]}),authorize:async()=>bad}))
  await assert.rejects(handler('industry-data-sources/authorize',authorizeInput,new AbortController().signal),{code:'teloa/invalid-host-response'})
 }
 const failure=new WorkError('teloa/storage-unavailable','授权结果未知')
 const failed=createIndustryDataSourceHandler('owner',async()=>{throw failure})
 await assert.rejects(failed('industry-data-sources/authorize',authorizeInput,new AbortController().signal),error=>error===failure)
})

test('目录回包接受漂移投影与逐行失败项，拒绝伪造的 drift 与错误码',async()=>{
 const drifted={...active,state:'needs_authorization' as const,drift:true as const}
 const broken='52345678-1234-4234-8234-123456789012',page={items:[drifted],errors:[{instanceId:broken,code:'teloa/storage-corrupt'}]}
 const handler=createIndustryDataSourceHandler('owner',async()=>({instantiate:async()=>record,get:async()=>drifted,list:async()=>page,authorize:async()=>active}))
 assert.deepEqual(await handler('industry-data-sources/list',{}),page)
 assert.deepEqual(await handler('industry-data-sources/get',{instanceId:id}),drifted)
 const badPages=[
  {items:[{...active,state:'needs_authorization' as const,drift:false}]},
  {items:[{...active,drift:true}]},
  {items:[record],errors:[{instanceId:broken,code:'teloa/forbidden'}]},
  {items:[record],errors:[{instanceId:broken}]},
  {items:[record],errors:[{instanceId:'not-a-uuid',code:'teloa/storage-corrupt'}]},
  {items:[record],errors:[{instanceId:id,code:'teloa/source-unavailable'}]},
  {items:[record],errors:[{instanceId:broken,code:'teloa/storage-corrupt'},{instanceId:broken,code:'teloa/source-unavailable'}]},
  {items:[record],errors:[]},
  {items:[record],errors:{instanceId:broken,code:'teloa/storage-corrupt'}},
 ]
 for(const bad of badPages){
  const rejecting=createIndustryDataSourceHandler('owner',async()=>({instantiate:async()=>record,get:async()=>record,list:async()=>bad,authorize:async()=>active}))
  await assert.rejects(rejecting('industry-data-sources/list',{}),{code:'teloa/invalid-host-response'})
 }
})

test('正式宿主在注册行业数据源 RPC 前初始化并路由四个端点',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 const sequence=await readFile(new URL('../../backend/src/work/initialize-database.ts',import.meta.url),'utf8')
 assert.match(sequence,/await initializeIndustryDataSources\(pool\)/)
 const initializeIndex=source.indexOf('initializeTeloaDatabase(database.pool')
 const rpcRegistrationIndex=source.indexOf("connection.rpc.handle('/teloa'")
 assert.notEqual(initializeIndex,-1)
 assert.notEqual(rpcRegistrationIndex,-1)
 assert.ok(initializeIndex<rpcRegistrationIndex)
 assert.match(source,/\.\.\.industryDataSourceEndpoints/)
 assert.match(source,/IndustryDataSourceSource\(market,loads\)/)
 assert.match(source,/createIndustryDataSourceReadiness\(\[securityAlertSource\]/)
 assert.match(source,/industryDataSourceHandler\(endpoint,payload,signal\)/)
})
