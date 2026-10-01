import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime} from '@deepseek-ai/dsh-llm'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {ToolCallId} from '@deepseek-ai/dsh-llm'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {registerTaskSubagentTool} from '../src/task-subagent-tool.ts'
import type {SubagentDelegationPorts} from '../src/subagent-delegation.ts'
import {subagentTaskToolName} from '../src/role-tool-grants.ts'

async function setup(result:{stopReason:string;output:{type:string;text?:string}[];diagnostic?:string}|Error={stopReason:'completed',output:[{type:'text',text:'已完成'}]},estimate?:number,portOverrides:Partial<SubagentDelegationPorts>={},dispose:()=>Promise<void>=async()=>{}){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('task-subagent-parent'),agentOptions:{provider:'test',model:'test'}})
 const calls:{name:string;input:unknown}[]=[]
 let disposeCount=0,sequence=0
 ctx.provide('subagents',{start:async(name:string,input:unknown)=>{
  calls.push({name,input});const id='child_'+(++sequence)
  if(estimate!==undefined)await ctx.agents.create({sessionId:SessionId(id),agentOptions:{provider:'test',model:'test'}})
  return {id,result:result instanceof Error?Promise.reject(result):Promise.resolve(result),dispose:async()=>{disposeCount++;await dispose()}}
 }})
 if(estimate!==undefined)Object.defineProperty(ctx,'tokenMeter',{value:{measure:()=>({totalTokens:estimate})}})
 const records:{kind:string;input:unknown}[]=[]
 const ports:SubagentDelegationPorts={
  limits:{maxDepth:1,maxPerRun:6},runId:async sessionId=>{records.push({kind:'run',input:sessionId});return 'a44f511d-436e-4feb-ae3f-0468dc0df10d'},
  reserve:async input=>{records.push({kind:'reserve',input})},release:async input=>{records.push({kind:'release',input})},bind:async input=>{records.push({kind:'bind',input})},settle:async input=>{records.push({kind:'settle',input})},abandon:async input=>{records.push({kind:'abandon',input})},
  ...portOverrides,
 }
 registerTaskSubagentTool(ctx,ports)
 const call=(description:string,prompt:string,callId:string,signal:AbortSignal=AbortSignal.timeout(5_000))=>ctx.tools.execute({agent,name:subagentTaskToolName,arguments:{description,prompt},callId:ToolCallId(callId),signal})
 return {ctx,agent,calls,records,call,disposeCount:()=>disposeCount}
}

test('每次执行态子任务直接把预留与 start 返回的子会话身份绑定',async t=>{
 const env=await setup();t.after(()=>env.ctx.fiber.dispose())
 const [first,second]=await Promise.all([env.call('研判甲','检查第一条告警','call-a'),env.call('研判乙','检查第二条告警','call-b')])
 assert.equal(first.isError,false);assert.equal(second.isError,false)
 assert.equal(env.calls.length,2);assert.equal(env.disposeCount(),2)
 const binds=env.records.filter(item=>item.kind==='bind').map(item=>item.input)
 assert.equal(binds.length,2)
 assert.deepEqual(binds.map(input=>({childSessionId:(input as {childSessionId:string}).childSessionId,depth:(input as {depth:number}).depth})),[{childSessionId:'child_1',depth:1},{childSessionId:'child_2',depth:1}])
 assert.ok(binds.every(input=>/^call:[a-f0-9]{64}$/.test((input as {reservationId:string}).reservationId)))
 assert.notEqual((binds[0] as {reservationId:string}).reservationId,(binds[1] as {reservationId:string}).reservationId)
 assert.deepEqual(env.records.filter(item=>item.kind==='settle').map(item=>item.input),[{childSessionId:'child_1',stopReason:'completed'},{childSessionId:'child_2',stopReason:'completed'}])
})

test('委派层数上限原样传给子 Agent provider，不让静态默认值覆盖运行配置',async t=>{
 const env=await setup(undefined,undefined,{limits:{maxDepth:2,maxPerRun:6}});t.after(()=>env.ctx.fiber.dispose())
 const result=await env.call('两层边界','验证 provider 取得运行态深度上限','call-depth-two')
 assert.equal(result.isError,false)
 assert.equal(env.calls.length,1)
 assert.equal((env.calls[0]!.input as {maxDepth:unknown}).maxDepth,2)
})

test('子会话启动前失败时释放预留，已发布但结算失败时保守中止',async t=>{
 const env=await setup(Error('child result unavailable'));t.after(()=>env.ctx.fiber.dispose())
 const result=await env.call('失败子任务','测试失败回收','call-failure')
 assert.equal(result.isError,true)
 const abandoned=env.records.filter(item=>item.kind==='abandon').map(item=>item.input)
 assert.equal(abandoned.length,1)
 assert.deepEqual((abandoned[0] as {childSessionId:string;depth:number;stopReason:string}),{reservationId:(abandoned[0] as {reservationId:string}).reservationId,childSessionId:'child_1',depth:1,stopReason:'tool-settlement-failed'})
 assert.match((abandoned[0] as {reservationId:string}).reservationId,/^call:[a-f0-9]{64}$/)
})

test('子 Agent 异常结束不向父会话回显非可信诊断内容',async t=>{
 const env=await setup({stopReason:'error',output:[],diagnostic:'private child diagnostic <script>alert(1)</script>'});t.after(()=>env.ctx.fiber.dispose())
 const result=await env.call('失败子任务','验证错误边界','call-diagnostic')
 assert.equal(result.isError,true)
 assert.match(JSON.stringify(result),/子 Agent 执行失败/)
 assert.doesNotMatch(JSON.stringify(result),/private child diagnostic|<script>/)
})

test('Run 身份读取期间取消时不创建预留或启动子 Agent',async t=>{
 let entered!:()=>void,continueRun!:()=>void
 const readStarted=new Promise<void>(resolve=>{entered=resolve}),continueReading=new Promise<void>(resolve=>{continueRun=resolve})
 const env=await setup(undefined,undefined,{runId:async()=>{entered();await continueReading;return 'a44f511d-436e-4feb-ae3f-0468dc0df10d'}});t.after(()=>env.ctx.fiber.dispose())
 const controller=new AbortController(),pending=env.call('取消子任务','验证预留前取消','call-cancel-before-reserve',controller.signal)
 await readStarted
 controller.abort()
 continueRun()
 const result=await pending
 assert.equal(result.isError,true)
 assert.equal(env.records.filter(item=>item.kind==='reserve').length,0)
 assert.equal(env.calls.length,0)
})

test('子会话结束时记录令牌估算快照，计量不可用不改变结项路径',async t=>{
 const env=await setup(undefined,321);t.after(()=>env.ctx.fiber.dispose())
 const result=await env.call('计量子任务','测试结束令牌估算','call-meter')
 assert.equal(result.isError,false)
 assert.deepEqual(env.records.filter(item=>item.kind==='settle').map(item=>item.input),[{childSessionId:'child_1',stopReason:'completed',tokenEstimate:321}])
})

test('子会话清理失败不覆盖已结算的任务结果',async t=>{
 const env=await setup(undefined,undefined,{},async()=>{throw Error('child cleanup failed')});t.after(()=>env.ctx.fiber.dispose())
 const result=await env.call('清理失败','验证结算结果','call-dispose-failure')
 assert.equal(result.isError,false)
 assert.equal(env.disposeCount(),1)
 assert.deepEqual(env.records.filter(item=>item.kind==='settle').map(item=>item.input),[{childSessionId:'child_1',stopReason:'completed'}])
})
