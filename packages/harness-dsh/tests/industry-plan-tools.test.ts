import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {registerIndustryPlanTools,type IndustryPlanToolsPorts,industryPlanToolNames} from '../src/industry-plan-tools.ts'
const id='12345678-1234-4234-8234-123456789012'
async function setup(overrides:Partial<IndustryPlanToolsPorts>={},subagent=false){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('industry-plan-test'),...(subagent?{meta:{origin:'subagent' as const,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}}),calls:unknown[][]=[]
 registerIndustryPlanTools(ctx,{owner:'owner',conversation:async sessionId=>({ownerId:'owner',sessionId,status:'ready'}),readTaskPolicy:async()=>null,directory:async()=>({items:[]}),handler:async(method,payload)=>{calls.push([method,payload]);return {plan:{id,state:'paused'}}},...overrides})
 const call=(name:string,args:Record<string,unknown>={},callId='call')=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,calls,call}
}
const input={loadId:id,itemInstanceId:id,goal:'每日核对',delivery:'简报',notificationPolicy:'silent',roleId:id,expectedRoleVersion:2,cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}
test('行业计划通过原生工具调用同一服务，调用身份固定请求且无自动启用',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose());assert.deepEqual(e.ctx.tools.schemas(e.agent).map(t=>t.name).filter(n=>n.startsWith('teloa_industry_')).sort(),[...industryPlanToolNames].sort())
 assert.equal((await e.call('teloa_industry_plans_directory')).isError,false)
 assert.equal((await e.call('teloa_industry_plans_preview',{loadId:id,itemInstanceId:id})).isError,false)
 assert.equal((await e.call('teloa_industry_plans_create',input)).isError,false)
 assert.equal((await e.call('teloa_industry_plans_create',input)).isError,false)
 assert.deepEqual(e.calls[1],e.calls[2]);const [method,payload]=e.calls[1] as [string,Record<string,unknown>];assert.equal(method,'industry-plans/create');assert.match(String(payload.requestId),/^[a-f0-9-]{36}$/);assert.equal(payload.notificationPolicy,'silent');assert.deepEqual(payload.trigger,{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'});assert.equal(Object.hasOwn(payload,'source'),false);assert.equal(e.calls.some(c=>c[0]==='plans/change'),false)
 assert.equal((await e.call('teloa_industry_plans_create',{...input,scope:'general'})).isError,true)
 assert.equal((await e.call('teloa_industry_plans_create',{...input,requestId:id})).isError,true)
 const {notificationPolicy:_,...missing}=input
 assert.equal((await e.call('teloa_industry_plans_create',missing)).isError,true)
 assert.equal((await e.call('teloa_industry_plans_create',{...input,notificationPolicy:'unexpected'})).isError,true)
})
test('行业计划工具拒绝子agent、执行会话和跨本人身份，正文仍复核',async t=>{
 for(const [ports,subagent] of [[{},true],[{readTaskPolicy:async()=>({allowedTools:[],nativeRequestId:id})},false],[{conversation:async(sessionId:string)=>({ownerId:'other',sessionId,status:'ready' as const})},false]] as const){const e=await setup(ports,subagent);t.after(()=>e.ctx.fiber.dispose());assert.equal((await e.call('teloa_industry_plans_create',input)).isError,true);assert.equal(e.calls.length,0)}
 let checks=0;const e=await setup({readTaskPolicy:async()=>++checks===1?null:{allowedTools:[],nativeRequestId:id}});t.after(()=>e.ctx.fiber.dispose());assert.equal((await e.call('teloa_industry_plans_create',input)).isError,true);assert.equal(e.calls.length,0)
})
