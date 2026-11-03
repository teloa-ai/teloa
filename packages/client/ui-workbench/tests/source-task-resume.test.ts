import test from 'node:test'
import assert from 'node:assert/strict'
import {createWorkControlApi} from '../src/client/work-control-api.ts'
const control={id:'11111111-1111-4111-8111-111111111111',ownerId:'local:owner',generation:2,version:3,state:'active' as const,scope:'definition' as const,pendingRunIds:[],unknownOperationIds:[]}
const sourceTask={taskId:'22222222-2222-4222-8222-222222222222',expectedTaskVersion:6,roleId:'33333333-3333-4333-8333-333333333333',expectedRoleVersion:4,sessionId:'task-run-original',expectedControlGeneration:2}
test('J07 客户端明确恢复携带精确原Task/SID，active控制同版回执也不新建Run',async()=>{
 const calls:any[]=[],api=createWorkControlApi(async(endpoint,payload)=>{calls.push({endpoint,payload});return control},undefined,()=> '44444444-4444-4444-8444-444444444444')
 const result=await api.resume(control,[],sourceTask);assert.equal(result.state,'active');assert.equal(calls.length,1);assert.deepEqual(calls[0].payload.sourceTask,sourceTask);assert.equal(calls[0].endpoint,'work-recovery/resume')
})
test('J07 未知恢复重建沿原请求与Task快照；换Task不能借用在途批准',async()=>{
 let raw:string|null=null;const calls:any[]=[],journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}}
 const failed=createWorkControlApi(async(endpoint,payload)=>{calls.push({endpoint,payload});throw Error('lost')},journal,()=> '44444444-4444-4444-8444-444444444444')
 await assert.rejects(failed.resume(control,[],sourceTask));assert.ok(raw);assert.throws(()=>failed.resume(control,[],{...sourceTask,sessionId:'other'}),/请先核对原控制请求/);assert.equal(calls.length,1)
 const restored=createWorkControlApi(async(endpoint,payload)=>{calls.push({endpoint,payload});return control},journal);await restored.recover();assert.deepEqual(calls[1],calls[0]);assert.equal(raw,null)
})
