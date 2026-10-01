import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError} from '@teloa/contract'
import {createIndustryPlansHandler} from '../src/industry-plans.ts'
const id='12345678-1234-4234-8234-123456789012',loadId='22345678-1234-4234-8234-123456789012',itemInstanceId='32345678-1234-4234-8234-123456789012'
test('行业计划入口拒绝前端覆盖身份和固定字段，普通来源null不掩盖故障',async()=>{
 let calls=0;const denied=createIndustryPlansHandler('owner',async()=>{calls++;throw Error('不能到达')})
 for(const extra of [{ownerId:'other'},{scope:'general'},{title:'改名'},{dataScope:'范围'}])await assert.rejects(denied('industry-plans/create',{requestId:id,loadId,itemInstanceId,goal:'核对',delivery:'简报',notificationPolicy:'attention',roleId:id,expectedRoleVersion:1,trigger:{},...extra}),{code:'teloa/invalid-input'})
 assert.equal(calls,0)
 for(const trigger of [{kind:'schedule',cadence:'daily',weekday:1,time:'25:00',timezone:'Asia/Singapore'},{kind:'schedule',cadence:'weekly',weekday:8,time:'09:00',timezone:'Asia/Singapore'}])await assert.rejects(denied('industry-plans/create',{requestId:id,loadId,itemInstanceId,goal:'核对',delivery:'简报',notificationPolicy:'attention',roleId:id,expectedRoleVersion:1,trigger}),{code:'teloa/invalid-input'})
 const valid={requestId:id,loadId,itemInstanceId,goal:'核对',delivery:'简报',notificationPolicy:'attention',roleId:id,expectedRoleVersion:1,trigger}
 const {notificationPolicy:_,...missing}=valid
 await assert.rejects(denied('industry-plans/create',missing),{code:'teloa/invalid-input'})
 await assert.rejects(denied('industry-plans/create',{...valid,notificationPolicy:'unexpected'}),{code:'teloa/invalid-input'})
 assert.equal(calls,0)
 const seen:unknown[][]=[],handler=createIndustryPlansHandler('owner',async()=>({preview:async()=>null,create:async()=>null,source:async(...args)=>{seen.push(args);return null},list:async()=>({items:[]})}))
 assert.equal(await handler('industry-plans/source',{planId:id}),null);assert.deepEqual(seen,[['owner',{planId:id}]])
 assert.deepEqual(await handler('industry-plans/list',{}),{items:[]})
 await assert.rejects(handler('industry-plans/preview',{loadId,itemInstanceId}),{code:'teloa/invalid-host-response'})
 const error=new WorkError('teloa/storage-unavailable','未知结果'),failed=createIndustryPlansHandler('owner',async()=>{throw error})
 await assert.rejects(failed('industry-plans/source',{planId:id}),cause=>cause===error)
})
const stamp='2026-09-12T00:00:00.000Z',roleId='42345678-1234-4234-8234-123456789012',trigger={kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},selectedTrigger={...trigger,time:'10:00'}
const work={loadId,itemInstanceId:roleId,itemLocalId:'research',contentId:id,contentHash:'a'.repeat(64),templateId:'research',templateVersion:'1.0.0',fileHash:'b'.repeat(64),title:'研究',method:'核对来源',requirements:['资料位置'],output:'简报',skills:[],scope:'space-'+loadId}
const snapshot={loadId,itemInstanceId,itemLocalId:'daily',contentId:id,contentHash:'a'.repeat(64),planVersion:'1.0.0',planFileHash:'c'.repeat(64),title:'每日研究',work,dataScope:'获准资料',trigger,scope:work.scope}
const source={...snapshot,planId:id,ownerId:'owner',requestId:id,goal:'核对',delivery:'摘要',notificationPolicy:'failure' as const,selectedTrigger,createdRole:{roleId,roleVersion:2},createdAt:stamp}
const plan={id,ownerId:'owner',title:snapshot.title,goal:source.goal,scope:source.scope,dataScope:source.dataScope,delivery:source.delivery,notificationPolicy:'failure',roleId,roleVersion:2,trigger:selectedTrigger,source:{kind:'market-content',contentId:id,contentHash:source.contentHash,resourceId:'daily',resourceVersion:'1.0.0'},version:3,configVersion:1,state:'archived',archivedReason:'本人归档',archivedAt:stamp,createdAt:stamp,updatedAt:stamp}
const input={requestId:id,loadId,itemInstanceId,goal:' 核对 ',delivery:' 摘要 ',notificationPolicy:'failure',trigger:selectedTrigger,roleId,expectedRoleVersion:2}
test('计划保留模板默认与所选日程，恢复归档状态且拒绝串源与坏回包',async()=>{
 const handler=createIndustryPlansHandler('owner',async()=>({preview:async()=>snapshot,create:async()=>({plan,source}),source:async()=>source,list:async()=>({items:[source]})}))
 assert.deepEqual(await handler('industry-plans/preview',{loadId,itemInstanceId}),snapshot)
 assert.deepEqual(await handler('industry-plans/create',input),{plan,source})
 assert.deepEqual(await handler('industry-plans/source',{planId:id}),source)
 assert.deepEqual(await handler('industry-plans/list',{loadId}),{items:[source]})
 for(const bad of [{...source,ownerId:'other'},{...source,notificationPolicy:'unexpected'},{...source,work:{...work,loadId:id}},{...source,selectedTrigger:trigger},{...source,createdRole:{roleId,roleVersion:1}},{...source,requestId:roleId},{...source,work:{...work,skills:[{id:'x',title:'x',version:'1.0.0',authorized:true}]}}]){
  const broken=createIndustryPlansHandler('owner',async()=>({preview:async()=>snapshot,create:async()=>({plan,source:bad}),source:async()=>bad,list:async()=>({items:[bad]})}))
  await assert.rejects(broken('industry-plans/create',input),{code:'teloa/invalid-host-response'})
 }
 const wrongPlan=createIndustryPlansHandler('owner',async()=>({preview:async()=>snapshot,create:async()=>({plan:{...plan,notificationPolicy:'silent'},source}),source:async()=>source,list:async()=>({items:[source]})}))
 await assert.rejects(wrongPlan('industry-plans/create',input),{code:'teloa/invalid-host-response'})
 const duplicated=createIndustryPlansHandler('owner',async()=>({preview:async()=>snapshot,create:async()=>({plan,source}),source:async()=>source,list:async()=>({items:[source,source]})}))
 await assert.rejects(duplicated('industry-plans/list',{}),{code:'teloa/invalid-host-response'})
})
test('旧行业计划来源可按缺失通知策略的原形读取，但不能冒充新建回执',async()=>{
 const {notificationPolicy:_,...legacy}=source
 const handler=createIndustryPlansHandler('owner',async()=>({preview:async()=>snapshot,create:async()=>({plan,source:legacy}),source:async()=>legacy,list:async()=>({items:[legacy]})}))
 assert.deepEqual(await handler('industry-plans/source',{planId:id}),legacy)
 assert.deepEqual(await handler('industry-plans/list',{loadId}),{items:[legacy]})
 await assert.rejects(handler('industry-plans/create',input),{code:'teloa/invalid-host-response'})
})
