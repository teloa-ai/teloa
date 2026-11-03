import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtemp,readFile,writeFile,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionStore,SessionId,SessionSeq} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry,type ProjectionDefinition} from '@deepseek-ai/dsh-session-projection'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
import {LoopWorkAdapter,loopText} from './fixtures/native-loop-work-admission.ts'
import {dshTaskRunPorts} from '../src/task-run-dsh.ts'
import {observeTaskRun} from '../src/task-run-observation.ts'
import {createTaskRunHandler} from '../src/task-runs.ts'
import {sourceFollowupNotice,resultFollowupNotice,errorRecoveryNotice,stoppedContinuationNotice,type ModelReference} from '@teloa/contract'
import type {TaskRun,TaskExecutionScope} from '@teloa/backend'
import {attachTaskRunBrowser,createTaskRunBrowser} from '../src/task-run-browser.ts'

test('unknown后续只认原prefix与最多一条官方空end-seed，不能伪造completed',async()=>{
 const {assertSourceFollowupEvents}=await import('../src/task-run-source-followup.ts')
 const events=[] as unknown[]
 const run={id:randomUUID(),sessionId:'original',nativeRequestId:randomUUID(),state:'submission_unknown',stopRequestedAt:new Date().toISOString(),evidence:null,submissionDisposition:{logCut:-1,logSha256:createHash('sha256').update(JSON.stringify(events)).digest('hex')}}
 assert.doesNotThrow(()=>assertSourceFollowupEvents(run as never,events as never))
 const marker={seq:0,type:'session/end-seed',data:{},time:1}
 assert.doesNotThrow(()=>assertSourceFollowupEvents(run as never,[marker] as never))
 for(const tail of [[{...marker,data:{inherited:true}}],[marker,{...marker,seq:1}],[{...marker,type:'user/message'}]])assert.throws(()=>assertSourceFollowupEvents(run as never,tail as never))
 assert.throws(()=>assertSourceFollowupEvents({...run,state:'ended'} as never,events as never))
})

for(const compression of ['none','zstd'] as const)test('纯官方持久冷读核验完整prefix和空Inbox，不启动Agent或修改日志：'+compression,async t=>{
 const {inspectSourceFollowup}=await import('../src/task-run-source-followup.ts')
 const pkg=await patchedNativePackage<typeof import('@deepseek-ai/dsh-agent-loop')&{inboxProjectionDefinition:ProjectionDefinition<'inbox'>&{wire:NonNullable<ProjectionDefinition<'inbox'>['wire']>}}>(t,{packageName:'@deepseek-ai/dsh-agent-loop',compatBasename:'dsh-agent-loop-0.2.1-rc.2-work-admission'})
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-followup-cold-'))),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(Jsonl,{root,compression});ctx.sessionProjections.register(pkg.namespace.inboxProjectionDefinition)
 ctx.provide('workingDirectory',{defaultDirectory:root} as never);ctx.provide('agents',{get:()=>undefined} as never)
 const id=SessionId('original-'+randomUUID()),writer=await ctx.sessionPersistence.create({id,version:4,createdAt:1,cwd:root,agentPreset:'worker',isSeeded:false})
 await writer.flush();await writer.close()
 const path=await Reflect.get(ctx.sessionPersistence,'resolveCurrentLog').call(ctx.sessionPersistence,id),before=await readFile(path)
 const runId=randomUUID(),nativeRequestId=randomUUID(),createdAt=new Date().toISOString(),inputText='原执行固定输入'
 const run:TaskRun={id:runId,taskId:randomUUID(),roleId:randomUUID(),taskVersion:4,roleVersion:1,linkVersion:1,sessionId:id,nativeRequestId,agentPresetId:'worker',state:'submission_unknown',stopRequestedAt:createdAt,evidence:null,allowedTools:[],skills:[],knowledge:[],memory:[],inputText,createdAt,submissionDisposition:{schema:'teloa.task-run-submission-disposition/v1',requestId:randomUUID(),runId,sessionId:id,nativeRequestId,inputSha256:createHash('sha256').update(inputText).digest('hex'),runtimeId:randomUUID(),logCut:-1,logSha256:createHash('sha256').update('[]').digest('hex'),acknowledgedUnknown:true,closedAt:createdAt}}
 await inspectSourceFollowup(ctx,run,AbortSignal.timeout(5000));assert.deepEqual(await readFile(path),before)
 const marker={type:'session/end-seed' as const,seq:SessionSeq(0),time:2,data:{}}
 const append=await ctx.sessionPersistence.open(id,'write');await append.append([marker]);await append.flush();await append.close()
 await inspectSourceFollowup(ctx,run,AbortSignal.timeout(5000));assert.deepEqual((await readFile(path)).subarray(0,before.length),before)
 const errorId=SessionId('failed-'+randomUUID()),errorRequest=randomUUID(),errorWriter=await ctx.sessionPersistence.create({id:errorId,version:4,createdAt:1,cwd:root,agentPreset:'worker',isSeeded:false})
 const errorEvents=[{type:'turn/start',seq:SessionSeq(0),time:1,data:{turn:1}},{type:'user/message',seq:SessionSeq(1),time:2,surfaceOp:'append',data:createUserMessage({source:{kind:'user',rpcId:errorRequest},content:[{type:'text',text:'固定失败输入'}]})},{type:'turn/end',seq:SessionSeq(2),time:3,data:{turn:1,reason:{kind:'error',error:{code:'UNKNOWN',message:'固定失败'}}}}] as Parameters<typeof observeTaskRun>[0]
 await errorWriter.append(errorEvents);await errorWriter.flush();await errorWriter.close()
 const errorPath=await Reflect.get(ctx.sessionPersistence,'resolveCurrentLog').call(ctx.sessionPersistence,errorId),errorBytes=await readFile(errorPath),errorEvidence=observeTaskRun(errorEvents,errorRequest);assert(errorEvidence.state==='ended');const {submissionDisposition:_oldDisposition,...errorBasis}=run;const errorRun:TaskRun={...errorBasis,id:randomUUID(),sessionId:errorId,nativeRequestId:errorRequest,state:'ended',stopRequestedAt:null,evidence:errorEvidence}
 await inspectSourceFollowup(ctx,errorRun,AbortSignal.timeout(5000),async events=>assert.deepEqual(observeTaskRun(events,errorRequest),errorRun.evidence));assert.deepEqual(await readFile(errorPath),errorBytes)
 await assert.rejects(inspectSourceFollowup(ctx,{...errorRun,stopRequestedAt:createdAt},AbortSignal.timeout(5000),async()=>{}),{code:'teloa/conflict'})
 const {unpublishedFollowupFixture}=await import('../../backend/tests/fixtures/source-followup-unpublished.ts'),{sourceFollowupCandidate}=await import('../../backend/src/work/task-run-source-followups.ts')
 const f=unpublishedFollowupFixture(),stopped={...errorRun,roleSnapshot:{} as never,stopRequestedAt:createdAt,inputText:f.run.inputText};f.update.state='accepted';f.update.task_id=stopped.taskId;f.update.run_id=stopped.id
 const db={query:async(sql:string,params?:unknown[])=>sql.startsWith('select * from teloa_task_runs')?{rows:[{task_id:stopped.taskId,session_id:stopped.sessionId,native_request_id:stopped.nativeRequestId,input_text:stopped.inputText,role_id:stopped.roleId,role_version:stopped.roleVersion,state:stopped.state,evidence:stopped.evidence,stop_requested_at:stopped.stopRequestedAt}]}:f.db.query(sql,params)}
 await sourceFollowupCandidate(db as never,f.owner,stopped,6)
 await inspectSourceFollowup(ctx,stopped,AbortSignal.timeout(5000),async events=>assert.deepEqual(observeTaskRun(events,errorRequest),stopped.evidence))
 assert.deepEqual(await readFile(errorPath),errorBytes,'停止后新续办冷读不改原日志')
 await assert.rejects(inspectSourceFollowup(ctx,{...stopped},AbortSignal.timeout(5000),async()=>{}),{code:'teloa/conflict'})

 const queued=createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'旧待办不能被重新执行'}]})
 const event={type:'agent/inbox/spliced' as const,seq:SessionSeq(1),time:3,data:{target:'next-turn' as const,start:0,inserted:[queued]}}
 const pending=await ctx.sessionPersistence.open(id,'write');await pending.append([event]);await pending.flush();const {events}=await pending.read();await pending.close()
 const queueRun={...run,submissionDisposition:{...run.submissionDisposition!,logCut:events.length-1,logSha256:createHash('sha256').update(JSON.stringify(events)).digest('hex')}}
 await assert.rejects(inspectSourceFollowup(ctx,queueRun,AbortSignal.timeout(5000)),{code:'teloa/conflict'},'prefix正确也不能把非空Inbox当空闲')
 const bytes=await readFile(path);await writeFile(path,compression==='none'?Buffer.concat([bytes,Buffer.from('{"type":')]):bytes.subarray(0,bytes.length-2))
 await assert.rejects(inspectSourceFollowup(ctx,queueRun,AbortSignal.timeout(5000)))
 for(const key of ['agentLoop','llm','tools'])assert.equal(ctx.get(key as never),undefined)
})

for(const kind of ['unknown-verification','result-verification','error-recovery'] as const)test('真实DSH循环：新确认正文与原限制进入provider，原nativeRequest不重发：'+kind,async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),adapter=new LoopWorkAdapter();ctx.llm.registerAdapter(['test'],adapter)
 ctx.provide('sessionController',{resolveAgent:async()=>({agent})} as never);ctx.provide('attachments',{admitPromptContent:async(content:unknown)=>structuredClone(content)} as never)
 const ports=dshTaskRunPorts(ctx,'owner',async sessionId=>({ownerId:'owner',sessionId,status:'ready'})),taskId=randomUUID(),roleId=randomUUID()
 const browser=createTaskRunBrowser(ctx,{list:async()=>[],put:async()=>{}},async()=>null);t.after(browser.dispose);attachTaskRunBrowser(ports,browser)
 const base={id:randomUUID(),taskId,taskVersion:1,roleId,roleVersion:1,sessionId:agent.id,nativeRequestId:randomUUID(),linkVersion:1,state:'prepared',stopRequestedAt:null,allowedTools:[],skills:[],knowledge:[],modelPolicy:{primary:{provider:'test',model:'test'}},inputText:'ORIGINAL_RESTRICTION_DO_NOT_REPEAT'} as unknown as TaskRun
 const target:TaskExecutionScope={taskId,taskVersion:1,sessionId:agent.id,linkVersion:1,scope:'SOC'},signal=AbortSignal.timeout(15000)
 adapter.scripts.push(kind==='error-recovery'?[{type:'finish',reason:{kind:'error',failure:{code:'UNKNOWN',message:'fixture original model failed'}}}]:loopText);await ports.send(base,signal,target);await agent.whenIdle()
 const events=agent.session.snapshotEvents(),evidence=observeTaskRun(events,base.nativeRequestId),original={...base,id:base.id,state:kind==='unknown-verification'?'submission_unknown':'ended',evidence:kind==='unknown-verification'?null:evidence,nativeRequestId:base.nativeRequestId,stopRequestedAt:kind==='unknown-verification'?new Date().toISOString():null} as TaskRun
 if(kind==='unknown-verification')original.submissionDisposition={schema:'teloa.task-run-submission-disposition/v1',requestId:randomUUID(),runId:original.id,sessionId:agent.id,nativeRequestId:original.nativeRequestId,inputSha256:createHash('sha256').update(original.inputText).digest('hex'),runtimeId:randomUUID(),logCut:events.length-1,logSha256:createHash('sha256').update(JSON.stringify(events)).digest('hex'),acknowledgedUnknown:true,closedAt:new Date().toISOString()}
 const f={schema:'teloa.task-run-source-followup/v1',kind,requestId:randomUUID(),taskId,taskVersion:3,sessionId:agent.id,originalRunId:original.id,originalNativeRequestId:original.nativeRequestId,originalInputSha256:createHash('sha256').update(original.inputText).digest('hex'),originalEvidenceSha256:kind==='unknown-verification'?null:'c'.repeat(64),...(original.submissionDisposition?{disposition:original.submissionDisposition}:{}),sourceUpdateId:randomUUID(),sourceTaskVersion:1,sourceEventId:randomUUID(),reference:{scope:'SOC',type:'alert',id:'A2_ONLY',version:2,snapshotHash:'a'.repeat(64)},instruction:'VERIFY_NEW_EVIDENCE_ONLY_KEEP_ORIGINAL_LIMITS',confirmedAt:new Date().toISOString(),notice:kind==='unknown-verification'?sourceFollowupNotice:kind==='error-recovery'?errorRecoveryNotice:resultFollowupNotice}
 const run={...base,id:randomUUID(),taskVersion:3,nativeRequestId:randomUUID(),sourceFollowup:f,inputText:JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:taskId,version:3,title:'原告警',scope:'SOC',goal:'ORIGINAL_RESTRICTION_DO_NOT_REPEAT'},sourceFollowup:f,businessContext:{updates:[{id:'A2_ONLY',version:2}]}})} as TaskRun
 if(kind==='error-recovery'){assert.equal(original.evidence?.state==='ended'&&original.evidence.reason,'error');ports.sourceContinuation=async()=>original;const ordinary={...run};delete ordinary.sourceFollowup;await assert.rejects(ports.check(ordinary,signal,{...target,taskVersion:3}),{code:'teloa/conflict'});delete ports.sourceContinuation}
 let inspected=0;ports.sourceFollowup=async()=>original;ports.inspectSourceFollowup=async value=>{inspected++;assert.equal(value.id,original.id)}
 adapter.scripts.push(loopText);await ports.check(run,signal,{...target,taskVersion:3});await ports.send(run,signal,{...target,taskVersion:3});await agent.whenIdle()
 const provider=JSON.stringify(adapter.requests.at(-1));for(const text of [f.notice,f.instruction,'ORIGINAL_RESTRICTION_DO_NOT_REPEAT','A2_ONLY'])assert.ok(provider.includes(text),text)
 assert.equal(adapter.requests.length,2);assert.ok(inspected>=2)
 await ports.send(run,signal,{...target,taskVersion:3});assert.equal(adapter.requests.length,2,'同请求重放不得追加模型调用')
 const messages=agent.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.source.kind==='user')
 assert.equal(messages.filter(e=>e.type==='user/message'&&Reflect.get(e.data.source,'rpcId')===base.nativeRequestId).length,1)
 if(kind==='unknown-verification')assert.equal(messages.filter(e=>e.type==='user/message'&&Reflect.get(e.data.source,'rpcId')===original.nativeRequestId).length,1,'原unknown请求不得重发')
})

for(const kind of ['result-verification','stopped-continuation'] as const)for(const override of [false,true])test('宿主按同一确认串行准备，保留本人显式模型而默认模型继续当前解析：'+kind+'/'+override,async()=>{
 const taskId=randomUUID(),original={id:randomUUID(),taskId,taskVersion:4,roleId:randomUUID(),roleVersion:1,linkVersion:1,sessionId:'original-session',nativeRequestId:randomUUID(),state:'ended',evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:kind==='stopped-continuation'?'error':'completed'},stopRequestedAt:kind==='stopped-continuation'?'2026-11-03T00:00:00.000Z':null,agentPresetId:'worker',permissionMode:'approval',allowedTools:[],skills:[],knowledge:[],modelPolicy:{primary:{provider:'fixture',model:override?'owner-picked':'old-default'},...(override?{fallback:{provider:'fixture',model:'owner-fallback'}}:{})},...(override?{modelPolicyOverride:true}:{})} as unknown as TaskRun
 const candidate={schema:'teloa.task-run-source-followup-candidate/v1',kind,taskId,expectedTaskVersion:6,runId:original.id,sessionId:original.sessionId,originalNativeRequestId:original.nativeRequestId,originalInputSha256:'a'.repeat(64),originalEvidenceSha256:'b'.repeat(64),...(kind==='stopped-continuation'?{originalStopRequestedAt:original.stopRequestedAt}:{}),sourceUpdateId:randomUUID(),sourceTaskVersion:4,sourceEventId:randomUUID(),reference:{scope:'SOC',type:'alert',id:'source-record',version:2,snapshotHash:'c'.repeat(64)}}
 const command={kind,requestId:randomUUID(),runId:original.id,expectedTaskVersion:6,sourceUpdateId:candidate.sourceUpdateId,instruction:'按固定来源核对并保存。'},checks:unknown[]=[]
 let requests=0,targets=0,preparations=0,defaults=0,permissions=0
 const savedId=randomUUID(),service={get:async()=>original,request:async()=>{requests++;return null},sourceFollowupTarget:async()=>{targets++;await new Promise(resolve=>setTimeout(resolve,5));return {candidate,original}},prepare:async(...args:any[])=>{
  preparations++;const options=args[8],modelPolicy=options.modelPolicy??await args[6]({runtimeConfig:{}})
  assert.equal(options.permissionMode,original.permissionMode)
  if(kind==='stopped-continuation'){assert.equal(options.sourceFollowup.originalStopRequestedAt,original.stopRequestedAt);assert.equal(options.sourceFollowup.notice,stoppedContinuationNotice)}
  return {...original,id:savedId,nativeRequestId:randomUUID(),state:'prepared',evidence:null,stopRequestedAt:null,sourceFollowup:options.sourceFollowup,modelPolicy,modelPolicyOverride:options.modelPolicy!==undefined}
 }}
 const ports={inspectSourceFollowup:async()=>{},check:async()=>{throw Error('不得warm')},send:async()=>{throw Error('不得自动start')},stop:async()=>{},events:async()=>[],resolvePreset:async(p:string|undefined)=>p!,prepareModels:async()=>{defaults++;return {primary:{provider:'fixture',model:'current-default'}}},checkModel:async(model:ModelReference)=>{checks.push(model)},checkPermissionMode:async()=>{permissions++}}
 const handler=createTaskRunHandler('owner',async()=>service as never,ports as never,undefined,{conversations:{} as never,links:{} as never,admitRun:async()=>{}})
 const pending=handler('task-runs/source-followup/prepare',command,AbortSignal.timeout(5000)),parallel=handler('task-runs/source-followup/prepare',{...command},AbortSignal.timeout(5000))
 await assert.rejects(handler('task-runs/source-followup/prepare',{...command,instruction:'同request篡改正文'},AbortSignal.timeout(5000)),{code:'teloa/conflict'})
 const [a,b]=await Promise.all([pending,parallel]) as TaskRun[]
 assert.equal(a!.id,b!.id);assert.equal(requests,1);assert.equal(targets,1);assert.equal(preparations,1,'宿主request读取与target最新判断作为同一确认串行')
 assert.equal(permissions,1);assert.equal(a!.modelPolicyOverride,override)
 if(override){assert.deepEqual(a!.modelPolicy,original.modelPolicy);assert.deepEqual(checks,[original.modelPolicy!.primary,original.modelPolicy!.fallback]);assert.equal(defaults,0)}else{assert.equal(a!.modelPolicy?.primary.model,'current-default');assert.deepEqual(checks,[]);assert.equal(defaults,1)}
})

test('真实DSH未发布撤回：typed取消prefix零重放，新确认手动发送并保留旧成功轮',async t=>{
 const {unpublishedFollowupFixture}=await import('../../backend/tests/fixtures/source-followup-unpublished.ts')
 const {sourceFollowupCandidate}=await import('../../backend/src/work/task-run-source-followups.ts')
 const {assertUnpublishedSourceFollowupEvents}=await import('../src/task-run-source-followup.ts')
 const {ctx}=await patchedSessionFixture(t),adapter=new LoopWorkAdapter();ctx.llm.registerAdapter(['test'],adapter)
 const {agent}=await ctx.agents.create({sessionId:SessionId('unpublished-'+randomUUID()),meta:{agentPreset:'worker'},agentOptions:{provider:'test',model:'test'}});ctx.provide('agentPresets',{composedPreset:()=> 'worker'} as never)
 ctx.provide('sessionController',{resolveAgent:async()=>({agent})} as never);ctx.provide('attachments',{admitPromptContent:async(content:unknown)=>structuredClone(content)} as never)
 const ports=dshTaskRunPorts(ctx,'owner',async sessionId=>({ownerId:'owner',sessionId,status:'ready'})),f=unpublishedFollowupFixture(),signal=AbortSignal.timeout(20000)
 const browser=createTaskRunBrowser(ctx,{list:async()=>[],put:async()=>{}},async()=>null);t.after(browser.dispose);attachTaskRunBrowser(ports,browser)
 const {roleSnapshot:_snapshot,...basis}=f.run;assert.equal(agent.session.header.agentPreset,'worker')
 const base={...basis,id:randomUUID(),nativeRequestId:randomUUID(),taskVersion:1,sessionId:agent.id,agentPresetId:'worker',state:'prepared',stopRequestedAt:null,inputText:'ORIGINAL_V3_COMPLETED_DO_NOT_REPEAT',modelPolicy:{primary:{provider:'test',model:'test'}}} as TaskRun
 const target={taskId:base.taskId,roleId:base.roleId,taskVersion:1,roleVersion:base.roleVersion,sessionId:agent.id,linkVersion:1,scope:'SOC'} as TaskExecutionScope
 adapter.scripts.push(loopText);await ports.send(base,signal,target);await agent.whenIdle()
 const events=agent.session.snapshotEvents(),evidence=observeTaskRun(events,base.nativeRequestId);assert.equal(evidence.state,'ended')
 const completed={...base,state:'ended',evidence};f.run.sessionId=agent.id;f.run.agentPresetId='worker'
 f.receipt.identity.sessionId=agent.id;f.receipt.logCut=events.length-1;f.receipt.logSha256=createHash('sha256').update(JSON.stringify(events)).digest('hex');f.attempt.session_id=agent.id
 ports.sourceContinuation=async()=>completed
 const pending={...base,id:f.run.id,nativeRequestId:f.run.nativeRequestId,taskVersion:f.run.taskVersion}
 await ports.check(pending,signal,{...target,taskVersion:f.run.taskVersion})
 delete ports.sourceContinuation
 const candidate=await sourceFollowupCandidate(f.db,f.owner,f.run,6)
 assertUnpublishedSourceFollowupEvents(f.run,events)
 assert.throws(()=>assertUnpublishedSourceFollowupEvents({...f.run},events),'JSON或对象复制不能伪造in-process取消资格')
 assert.throws(()=>assertUnpublishedSourceFollowupEvents(f.run,[...events,{seq:events.length,type:'user/message',data:{}}] as never),'有新输入不可续办')
 ports.sourceFollowup=async()=>f.run;ports.inspectSourceFollowup=async run=>assertUnpublishedSourceFollowupEvents(run,agent.session.snapshotEvents())
 let childrenChecks=0;ports.subagentState=async()=>{childrenChecks++;return 'none'};ports.flowState=async()=> 'none'
 const followup={schema:'teloa.task-run-source-followup/v1',kind:'error-recovery',requestId:randomUUID(),taskId:f.run.taskId,taskVersion:6,sessionId:agent.id,originalRunId:f.run.id,originalNativeRequestId:f.run.nativeRequestId,originalInputSha256:candidate.originalInputSha256,originalEvidenceSha256:candidate.originalEvidenceSha256,sourceUpdateId:candidate.sourceUpdateId,sourceTaskVersion:4,sourceEventId:candidate.sourceEventId,reference:candidate.reference,instruction:'按固定v4完成剩余核对；不重做v3已保存成果。',confirmedAt:new Date().toISOString(),notice:errorRecoveryNotice} as const
 const next={...base,id:randomUUID(),taskVersion:6,nativeRequestId:randomUUID(),sourceFollowup:followup,inputText:JSON.stringify({task:{id:f.run.taskId,version:6,goal:'ORIGINAL_LIMITS'},sourceFollowup:followup})} as TaskRun
 assert.equal(adapter.requests.length,1,'prepare/核验不发送模型')
 adapter.scripts.push(loopText);await ports.check(next,signal,{...target,taskVersion:6});await ports.send(next,signal,{...target,taskVersion:6});await agent.whenIdle()
 assert.equal(adapter.requests.length,2);assert.equal(f.run.state,'withdrawn');assert.equal(f.run.evidence,null);assert(childrenChecks>0,'仍按真实端口重核子工作，不把取消证明当作跳过后果检查')
 const after=agent.session.snapshotEvents();assert.deepEqual(after.slice(0,events.length),events)
 assert.equal(observeTaskRun(after,f.run.nativeRequestId).state,'unobserved','新请求的来源审计文字可保留旧ID，但旧未发布请求不能变成新user/header')
 assert.equal(after.filter(e=>e.type==='user/message'&&e.data.source.kind==='user'&&Reflect.get(e.data.source,'rpcId')===next.nativeRequestId).length,1)
})


test('受控DSH停止后新续办：进程内证明+新owner正文沿同SID，仅新请求发送；普通error与伪证明拒绝',async t=>{
 const {unpublishedFollowupFixture}=await import('../../backend/tests/fixtures/source-followup-unpublished.ts')
 const {sourceFollowupCandidate,sourceFollowupStoppedProof}=await import('../../backend/src/work/task-run-source-followups.ts')
 const {ctx}=await patchedSessionFixture(t),adapter=new LoopWorkAdapter();ctx.llm.registerAdapter(['test'],adapter)
 const {agent}=await ctx.agents.create({sessionId:SessionId('stopped-'+randomUUID()),meta:{agentPreset:'worker'},agentOptions:{provider:'test',model:'test'}})
 ctx.provide('agentPresets',{composedPreset:()=> 'worker'} as never);ctx.provide('sessionController',{resolveAgent:async()=>({agent})} as never);ctx.provide('attachments',{admitPromptContent:async(content:unknown)=>structuredClone(content)} as never)
 const f=unpublishedFollowupFixture(),ports=dshTaskRunPorts(ctx,f.owner,async sessionId=>({ownerId:f.owner,sessionId,status:'ready'})),signal=AbortSignal.timeout(20000)
 const browser=createTaskRunBrowser(ctx,{list:async()=>[],put:async()=>{}},async()=>null);t.after(browser.dispose);attachTaskRunBrowser(ports,browser)
 const {roleSnapshot:_snapshot,...basis}=f.run
 const base={...basis,state:'prepared',stopRequestedAt:null,sessionId:agent.id,inputText:JSON.stringify({task:{id:f.run.taskId,version:4,goal:'KEEP_ORIGINAL_LIMITS'},...JSON.parse(f.run.inputText)}),modelPolicy:{primary:{provider:'test',model:'test'}}} as TaskRun
 const target={taskId:base.taskId,taskVersion:4,roleId:base.roleId,roleVersion:base.roleVersion,sessionId:agent.id,linkVersion:1,scope:'SOC'} as TaskExecutionScope
 adapter.scripts.push([{type:'finish',reason:{kind:'error',failure:{code:'UNKNOWN',message:'controlled original error'}}}]);await ports.send(base,signal,target);await agent.whenIdle()
 const events=agent.session.snapshotEvents(),evidence=observeTaskRun(events,base.nativeRequestId);assert.equal(evidence.state,'ended');assert.equal(evidence.state==='ended'&&evidence.reason,'error')
 Object.assign(f.run,{state:'ended',evidence,sessionId:agent.id,inputText:base.inputText});f.update.state='accepted';f.update.reason=''
 const stoppedBefore=structuredClone(f.run)
 const db={query:async(sql:string,params?:unknown[])=>sql.startsWith('select * from teloa_task_runs')?{rows:[{id:f.run.id,owner_id:f.owner,task_id:f.run.taskId,session_id:f.run.sessionId,native_request_id:f.run.nativeRequestId,input_text:f.run.inputText,role_id:f.run.roleId,role_version:f.run.roleVersion,state:f.run.state,evidence:f.run.evidence,stop_requested_at:f.run.stopRequestedAt}]}:f.db.query(sql,params)}
 const candidate=await sourceFollowupCandidate(db as never,f.owner,f.run,6);assert.equal(candidate.kind,'stopped-continuation');assert.ok(sourceFollowupStoppedProof(f.run))
 const {schema:_schema,expectedTaskVersion:_version,runId:_run,...rest}=candidate
 const followup={...rest,schema:'teloa.task-run-source-followup/v1',requestId:randomUUID(),taskVersion:6,originalRunId:f.run.id,instruction:'NEW_OWNER_CONTINUATION_NO_REPLAY',confirmedAt:new Date().toISOString(),notice:stoppedContinuationNotice} as const
 const next={...base,id:randomUUID(),taskVersion:6,nativeRequestId:randomUUID(),sourceFollowup:followup,inputText:JSON.stringify({task:{id:f.run.taskId,version:6,goal:'KEEP_ORIGINAL_LIMITS'},sourceFollowup:followup})} as TaskRun
 ports.sourceFollowup=async()=>({...f.run});ports.inspectSourceFollowup=async()=>{}
 await assert.rejects(ports.check(next,signal,{...target,taskVersion:6}),{code:'teloa/conflict'},'复制停止字段不能获得进程内证明')
 ports.sourceFollowup=async()=>f.run
 await assert.rejects(ports.check({...next,sourceFollowup:{...followup,kind:'error-recovery',notice:errorRecoveryNotice}} as TaskRun,signal,{...target,taskVersion:6}),{code:'teloa/conflict'},'普通error-recovery仍拒绝真实stop')
 assert.equal(adapter.requests.length,1,'新owner确认及prepare/check均不自动发送')
 adapter.scripts.push(loopText);await ports.check(next,signal,{...target,taskVersion:6});await ports.send(next,signal,{...target,taskVersion:6});await agent.whenIdle()
 assert.equal(adapter.requests.length,2)
 const provider=JSON.stringify(adapter.requests.at(-1));for(const expected of [stoppedContinuationNotice,followup.instruction,'KEEP_ORIGINAL_LIMITS'])assert.ok(provider.includes(expected))
 await ports.send(next,signal,{...target,taskVersion:6});assert.equal(adapter.requests.length,2,'同新request重复提交不新增发送')
 assert.deepEqual(f.run,stoppedBefore,'旧stop/evidence/input永久保持')
 const after=agent.session.snapshotEvents();assert.deepEqual(after.slice(0,events.length),events)
 assert.equal(after.filter(e=>e.type==='user/message'&&e.data.source.kind==='user'&&Reflect.get(e.data.source,'rpcId')===base.nativeRequestId).length,1)
 assert.equal(after.filter(e=>e.type==='user/message'&&e.data.source.kind==='user'&&Reflect.get(e.data.source,'rpcId')===next.nativeRequestId).length,1)
})
