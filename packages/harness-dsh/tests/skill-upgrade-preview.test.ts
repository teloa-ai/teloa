import test from 'node:test'
import assert from 'node:assert/strict'
import {createSkillUpgradePreviewHandler} from '../src/skill-upgrade-preview.ts'
const id='12345678-1234-4234-8234-123456789012',targetId='22345678-1234-4234-8234-123456789012',hash='a'.repeat(64)
const source={kind:'atomic',contentId:targetId,contentHash:hash,resourceId:'audit',resourceVersion:'2'}
const native={name:'audit',description:'Audit',modelInvocable:true,userInvocable:true,bodyHash:hash}
const current={installation:{id,ownerId:'owner',version:2,bundleHash:hash,native},availability:{installationId:id,ownerId:'owner',availability:'enabled',version:1},impact:{installation:{id,version:2,bundleHash:hash,nativeName:'audit'},availability:{version:1,value:'enabled'}},impactDigest:hash}
const preview={current,target:{source,bundleHash:hash,native,files:[]},files:[],sameResourceId:true,blockers:[]}
test('升级预览只接受固定来源身份，不接受外部owner、路径或执行动作',async()=>{
 let calls=0;const handler=createSkillUpgradePreviewHandler('owner',async()=>{calls++;throw Error('unexpected')})
 for(const payload of [{installationId:id,target:{kind:'atomic',contentId:targetId},ownerId:'other'},{installationId:id,target:{kind:'atomic',contentId:targetId,path:'/tmp'}},{installationId:id,target:{kind:'industry',loadId:targetId}},{installationId:'bad',target:{kind:'atomic',contentId:targetId}}])await assert.rejects(handler('skill-upgrades/preview',payload),{code:'teloa/invalid-input'})
 await assert.rejects(handler('skill-upgrades/change',{}),{code:'teloa/not-found'});assert.equal(calls,0)
})
test('升级预览固定宿主本人，核对当前安装和目标来源身份',async()=>{
 const handler=createSkillUpgradePreviewHandler('owner',async()=>({preview:async(owner:string,input:unknown)=>{assert.equal(owner,'owner');assert.deepEqual(input,{installationId:id,target:{kind:'atomic',contentId:targetId}});return preview}}) as never)
 assert.deepEqual(await handler('skill-upgrades/preview',{installationId:id,target:{kind:'atomic',contentId:targetId}}),preview)
 for(const changed of [{...preview,current:{...current,installation:{...current.installation,ownerId:'other'}}},{...preview,target:{...preview.target,source:{...source,contentId:id}}},{...preview,current:{...current,impact:{...current.impact,installation:{...current.impact.installation,id:targetId}}}}]){
  const bad=createSkillUpgradePreviewHandler('owner',async()=>({preview:async()=>changed}) as never)
  await assert.rejects(bad('skill-upgrades/preview',{installationId:id,target:{kind:'atomic',contentId:targetId}}),{code:'teloa/invalid-host-response'})
 }
})
test('行业目标只接受原请求load和item，来源读取故障不伪装成空差异',async()=>{
 const target={kind:'industry',loadId:id,itemInstanceId:targetId},industry={...source,kind:'industry-local',loadId:id,itemInstanceId:targetId}
 const handler=createSkillUpgradePreviewHandler('owner',async()=>({preview:async()=>({...preview,target:{...preview.target,source:industry}})}) as never)
 await handler('skill-upgrades/preview',{installationId:id,target})
 const wrong=createSkillUpgradePreviewHandler('owner',async()=>({preview:async()=>({...preview,target:{...preview.target,source:{...industry,itemInstanceId:id}}})}) as never)
 await assert.rejects(wrong('skill-upgrades/preview',{installationId:id,target}),{code:'teloa/invalid-host-response'})
 const failure=new Error('source read failed'),failed=createSkillUpgradePreviewHandler('owner',async()=>({preview:async()=>{throw failure}}) as never)
 await assert.rejects(failed('skill-upgrades/preview',{installationId:id,target}),error=>error===failure)
})
