import test from 'node:test'
import assert from 'node:assert/strict'
import {mergeTaskAttention,isVerifiedNoAttention} from '../src/client/task-attention-state.ts'

const id='12345678-1234-4234-8234-123456789012',at='2026-09-11T00:00:00Z'
const task=(version:number,state:'ready'|'waiting'|'blocked')=>({id,ownerId:'owner',version,state,title:'任务',goal:'核对',scope:'general',groupId:null,skills:[],assigneeRoleId:null,assigneeRoleVersion:null,createdAt:at,updatedAt:at})

test('旧版本写响应不能删除或替换高版本注意证据',()=>{
 const current=[{task:task(5,'blocked'),attention:{kind:'error' as const,reason:'task-blocked' as const}}]
 assert.deepEqual(mergeTaskAttention(current,[task(3,'ready')],[task(5,'blocked')]),current)
 assert.deepEqual(mergeTaskAttention(current,[task(3,'waiting')],[task(5,'blocked')]),current)
})

test('无需干预必须同时确认注意快照与交接快照',()=>{
 const ready=task(1,'ready'),attention=[{task:ready,attention:null}]
 assert.equal(isVerifiedNoAttention(ready,true,attention,false,[]),false)
 assert.equal(isVerifiedNoAttention(ready,true,attention,true,[]),true)
 assert.equal(isVerifiedNoAttention(ready,true,attention,true,[{taskId:id,status:'pending'}]),false)
})
