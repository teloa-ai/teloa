import test from 'node:test'
import assert from 'node:assert/strict'
import {createRoleMemoryApi} from '../src/client/role-memory-api.ts'

const roleId='16057272-ed9d-44a3-abe4-2ab04e056105',memoryId='26057272-ed9d-44a3-abe4-2ab04e056105',sourceId='36057272-ed9d-44a3-abe4-2ab04e056105',at='2026-09-13T00:00:00.000Z',markdown='先核对来源。',hash='a'.repeat(64)
const memory={id:memoryId,ownerId:'local:owner',roleId,roleVersion:2,title:'复核来源',state:'candidate' as const,stateVersion:1,source:{kind:'self-feedback' as const,id:sourceId,version:1},sourceTitle:'本人反馈',sourceAvailable:true,visibility:{kind:'role' as const,scopeIds:['SOC']},proposedBy:{kind:'self' as const},content:{version:1,contentHash:hash,bytes:new TextEncoder().encode(markdown).byteLength,markdown,createdAt:at},candidateAt:at,confirmedAt:null,withdrawnAt:null}

test('目录校验岗位与本人隔离，候选写入使用固定请求并核对正文',async()=>{
 let raw:string|null=null,calls:unknown[]=[],next=0
 const api=createRoleMemoryApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);return endpoint==='role-memory/list'?[memory]:memory},{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}},()=>`46057272-ed9d-44a3-abe4-2ab04e05610${++next}`)
 assert.deepEqual(await api.list(roleId),[memory])
 const created=await api.create({roleId,expectedRoleVersion:2,title:'复核来源',markdown,source:memory.source,visibility:memory.visibility})
 assert.deepEqual(created,memory);assert.equal(raw,null);assert.equal((calls[1] as unknown[])[0],'role-memory/create')
 const sent=(calls[1] as unknown[])[1] as Record<string,unknown>;assert.equal(sent.requestId,'46057272-ed9d-44a3-abe4-2ab04e056101')
 await assert.rejects(createRoleMemoryApi(async()=>[{...memory,ownerId:'other'},{...memory,id:'56057272-ed9d-44a3-abe4-2ab04e056105'}]).list(roleId),/本人|目录/)
 await assert.rejects(createRoleMemoryApi(async()=>[{...memory,roleId:sourceId}]).list(roleId),/岗位|目录/)
})

test('确认和撤回丢回包保留原请求，恢复只接受匹配状态回执',async()=>{
 let raw:string|null=null,calls:unknown[]=[],fail=true
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createRoleMemoryApi(async(endpoint,payload)=>{calls.push([endpoint,payload]);if(fail)throw Error('断线');return {...memory,state:'confirmed',stateVersion:2,confirmedAt:at}},journal,()=> '66057272-ed9d-44a3-abe4-2ab04e056105')
 await assert.rejects(api.confirm(memoryId,1),/断线/);assert.ok(raw);assert.ok(api.pending())
 fail=false;const recovered=await api.recover();assert.equal(recovered.state,'confirmed');assert.deepEqual(calls[0],calls[1]);assert.equal(raw,null)
 const bad=createRoleMemoryApi(async()=>({...memory,state:'withdrawn',stateVersion:2,withdrawnAt:at}),undefined,()=> '76057272-ed9d-44a3-abe4-2ab04e056105')
 await assert.rejects(bad.confirm(memoryId,1),/响应/)
})

test('明确拒绝释放日志，损坏日志和并行新命令阻止发送',async()=>{
 let raw:string|null=null,calls=0
 const api=createRoleMemoryApi(async()=>{calls++;throw Object.assign(Error('版本变化'),{rejected:true,code:'teloa/version-conflict'})},{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}},()=> '86057272-ed9d-44a3-abe4-2ab04e056105')
 await assert.rejects(api.withdraw(memoryId,2),/版本变化/);assert.equal(raw,null);assert.equal(api.pending(),undefined)
 const corrupt=createRoleMemoryApi(async()=>{calls++;return memory},{read:()=>'{',write:()=>{},clear:()=>{}})
 await assert.rejects(corrupt.create({roleId,expectedRoleVersion:2,title:'复核来源',markdown,source:memory.source,visibility:memory.visibility}),error=>error instanceof Error&&'code' in error&&error.code==='teloa/storage-corrupt')
 assert.equal(calls,1)
})

test('128KiB Markdown 即使 JSON 转义膨胀仍可从日志恢复',async()=>{
 let raw:string|null=null,offline=true
 const body='\u0001'.repeat(128*1024),journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const call=async()=>{
  if(offline)throw Error('断线')
  return {...memory,title:'转义正文',content:{...memory.content,bytes:128*1024,markdown:body}}
 }
 const first=createRoleMemoryApi(call,journal,()=> '96057272-ed9d-44a3-abe4-2ab04e056105')
 await assert.rejects(first.create({roleId,expectedRoleVersion:2,title:'转义正文',markdown:body,source:memory.source,visibility:memory.visibility}),/断线/)
 const saved=journal.read();assert.ok(saved&&saved.length>150000)
 offline=false
 const recovered=createRoleMemoryApi(call,journal)
 assert.equal((await recovered.recover()).content.markdown,body);assert.equal(raw,null)
})
