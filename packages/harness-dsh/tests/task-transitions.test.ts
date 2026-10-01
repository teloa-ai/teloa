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
