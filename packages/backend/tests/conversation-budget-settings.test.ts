import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {WorkError} from '@teloa/contract'
import {setupRoleWork} from './role-work-test-fixture.ts'
import {ConversationBudgetSettingsService,initializeConversationBudgetSettings} from '../src/work/conversation-budget-settings.ts'
import {defaultWorkBudgetPolicy} from '../src/work/work-budget.ts'

test('会话页设只保存额度，严格隔离本人/会话且支持无限、版本和原请求恢复',{timeout:60000},async t=>{
 const env=await setupRoleWork();t.after(env.close);await initializeConversationBudgetSettings(env.pool)
 const owner=randomUUID(),sessionId='new-work-settings',eligible=new Set([sessionId,'other-session'])
 const service=new ConversationBudgetSettingsService(env.pool,()=>new Date().toISOString(),async(actor,id)=>{if(actor!==owner||!eligible.has(id))throw new WorkError('teloa/forbidden','不是本人可交办会话')})
 const count=async(table:string)=>Number((await env.pool.query('select count(*) as n from '+table)).rows[0].n)
 const defaults=await service.read(owner,{sessionId})
 assert.equal(defaults.version,0);assert.equal(defaults.configured,false);assert.deepEqual(defaults.policy,defaultWorkBudgetPolicy)
 assert.equal(await count('teloa_conversation_budget_settings'),0)
 const policy={...defaults.policy,maxTokens:null,maxGoalRounds:null,maxConcurrent:null,maxElapsedMs:null},request={requestId:randomUUID(),sessionId,expectedVersion:0,policy}
 const saved=await service.configure(owner,request)
 assert.equal(saved.version,1);assert.equal(saved.configured,true);assert.deepEqual(saved.policy,policy)
 assert.deepEqual(await service.configure(owner,request),saved)
 assert.deepEqual((await service.read(owner,{sessionId})).policy,policy)
 assert.deepEqual(await new ConversationBudgetSettingsService(env.pool,()=>new Date().toISOString(),async()=>{}).read(owner,{sessionId}),saved,'重新打开服务读取真实持久值，不重复配置')
 assert.equal((await service.read(owner,{sessionId:'other-session'})).configured,false)
 await assert.rejects(service.configure(owner,{...request,policy:{...policy,maxTokens:10}}),{code:'teloa/conflict'})
 await assert.rejects(service.configure(owner,{...request,requestId:randomUUID()}),{code:'teloa/version-conflict'})
 await assert.rejects(service.configure(owner,{...request,sessionId:'other-session'}),{code:'teloa/conflict'})
 await assert.rejects(service.read('other-owner',{sessionId}),{code:'teloa/forbidden'})
 await assert.rejects(service.configure(owner,{...request,requestId:randomUUID(),expectedVersion:1,policy:{...policy,maxTokens:undefined}}),{code:'teloa/invalid-input'})
 await assert.rejects(service.configure(owner,{...request,requestId:randomUUID(),expectedVersion:1,policy:{...policy,maxRetries:null}}),{code:'teloa/invalid-input'})
 assert.equal(await count('teloa_tasks'),0);assert.equal(await count('teloa_task_runs'),0);assert.equal(await count('teloa_work_budget_accounts'),0)
 eligible.delete(sessionId)
 await assert.rejects(service.configure(owner,request),{code:'teloa/forbidden'})
})

test('并发页设保存只接受同版本的一次修改，权限等待中变化不落库',{timeout:60000},async t=>{
 const env=await setupRoleWork();t.after(env.close);await initializeConversationBudgetSettings(env.pool)
 const owner=randomUUID(),sessionId='parallel-budget',service=new ConversationBudgetSettingsService(env.pool,()=>new Date().toISOString(),async()=>{})
 const saves=await Promise.allSettled([3_000_000,4_000_000].map(maxTokens=>service.configure(owner,{requestId:randomUUID(),sessionId,expectedVersion:0,policy:{...defaultWorkBudgetPolicy,maxTokens}})))
 assert.equal(saves.filter(value=>value.status==='fulfilled').length,1)
 assert.equal(saves.filter(value=>value.status==='rejected'&&value.reason.code==='teloa/version-conflict').length,1)
 assert.equal((await service.read(owner,{sessionId})).version,1)
 let checks=0
 const revoked=new ConversationBudgetSettingsService(env.pool,()=>new Date().toISOString(),async()=>{if(++checks>1)throw new WorkError('teloa/forbidden','会话已变化')})
 await assert.rejects(revoked.configure(owner,{requestId:randomUUID(),sessionId:'revoked-budget',expectedVersion:0,policy:defaultWorkBudgetPolicy}),{code:'teloa/forbidden'})
 assert.equal(Number((await env.pool.query('select count(*) as n from teloa_conversation_budget_settings where session_id=$1',['revoked-budget'])).rows[0].n),0)
})
