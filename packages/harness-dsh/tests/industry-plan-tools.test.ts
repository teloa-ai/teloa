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
import {WorkError} from '@teloa/contract'
import {registerIndustryPlanTools,type IndustryPlanToolsPorts,industryPlanToolNames} from '../src/industry-plan-tools.ts'
import {createIndustryPlansHandler} from '../src/industry-plans.ts'
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

test('来源只读工具经正式 handler 返回固定来源或 null，坏回包与存储故障不能冒充空来源',async t=>{
 // 仅替代底层来源服务；实际官方 ToolRuntime、管理身份闸和正式 handler 均参与。
 // 来源快照的 PG 持久化/摘要验证沿用 backend/tests/industry-plans.test.ts，不在此重建数据库。
 const loadId='22345678-1234-4234-8234-123456789012',itemInstanceId='32345678-1234-4234-8234-123456789012',roleId='42345678-1234-4234-8234-123456789012'
 const trigger={kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}
 const work={loadId,itemInstanceId:roleId,itemLocalId:'research',contentId:id,contentHash:'a'.repeat(64),templateId:'research',templateVersion:'1.0.0',fileHash:'b'.repeat(64),title:'资料核对',method:'核对固定来源',requirements:['获准资料'],output:'简报',skills:[],scope:'general'}
 const source={loadId,itemInstanceId,itemLocalId:'daily',contentId:id,contentHash:'a'.repeat(64),planVersion:'1.0.0',planFileHash:'c'.repeat(64),title:'每日核对',work,dataScope:'获准资料',trigger,scope:'general',planId:id,ownerId:'owner',requestId:id,goal:'核对',delivery:'摘要',notificationPolicy:'silent',selectedTrigger:{...trigger,time:'10:00'},createdRole:{roleId,roleVersion:2},createdAt:'2026-09-12T00:00:00.000Z'}
 let value:unknown=source,unrelatedCalls=0
 const reads:unknown[][]=[],unused=async():Promise<never>=>{unrelatedCalls++;throw Error('来源读取不能调用预览、创建或其他目录')}
 const handler=createIndustryPlansHandler('owner',async()=>({preview:unused,create:unused,list:unused,source:async(owner,payload)=>{reads.push([owner,payload]);if(value instanceof Error)throw value;return value}}))
 const e=await setup({handler});t.after(()=>e.ctx.fiber.dispose())
 const before=e.agent.session.snapshotEvents().length
 const found=await e.call('teloa_industry_plans_source',{planId:id})
 assert.equal(found.isError,false,JSON.stringify(found));assert.deepEqual(JSON.parse(found.value as string),source)
 assert.deepEqual(reads,[['owner',{planId:id}]],'来源主体由正式 handler 固定，工具仅传计划身份')
 value=null
 const plain=await e.call('teloa_industry_plans_source',{planId:id})
 assert.equal(plain.isError,false,JSON.stringify(plain));assert.equal(JSON.parse(plain.value as string),null)
 for(const invalid of [{...source,ownerId:'other'},{...source,planId:roleId},new WorkError('teloa/storage-unavailable','合成存储暂不可用')]){
  value=invalid
  const result=await e.call('teloa_industry_plans_source',{planId:id})
  assert.equal(result.isError,true,JSON.stringify(result));assert.notEqual(result.value,'null')
  if(invalid instanceof WorkError)assert.match(JSON.stringify(result),/合成存储暂不可用/)
 }
 assert.equal(unrelatedCalls,0);assert.equal(e.agent.session.snapshotEvents().length,before,'只读工具不新增用户任务或原生会话事件')
})

test('来源工具的非法参数及跨本人/受管会话在触达正式服务前拒绝',async t=>{
 let reads=0
 const unused=async():Promise<never>=>{throw Error('不得调用其他行业计划操作')}
 const handler=createIndustryPlansHandler('owner',async()=>({preview:unused,create:unused,list:unused,source:async()=>{reads++;return null}}))
 const e=await setup({handler});t.after(()=>e.ctx.fiber.dispose())
 for(const args of [{planId:id,ownerId:'other'},{planId:id,scope:'general'},{planId:'not-a-plan'}])assert.equal((await e.call('teloa_industry_plans_source',args)).isError,true)
 for(const [ports,subagent] of [[{},true],[{readTaskPolicy:async()=>({allowedTools:[],nativeRequestId:id})},false],[{conversation:async(sessionId:string)=>({ownerId:'other',sessionId,status:'ready' as const})},false]] as const){
  const denied=await setup({...ports,handler},subagent);t.after(()=>denied.ctx.fiber.dispose())
  assert.equal((await denied.call('teloa_industry_plans_source',{planId:id})).isError,true)
 }
 assert.equal(reads,0,'身份或参数拒绝不能查询来源服务')
})

test('AD02-DST：行业计划真实工具schema允许纽约，创建仍暂停且不扩大来源',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const result=await e.call('teloa_industry_plans_create',{...input,timezone:'America/New_York'})
 assert.equal(result.isError,false,JSON.stringify(result));assert.equal(e.calls.length,1)
 const [method,payload]=e.calls[0] as [string,{trigger:{timezone:string}}]
 assert.equal(method,'industry-plans/create');assert.equal(payload.trigger.timezone,'America/New_York')
})
