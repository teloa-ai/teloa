import test from 'node:test'
import assert from 'node:assert/strict'
import {createSkillAvailabilityApi} from '../src/client/skill-availability-api.ts'
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',requestId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',at='2026-09-12T00:00:00.000Z'
const current={installationId:id,ownerId:'owner',availability:'disabled' as const,version:2,updatedAt:at}
const impact={installation:{id,version:2,bundleHash:'a'.repeat(64),nativeName:'review'},availability:{value:'enabled' as const,version:1},industryUsages:[],roles:[],plans:[],tasks:[],runs:[],ordinarySessions:{status:'unknown' as const}}
const request={requestId,installationId:id,expectedVersion:1,expectedBundleHash:'a'.repeat(64),expectedImpactDigest:'b'.repeat(64),action:'disable' as const}
const response={receipt:{requestId,installationId:id,action:'disable' as const,reason:'',impact,impactDigest:'b'.repeat(64),result:current,createdAt:at},current}
const installation={id,ownerId:'owner',state:'installed',version:2,bundleHash:'a'.repeat(64),createdAt:at,updatedAt:at,source:{kind:'atomic',contentId:requestId,contentHash:'c'.repeat(64),resourceId:'review',resourceVersion:'1.0.0'},native:{name:'review',description:'核对',modelInvocable:true,userInvocable:true,bodyHash:'d'.repeat(64)}}
test('影响预览核对本人、安装、独立可用版本及完整关系，不接受重复或错配数据',async()=>{
 const preview={installation,availability:{...current,availability:'enabled',version:1},impact,impactDigest:'b'.repeat(64),blockers:[]}
 assert.deepEqual(await createSkillAvailabilityApi(async()=>preview).preview(id),preview)
 for(const bad of [{...preview,availability:{...preview.availability,version:2}},{...preview,installation:{...installation,ownerId:'other'}},{...preview,impact:{...impact,industryUsages:[{loadId:id,itemInstanceId:requestId},{loadId:id,itemInstanceId:requestId}]}},{...preview,impact:{...impact,ordinarySessions:{status:'none'}}},{...preview,blockers:['installation-not-installed']}])await assert.rejects(createSkillAvailabilityApi(async()=>bad).preview(id))
})
test('未知回包跨API重建恢复完全相同请求，历史回执与当前恢复后的状态分开',async()=>{
 let raw:string|null=null;const sent:unknown[]=[]
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createSkillAvailabilityApi(async(_method,payload)=>{sent.push(payload);throw Error('断线')},journal)
 await assert.rejects(api.change(request),/断线/)
 const restored=createSkillAvailabilityApi(async(_method,payload)=>{sent.push(payload);return {...response,current:{...current,availability:'enabled',version:3}}},journal)
 const result=await restored.recover(id)
 assert.deepEqual(sent[0],sent[1]);assert.equal(result.receipt.result.availability,'disabled');assert.equal(result.current.availability,'enabled');assert.equal(raw,null)
})
test('跨安装恢复在发送前拒绝，未知pending不允许换动作',async()=>{
 let calls=0;const api=createSkillAvailabilityApi(async()=>{calls++;throw Error('断线')})
 await assert.rejects(api.change(request));await assert.rejects(api.recover(requestId),/安装/)
 await assert.rejects(api.change({...request,action:'enable'}),/原/);assert.equal(calls,1)
})
test('回包身份、影响摘要和历史操作不符均保留journal',async()=>{
 for(const bad of [{...response,current:{...current,installationId:requestId}},{...response,receipt:{...response.receipt,action:'enable'}},{...response,receipt:{...response.receipt,impactDigest:'c'.repeat(64)}},{...response,receipt:{...response.receipt,result:{...current,version:1}}}]){
  const api=createSkillAvailabilityApi(async()=>bad);await assert.rejects(api.change(request));assert.ok(api.pending())
 }
})
test('明确预览版本拒绝可重新预览，未知故障必须保留原请求',async()=>{
 for(const code of ['teloa/version-conflict','teloa/conflict']){
  const api=createSkillAvailabilityApi(async()=>{throw Object.assign(Error('影响已变化'),{code,rejected:true})})
  await assert.rejects(api.change(request));assert.equal(api.pending(),undefined)
 }
 for(const code of ['teloa/storage-unavailable','teloa/host-unavailable']){const api=createSkillAvailabilityApi(async()=>{throw Object.assign(Error('存储或宿主不可用'),{code,rejected:true})});await assert.rejects(api.change(request));assert.ok(api.pending())}
})
test('journal失败不发送，损坏记录禁止维护但允许读取',async()=>{
 let calls=0;const api=createSkillAvailabilityApi(async()=>{calls++;return current},{read:()=>null,write:()=>{throw Error('无法保存')},clear:()=>{}})
 await assert.rejects(api.change(request),/保存/);assert.equal(calls,0)
 const broken=createSkillAvailabilityApi(async()=>current,{read:()=>'{',write:()=>{},clear:()=>{}})
 assert.ok(broken.recoveryMessage());assert.deepEqual(await broken.get(id),current);await assert.rejects(broken.change(request))
})
