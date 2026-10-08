import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError} from '@teloa/contract'
import {createIndustryTasksHandler} from '../src/industry-tasks.ts'
const requestId='12345678-1234-4234-8234-123456789012',loadId='22345678-1234-4234-8234-123456789012',itemInstanceId='32345678-1234-4234-8234-123456789012'
test('行业任务入口先拒绝伪造身份权限，不调用服务',async()=>{
 let calls=0
 const handler=createIndustryTasksHandler('owner',async()=>{calls++;throw Error('不得调用')})
 for(const extra of [{owner:'other'},{scope:'general'},{template:{}},{tools:['execute']}])await assert.rejects(handler('industry-tasks/create',{requestId,loadId,itemInstanceId,goal:'核对',inputs:['资料'],...extra}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('industry-tasks/preview',{loadId,itemInstanceId,owner:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('industry-tasks/source',{taskId:'not-id'}),{code:'teloa/invalid-input'})
 assert.equal(calls,0)
})
test('普通任务来源为null，源服务错误不能伪装成空来源',async()=>{
 const calls:unknown[][]=[]
 const handler=createIndustryTasksHandler('owner',async()=>({preview:async()=>null,create:async()=>null,source:async(...args)=>{calls.push(args);return null}}))
 assert.equal(await handler('industry-tasks/source',{taskId:requestId}),null)
 assert.deepEqual(calls,[['owner',{taskId:requestId}]])
 const error=new WorkError('teloa/storage-unavailable','无法核对来源'),failed=createIndustryTasksHandler('owner',async()=>{throw error})
 await assert.rejects(failed('industry-tasks/source',{taskId:requestId}),cause=>cause===error)
 await assert.rejects(handler('industry-tasks/preview',{loadId,itemInstanceId}),{code:'teloa/invalid-host-response'})
})
const stamp='2026-09-12T00:00:00.000Z'
const snapshot={loadId,itemInstanceId,itemLocalId:'research',contentId:requestId,contentHash:'a'.repeat(64),templateId:'research',templateVersion:'1.0.0',fileHash:'b'.repeat(64),title:'资料研究',method:'比较资料与来源',requirements:['原文'],output:'简报',skills:[{id:'research',title:'研究',version:'1.0.0'}],scope:'space-'+loadId}
const fixed={...snapshot,taskId:requestId,ownerId:'owner',inputs:['资料'],createdAssignee:null,createdAt:stamp}
const task={id:requestId,ownerId:'owner',title:'本人修改的标题',goal:'本人修改的目标',scope:snapshot.scope,groupId:null,skills:[],version:3,state:'cancelled',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:stamp,updatedAt:stamp}
const input={requestId,loadId,itemInstanceId,goal:'核对',inputs:[' 资料 ']}
test('行业任务内容版本与完成策略兼容旧回包并严格读取新增字段',async()=>{
 const read=(value:unknown)=>createIndustryTasksHandler('owner',async()=>({preview:async()=>snapshot,create:async()=>({task:value,source:fixed}),source:async()=>fixed}))('industry-tasks/create',input)
 assert.deepEqual(await read(task),{task,source:fixed})
 for(const completionPolicy of [{kind:'manual'},{kind:'verified',verifier:'system-digest',verifierVersion:1,authorizationVersion:2}]){
  const current={...task,contentVersion:2,completionPolicy};assert.deepEqual(await read(current),{task:current,source:fixed})
 }
 for(const fields of [
  ...[null,0,-1,1.5,'2',Number.MAX_SAFE_INTEGER+1].map(contentVersion=>({contentVersion})),
  ...[null,{kind:'manual',extra:true},{kind:'verified',verifier:'unknown',verifierVersion:1,authorizationVersion:1},{kind:'verified',verifier:'system-digest',verifierVersion:0,authorizationVersion:1},{kind:'verified',verifier:'system-digest',verifierVersion:1}].map(completionPolicy=>({completionPolicy})),
  {unexpected:true},
 ])await assert.rejects(read({...task,...fields}),{code:'teloa/invalid-host-response'})
})
test('固定来源与当前合法编辑任务分别读取，拒绝错误身份、声明授权及坏快照',async()=>{
 const calls:unknown[][]=[]
 const handler=createIndustryTasksHandler('owner',async()=>({preview:async()=>snapshot,create:async(...args)=>{calls.push(args);return {task,source:fixed}},source:async()=>fixed}))
 assert.deepEqual(await handler('industry-tasks/preview',{loadId,itemInstanceId}),snapshot)
 assert.deepEqual(await handler('industry-tasks/create',input),{task,source:fixed})
 assert.deepEqual(await handler('industry-tasks/source',{taskId:requestId}),fixed)
 assert.deepEqual(calls,[['owner',input]])
 for(const bad of [{...fixed,ownerId:'other'},{...fixed,taskId:loadId},{...fixed,inputs:[]},{...fixed,requirements:['x','y']},{...fixed,fileHash:'bad'},{...fixed,skills:[{id:'research',title:'研究',version:'1.0.0',granted:true}]},{...fixed,createdAssignee:{roleId:loadId,roleVersion:0}},{...fixed,scope:''},{...fixed,scope:'x'.repeat(81)},{...fixed,createdAt:'yesterday'}]){
  const broken=createIndustryTasksHandler('owner',async()=>({preview:async()=>snapshot,create:async()=>({task,source:bad}),source:async()=>bad}))
  await assert.rejects(broken('industry-tasks/source',{taskId:requestId}),{code:'teloa/invalid-host-response'})
 }
 for(const bad of [{...task,ownerId:'other'},{...task,id:loadId},{...task,state:'invented'},{...task,scope:''}]){
  const broken=createIndustryTasksHandler('owner',async()=>({preview:async()=>snapshot,create:async()=>({task:bad,source:fixed}),source:async()=>fixed}))
  await assert.rejects(broken('industry-tasks/create',input),{code:'teloa/invalid-host-response'})
 }
})
