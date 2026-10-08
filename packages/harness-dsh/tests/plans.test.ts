import test from 'node:test'
import assert from 'node:assert/strict'
import {createPlanHandler,createConfirmedPlanHandler,planEndpoints} from '../src/plans.ts'

const owner='local:owner'
const planId='11111111-1111-4111-8111-111111111111',roleId='22222222-2222-4222-8222-222222222222',requestId='33333333-3333-4333-8333-333333333333'
const trigger={kind:'schedule' as const,cadence:'weekly' as const,weekday:2,time:'09:30',timezone:'Asia/Singapore' as const}
const fields={title:'每周资料核对',goal:'核对本周资料并形成结论。',scope:'general',dataScope:'本人已授权资料。',delivery:'变化与待核对项。',roleId,expectedRoleVersion:3,trigger,notificationPolicy:'attention' as const}
const stored={id:planId,ownerId:owner,title:fields.title,goal:fields.goal,scope:fields.scope,dataScope:fields.dataScope,delivery:fields.delivery,roleId,roleVersion:3,trigger,notificationPolicy:fields.notificationPolicy,source:{kind:'manual' as const},version:1,configVersion:1,state:'paused' as const,archivedReason:null,archivedAt:null,createdAt:'2026-09-11T00:00:00.000Z',updatedAt:'2026-09-11T00:00:00.000Z'}
const operations={list:async()=>[stored],get:async()=>stored,create:async()=>stored,change:async()=>stored}

test('自动结项策略回包可读取，本人确认操作与普通计划工具隔离',async()=>{
 const completionPolicy={kind:'verified' as const,verifier:'material-version-summary' as const,verifierVersion:1,authorizationVersion:1},record={...stored,completionPolicy}
 let created=0,confirmed=0
 const get=async()=>({...operations,get:async()=>record,create:async()=>{created++;return record},createConfirmed:async()=>{confirmed++;return record}})
 assert.deepEqual(await createPlanHandler(owner,get)('plans/get',{planId}),record)
 await assert.rejects(createPlanHandler(owner,get)('plans/create-confirmed',{requestId,fields:{...fields,completionPolicy},source:{kind:'manual'}}),{code:'teloa/not-found'})
 await assert.rejects(createPlanHandler(owner,get)('plans/create',{requestId,fields:{...fields,completionPolicy},source:{kind:'manual'}}),{code:'teloa/forbidden'})
 assert.equal((planEndpoints as readonly string[]).includes('plans/create-confirmed'),false)
 assert.deepEqual(await createConfirmedPlanHandler(owner,get)('plans/create-confirmed',{requestId,fields:{...fields,completionPolicy},source:{kind:'manual'}}),record)
 assert.equal(created,0);assert.equal(confirmed,1)
 await assert.rejects(createConfirmedPlanHandler(owner,async()=>operations)('plans/create-confirmed',{requestId,fields:{...fields,completionPolicy},source:{kind:'manual'}}),{code:'teloa/dependency-unavailable'})
})

test('未知端点和非法输入在打开计划服务前拒绝',async()=>{
 let opened=0
 const handle=createPlanHandler(owner,async()=>{opened++;throw Error('不应打开服务')})
 const cases:[string,unknown][]=[
  ['plans/remove',{}],['plans/list',{ownerId:'forged'}],['plans/get',{planId:'bad'}],
  ['plans/create',{requestId,fields:{...fields,trigger:{...trigger,time:'24:00'}},source:{kind:'manual'}}],
  ['plans/create',{requestId,fields:{...fields,notificationPolicy:'unknown'},source:{kind:'manual'}}],
  ['plans/create',{requestId,fields:(({notificationPolicy:_,...legacy})=>legacy)(fields),source:{kind:'manual'}}],
  ['plans/create',{requestId,fields,source:{kind:'manual'},ownerId:'forged'}],
  ['plans/create',{requestId,fields,source:{kind:'market-content',contentId:planId,contentHash:'bad',resourceId:'weekly',resourceVersion:'1.0.0'}}],
  ['plans/change',{planId,requestId,expectedVersion:1,action:'pause',ownerId:'forged'}],
  ['plans/change',{planId,requestId,expectedVersion:1,action:'enable',note:'不应出现'}],
  ['plans/change',{planId,requestId,expectedVersion:1,action:'archive'}],
  ['plans/trigger',{planId,requestId,expectedVersion:1,expectedConfigVersion:1,now:'bad'}],
  ['plans/trigger',{planId,requestId,expectedVersion:1,expectedConfigVersion:1,now:'2026-09-11T00:00:00.000Z',ownerId:'forged'}],
 ]
 for(const [endpoint,payload] of cases)await assert.rejects(handle(endpoint,payload))
 assert.equal(opened,0)
})

test('list和get固定宿主本人并拒绝服务返回其他owner',async()=>{
 const calls:unknown[][]=[],handle=createPlanHandler(owner,async()=>({
  ...operations,
  list:async(actor:unknown,input:unknown)=>{calls.push([actor,input]);return [stored]},
  get:async(actor:unknown,input:unknown)=>{calls.push([actor,input]);return stored},
 }))
 assert.deepEqual(await handle('plans/list',{}),[stored])
 assert.deepEqual(await handle('plans/get',{planId}),stored)
 assert.deepEqual(calls,[[owner,{}],[owner,{planId}]])
 const leaking=createPlanHandler(owner,async()=>({...operations,get:async()=>({...stored,ownerId:'other'})}))
 await assert.rejects(leaking('plans/get',{planId}),{code:'teloa/invalid-host-response'})
})

test('create完整校验计划定义和固定来源后透传，不接受客户端owner',async()=>{
 const source={kind:'market-content' as const,contentId:'44444444-4444-4444-8444-444444444444',contentHash:'a'.repeat(64),resourceId:'weekly-review',resourceVersion:'1.0.0'}
 const input={requestId,fields,source},calls:unknown[][]=[]
 const handle=createPlanHandler(owner,async()=>({...operations,create:async(actor:unknown,value:unknown)=>{calls.push([actor,value]);return {...stored,source}}}))
 const result=await handle('plans/create',input)
 assert.deepEqual(calls,[[owner,input]])
 assert.deepEqual(result,{...stored,source})
 const legacy={...stored} as Record<string,unknown>;delete legacy.notificationPolicy
 assert.deepEqual(await createPlanHandler(owner,async()=>({...operations,list:async()=>[legacy]}))('plans/list',{}),[legacy])
 await assert.rejects(handle('plans/create',{...input,ownerId:owner}),{code:'teloa/invalid-input'})
})

test('change仅透传启用、暂停或带原因归档，并校验固定结果',async()=>{
 const calls:unknown[][]=[],input={planId,requestId,expectedVersion:1,action:'archive' as const,note:'周期工作结束'}
 const archived={...stored,version:2,state:'archived' as const,archivedReason:input.note,archivedAt:'2026-09-11T01:00:00.000Z',updatedAt:'2026-09-11T01:00:00.000Z'}
 const handle=createPlanHandler(owner,async()=>({...operations,change:async(actor:unknown,value:unknown)=>{calls.push([actor,value]);return archived}}))
 assert.deepEqual(await handle('plans/change',input),archived)
 assert.deepEqual(calls,[[owner,input]])
 const broken=createPlanHandler(owner,async()=>({...operations,change:async()=>({...archived,archivedReason:null})}))
 await assert.rejects(broken('plans/change',input),{code:'teloa/invalid-host-response'})
})

test('update只接受固定岗位与业务外的定义字段，并透传双版本',async()=>{
 const updated={...stored,title:'每周资料核对',goal:'核对本周资料。',dataScope:'本周资料。',delivery:'本周变化。',trigger:{kind:'schedule' as const,cadence:'weekly' as const,weekday:5,time:'10:30',timezone:'Asia/Singapore' as const},notificationPolicy:'failure',version:2,configVersion:2,updatedAt:'2026-09-11T01:00:00.000Z'}
 const fields={title:updated.title,goal:updated.goal,dataScope:updated.dataScope,delivery:updated.delivery,trigger:updated.trigger,notificationPolicy:updated.notificationPolicy}
 const input={planId,requestId,expectedVersion:1,expectedConfigVersion:1,action:'update' as const,fields},calls:unknown[][]=[]
 const handle=createPlanHandler(owner,async()=>({...operations,change:async(actor:unknown,value:unknown)=>{calls.push([actor,value]);return updated}}))
 assert.deepEqual(await handle('plans/change',input),updated);assert.deepEqual(calls,[[owner,input]])
 for(const bad of [{...input,fields:{...fields,scope:'SOC'}},{...input,expectedConfigVersion:0},{...input,note:'no'}])await assert.rejects(handle('plans/change',bad),{code:'teloa/invalid-input'})
})

test('立即运行固定本人、双版本与回包任务链，只允许服务端返回同一次执行',async()=>{
 const claimId='55555555-5555-4555-8555-555555555555',taskId='66666666-6666-4666-8666-666666666666',runId='77777777-7777-4777-8777-777777777777'
 const input={planId,requestId,expectedVersion:1,expectedConfigVersion:1,now:'2026-09-11T00:00:00.000Z'},calls:unknown[][]=[]
 const result={occurrence:{id:claimId,ownerId:owner,planId,planVersion:1,configVersion:1,taskRequestId:requestId},task:{id:taskId,ownerId:owner,title:'Auto Dream · 每日小结',goal:'x',scope:'general',version:1,state:'ready',createdAt:'2026-09-11T00:00:00.000Z'},run:{id:runId,taskId,state:'active',roleId,startedAt:'2026-09-11T00:00:00.000Z'}}
 const handle=createPlanHandler(owner,async()=>({...operations,trigger:async(actor:unknown,value:unknown,signal:AbortSignal)=>{calls.push([actor,value,signal.aborted]);return result}}))
 assert.deepEqual(await handle('plans/trigger',input),{planId,claimId,taskId,runId})
 assert.deepEqual(calls,[[owner,input,false]])
 await assert.rejects(createPlanHandler(owner,async()=>operations)('plans/trigger',input),{code:'teloa/dependency-unavailable'})
 await assert.rejects(createPlanHandler(owner,async()=>({...operations,trigger:async()=>({...result,run:{id:runId,taskId:planId}})}))('plans/trigger',input),{code:'teloa/invalid-host-response'})
})

test('Auto Dream 系统计划来源只在回包里接受，客户端不得经 plans/create 提交',async()=>{
 const system={...stored,id:'55555555-5555-4555-8555-555555555555',source:{kind:'system-digest' as const,roleId}}
 const handle=createPlanHandler(owner,async()=>({...operations,list:async()=>[system,stored],get:async()=>system}))
 assert.deepEqual(await handle('plans/list',{}),[system,stored])
 assert.deepEqual(await handle('plans/get',{planId}),system)
 for(const broken of [{kind:'system-digest'},{kind:'system-digest',roleId:'bad'},{kind:'system-digest',roleId,extra:1}]){
  await assert.rejects(createPlanHandler(owner,async()=>({...operations,list:async()=>[{...stored,source:broken}]}))('plans/list',{}),{code:'teloa/invalid-host-response'})
 }
 await assert.rejects(handle('plans/create',{requestId,fields,source:{kind:'system-digest',roleId}}),{code:'teloa/invalid-input'})
})
