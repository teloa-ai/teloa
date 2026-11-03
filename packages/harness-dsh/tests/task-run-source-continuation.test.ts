import test from 'node:test'
import assert from 'node:assert/strict'
import type {TaskRun,TaskExecutionScope,TaskRunRuntimeLink,TaskRunRuntimeLinks} from '@teloa/backend'
import {LocalJobRegistry} from '@deepseek-ai/dsh-jobs-local'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {dshTaskRunPorts} from '../src/task-run-dsh.ts'
import {observeTaskRun} from '../src/task-run-observation.ts'
import {loopWorkFixture,loopText} from './fixtures/native-loop-work-admission.ts'
import {createTaskRunBackground} from '../src/task-run-background.ts'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
import {LoopWorkAdapter} from './fixtures/native-loop-work-admission.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {WorkAccess} from '@teloa/backend'
import {attachTaskRunBrowser,createTaskRunBrowser} from '../src/task-run-browser.ts'

test('实际DSH循环连续两次告警续报保留历史，每轮独立模型、请求与后台归属，重放不再次发送',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),adapter=new LoopWorkAdapter()
 ctx.llm.registerAdapter(['loop-test'],adapter)
 const input=createNativeWorkInput(ctx,new WorkAccess());t.after(input.close)
 await ctx.plugin(LocalJobRegistry,{})
 ctx.provide('sessionController',{resolveAgent:async()=>({agent}),prompt:async()=>{throw Error('固定模型不得退回控制器发送')}} as never)
 ctx.provide('attachments',{admitPromptContent:async(content:unknown)=>structuredClone(content)} as never)
 const saved=new Map<string,TaskRunRuntimeLink>(),links:TaskRunRuntimeLinks={list:async({runId})=>[...saved.values()].filter(row=>row.runId===runId),put:async row=>{saved.set(JSON.stringify([row.runId,row.kind,row.nativeId]),structuredClone(row))}}
 const ports=dshTaskRunPorts(ctx,'owner',async sessionId=>({ownerId:'owner',sessionId,status:'ready'}),undefined,undefined,undefined,undefined,undefined,undefined,links,undefined,undefined,input)
 const browser=createTaskRunBrowser(ctx,links,async()=>null);t.after(browser.dispose);attachTaskRunBrowser(ports,browser)
 let previous:TaskRun|null=null
 ports.sourceContinuation=async()=>previous
 let releases=0;ports.releaseRunSkills=async()=>{if(++releases%2===0)await new Promise(resolve=>setTimeout(resolve,5))}
 const base={taskId:'alert-a',roleId:'employee',roleVersion:1,roleSnapshot:{kind:'employee'},linkVersion:1,sessionId:agent.id,state:'prepared',allowedTools:[],skills:[],knowledge:[],stopRequestedAt:null} as unknown as TaskRun
 const signal=AbortSignal.timeout(20000),finished:TaskRun[]=[]
 for(let version=1;version<=3;version++){
  const run={...base,id:'run-'+version,nativeRequestId:'input-'+version,taskVersion:version,inputText:'ALERT_A_VERSION_'+version,modelPolicy:{primary:{provider:'loop-test',model:'model-'+version}}}
  const target:TaskExecutionScope={taskId:run.taskId,taskVersion:version,sessionId:agent.id,linkVersion:1,scope:'SOC'}
  if(previous){
   const proof=previous
   previous={...proof,evidence:{...proof.evidence!,endSeq:0} as TaskRun['evidence']}
   await assert.rejects(ports.check(run,signal,target),{code:'teloa/conflict'},'错误终态不能许可续报')
   previous={...proof,taskId:'alert-b'}
   await assert.rejects(ports.check(run,signal,target),{code:'teloa/forbidden'},'其他告警的证明不能占用原会话')
   previous=proof
   assert.equal(adapter.requests.length,version-1)
  }
  adapter.scripts.push(loopText)
  await Promise.all([ports.check(run,signal,target),ports.check(run,signal,target)]);if(version>1)assert.equal((await ctx.systemPrompt.assemble({agent,scope:agent})).sections.filter(x=>x.name==='teloa:employee-behavior').length,0,'previous employee lease retired before version '+version);await assert.doesNotReject(ports.send(run,signal,target),'employee source version '+version);await agent.whenIdle()
  const events=agent.session.snapshotEvents(),observed=observeTaskRun(events,run.nativeRequestId)
  assert.equal(observed.state,'ended');assert.equal(adapter.requests.length,version)
  const request=JSON.stringify(adapter.requests.at(-1))
  for(let earlier=1;earlier<=version;earlier++)assert.ok(request.includes('ALERT_A_VERSION_'+earlier),'当前模型输入保留前轮历史和本轮新快照')
  assert.ok(request.includes('model-'+version),'本轮使用本轮固定模型')
  await ports.send(run,signal,target);assert.equal(adapter.requests.length,version,'同请求重放不能再发送')
  previous={...run,state:'ended',evidence:observed as TaskRun['evidence']};finished.push(previous)
 }
 for(const run of finished){
  assert.deepEqual(observeTaskRun(agent.session.snapshotEvents(),run.nativeRequestId),run.evidence,'后轮不能改变前轮终态归属')
  assert.equal((await links.list({runId:run.id})).filter(row=>row.kind==='job'&&row.payload.record==='owner').length,1)
 }
 previous=null
 await assert.rejects(ports.check({...base,id:'unproved',taskVersion:4},signal),{code:'teloa/conflict'},'没有同源账本证明不能占用有历史的会话')
 assert.equal(adapter.requests.length,3)
})

test('续报切换后历史job只归旧Run，旧回执及停止不能占用新Run，未完成job阻止切换',async t=>{
 const {ctx,agent}=await loopWorkFixture(t)
 await ctx.plugin(LocalJobRegistry,{});ctx.jobs.attachController('continuation-test')
 const saved=new Map<string,TaskRunRuntimeLink>(),links:TaskRunRuntimeLinks={list:async({runId})=>[...saved.values()].filter(row=>row.runId===runId),put:async row=>{saved.set(JSON.stringify([row.runId,row.kind,row.nativeId]),structuredClone(row))}}
 const background=createTaskRunBackground(ctx,links,()=>true,'runtime');t.after(background.dispose)
 const first={id:'first',sessionId:agent.id,nativeRequestId:'first-input'},next={...first,id:'next',nativeRequestId:'next-input'}
 await background.start(first)
 let done!:(result:{status:'completed'})=>void
 const job=ctx.jobs.start({kind:'bash',label:'原告警后台工作',owner:agent.id,run:()=>({done:new Promise(resolve=>{done=resolve}),cancel:()=>{}})})
 await assert.rejects(background.prepareContinuation(first),{code:'teloa/conflict'})
 done({status:'completed'});await ctx.jobs.wait(job,1000,agent.id);await background.flush(agent.id)
 await background.prepareContinuation(first);await background.start(next)
 await background.state(next)
 assert.equal((await links.list({runId:next.id})).some(row=>row.kind==='job'&&row.payload.record==='job'),false,'扫描旧job不能转嫁给新Run')
 let finish!:(result:{status:'completed'})=>void,cancelled=0
 const second=ctx.jobs.start({kind:'bash',label:'续报告警后台工作',owner:agent.id,run:()=>({done:new Promise(resolve=>{finish=resolve}),cancel:()=>{cancelled++}})})
 assert.equal((await background.state(next)).outstanding,true)
 assert.equal((await background.state(first)).outstanding,false,'旧Run读数不继承新Run后台活动')
 await assert.rejects(background.cancel(first,new AbortController().signal))
 assert.equal(cancelled,0,'旧Run停止不能取消新Run的job')
 finish({status:'completed'});await ctx.jobs.wait(second,1000,agent.id);await background.flush(agent.id)
 assert.equal((await links.list({runId:first.id})).filter(row=>row.kind==='job'&&row.payload.record==='job').length,1)
 assert.equal((await links.list({runId:next.id})).filter(row=>row.kind==='job'&&row.payload.record==='job').length,1)
})

test('原Run合法追加轮的最终终态用于续报准入，不能只核对最初轮次',async t=>{
 const {ctx,agent,adapter}=await loopWorkFixture(t)
 ctx.provide('sessionController',{resolveAgent:async()=>({agent})} as never)
 ctx.provide('attachments',{admitPromptContent:async(content:unknown)=>structuredClone(content)} as never)
 const ports=dshTaskRunPorts(ctx,'owner',async sessionId=>({ownerId:'owner',sessionId,status:'ready'}))
 const run={id:'initial',taskId:'alert',taskVersion:1,linkVersion:1,sessionId:agent.id,nativeRequestId:'root-request',allowedTools:[],skills:[],knowledge:[],stopRequestedAt:null,inputText:'首报',modelPolicy:{primary:{provider:'loop-test',model:'first'}}} as unknown as TaskRun
 const target={taskId:run.taskId,taskVersion:1,linkVersion:1,sessionId:agent.id,scope:'SOC'},signal=AbortSignal.timeout(10000)
 adapter.scripts.push(loopText,loopText,loopText)
 await ports.send(run,signal,target);await agent.whenIdle()
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'approved-append'},content:[{type:'text',text:'原工作获准追加'}]}));await agent.whenIdle()
 const continuations=new Set([JSON.stringify(['group-append','approved-append'])])
 const ended={...run,state:'ended',evidence:observeTaskRun(agent.session.snapshotEvents(),run.nativeRequestId,continuations)} as TaskRun
 assert.equal(ended.evidence?.state,'ended')
 ports.sourceContinuation=async()=>ended;ports.continuations=async()=>continuations
 const next={...run,id:'next',taskVersion:2,nativeRequestId:'new-source',inputText:'同告警新版',modelPolicy:{primary:{provider:'loop-test',model:'second'}}}
 await ports.check(next,signal,{...target,taskVersion:2});await ports.send(next,signal,{...target,taskVersion:2});await agent.whenIdle()
 assert.equal(adapter.requests.length,3)
 assert.deepEqual(observeTaskRun(agent.session.snapshotEvents(),run.nativeRequestId,continuations),ended.evidence)
})


test('旧提交finally迟到不能重装已退休租约或覆盖同SID的新Run',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),adapter=new LoopWorkAdapter()
 ctx.llm.registerAdapter(['loop-test'],adapter)
 const input=createNativeWorkInput(ctx,new WorkAccess());t.after(input.close)
 await ctx.plugin(LocalJobRegistry,{})
 ctx.provide('sessionController',{resolveAgent:async()=>({agent}),prompt:async()=>{throw Error('固定模型不得退回控制器发送')}} as never)
 ctx.provide('attachments',{admitPromptContent:async(content:unknown)=>structuredClone(content)} as never)
 let releaseFirst!:()=>void,firstPublished!:()=>void
 const holdFirst=new Promise<void>(resolve=>{releaseFirst=resolve}),published=new Promise<void>(resolve=>{firstPublished=resolve})
 t.after(releaseFirst)
 const delayed={...input,withNewInput:async(...args:Parameters<typeof input.withNewInput>)=>{
  await input.withNewInput(...args)
  const source=args[1].source
  if(source.kind==='user'&&'rpcId' in source&&source.rpcId==='late-first-input'){firstPublished();await holdFirst}
 }}
 const saved=new Map<string,TaskRunRuntimeLink>(),links:TaskRunRuntimeLinks={list:async({runId})=>[...saved.values()].filter(row=>row.runId===runId),put:async row=>{saved.set(JSON.stringify([row.runId,row.kind,row.nativeId]),structuredClone(row))}}
 const ports=dshTaskRunPorts(ctx,'owner',async sessionId=>({ownerId:'owner',sessionId,status:'ready'}),undefined,undefined,undefined,undefined,undefined,undefined,links,undefined,undefined,delayed)
 let previous:TaskRun|null=null;ports.sourceContinuation=async()=>previous
 const base={taskId:'late-alert',roleId:'employee',roleVersion:1,roleSnapshot:{kind:'employee'},linkVersion:1,sessionId:agent.id,state:'prepared',allowedTools:[],skills:[],knowledge:[],stopRequestedAt:null,modelPolicy:{primary:{provider:'loop-test',model:'model'}}} as unknown as TaskRun
 const first={...base,id:'late-first',nativeRequestId:'late-first-input',taskVersion:1,inputText:'FIRST_SOURCE'},second={...base,id:'late-second',nativeRequestId:'late-second-input',taskVersion:2,inputText:'SECOND_SOURCE'},third={...base,id:'late-third',nativeRequestId:'late-third-input',taskVersion:3,inputText:'THIRD_SOURCE'}
 const target=(run:TaskRun):TaskExecutionScope=>({taskId:run.taskId,taskVersion:run.taskVersion,sessionId:run.sessionId,linkVersion:1,scope:'SOC'}),signal=AbortSignal.timeout(15000)
 adapter.scripts.push(loopText,loopText)
 const firstSend=ports.send(first,signal,target(first));const firstSettled=firstSend.then(()=>undefined,error=>error)
 await published;await agent.whenIdle()
 const firstEvidence=observeTaskRun(agent.session.snapshotEvents(),first.nativeRequestId);assert.equal(firstEvidence.state,'ended')
 previous={...first,state:'ended',evidence:firstEvidence as TaskRun['evidence']}
 await ports.check(second,signal,target(second))
 assert.equal((await ctx.systemPrompt.assemble({agent,scope:agent})).sections.some(x=>x.name==='teloa:employee-behavior'),false,'真实旧native完成后的准备必须先退休旧租约，即使旧send的finally还未返回')
 await ports.send(second,signal,target(second));await agent.whenIdle()
 releaseFirst();assert.equal(await firstSettled,undefined)
 assert.equal((await ctx.systemPrompt.assemble({agent,scope:agent})).sections.filter(x=>x.name==='teloa:employee-behavior').length,1,'旧finally不得释放或覆盖新Run当前规则')
 const nextEvidence=observeTaskRun(agent.session.snapshotEvents(),second.nativeRequestId);assert.equal(nextEvidence.state,'ended')
 previous={...second,state:'ended',evidence:nextEvidence as TaskRun['evidence']}
 await ports.check(third,signal,target(third))
 assert.equal((await ctx.systemPrompt.assemble({agent,scope:agent})).sections.some(x=>x.name==='teloa:employee-behavior'),false,'退休新Run后无旧Run泄漏，非employee后续不继承员工规则')
 assert.equal(adapter.requests.length,2);for(const req of adapter.requests){const body=JSON.stringify(req.messages.filter(m=>m.role==='system'));assert.equal(body.split('# AI employee working rules').length-1,1)}
 assert.deepEqual(observeTaskRun(agent.session.snapshotEvents(),first.nativeRequestId),firstEvidence,'后轮不改旧native终态')
})


test('真实员工装配在发布前失败或取消时撤销全部租约，下一正常请求只含一份规则',async t=>{
 for(const outcome of ['failure','abort'] as const)await t.test(outcome,async t=>{
  const {ctx,agent}=await patchedSessionFixture(t),adapter=new LoopWorkAdapter()
  ctx.llm.registerAdapter(['loop-test'],adapter)
  const input=createNativeWorkInput(ctx,new WorkAccess());t.after(input.close)
  ctx.provide('sessionController',{resolveAgent:async()=>({agent}),prompt:async()=>{throw Error('固定模型不得退回控制器发送')}} as never)
  const controller=new AbortController(),failure=new Error('fixture attachment admission failed');let reject=true
  ctx.provide('attachments',{admitPromptContent:async(content:unknown)=>{if(reject){if(outcome==='failure')throw failure;controller.abort(new Error('fixture cancellation'))}return structuredClone(content)}} as never)
  const ports=dshTaskRunPorts(ctx,'owner',async sessionId=>({ownerId:'owner',sessionId,status:'ready'}),undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,input)
  const run={id:'before-publication',taskId:'failure-task',roleId:'employee',roleVersion:1,roleSnapshot:{kind:'employee'},taskVersion:1,linkVersion:1,sessionId:agent.id,state:'prepared',nativeRequestId:'before-publication-input',inputText:'SYNTHETIC_FAILURE_CASE',allowedTools:[],skills:[],knowledge:[],stopRequestedAt:null,modelPolicy:{primary:{provider:'loop-test',model:'model'}}} as unknown as TaskRun
  const target:TaskExecutionScope={taskId:run.taskId,taskVersion:1,sessionId:run.sessionId,linkVersion:1,scope:'SOC'}
  await assert.rejects(ports.send(run,controller.signal,target),error=>error===(outcome==='failure'?failure:controller.signal.reason))
  assert.equal(adapter.requests.length,0);assert.equal(agent.session.snapshotEvents().some(e=>e.type==='user/message'),false)
  assert.equal((await ctx.systemPrompt.assemble({agent,scope:agent})).sections.some(x=>x.name==='teloa:employee-behavior'),false)
  reject=false;adapter.scripts.push(loopText)
  await ports.send({...run,id:'after-known-failure',nativeRequestId:'after-known-failure-input'},AbortSignal.timeout(10000),target);await agent.whenIdle()
  assert.equal(adapter.requests.length,1);assert.equal(JSON.stringify(adapter.requests[0]!.messages.filter(m=>m.role==='system')).split('# AI employee working rules').length-1,1)
 })
})
