import test from 'node:test'
import assert from 'node:assert/strict'
import {mergeTaskAttention,isVerifiedNoAttention,openTaskNativeApproval} from '../src/client/task-attention-state.ts'

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

test('打开原生审批前重核 Task 与 Run，会话换轮、结束、跨任务或换连接后不跳转',async()=>{
 const target={taskId:id,runId:'11111111-1111-4111-8111-111111111111',sessionId:'22222222-2222-4222-8222-222222222222'},running={...task(2,'ready'),state:'running' as const},entry={task:running,attention:null,nativeApproval:{runId:target.runId,sessionId:target.sessionId}}
 const opened:string[]=[]
 assert.equal(await openTaskNativeApproval(target,async()=>({items:[entry]}),async id=>{opened.push(id);return 'opened'},()=>true),true)
 assert.deepEqual(opened,[target.sessionId])
 assert.equal(isVerifiedNoAttention(running,true,[entry],true,[]),false)
 const {nativeApproval,...absent}=entry
 for(const item of [absent,{...entry,nativeApproval:{...nativeApproval,runId:id}},{...entry,nativeApproval:{...nativeApproval,sessionId:id}},{...entry,task:{...running,id:target.runId}},{...entry,task:{...running,state:'cancelled' as const}}])assert.equal(await openTaskNativeApproval(target,async()=>({items:[item]}),async()=>assert.fail('失效来源不能打开'),()=>true),false)
 assert.equal(await openTaskNativeApproval(target,async()=>({items:[entry]}),async()=>assert.fail('换连接不能打开'),()=>false),false)
 await assert.rejects(openTaskNativeApproval(target,async()=>{throw Error('断线')},async()=>assert.fail('断线不能打开'),()=>true),/断线/)
})
