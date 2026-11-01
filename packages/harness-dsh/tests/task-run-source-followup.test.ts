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
import {sourceFollowupNotice,resultFollowupNotice,type ModelReference} from '@teloa/contract'
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
 const queued=createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'旧待办不能被重新执行'}]})
 const event={type:'agent/inbox/spliced' as const,seq:SessionSeq(1),time:3,data:{target:'next-turn' as const,start:0,inserted:[queued]}}
 const pending=await ctx.sessionPersistence.open(id,'write');await pending.append([event]);await pending.flush();const {events}=await pending.read();await pending.close()
 const queueRun={...run,submissionDisposition:{...run.submissionDisposition!,logCut:events.length-1,logSha256:createHash('sha256').update(JSON.stringify(events)).digest('hex')}}
 await assert.rejects(inspectSourceFollowup(ctx,queueRun,AbortSignal.timeout(5000)),{code:'teloa/conflict'},'prefix正确也不能把非空Inbox当空闲')
 const bytes=await readFile(path);await writeFile(path,compression==='none'?Buffer.concat([bytes,Buffer.from('{"type":')]):bytes.subarray(0,bytes.length-2))
 await assert.rejects(inspectSourceFollowup(ctx,queueRun,AbortSignal.timeout(5000)))
 for(const key of ['agentLoop','llm','tools'])assert.equal(ctx.get(key as never),undefined)
})

for(const kind of ['unknown-verification','result-verification'] as const)test('真实DSH循环：新确认正文与原限制进入provider，原nativeRequest不重发：'+kind,async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),adapter=new LoopWorkAdapter();ctx.llm.registerAdapter(['test'],adapter)
 ctx.provide('sessionController',{resolveAgent:async()=>({agent})} as never);ctx.provide('attachments',{admitPromptContent:async(content:unknown)=>structuredClone(content)} as never)
 const ports=dshTaskRunPorts(ctx,'owner',async sessionId=>({ownerId:'owner',sessionId,status:'ready'})),taskId=randomUUID(),roleId=randomUUID()
 const browser=createTaskRunBrowser(ctx,{list:async()=>[],put:async()=>{}},async()=>null);t.after(browser.dispose);attachTaskRunBrowser(ports,browser)
 const base={id:randomUUID(),taskId,taskVersion:1,roleId,roleVersion:1,sessionId:agent.id,nativeRequestId:randomUUID(),linkVersion:1,state:'prepared',stopRequestedAt:null,allowedTools:[],skills:[],knowledge:[],modelPolicy:{primary:{provider:'test',model:'test'}},inputText:'ORIGINAL_RESTRICTION_DO_NOT_REPEAT'} as unknown as TaskRun
 const target:TaskExecutionScope={taskId,taskVersion:1,sessionId:agent.id,linkVersion:1,scope:'SOC'},signal=AbortSignal.timeout(15000)
 adapter.scripts.push(loopText);await ports.send(base,signal,target);await agent.whenIdle()
 const events=agent.session.snapshotEvents(),evidence=observeTaskRun(events,base.nativeRequestId),original={...base,id:base.id,state:kind==='unknown-verification'?'submission_unknown':'ended',evidence:kind==='unknown-verification'?null:evidence,nativeRequestId:base.nativeRequestId,stopRequestedAt:kind==='unknown-verification'?new Date().toISOString():null} as TaskRun
 if(kind==='unknown-verification')original.submissionDisposition={schema:'teloa.task-run-submission-disposition/v1',requestId:randomUUID(),runId:original.id,sessionId:agent.id,nativeRequestId:original.nativeRequestId,inputSha256:createHash('sha256').update(original.inputText).digest('hex'),runtimeId:randomUUID(),logCut:events.length-1,logSha256:createHash('sha256').update(JSON.stringify(events)).digest('hex'),acknowledgedUnknown:true,closedAt:new Date().toISOString()}
 const f={schema:'teloa.task-run-source-followup/v1',kind,requestId:randomUUID(),taskId,taskVersion:3,sessionId:agent.id,originalRunId:original.id,originalNativeRequestId:original.nativeRequestId,originalInputSha256:createHash('sha256').update(original.inputText).digest('hex'),originalEvidenceSha256:kind==='unknown-verification'?null:'c'.repeat(64),...(original.submissionDisposition?{disposition:original.submissionDisposition}:{}),sourceUpdateId:randomUUID(),sourceTaskVersion:1,sourceEventId:randomUUID(),reference:{scope:'SOC',type:'alert',id:'A2_ONLY',version:2,snapshotHash:'a'.repeat(64)},instruction:'VERIFY_NEW_EVIDENCE_ONLY_KEEP_ORIGINAL_LIMITS',confirmedAt:new Date().toISOString(),notice:kind==='unknown-verification'?sourceFollowupNotice:resultFollowupNotice}
 const run={...base,id:randomUUID(),taskVersion:3,nativeRequestId:randomUUID(),sourceFollowup:f,inputText:JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:taskId,version:3,title:'原告警',scope:'SOC',goal:'ORIGINAL_RESTRICTION_DO_NOT_REPEAT'},sourceFollowup:f,businessContext:{updates:[{id:'A2_ONLY',version:2}]}})} as TaskRun
 let inspected=0;ports.sourceFollowup=async()=>original;ports.inspectSourceFollowup=async value=>{inspected++;assert.equal(value.id,original.id)}
 adapter.scripts.push(loopText);await ports.check(run,signal,{...target,taskVersion:3});await ports.send(run,signal,{...target,taskVersion:3});await agent.whenIdle()
 const provider=JSON.stringify(adapter.requests.at(-1));for(const text of [f.notice,f.instruction,'ORIGINAL_RESTRICTION_DO_NOT_REPEAT','A2_ONLY'])assert.ok(provider.includes(text),text)
 assert.equal(adapter.requests.length,2);assert.ok(inspected>=2)
 await ports.send(run,signal,{...target,taskVersion:3});assert.equal(adapter.requests.length,2,'同请求重放不得追加模型调用')
 const messages=agent.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.source.kind==='user')
 assert.equal(messages.filter(e=>e.type==='user/message'&&Reflect.get(e.data.source,'rpcId')===base.nativeRequestId).length,1)
 if(kind==='unknown-verification')assert.equal(messages.filter(e=>e.type==='user/message'&&Reflect.get(e.data.source,'rpcId')===original.nativeRequestId).length,1,'原unknown请求不得重发')
})

for(const override of [false,true])test('宿主按同一确认串行准备，保留本人显式模型而默认模型继续当前解析：'+override,async()=>{
 const taskId=randomUUID(),original={id:randomUUID(),taskId,taskVersion:4,roleId:randomUUID(),roleVersion:1,linkVersion:1,sessionId:'original-session',nativeRequestId:randomUUID(),state:'ended',evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'},stopRequestedAt:null,agentPresetId:'worker',permissionMode:'approval',allowedTools:[],skills:[],knowledge:[],modelPolicy:{primary:{provider:'fixture',model:override?'owner-picked':'old-default'},...(override?{fallback:{provider:'fixture',model:'owner-fallback'}}:{})},...(override?{modelPolicyOverride:true}:{})} as unknown as TaskRun
 const candidate={schema:'teloa.task-run-source-followup-candidate/v1',kind:'result-verification',taskId,expectedTaskVersion:6,runId:original.id,sessionId:original.sessionId,originalNativeRequestId:original.nativeRequestId,originalInputSha256:'a'.repeat(64),originalEvidenceSha256:'b'.repeat(64),sourceUpdateId:randomUUID(),sourceTaskVersion:4,sourceEventId:randomUUID(),reference:{scope:'SOC',type:'alert',id:'source-record',version:2,snapshotHash:'c'.repeat(64)}}
 const command={kind:'result-verification',requestId:randomUUID(),runId:original.id,expectedTaskVersion:6,sourceUpdateId:candidate.sourceUpdateId,instruction:'按固定来源核对并保存。'},checks:unknown[]=[]
 let requests=0,targets=0,preparations=0,defaults=0,permissions=0
 const savedId=randomUUID(),service={get:async()=>original,request:async()=>{requests++;return null},sourceFollowupTarget:async()=>{targets++;await new Promise(resolve=>setTimeout(resolve,5));return {candidate,original}},prepare:async(...args:any[])=>{
  preparations++;const options=args[8],modelPolicy=options.modelPolicy??await args[6]({runtimeConfig:{}})
  assert.equal(options.permissionMode,original.permissionMode)
  return {...original,id:savedId,nativeRequestId:randomUUID(),state:'prepared',evidence:null,sourceFollowup:options.sourceFollowup,modelPolicy,modelPolicyOverride:options.modelPolicy!==undefined}
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
