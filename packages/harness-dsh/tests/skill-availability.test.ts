import test from 'node:test'
import assert from 'node:assert/strict'
import {createSkillAvailabilityHandler} from '../src/skill-availability.ts'
const id='12345678-1234-4234-8234-123456789012',current={installationId:id,ownerId:'owner',availability:'enabled',version:3,updatedAt:'2026-09-12T00:00:00.000Z'}
const input={requestId:id,installationId:id,expectedVersion:1,expectedBundleHash:'a'.repeat(64),expectedImpactDigest:'b'.repeat(64),action:'disable'}
test('启停入口拒绝客户端身份/路径及未知动作，不接触服务',async()=>{
 let calls=0;const handler=createSkillAvailabilityHandler('owner',async()=>{calls++;throw Error()})
 for(const payload of [{...input,ownerId:'other'},{...input,path:'/tmp'},{...input,action:'remove'},{...input,expectedVersion:0}])await assert.rejects(handler('skill-availability/change',payload),{code:'teloa/invalid-input'})
 assert.equal(calls,0)
})
test('历史维护回执与新当前状态分离，不能把重试认作再次停用',async()=>{
 const receipt={requestId:id,installationId:id,action:'disable',reason:'',impactDigest:input.expectedImpactDigest,impact:{installation:{id,bundleHash:input.expectedBundleHash},availability:{version:1}},result:{...current,availability:'disabled',version:2}},result={receipt,current}
 const handler=createSkillAvailabilityHandler('owner',async()=>({change:async(owner:string,spec:unknown)=>{assert.equal(owner,'owner');assert.deepEqual(spec,input);return result}}) as never)
 assert.deepEqual(await handler('skill-availability/change',input),result)
 const wrong=createSkillAvailabilityHandler('owner',async()=>({change:async()=>({...result,current:{...current,ownerId:'other'}})}) as never)
 await assert.rejects(wrong('skill-availability/change',input),{code:'teloa/invalid-host-response'})
})
test('可用状态读取必须返回本人同安装身份',async()=>{
 const handler=createSkillAvailabilityHandler('owner',async()=>({get:async()=>current}) as never)
 assert.deepEqual(await handler('skill-availability/get',{installationId:id}),current)
 const wrong=createSkillAvailabilityHandler('other',async()=>({get:async()=>current}) as never)
 await assert.rejects(wrong('skill-availability/get',{installationId:id}),{code:'teloa/invalid-host-response'})
})

test('维护拒绝跨安装影响快照与同版本相反状态',async()=>{
 const receipt={requestId:id,installationId:id,action:'disable',reason:'',impactDigest:input.expectedImpactDigest,impact:{installation:{id,bundleHash:input.expectedBundleHash},availability:{version:1}},result:{...current,availability:'disabled',version:2}}
 for(const result of [{receipt:{...receipt,impact:{...receipt.impact,installation:{...receipt.impact.installation,id:'22345678-1234-4234-8234-123456789012'}}},current},{receipt,current:{...current,version:2}}]){
  const handler=createSkillAvailabilityHandler('owner',async()=>({change:async()=>result}) as never)
  await assert.rejects(handler('skill-availability/change',input),{code:'teloa/invalid-host-response'})
 }
})
