import {installNativeWorkingDirectory} from './fixtures/native-working-directory.ts'
import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime,LlmAdapter,createUserMessage,ToolCallId,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId,SessionSeq,interruptedTurnClosers,type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LocalJobRegistry} from '@deepseek-ai/dsh-jobs-local'
import {SubagentRuntime} from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import {TeamService,TeamId,TeamMessageId} from '@deepseek-ai/dsh-experimental-agent-team'
import * as TeamTools from '@deepseek-ai/dsh-experimental-tool-agent-team'
import type {TaskRun,TaskRunRuntimeLinks,TaskRunRuntimeLink} from '@teloa/backend'
import {createTaskRunTeam} from '../src/task-run-team.ts'
import {registerTaskToolGuard,type TaskToolPolicy} from '../src/task-tool-guard.ts'
import {teamDelegationTools} from '../src/role-tool-grants.ts'
import type {SubagentDelegationPorts} from '../src/subagent-delegation.ts'
import {taskRunTeamContinuations} from '../src/task-run-team-records.ts'
import {observeTaskRun,isTaskRunReconcileEndReason} from '../src/task-run-observation.ts'
import TeloaAttachmentStore from '../src/attachment-guard.ts'
import {dshTaskRunPorts} from '../src/task-run-dsh.ts'
import {assertSafeTaskRunRetry} from '../src/task-run-retry-proof.ts'
import {TaskRunDriver} from '../src/task-run-driver.ts'
import {taskRunRuntimeId} from '../src/task-run-background.ts'
import {readEndedTaskRunSession,readTaskRunSessionForReconcile} from '../src/task-run-cold-session.ts'

class WaitingAdapter extends LlmAdapter{
 calls=0
 fail=false
 maxTokens=false
 private released=false
 private waiters:Array<()=>void>=[]
 finish(){this.released=true;for(const resolve of this.waiters)resolve()}
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
 async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
  this.calls++
  if(this.fail)throw Error('合成模型准备失败')
  if(!this.released)await new Promise<void>((resolve,reject)=>{this.waiters.push(resolve);if(options.signal?.aborted)reject(options.signal.reason);else options.signal?.addEventListener('abort',()=>reject(options.signal!.reason),{once:true})})
  yield {type:'block-start',index:0,blockType:'text'}
  yield {type:'text-delta',index:0,text:'完成'}
  yield {type:'block-end',index:0,block:{type:'text',text:'完成'}}
  yield {type:'finish',reason:{kind:this.maxTokens?'max-tokens':'stop'}}
 }
}

async function setup(t:TestContext,cold=false,meta:Record<string,unknown>={},manualRootEvents=true){
 const directory=await mkdtemp(join(tmpdir(),'teloa-team-')),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true})})
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 await ctx.plugin(JsonlSessionPersistence,{root:directory,compression:'none'})
 await ctx.plugin(LocalJobRegistry,{})
 const adapter=new WaitingAdapter();ctx.llm.registerAdapter(['test'],adapter)
 await installNativeWorkingDirectory(ctx,directory)
 await ctx.plugin(SubagentRuntime,{maxDepth:1,maxActiveSubagents:6})
 await ctx.plugin(Spawn,{providerName:'spawn'});await ctx.plugin(TeamService,{maxMembers:6});await ctx.plugin(TeamTools,{freshProvider:'spawn',forkProvider:'fork'})
 if(cold){
  const require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),official=(name:string)=>import(require.resolve('@deepseek-ai/'+name))
  await ctx.plugin((await official('dsh-storage')).Storage);await ctx.plugin(await official('dsh-storage-json'),{root:join(directory,'domains')});await ctx.plugin(await official('dsh-storage-domain'),{backend:'json'})
  await ctx.plugin((await official('dsh-workspace')).WorkspaceRegistry)
  await ctx.plugin((await official('dsh-session-query-sqlite')).SqliteSessionQueryEngine,{path:join(directory,'query.sqlite'),openAt:'never'})
  await ctx.plugin((await official('dsh-session-projection-cache')).SessionProjectionCache,{writeEveryEvents:100,writeIntervalMs:60000})
  await ctx.plugin(TeloaAttachmentStore,{dshHome:directory})
  await ctx.plugin((await official('dsh-typert-registry')).default);await ctx.plugin((await official('dsh-api-gateway')).default)
  ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'test',model:'test'}),saveSelection:async()=>{}})
  ctx.provide('fileUploads',{registerAgentResolver:()=>()=>{},bindPrompt:()=>({commit(){},[Symbol.dispose](){}})})
  await ctx.plugin((await official('dsh-api-remote-access')).RemoteAccessService)
  await ctx.plugin((await official('dsh-api-session-controller')).SessionController,{nativeOpen:false})
 }
 const handle=await ctx.agents.create({sessionId:SessionId('team-root'),meta:{cwd:directory,...meta},agentOptions:{provider:'test',model:'test'}}),root=handle.agent
 const rows=new Map<string,TaskRunRuntimeLink>(),calls:Array<{kind:string;input:unknown}>=[]
 const links:TaskRunRuntimeLinks={list:async input=>[...rows.values()].filter(row=>row.runId===input.runId&&(!input.kind||row.kind===input.kind)),put:async row=>{rows.set(row.kind+':'+row.nativeId,structuredClone(row))}}
 const delegation:SubagentDelegationPorts={limits:{maxDepth:1,maxPerRun:6},runId:async()=> 'run',reserve:async input=>{calls.push({kind:'reserve',input})},release:async input=>{calls.push({kind:'release',input})},bind:async input=>{calls.push({kind:'bind',input})},settle:async input=>{calls.push({kind:'settle',input})},abandon:async input=>{calls.push({kind:'abandon',input})}}
 let policy:TaskToolPolicy={allowedTools:[...teamDelegationTools,'read_evidence'],nativeRequestId:'native'}
 const readPolicy=async()=>policy,team=createTaskRunTeam(ctx,delegation,readPolicy,links);t.after(team.dispose)
 registerTaskToolGuard(ctx,readPolicy,['self_tool'],undefined,delegation,undefined,team)
 let bodies=0,sequence=0
 for(const name of ['read_evidence','write_action','self_tool'])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 if(!cold&&manualRootEvents){root.session.append('turn/start',{turn:0});root.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:'native'}}),{surfaceOp:'append'})}
 const call=(agent:typeof root,name:string,args:Record<string,unknown>={},callId='call-'+ ++sequence)=>agent.ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal:AbortSignal.timeout(5000)})
 const run={id:'run',sessionId:root.id,nativeRequestId:'native',allowedTools:policy.allowedTools,state:'active',stopRequestedAt:null} as unknown as TaskRun
 return {ctx,root,team,links,calls,call,run,handle,adapter,finish:()=>adapter.finish(),bodies:()=>bodies,setPolicy:(next:TaskToolPolicy)=>{policy=next}}
}

async function coldFailure(t:TestContext,meta:Record<string,unknown>={}){
 const env=await setup(t,true,meta)
 env.adapter.fail=true
 env.root.followup(createUserMessage({content:[{type:'text',text:'合成 SOC 事实核对'}],source:{kind:'user',rpcId:'native'}}))
 await env.root.whenIdle()
 const events=env.root.session.snapshotEvents(),evidence=observeTaskRun(events,'native')
 assert.equal(evidence.state,'ended');assert.equal(env.adapter.calls,1)
 return {...env,run:{...env.run,state:'ended',evidence},events}
}

async function coldCompletedActive(t:TestContext,pending?:'inbox'|'task'|'grant'){
 const env=await setup(t,true)
 env.finish()
 env.root.followup(createUserMessage({content:[{type:'text',text:'合成冷态对账'}],source:{kind:'user',rpcId:'native'}}))
 await env.root.whenIdle()
 const events=env.root.session.snapshotEvents(),terminal=observeTaskRun(events,'native')
 assert.ok(terminal.state==='ended'&&terminal.reason==='completed')
 const run={...env.run,inputText:'合成冷态对账',evidence:{state:'active' as const,turn:terminal.turn,messageSeq:terminal.messageSeq}}
 await env.links.put({runId:run.id,kind:'job',nativeId:'owner:'+taskRunRuntimeId+':'+run.sessionId,sessionId:run.sessionId,payload:{record:'owner',runtimeId:taskRunRuntimeId,requestId:run.nativeRequestId}})
 if(pending==='inbox')env.root.inbox.append('next-turn',createUserMessage({content:[{type:'text',text:'保留的后续待办'}],source:{kind:'user',rpcId:'later'}}))
 if(pending==='task')await env.ctx.agentTeams.createTask(env.root,{subject:'尚未完成',description:'不能当作空闲'})
 if(pending==='grant')await env.links.put({runId:run.id,kind:'team',nativeId:'pending-grant',sessionId:run.sessionId,payload:{reservationId:'pending-grant',requestId:'native',name:'reviewer'}})
 const queued=pending==='inbox'?[...env.root.session.snapshotEvents()].reverse().find(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.length>0):undefined
 await env.handle.dispose()
 if(queued){
  // 复用官方 Inbox 的真实追加事件，模拟宿主尚未来得及持久化取消的冷待办。
  const writer=await env.ctx.sessionPersistence.open(env.root.id,'write')
  try{const history=(await writer.read()).events;await writer.append([{...queued,seq:SessionSeq(history.length),time:Date.now()}]);await writer.flush()}finally{await writer.close()}
 }
 return {...env,run,events,terminal}
}

async function coldFailedActive(t:TestContext,reason:'error'|'interrupted'|'aborted'|'max-tokens',pending?:'inbox'|'task'|'grant',oldOwner=false){
 const env=await setup(t,true)
 env.adapter.fail=reason==='error'||reason==='interrupted'
 env.adapter.maxTokens=reason==='max-tokens'
 if(reason!=='aborted')env.finish()
 env.root.followup(createUserMessage({content:[{type:'text',text:'合成冷态失败核对'}],source:{kind:'user',rpcId:'native'}}))
 if(reason==='aborted'){
  for(let i=0;i<1000&&env.adapter.calls===0;i++)await new Promise(resolve=>setTimeout(resolve,1))
  assert.equal(env.adapter.calls,1);env.root.cancel({kind:'user'})
 }
 await env.root.whenIdle()
 let events=env.root.session.snapshotEvents(),terminal=observeTaskRun(events,'native')
 assert.ok(terminal.state==='ended'&&terminal.reason===(reason==='interrupted'?'error':reason))
 if(pending==='inbox')env.root.inbox.append('next-turn',createUserMessage({content:[{type:'text',text:'尚未处理的输入'}],source:{kind:'user',rpcId:'later'}}))
 if(pending==='task')await env.ctx.agentTeams.createTask(env.root,{subject:'尚未完成',description:'不能结束'})
 if(pending==='grant')await env.links.put({runId:env.run.id,kind:'team',nativeId:'unsettled-grant',sessionId:env.run.sessionId,payload:{reservationId:'unsettled-grant',requestId:'native',name:'reviewer'}})
 const queued=pending==='inbox'?[...env.root.session.snapshotEvents()].reverse().find(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.length):undefined
 await env.handle.dispose()
 let sessionId=env.run.sessionId
 if(reason==='interrupted'){
  // 用真实 Loop 的崩溃前前缀和官方恢复 closer 建立独立冷日志，不伪造生产终态或恢复 Agent。
  const fixed=await env.ctx.sessionController.inspect(env.root.id)
  sessionId=SessionId('team-crash-recovery')
  const prefix=fixed.events.slice(0,terminal.endSeq)
  events=[...prefix,...interruptedTurnClosers(prefix)]
  const writer=await env.ctx.sessionPersistence.create({...fixed.meta,id:SessionId(sessionId)})
  try{await writer.append(events);await writer.flush()}finally{await writer.close()}
 }
 if(queued){const writer=await env.ctx.sessionPersistence.open(env.root.id,'write');try{const history=(await writer.read()).events;await writer.append([{...queued,seq:SessionSeq(history.length),time:Date.now()}]);await writer.flush()}finally{await writer.close()}}
 events=[...(await env.ctx.sessionController.inspect(SessionId(sessionId))).events]
 terminal=observeTaskRun(events,'native')
 assert.ok(terminal.state==='ended'&&terminal.reason===reason)
 const message=events[terminal.messageSeq]
 assert.ok(message?.type==='user/message'&&message.data.content[0]?.type==='text')
 const run={...env.run,sessionId,state:'active' as const,inputText:message.data.content[0].text,evidence:{state:'active' as const,turn:terminal.turn,messageSeq:terminal.messageSeq}}
 const runtimeId=oldOwner?'old-native-owner':taskRunRuntimeId
 await env.links.put({runId:run.id,kind:'job',nativeId:'owner:'+runtimeId+':'+run.sessionId,sessionId:run.sessionId,payload:{record:'owner',runtimeId,requestId:run.nativeRequestId}})
 return {...env,run,events,terminal}
}

test('普通终态分类只认固定 SDK 执行结尾，不接受 forked 或未知插件原因',()=>{
 for(const reason of ['completed','aborted','blocked','error','max-tokens','interrupted'])assert.equal(isTaskRunReconcileEndReason(reason),true)
 for(const reason of ['forked','unknown-plugin','','error '])assert.equal(isTaskRunReconcileEndReason(reason),false)
})

for(const reason of ['error','interrupted','aborted','max-tokens'] as const)for(const oldOwner of [false,true])test('冷态 active Run 从真实 '+reason+' 终态正常对账，保留原 reason 且不恢复执行'+(oldOwner?'（旧 owner）':''),async t=>{
 const env=await coldFailedActive(t,reason,undefined,oldOwner),before=await env.ctx.sessionController.inspect(SessionId(env.run.sessionId))
 let resolutions=0,records=0,current=env.run as TaskRun
 env.ctx.sessionController.resolveAgent=async()=>{resolutions++;throw Error('只读对账不得恢复执行')}
 const ports=dshTaskRunPorts(env.ctx,'owner',async()=>({ownerId:'owner',sessionId:env.run.sessionId,status:'ready'}),undefined,undefined,undefined,undefined,undefined,undefined,env.links)
 const nativeBackground=ports.backgroundState!
 ports.backgroundState=async run=>{const [jobs,team]=await Promise.all([nativeBackground(run),env.team.state(run)]);return {outstanding:jobs.outstanding||team.outstanding,interrupted:jobs.interrupted||team.interrupted}}
 ports.subagentState=async()=> 'none';ports.flowState=async()=> 'none';ports.goalObservation=async()=>undefined
 const service={get:async()=>current,executionScope:async()=>{throw Error('不可重新领取')},claim:async()=>{throw Error('不可重新领取')},requestStop:async()=>{throw Error('不可改写原停止意图')},record:async(_owner:string,input:{evidence:NonNullable<TaskRun['evidence']>})=>{records++;current={...current,state:input.evidence.state,evidence:input.evidence};return current}}
 for(const control of ['active','paused'] as const){
  current=env.run;ports.controlState=async()=>control
  const result=await new TaskRunDriver(service,ports).reconcile('owner',{runId:env.run.id})
  assert.equal(result.state,'ended');assert.deepEqual(result.evidence,env.terminal)
 }
 assert.equal(records,2);assert.equal(resolutions,0);assert.equal(env.ctx.agents.get(SessionId(env.run.sessionId)),undefined)
 assert.equal(env.adapter.calls,1);assert.equal(env.bodies(),0);assert.deepEqual(env.calls,[])
 assert.deepEqual((await env.ctx.sessionController.inspect(SessionId(env.run.sessionId))).events,before.events)
})

test('真实 pre-step blocked 没有原输入锚点，不能借普通终态分类伪造 active 结束',async t=>{
 const env=await setup(t,true)
 env.ctx.on('agent/pre-step',async()=>({kind:'reject' as const}))
 env.root.followup(createUserMessage({content:[{type:'text',text:'尚未发布的原输入'}],source:{kind:'user',rpcId:'native'}}))
 await env.root.whenIdle();await env.handle.dispose()
 const fixed=await env.ctx.sessionController.inspect(env.root.id),end=fixed.events.find(event=>event.type==='turn/end')
 assert.ok(end?.type==='turn/end'&&end.data.reason.kind==='blocked');assert.equal(observeTaskRun(fixed.events,'native').state,'unobserved')
 await assert.rejects(readTaskRunSessionForReconcile(env.ctx,{...env.run,inputText:'尚未发布的原输入',evidence:{state:'active',turn:end.data.turn,messageSeq:end.seq}}),{code:'teloa/session-unavailable'})
 assert.equal(env.adapter.calls,0);assert.equal(env.bodies(),0);assert.deepEqual((await env.ctx.sessionController.inspect(env.root.id)).events,fixed.events)
})

test('失败冷态仍拒绝外来身份、输入或序列损坏、forked/未知结尾与未完成 Goal',async t=>{
 const env=await coldFailedActive(t,'error'),inspect=env.ctx.sessionController.inspect.bind(env.ctx.sessionController),fixed=await inspect(SessionId(env.run.sessionId))
 for(const run of [{...env.run,id:'foreign-run'},{...env.run,nativeRequestId:'foreign-request'},{...env.run,inputText:'另一请求'},{...env.run,evidence:{...env.run.evidence,messageSeq:env.run.evidence.messageSeq+1}},{...env.run,stopRequestedAt:'2026-11-01T00:00:00Z'},{...env.run,agentPresetId:'foreign'}])await assert.rejects(env.team.state(run))
 const variations=[fixed.events.slice(0,env.terminal.endSeq),fixed.events.map((event,index)=>index===1?{...event,seq:SessionSeq(event.seq+1)}:event),...['forked','unknown-plugin'].map(kind=>fixed.events.map(event=>event.type==='turn/end'?{...event,data:{...event.data,reason:{kind}}}:event))] as SessionEvent[][]
 try{for(const events of variations){env.ctx.sessionController.inspect=async()=>({...fixed,events});await assert.rejects(env.team.state(env.run))}}finally{env.ctx.sessionController.inspect=inspect}
 await assert.rejects(readEndedTaskRunSession(env.ctx,env.run),{code:'teloa/session-unavailable'})
 await assert.rejects(readTaskRunSessionForReconcile(env.ctx,env.run,async()=>({binding:{ownerId:'owner',runId:env.run.id,sessionId:env.run.sessionId,goalId:'goal',revision:1,hostGeneration:1,controlId:'control',controlGeneration:1},continuations:[],goalPhase:'active',activation:'disarmed',pendingRound:false,childrenOutstanding:false})),{code:'teloa/session-unavailable'})
 env.setPolicy({allowedTools:[],nativeRequestId:'foreign'});await assert.rejects(env.team.state(env.run))
 assert.equal(env.adapter.calls,1);assert.equal(env.bodies(),0);assert.equal(env.ctx.agents.get(SessionId(env.run.sessionId)),undefined);assert.deepEqual((await inspect(SessionId(env.run.sessionId))).events,fixed.events)
})

test('失败冷态的 Inbox、Team、flow 或子级未收口时不记 ended',async t=>{
 for(const pending of ['inbox','task','grant','flow','subagent'] as const)await t.test(pending,async t=>{
  const env=await coldFailedActive(t,'error',pending==='flow'||pending==='subagent'?undefined:pending),before=await env.ctx.sessionController.inspect(SessionId(env.run.sessionId));let records=0
  const ports=dshTaskRunPorts(env.ctx,'owner',async()=>({ownerId:'owner',sessionId:env.run.sessionId,status:'ready'}),undefined,undefined,undefined,undefined,undefined,undefined,env.links),nativeBackground=ports.backgroundState!
  ports.backgroundState=async run=>{const [jobs,team]=await Promise.all([nativeBackground(run),env.team.state(run)]);return {outstanding:jobs.outstanding||team.outstanding,interrupted:jobs.interrupted||team.interrupted}}
  ports.controlState=async()=> 'paused';ports.subagentState=async()=>pending==='subagent'?'outstanding':'none';ports.flowState=async()=>pending==='flow'?'outstanding':'none';ports.goalObservation=async()=>undefined
  const service={get:async()=>env.run,executionScope:async()=>{throw Error('不能领取')},claim:async()=>{throw Error('不能领取')},requestStop:async()=>{throw Error('不能停止')},record:async()=>{records++;throw Error('未收口不能记终态')}}
  try{const result=await new TaskRunDriver(service,ports).reconcile('owner',{runId:env.run.id});assert.equal(result.state,'active')}catch(error){assert.equal((error as {code?:string}).code,'teloa/session-unavailable')}
  assert.equal(records,0);assert.equal(env.adapter.calls,1);assert.equal(env.bodies(),0);assert.equal(env.ctx.agents.get(SessionId(env.run.sessionId)),undefined);assert.deepEqual((await env.ctx.sessionController.inspect(SessionId(env.run.sessionId))).events,before.events)
 })
})

test('143 冷态 active Run 从真实 completed 日志对账，不恢复 Agent 或重发原请求',async t=>{
 const env=await coldCompletedActive(t)
 const before=await env.ctx.sessionController.inspect(env.root.id)
 let resolutions=0,records=0,current=env.run as TaskRun
 env.ctx.sessionController.resolveAgent=async()=>{resolutions++;throw Error('只读对账不得恢复执行')}
 const ports=dshTaskRunPorts(env.ctx,'owner',async()=>({ownerId:'owner',sessionId:env.run.sessionId,status:'ready'}),undefined,undefined,undefined,undefined,undefined,undefined,env.links)
 const nativeBackground=ports.backgroundState!
 ports.backgroundState=async run=>{const [jobs,team]=await Promise.all([nativeBackground(run),env.team.state(run)]);return {outstanding:jobs.outstanding||team.outstanding,interrupted:jobs.interrupted||team.interrupted}}
 ports.subagentState=async()=> 'none';ports.flowState=async()=> 'none';ports.goalObservation=async()=>undefined;ports.controlState=async()=> 'active'
 const service={get:async(owner:string,input:{runId:string})=>{assert.equal(owner,'owner');assert.equal(input.runId,current.id);return current},executionScope:async()=>{throw Error('不可重新领取')},claim:async()=>{throw Error('不可重新领取')},requestStop:async()=>{throw Error('不可停止已结束的原生轮')},record:async(_owner:string,input:{evidence:NonNullable<TaskRun['evidence']>})=>{records++;current={...current,state:input.evidence.state,evidence:input.evidence};return current}}
 assert.deepEqual(await env.team.state(env.run),{outstanding:false,interrupted:false})
 const result=await new TaskRunDriver(service,ports).reconcile('owner',{runId:env.run.id})
 assert.equal(result.state,'ended');assert.deepEqual(result.evidence,env.terminal);assert.equal(records,1)
 current=env.run;ports.controlState=async()=> 'paused'
 assert.equal((await new TaskRunDriver(service,ports).reconcile('owner',{runId:env.run.id})).state,'ended');assert.equal(records,2)
 current=env.run;ports.controlState=async()=> 'active';ports.subagentState=async()=> 'outstanding'
 assert.equal((await new TaskRunDriver(service,ports).reconcile('owner',{runId:env.run.id})).state,'active')
 current=env.run;ports.subagentState=async()=> 'none';ports.flowState=async()=> 'outstanding'
 assert.equal((await new TaskRunDriver(service,ports).reconcile('owner',{runId:env.run.id})).state,'active')
 current=env.run;ports.flowState=async()=> 'none';const background=ports.backgroundState!
 ports.backgroundState=async run=>({...await background(run),outstanding:true})
 assert.equal((await new TaskRunDriver(service,ports).reconcile('owner',{runId:env.run.id})).state,'active')
 current=env.run;ports.backgroundState=async run=>({...await background(run),interrupted:true})
 const oldHost=await new TaskRunDriver(service,ports).reconcile('owner',{runId:env.run.id})
 assert.equal(oldHost.evidence?.state==='ended'?oldHost.evidence.reason:undefined,'interrupted','有工具的旧宿主仍由原后台规则判中断，不伪装 completed')
 assert.equal(resolutions,0);assert.equal(env.ctx.agents.get(env.root.id),undefined);assert.equal(env.adapter.calls,1);assert.equal(env.bodies(),0)
 assert.deepEqual((await env.ctx.sessionController.inspect(env.root.id)).events,before.events)
})

test('143 冷态 active 候选核本人策略、精确 Run owner 回执、请求锚点和停止状态',async t=>{
 const env=await coldCompletedActive(t),before=await env.ctx.sessionController.inspect(env.root.id)
 const denied=createTaskRunTeam(env.ctx,{} as SubagentDelegationPorts,async()=>null,env.links);t.after(denied.dispose)
 await assert.rejects(denied.state(env.run),{code:'teloa/session-unavailable'},'另一人没有本人策略，不能借用同一个原生日志')
 for(const run of [{...env.run,id:'other-run'},{...env.run,nativeRequestId:'other-request'},{...env.run,sessionId:'other-session'},{...env.run,inputText:'另一任务的固定输入'},{...env.run,evidence:{...env.run.evidence,messageSeq:env.run.evidence.messageSeq+1}},{...env.run,agentPresetId:'other-preset'},{...env.run,stopRequestedAt:'2026-11-01T00:00:00Z'}])await assert.rejects(env.team.state(run))
 env.setPolicy({allowedTools:[],nativeRequestId:'native',stopRequested:true});await assert.rejects(env.team.state(env.run))
 env.setPolicy({allowedTools:[],nativeRequestId:'native'})
 await env.links.put({runId:env.run.id,kind:'job',nativeId:'owner:'+taskRunRuntimeId+':'+env.run.sessionId,sessionId:'other-session',payload:{record:'owner',runtimeId:taskRunRuntimeId,requestId:'native'}})
 await assert.rejects(env.team.state(env.run),{code:'teloa/session-unavailable'})
 assert.equal(env.ctx.agents.get(env.root.id),undefined);assert.equal(env.adapter.calls,1);assert.equal(env.bodies(),0);assert.deepEqual((await env.ctx.sessionController.inspect(env.root.id)).events,before.events)
})

test('143 冷态 active 候选拒绝截断、序列缺口、无结尾及未完成 Goal；原 ended 读口仍严格',async t=>{
 const env=await coldCompletedActive(t),inspect=env.ctx.sessionController.inspect.bind(env.ctx.sessionController),fixed=await inspect(env.root.id)
 const variations=[
  fixed.events.slice(0,env.terminal.endSeq),
  fixed.events.map((event,index)=>index===1?{...event,seq:SessionSeq(event.seq+1)}:event),
  [...fixed.events,{type:'turn/start',seq:SessionSeq(fixed.events.length),time:Date.now(),data:{turn:env.terminal.turn+1}}] as SessionEvent[],
  fixed.events.map(event=>event.type==='user/message'&&event.data.source.kind==='user'?{...event,data:{...event.data,source:{kind:'user' as const,rpcId:'foreign'}}}:event),
 ]
 try{for(const events of variations){env.ctx.sessionController.inspect=async()=>({...fixed,events});await assert.rejects(env.team.state(env.run))}}finally{env.ctx.sessionController.inspect=inspect}
 await assert.rejects(readEndedTaskRunSession(env.ctx,env.run),{code:'teloa/session-unavailable'},'不把 active 输入伪造成已保存 ended')
 await assert.rejects(readTaskRunSessionForReconcile(env.ctx,env.run,async()=>({binding:{ownerId:'owner',runId:env.run.id,sessionId:env.run.sessionId,goalId:'goal',revision:1,hostGeneration:1,controlId:'control',controlGeneration:1},continuations:[],goalPhase:'active',activation:'disarmed',pendingRound:false,childrenOutstanding:false})),{code:'teloa/session-unavailable'})
 assert.equal(env.ctx.agents.get(env.root.id),undefined);assert.equal(env.adapter.calls,1);assert.equal(env.bodies(),0);assert.deepEqual((await inspect(env.root.id)).events,fixed.events)
})

test('143 冷态 active 候选仍保留真实 Inbox、Team 任务与授权未收口状态',async t=>{
 for(const pending of ['inbox','task','grant'] as const)await t.test(pending,async t=>{
  const env=await coldCompletedActive(t,pending),before=await env.ctx.sessionController.inspect(env.root.id)
  const state=await env.team.state(env.run)
  assert.ok(state.outstanding||state.interrupted)
  assert.equal(env.ctx.agents.get(env.root.id),undefined);assert.equal(env.adapter.calls,1);assert.equal(env.bodies(),0);assert.deepEqual(env.calls,[])
  assert.deepEqual((await env.ctx.sessionController.inspect(env.root.id)).events,before.events)
 })
})

test('官方 Controller 只读冷 root：真实 Loop 失败后卸载仍能证明 Team 空闲且不恢复或重放',async t=>{
 const env=await coldFailure(t)
 await env.handle.dispose()
 assert.equal(env.ctx.agents.get(env.root.id),undefined)
 const before=await env.ctx.sessionController.inspect(env.root.id)
 assert.deepEqual(before.events,env.events)
 let resolutions=0
 env.ctx.sessionController.resolveAgent=async()=>{resolutions++;throw Error('状态读取不能恢复执行')}
 const ports=dshTaskRunPorts(env.ctx,'owner',async()=>({ownerId:'owner',sessionId:env.run.sessionId,status:'ready'}),undefined,undefined,undefined,undefined,undefined,undefined,env.links)
 // 已核实固定终态且 Inbox 为空的冷轮可只读证明停妥：停止读数报告该 Run 原生日志的结束 seq，供暂停/停止收口（9651a5b4）。
 assert.deepEqual(await Promise.all([env.team.state(env.run),ports.stopState!(env.run)]),[{outstanding:false,interrupted:false},{running:false,settledSeq:(env.run.evidence as {endSeq:number}).endSeq}])
 const nativeBackground=ports.backgroundState!
 ports.backgroundState=async run=>{const [jobs,team]=await Promise.all([nativeBackground(run),env.team.state(run)]);return {outstanding:jobs.outstanding||team.outstanding,interrupted:jobs.interrupted||team.interrupted}}
 ports.subagentState=async()=> 'none';ports.flowState=async()=> 'none';ports.goalObservation=async()=>undefined
 await assert.rejects(assertSafeTaskRunRetry(env.run,ports,new AbortController().signal,{subagents:[],webAccess:[]}),{code:'teloa/conflict'},'空后台登记不冒充从未派发')
 assert.equal(resolutions,0)
 assert.equal(env.ctx.agents.get(env.root.id),undefined)
 assert.equal(env.adapter.calls,1);assert.equal(env.bodies(),0);assert.deepEqual(env.calls,[])
 assert.deepEqual((await env.ctx.sessionController.inspect(env.root.id)).events,before.events)
 await env.links.put({runId:'run',kind:'job',nativeId:'owner:old:team-root',sessionId:env.root.id,payload:{record:'owner',runtimeId:'old',requestId:'native'}})
 const retryRun={...env.run,allowedTools:['result'],skills:[],knowledge:[],memory:[]}
 assert.deepEqual(await ports.backgroundState(retryRun),{outstanding:false,interrupted:true},'全局完成读数不因显式重试证明改写')
 await assertSafeTaskRunRetry(retryRun,ports,new AbortController().signal,{subagents:[],webAccess:[]})
 await env.links.put({runId:'run',kind:'job',nativeId:'old:external',sessionId:env.root.id,payload:{record:'job',runtimeId:'old',requestId:'native',jobId:'external',status:'completed'}})
 await assert.rejects(assertSafeTaskRunRetry(retryRun,ports,new AbortController().signal,{subagents:[],webAccess:[]}),{code:'teloa/conflict'})
 assert.equal(resolutions,0);assert.equal(env.ctx.agents.get(env.root.id),undefined);assert.equal(env.adapter.calls,1)
})

test('冷 root 的待办输入、官方 Team 任务和持久授权均不能视为空闲',async t=>{
 for(const kind of ['inbox','task','grant'] as const)await t.test(kind,async t=>{
  const env=await coldFailure(t)
  if(kind==='inbox')env.root.inbox.append('next-turn',createUserMessage({content:[{type:'text',text:'后续未执行'}],source:{kind:'user',rpcId:'later'}}))
  if(kind==='task')await env.ctx.agentTeams.createTask(env.root,{subject:'未完成',description:'不能重放'})
  if(kind==='grant')await env.links.put({runId:'run',kind:'team',nativeId:'grant',sessionId:env.root.id,payload:{reservationId:'grant',requestId:'native',name:'reviewer'}})
  const queued=[...env.root.session.snapshotEvents()].reverse().find(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.length>0)
  await env.handle.dispose()
  if(kind==='inbox'){
   assert.ok(queued)
   // 正常 dispose 会取消 Inbox；保留官方 Inbox 生成的追加数据，构造未完成取消的冷日志。
   const writer=await env.ctx.sessionPersistence.open(env.root.id,'write')
   try{const history=(await writer.read()).events;await writer.append([{...queued,seq:SessionSeq(history.length),time:Date.now()}]);await writer.flush()}finally{await writer.close()}
  }
  const state=await env.team.state(env.run)
  assert.ok(state.outstanding||state.interrupted)
  assert.equal(env.ctx.agents.get(env.root.id),undefined);assert.equal(env.adapter.calls,1);assert.deepEqual(env.calls,[])
 })
})

test('冷 root 状态仍核对原请求、终态证据、停止与谱系，不因卸载放宽恢复',async t=>{
 const env=await coldFailure(t)
 await env.handle.dispose()
 for(const run of [{...env.run,nativeRequestId:'foreign'},{...env.run,state:'active'},{...env.run,evidence:null},{...env.run,stopRequestedAt:'2026-10-12T00:00:00Z'},{...env.run,agentPresetId:'foreign'}])await assert.rejects(env.team.state(run))
 env.setPolicy({allowedTools:[],nativeRequestId:'foreign'});await assert.rejects(env.team.state(env.run))
 env.setPolicy({allowedTools:[],nativeRequestId:'native',stopRequested:true});await assert.rejects(env.team.state(env.run))
 assert.equal(env.ctx.agents.get(env.root.id),undefined);assert.equal(env.adapter.calls,1);assert.deepEqual(env.calls,[])
 const child=await coldFailure(t,{parentSession:SessionId('foreign-parent'),origin:'subagent',delegationDepth:1})
 await child.handle.dispose();await assert.rejects(child.team.state(child.run));assert.equal(child.ctx.agents.get(child.root.id),undefined)
})

test('官方依赖任务板保持真源；成员自然完成卸载后按持久结尾收口',async t=>{
 const env=await setup(t),{ctx,root,team,run,call}=env
 const task=await ctx.agentTeams.createTask(root,{subject:'前置',description:'先做'})
 const dependent=await ctx.agentTeams.createTask(root,{subject:'后续',description:'后做',blockedBy:[task.id]})
 assert.equal(ctx.agentTeams.getTask(root,dependent.id).ready,false)
 await assert.rejects(ctx.agentTeams.updateTask(root,{taskId:dependent.id,expectedRevision:1,action:'claim'}))
 await ctx.agentTeams.updateTask(root,{taskId:task.id,expectedRevision:1,action:'claim'})
 await ctx.agentTeams.updateTask(root,{taskId:task.id,expectedRevision:2,action:'complete'})
 assert.equal(ctx.agentTeams.getTask(root,dependent.id).ready,true)
 await ctx.agentTeams.updateTask(root,{taskId:dependent.id,expectedRevision:1,action:'claim'})
 await ctx.agentTeams.updateTask(root,{taskId:dependent.id,expectedRevision:2,action:'complete'})
 const created=await call(root,'spawn_teammate',{name:'writer',description:'整理',prompt:'整理结果'},'writer-once')
 assert.equal(created.isError,false,JSON.stringify(created))
 assert.equal((await team.state(run)).outstanding,true)
 assert.equal(env.calls.filter(item=>item.kind==='settle').length,0)
 const member=ctx.agentTeams.listMembers(root).find(item=>item.name==='writer')!,child=ctx.agents.get(member.id)!
 root.session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 env.finish();await child.whenIdle()
 for(let count=0;count<100&&ctx.agents.get(member.id);count++)await new Promise(resolve=>setTimeout(resolve,5))
 await root.whenIdle()
 assert.equal(ctx.agents.get(member.id),undefined)
 assert.deepEqual(await team.state(run),{outstanding:false,interrupted:false})
 assert.equal(env.calls.filter(item=>item.kind==='settle').length,1)
 const events=root.session.snapshotEvents(),trusted=await team.runContinuations(run,events)
 assert.equal(observeTaskRun(events,'native',trusted).state,'ended')
})

test('旧非 Team continuable 子会话仍可由官方控制服务读取和中断，不冒充 Team 成员',async t=>{
 const {ctx,root}=await setup(t)
 const started=await ctx.subagents.startActivation({delivery:'parent',provider:'spawn',label:'既有子会话',request:{parent:root,prompt:[]},signal:AbortSignal.timeout(5000)})
 const child=ctx.agents.get(started.childId)!
 assert.ok(child);assert.equal(ctx.agentTeams.tryMembership(child),undefined)
 assert.equal(child.session.header.parentSession,root.id)
 assert.equal(typeof ctx.subagents.prompt,'function');assert.equal(typeof ctx.subagents.listDescendants,'function')
 assert.equal(ctx.subagents.interruptByParent(child.id,root.id,'continuable').accepted,true)
 await child.whenIdle()
})

test('真实 Team 工具经公开 execute 钩子预留、绑定临时身份；未登记成员与停止后调用被拒',async t=>{
 const env=await setup(t),{ctx,root,team,call}=env
 const result=await call(root,'spawn_teammate',{name:'reviewer',description:'复核',prompt:'请复核'},'spawn-once')
 assert.equal(result.isError,false,JSON.stringify(result))
 const member=ctx.agentTeams.listMembers(root).find(item=>item.name==='reviewer')!
 const child=ctx.agents.get(member.id)!
 assert.ok(child);assert.equal(ctx.agentTeams.membership(child).role,'teammate')
 assert.equal(env.calls.filter(item=>item.kind==='reserve').length,1)
 assert.equal(env.calls.filter(item=>item.kind==='bind').length,1)
 const repeated=await call(root,'spawn_teammate',{name:'reviewer',description:'复核',prompt:'请复核'},'spawn-once')
 assert.equal(repeated.isError,true);assert.equal(env.calls.filter(item=>item.kind==='reserve').length,1)
 root.session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 assert.equal((await call(child,'read_evidence')).isError,false)
 assert.equal((await call(child,'write_action')).isError,true)
 assert.equal((await call(child,'self_tool')).isError,true)
 assert.equal(env.bodies(),1)
 const unmanaged=(await ctx.agentTeams.spawnTeammate(root,{name:'unregistered',description:'无业务登记',prompt:[],context:'fresh',provider:'spawn',signal:AbortSignal.timeout(5000)})).member
 assert.equal((await call(ctx.agents.get(unmanaged.id)!,'read_evidence')).isError,true)
 env.setPolicy({allowedTools:[],nativeRequestId:'native',stopRequested:true})
 assert.match(JSON.stringify(await call(child,'read_evidence')),/已请求停止/)
 await team.stop({...env.run,stopRequestedAt:'2026-09-24T00:00:00Z'},AbortSignal.timeout(5000))
 await root.whenIdle()
 assert.equal((await team.state({...env.run,stopRequestedAt:'2026-09-24T00:00:00Z'})).outstanding,false)
 assert.equal(env.calls.filter(item=>item.kind==='settle').length,1)
 // 未登记的官方成员不被本 Run 的取消动作认领。
 assert.ok(ctx.agents.get(unmanaged.id))
})

test('并发重放同一 native callId 不重复预留或创建成员',async t=>{
 const env=await setup(t),args={name:'parallel',description:'并行重试',prompt:'工作'}
 const results=await Promise.all([env.call(env.root,'spawn_teammate',args,'same-call'),env.call(env.root,'spawn_teammate',args,'same-call')])
 assert.equal(results.filter(result=>!result.isError).length,1)
 assert.equal(env.calls.filter(item=>item.kind==='reserve').length,1)
 assert.equal(env.ctx.agentTeams.listMembers(env.root).filter(member=>member.role==='teammate').length,1)
})

test('旧宿主世代的 Run 不自动重获工具授权或重放外部动作',async t=>{
 const env=await setup(t)
 await env.links.put({runId:'run',kind:'job',nativeId:'owner:old:team-root',sessionId:'team-root',payload:{record:'owner',runtimeId:'old',requestId:'native'}})
 assert.equal((await env.call(env.root,'read_evidence')).isError,true)
 assert.equal(env.bodies(),0)
})

test('Team 续轮必须对上官方队列、teamId 和已授权 senderId',()=>{
 const teamId=TeamId('lead'),senderId=SessionId('child'),messageId=TeamMessageId('message')
 const grant:TaskRunRuntimeLink={runId:'run',kind:'team',nativeId:'call:one',sessionId:'lead',payload:{requestId:'native',reservationId:'call:one',name:'reviewer'}}
 const source={kind:'team-message' as const,teamId,senderId,messageId,senderName:'reviewer'}
 const base=[{type:'turn/start',data:{turn:0}},{type:'user/message',surfaceOp:'append',data:createUserMessage({content:[],source:{kind:'user',rpcId:'native'}})},{type:'team/member',data:{version:2,teamId,member:{id:senderId,name:'reviewer',description:'review',provider:'spawn',context:'fresh',phase:'active'}}},{type:'turn/end',data:{turn:0,reason:{kind:'completed'}}},{type:'team/message/queued',data:{version:2,teamId,message:{id:messageId,senderId,senderName:'reviewer',targetId:SessionId('lead'),content:[]}}},{type:'turn/start',data:{turn:1}}]
 const events=(next:typeof source)=>[...base,{type:'user/message',surfaceOp:'append',data:createUserMessage({content:[],source:next})}].map((event,seq)=>({...event,seq,time:seq})) as SessionEvent[]
 const accepted=events(source),keys=taskRunTeamContinuations(accepted,[grant])
 assert.equal(observeTaskRun(accepted,'native',keys).state,'active')
 assert.equal(observeTaskRun(accepted,'native',taskRunTeamContinuations(accepted,[])).state,'ended')
 for(const changed of [{...source,teamId:TeamId('foreign')},{...source,senderId:SessionId('foreign')},{...source,messageId:TeamMessageId('foreign')}])assert.equal(observeTaskRun(events(changed),'native',keys).state,'ended')
})

test('新版 Team 直接 Inbox 接纳不代表处理，未消费消息阻止父 Run 提前完成',async t=>{
 const env=await setup(t,false,{},false),{ctx,root}=env
 const started=new Promise<void>(resolve=>{const off=ctx.on('session/event',(session,event)=>{if(session===root.session&&event.type==='user/message'&&event.data.source.kind==='user'&&'rpcId' in event.data.source&&event.data.source.rpcId==='native'){off();resolve()}},{global:true})})
 root.followup(createUserMessage({source:{kind:'user',rpcId:'native'},content:[{type:'text',text:'等待已授权的团队复核'}]}))
 await started
 const result=await env.call(root,'spawn_teammate',{name:'inbox-reviewer',description:'复核',prompt:'等待'})
 assert.equal(result.isError,false,JSON.stringify(result))
 const member=ctx.agentTeams.listMembers(root).find(member=>member.name==='inbox-reviewer')!,child=ctx.agents.get(member.id)!
 const before=root.session.snapshotEvents().length
 const sent=await ctx.agentTeams.sendMessage(child,{target:'lead',content:[{type:'text',text:'已接纳，仍等待负责人的模型处理'}],signal:AbortSignal.timeout(5000)})
 assert.equal(typeof sent.messageId,'string')
 assert.ok([...root.inbox.nextTurn,...root.inbox.nextStep].some(message=>message.id===sent.messageId))
 assert.equal(root.session.snapshotEvents().slice(before).some(event=>event.type==='team/message/queued'),false)
 assert.equal((await env.team.state(env.run)).outstanding,true)
 await env.team.stop({...env.run,stopRequestedAt:'2026-10-15T00:00:00Z'},AbortSignal.timeout(5000))
})
