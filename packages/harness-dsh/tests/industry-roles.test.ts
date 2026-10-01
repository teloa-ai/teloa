import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError} from '@teloa/contract'
import {createIndustryRolesHandler} from '../src/industry-roles.ts'
const id='12345678-1234-4234-8234-123456789012',loadId='22345678-1234-4234-8234-123456789012',itemInstanceId='32345678-1234-4234-8234-123456789012',roleId='42345678-1234-4234-8234-123456789012',stamp='2026-09-12T00:00:00.000Z'
const responsibility={triggers:['收到调查任务'],autonomousActions:['整理已授权资料'],confirmationPoints:[],escalationRules:['资料冲突时说明阻塞'],deliveryChecks:['附带证据来源']}
const role={id:roleId,ownerId:'owner',name:'分析员',kind:'employee',scopes:['space-'+loadId],duty:'研究',dataScope:'资料',executionScope:'代拟',skills:[],knowledge:[],responsibility,runtimeConfig:{agentPresetId:'security-analyst'},version:1,state:'paused',createdAt:stamp,updatedAt:stamp}
const record={id,ownerId:'owner',loadId,itemInstanceId,itemLocalId:'analyst',scope:'space-'+loadId,definitionHash:'a'.repeat(64),revision:1,state:'paused',role,knowledge:[],omittedKnowledge:[],declarations:[],failure:null,createdAt:stamp,updatedAt:stamp}
const input={requestId:id,loadId,itemInstanceId}
test('岗位实例入口固定本人及加载项，拒绝客户端定义与权限',async()=>{
 const calls:unknown[][]=[],handler=createIndustryRolesHandler('owner',async()=>({instantiate:async(...args)=>{calls.push(args);return record},get:async()=>record,list:async()=>({items:[record]})}))
 assert.deepEqual(await handler('industry-roles/instantiate',input),record)
 assert.deepEqual(await handler('industry-roles/get',{instanceId:id}),record)
 assert.deepEqual(await handler('industry-roles/list',{}),{items:[record]})
 assert.deepEqual(calls,[['owner',input]])
 for(const extra of [{owner:'other'},{scope:'general'},{fields:role},{knowledge:[id]}])await assert.rejects(handler('industry-roles/instantiate',{...input,...extra}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('industry-roles/delete',{}),{code:'teloa/invalid-input'})
 assert.equal(calls.length,1)
})
test('允许当前岗位合法编辑和退役，拒绝归属、状态和依赖坏回包',async()=>{
 const changed={...record,state:'retired',role:{...role,state:'retired',version:4,name:'本人修改',scopes:['general'],knowledge:[id]}}
 const restored=createIndustryRolesHandler('owner',async()=>({instantiate:async()=>changed,get:async()=>changed,list:async()=>({items:[changed]})}))
 assert.deepEqual(await restored('industry-roles/instantiate',input),changed)
 const bound={itemInstanceId:id,instanceId:roleId,resourceId:loadId,resourceVersion:1}
 for(const bad of [{...record,ownerId:'other'},{...record,scope:''},{...record,scope:'x'.repeat(81)},{...record,definitionHash:'bad'},{...record,role:{...role,ownerId:'other'}},{...record,role:{...role,state:'active'}},{...record,state:'pending'},{...record,revision:2147483648},{...record,knowledge:[bound,bound]},{...record,knowledge:[bound],omittedKnowledge:[{itemInstanceId:id,reason:'withdrawn'}]},{...record,declarations:[{kind:'skill',itemInstanceId:id,status:'installed'}]},{...record,omittedKnowledge:[{itemInstanceId:id,reason:'unknown'}]}]){
  const handler=createIndustryRolesHandler('owner',async()=>({instantiate:async()=>bad,get:async()=>bad,list:async()=>({items:[bad]})}));await assert.rejects(handler('industry-roles/get',{instanceId:id}),{code:'teloa/invalid-host-response'})
 }
})
test('复审 N-1：带 model/skipped 声明（模板模型指定已剥离）的实例可 instantiate/get/list；非 skipped、指向他项或重复的 model 声明被拒',async()=>{
 const notice={kind:'model',itemInstanceId,status:'skipped'},stripped={...record,declarations:[{kind:'skill',itemInstanceId:id,status:'pending-adapter'},notice]}
 const handler=createIndustryRolesHandler('owner',async()=>({instantiate:async()=>stripped,get:async()=>stripped,list:async()=>({items:[stripped]})}))
 assert.deepEqual(await handler('industry-roles/instantiate',input),stripped)
 assert.deepEqual(await handler('industry-roles/get',{instanceId:id}),stripped)
 assert.deepEqual(await handler('industry-roles/list',{}),{items:[stripped]})
 for(const bad of [{...record,declarations:[{...notice,status:'pending-adapter'}]},{...record,declarations:[{...notice,itemInstanceId:id}]},{...record,declarations:[notice,notice]}]){
  const rejecting=createIndustryRolesHandler('owner',async()=>({instantiate:async()=>bad,get:async()=>bad,list:async()=>({items:[bad]})}))
  await assert.rejects(rejecting('industry-roles/list',{}),{code:'teloa/invalid-host-response'})
 }
})
test('重复映射和错误目标被拒，提交未知错误原样保留',async()=>{
 const handler=createIndustryRolesHandler('owner',async()=>({instantiate:async()=>record,get:async()=>record,list:async()=>({items:[record,{...record,id:roleId}]})}))
 await assert.rejects(handler('industry-roles/list',{}),{code:'teloa/invalid-host-response'})
 await assert.rejects(handler('industry-roles/get',{instanceId:roleId}),{code:'teloa/invalid-host-response'})
 await assert.rejects(handler('industry-roles/instantiate',{...input,itemInstanceId:id}),{code:'teloa/invalid-host-response'})
 const error=new WorkError('teloa/storage-unavailable','结果未知'),failed=createIndustryRolesHandler('owner',async()=>{throw error})
 await assert.rejects(failed('industry-roles/instantiate',input),cause=>cause===error)
})
