import test from 'node:test'
import assert from 'node:assert/strict'
import {appendPlanSkipHistory,readPlanSkipHistoryPage} from '../src/client/plan-skip-history.ts'
import {createPlanExecutionHistoryRequestGate} from '../src/client/plan-execution-history.ts'

const planId='11111111-1111-4111-8111-111111111111',claimId='22222222-2222-4222-8222-222222222222',taskId='33333333-3333-4333-8333-333333333333'
const occurrenceId='2026-09-12T09:00[Asia/Singapore]',at='2026-09-12T01:00:00.000Z',later='2026-09-12T01:00:02.000Z'
const item={planId,planVersion:3,configVersion:2,occurrenceId,scheduledAt:at,skippedAt:later,reason:'previous-task-unfinished' as const,blockingClaimId:claimId,taskId}

test('严格读取跳过原因、阻塞任务关系和计划身份',()=>{
 assert.deepEqual(readPlanSkipHistoryPage({items:[item]},planId),{items:[item]})
 assert.throws(()=>readPlanSkipHistoryPage({items:[{...item,planId:taskId}]},planId),/跳过记录/)
 assert.throws(()=>readPlanSkipHistoryPage({items:[{...item,reason:'previous-pending',taskId}]},planId),/跳过记录/)
 assert.throws(()=>readPlanSkipHistoryPage({items:[{...item,reason:'previous-task-unfinished',taskId:null}]},planId),/跳过记录/)
 assert.throws(()=>readPlanSkipHistoryPage({items:[{...item,reason:'successful'}]},planId),/跳过记录/)
 assert.throws(()=>readPlanSkipHistoryPage({items:[{...item,reason:new String('previous-task-unfinished')}]},planId),/跳过记录/)
 assert.throws(()=>readPlanSkipHistoryPage({items:[{...item,extra:true}]},planId),/跳过记录/)
})

test('同一时间按配置版本和触发身份倒序并拒绝乱序',()=>{
 const sameTimeOlder={...item,configVersion:1,occurrenceId:'2026-09-12T08:00[Asia/Singapore]',planVersion:3}
 assert.deepEqual(readPlanSkipHistoryPage({items:[item,sameTimeOlder]},planId).items,[item,sameTimeOlder])
 assert.throws(()=>readPlanSkipHistoryPage({items:[sameTimeOlder,item]},planId),/跳过记录/)
 assert.throws(()=>readPlanSkipHistoryPage({items:[item,{...item}]},planId),/跳过记录/)
 assert.throws(()=>readPlanSkipHistoryPage({items:[item,{...item,skippedAt:'2026-09-12T01:00:01.000Z'}]},planId),/跳过记录/)
})

test('坏行推进原始复合游标且分页边界不能倒退',()=>{
 const cursor={skippedAt:later,configVersion:2,occurrenceId},error={...cursor,code:'teloa/storage-corrupt' as const}
 assert.deepEqual(readPlanSkipHistoryPage({items:[],errors:[error],cursor},planId,{limit:1}),{items:[],errors:[error],cursor})
 assert.throws(()=>readPlanSkipHistoryPage({items:[],errors:[error],cursor:{...cursor,occurrenceId:'missing'}},planId,{limit:1}),/跳过记录/)
 assert.throws(()=>readPlanSkipHistoryPage({items:[item],errors:[error]},planId,{limit:1}),/跳过记录/)
 assert.throws(()=>readPlanSkipHistoryPage({items:[item]},planId,{limit:20,cursor}),/跳过记录/)
 assert.throws(()=>readPlanSkipHistoryPage({items:[item],cursor},planId,{limit:2}),/跳过记录/)
 assert.throws(()=>readPlanSkipHistoryPage({items:[],errors:[{...error,configVersion:2147483648}],cursor:{...cursor,configVersion:2147483648}},planId,{limit:1}),/跳过记录/)
})

test('追加下一页保留坏行并拒绝重复和跨页倒退',()=>{
 const currentCursor={skippedAt:later,configVersion:2,occurrenceId},older={...item,configVersion:1,occurrenceId:'2026-09-12T08:00[Asia/Singapore]'}
 const current={items:[item],cursor:currentCursor},next={items:[older]}
 assert.deepEqual(appendPlanSkipHistory(current,next),{items:[item,older]})
 assert.throws(()=>appendPlanSkipHistory(current,{items:[item]}),/跳过记录/)
 assert.throws(()=>appendPlanSkipHistory(current,{items:[],errors:[{skippedAt:'2026-09-12T01:00:03.000Z',configVersion:1,occurrenceId:'2026-09-12T08:00[Asia/Singapore]',code:'teloa/storage-corrupt'}]}),/跳过记录/)
})

test('请求世代拒绝筛选往返后的旧跳过记录',async()=>{
 const gate=createPlanExecutionHistoryRequestGate(),first=gate.begin(),events:string[]=[];let release!:()=>void
 const late=new Promise<void>(resolve=>{release=resolve}).then(()=>{if(gate.current(first))events.push('old')})
 gate.begin();const current=gate.begin();release();await late;if(gate.current(current))events.push('current')
 assert.deepEqual(events,['current'])
})
