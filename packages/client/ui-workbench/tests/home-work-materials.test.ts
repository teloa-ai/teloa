import assert from 'node:assert/strict'
import test from 'node:test'
import type {WorkTask} from '@teloa/contract'
import {pinHomeWorkResources} from '../src/client/home-work-materials.ts'

const at='2026-09-13T00:00:00.000Z'
const task=(version:number):WorkTask=>({
  id:'11111111-1111-4111-8111-111111111111',ownerId:'self',version,state:'ready',createdAt:at,updatedAt:at,
  title:'核对告警',goal:'核对告警',scope:'SOC',groupId:null,skills:[],assigneeRoleId:null,assigneeRoleVersion:null,
})

test('首页工作按最新任务版本串行固定所选资料',async()=>{
  const calls:Array<[number,string,number]>=[],changed:number[]=[]
  const result=await pinHomeWorkResources(task(1),[
    {id:'22222222-2222-4222-8222-222222222222',version:3,title:'调查手册'},
    {id:'33333333-3333-4333-8333-333333333333',version:7,title:'处置规范'},
  ],async(_taskId,expectedTaskVersion,resourceId,expectedResourceVersion)=>{
    calls.push([expectedTaskVersion,resourceId,expectedResourceVersion])
    return {task:task(expectedTaskVersion+1),material:{} as never}
  },row=>changed.push(row.version))
  assert.deepEqual(calls,[[1,'22222222-2222-4222-8222-222222222222',3],[2,'33333333-3333-4333-8333-333333333333',7]])
  assert.deepEqual(changed,[2,3])
  assert.equal(result.task.version,3)
  assert.equal(result.error,undefined)
})

test('资料固定失败保留已创建任务事实和最后确认版本',async()=>{
  let calls=0
  const cause=Error('回包待核对')
  const result=await pinHomeWorkResources(task(1),[
    {id:'22222222-2222-4222-8222-222222222222',version:3,title:'调查手册'},
    {id:'33333333-3333-4333-8333-333333333333',version:7,title:'处置规范'},
  ],async(_taskId,expectedTaskVersion)=>{
    calls++
    if(calls===2)throw cause
    return {task:task(expectedTaskVersion+1),material:{} as never}
  },()=>{})
  assert.equal(result.task.version,2)
  assert.equal(result.error,cause)
  assert.equal(calls,2)
})
