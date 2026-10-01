import test from 'node:test'
import assert from 'node:assert/strict'
import {planSkipHistoryInput,planSkipHistoryResponse} from '../src/plan-skip-history.ts'
import {createPlanScheduleHandler} from '../src/plan-schedule.ts'

const planId='11111111-1111-4111-8111-111111111111',claimId='22222222-2222-4222-8222-222222222222'
const item={planId,planVersion:2,configVersion:1,occurrenceId:'2026-09-12T09:00[UTC]',scheduledAt:'2026-09-12T09:00:00.000Z',skippedAt:'2026-09-12T09:00:01.000Z',reason:'previous-pending',blockingClaimId:claimId,taskId:null}
const position={skippedAt:item.skippedAt,configVersion:1,occurrenceId:item.occurrenceId}

test('跳过历史走宿主本人只读接口且不依赖当前调度可用状态',async()=>{
 const calls:unknown[]=[],handle=createPlanScheduleHandler('owner',{isAvailable:()=>false,overview:async()=>null,getStatus:async()=>null,executionHistory:async()=>({items:[]}),skipHistory:async(owner,input)=>{calls.push([owner,input]);return {items:[item]}}})
 assert.deepEqual(await handle('plans/skips',{planId,limit:20}),{items:[item]})
 assert.deepEqual(calls,[['owner',{planId,limit:20}]])
 await assert.rejects(handle('plans/skips',{planId,limit:20,owner:'other'}),{code:'teloa/invalid-input'})
 assert.equal(calls.length,1)
})

test('跳过历史只接受明确计划及精确分页输入',()=>{
 assert.deepEqual(planSkipHistoryInput({planId,limit:20,cursor:position}),{planId,limit:20,cursor:position})
 assert.throws(()=>planSkipHistoryInput({planId,limit:20,cursor:{...position,configVersion:2147483648}}),{code:'teloa/invalid-input'})
 for(const bad of [{limit:20},{planId,limit:0},{planId,limit:51},{planId,limit:1,ownerId:'other'},{planId,limit:1,cursor:{...position,extra:1}},{planId,limit:1,cursor:{...position,configVersion:'1'}},{planId,limit:1,cursor:{...position,occurrenceId:'bad'}}])assert.throws(()=>planSkipHistoryInput(bad),{code:'teloa/invalid-input'})
})
test('跳过历史核对理由任务关系与计划身份，坏行游标仍能推进',()=>{
 assert.deepEqual(planSkipHistoryResponse({items:[item],cursor:position},{planId,limit:1}),{items:[item],cursor:position})
 const error={...position,code:'teloa/storage-corrupt'}
 assert.deepEqual(planSkipHistoryResponse({items:[],errors:[error],cursor:position},{planId,limit:1}),{items:[],errors:[error],cursor:position})
 for(const row of [{...item,planId:claimId},{...item,reason:'unknown'},{...item,reason:['previous-pending']},{...item,reason:'previous-task-unfinished'},{...item,taskId:claimId},{...item,skippedAt:'2026-09-11T09:00:01.000Z'}])assert.throws(()=>planSkipHistoryResponse({items:[row]},{planId,limit:1}),{code:'teloa/invalid-host-response'})
 assert.throws(()=>planSkipHistoryResponse({items:[item],errors:[error]},{planId,limit:2}),{code:'teloa/invalid-host-response'})
 assert.throws(()=>planSkipHistoryResponse({items:[item],cursor:position},{planId,limit:2}),{code:'teloa/invalid-host-response'})
})
test('相同跳过时间按配置版本和事件身份倒序，跨页不允许返回旧位置',()=>{
 const newer={...item,configVersion:2},later={...item,occurrenceId:'2026-09-13T09:00[UTC]'}
 assert.deepEqual(planSkipHistoryResponse({items:[newer,later,item]},{planId,limit:3}).items,[newer,later,item])
 assert.throws(()=>planSkipHistoryResponse({items:[item,newer]},{planId,limit:2}),{code:'teloa/invalid-host-response'})
 assert.throws(()=>planSkipHistoryResponse({items:[item]},{planId,limit:1,cursor:position}),{code:'teloa/invalid-host-response'})
})
