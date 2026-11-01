import test from 'node:test'
import assert from 'node:assert/strict'
import type {TaskRunService} from '@teloa/backend'
import {createTaskRunHandler} from '../src/task-runs.ts'

const ids={requestId:'12345678-1234-4234-8234-123456789012',taskId:'22345678-1234-4234-8234-123456789012',roleId:'32345678-1234-4234-8234-123456789012',memoryId:'abcdefab-1234-4234-8234-123456789012'}
function fixture(ownerExecution=false){
 const calls:string[]=[],prepared:unknown[]=[],lookups:unknown[]=[],sessionId='task-run-'+ids.requestId
 const target={taskId:ids.taskId,taskVersion:1,title:'本例任务',roleId:ids.roleId,roleVersion:1,agentPresetId:'synthetic-preset',...ownerExecution?{executor:{kind:'owner',grantId:ids.requestId,grantVersion:1}}:{}}
 const service={conversationParent:async()=>null,request:async(_owner:string,payload:unknown)=>{lookups.push(payload);return null},sourceContinuation:async()=>null,preparationTarget:async()=>target,prepare:async(_owner:string,payload:unknown)=>{prepared.push(payload);return {id:'synthetic-run',state:'prepared'}},failPreparation:async()=>{throw Error('不应配置失败')}} as unknown as TaskRunService
 const handler=createTaskRunHandler('synthetic-owner',async()=>service,{check:async()=>{},resolvePreset:async()=>{calls.push('resolve');return 'synthetic-preset'},send:async()=>{throw Error('本测试不发送')},stop:async()=>{},events:async()=>[]},undefined,{conversations:{runReservation:async()=>null,failRunReservation:async()=>false,createRun:async()=>{calls.push('create');return {id:'conversation',ownerId:'synthetic-owner',title:'本例任务',scopeIds:['general'],version:1,status:'ready',sessionId,requestedSessionId:sessionId,createdAt:'2026-11-01T00:00:00Z',requestId:ids.requestId,purpose:'task-run',run:{taskId:ids.taskId,taskVersion:1,roleId:ids.roleId,roleVersion:1,agentPresetId:'synthetic-preset'}}}},links:{change:async()=>{calls.push('link');return {kind:'task',objectId:ids.taskId,objectVersion:1,conversationId:'conversation',sessionId,version:1,active:true,updatedAt:'2026-11-01T00:00:00Z',scopeId:null}}}})
 return {handler,calls,prepared,lookups,sessionId}
}
test('一键及显式会话准备传同一规范经验选择，省略不回填默认项',async()=>{
 for(const full of [false,true])for(const selection of [undefined,[],[ids.memoryId.toUpperCase()]]){
  const f=fixture(),payload={requestId:ids.requestId,taskId:ids.taskId,expectedTaskVersion:1,...full?{roleId:ids.roleId,expectedRoleVersion:1,sessionId:f.sessionId,expectedLinkVersion:1}:{},...selection===undefined?{}:{selectedMemoryIds:selection}}
  await f.handler('task-runs/prepare',payload,new AbortController().signal)
  const prepared=f.prepared[0] as {selectedMemoryIds?:string[]}
  assert.deepEqual(prepared.selectedMemoryIds,selection===undefined?undefined:selection.map(id=>id.toLowerCase()))
  assert.equal(Object.hasOwn(prepared,'selectedMemoryIds'),selection!==undefined)
  if(!full)assert.deepEqual((f.lookups[0] as {selectedMemoryIds?:string[]}).selectedMemoryIds,prepared.selectedMemoryIds)
 }
})
test('非法选择在会话/Run副作用前拒绝；owner即使空集合也不得使用岗位选择',async()=>{
 for(const selectedMemoryIds of [null,['bad'],[ids.memoryId,ids.memoryId.toUpperCase()]]){
  const f=fixture();await assert.rejects(f.handler('task-runs/prepare',{requestId:ids.requestId,taskId:ids.taskId,expectedTaskVersion:1,selectedMemoryIds},new AbortController().signal),{code:'teloa/invalid-input'});assert.deepEqual(f.calls,[]);assert.deepEqual(f.prepared,[])
 }
 for(const selectedMemoryIds of [[],[ids.memoryId]]){
  const f=fixture(true);await assert.rejects(f.handler('task-runs/prepare',{requestId:ids.requestId,taskId:ids.taskId,expectedTaskVersion:1,selectedMemoryIds},new AbortController().signal),{code:'teloa/invalid-input'});assert.deepEqual(f.calls,[]);assert.deepEqual(f.prepared,[])
 }
})
