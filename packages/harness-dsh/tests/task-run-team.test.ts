import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime,LlmAdapter,createUserMessage,ToolCallId,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId,type SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
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
import {observeTaskRun} from '../src/task-run-observation.ts'

class WaitingAdapter extends LlmAdapter{
 private released=false
 private waiters:Array<()=>void>=[]
 finish(){this.released=true;for(const resolve of this.waiters)resolve()}
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
 async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
  if(!this.released)await new Promise<void>((resolve,reject)=>{this.waiters.push(resolve);if(options.signal?.aborted)reject(options.signal.reason);else options.signal?.addEventListener('abort',()=>reject(options.signal!.reason),{once:true})})
  yield {type:'block-start',index:0,blockType:'text'}
  yield {type:'text-delta',index:0,text:'完成'}
  yield {type:'block-end',index:0,block:{type:'text',text:'完成'}}
  yield {type:'finish',reason:{kind:'stop'}}
 }
}

async function setup(t:TestContext){
 const directory=await mkdtemp(join(tmpdir(),'teloa-team-')),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true})})
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 await ctx.plugin(JsonlSessionPersistence,{root:directory,compression:'none'})
 await ctx.plugin(LocalJobRegistry,{})
 const adapter=new WaitingAdapter();ctx.llm.registerAdapter(['test'],adapter)
 await ctx.plugin(SubagentRuntime,{maxDepth:1,maxActiveSubagents:6})
 await ctx.plugin(Spawn,{providerName:'spawn'});await ctx.plugin(TeamService,{maxMembers:6});await ctx.plugin(TeamTools,{freshProvider:'spawn',forkProvider:'fork'})
 const {agent:root}=await ctx.agents.create({sessionId:SessionId('team-root'),agentOptions:{provider:'test',model:'test'}})
 const rows=new Map<string,TaskRunRuntimeLink>(),calls:Array<{kind:string;input:unknown}>=[]
 const links:TaskRunRuntimeLinks={list:async input=>[...rows.values()].filter(row=>row.runId===input.runId&&(!input.kind||row.kind===input.kind)),put:async row=>{rows.set(row.kind+':'+row.nativeId,structuredClone(row))}}
 const delegation:SubagentDelegationPorts={limits:{maxDepth:1,maxPerRun:6},runId:async()=> 'run',reserve:async input=>{calls.push({kind:'reserve',input})},release:async input=>{calls.push({kind:'release',input})},bind:async input=>{calls.push({kind:'bind',input})},settle:async input=>{calls.push({kind:'settle',input})},abandon:async input=>{calls.push({kind:'abandon',input})}}
 let policy:TaskToolPolicy={allowedTools:[...teamDelegationTools,'read_evidence'],nativeRequestId:'native'}
 const readPolicy=async()=>policy,team=createTaskRunTeam(ctx,delegation,readPolicy,links);t.after(team.dispose)
 registerTaskToolGuard(ctx,readPolicy,['self_tool'],undefined,delegation,undefined,team)
 let bodies=0,sequence=0
 for(const name of ['read_evidence','write_action','self_tool'])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 root.session.append('turn/start',{turn:0});root.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:'native'}}),{surfaceOp:'append'})
 const call=(agent:typeof root,name:string,args:Record<string,unknown>={},callId='call-'+ ++sequence)=>agent.ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal:AbortSignal.timeout(5000)})
 const run={id:'run',sessionId:root.id,nativeRequestId:'native',state:'active',stopRequestedAt:null} as unknown as TaskRun
 return {ctx,root,team,links,calls,call,run,finish:()=>adapter.finish(),bodies:()=>bodies,setPolicy:(next:TaskToolPolicy)=>{policy=next}}
}

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
 const started=await ctx.subagents.startContinuable({provider:'spawn',label:'既有子会话',request:{parent:root,prompt:[]},signal:AbortSignal.timeout(5000)})
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
