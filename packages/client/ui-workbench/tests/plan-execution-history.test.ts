import test from 'node:test'
import assert from 'node:assert/strict'
import {appendPlanExecutionHistory,createPlanExecutionHistoryRequestGate,readPlanExecutionDirectoryPage,readPlanExecutionHistoryPage} from '../src/client/plan-execution-history.ts'

const planId='11111111-1111-4111-8111-111111111111'
const claimId='22222222-2222-4222-8222-222222222222'
const taskId='33333333-3333-4333-8333-333333333333'
const runId='44444444-4444-4444-8444-444444444444'
const occurrenceId='daily:2026-09-12T01:00:00.000Z'
const at='2026-09-12T01:00:00.000Z'
const later='2026-09-12T01:00:01.000Z'
const item={claimId,planId,occurrenceId,planVersion:3,configVersion:2,notificationPolicy:'attention' as const,scheduledAt:at,claimedAt:later,task:{id:taskId,state:'running' as const},run:{id:runId,state:'active' as const,sessionId:'session-native-1',createdAt:later}}

test('严格读取真实执行历史的合法状态与 nullable 关系',()=>{
 const states=['prepared','submitting','accepted','active','ended','withdrawn','configuration_failed'] as const
 for(const state of states)assert.equal(readPlanExecutionHistoryPage({items:[{...item,run:{...item.run,state}}]},planId).items[0]!.run!.state,state)
 assert.deepEqual(readPlanExecutionHistoryPage({items:[{...item,task:null,run:null}]},planId).items[0]!.task,null)
 assert.deepEqual(readPlanExecutionHistoryPage({items:[{...item,run:null}],errors:[{claimId:'55555555-5555-4555-8555-555555555555',code:'teloa/storage-corrupt'}],cursor:{claimedAt:later,claimId}},planId),{items:[{...item,run:null}],errors:[{claimId:'55555555-5555-4555-8555-555555555555',code:'teloa/storage-corrupt'}],cursor:{claimedAt:later,claimId}})
})

test('拒绝未知字段、跨计划、重复身份和非法组合',()=>{
 const reject=(value:unknown)=>assert.throws(()=>readPlanExecutionHistoryPage(value,planId),/执行历史/)
 reject({items:[{...item,unknown:true}]})
 reject({items:[{...item,planId:'55555555-5555-4555-8555-555555555555'}]})
 reject({items:[item,item]})
 reject({items:[{...item,task:{...item.task,id:'bad'}}]})
 reject({items:[{...item,run:{...item.run,id:'bad'}}]})
 reject({items:[{...item,task:null}]})
 reject({items:[{...item,run:{...item.run,state:'completed'}}]})
 reject({items:[{...item,run:{...item.run,state:new String('active')}}]})
 reject({items:[{...item,notificationPolicy:'unknown'}]})
 reject({items:[{...item,scheduledAt:'2026-09-12'}]})
 reject({items:[item],cursor:{claimedAt:'bad',claimId}})
 reject({items:[item],cursor:{claimedAt:later,claimId:'bad'}})
 reject({items:[item],errors:[{claimId,code:'teloa/storage-corrupt'}]})
 reject({items:[],errors:[{claimId,code:'database password leaked'}]})
 reject({items:[],errors:[{claimId,code:'teloa/storage-corrupt',detail:'secret'}]})
 reject({items:[],extra:true})
})

test('分页响应遵守请求额度、原始游标身份与严格倒序边界',()=>{
 const older={...item,claimId:'55555555-5555-4555-8555-555555555555',scheduledAt:'2026-09-12T00:59:00.000Z',claimedAt:at,task:null,run:null}
 assert.throws(()=>readPlanExecutionHistoryPage({items:[older,item]},planId),/执行历史/)
 assert.throws(()=>readPlanExecutionHistoryPage({items:[],cursor:{claimedAt:at,claimId}},planId),/执行历史/)
 assert.throws(()=>readPlanExecutionHistoryPage({items:[item],cursor:{claimedAt:at,claimId}},planId),/执行历史/)
 assert.throws(()=>readPlanExecutionHistoryPage({items:[item],cursor:{claimedAt:later,claimId:'66666666-6666-4666-8666-666666666666'}},planId),/执行历史/)
 assert.throws(()=>readPlanExecutionHistoryPage({items:[item],errors:[{claimId:'66666666-6666-4666-8666-666666666666',code:'teloa/storage-corrupt'}],cursor:{claimedAt:'2026-09-12T02:00:00.000Z',claimId:'66666666-6666-4666-8666-666666666666'}},planId),/执行历史/)
 assert.throws(()=>readPlanExecutionHistoryPage({items:[item,older]},planId,{limit:1}),/执行历史/)
 assert.throws(()=>readPlanExecutionHistoryPage({items:[item]},planId,{limit:20,cursor:{claimedAt:later,claimId}}),/执行历史/)
 assert.deepEqual(readPlanExecutionHistoryPage({items:[],errors:[{claimId,code:'teloa/storage-corrupt'}],cursor:{claimedAt:at,claimId}},planId),{items:[],errors:[{claimId,code:'teloa/storage-corrupt'}],cursor:{claimedAt:at,claimId}})
})

test('拒绝非 UUID 请求计划身份',()=>{
 assert.throws(()=>readPlanExecutionHistoryPage({items:[]},'bad'),/执行历史/)
})

test('跨计划目录接受任意合法计划身份但仍拒绝坏身份与跨页倒退',()=>{
 const other={...item,planId:'55555555-5555-4555-8555-555555555555'}
 assert.deepEqual(readPlanExecutionDirectoryPage({items:[other]}),{items:[other]})
 assert.throws(()=>readPlanExecutionDirectoryPage({items:[{...other,planId:'bad'}]}),/执行历史/)
 assert.throws(()=>readPlanExecutionDirectoryPage({items:[other]}, {limit:20,cursor:{claimedAt:later,claimId}}),/执行历史/)
})

test('追加分页保持倒序且拒绝重复或倒退回包',()=>{
 const older={...item,claimId:'55555555-5555-4555-8555-555555555555',claimedAt:at,task:null,run:null}
 const current={items:[item],errors:[{claimId:'66666666-6666-4666-8666-666666666666' as string,code:'teloa/storage-corrupt' as const}],cursor:{claimedAt:later,claimId}}
 const next={items:[older]}
 assert.deepEqual(appendPlanExecutionHistory(current,next),{items:[item,older],errors:current.errors})
 assert.throws(()=>appendPlanExecutionHistory(current,{items:[item]}),/执行历史/)
 assert.throws(()=>appendPlanExecutionHistory(current,{items:[{...older,claimedAt:'2026-09-12T02:00:00.000Z'}]}),/执行历史/)
 assert.throws(()=>appendPlanExecutionHistory(current,{items:[],errors:[current.errors[0]!]}),/执行历史/)
})

test('请求世代在 A 到 B 再回 A 时仍拒绝旧 A 的迟到结果',async()=>{
 const gate=createPlanExecutionHistoryRequestGate(),first=gate.begin(),events:string[]=[]
 let release!:()=>void
 const late=new Promise<void>(resolve=>{release=resolve}).then(()=>{if(gate.current(first))events.push('old-a')})
 gate.begin()
 const currentA=gate.begin()
 release();await late
 if(gate.current(currentA))events.push('new-a')
 assert.deepEqual(events,['new-a'])
})
