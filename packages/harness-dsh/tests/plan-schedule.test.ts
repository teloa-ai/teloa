import test from 'node:test'
import assert from 'node:assert/strict'
import {createPlanScheduleHandler,type PlanSchedulePorts} from '../src/plan-schedule.ts'

const owner='local:teloa-owner'
const planId='11111111-1111-4111-8111-111111111111'
const otherPlanId='22222222-2222-4222-8222-222222222222'
const occurrenceId='33333333-3333-4333-8333-333333333333'
const taskId='44444444-4444-4444-8444-444444444444'
const at='2026-09-13T01:00:00.000Z'
const overview={
 planId,planVersion:3,state:'active',nextAt:'2026-09-14T01:00:00.000Z',
 latest:{occurrence:{id:occurrenceId,ownerId:owner,planId,planVersion:3,configVersion:1,occurrenceId:'2026-09-13T09:00[Asia/Singapore]',scheduledAt:at,claimedAt:'2026-09-13T01:00:01.000Z',taskRequestId:'55555555-5555-4555-8555-555555555555',fields:{title:'每日核对',goal:'核对资料',scope:'general',dataScope:'已授权资料',delivery:'摘要',roleId:'66666666-6666-4666-8666-666666666666',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}},source:{kind:'manual'},roleVersion:2,taskRequest:{requestId:'55555555-5555-4555-8555-555555555555',fields:{title:'每日核对',goal:'核对资料',scope:'general'},assignee:{roleId:'66666666-6666-4666-8666-666666666666',expectedVersion:2}}},task:{id:taskId,state:'running'}},
 latestSkip:{planId,planVersion:3,configVersion:1,occurrenceId:'2026-09-14T09:00[Asia/Singapore]',scheduledAt:'2026-09-14T01:00:00.000Z',skippedAt:'2026-09-14T01:00:02.000Z',reason:'previous-task-unfinished',blockingClaimId:occurrenceId,taskId},
}
const planHealth={ownerId:owner,planId,health:'failing',failureCode:'teloa/plan-execute-failed',lastAttemptAt:'2026-09-13T01:01:00.000Z',lastSuccessAt:'2026-09-12T01:01:00.000Z'}

function ports(patch:Partial<PlanSchedulePorts>={}):PlanSchedulePorts{
 return {
  isAvailable:()=>true,
  overview:async()=>overview,
  getStatus:async()=>planHealth,
  executionHistory:async()=>({items:[]}),
  skipHistory:async()=>({items:[]}),
  ...patch,
 }
}

test('未知端点和非法计划身份在检查可用性及读取服务前拒绝',async()=>{
 let availableChecks=0,reads=0
 const handle=createPlanScheduleHandler(owner,ports({isAvailable:()=>{availableChecks++;return true},overview:async()=>{reads++;return overview},getStatus:async()=>{reads++;return planHealth}}))
 for(const [endpoint,payload] of [['plans/status',{planId}],['plans/schedule',{}],['plans/schedule',{planId:'bad'}],['plans/schedule',{planId,ownerId:'forged'}]] as const)await assert.rejects(handle(endpoint,payload))
 assert.equal(availableChecks,0);assert.equal(reads,0)
})

const historyItem={claimId:occurrenceId,planId,occurrenceId:'2026-09-13T09:00[Asia/Singapore]',planVersion:3,configVersion:1,notificationPolicy:'attention',scheduledAt:at,claimedAt:'2026-09-13T01:00:01.000Z',task:{id:taskId,state:'running'},run:{id:'77777777-7777-4777-8777-777777777777',state:'active',sessionId:'session-1',createdAt:'2026-09-13T01:00:02.000Z'}}

test('全局执行查询透传精确过滤条件并接受跨计划合法身份',async()=>{
 const calls:unknown[]=[],page={items:[historyItem,{...historyItem,claimId:taskId,planId:otherPlanId,claimedAt:at}]}
 const handle=createPlanScheduleHandler(owner,ports({executionHistory:async(actor,input)=>{calls.push([actor,input]);return page}}))
 const input={limit:20,scope:'SOC',roleId:taskId,query:'核对',runState:'active'}
 assert.deepEqual(await handle('plans/executions',input),page)
 assert.deepEqual(calls,[[owner,input]])
 for(const bad of [{limit:20,owner:'other'},{limit:20,planId:null},{limit:20,scope:''},{limit:20,roleId:'bad'},{limit:20,query:'x'.repeat(241)},{limit:20,runState:['active']},{limit:20,runState:'completed'}])await assert.rejects(handle('plans/executions',bad),{code:'teloa/invalid-input'})
 const broken=createPlanScheduleHandler(owner,ports({executionHistory:async()=>({items:[{...historyItem,planId:'bad'}]})}))
 await assert.rejects(broken('plans/executions',{limit:20}),{code:'teloa/invalid-host-response'})
 await assert.rejects(handle('plans/executions',{limit:20,runState:'ended'}),{code:'teloa/invalid-host-response'})
 await assert.rejects(handle('plans/executions',{limit:20,runState:'not-started'}),{code:'teloa/invalid-host-response'})
})

test('执行历史使用认证owner读取导航事实，独立于当前调度可用性',async()=>{
 const calls:unknown[]=[],page={items:[historyItem]}
 const handle=createPlanScheduleHandler(owner,ports({isAvailable:()=>false,executionHistory:async(actor,input)=>{calls.push({actor,input});return page}}))
 assert.deepEqual(await handle('plans/executions',{planId,limit:20}),page)
 assert.deepEqual(calls,[{actor:owner,input:{planId,limit:20}}])
 for(const item of [{...historyItem,task:null,run:null},{...historyItem,run:null},{...historyItem,run:{...historyItem.run,state:'ended'}}]){
  assert.deepEqual(await createPlanScheduleHandler(owner,ports({executionHistory:async()=>({items:[item]})}))('plans/executions',{planId,limit:1}),{items:[item]})
 }
 const configurationFailed={...historyItem,run:{...historyItem.run,state:'configuration_failed'}}
 assert.deepEqual(await createPlanScheduleHandler(owner,ports({executionHistory:async()=>({items:[configurationFailed]})}))('plans/executions',{planId,limit:1}),{items:[configurationFailed]})
})

test('执行历史请求拒绝伪造身份、未知字段和非法分页，数据库不被调用',async()=>{
 let calls=0
 const handle=createPlanScheduleHandler(owner,ports({executionHistory:async()=>{calls++;return {items:[]}}}))
 for(const input of [{planId},{planId,limit:0},{planId,limit:51},{planId,limit:1.5},{planId,limit:1,ownerId:'other'},{planId,limit:1,cursor:{claimedAt:at,claimId:'bad'}},{planId,limit:1,cursor:{claimedAt:'yesterday',claimId:occurrenceId}},{planId,limit:1,cursor:{claimedAt:at,claimId:occurrenceId,extra:true}}]){
  await assert.rejects(handle('plans/executions',input),{code:'teloa/invalid-input'})
 }
 assert.equal(calls,0)
})

test('执行历史响应拒绝跨计划、重复、非法组合、泄露字段与不推进的分页',async()=>{
 const badPages=[
  {items:[{...historyItem,planId:otherPlanId}]},
  {items:[historyItem,historyItem]},
  {items:[{...historyItem,task:null}]},
  {items:[{...historyItem,task:{id:taskId,state:'made-up'}}]},
  {items:[{...historyItem,run:{...historyItem.run,state:'made-up'}}]},
  {items:[{...historyItem,run:{...historyItem.run,state:['active']}}]},
  {items:[{...historyItem,run:{...historyItem.run,state:{value:'active'}}}]},
  {items:[{...historyItem,notificationPolicy:'unknown'}]},
  {items:[{...historyItem,inputText:'private'}]},
  {items:[{...historyItem,claimedAt:'bad'}]},
  {items:[historyItem],errors:[{claimId:occurrenceId,code:'teloa/storage-corrupt'}]},
  {items:[],errors:[{claimId:occurrenceId,code:'password=secret'}]},
  {items:[historyItem],cursor:{claimId:taskId,claimedAt:at}},
  {items:[],cursor:{claimId:occurrenceId,claimedAt:at}},
 ]
 for(const page of badPages)await assert.rejects(createPlanScheduleHandler(owner,ports({executionHistory:async()=>page}))('plans/executions',{planId,limit:20}),{code:'teloa/invalid-host-response'})
 const page={items:[historyItem],cursor:{claimId:occurrenceId,claimedAt:historyItem.claimedAt}}
 await assert.rejects(createPlanScheduleHandler(owner,ports({executionHistory:async()=>page}))('plans/executions',{planId,limit:1,cursor:page.cursor}),{code:'teloa/invalid-host-response'})
})

test('执行历史坏行页仍可推进，服务失败不能伪造成空历史',async()=>{
 const cursor={claimId:occurrenceId,claimedAt:at},page={items:[],errors:[{claimId:occurrenceId,code:'teloa/storage-corrupt'}],cursor}
 assert.deepEqual(await createPlanScheduleHandler(owner,ports({executionHistory:async()=>page}))('plans/executions',{planId,limit:1}),page)
 const failure=Error('unavailable')
 await assert.rejects(createPlanScheduleHandler(owner,ports({executionHistory:async()=>{throw failure}}))('plans/executions',{planId,limit:1}),error=>error===failure)
})

test('调度未装配时固定返回不可用且不读取数据库端口',async()=>{
 let reads=0
 const handle=createPlanScheduleHandler(owner,ports({isAvailable:()=>false,overview:async()=>{reads++;throw Error()},getStatus:async()=>{reads++;throw Error()}}))
 assert.deepEqual(await handle('plans/schedule',{planId}),{available:false,overview:null,health:null})
 assert.equal(reads,0)
 await assert.rejects(createPlanScheduleHandler(owner,ports({isAvailable:()=>undefined as never}))('plans/schedule',{planId}),{code:'teloa/invalid-host-response'})
})

test('保留真实概览并优先返回该计划健康状态，内部身份不进入wire',async()=>{
 const calls:unknown[][]=[]
 const handle=createPlanScheduleHandler(owner,ports({
  overview:async(actor,input)=>{calls.push(['overview',actor,input]);return overview},
  getStatus:async(actor,input)=>{calls.push(['status',actor,input]);return planHealth},
 }))
 const result=await handle('plans/schedule',{planId})
 assert.deepEqual(calls,[['overview',owner,{planId}],['status',owner,{planId}]])
 assert.deepEqual(result,{available:true,overview,health:{health:'failing',failureCode:'teloa/plan-execute-failed',lastAttemptAt:'2026-09-13T01:01:00.000Z',lastSuccessAt:'2026-09-12T01:01:00.000Z'}})
 assert.equal('ownerId' in (result as {health:Record<string,unknown>}).health,false)
 assert.equal('planId' in (result as {health:Record<string,unknown>}).health,false)
})

test('计划尚无健康记录时读取本人总状态，仍无记录则明确返回null',async()=>{
 const calls:unknown[]=[],ownerHealth={...planHealth,planId:null,health:'healthy',failureCode:null,lastAttemptAt:at,lastSuccessAt:at}
 const fallback=createPlanScheduleHandler(owner,ports({getStatus:async(_actor,input)=>{calls.push(input);return 'planId' in input?null:ownerHealth}}))
 assert.deepEqual((await fallback('plans/schedule',{planId}) as {health:unknown}).health,{health:'healthy',failureCode:null,lastAttemptAt:at,lastSuccessAt:at})
 assert.deepEqual(calls,[{planId},{}])
 const empty=createPlanScheduleHandler(owner,ports({getStatus:async()=>null}))
 assert.equal((await empty('plans/schedule',{planId}) as {health:unknown}).health,null)
})

test('跨本人或跨计划回执、非法健康和任务状态均拒绝',async()=>{
 const cases:Partial<PlanSchedulePorts>[]=[
  {overview:async()=>({...overview,planId:otherPlanId})},
  {overview:async()=>({...overview,latest:{...overview.latest,occurrence:{...overview.latest.occurrence,ownerId:'other'}}})},
  {overview:async()=>({...overview,latest:{...overview.latest,occurrence:{...overview.latest.occurrence,planId:otherPlanId}}})},
  {overview:async()=>({...overview,latest:{...overview.latest,task:{id:taskId,state:'invented'}}})},
  {overview:async()=>({...overview,latestSkip:{...overview.latestSkip,planId:otherPlanId}})},
  {getStatus:async()=>({...planHealth,ownerId:'other'})},
  {getStatus:async()=>({...planHealth,planId:otherPlanId})},
  {getStatus:async()=>({...planHealth,failureCode:'database password=secret'})},
  {getStatus:async()=>({...planHealth,lastAttemptAt:'bad'})},
 ]
 for(const value of cases)await assert.rejects(createPlanScheduleHandler(owner,ports(value))('plans/schedule',{planId}),{code:'teloa/invalid-host-response'})
 const fallbackOwnerMismatch=createPlanScheduleHandler(owner,ports({getStatus:async(_actor,input)=>'planId' in input?null:{...planHealth,planId}}))
 await assert.rejects(fallbackOwnerMismatch('plans/schedule',{planId}),{code:'teloa/invalid-host-response'})
})

test('概览或健康读取失败原样失败，不返回伪造健康',async()=>{
 const overviewError=Error('overview unavailable'),healthError=Error('health unavailable')
 await assert.rejects(createPlanScheduleHandler(owner,ports({overview:async()=>{throw overviewError}}))('plans/schedule',{planId}),error=>error===overviewError)
 await assert.rejects(createPlanScheduleHandler(owner,ports({getStatus:async()=>{throw healthError}}))('plans/schedule',{planId}),error=>error===healthError)
})
