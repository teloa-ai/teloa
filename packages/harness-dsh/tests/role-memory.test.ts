import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {createRoleMemoryHandler,registerRoleMemoryTools,roleMemoryProposalToolName,type RoleMemoryToolPorts} from '../src/role-memory.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'

test('岗位记忆 RPC 固定为本人，并独立分派目录、候选、确认与撤回',async()=>{
 const calls:unknown[]=[],backend={
  list:async(actor:unknown,input:unknown)=>{calls.push(['list',actor,input]);return []},
  create:async(actor:unknown,input:unknown)=>{calls.push(['create',actor,input]);return {state:'candidate'}},
  confirm:async(actor:unknown,input:unknown)=>{calls.push(['confirm',actor,input]);return {state:'confirmed'}},
  withdraw:async(actor:unknown,input:unknown)=>{calls.push(['withdraw',actor,input]);return {state:'withdrawn'}},
 }
 const handle=createRoleMemoryHandler('local:owner',async()=>backend)
 await handle('role-memory/list',{roleId:'a'})
 await handle('role-memory/create',{requestId:'r',roleId:'a',expectedRoleVersion:1,title:'经验',markdown:'正文',source:{},visibility:{}})
 await handle('role-memory/confirm',{requestId:'c',memoryId:'m',expectedStateVersion:1})
 await handle('role-memory/withdraw',{requestId:'w',memoryId:'m',expectedStateVersion:2})
 assert.deepEqual(calls.map(row=>(row as unknown[]).slice(0,2)),[
  ['list',{ownerId:'local:owner',kind:'human'}],['create',{ownerId:'local:owner',kind:'human'}],['confirm',{ownerId:'local:owner',kind:'human'}],['withdraw',{ownerId:'local:owner',kind:'human'}],
 ])
})

test('未知接口、未知字段和伪造主体在读取服务前拒绝',async()=>{
 let reads=0
 const handle=createRoleMemoryHandler('local:owner',async()=>{reads++;throw Error('数据库不可用')})
 await assert.rejects(handle('role-memory/delete',{}),{code:'teloa/not-found'})
 await assert.rejects(handle('role-memory/list',{roleId:'a',ownerId:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('role-memory/confirm',{requestId:'r',memoryId:'m',expectedStateVersion:1,kind:'agent'}),{code:'teloa/invalid-input'})
 assert.equal(reads,0)
 await assert.rejects(handle('role-memory/list',{roleId:'a'}),/数据库不可用/)
 assert.equal(reads,1)
})

const owner='local:teloa-owner',roleId='22222222-2222-4222-8222-222222222222',runId='33333333-3333-4333-8333-333333333333',sourceId='44444444-4444-4444-8444-444444444444'
async function setupTool(overrides:Partial<RoleMemoryToolPorts>={}){
 const ctx=new Context()
 await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('role-memory-run'),agentOptions:{provider:'test',model:'test'}}),calls:unknown[][]=[]
 const candidate={id:'55555555-5555-4555-8555-555555555555',ownerId:owner,roleId,roleVersion:2,title:'复核证据',state:'candidate',stateVersion:1,source:{kind:'task',id:sourceId,version:1},sourceTitle:'调查任务',sourceAvailable:true,visibility:{kind:'role',scopeIds:['SOC']},proposedBy:{kind:'role',roleId,roleVersion:2},content:{version:1,contentHash:'410a138411ce7bf1449d287e63a9c4aee025f3b91815302e3a98059f88c896c2',bytes:24,markdown:'交付前复核证据。',createdAt:'2026-09-13T00:00:00.000Z'},candidateAt:'2026-09-13T00:00:00.000Z',confirmedAt:null,withdrawnAt:null}
 const ports:RoleMemoryToolPorts={owner,run:async sessionId=>({id:runId,roleId,roleVersion:2,sessionId,state:'active'}),scope:async()=>({taskId:sourceId,taskVersion:1,sessionId:agent.session.id,linkVersion:1,scope:'SOC'}),create:async(actor,input)=>{calls.push([actor,input]);return candidate},...overrides}
 registerRoleMemoryTools(ctx,ports)
 const nativeRequestId='66666666-6666-4666-8666-666666666666'
 registerTaskToolGuard(ctx,async()=>({allowedTools:[],nativeRequestId}),[roleMemoryProposalToolName])
 agent.session.append('turn/start',{turn:0});agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>(nativeRequestId)}}),{surfaceOp:'append'})
 let seq=0
 const call=(args:Record<string,unknown>)=>ctx.tools.execute({agent,name:roleMemoryProposalToolName,arguments:args,callId:ToolCallId('memory-'+ ++seq),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,calls,call,candidate,ports}
}

for(const state of ['active','missing-run','ended','offline'] as const)test(`子 Agent 岗位记忆：${state} 只认父岗位与父 Run`,async t=>{
 const env=await setupTool();t.after(()=>env.ctx.fiber.dispose())
 const {agent:child}=await env.ctx.agents.create({sessionId:SessionId('memory-child'),meta:{origin:'subagent',parentSession:env.agent.session.id,delegationDepth:1},agentOptions:{provider:'test',model:'test'}})
 child.session.append('turn/start',{turn:0});child.session.append('user/message',createUserMessage({content:[],source:{kind:'user'}}),{surfaceOp:'append'})
 const readIds:string[]=[]
 env.ports.run=async sessionId=>{readIds.push(sessionId);return state==='missing-run'?null:{id:runId,roleId,roleVersion:2,sessionId,state:state==='ended'?'ended':'active'}}
 if(state==='offline')env.ctx.agents.get=()=>undefined
 const args={title:'复核证据',markdown:'交付前复核证据。',source:{kind:'task',id:sourceId,version:1}}
 const result=await env.ctx.tools.execute({agent:child,name:roleMemoryProposalToolName,arguments:args,callId:ToolCallId('same-parent-request'),signal:AbortSignal.timeout(5000)})
 assert.equal(result.isError,state!=='active')
 if(state==='active'){
  assert.deepEqual(readIds,[env.agent.session.id,env.agent.session.id])
  assert.deepEqual(env.calls[0]![0],{ownerId:owner,kind:'agent',roleId})
  const input=env.calls[0]![1] as {requestId:string;roleId:string;visibility:unknown}
  assert.equal(input.roleId,roleId);assert.deepEqual(input.visibility,{kind:'role',scopeIds:['SOC']})
  const content=result.content.find(item=>item.type==='text')
  assert.ok(content?.type==='text')
  assert.deepEqual(JSON.parse(content.text).memory.proposedBy,{kind:'role',roleId,roleVersion:2})
  const rootResult=await env.ctx.tools.execute({agent:env.agent,name:roleMemoryProposalToolName,arguments:args,callId:ToolCallId('same-parent-request'),signal:AbortSignal.timeout(5000)})
  assert.equal(rootResult.isError,false)
  assert.equal((env.calls[1]![1] as {requestId:string}).requestId,input.requestId)
 }else{
  assert.equal(env.calls.length,0)
  assert.ok(state==='offline'?readIds.length===0:readIds.every(id=>id===env.agent.session.id))
 }
})

test('数字员工通过真实 ToolRuntime 为当前运行岗位提出候选，身份与范围均由 Run 固定',async t=>{
 const env=await setupTool();t.after(()=>env.ctx.fiber.dispose())
 assert.ok(env.ctx.tools.schemas(env.agent).some(tool=>tool.name===roleMemoryProposalToolName))
 const result=await env.call({title:'复核证据',markdown:'交付前复核证据。',source:{kind:'task',id:sourceId,version:1}})
 assert.equal(result.isError,false)
 assert.deepEqual(env.calls,[[{ownerId:owner,kind:'agent',roleId},{requestId:(env.calls[0]![1] as {requestId:string}).requestId,roleId,expectedRoleVersion:2,title:'复核证据',markdown:'交付前复核证据。',source:{kind:'task',id:sourceId,version:1},visibility:{kind:'role',scopeIds:['SOC']}}]])
 assert.match((env.calls[0]![1] as {requestId:string}).requestId,/^[a-f0-9-]{36}$/)
 assert.equal((await env.call({title:'伪造',markdown:'正文',source:{kind:'task',id:sourceId,version:1},roleId:'77777777-7777-4777-8777-777777777777'})).isError,true)
 assert.equal(env.calls.length,1)
})

test('岗位记忆工具拒绝普通或结束 Run、范围身份不一致与 self-feedback 来源',async t=>{
 const cases:Partial<RoleMemoryToolPorts>[]=[
  {run:async()=>null},
  {run:async sessionId=>({id:runId,roleId,roleVersion:2,sessionId,state:'ended'})},
  {scope:async()=>({taskId:sourceId,taskVersion:1,sessionId:'other-session',linkVersion:1,scope:'SOC'})},
 ]
 for(const overrides of cases){const env=await setupTool(overrides);t.after(()=>env.ctx.fiber.dispose());assert.equal((await env.call({title:'复核证据',markdown:'正文',source:{kind:'task',id:sourceId,version:1}})).isError,true);assert.equal(env.calls.length,0)}
 const source=await setupTool();t.after(()=>source.ctx.fiber.dispose());assert.equal((await source.call({title:'自述',markdown:'正文',source:{kind:'self-feedback',id:sourceId,version:1}})).isError,true);assert.equal(source.calls.length,0)
})
