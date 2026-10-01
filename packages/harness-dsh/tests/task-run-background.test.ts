import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId,type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LocalJobRegistry} from '@deepseek-ai/dsh-jobs-local'
import type {JobOutcome} from '@deepseek-ai/dsh-jobs'
import type {TaskRun,TaskRunRuntimeLinks,TaskRunRuntimeLink} from '@teloa/backend'
import {TaskRunDriver} from '../src/task-run-driver.ts'
import {createTaskRunBackground,isOwnerOnlyTextRun} from '../src/task-run-background.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'

function linkStore(){
 const rows=new Map<string,TaskRunRuntimeLink>()
 const store:TaskRunRuntimeLinks={list:async input=>[...rows.values()].filter(row=>row.runId===input.runId&&(!input.kind||row.kind===input.kind)),put:async row=>{rows.set(row.kind+':'+row.nativeId,structuredClone(row))}}
 return store
}

test('仅固定无工具无技能 Run 的单条旧 owner 关联可作为纯文本恢复候选',()=>{
 const run={id:'run',sessionId:'session',nativeRequestId:'native',allowedTools:[],skills:[],subagents:[],stopRequestedAt:null} as unknown as TaskRun
 const owner={runId:'run',kind:'job',nativeId:'owner:old:session',sessionId:'session',payload:{record:'owner',runtimeId:'old',requestId:'native'}} as Extract<TaskRunRuntimeLink,{kind:'job'}>
 assert.equal(isOwnerOnlyTextRun(run,[owner],'new'),true)
 for(const unsafe of [
  {...run,allowedTools:['bash']},
  {...run,skills:[{name:'managed'}]},
  {...run,stopRequestedAt:'2026-09-30T00:00:00Z'},
  {...run,groupContext:{groupId:'group'}},
  {...run,flowId:'flow'},
  {...run,subagents:[{childSessionId:'child'}]},
  {...run,subagents:undefined},
  {...run,allowedTools:undefined},
  {...run,skills:undefined},
 ])assert.equal(isOwnerOnlyTextRun(unsafe as TaskRun,[owner],'new'),false)
 assert.equal(isOwnerOnlyTextRun(run,[],'new'),false)
 assert.equal(isOwnerOnlyTextRun(run,[owner,owner],'new'),false)
 assert.equal(isOwnerOnlyTextRun(run,[owner,{...owner,kind:'team',payload:{requestId:'native',reservationId:'team',name:'helper'}}],'new'),false)
 assert.equal(isOwnerOnlyTextRun(run,[owner,{...owner,kind:'browser',payload:{runtimeId:'old',requestId:'native',dispatchId:'dispatch',status:'closed'}}],'new'),false)
 assert.equal(isOwnerOnlyTextRun(run,[{...owner,sessionId:'other'}],'new'),false)
 assert.equal(isOwnerOnlyTextRun(run,[{...owner,payload:{record:'owner',runtimeId:'new',requestId:'native'}}],'new'),false)
 assert.equal(isOwnerOnlyTextRun(run,[{...owner,payload:{record:'owner',runtimeId:'old',requestId:'other'}}],'new'),false)
})
test('后台读口仅在完整固定空权限且无任何其他关联时提供旧 owner 纯文本候选',async t=>{
 const {ctx,agent}=await runtime(),links=linkStore()
 const run={id:'run',sessionId:agent.id,nativeRequestId:'native',allowedTools:[],skills:[],subagents:[],stopRequestedAt:null} as unknown as TaskRun
 await links.put({runId:run.id,kind:'job',nativeId:'owner:old:'+run.sessionId,sessionId:run.sessionId,payload:{record:'owner',runtimeId:'old',requestId:run.nativeRequestId}})
 const background=createTaskRunBackground(ctx,links,undefined,'new')
 t.after(async()=>{background.dispose();await ctx.fiber.dispose()})
 assert.deepEqual(await background.state(run),{outstanding:false,interrupted:true,ownerOnly:true})
 await links.put({runId:run.id,kind:'browser',nativeId:'old:dispatch',sessionId:run.sessionId,payload:{runtimeId:'old',requestId:run.nativeRequestId,dispatchId:'dispatch',status:'closed'}})
 assert.deepEqual(await background.state(run),{outstanding:false,interrupted:true})
})
async function runtime(){
 const ctx=new Context()
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
 await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(LocalJobRegistry,{})
 ctx.jobs.attachController('task-run-test')
 const {agent}=await ctx.agents.create({sessionId:SessionId('managed-job-owner'),agentOptions:{provider:'test',model:'test'}})
 return {ctx,agent}
}

test('官方 job 尚在运行或停止中时，初始轮完成不能把业务 Run 交付',async t=>{
 const {ctx,agent}=await runtime()
 let finish!:(outcome:JobOutcome)=>void
 t.after(async()=>{finish?.({status:'killed'});await ctx.fiber.dispose()})
 const done=new Promise<JobOutcome>(resolve=>{finish=resolve})
 const id=ctx.jobs.start({kind:'bash',label:'controlled work',owner:agent.session.id,run:()=>({done,cancel:()=>{}})})
 let run={id:'run',sessionId:agent.session.id,nativeRequestId:'native',state:'active',stopRequestedAt:null} as unknown as TaskRun
 const events=[{seq:0,time:0,type:'turn/start',data:{turn:0}},{seq:1,time:1,type:'user/message',surfaceOp:'append',data:{id:'request',source:{kind:'user',rpcId:'native'},role:'user',content:[]}},{seq:2,time:2,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}}] as SessionEvent[]
 const service={get:async()=>run,executionScope:async()=>{throw Error('not used')},claim:async()=>{throw Error('not used')},requestStop:async()=>run,record:async(_owner:string,input:unknown)=>{const evidence=(input as {evidence:NonNullable<TaskRun['evidence']>}).evidence;run={...run,evidence,state:evidence.state};return run}}
 const driver=new TaskRunDriver(service,{check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>events,backgroundState:async()=>({outstanding:ctx.jobs.list(agent.session.id).some(job=>job.owner===agent.session.id&&['running','stopping'].includes(job.status)),interrupted:false})})
 assert.equal((await driver.reconcile('owner',{runId:'run'})).state,'active')
 ctx.jobs.kill(id,agent.session.id)
 assert.equal(ctx.jobs.get(id,agent.session.id).status,'stopping')
 assert.equal((await driver.reconcile('owner',{runId:'run'})).state,'active')
 finish({status:'completed'});await ctx.jobs.wait(id,1000,agent.session.id)
 assert.equal((await driver.reconcile('owner',{runId:'run'})).state,'ended')
})

test('后台关联从官方 owner 记录，取消只作用本 Run，重建适配不能重放丢失工作',async t=>{
 const {ctx,agent}=await runtime(),finishes:Array<(outcome:JobOutcome)=>void>=[]
 t.after(async()=>{for(const finish of finishes)finish({status:'killed'});await ctx.fiber.dispose()})
 const run={id:'run',sessionId:agent.session.id,nativeRequestId:'native'}
 const links=linkStore(),background=createTaskRunBackground(ctx,links);t.after(background.dispose);await background.start(run)
 agent.session.append('turn/start',{turn:0})
 agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>('native')}}),{surfaceOp:'append'})
 let ownedCancels=0,foreignCancels=0
 const start=(owner:SessionId|undefined,cancel:()=>void)=>ctx.jobs.start({kind:'bash',label:'private work',...(owner?{owner}:{}),run:()=>({done:new Promise<JobOutcome>(resolve=>finishes.push(resolve)),cancel})})
 const owned=start(agent.session.id,()=>{ownedCancels++})
 const unowned=start(undefined,()=>{foreignCancels++})
 assert.equal((await background.state(run)).outstanding,true)
 const records=(await links.list({runId:run.id,kind:'job'})).filter(row=>row.kind==='job'&&row.payload.record==='job')
 assert.equal(records.length,1);assert.ok(records[0]?.kind==='job'&&records[0].payload.record==='job');assert.equal(records[0].payload.jobId,owned);assert.equal(records[0]!.sessionId,agent.session.id)
 agent.session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 agent.session.append('turn/start',{turn:1})
 agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>('unrelated')}}),{surfaceOp:'append'})
 const unrelated=start(agent.session.id,()=>{foreignCancels++})
 await background.cancel(run,new AbortController().signal)
 assert.equal(ctx.jobs.get(owned,agent.session.id).status,'stopping')
 assert.equal(ctx.jobs.get(unowned).status,'running');assert.equal(ctx.jobs.get(unrelated,agent.session.id).status,'running')
 assert.deepEqual({ownedCancels,foreignCancels},{ownedCancels:1,foreignCancels:0})
 const recovered=createTaskRunBackground(ctx,links,undefined,'00000000-0000-4000-8000-000000000001');t.after(recovered.dispose)
 assert.equal((await recovered.state(run)).interrupted,true)
 assert.equal(ownedCancels,1)
 finishes[0]!({status:'killed'});await ctx.jobs.wait(owned,1000,agent.session.id)
 assert.equal((await background.state(run)).outstanding,false)
 assert.equal((await background.state(run)).interrupted,false)
})

test('真实job已启动但关联尚未落库时，重启的owner-only记录不能冒充安全收口',async t=>{
 const {ctx,agent}=await runtime(),stored=linkStore()
 let persist!:()=>void,finish!:(outcome:JobOutcome)=>void
 const delayed=new Promise<void>(resolve=>{persist=resolve})
 const links:TaskRunRuntimeLinks={list:stored.list,put:async row=>{
  if(row.kind==='job'&&row.payload.record==='job')await delayed
  await stored.put(row)
 }}
 const run={id:'run',sessionId:agent.session.id,nativeRequestId:'native'}
 const background=createTaskRunBackground(ctx,links)
 const recovered=createTaskRunBackground(ctx,stored,undefined,'00000000-0000-4000-8000-000000000002')
 t.after(async()=>{persist();finish?.({status:'killed'});background.dispose();recovered.dispose();await ctx.fiber.dispose()})
 await background.start(run)
 agent.session.append('turn/start',{turn:0})
 agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>('native')}}),{surfaceOp:'append'})
 ctx.jobs.start({kind:'bash',label:'job before journal flush',owner:agent.session.id,run:()=>({done:new Promise<JobOutcome>(resolve=>{finish=resolve}),cancel:()=>{}})})
 agent.session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 const journal=await stored.list({runId:run.id,kind:'job'})
 assert.equal(journal.length,1);assert.equal(journal[0]?.kind==='job'&&journal[0].payload.record,'owner')
 assert.deepEqual(await recovered.state(run),{outstanding:false,interrupted:true})
 persist()
 assert.equal((await background.state(run)).outstanding,true)
})

test('提交未知在当前官方Agent已空闲且后台收口时落定，旧世代只读核验不推翻持久终态',async t=>{
 const {ctx,agent}=await runtime(),links=linkStore(),background=createTaskRunBackground(ctx,links)
 t.after(async()=>{background.dispose();await ctx.fiber.dispose()})
 let run={id:'run',taskId:'task',sessionId:agent.session.id,nativeRequestId:'native',state:'prepared',stopRequestedAt:null} as unknown as TaskRun,sends=0
 const target={taskId:'task',taskVersion:1,sessionId:agent.session.id,linkVersion:1,scope:'general'}
 const service={get:async()=>run,executionScope:async()=>target,claim:async()=>{run={...run,state:'submitting'};return {run,dispatch:true as const,target}},requestStop:async()=>run,record:async(_owner:string,input:unknown)=>{const evidence=(input as {evidence:NonNullable<TaskRun['evidence']>}).evidence;run={...run,state:evidence.state,evidence};return run}}
 const driver=new TaskRunDriver(service,{check:async()=>{},stop:async()=>{},backgroundState:background.state,events:async()=>readSessionEvents(agent.session),send:async()=>{
  sends++;await background.start(run)
  agent.session.append('turn/start',{turn:0})
  agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>('native')}}),{surfaceOp:'append'})
  agent.session.append('turn/end',{turn:0,reason:{kind:'completed'}})
  throw Error('回包丢失')
 }})
 await assert.rejects(driver.start('owner',{runId:'run'},new AbortController().signal),{code:'teloa/execution-pending'})
 assert.equal(run.state,'ended');assert.equal(run.evidence?.state==='ended'&&run.evidence.reason,'completed')
 const recovered=createTaskRunBackground(ctx,links,undefined,'00000000-0000-4000-8000-000000000002');t.after(recovered.dispose)
 assert.equal((await recovered.state(run)).interrupted,true)
 driver.ports.backgroundState=recovered.state
 const reconciled=await driver.reconcile('owner',{runId:'run'})
 assert.equal(reconciled.evidence?.state==='ended'&&reconciled.evidence.reason,'completed')
 assert.equal(sends,1)
})
