import test from 'node:test'
import assert from 'node:assert/strict'
import {createTaskHandler} from '../src/tasks.ts'
test('状态入口使用宿主本人身份，未知字段在服务调用前拒绝',async()=>{
 let calls=0
 const unused=async()=>{throw Error('不应调用任务定义服务')}
 const handle=createTaskHandler('owner',async()=>({list:unused,create:unused,edit:unused}),async()=>({change:async(owner,input)=>{calls++;assert.equal(owner,'owner');assert.deepEqual(input,{taskId:'t1',requestId:'r1',expectedVersion:1,action:'start'});throw Error('已进入状态服务')}}))
 await assert.rejects(handle('tasks/transition',{taskId:'t1',requestId:'r1',expectedVersion:1,action:'start',ownerId:'other'}),{code:'teloa/invalid-input'});assert.equal(calls,0)
 await assert.rejects(handle('tasks/transition',{taskId:'t1',requestId:'r1',expectedVersion:1,action:'start'}),/已进入状态服务/);assert.equal(calls,1)
})
test('返工资格只读且本人seal仅由可信调用参数传入，JSON不能冒充',async()=>{
 const seal={assertCurrent(){}},unused=async()=>{throw Error('不创建/编辑')};let reads=0,writes=0
 const handler=createTaskHandler('owner',async()=>({list:unused,create:unused,edit:unused}),async()=>({reworkCandidate:async(owner,input)=>{reads++;assert.equal(owner,'owner');assert.deepEqual(input,{taskId:'t1',expectedVersion:6});return {taskId:'t1',taskVersion:6,available:true,controlId:'control'}},change:async(owner,input,proof)=>{assert.equal(owner,'owner');assert.equal((input as {action:string}).action,'rework');if(proof!==seal)throw Object.assign(Error('需要本人确认'),{code:'teloa/forbidden'});writes++;throw Error('已交本人确认')}}))
 await handler('tasks/rework-candidate',{taskId:'t1',expectedVersion:6});assert.equal(reads,1);assert.equal(writes,0)
 const input={taskId:'t1',expectedVersion:6,requestId:'r1',action:'rework'}
 await assert.rejects(handler('tasks/transition',{...input,ownerRework:seal}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('tasks/transition',input),{code:'teloa/forbidden'})
 await assert.rejects(handler('tasks/transition',input,undefined,seal),/已交本人确认/);assert.equal(writes,1)
})
