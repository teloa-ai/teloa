import test from 'node:test'
import assert from 'node:assert/strict'
import {createIndustryDataSourceApi} from '../src/client/industry-data-source-api.ts'

const id='12345678-1234-4234-8234-123456789012',loadId='22345678-1234-4234-8234-123456789012',itemInstanceId='32345678-1234-4234-8234-123456789012',stamp='2026-09-14T00:00:00.000Z'
const record={id,ownerId:'local:teloa-owner',loadId,itemInstanceId,itemLocalId:'alerts',contentId:'42345678-1234-4234-8234-123456789012',contentHash:'a'.repeat(64),itemVersion:'1.0.0',scope:'space-'+loadId,state:'needs_authorization' as const,revision:1,binding:null,createdAt:stamp,updatedAt:stamp}
const active={...record,state:'active' as const,revision:2,binding:{sourceId:'security-alert-http',scopes:['SOC'],definitionHash:'b'.repeat(64),probedAt:stamp}}

test('行业数据源 API 固定实例化与授权请求身份',async()=>{
 const calls:unknown[][]=[]
 const api=createIndustryDataSourceApi(async(method,payload)=>{calls.push([method,payload]);return method.endsWith('/list')?{items:[record]}:method.endsWith('/authorize')?active:record})
 assert.deepEqual(await api.instantiate({requestId:id,loadId,itemInstanceId}),record)
 assert.deepEqual(await api.authorize({requestId:id,instanceId:id,expectedRevision:1}),active)
 assert.deepEqual(await api.list(),{items:[record]})
 assert.deepEqual(calls,[['industry-data-sources/instantiate',{requestId:id,loadId,itemInstanceId}],['industry-data-sources/authorize',{requestId:id,instanceId:id,expectedRevision:1}],['industry-data-sources/list',{}]])
})

test('行业数据源 API 拒绝映射漂移、错误状态与重复实例',async()=>{
 const api=(value:unknown)=>createIndustryDataSourceApi(async()=>value)
 await assert.rejects(api({...record,loadId:id}).instantiate({requestId:id,loadId,itemInstanceId}),/映射/)
 await assert.rejects(api({...record,state:'pending'}).instantiate({requestId:id,loadId,itemInstanceId}),/格式/)
 await assert.rejects(api({...record,revision:1}).authorize({requestId:id,instanceId:id,expectedRevision:1}),/授权/)
 await assert.rejects(api({...active,binding:{...active.binding,definitionHash:'zz'}}).authorize({requestId:id,instanceId:id,expectedRevision:1}),/格式/)
 await assert.rejects(api({items:[record,{...record,id:'52345678-1234-4234-8234-123456789012'}]}).list(),/重复/)
 // 逐行失败项不得自身重复，也不得与已返回的实例身份重合。
 await assert.rejects(api({items:[record],errors:[{instanceId:record.id,code:'teloa/storage-corrupt'}]}).list(),/格式/)
 await assert.rejects(api({items:[record],errors:[{instanceId:'52345678-1234-4234-8234-123456789012',code:'teloa/storage-corrupt'},{instanceId:'52345678-1234-4234-8234-123456789012',code:'teloa/source-unavailable'}]}).list(),/格式/)
})

test('行业数据源授权失败保留原请求并以完全相同参数恢复',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}},input={requestId:id,instanceId:id,expectedRevision:1},calls:unknown[][]=[]
 const api=createIndustryDataSourceApi(async(method,payload)=>{calls.push([method,payload]);if(calls.length===1)throw Error('连接断开');return active},journal)
 await assert.rejects(api.authorize(input),/连接断开/)
 assert.deepEqual(api.pending(),input)
 assert.match(raw||'',/teloa\.industry-data-source-authorize\/v1/)
 assert.deepEqual(createIndustryDataSourceApi(async()=>active,journal).pending(),input)
 assert.deepEqual(await api.recover(),active)
 assert.deepEqual(calls,[['industry-data-sources/authorize',input],['industry-data-sources/authorize',input]])
 assert.equal(api.pending(),undefined)
 assert.equal(raw,null)
})

test('行业数据源登记不写恢复日志，日志损坏时停止授权',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createIndustryDataSourceApi(async()=>record,journal)
 assert.deepEqual(await api.instantiate({requestId:id,loadId,itemInstanceId}),record)
 assert.equal(raw,null)
 assert.equal(api.pending(),undefined)
 const damaged=createIndustryDataSourceApi(async()=>active,{read:()=>'{broken',write:()=>{},clear:()=>{}})
 assert.equal(damaged.recoveryMessage()?.code,'teloa/storage-corrupt')
 await assert.rejects(damaged.authorize({requestId:id,instanceId:id,expectedRevision:1}),(error:unknown)=>(error as {code?:unknown})?.code==='teloa/storage-corrupt')
 await assert.rejects(damaged.recover(),(error:unknown)=>(error as {code?:unknown})?.code==='teloa/storage-corrupt')
})

test('行业数据源授权被明确拒绝时清除恢复记录',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createIndustryDataSourceApi(async()=>{throw Object.assign(Error('版本冲突'),{rejected:true,code:'teloa/version-conflict'})},journal)
 await assert.rejects(api.authorize({requestId:id,instanceId:id,expectedRevision:1}),/版本冲突/)
 assert.equal(journal.read(),null)
 assert.equal(api.pending(),undefined)
})
