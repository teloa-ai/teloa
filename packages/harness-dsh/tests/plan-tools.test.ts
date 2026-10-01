import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {registerPlanTools,type PlanToolsPorts} from '../src/plan-tools.ts'

const owner='local:teloa-owner'
const planId='11111111-1111-4111-8111-111111111111'
const roleId='22222222-2222-4222-8222-222222222222'
const stored={id:planId,ownerId:owner,title:'每日核对',goal:'核对变化。',scope:'SOC',dataScope:'已授权资料。',delivery:'变化清单。',notificationPolicy:'attention',roleId,roleVersion:3,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:30',timezone:'Asia/Singapore'},source:{kind:'manual'},version:1,configVersion:1,state:'paused',archivedReason:null,archivedAt:null,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z'}
const require=createRequire(import.meta.url)
async function nativeApprovalService(){
 const fromTools=createRequire(require.resolve('@deepseek-ai/dsh-tools'))
 return (await import(fromTools.resolve('@deepseek-ai/dsh-user-approval'))).ApprovalService
}

async function setup(overrides:Partial<PlanToolsPorts>={},subagent=false){
 const ctx=new Context()
 await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const sessionId=SessionId(subagent?'plan-subagent':'plan-ordinary')
 const {agent}=await ctx.agents.create({sessionId,...(subagent?{meta:{origin:'subagent' as const,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 const calls:unknown[][]=[]
 const ports:PlanToolsPorts={
  owner,
  conversation:async id=>({ownerId:owner,sessionId:id,status:'ready'}),
  readTaskPolicy:async()=>null,
  planHandler:async(endpoint,payload)=>{calls.push([endpoint,payload]);return endpoint==='plans/list'?[stored]:endpoint==='plans/get'?stored:endpoint==='plans/create'?stored:{...stored,version:2,state:'active',updatedAt:'2026-09-12T00:01:00.000Z'}},
  scheduleHandler:async(_endpoint,payload)=>{calls.push(['plans/executions',payload]);return {items:[],errors:[]}},
  roles:{list:async(actor,input)=>{calls.push(['roles/list',actor,input]);return [{id:roleId,ownerId:owner,version:3,state:'active',name:'SOC 分析员',kind:'employee',scopes:['SOC'],duty:'核对',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z'}]}},
  now:()=> '2026-09-12T01:02:03.000Z',timezone:()=> 'Asia/Singapore',...overrides,
 }
 registerPlanTools(ctx,ports)
 let seq=0
 const call=(name:string,args:Record<string,unknown>={},callId?:string)=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId??'plan-'+ ++seq),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,calls,call}
}
const value=(result:Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['call']>>)=>JSON.parse(result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n'))

test('七个工具通过真实 ToolRuntime 注册，目录只列本人在岗数字员工且保留跨业务 scope',async t=>{
 const env=await setup();t.after(()=>env.ctx.fiber.dispose())
 assert.deepEqual(env.ctx.tools.schemas(env.agent).map(tool=>tool.name).filter(name=>name.startsWith('teloa_plans_')).sort(),['teloa_plans_change','teloa_plans_create','teloa_plans_directory','teloa_plans_get','teloa_plans_history','teloa_plans_list','teloa_plans_update'])
 const result=await env.call('teloa_plans_directory')
 assert.equal(result.isError,false)
 assert.deepEqual(value(result),{observedAt:'2026-09-12T01:02:03.000Z',defaultTimezone:'Asia/Singapore',roles:[{id:roleId,version:3,name:'SOC 分析员',scopes:['SOC']}]})
 assert.deepEqual(env.calls,[['roles/list',owner,{}]])
 const malformed=await setup({roles:{list:async()=>[{id:roleId,ownerId:owner,version:3,state:['paused'],name:'坏岗位',kind:'employee',scopes:['SOC'],duty:'核对',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:00.000Z'}]}});t.after(()=>malformed.ctx.fiber.dispose())
 assert.equal((await malformed.call('teloa_plans_directory')).isError,true)
})

test('根输入拒绝身份与未知字段，创建固定 manual 来源并用调用身份生成稳定 requestId',async t=>{
 const env=await setup();t.after(()=>env.ctx.fiber.dispose())
 const invalidCases:[string,Record<string,unknown>][]= [['teloa_plans_list',{ownerId:owner}],['teloa_plans_get',{planId,extra:true}],['teloa_plans_create',{ownerId:owner}],['teloa_plans_change',{planId,expectedVersion:1,action:'pause',requestId:planId}]]
 for(const [name,args] of invalidCases) {
  assert.equal((await env.call(name,args)).isError,true)
 }
 const input={title:'每日核对',goal:'核对变化。',scope:'SOC',dataScope:'已授权资料。',delivery:'变化清单。',notificationPolicy:'attention',roleId,expectedRoleVersion:3,cadence:'daily',weekday:1,time:'09:30',timezone:'Asia/Singapore'}
 assert.equal((await env.call('teloa_plans_create',input,'same-create')).isError,false)
 assert.equal((await env.call('teloa_plans_create',input,'same-create')).isError,false)
 const writes=env.calls.filter(row=>row[0]==='plans/create') as [string,{requestId:string;source:unknown;fields:{notificationPolicy:string}}][]
 assert.equal(writes.length,2);assert.match(writes[0]![1].requestId,/^[a-f0-9-]{36}$/);assert.equal(writes[0]![1].requestId,writes[1]![1].requestId);assert.deepEqual(writes[0]![1].source,{kind:'manual'});assert.equal(writes[0]![1].fields.notificationPolicy,'attention')
 assert.equal((await env.call('teloa_plans_create',{...input,notificationPolicy:'unknown'})).isError,true)
})

test('绑定、原生身份和历史任务策略在前置与工具正文双重拒绝且错误脱敏',async t=>{
 for(const overrides of [
  {conversation:async(id:string)=>({ownerId:'other',sessionId:id,status:'ready' as const})},
  {conversation:async(id:string)=>({ownerId:owner,sessionId:id,status:'pending' as const})},
  {readTaskPolicy:async()=>({allowedTools:[],nativeRequestId:'old-run'})},
 ]){
  const env=await setup(overrides);t.after(()=>env.ctx.fiber.dispose());assert.equal((await env.call('teloa_plans_list')).isError,true);assert.equal(env.calls.length,0)
 }
 const child=await setup({},true);t.after(()=>child.ctx.fiber.dispose());assert.equal((await child.call('teloa_plans_list')).isError,true);assert.equal(child.calls.length,0)
 const privateFailure=await setup({conversation:async()=>{throw Error('postgres password=private')}});t.after(()=>privateFailure.ctx.fiber.dispose())
 const failed=await privateFailure.call('teloa_plans_list');assert.equal(failed.isError,true);assert.ok(!JSON.stringify(failed).includes('password=private'))
})

test('原生 deny/ask 被保留，enable和archive从allow提升ask，无审批时不执行，批准后正文重新核对',async t=>{
 const denied=await setup();t.after(()=>denied.ctx.fiber.dispose())
 denied.ctx.on('tools/pre-execute',async(_exec,_next)=>({kind:'deny',reason:'已有策略拒绝'}))
 assert.equal((await denied.call('teloa_plans_change',{planId,expectedVersion:1,action:'pause'})).isError,true);assert.equal(denied.calls.length,0)

 const noApproval=await setup();t.after(()=>noApproval.ctx.fiber.dispose())
 assert.equal((await noApproval.call('teloa_plans_change',{planId,expectedVersion:1,action:'enable'})).isError,true);assert.equal(noApproval.calls.some(row=>row[0]==='plans/change'),false)

 let ready=true
 const approved=await setup({conversation:async id=>({ownerId:owner,sessionId:id,status:ready?'ready':'pending'})});t.after(()=>approved.ctx.fiber.dispose())
 approved.ctx.provide('approval',{request:async()=>{ready=false;return 'allowed-once'}})
 assert.equal((await approved.call('teloa_plans_change',{planId,expectedVersion:1,action:'archive',note:'结束'})).isError,true);assert.equal(approved.calls.some(row=>row[0]==='plans/change'),false)

 let taskPolicy:null|{allowedTools:string[];nativeRequestId:string}=null
 const taskChanged=await setup({readTaskPolicy:async()=>taskPolicy});t.after(()=>taskChanged.ctx.fiber.dispose())
 taskChanged.ctx.provide('approval',{request:async()=>{taskPolicy={allowedTools:[],nativeRequestId:'new-task-run'};return 'allowed-once'}})
 assert.equal((await taskChanged.call('teloa_plans_change',{planId,expectedVersion:1,action:'enable'})).isError,true);assert.equal(taskChanged.calls.some(row=>row[0]==='plans/change'),false)

 const existingAsk=await setup();t.after(()=>existingAsk.ctx.fiber.dispose())
 existingAsk.ctx.on('tools/pre-execute',async(_exec,_next)=>({kind:'ask',reason:'已有确认'}))
 assert.equal((await existingAsk.call('teloa_plans_list')).isError,true);assert.equal(existingAsk.calls.length,0)

 let reason=''
 const success=await setup();t.after(()=>success.ctx.fiber.dispose())
 success.ctx.provide('approval',{request:async(input:{reason?:string})=>{reason=input.reason??'';return 'allowed-once'}})
 assert.equal((await success.call('teloa_plans_change',{planId,expectedVersion:99,action:'enable'})).isError,false)
 assert.match(reason,/每日核对/);assert.match(reason,/每天/);assert.match(reason,/09:30/);assert.match(reason,/Asia\/Singapore/)
 assert.equal(success.calls.some(row=>row[0]==='plans/change'),true)
})

test('update需要本人确认，传递双版本与固定定义字段',async t=>{
 const env=await setup();t.after(()=>env.ctx.fiber.dispose())
 let reason='';env.ctx.provide('approval',{request:async(input:{reason?:string})=>{reason=input.reason??'';return 'allowed-once'}})
 const input={planId,expectedVersion:1,expectedConfigVersion:1,title:'每周核对',goal:'核对本周资料。',dataScope:'本周资料。',delivery:'本周变化。',notificationPolicy:'failure',cadence:'weekly',weekday:5,time:'10:30',timezone:'Asia/Singapore'}
 assert.equal((await env.call('teloa_plans_update',input)).isError,false)
 assert.match(reason,/更新持续计划/)
 const write=env.calls.find(row=>row[0]==='plans/change')?.[1] as Record<string,unknown>
 assert.deepEqual(write,{planId,expectedVersion:1,expectedConfigVersion:1,requestId:write.requestId,action:'update',fields:{title:input.title,goal:input.goal,dataScope:input.dataScope,delivery:input.delivery,notificationPolicy:input.notificationPolicy,trigger:{kind:'schedule',cadence:'weekly',weekday:5,time:'10:30',timezone:'Asia/Singapore'}}})
 assert.equal((await env.call('teloa_plans_update',{...input,scope:'SOC'})).isError,true)
})

test('list/get/history/change传给既有 handler，history分页和change动作只接受精确字段',async t=>{
 const env=await setup();t.after(()=>env.ctx.fiber.dispose())
 assert.equal((await env.call('teloa_plans_list')).isError,false)
 assert.equal((await env.call('teloa_plans_get',{planId})).isError,false)
 assert.equal((await env.call('teloa_plans_history',{planId,limit:20,cursor:{claimedAt:'2026-09-12T00:00:00.000Z',claimId:'33333333-3333-4333-8333-333333333333'}})).isError,false)
 assert.equal((await env.call('teloa_plans_change',{planId,expectedVersion:1,action:'pause'})).isError,false)
 assert.deepEqual(env.calls.map(row=>row[0]),['plans/list','plans/get','plans/executions','plans/change'])
})

test('真实 ApprovalService 对never、无answerer和allowed-once分别拒绝、拒绝和放行',async t=>{
 const ApprovalService=await nativeApprovalService()
 const never=await setup();t.after(()=>never.ctx.fiber.dispose());await never.ctx.plugin(ApprovalService,{policy:'never'});never.agent.session.append('turn/start',{turn:0})
 assert.equal((await never.call('teloa_plans_change',{planId,expectedVersion:1,action:'enable'})).isError,true);assert.equal(never.calls.some(row=>row[0]==='plans/change'),false)

 const unavailable=await setup();t.after(()=>unavailable.ctx.fiber.dispose());await unavailable.ctx.plugin(ApprovalService,{policy:'ask'});unavailable.agent.session.append('turn/start',{turn:0})
 assert.equal((await unavailable.call('teloa_plans_change',{planId,expectedVersion:1,action:'enable'})).isError,true);assert.equal(unavailable.calls.some(row=>row[0]==='plans/change'),false)

 const allowed=await setup();t.after(()=>allowed.ctx.fiber.dispose());await allowed.ctx.plugin(ApprovalService,{policy:'ask'});allowed.ctx.on('approval/request' as never,(async()=> 'allowed-once') as never);allowed.agent.session.append('turn/start',{turn:0})
 assert.equal((await allowed.call('teloa_plans_change',{planId,expectedVersion:1,action:'enable'})).isError,false);assert.equal(allowed.calls.some(row=>row[0]==='plans/change'),true)
 const audit=allowed.agent.session.snapshotEvents().filter(event=>(event.type as string).startsWith('approval/')).map(event=>({type:event.type,data:event.data}))
 assert.deepEqual(audit.map(event=>event.type),['approval/asked','approval/decided']);assert.equal((audit[1]!.data as {outcome:string}).outcome,'allowed-once')
})
