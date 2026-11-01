import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmRuntime,LlmAdapter,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import type {TaskRun} from '@teloa/backend'
import {readRunAnalysisScope,runAnalysisNotice,ownerTaskMemoryAnalysisNotice} from '@teloa/contract'
import {verifiedAnalysisRun} from '../src/task-run-analysis.ts'
import {restrictRunTools} from '../src/task-run-dsh.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {registerTaskRunTextScope} from '../src/task-run-text-scope.ts'
import {leaseRunTools} from '../src/task-run-tool-lease.ts'
import {runToolApplicability} from '../src/task-run-tool-catalog.ts'
import {registerRoleMemoryTools} from '../src/role-memory.ts'
import {isTextOnlyTaskRun} from '../src/task-run-background.ts'
import type {TaskToolPolicy} from '../src/task-tool-guard.ts'
import {TaskRunDriver} from '../src/task-run-driver.ts'

function runFixture():TaskRun{
 const taskId=randomUUID(),roleId=randomUUID(),groupId=randomUUID(),scope=readRunAnalysisScope({schema:'teloa.run-analysis-scope/v1',kind:'source-derived',ownerId:'owner',taskId,taskVersion:1,roleId,roleVersion:1,groupId,groupVersion:1,sourceMessageId:randomUUID(),sourceDigest:'a'.repeat(64),contextSha256:'b'.repeat(64),lineageSha256:'c'.repeat(64),controls:[{id:randomUUID(),generation:1}],files:[],notice:runAnalysisNotice})
 assert.ok(scope.kind==='source-derived')
 return {id:randomUUID(),taskId,roleId,taskVersion:1,roleVersion:1,linkVersion:1,sessionId:'analysis-session',nativeRequestId:randomUUID(),state:'prepared',evidence:null,stopRequestedAt:null,allowedTools:[],argumentRules:[],skills:[],knowledge:[],memory:[],inputText:JSON.stringify({analysisScope:scope}),createdAt:'2026-10-27T00:00:00.000Z',analysisScope:scope,groupContext:{taskId,roleId,roleVersion:1,groupId,groupVersion:1,grantVersion:1,source:{messageId:scope.sourceMessageId,rootId:scope.sourceMessageId,text:'只分析合成资料',createdAt:'2026-10-27T00:00:00.000Z'},materials:[],files:[]}}
}
function ownerRunFixture():TaskRun{
 const run=runFixture(),old=run.analysisScope!,{groupContext,...fixed}=run
 const scope=readRunAnalysisScope({schema:old.schema,kind:'owner-task-derived',ownerId:old.ownerId,taskId:old.taskId,taskVersion:old.taskVersion,roleId:old.roleId,roleVersion:old.roleVersion,sourceDigest:old.sourceDigest,contextSha256:old.contextSha256,lineageSha256:old.lineageSha256,controls:old.controls,files:[],notice:old.notice,requestId:randomUUID(),materialsSha256:'d'.repeat(64),knowledgeSha256:'e'.repeat(64)})
 return {...fixed,analysisScope:scope,inputText:JSON.stringify({analysisScope:scope})}
}
test('派生scope出现本身不放行，必须后端同Run可信读口复核且禁止夹带工具',async()=>{
 const run=runFixture(),signal=AbortSignal.timeout(5000)
 await assert.rejects(verifiedAnalysisRun(run,signal),{code:'teloa/forbidden'})
 await assert.rejects(verifiedAnalysisRun(run,signal,async()=>false),{code:'teloa/forbidden'})
 let calls=0;assert.equal(await verifiedAnalysisRun(run,signal,async actual=>{calls++;assert.equal(actual.id,run.id);return true}),true);assert.equal(calls,1)
 await assert.rejects(verifiedAnalysisRun({...run,allowedTools:['run_code']},signal,async()=>true),{code:'teloa/storage-corrupt'})
})
test('实际TaskRunDriver.start仅在同Run后端核验后领取发送；伪scope与普通空工具均零提交',async()=>{
 for(const trusted of [undefined,false,true]){
  let run=runFixture();const calls={claim:0,send:0},target={taskId:run.taskId,taskVersion:run.taskVersion,sessionId:run.sessionId,linkVersion:run.linkVersion,scope:'general'}
  const driver=new TaskRunDriver({get:async()=>run,executionScope:async()=>target,claim:async()=>{calls.claim++;run={...run,state:'submitting'};return {run,dispatch:true,target}},record:async()=>{run={...run,state:'accepted',evidence:{state:'accepted'}};return run},requestStop:async()=>run,...(trusted===undefined?{}:{isAnalysisRun:async(owner,input)=>{assert.equal(owner,'owner');assert.deepEqual(input,{runId:run.id});return trusted}})},{check:async()=>{},send:async actual=>{calls.send++;assert.deepEqual(actual.allowedTools,[])},events:async()=>[],stop:async()=>{throw Error('本例不停止')}})
  const action=()=>driver.start('owner',{runId:run.id},AbortSignal.timeout(5000))
  if(trusted===true){assert.equal((await action()).state,'accepted');await action();assert.deepEqual(calls,{claim:1,send:1})}
  else{await assert.rejects(action(),{code:'teloa/forbidden'});assert.deepEqual(calls,{claim:0,send:0})}
 }
 const normal=runFixture();delete normal.analysisScope
 const driver=new TaskRunDriver({get:async()=>normal,executionScope:async()=>{throw Error('不应领取')},claim:async()=>{throw Error('不应提交')},record:async()=>normal,requestStop:async()=>normal},{check:async()=>{},send:async()=>{throw Error('不应发送')},events:async()=>[],stop:async()=>{throw Error('不停止')}})
 await assert.rejects(driver.start('owner',{runId:normal.id},AbortSignal.timeout(5000)),{code:'teloa/conflict'})
})
test('已核分析scope复用真实SDK零工具装配：PTC降为native、全部执行拒绝且不污染另一Agent',async()=>{
 let calls=0,models=0
 class NeverAdapter extends LlmAdapter{
  async resolveModel(provider:string,id:string){return {provider,id,name:id,inputModalities:['text' as const]}}
  async *stream():AsyncGenerator<never>{models++;throw Error('本测试禁止模型')}
 }
 const ctx=new Context()
 try{
  for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt])await ctx.plugin(plugin)
  await ctx.plugin(ToolRuntime,{mode:'ptc'});await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]});ctx.llm.registerAdapter(['offline-never'],new NeverAdapter())
  const {agent}=await ctx.agents.create({sessionId:SessionId('analysis-session'),agentOptions:{provider:'offline-never',model:'never'}}),{agent:sibling}=await ctx.agents.create({sessionId:SessionId('other-session'),agentOptions:{provider:'offline-never',model:'never'}})
  for(const name of ['read','bash','web_fetch'])ctx.tools.register(defineTool({name,description:'本轮执行必须不可达',parameters:{},output:{schema:{type:'string'},render:()=>[]},execute:async()=>{calls++;return 'never'}}))
  for(const run of [runFixture(),ownerRunFixture()]){
  assert.equal(await verifiedAnalysisRun(run,AbortSignal.timeout(5000),async()=>true),true)
  registerTaskToolGuard(ctx,async id=>id===agent.id?{allowedTools:[],textOnly:true}:null,[])
  const release=restrictRunTools(agent,[],runToolApplicability(run,false,true))
  try{
   assert.deepEqual((await ctx.systemPrompt.assemble({agent,scope:agent})).tools,[])
   await assert.rejects(ctx.systemPrompt.assemble({agent:sibling,scope:sibling}),/PTC|ptc|runtime/i,'另一Agent仍保留原PTC呈现，不能被text scope全局改写')
   for(const name of ['read','bash','web_fetch','run_code'])assert.equal((await ctx.tools.execute({name,arguments:{},callId:ToolCallId('analysis-'+name),agent,signal:AbortSignal.timeout(5000)})).isError,true)
  }finally{release()}
  }
  assert.equal(calls,0);assert.equal(models,0)
 }finally{await ctx.fiber.dispose()}
})
test('独立任务scope仍需同Run可信读口，夹带群来源或工具立即拒绝',async()=>{
 const run=ownerRunFixture(),signal=AbortSignal.timeout(5000)
 await assert.rejects(verifiedAnalysisRun(run,signal),{code:'teloa/forbidden'})
 await assert.rejects(verifiedAnalysisRun(run,signal,async()=>false),{code:'teloa/forbidden'})
 await assert.rejects(verifiedAnalysisRun({...run,groupContext:runFixture().groupContext!},signal,async()=>true),{code:'teloa/storage-corrupt'})
 await assert.rejects(verifiedAnalysisRun({...run,allowedTools:['run_code']},signal,async()=>true),{code:'teloa/storage-corrupt'})
 assert.equal(await verifiedAnalysisRun(run,signal,async()=>true),true)
})

test('新本人分身分析范围只显式携带一个候选工具，旧scope及其它来源不补权',()=>{
 const run=ownerRunFixture(),old=run.analysisScope!
 assert.throws(()=>readRunAnalysisScope({...old,selfAuthorizedTools:['teloa_role_memory_propose']}))
 for(const tools of [[],['read'],['teloa_role_memory_propose','teloa_group_react'],['teloa_role_memory_propose','teloa_role_memory_propose']])assert.throws(()=>readRunAnalysisScope({...old,notice:ownerTaskMemoryAnalysisNotice,selfAuthorizedTools:tools}))
 assert.throws(()=>readRunAnalysisScope({...runFixture().analysisScope,selfAuthorizedTools:['teloa_role_memory_propose'],notice:ownerTaskMemoryAnalysisNotice}))
 assert.equal(readRunAnalysisScope(old).notice,runAnalysisNotice)
 const scope=readRunAnalysisScope({...old,selfAuthorizedTools:['teloa_role_memory_propose'],notice:ownerTaskMemoryAnalysisNotice})
 assert.deepEqual(scope.kind==='owner-task-derived'&&scope.selfAuthorizedTools,['teloa_role_memory_propose'])
 assert.equal(isTextOnlyTaskRun(run),true)
 assert.equal(isTextOnlyTaskRun({...run,analysisScope:scope}),false,'可写候选的Run不能借旧纯文本零副作用恢复例外')
})
test('真实SDK组装和执行：新分身分析仅候选可达，普通/native/PTC/其它自授权拒绝，暂停/能力变化收紧',async()=>{
 const ctx=new Context();let calls=0,models=0
 class Never extends LlmAdapter{async resolveModel(provider:string,id:string){return {provider,id,name:id,inputModalities:['text' as const]}}async *stream():AsyncGenerator<never>{models++;throw Error('no model')}}
 try{
  for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt])await ctx.plugin(plugin)
  await ctx.plugin(ToolRuntime,{mode:'ptc'});await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]});ctx.llm.registerAdapter(['offline'],new Never())
  const run=ownerRunFixture();run.analysisScope=readRunAnalysisScope({...run.analysisScope,selfAuthorizedTools:['teloa_role_memory_propose'],notice:ownerTaskMemoryAnalysisNotice})
  const {agent}=await ctx.agents.create({sessionId:SessionId(run.sessionId),agentOptions:{provider:'offline',model:'never'}})
  const names=['teloa_role_memory_propose','teloa_group_react','teloa_role_memory_confirm','read','bash','memory']
  for(const name of names.slice(1))ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:()=>[]},execute:async()=>{calls++;return 'ok'}}))
  const markdown='交付前复核证据。',preference={kind:'preference',basis:{kind:'owner-input',quote:'交付前复核证据。'}}
  registerRoleMemoryTools(ctx,{owner:'owner',run:async sessionId=>({id:run.id,roleId:run.roleId!,roleVersion:run.roleVersion!,sessionId,state:'active',roleSnapshot:{kind:'twin'}}),scope:async()=>({taskId:run.taskId,taskVersion:run.taskVersion,sessionId:run.sessionId,linkVersion:run.linkVersion,scope:'general'}),create:async(actor,input)=>{
   calls++;const value=input as {source:unknown;visibility:unknown;preference:unknown;expectedRoleVersion:number}
   assert.deepEqual(actor,{ownerId:'owner',kind:'agent',roleId:run.roleId});assert.equal(value.expectedRoleVersion,run.roleVersion)
   assert.deepEqual(value.source,{kind:'run',id:run.id,version:1});assert.deepEqual(value.visibility,{kind:'private',scopeIds:[]})
   assert.deepEqual(value.preference,{...preference,schema:'teloa.preference-candidate/v1',scope:'general'})
   return {id:randomUUID(),ownerId:'owner',roleId:run.roleId,roleVersion:run.roleVersion,title:'复核证据',state:'candidate',stateVersion:1,source:value.source,sourceTitle:'本人原任务',sourceAvailable:true,visibility:value.visibility,proposedBy:{kind:'role',roleId:run.roleId,roleVersion:run.roleVersion},content:{version:1,contentHash:createHash('sha256').update(markdown).digest('hex'),bytes:Buffer.byteLength(markdown),markdown,createdAt:run.createdAt},candidateAt:run.createdAt,confirmedAt:null,withdrawnAt:null}
  }})
  let policy:TaskToolPolicy={allowedTools:[],textOnly:true,nativeRequestId:run.nativeRequestId,selfAuthorizedTools:['teloa_role_memory_propose']}
  const read=async()=>policy
  registerTaskToolGuard(ctx,read,['teloa_role_memory_propose','teloa_group_react'])
  registerTaskRunTextScope(ctx,read,(a,aux)=>restrictRunTools(a,[],{text:true,group:false,digest:false,...(aux.length?{selfAuthorizedTools:aux}:{})}))
  const release=leaseRunTools(agent,run.nativeRequestId,true,()=>restrictRunTools(agent,[],runToolApplicability(run,false,true)),'teloa_role_memory_propose')
  const assembled=await ctx.systemPrompt.assemble({agent,scope:agent});assert.deepEqual(assembled.tools.map(t=>t.name),['teloa_role_memory_propose'])
  assert.match(JSON.stringify(assembled.tools),/owner-input/);assert.match(JSON.stringify(assembled.tools),/preference/)
  agent.session.append('turn/start',{turn:1})
  agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:run.nativeRequestId as never},content:[]}),{surfaceOp:'append'})
  let sequence=0;const call=(name:string)=>ctx.tools.execute({agent,name,arguments:name==='teloa_role_memory_propose'?{title:'复核证据',markdown,preference}:{},callId:ToolCallId('candidate-'+ ++sequence),signal:AbortSignal.timeout(5000)})
  assert.equal((await call('teloa_role_memory_propose')).isError,false)
  for(const name of [...names.slice(1),'run_code'])assert.equal((await call(name)).isError,true,name)
  assert.equal(calls,1)
  const {agent:child}=await ctx.agents.create({sessionId:SessionId('analysis-child'),meta:{origin:'subagent',parentSession:agent.id,delegationDepth:1},agentOptions:{provider:'offline',model:'never'}})
  child.ctx.tools.presentAs('native')
  assert.deepEqual((await ctx.systemPrompt.assemble({agent:child,scope:child})).tools,[],'子会话不得借用根分身的私有候选能力')
  assert.equal((await ctx.tools.execute({agent:child,name:'teloa_role_memory_propose',arguments:{title:'越界',markdown,preference},callId:ToolCallId('child-candidate'),signal:AbortSignal.timeout(5000)})).isError,true)
  const removeRace=ctx.on('tools/pre-execute',async(_exec,next)=>{const result=await next();policy={allowedTools:[],textOnly:true,nativeRequestId:run.nativeRequestId};return result},true)
  assert.equal((await call('teloa_role_memory_propose')).isError,true,'pre-execute已允许但派发前许可撤回仍零写入');removeRace()
  assert.equal(calls,1)
  policy={allowedTools:[],textOnly:true,nativeRequestId:run.nativeRequestId,selfAuthorizedTools:['teloa_role_memory_propose']}
  policy={...policy,stopRequested:true};assert.equal((await call('teloa_role_memory_propose')).isError,true)
  policy={allowedTools:[],textOnly:true,nativeRequestId:run.nativeRequestId};assert.equal((await call('teloa_role_memory_propose')).isError,true)
  await assert.rejects(ctx.systemPrompt.assemble({agent,scope:agent}),'同一Run不可替换候选许可')
  release();assert.equal(models,0);assert.equal(calls,1)
 }finally{await ctx.fiber.dispose()}
})
