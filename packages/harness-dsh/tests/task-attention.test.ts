import test from 'node:test'
import assert from 'node:assert/strict'
import {createTaskAttentionHandler} from '../src/task-attention.ts'

const owner='local:teloa-owner',id='11111111-1111-4111-8111-111111111111'
const task={id,ownerId:owner,version:3,state:'blocked',createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T01:00:00.000Z',title:'核对资料',goal:'形成核对结果',scope:'general',assigneeRoleId:null,assigneeRoleVersion:null}
test('真实需要你只读入口从宿主取本人身份并拒绝额外参数',async()=>{
 const calls:unknown[]=[],page={items:[{task,attention:{kind:'error',reason:'task-blocked'}}]}
 const handle=createTaskAttentionHandler(owner,async()=>({list:async(actor,input)=>{calls.push([actor,input]);return page}}))
 assert.deepEqual(await handle({}),page);assert.deepEqual(calls,[[owner,{}]])
 await assert.rejects(handle({owner:'other'}),{code:'teloa/invalid-input'});assert.equal(calls.length,1)
})
test('拒绝跨本人、重复任务、伪状态及原因与任务状态不一致',async()=>{
 const valid={task:{...task,assigneeRoleId:id,assigneeRoleVersion:1},attention:{kind:'error',reason:'execution-failed'}}
 for(const entry of [{...valid,task:{...task,ownerId:'other'}},{...valid,task:{...task,state:['blocked']}},{...valid,task:{...task,id:'x'.repeat(36)}},{...valid,attention:null},{...valid,attention:{kind:'review',reason:'task-waiting'}},{...valid,attention:{kind:'error',reason:'execution-failed',runId:id}},{...valid,task:{...task,state:'completed'}}]){
  const handle=createTaskAttentionHandler(owner,async()=>({list:async()=>({items:[entry]})}))
  await assert.rejects(handle({}),{code:'teloa/invalid-host-response'})
 }
 await assert.rejects(createTaskAttentionHandler(owner,async()=>({list:async()=>({items:[valid,valid]})}))({}),{code:'teloa/invalid-host-response'})
})
test('待核对和无需干预保持当前任务事实，读取失败不能变空列表',async()=>{
 for(const state of ['ready','running','paused','completed','cancelled']){
  const page={items:[{task:{...task,state},attention:null}]}
  assert.deepEqual(await createTaskAttentionHandler(owner,async()=>({list:async()=>page}))({}),page)
 }
 for(const reason of ['execution-completed','task-waiting']){
  const page={items:[{task:{...task,state:'waiting',assigneeRoleId:id,assigneeRoleVersion:1},attention:{kind:'review',reason}}]}
  assert.deepEqual(await createTaskAttentionHandler(owner,async()=>({list:async()=>page}))({}),page)
 }
 await assert.rejects(createTaskAttentionHandler(owner,async()=>({list:async()=>{throw Error('unavailable')}}))({}),/unavailable/)
})

test('运行配置失败可以在未运行任务上呈现，且必须属于数字员工任务',async()=>{
 for(const state of ['ready','paused','blocked','waiting']){
  const page={items:[{task:{...task,state,assigneeRoleId:id,assigneeRoleVersion:1},attention:{kind:'error',reason:'execution-configuration-failed'}}]}
  assert.deepEqual(await createTaskAttentionHandler(owner,async()=>({list:async()=>page}))({}),page)
 }
 const page={items:[{task:{...task,state:'ready'},attention:{kind:'error',reason:'execution-configuration-failed'}}]}
 await assert.rejects(createTaskAttentionHandler(owner,async()=>({list:async()=>page}))({}),{code:'teloa/invalid-host-response'})
})
