import test from 'node:test'
import assert from 'node:assert/strict'
import {createRoleMemoryApi} from '../src/client/role-memory-api.ts'

const roleId='16057272-ed9d-44a3-abe4-2ab04e056105',memoryId='26057272-ed9d-44a3-abe4-2ab04e056105',sourceId='36057272-ed9d-44a3-abe4-2ab04e056105',at='2026-09-13T00:00:00.000Z',markdown='先核对来源。',hash='a'.repeat(64)
const memory={id:memoryId,ownerId:'local:owner',roleId,roleVersion:2,title:'复核来源',state:'candidate' as const,stateVersion:1,source:{kind:'self-feedback' as const,id:sourceId,version:1},sourceTitle:'本人反馈',sourceAvailable:true,visibility:{kind:'role' as const,scopeIds:['SOC']},proposedBy:{kind:'self' as const},content:{version:1,contentHash:hash,bytes:new TextEncoder().encode(markdown).byteLength,markdown,createdAt:at},candidateAt:at,confirmedAt:null,withdrawnAt:null}

test('本人编辑固定来源和双版本，失回包后以原请求恢复并严格核对身份',async()=>{
 let raw:string|null=null,fail=true;const calls:unknown[]=[],body='本人修订',result={...memory,title:'修订',stateVersion:2,content:{...memory.content,version:2,markdown:body,bytes:new TextEncoder().encode(body).byteLength,contentHash:'b'.repeat(64),editedBy:'self' as const}}
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}},call=async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);if(fail)throw Error('断线');return result}
 const api=createRoleMemoryApi(call,journal,()=>sourceId)
 assert.equal(typeof api.edit,'function')
 await assert.rejects(api.edit(memory,{title:'修订',markdown:body}),/断线/)
 assert.throws(()=>api.discard(),/核对|原请求/)
 const request=(calls[0] as unknown[])[1] as Record<string,unknown>
 assert.equal(request.expectedContentVersion,1);assert.equal(request.expectedStateVersion,1);assert.equal(request.expectedContentHash,hash);assert.equal(request.roleId,roleId);assert.equal(request.source,undefined)
 fail=false;const recovered=createRoleMemoryApi(call,journal)
 assert.deepEqual(await recovered.recover(),result);assert.deepEqual(calls[0],calls[1]);assert.equal(raw,null)
 for(const changed of [{ownerId:'other'},{roleId:sourceId},{source:{...memory.source,id:roleId}},{state:'confirmed',stateVersion:2,confirmedAt:at},{proposedBy:{kind:'role',roleId,roleVersion:2}}]){
  const bad=createRoleMemoryApi(async()=>({...result,...changed}))
  await assert.rejects(bad.edit(memory,{title:'修订',markdown:body}),/响应/)
 }
})

test('记忆编辑草稿按API归属保存固定版本，关闭/重建不重基，存储失败仍保留内存新稿',()=>{
 let raw:string|null=null,quota=false
 const journal={read:()=>raw,write:(value:string)=>{if(quota)throw Object.assign(Error('满'),{name:'QuotaExceededError'});raw=value},clear:()=>{raw=null}},api=createRoleMemoryApi(async()=>memory,undefined,()=>sourceId,journal)
 assert.equal(typeof api.editDraft,'function')
 api.editDraft(memory);api.updateEditDraft(memoryId,{title:'未提交',markdown:'保留原版本的草稿'})
 const restored=createRoleMemoryApi(async()=>memory,undefined,()=>sourceId,journal),newer={...memory,stateVersion:2,content:{...memory.content,version:2,editedBy:'self' as const}}
 assert.equal(restored.editDraft(newer).target.content.version,1);assert.equal(restored.editDraft(newer).value.title,'未提交')
 assert.equal(createRoleMemoryApi(async()=>memory).editDraft(memory).value.title,memory.title)
 quota=true;assert.throws(()=>api.updateEditDraft(memoryId,{title:'内存新稿',markdown:'本机存储满后继续保留'}),/满/)
 assert.equal(api.editDraft(memory).value.title,'内存新稿')
 quota=false;api.updateEditDraft(memoryId,{title:'恢复存储',markdown:'重新保存'});assert.equal(createRoleMemoryApi(async()=>memory,undefined,()=>sourceId,journal).editDraft(memory).value.title,'恢复存储')
})

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


test('MEM-DEDUP-CORRECTIVE create只放行标题与UUID等价回执，其他身份正文范围状态仍拒绝',async()=>{
 const reused={...memory,title:'ＡＬＰＨＡ　 顺序'},input={roleId:roleId.toUpperCase(),expectedRoleVersion:2,title:'alpha 顺序',markdown,source:{...memory.source,id:sourceId.toUpperCase()},visibility:memory.visibility};let raw:string|null=null
 const api=createRoleMemoryApi(async()=>reused,{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}},()=> 'a6057272-ed9d-44a3-abe4-2ab04e056105')
 assert.deepEqual(await api.create(input),reused);assert.equal(raw,null);assert.equal(api.pending(),undefined)
 for(const patch of [{roleId:sourceId},{roleVersion:3},{title:'另一主题'},{source:{...memory.source,id:roleId}},{source:{...memory.source,version:2}},{source:{kind:'task',id:sourceId,version:1}},{visibility:{kind:'role',scopeIds:['IT']}},{state:'confirmed',stateVersion:2,confirmedAt:at},{content:{...memory.content,markdown:'被替换的正文',bytes:new TextEncoder().encode('被替换的正文').byteLength}}]){
  const bad=createRoleMemoryApi(async()=>({...reused,...patch}));await assert.rejects(bad.create(input),/响应/);assert.ok(bad.pending())
 }
})

test('MEM-DEDUP-CORRECTIVE list/readVersion/edit/confirm/withdraw比较UUID身份且不重写请求',async()=>{
 const alias={...memory,id:memory.id.toUpperCase(),roleId:roleId.toUpperCase(),source:{...memory.source,id:sourceId.toUpperCase()}},calls:Array<[string,unknown]>=[]
 const confirmed={...memory,state:'confirmed' as const,stateVersion:2,confirmedAt:at},withdrawn={...confirmed,state:'withdrawn' as const,stateVersion:3,withdrawnAt:at},edited={...memory,title:'明确编辑',stateVersion:2,content:{...memory.content,version:2,editedBy:'self' as const}}
 const call=async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);return endpoint==='role-memory/list'?[memory]:endpoint==='role-memory/confirm'?confirmed:endpoint==='role-memory/withdraw'?withdrawn:endpoint==='role-memory/edit'?edited:memory}
 const api=createRoleMemoryApi(call)
 assert.deepEqual(await api.list(alias.roleId),[memory]);assert.deepEqual(await api.readVersion(alias,1),memory)
 assert.deepEqual(await api.confirm(alias.id,1),confirmed);assert.equal((calls.at(-1)![1] as {memoryId:string}).memoryId,alias.id)
 assert.deepEqual(await api.withdraw(alias.id,2),withdrawn)
 assert.deepEqual(await api.edit(alias,{title:edited.title,markdown}),edited);assert.equal((calls.at(-1)![1] as {roleId:string}).roleId,alias.roleId)
 assert.equal((calls.at(-1)![1] as {memoryId:string}).memoryId,alias.id)
})

test('显式偏好参数在创建、编辑与恢复中保留；正文中的同名 JSON 示例不变',async()=>{
 const preference={schema:'teloa.preference-candidate/v1' as const,kind:'preference' as const,scope:'general',basis:{kind:'owner-confirmation' as const}},doc=JSON.stringify({schema:'teloa.preference-candidate/v1',kind:'one-off',markdown:'普通用户文档'})
 const saved={...memory,content:{...memory.content,markdown:doc,bytes:new TextEncoder().encode(doc).byteLength}},sent:any[]=[],api=createRoleMemoryApi(async(endpoint,payload)=>{sent.push([endpoint,payload]);return saved})
 await api.create({roleId,expectedRoleVersion:2,title:memory.title,markdown:doc,source:memory.source,visibility:memory.visibility})
 assert.equal(sent[0][1].markdown,doc);assert.equal(sent[0][1].preference,undefined)
 let raw:string|null=null,offline=true
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}},call=async(endpoint:string,payload:unknown)=>{sent.push([endpoint,payload]);if(offline)throw Error('断线');return saved}
 await assert.rejects(createRoleMemoryApi(call,journal).create({roleId,expectedRoleVersion:2,title:memory.title,markdown:doc,source:memory.source,visibility:memory.visibility,preference}),/断线/)
 offline=false;await createRoleMemoryApi(call,journal).recover()
 assert.deepEqual(sent[1],sent[2]);assert.deepEqual(sent[2][1].preference,preference);assert.equal(sent[2][1].markdown,doc);assert.equal(raw,null)
 const result={...saved,stateVersion:2,content:{...saved.content,version:2,editedBy:'self' as const}},edit=createRoleMemoryApi(async(_endpoint,payload)=>{sent.push(payload);return result})
 await edit.edit(saved,{title:memory.title,markdown:doc,preference});assert.deepEqual(sent.at(-1).preference,preference)
})
