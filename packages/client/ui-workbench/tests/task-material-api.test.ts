import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {createTaskMaterialApi} from '../src/client/task-material-api.ts'

const taskId='11111111-1111-4111-8111-111111111111',resourceId='22222222-2222-4222-8222-222222222222',materialId='33333333-3333-4333-8333-333333333333',requestId='44444444-4444-4444-8444-444444444444',at='2026-09-12T00:00:00.000Z'
const task={id:taskId,ownerId:'owner',version:2,state:'ready',createdAt:at,updatedAt:at,title:'核对迁移影响',goal:'根据固定资料完成核对',scope:'general',assigneeRoleId:null,assigneeRoleVersion:null}
const material={id:materialId,taskId,taskVersion:2,resourceId,resourceVersion:3,title:'迁移核对手册',sourceId:'knowledge_guide',sourceVersion:'a'.repeat(64),scopeIds:['general'],available:true,createdAt:at}

test('任务知识 API 作为独立的可恢复任务事实边界存在',()=>{
  assert.equal(existsSync(new URL('../src/client/task-material-api.ts',import.meta.url)),true)
})

test('任务知识目录拒绝跨任务和重复身份，保留固定版本与当前可用性',async()=>{
  const rows=await createTaskMaterialApi(async()=>[material]).list(taskId)
  assert.deepEqual(rows,[material])
  await assert.rejects(createTaskMaterialApi(async()=>[{...material,taskId:resourceId}]).list(taskId),/身份/)
  await assert.rejects(createTaskMaterialApi(async()=>[material,material]).list(taskId),/身份/)
})

test('添加回包丢失后重建客户端使用同一请求恢复，不允许改写固定版本',async()=>{
  let raw:string|null=null,first=true;const sent:unknown[]=[]
  const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
  const call=async(method:string,payload:any)=>{assert.equal(method,'tasks/materials/add');sent.push(payload);if(first){first=false;throw Error('回包丢失')}return {task,material}}
  await assert.rejects(createTaskMaterialApi(call,journal).add(taskId,1,resourceId,3),/回包丢失/)
  const restored=createTaskMaterialApi(call,journal)
  assert.deepEqual(restored.pending(),{requestId:(sent[0] as {requestId:string}).requestId,taskId,expectedTaskVersion:1,resourceId,expectedResourceVersion:3})
  await assert.rejects(restored.add(taskId,1,resourceId,4),/原请求/)
  assert.deepEqual(await restored.recover(),{task,material})
  assert.deepEqual(sent[0],sent[1]);assert.equal(raw,null)
})

test('明确拒绝清除待核对请求，损坏 journal 阻止发送',async()=>{
  let raw:string|null=JSON.stringify({schema:'teloa.task-material-add/v1',request:{requestId,taskId,expectedTaskVersion:1,resourceId,expectedResourceVersion:3}})
  const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
  await assert.rejects(createTaskMaterialApi(async()=>{throw Object.assign(Error('版本冲突'),{rejected:true,code:'teloa/version-conflict'})},journal).recover(),/版本冲突/)
  assert.equal(raw,null)
  let called=false
  const corrupted=createTaskMaterialApi(async()=>{called=true},{read:()=>'{bad',write:()=>{},clear:()=>{}})
  await assert.rejects(corrupted.add(taskId,1,resourceId,3),(error:unknown)=>(error as {code?:unknown})?.code==='teloa/storage-corrupt')
  assert.equal(called,false)
})
