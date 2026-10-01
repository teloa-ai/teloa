import test from 'node:test'
import assert from 'node:assert/strict'
import {createIndustryExecutionToolApi} from '../src/client/industry-execution-tool-api.ts'

const id='12345678-1234-4234-8234-123456789012',loadId='22345678-1234-4234-8234-123456789012',itemInstanceId='32345678-1234-4234-8234-123456789012',stamp='2026-09-14T00:00:00.000Z'
const record={id,ownerId:'local:teloa-owner',loadId,itemInstanceId,itemLocalId:'isolate-endpoint',contentId:'42345678-1234-4234-8234-123456789012',contentHash:'a'.repeat(64),itemVersion:'1.0.0',scope:'space-'+loadId,state:'needs_authorization' as const,revision:1,binding:null,createdAt:stamp,updatedAt:stamp}
const active={...record,state:'active' as const,revision:2,binding:{adapterId:'security-action-http' as const,tools:['security.endpoint.isolate'] as ['security.endpoint.isolate'],definitionHash:'b'.repeat(64)}}

test('行业执行工具 API 登记固定来源并以预期版本显式授权',async()=>{
 const calls:unknown[][]=[]
 const api=createIndustryExecutionToolApi(async(method,payload)=>{calls.push([method,payload]);return method.endsWith('/list')?{items:[record]}:method.endsWith('/authorize')?active:record})
 assert.deepEqual(await api.instantiate({requestId:id,loadId,itemInstanceId}),record)
 assert.deepEqual(await api.authorize({requestId:id,instanceId:id,expectedRevision:1}),active)
 assert.deepEqual(await api.get(id),record)
 assert.deepEqual(await api.list(),{items:[record]})
 assert.deepEqual(calls,[['industry-execution-tools/instantiate',{requestId:id,loadId,itemInstanceId}],['industry-execution-tools/authorize',{requestId:id,instanceId:id,expectedRevision:1}],['industry-execution-tools/get',{instanceId:id}],['industry-execution-tools/list',{}]])
})

test('行业执行工具 API 拒绝映射漂移、伪造可用状态与重复实例',async()=>{
 const api=(value:unknown)=>createIndustryExecutionToolApi(async()=>value)
 await assert.rejects(api({...record,loadId:id}).instantiate({requestId:id,loadId,itemInstanceId}),/映射/)
 await assert.rejects(api({...record,state:'active'}).instantiate({requestId:id,loadId,itemInstanceId}),/格式/)
 await assert.rejects(api({...active,binding:{...active.binding,tools:['security.endpoint.delete']}}).authorize({requestId:id,instanceId:id,expectedRevision:1}),/格式/)
 await assert.rejects(api(active).authorize({...{requestId:id,instanceId:id,expectedRevision:1},adapterId:'forged'} as never),/请求格式/)
 await assert.rejects(api({items:[record,{...record,id:'52345678-1234-4234-8234-123456789012'}]}).list(),/重复/)
 // 逐行失败项不得自身重复，也不得与已返回的实例身份重合。
 await assert.rejects(api({items:[record],errors:[{instanceId:record.id,code:'teloa/storage-corrupt'}]}).list(),/格式/)
 await assert.rejects(api({items:[record],errors:[{instanceId:'52345678-1234-4234-8234-123456789012',code:'teloa/storage-corrupt'},{instanceId:'52345678-1234-4234-8234-123456789012',code:'teloa/source-unavailable'}]}).list(),/格式/)
})

test('行业执行工具授权失败保留原请求并以完全相同参数恢复',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}},input={requestId:id,instanceId:id,expectedRevision:1},calls:unknown[][]=[]
 const api=createIndustryExecutionToolApi(async(method,payload)=>{calls.push([method,payload]);if(calls.length===1)throw Error('连接断开');return active},journal)
 await assert.rejects(api.authorize(input),/连接断开/)
 assert.deepEqual(api.pending(),input)
 assert.match(raw||'',/teloa\.industry-execution-tool-authorize\/v1/)
 assert.deepEqual(createIndustryExecutionToolApi(async()=>active,journal).pending(),input)
 assert.deepEqual(await api.recover(),active)
 assert.deepEqual(calls,[['industry-execution-tools/authorize',input],['industry-execution-tools/authorize',input]])
 assert.equal(api.pending(),undefined)
 assert.equal(raw,null)
})

test('行业执行工具登记不写恢复日志，日志损坏时停止授权',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createIndustryExecutionToolApi(async()=>record,journal)
 assert.deepEqual(await api.instantiate({requestId:id,loadId,itemInstanceId}),record)
 assert.equal(raw,null)
 assert.equal(api.pending(),undefined)
 const damaged=createIndustryExecutionToolApi(async()=>active,{read:()=>'{broken',write:()=>{},clear:()=>{}})
 assert.equal(damaged.recoveryMessage()?.code,'teloa/storage-corrupt')
 await assert.rejects(damaged.authorize({requestId:id,instanceId:id,expectedRevision:1}),(error:unknown)=>(error as {code?:unknown})?.code==='teloa/storage-corrupt')
 await assert.rejects(damaged.recover(),(error:unknown)=>(error as {code?:unknown})?.code==='teloa/storage-corrupt')
})

test('行业执行工具授权被明确拒绝时清除恢复记录',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createIndustryExecutionToolApi(async()=>{throw Object.assign(Error('版本冲突'),{rejected:true,code:'teloa/version-conflict'})},journal)
 await assert.rejects(api.authorize({requestId:id,instanceId:id,expectedRevision:1}),/版本冲突/)
 assert.equal(journal.read(),null)
 assert.equal(api.pending(),undefined)
})
