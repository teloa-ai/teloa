import test from 'node:test'
import assert from 'node:assert/strict'
import {Context,symbols} from '@deepseek-ai/cordis'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtemp,readFile,rm,readdir,writeFile,rename,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
import {SessionId,SessionStore,type SessionEvent} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {LocalJobRegistry} from '@deepseek-ai/dsh-jobs-local'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {TaskRunSubagentService,TaskRunFlowService,type TaskRun} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import type {SessionPersistence} from '@deepseek-ai/dsh-session-persistence'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'
import {withColdInboxErrorWriter} from '../src/task-run-inbox-error-cold.ts'
import {dshTaskRunPorts} from '../src/task-run-dsh.ts'
import {TaskRunDriver} from '../src/task-run-driver.ts'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
import {createNativeInputGuard} from '../src/native-input-access.ts'
import {acceptedInboxErrorEvidence,verifiedAcceptedInboxError} from '../src/task-run-inbox-error.ts'
import {runBudgetTerminal} from '../src/resident-model-budget.ts'
import {taskRunOwnerSettlement} from '../src/task-run-owner-settlement.ts'
import {createTaskRunTeam} from '../src/task-run-team.ts'

const sha=(s:Uint8Array)=>createHash('sha256').update(s).digest('hex')
test('149 正式当前v4独占writer：跨进程冲突不等待；零Agent/append/迁移，DB错误取消finally释放',{timeout:10000},async t=>{
 const seam=await patchedNativePackage(t,{packageName:'@deepseek-ai/dsh-session-persistence',compatBasename:'dsh-session-persistence-0.2.1-rc.2-open-admission'})
 const graph=await patchedNativePackage<typeof import('@deepseek-ai/dsh-session-persistence-jsonl')>(t,{packageName:'@deepseek-ai/dsh-session-persistence-jsonl',compatBasename:'dsh-session-persistence-jsonl-0.2.1-rc.2-open-admission',overrides:{'@deepseek-ai/dsh-session-persistence':seam.root}})
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-cold-error-writer-'))),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 const storageFiber=await ctx.plugin(graph.namespace,{root,compression:'none'})
 const p=ctx.sessionPersistence as SessionPersistence&{resolveCurrentLog:(id:SessionId)=>Promise<string>}
 const run={id:randomUUID(),taskId:randomUUID(),sessionId:'cold-'+randomUUID(),nativeRequestId:randomUUID(),agentPresetId:'teloa-standard',state:'accepted',inputText:'本例原输入',evidence:{state:'accepted'}} as unknown as TaskRun
 const message=createUserMessage({content:[{type:'text',text:run.inputText}],source:{kind:'user',rpcId:run.nativeRequestId}})
 const events=[{type:'agent/inbox/spliced',seq:0,time:1,data:{target:'next-turn',start:0,removedCount:0,inserted:[message]}},{type:'turn/start',seq:1,time:2,data:{turn:1}},{type:'agent/inbox/spliced',seq:2,time:3,data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},{type:'turn/end',seq:3,time:4,data:{turn:1,reason:{kind:'error',error:{code:'UNKNOWN',message:'合成预消息失败'}}}}] as SessionEvent[]
 const handle=await p.create({id:SessionId(run.sessionId),version:4,createdAt:0,cwd:root,isSeeded:false,agentPreset:'teloa-standard'})
 await handle.append(events);await handle.close()
 const path=await p.resolveCurrentLog(SessionId(run.sessionId)),before=await readFile(path),names=await readdir(dirname(path));let called=0
 const absent=()=>{assert.equal(ctx.get('agents' as never),undefined);assert.equal(ctx.get('agentLoop' as never),undefined)}
 const moduleUrl=pathToFileURL(join(graph.root,'lib/index.js')).href,cordisUrl=pathToFileURL(createRequire(import.meta.url).resolve('@deepseek-ai/cordis')).href
 const child=`const {Context}=await import(process.argv[2]);const plugin=await import(process.argv[1]);const ctx=new Context();await ctx.plugin(plugin,{root:process.argv[3],compression:'none'});try{const h=await ctx.sessionPersistence.open(process.argv[4],'write');await h.close();process.exitCode=2}catch(e){console.log(e.name);process.exitCode=/Owned/.test(e.name)?0:3}finally{await ctx.fiber.dispose()}`
 const signal=new AbortController().signal
 const first=await withColdInboxErrorWriter(p,run,signal,absent,async proof=>{
  called++;assert.equal(proof.physicalSha256,sha(before));assert.equal(proof.evidence.inputAnchor.kind,'accepted-inbox-error');proof.assertCurrent()
  const result=spawnSync(process.execPath,['--input-type=module','-e',child,moduleUrl,cordisUrl,root,run.sessionId],{encoding:'utf8',timeout:3000})
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Owned/)
  await Promise.resolve();proof.assertCurrent();return proof.evidence
 })
 assert.equal(called,1);assert.equal(first.reason,'error');assert.deepEqual(await readFile(path),before);assert.deepEqual(await readdir(dirname(path)),names)
 const busy=await p.open(SessionId(run.sessionId),'write')
 await assert.rejects(withColdInboxErrorWriter(p,run,signal,absent,async()=>{throw Error('busy必须在work前拒绝')}),{name:'SessionAlreadyOwnedError'})
 await busy.close()
 for(const phase of ['read','write','commit','cancel']){
  const abort=new AbortController()
  await assert.rejects(withColdInboxErrorWriter(p,run,abort.signal,absent,async proof=>{if(phase==='cancel'){abort.abort();proof.assertCurrent()}throw Error(phase)}))
  const next=await p.open(SessionId(run.sessionId),'write');await next.close();assert.deepEqual(await readFile(path),before)
 }
 await assert.rejects(withColdInboxErrorWriter(p,run,signal,()=>{throw Error('Agent出现')},async()=>{}),/Agent出现/)
 const atomic=p as unknown as SessionPersistence&{openWithAdmission:(id:SessionId,admit:(candidate:unknown)=>Promise<unknown>,options:{signal:AbortSignal})=>Promise<unknown>}
 const drift={ctx:Reflect.get(Reflect.get(p,symbols.original),'ctx'),resolveCurrentLog:p.resolveCurrentLog.bind(p),openWithAdmission:(id:SessionId,admit:(candidate:unknown)=>Promise<unknown>,options:{signal:AbortSignal})=>atomic.openWithAdmission(id,async candidate=>{await writeFile(path,Buffer.concat([before,Buffer.from('\n')]));return admit(candidate)},options)}
 await assert.rejects(withColdInboxErrorWriter(drift as never,run,signal,absent,async()=>{throw Error('源字节漂移不可进入DB')}),{code:'teloa/conflict'})
 assert.equal((await readFile(path)).length,before.length+1);await writeFile(path,before)
 const unlocked=await p.open(SessionId(run.sessionId),'write');await unlocked.close()
 const extra=join(dirname(path),'session.v3.jsonl');await writeFile(extra,before)
 await assert.rejects(withColdInboxErrorWriter(p,run,signal,absent,async()=>{}),{code:'teloa/conflict'});await rm(extra)
 await rename(path,extra)
 await assert.rejects(withColdInboxErrorWriter(p,run,signal,absent,async()=>{}));assert.deepEqual(await readdir(dirname(path)),['session.lock','session.v3.jsonl'].sort());await rename(extra,path)
 assert.deepEqual(await readFile(path),before);absent()
 // 完整DSH冷端口复用正式registry/持久writer；不安装Loop，更不能materialize旧Agent。
 for(const plugin of [SessionStore,AgentRegistry,LocalJobRegistry])await ctx.plugin(plugin)
 ctx.provide('sessionController',{inspect:async()=>{const h=await p.open(SessionId(run.sessionId),'read');try{return {meta:h.header,inheritedEventCount:h.inheritedEventCount,events:(await h.read(0)).events}}finally{await h.close()}},resolveAgent:async()=>{throw Error('禁止恢复旧Agent')}} as never)
 const oldRuntime=randomUUID(),newRuntime=randomUUID(),link={runId:run.id,nativeId:'owner:'+oldRuntime+':'+run.sessionId,sessionId:run.sessionId,kind:'job' as const,payload:{record:'owner' as const,runtimeId:oldRuntime,requestId:run.nativeRequestId}}
 let extraOwner=false,childReserved=false,flowReadFails=false;const queries:string[]=[]
 const links={list:async()=>extraOwner?[link,{...link,nativeId:'unexpected-owner'}]:[link],put:async()=>{throw Error('不能新增owner')}}
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:run.sessionId,status:'ready'}),undefined,undefined,undefined,undefined,undefined,undefined,links,undefined,undefined,{withNewInput:async()=>{throw Error('不能发送')},withQuiescentSession:async()=>{throw Error('冷维护不调用liveAgent')}},undefined,newRuntime)
 // 与index接线相同的实际Service读口；仅SQL存储为内存fixture，不把返回none的stub当完整背景核验。
 const db={query:async(sql:string,values:unknown[])=>{
  assert.deepEqual(values,['owner',run.id]);queries.push(sql)
  if(sql.includes('from teloa_task_run_subagents'))return {rows:childReserved?[{owner_id:'owner',run_id:run.id,reservation_id:'reserved-child',state:'reserved',created_at:new Date(1),started_at:null,ended_at:null,child_session_id:null,depth:null,stop_reason:null,token_estimate:null}]:[]}
  if(sql==='select id from teloa_task_runs where owner_id=$1 and id=$2')return {rows:[{id:run.id}]}
  if(sql==='select * from teloa_task_run_flows where owner_id=$1 and run_id=$2'){if(flowReadFails)throw new WorkError('teloa/storage-unavailable','合成Flow读失败');return {rows:[]}}
  throw Error('未预期SQL：'+sql)
 }} as unknown as ConstructorParameters<typeof TaskRunFlowService>[0]
 const subagents=new TaskRunSubagentService(db,{now:()=>new Date(1).toISOString()}),flows=new TaskRunFlowService(db,{id:randomUUID,now:()=>new Date(1).toISOString()})
 ports.subagentState=async current=>(await subagents.outstanding('owner',current.id)).length?'outstanding':'none'
 ports.flowState=async current=>{const flow=await flows.get('owner',{runId:current.id});return flow&&!['completed','compensated'].includes(flow.state)?'outstanding':'none'}
 let receipts=0
 const cold=await ports.withAcceptedInboxFailureFence!(run,signal,async fence=>{receipts++;assert.equal(fence.runtimeId,oldRuntime);assert.equal(fence.issuer?.kind,'stopped-session-writer-maintenance');assert.equal(fence.issuer?.maintenanceRuntimeId,newRuntime);return fence.evidence})
 assert.equal(receipts,1);assert.equal(cold?.reason,'error');assert.equal(ctx.agents.get(SessionId(run.sessionId)),undefined);assert.equal(ctx.sessions.get(SessionId(run.sessionId)),undefined)
 assert.deepEqual(await readFile(path),before)
 // 正常聚合背景口会核Team；accepted且已请求停止不能借active/ended历史读口。
 // 声明可用工具不等于已经调用：原完整native与唯一owner仍须由cold writer证明。
 const pending={...run,allowedTools:['search_resources','read_resource'],skills:[],stopRequestedAt:new Date(6).toISOString()}
 const team=createTaskRunTeam(ctx,{} as never,async()=>null,links)
 const baseBackground=ports.backgroundState!
 let aggregateCalls=0,settlements=0
 ports.backgroundState=async current=>{aggregateCalls++;await team.state(current);return baseBackground(current)}
 await assert.rejects(ports.backgroundState(pending),{code:'teloa/session-unavailable'})
 aggregateCalls=0
 let current:TaskRun=pending
 const deny=async()=>{throw Error('不能发送、创建Run或走普通record')}
 const driver=new TaskRunDriver({get:async()=>current,executionScope:deny,claim:deny,requestStop:deny,record:deny,recordAcceptedInboxFailure:async(_owner,fence)=>{
  settlements++;assert.equal(fence.issuer?.kind,'stopped-session-writer-maintenance')
  current={...current,state:'ended',evidence:fence.evidence};return current
 }},ports)
 const reconciled=await driver.reconcile('owner',{runId:run.id},signal)
 assert.equal(reconciled.state,'ended');assert.equal(reconciled.evidence?.state==='ended'&&reconciled.evidence.reason,'error')
 assert.equal(settlements,1);assert.equal(aggregateCalls,0,'只有严格cold proof可跳过不适用于accepted的Team历史口')
 await driver.reconcile('owner',{runId:run.id},signal);assert.equal(settlements,1)
 assert.ok(queries.some(sql=>sql.includes('from teloa_task_run_subagents'))&&queries.some(sql=>sql.includes('from teloa_task_run_flows')))
 for(const reject of ['extra-owner','reserved-child','unknown-flow'] as const){
  extraOwner=reject==='extra-owner';childReserved=reject==='reserved-child';flowReadFails=reject==='unknown-flow'
  if(flowReadFails)await assert.rejects(ports.withAcceptedInboxFailureFence!(pending,signal,async()=>{throw Error('未知Flow不能提交')}),{code:'teloa/storage-unavailable'})
  else assert.equal(await ports.withAcceptedInboxFailureFence!(pending,signal,async()=>{throw Error('关联未结清不能提交')}),null)
  const free=await p.open(SessionId(run.sessionId),'write');await free.close()
 }
 extraOwner=false;childReserved=false;flowReadFails=false
 assert.deepEqual(await readFile(path),before)
 // 同一真实provider在DB等待期间卸载：不能凭未变字节继续使用已释放writer资格。
 const original=Reflect.get(Reflect.get(p,symbols.original),'ctx') as Context
 assert.notEqual(original.fiber,ctx.fiber,'service代理ctx是调用方，生命周期必须绑原provider')
 let committed=false,disposeStarted!:()=>void,disposal:Promise<void>|undefined,competingStatus:number|null=null
 const unloading=new Promise<void>(done=>{disposeStarted=done})
 original.effect(()=>()=>disposeStarted(),'本例观察provider真实卸载开始')
 await assert.rejects(withColdInboxErrorWriter(p,run,signal,()=>{},async proof=>{
  // 模拟DB COMMIT仍在await；provider不能先释放本次已取得的kernel锁。
  disposal=storageFiber.dispose();await unloading;await new Promise(done=>setImmediate(done))
  const competing=spawnSync(process.execPath,['--input-type=module','-e',child,moduleUrl,cordisUrl,root,run.sessionId],{encoding:'utf8',timeout:3000})
  competingStatus=competing.status
  proof.assertCurrent();committed=true
 }))
 await disposal
 assert.equal(competingStatus,0,'本次work结束前第二writer仍必须被kernel拒绝')
 assert.equal(committed,false);assert.deepEqual(await readFile(path),before)
 const replacement=new Context()
 try{
  await replacement.plugin(graph.namespace,{root,compression:'none'})
  const writer=await replacement.sessionPersistence.open(SessionId(run.sessionId),'write');await writer.close()
 }finally{await replacement.fiber.dispose()}
 assert.deepEqual(await readFile(path),before)
})


test('152 已消费未发布的真实Loop冷前缀：官方无Agent封口、原endSeq/seed分离、重核不追加',{timeout:10000},async t=>{
 const f=await patchedSessionFixture(t),directory=await realpath(await mkdtemp(join(tmpdir(),'teloa-cold-interrupted-')))
 t.after(()=>rm(directory,{recursive:true,force:true}));await f.ctx.plugin(f.persistencePackage,{root:directory,compression:'none'})
 let SDK=0,tools=0;f.ctx.on('llm/stream',async function*(){SDK++;throw Error('本例不得调用模型')},{global:true});f.ctx.tools.guard(()=>{tools++;throw Error('本例不得调用工具')})
 let release!:()=>void,entered!:()=>void
 const waiting=new Promise<void>(done=>release=done),inside=new Promise<void>(done=>entered=done)
 const dispose=f.agent.ctx.on('agent/pre-step',async()=>{entered();await waiting;throw Error('fixture crash after consumed input')})
 const nativeRequestId=randomUUID(),inputText='合成未发布输入，只核对冷恢复'
 f.agent.followup(createUserMessage({content:[{type:'text',text:inputText}],source:{kind:'user',rpcId:nativeRequestId}}));await inside
 const prefix=f.agent.session.snapshotEvents();assert.ok(prefix.at(-1)?.type==='agent/inbox/spliced');assert.equal(prefix.some(e=>e.type==='user/message'||e.type==='turn/end'||e.type==='request/header'),false)
 release();await f.agent.whenIdle();dispose();const guard=createNativeInputGuard(f.ctx,{final:true});t.after(guard.close)
 const id=SessionId('cold-unpublished-'+randomUUID()),run={id:randomUUID(),taskId:randomUUID(),sessionId:id,nativeRequestId,inputText,agentPresetId:'teloa-standard',state:'accepted',evidence:{state:'accepted'},stopRequestedAt:null} as unknown as TaskRun
 const p=f.ctx.sessionPersistence as SessionPersistence&{resolveCurrentLog:(id:SessionId)=>Promise<string>},created=await p.create({id,version:4,createdAt:prefix[0]!.time,cwd:directory,isSeeded:false,agentPreset:'teloa-standard'});await created.append(prefix);await created.close()
 const path=await p.resolveCurrentLog(id),before=await readFile(path),absent=()=>{assert.equal(f.ctx.agents.get(id),undefined);assert.equal(f.ctx.sessions.get(id),undefined)},signal=new AbortController().signal
 let checked=0,works=0
 await assert.rejects(withColdInboxErrorWriter(p,run,signal,absent,async()=>{}, {sessions:f.ctx.sessions,assertSafe:async()=>{throw Error('unknown activity')}}),/unknown activity/);assert.deepEqual(await readFile(path),before)
 await assert.rejects(withColdInboxErrorWriter(p,{...run,nativeRequestId:randomUUID()},signal,absent,async()=>{}, {sessions:f.ctx.sessions,assertSafe:async()=>{}}));assert.deepEqual(await readFile(path),before)
 const busy=await p.open(id,'write');await assert.rejects(withColdInboxErrorWriter(p,run,signal,absent,async()=>{}, {sessions:f.ctx.sessions,assertSafe:async()=>{}}),{name:'SessionAlreadyOwnedError'});await busy.close()
 // 官方封口是原生事实；后续DB事务拒绝时保留该事实，不伪造Run结束或清理unknown预算。
 await assert.rejects(withColdInboxErrorWriter(p,run,signal,absent,async proof=>{works++;proof.assertCurrent();throw Error('DB unknown budget rejected')},{sessions:f.ctx.sessions,assertSafe:async()=>{checked++;absent()}}),/DB unknown budget rejected/)
 const afterRejectedRecord=await readFile(path);assert.notDeepEqual(afterRejectedRecord,before)
 const proof=await withColdInboxErrorWriter(p,run,signal,absent,async proof=>proof,{sessions:f.ctx.sessions,assertSafe:async()=>{throw Error('已封口不能再repair')}})
 assert.deepEqual(await readFile(path),afterRejectedRecord)
 assert.equal(checked,1);assert.equal(works,1);assert.equal(proof.evidence.reason,'interrupted');assert.equal(proof.evidence.endSeq,prefix.length)
 assert.equal(proof.evidence.inputAnchor.kind,'accepted-inbox-interrupted');assert.ok(proof.evidence.inputAnchor.kind==='accepted-inbox-interrupted');assert.equal(proof.evidence.inputAnchor.resumeSealSeq,prefix.length+1)
 const sealed=await p.open(id,'read');let events:SessionEvent[];try{events=[...(await sealed.read(0)).events]}finally{await sealed.close()}
 assert.deepEqual(events.slice(0,prefix.length),prefix);assert.equal(events.length,prefix.length+2);assert.equal(events[proof.evidence.endSeq]!.type,'turn/end');assert.equal(events.at(-1)!.type,'session/end-seed');assert.deepEqual(events.at(-1)!.data,{})
 assert.equal(events.some(e=>e.type==='user/message'||e.type==='request/header'||e.type.startsWith('tool/')),false);assert.equal(proof.endedAt,new Date(events.at(-1)!.time).toISOString())
 const ended={...run,state:'ended',evidence:proof.evidence};assert.deepEqual(verifiedAcceptedInboxError(ended,events),proof.evidence)
 const terminal=runBudgetTerminal(ended,{sessionId:id,events,inheritedEventCount:0});assert.equal(terminal?.endSeq,proof.evidence.endSeq);assert.equal(terminal?.endedAt,proof.endedAt)
 // 复用同一真实原生日志核正常owner消费者；这里只以受控ports提供空闲读数，不创建Agent或调用DB。
 let ownerEvents=events
 const runtimeId=randomUUID(),ownerCtx={agents:{get:()=>({id,status:'idle',session:{inheritedEventCount:0},inbox:{nextTurn:[],nextStep:[]}})},jobs:{list:()=>[]}} as unknown as Context
 const ownerOptions={runtimeId,ports:{check:async()=>{},send:async()=>{throw Error('不发送')},stop:async()=>{},events:async()=>ownerEvents,backgroundState:async()=>({outstanding:false,interrupted:false}),subagentState:async()=> 'none' as const,flowState:async()=> 'none' as const},listLinks:async()=>[{runId:run.id,nativeId:'owner:'+runtimeId+':'+id,sessionId:id,kind:'job' as const,payload:{record:'owner' as const,runtimeId,requestId:run.nativeRequestId}}],nativeInput:{hasPendingJobCompletion:()=>false,hasCancelledJobCompletion:()=>false},now:()=>new Date().toISOString()}
 const ownerProof=await taskRunOwnerSettlement(ownerCtx,ended,ownerOptions);assert.equal(ownerProof?.prefixLength,events.length);assert.equal(ownerProof?.prefixSha256,proof.evidence.inputAnchor.prefixSha256)
 ownerEvents=events.slice(0,-1);assert.equal(await taskRunOwnerSettlement(ownerCtx,ended,ownerOptions),null);assert.equal(runBudgetTerminal(ended,{sessionId:id,events:ownerEvents,inheritedEventCount:0}),null)
 ownerEvents=events.map((e,i)=>i===events.length-1?{...e,data:{inherited:true}} as SessionEvent:e);assert.equal(await taskRunOwnerSettlement(ownerCtx,ended,ownerOptions),null);assert.equal(runBudgetTerminal(ended,{sessionId:id,events:ownerEvents,inheritedEventCount:0}),null)

 const bytes=await readFile(path);await withColdInboxErrorWriter(p,ended,signal,absent,async again=>{assert.deepEqual(again.evidence,proof.evidence)},{sessions:f.ctx.sessions,assertSafe:async()=>{throw Error('已封口不能再repair')}});assert.deepEqual(await readFile(path),bytes)
 for(const bad of [events.slice(0,-1),events.map((e,i)=>i===events.length-1?{...e,data:{inherited:true}}:e),events.map((e,i)=>i===events.length-1?{...e,time:0}:e),events.map(e=>e.type==='turn/end'?{...e,data:{...e.data,reason:{kind:'error'}}}:e)] as SessionEvent[][])assert.equal(acceptedInboxErrorEvidence(run,bad),null)
 absent();assert.equal(SDK,0);assert.equal(tools,0)
})
