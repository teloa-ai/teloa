import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkFactsService} from '../src/work/work-facts.ts'
import type {Pool} from 'pg'
test('事实投影固定时间窗与可访问业务，读取失败不能变为无记录',async()=>{
 const calls:{sql:string;args:unknown[]}[]=[]
 const db={query:async(sql:string,args:unknown[]=[])=>{calls.push({sql,args});return {rows:[],rowCount:0}},release(){}}
 const pool={connect:async()=>db} as unknown as Pool
 const service=new WorkFactsService(pool,()=> '2026-09-25T02:00:00.000Z')
 const result=await service.read({ownerId:'owner',scopeIds:['general','SOC']},{from:'2026-09-24T16:00:00.000Z',to:'2026-09-25T16:00:00.000Z',timezone:'Asia/Singapore'})
 assert.deepEqual(result.counts,{tasksTouched:0,runsStarted:0,deliveriesCreated:0,blocked:0,waitingReview:0})
 assert.equal(result.coverage,'complete');assert.equal(result.timezone,'Asia/Singapore')
 assert.deepEqual(result.scopes,['general','SOC']);assert.ok(calls.some(x=>x.sql==='begin isolation level repeatable read read only'))
 assert.ok(calls.every(x=>!x.sql.includes('daily_log')&&!x.sql.includes('role_memory')&&!x.sql.includes('input_text')))
 await assert.rejects(service.read({ownerId:'owner',scopeIds:['SOC']},{scope:'general',from:result.from,to:result.to,timezone:'UTC'}),{code:'teloa/forbidden'})
 const broken=new WorkFactsService({connect:async()=>{throw Error('broken database')}} as unknown as Pool,()=>result.observedAt)
 await assert.rejects(broken.read({ownerId:'owner',scopeIds:['SOC']},{from:result.from,to:result.to,timezone:'UTC'}),/broken database/)
})
test('真实记录按明确口径统计：运行开始不是业务完成，当前阻塞保留任务来源',async()=>{
 const db={query:async(sql:string)=>({rows:sql.includes('from teloa_tasks')?[{id:'task',title:'调查',scope:'SOC',state:'blocked',assigneeRoleId:'role',createdAt:new Date('2026-09-25T00:00:00.000Z'),updatedAt:new Date('2026-09-25T01:00:00.000Z')}]:sql.includes('from teloa_task_runs')?[{id:'run',taskId:'task',state:'ended',createdAt:new Date('2026-09-25T00:30:00.000Z'),outcome:'completed'}]:sql.includes('from teloa_artifact_versions')?[{artifactId:'artifact',number:1,taskId:'task',title:'调查结果',createdAt:new Date('2026-09-25T01:00:00.000Z')}]:[]}),release(){}}
 const service=new WorkFactsService({connect:async()=>db} as unknown as Pool,()=> '2026-09-25T02:00:00.000Z')
 const value=await service.read({ownerId:'owner',scopeIds:['SOC']},{scope:'SOC',from:'2026-09-25T00:00:00.000Z',to:'2026-09-26T00:00:00.000Z',timezone:'UTC'})
 assert.deepEqual(value.counts,{tasksTouched:1,runsStarted:1,deliveriesCreated:1,blocked:1,waitingReview:0})
 assert.equal(value.tasks[0]?.id,'task');assert.equal(value.runs[0]?.taskId,'task');assert.equal(value.deliveries[0]?.taskId,'task')
})
