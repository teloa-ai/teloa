import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import type {TaskToolArgumentRule} from '../src/task-tool-arguments.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import type {SubagentDelegationPorts} from '../src/subagent-delegation.ts'
import {conversationDelegationTools,externalEgressTools,mcpResourceTools,orchestrationTools,roleGrantToolNames,subagentTaskToolName} from '../src/role-tool-grants.ts'
import {roleDailyDigestToolNames} from '../src/role-daily-log.ts'
import {roleMemoryProposalToolName} from '../src/role-memory.ts'
import {registerMarketSessionTools,marketSessionToolNames} from '../src/market-session-tools.ts'
import {selfAuthorizedToolNames} from '../src/self-authorized-tools.ts'
import {子Agent执行态事件流} from './fixtures/子Agent执行态/事件流.ts'

test('官方后台续轮保留原授权，停止立即拒绝自授权工具，后续人类请求不继承',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('background-guard'),agentOptions:{provider:'test',model:'test'}})
 let stopRequested=false,bodies=0,seq=0
 for(const name of ['read_evidence','self_tool'])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 registerTaskToolGuard(ctx,async()=>({allowedTools:stopRequested?[]:['read_evidence'],nativeRequestId:'owned',stopRequested}),['self_tool'])
 const call=(name='read_evidence')=>ctx.tools.execute({agent,name,arguments:{},callId:ToolCallId('background-'+ ++seq),signal:AbortSignal.timeout(5000)})
 agent.session.append('turn/start',{turn:0})
 agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>('owned')}}),{surfaceOp:'append'})
 agent.session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 agent.session.append('turn/start',{turn:1})
 agent.session.append('user/message',createUserMessage({content:[],source:{kind:'tool-jobs',form:'notice',summary:'finished'}}),{surfaceOp:'append'})
 assert.equal((await call()).isError,false)
 stopRequested=true
 assert.match(JSON.stringify(await call('self_tool')),/已请求停止/)
 stopRequested=false
 agent.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 agent.session.append('turn/start',{turn:2})
 agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>('unrelated')}}),{surfaceOp:'append'})
 assert.equal((await call()).isError,true)
 assert.equal(bodies,1)
})

for(const caller of ['root','child'] as const)test(`真实原生请求核验：${caller} 调用只受策略根会话的轮次约束`,async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent:parent}=await ctx.agents.create({sessionId:SessionId('native-parent'),agentOptions:{provider:'test',model:'test'}})
 const {agent:child}=await ctx.agents.create({sessionId:SessionId('native-child'),meta:{origin:'subagent',parentSession:parent.session.id,delegationDepth:1},agentOptions:{provider:'test',model:'test'}})
 const agent=caller==='root'?parent:child,nativeRequestId=子Agent执行态事件流.nativeRequestId,readIds:string[]=[]
 let bodies=0,seq=0
 for(const name of ['read_evidence','write_action'])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 registerTaskToolGuard(ctx,async sessionId=>{readIds.push(sessionId);return {allowedTools:['read_evidence'],nativeRequestId,argumentRules:[{name:'read_evidence',allowed:[{id:'known',version:'v1'}]}]}})
 const call=(name='read_evidence',args:Record<string,unknown>={id:'known',version:'v1'})=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId('native-'+ ++seq),signal:AbortSignal.timeout(5000)})
 const childMessage=()=>child.session.append(子Agent执行态事件流.子会话.driverMessage.type,子Agent执行态事件流.子会话.driverMessage.data,{surfaceOp:子Agent执行态事件流.子会话.driverMessage.surfaceOp})
 child.session.append(子Agent执行态事件流.子会话.turnStart.type,子Agent执行态事件流.子会话.turnStart.data);childMessage()
 assert.match(JSON.stringify(await call()),/当前工具调用不属于获准执行的原生轮次/)
 parent.session.append(子Agent执行态事件流.父会话.turnStart.type,子Agent执行态事件流.父会话.turnStart.data)
 parent.session.append(子Agent执行态事件流.父会话.request.type,子Agent执行态事件流.父会话.request.data,{surfaceOp:子Agent执行态事件流.父会话.request.surfaceOp})
 assert.equal((await call()).isError,false)
 childMessage();childMessage();assert.equal((await call()).isError,false)
 assert.match(JSON.stringify(await call('write_action')),/当前任务未授权使用此工具/)
 assert.match(JSON.stringify(await call('read_evidence',{id:'known',version:'v2'})),/工具参数超出本次任务授权的数据范围或版本/)
 parent.session.append(子Agent执行态事件流.父会话.otherRequest.type,子Agent执行态事件流.父会话.otherRequest.data,{surfaceOp:子Agent执行态事件流.父会话.otherRequest.surfaceOp})
 assert.match(JSON.stringify(await call()),/本轮混入其他请求/)
 childMessage();assert.match(JSON.stringify(await call()),/本轮混入其他请求/)
 parent.session.append(子Agent执行态事件流.父会话.turnEnd.type,子Agent执行态事件流.父会话.turnEnd.data)
 assert.match(JSON.stringify(await call()),/当前工具调用不属于获准执行的原生轮次/)
 childMessage();assert.match(JSON.stringify(await call()),/当前工具调用不属于获准执行的原生轮次/)
 assert.equal(bodies,2);assert.ok(readIds.length>0&&readIds.every(id=>id===parent.session.id))
})

test('真实工具运行器在调用前拦截未授权工具，普通会话及原生守卫保留',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('guard-task'),agentOptions:{provider:'test',model:'test'}})
 let bodies=0,policy:'ordinary'|'read'|'paused'|'error'='read',nativeDeny=false
 let argumentRules:TaskToolArgumentRule[]|undefined
 let nativeRequestId:string|undefined
 for(const name of ['read_evidence','write_action'])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 registerTaskToolGuard(ctx,async sessionId=>{assert.equal(sessionId,agent.session.id);if(policy==='error')throw Error('private database detail');return policy==='ordinary'?null:{allowedTools:policy==='read'?['read_evidence']:[],...(argumentRules?{argumentRules}:{}),...(nativeRequestId===undefined?{}:{nativeRequestId})}})
 ctx.on('tools/pre-execute',async(_exec,next)=>nativeDeny?{kind:'deny',reason:'原生守卫拒绝'}:next())
 let seq=0
 const call=(name:string,args:Record<string,unknown>={})=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId('guard-'+ ++seq),signal:AbortSignal.timeout(5000)})
 assert.equal((await call('write_action')).isError,true);assert.equal(bodies,0)
 argumentRules=[{name:'read_evidence',allowed:[{id:'known',version:'v1'}]}]
 assert.equal((await call('read_evidence',{id:'other',version:'v1'})).isError,true);assert.equal(bodies,0)
 assert.equal((await call('read_evidence',{id:'known',version:'v2'})).isError,true);assert.equal(bodies,0)
 assert.equal((await call('read_evidence',{id:'known',version:'v1'})).isError,false);assert.equal(bodies,1)
 argumentRules=undefined
 nativeDeny=true;assert.equal((await call('read_evidence')).isError,true);assert.equal(bodies,1);nativeDeny=false
 policy='paused';assert.equal((await call('read_evidence')).isError,true);assert.equal(bodies,1)
 policy='error';const failed=await call('read_evidence');assert.equal(failed.isError,true);assert.equal(bodies,1);assert.ok(!JSON.stringify(failed).includes('private database detail'))
 policy='ordinary';assert.equal((await call('write_action')).isError,false);assert.equal(bodies,2)
 policy='read';nativeRequestId='owned-request'
 assert.equal((await call('read_evidence')).isError,true);assert.equal(bodies,2)
 agent.session.append('turn/start',{turn:0})
 agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>(nativeRequestId)}}),{surfaceOp:'append'})
 assert.equal((await call('read_evidence')).isError,false);assert.equal(bodies,3)
 agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>('queued-other-request')}}),{surfaceOp:'append'})
 assert.equal((await call('read_evidence')).isError,true);assert.equal(bodies,3)
 agent.session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 agent.session.append('turn/start',{turn:1})
 agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>('other-request')}}),{surfaceOp:'append'})
 assert.equal((await call('read_evidence')).isError,true);assert.equal(bodies,3)
 agent.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
})

test('preset 可发现性和子 Agent 都不能扩大父 Run 的工具与资料访问上限',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent:parent}=await ctx.agents.create({sessionId:SessionId('guard-parent'),agentOptions:{provider:'test',model:'test'}})
 const {agent:child}=await ctx.agents.create({sessionId:SessionId('guard-child'),meta:{origin:'subagent',parentSession:parent.session.id,delegationDepth:1},agentOptions:{provider:'test',model:'test'}})
 let bodies=0;for(const name of ['read_evidence','write_action','preset_write_action','read_all_work_resources'])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 const readIds:string[]=[]
 registerTaskToolGuard(ctx,async sessionId=>{readIds.push(sessionId);return sessionId===parent.session.id?{allowedTools:['read_evidence']}:{allowedTools:['read_evidence','write_action']}})
 const call=(name:string)=>ctx.tools.execute({agent:child,name,arguments:{},callId:ToolCallId('child-'+name),signal:AbortSignal.timeout(5000)})
 assert.equal((await call('read_evidence')).isError,false);assert.equal(bodies,1)
 assert.equal((await call('write_action')).isError,true);assert.equal(bodies,1)
 assert.equal((await call('preset_write_action')).isError,true);assert.equal(bodies,1)
 assert.equal((await call('read_all_work_resources')).isError,true);assert.equal(bodies,1)
 assert.deepEqual(readIds,[parent.session.id,parent.session.id,parent.session.id,parent.session.id])
})

test('MCP 资源工具在普通会话被拒，只有岗位授权清单列出的会话可用',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('guard-mcp'),agentOptions:{provider:'test',model:'test'}})
 let bodies=0,policy:'ordinary'|'denied'|'granted'='ordinary'
 for(const name of ['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 registerTaskToolGuard(ctx,async()=>policy==='ordinary'?null:{allowedTools:policy==='granted'?['read_mcp_resource']:['read_evidence']})
 let seq=0
 const call=(name:string)=>ctx.tools.execute({agent,name,arguments:{},callId:ToolCallId('mcp-'+ ++seq),signal:AbortSignal.timeout(5000)})
 for(const name of ['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource']){
  policy='ordinary';assert.equal((await call(name)).isError,true)
  policy='denied';assert.equal((await call(name)).isError,true)
 }
 assert.equal(bodies,0)
 policy='granted'
 assert.equal((await call('read_mcp_resource')).isError,false);assert.equal(bodies,1)
 assert.equal((await call('list_mcp_resources')).isError,true);assert.equal(bodies,1)
})

test('任务会话调用八个会话内安装工具一律被守卫固定句拒绝；把工具名写进 allowedTools 也过不了本模块的任务会话闸',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('guard-market-session'),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:0})
 agent.session.append('user/message',createUserMessage({content:[{type:'text',text:'帮我装一个整理 PDF 的技能'}],source:{kind:'user',rpcId:brandString<SessionRequestId>('task-turn')}}),{surfaceOp:'append'})
 let allowed:readonly string[]=['web_fetch'],ports=0
 const policy=async()=>({allowedTools:allowed,nativeRequestId:'task-turn'})
 const port=async()=>{ports++;throw Error('任务会话不应触达任何端口')}
 // 与 index.ts 同序：守卫先挂，会话内安装模块后挂；守卫按 allowedTools 先拒，放行了工具名时本模块再拒
 registerTaskToolGuard(ctx,policy,[...selfAuthorizedToolNames])
 registerMarketSessionTools(ctx,{owner:'local:owner',conversation:async sessionId=>({ownerId:'local:owner',sessionId,status:'ready'}),readTaskPolicy:policy,catalog:port,github:port,content:port,skills:port,mcp:port,connectorEntry:()=>undefined,skillSecrets:()=>[],skillSecretMeta:()=>({}),skillSecretGroupMembers:()=>[],industryLoads:port,industryPrepare:port,currentSpace:async()=>({id:'33333333-3333-4333-8333-333333333333',name:'空间',version:1}),bundledExtensions:port,localModels:{pullFacts:port,startPull:port}})
 const args:Record<string,Record<string,unknown>>={teloa_model_prepare:{entryId:'teloa.model.local.qwen3'},teloa_market_search:{query:'pdf'},teloa_market_resolve:{reference:'acme.pdf-tools'},teloa_market_add:{candidate:{kind:'catalog',entryId:'acme.pdf-tools'},expectedFingerprint:'1'.repeat(64)},teloa_mcp_connect:{catalogId:'teloa.mcp-deepwiki'},teloa_industry_load:{contentId:'44444444-4444-4444-8444-444444444444',expectedContentHash:'c'.repeat(64)},teloa_industry_readiness:{load:'安全运营'},teloa_industry_prepare:{loadId:'77777777-7777-4777-8777-777777777777',expectedDigest:'9'.repeat(64)}}
 let seq=0
 const call=(name:string)=>ctx.tools.execute({agent,name,arguments:args[name]!,callId:ToolCallId('market-'+ ++seq),signal:AbortSignal.timeout(5000)})
 for(const name of marketSessionToolNames)assert.match(JSON.stringify(await call(name)),/当前任务未授权使用此工具，请核对员工执行范围。/,name)
 allowed=[...marketSessionToolNames]
 for(const name of marketSessionToolNames){const result=await call(name);assert.equal(result.isError,true,name);assert.match(JSON.stringify(result),/任务执行会话及其历史会话不能执行会话内安装/,name)}
 assert.equal(ports,0)
})

test('自授权工具集不得含 MCP 资源工具，装配期即拒绝',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 // 自授权分支排在资源工具闸之前，若把资源工具放进自授权集就会绕过默认拒绝，故装配期直接报错。
 for(const name of mcpResourceTools)assert.throws(()=>registerTaskToolGuard(ctx,async()=>null,[name]),/自授权工具不能包含 MCP 资源工具/)
 registerTaskToolGuard(ctx,async()=>null,['role_memory_proposal'])
})

test('自授权工具集不得含技能代发工具，装配期即拒绝（只能由本人按岗位授予，规格 2026-09-27 §5.1）',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 assert.throws(()=>registerTaskToolGuard(ctx,async()=>null,['teloa_skill_http']),/自授权工具不能包含技能代发工具/)
 registerTaskToolGuard(ctx,async()=>null,['role_memory_proposal'])
})

test('技能代发在执行态按已勾选技能过闸（审查修复 R1 M-1）：参数不按整组逐字比对，只认 skill 在授权记录里',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('skill-http-guard'),agentOptions:{provider:'test',model:'test'}})
 let bodies=0,seq=0
 ctx.tools.register(defineTool({name:'teloa_skill_http',description:'probe',parameters:{skill:{type:'string',required:true},method:{type:'string',required:true},url:{type:'string',required:true}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 registerTaskToolGuard(ctx,async()=>({allowedTools:['teloa_skill_http'],argumentRules:[{name:'teloa_skill_http',allowed:[{skill:'x-search'}]}]}))
 const call=(skill:string)=>ctx.tools.execute({agent,name:'teloa_skill_http',arguments:{skill,method:'GET',url:'https://api.x.ai/v1/x'},callId:ToolCallId('skill-http-'+ ++seq),signal:AbortSignal.timeout(5000)})
 assert.equal((await call('x-search')).isError,false);assert.equal(bodies,1)
 const denied=await call('brief')
 assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/工具参数超出本次任务授权/);assert.equal(bodies,1)
})

test('自授权工具集不得含编排类工具，装配期即拒绝',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 for(const name of orchestrationTools)assert.throws(()=>registerTaskToolGuard(ctx,async()=>null,[name]),/自授权工具不能包含编排类工具/)
 registerTaskToolGuard(ctx,async()=>null,['role_memory_proposal'])
})

test('绑定业务对象来源的会话一律拒绝外发工具，未绑定的普通会话照常放行',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('guard-egress'),agentOptions:{provider:'test',model:'test'}})
 // 告警正文随任务快照逐字进过这条会话的 user turn，而 web_fetch 在上游没有任何审批钩子。
 let bodies=0,policy:'ordinary'|'denied'|'granted'='ordinary',binding:'bound'|'free'|'error'='bound'
 for(const name of externalEgressTools)ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 registerTaskToolGuard(ctx,async()=>policy==='ordinary'?null:{allowedTools:policy==='granted'?['web_fetch']:['read_evidence']},[],async sessionId=>{
  assert.equal(sessionId,agent.session.id)
  if(binding==='error')throw Error('private database detail')
  return binding==='bound'
 },undefined,{
  // 这条用例只管业务绑定这一维，上网总开关开着、拦截名单空着；闸的其余三维在下一条用例里逐条判。
  policy:async signal=>{signal.throwIfAborted();return {enabled:true,blocked:[]}},
  record:async(_sessionId,_entry,signal)=>{signal.throwIfAborted();return 'no-run'},
 })
 let seq=0
 const call=(name:string)=>ctx.tools.execute({agent,name,arguments:name==='web_fetch'?{url:'https://example.com/a'}:{queries:['告警来源']},callId:ToolCallId('egress-'+ ++seq),signal:AbortSignal.timeout(5000)})
 for(const name of externalEgressTools){
  binding='bound';policy='ordinary';assert.equal((await call(name)).isError,true)
  policy='denied';assert.equal((await call(name)).isError,true)
  // 判定不出来时按"绑定了"拒绝：无从证明这条会话没有外部正文。
  binding='error';policy='ordinary';const failed=await call(name)
  assert.equal(failed.isError,true);assert.ok(!JSON.stringify(failed).includes('private database detail'))
 }
 assert.equal(bodies,0)
 // 没有业务来源的普通会话不受影响，联网工具照常可用。
 binding='free';policy='ordinary'
 for(const name of externalEgressTools)assert.equal((await call(name)).isError,false)
 assert.equal(bodies,externalEgressTools.length)
 // 绑定业务来源的执行态会话仍可由岗位执行范围显式授权。
 binding='bound';policy='granted'
 assert.equal((await call('web_fetch')).isError,false)
 assert.equal((await call('web_search')).isError,true)
 assert.equal(bodies,externalEgressTools.length+1)
 // 外发工具进岗位授权候选清单：这是本期唯一一条被反转的断言（岗位从此能把上网授权出去）。
 for(const name of externalEgressTools)assert.ok(roleGrantToolNames.includes(name))
 // 编排权限独立列出，逐次确认由编排守卫用例覆盖。
 for(const name of orchestrationTools)assert.ok(roleGrantToolNames.includes(name))
})

test('上网闸：总开关、拦截名单、URL 解析与派发前记录各自的固定理由',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('guard-web-gate'),agentOptions:{provider:'test',model:'test'}})
 let bodies=0,enabled=true,blocked:string[]=[],writes:'no-run'|'written'|'throw'='no-run',explode=false
 const records:{sessionId:string;kind:string;value:string}[]=[]
 for(const name of externalEgressTools)ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;if(explode)throw Error('provider refused');return 'executed'}}))
 // 本人在场的普通会话（未绑定业务来源）：这条用例里被拒的每一次都只可能是上网闸自己在说话。
 registerTaskToolGuard(ctx,async()=>null,[],async()=>false,undefined,{
  policy:async signal=>{signal.throwIfAborted();return {enabled,blocked}},
  record:async(sessionId,entry,signal)=>{
   signal.throwIfAborted();records.push({sessionId,...entry})
   if(writes==='throw')throw Error('private database detail')
   return writes
  },
 })
 let seq=0
 const call=(name:string,args:Record<string,unknown>)=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId('web-gate-'+ ++seq),signal:AbortSignal.timeout(5000)})
 const fetchCall=(url:unknown)=>call('web_fetch',{url}),searchCall=()=>call('web_search',{queries:['明天的天气']})
 // ① 总开关关：两个工具都拒，理由逐字。
 enabled=false
 assert.match(JSON.stringify(await fetchCall('https://example.com/a')),/设置中已关闭网页搜索与读取。/)
 assert.match(JSON.stringify(await searchCall()),/设置中已关闭网页搜索与读取。/)
 assert.equal(bodies,0);assert.equal(records.length,0)
 // ② 拦截名单：只拦 web_fetch 的目标主机，子域一并拦，形近域名不拦，对 web_search 不生效。
 enabled=true;blocked=['example.com']
 assert.match(JSON.stringify(await fetchCall('https://a.example.com/x')),/目标网站在拦截名单里。/)
 assert.match(JSON.stringify(await fetchCall('https://example.com/')),/目标网站在拦截名单里。/)
 assert.equal((await searchCall()).isError,false)
 assert.equal((await fetchCall('https://notexample.com/')).isError,false)
 assert.equal(bodies,2)
 // ③ URL 解析不出来（非 URL、非 http(s)、内嵌凭据）走 hostAllowed 为假的同一条路，不新增第六条理由。
 for(const url of ['不是URL','ftp://x','https://u:p@x.com'])
  assert.match(JSON.stringify(await fetchCall(url)),/目标网站在拦截名单里。/)
 // 连 url 都没给：同一条路，同一句理由。
 assert.match(JSON.stringify(await call('web_fetch',{})),/目标网站在拦截名单里。/)
 assert.equal(bodies,2)
 // ④ 记录写不进就没有对价：拒绝，工具体不执行，库里的细节不外冒。
 blocked=[];writes='throw'
 const failed=await searchCall()
 assert.match(JSON.stringify(failed),/无法记录本次上网，已取消该工具调用。/)
 assert.ok(!JSON.stringify(failed).includes('private database detail'))
 assert.equal(bodies,2)
 // ⑤ 普通会话没有 Run 作用域（'no-run'）：放行且不记录，不能把本人自己的搜索一刀切掉。
 writes='no-run'
 assert.equal((await searchCall()).isError,false);assert.equal(bodies,3)
 // ⑥ 记录是在派发之前写的：工具体自己抛错，这一次外发同样留下了证据。
 writes='written';explode=true
 const before=records.length
 assert.equal((await fetchCall('https://example.com/evidence')).isError,true)
 assert.equal(bodies,4);assert.equal(records.length,before+1)
 assert.deepEqual(records[records.length-1],{sessionId:agent.session.id,kind:'fetch',value:'https://example.com/evidence'})
 // 记录的 value 是模型给出的参数原文：search 存查询词数组的逐字序列化。
 assert.deepEqual(records.filter(row=>row.kind==='search').at(-1),{sessionId:agent.session.id,kind:'search',value:'["明天的天气"]'})
})

test('读口缺席时外发工具一律拒绝，且自授权工具集不得含外发工具',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('guard-egress-unwired'),agentOptions:{provider:'test',model:'test'}})
 let bodies=0
 for(const name of externalEgressTools)ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 for(const name of externalEgressTools)assert.throws(()=>registerTaskToolGuard(ctx,async()=>null,[name]),/自授权工具不能包含外发类工具/)
 // 没有接判定读口就等于判定不出来：普通会话也一律拒绝，绝不默认放行。
 registerTaskToolGuard(ctx,async()=>null)
 let seq=0
 for(const name of externalEgressTools)assert.equal((await ctx.tools.execute({agent,name,arguments:{},callId:ToolCallId('egress-unwired-'+ ++seq),signal:AbortSignal.timeout(5000)})).isError,true)
 assert.equal(bodies,0)
})

const delegationPorts=(overrides:Partial<SubagentDelegationPorts>={}):SubagentDelegationPorts=>({limits:{maxDepth:1,maxPerRun:6},runId:async()=>undefined,reserve:async()=>{},release:async()=>{},bind:async()=>{},settle:async()=>{},abandon:async()=>{},...overrides})

test('执行态 subagent_task 受岗位和层数约束；会话委派工具不进入执行态',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent:root}=await ctx.agents.create({sessionId:SessionId('delegation-root'),agentOptions:{provider:'test',model:'test'}})
 const {agent:child}=await ctx.agents.create({sessionId:SessionId('delegation-child'),meta:{origin:'subagent',parentSession:root.session.id,delegationDepth:1},agentOptions:{provider:'test',model:'test'}})
 let bodies=0,policy:'granted'|'denied'='granted',runId:string|undefined='5d88e8cf-1e91-4a70-97ae-98175a21382b'
 const reservations:{runId:string;reservationId:string;limit:number}[]=[]
 for(const name of [subagentTaskToolName,...conversationDelegationTools])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 registerTaskToolGuard(ctx,async sessionId=>{assert.equal(sessionId,root.session.id);return {allowedTools:policy==='granted'?[subagentTaskToolName]:[]}},[],undefined,delegationPorts({runId:async()=>runId,reserve:async input=>{reservations.push(input)}}))
 let seq=0
 const call=(agent=root,name=subagentTaskToolName)=>ctx.tools.execute({agent,name,arguments:{},callId:ToolCallId('delegation-'+ ++seq),signal:AbortSignal.timeout(5000)})
 assert.equal((await call()).isError,false);assert.equal(bodies,1)
 assert.deepEqual(reservations,[])
 assert.equal((await call(root,conversationDelegationTools[0])).isError,true);assert.equal(bodies,1)
 assert.equal((await call(child)).isError,true);assert.equal(bodies,1);assert.equal(reservations.length,0)
 policy='denied';assert.equal((await call()).isError,true);assert.equal(bodies,1);assert.equal(reservations.length,0)
 runId=undefined;policy='granted';assert.equal((await call()).isError,false);assert.equal(bodies,2)
})

test('提高到两层时一级子任务可继续拆分，第二级仍被深度闸拒绝',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent:root}=await ctx.agents.create({sessionId:SessionId('delegation-depth-root'),agentOptions:{provider:'test',model:'test'}})
 const {agent:child}=await ctx.agents.create({sessionId:SessionId('delegation-depth-child'),meta:{origin:'subagent',parentSession:root.session.id,delegationDepth:1},agentOptions:{provider:'test',model:'test'}})
 const {agent:grandchild}=await ctx.agents.create({sessionId:SessionId('delegation-depth-grandchild'),meta:{origin:'subagent',parentSession:child.session.id,delegationDepth:2},agentOptions:{provider:'test',model:'test'}})
 let bodies=0,sequence=0
 ctx.tools.register(defineTool({name:subagentTaskToolName,description:subagentTaskToolName,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 registerTaskToolGuard(ctx,async sessionId=>{assert.equal(sessionId,root.session.id);return {allowedTools:[subagentTaskToolName]}},[],undefined,delegationPorts({limits:{maxDepth:2,maxPerRun:6},runId:async()=> '7c98921d-d6f1-46f4-b78b-cbfb63f5fd56'}))
 const call=(agent:typeof root)=>ctx.tools.execute({agent,name:subagentTaskToolName,arguments:{},callId:ToolCallId('delegation-depth-'+ ++sequence),signal:AbortSignal.timeout(5000)})
 assert.equal((await call(root)).isError,false)
 assert.equal((await call(child)).isError,false)
 const denied=await call(grandchild)
 assert.equal(denied.isError,true)
 assert.match(JSON.stringify(denied),/已达到本次任务允许的拆分层数上限/)
 assert.equal(bodies,2)
})

test('同一 Run 并行提出多个 subagent_task 时守卫不串行阻塞工具调用',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('delegation-serial'),agentOptions:{provider:'test',model:'test'}})
 const runId='ca6c3e5d-5373-492e-a720-19237f5ffc9d',reservations:{runId:string;reservationId:string;limit:number}[]=[]
 let entered!:()=>void,release!:()=>void,bodies=0
 const enteredFirst=new Promise<void>(resolve=>{entered=resolve}),releaseFirst=new Promise<void>(resolve=>{release=resolve})
 ctx.tools.register(defineTool({name:subagentTaskToolName,description:subagentTaskToolName,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;if(bodies===1){entered();await releaseFirst}return 'executed'}}))
 registerTaskToolGuard(ctx,async()=>({allowedTools:[subagentTaskToolName]}),[],undefined,delegationPorts({runId:async()=>runId,reserve:async input=>{reservations.push(input)}}))
 let sequence=0
 const call=()=>ctx.tools.execute({agent,name:subagentTaskToolName,arguments:{},callId:ToolCallId('serial-'+ ++sequence),signal:AbortSignal.timeout(5000)})
 const first=call();await enteredFirst
 const second=call();await Promise.resolve();await Promise.resolve()
 release()
 const [firstResult,secondResult]=await Promise.all([first,second])
 assert.equal(firstResult.isError,false);assert.equal(secondResult.isError,false)
 assert.equal(bodies,2);assert.equal(reservations.length,0)
})

test('普通会话保留既有委派，subagent_task 与预留失败均 fail-closed，且不能自授权',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('delegation-ordinary'),agentOptions:{provider:'test',model:'test'}})
 let bodies=0,execution=false
 for(const name of [subagentTaskToolName,...conversationDelegationTools])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 assert.throws(()=>registerTaskToolGuard(ctx,async()=>null,[subagentTaskToolName]),/自授权工具不能包含执行态委派工具/)
 registerTaskToolGuard(ctx,async()=>execution?{allowedTools:[subagentTaskToolName]}:null,[],undefined,delegationPorts({limits:{maxDepth:2,maxPerRun:6},runId:async()=> '8ad8c8ae-52cc-4e9c-ae94-e123fd4879c3',reserve:async()=>{throw Error('private quota detail')}}))
 let seq=0
 const call=(name:string)=>ctx.tools.execute({agent,name,arguments:{},callId:ToolCallId('ordinary-'+ ++seq),signal:AbortSignal.timeout(5000)})
 assert.equal((await call(conversationDelegationTools[0])).isError,false);assert.equal(bodies,1)
 assert.equal((await call(subagentTaskToolName)).isError,true);assert.equal(bodies,1)
 execution=true;const permitted=await call(subagentTaskToolName)
 assert.equal(permitted.isError,false);assert.ok(!JSON.stringify(permitted).includes('private quota detail'));assert.equal(bodies,2)
})

test('自授权集列出的三个名字由守卫放行，MCP 资源类、外发类与委派类逐条被拒',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('guard-digest'),agentOptions:{provider:'test',model:'test'}})
 // 这一层只管自授权集与三条分类闸；小结运行再由 role-daily-log.ts 的闸收窄到两个工具。
 const digestTools=[roleMemoryProposalToolName,...roleDailyDigestToolNames]
 const blocked=[mcpResourceTools[2],externalEgressTools[0],subagentTaskToolName] as const
 let bodies=0
 for(const name of [...digestTools,...blocked])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 const nativeRequestId='b0b7e0dc-4b2f-4a02-9c2e-4a5f8c5c1f6d'
 registerTaskToolGuard(ctx,async()=>({allowedTools:[],nativeRequestId}),digestTools)
 agent.session.append('turn/start',{turn:0})
 agent.session.append('user/message',createUserMessage({content:[],source:{kind:'user',rpcId:brandString<SessionRequestId>(nativeRequestId)}}),{surfaceOp:'append'})
 let seq=0
 const call=(name:string)=>ctx.tools.execute({agent,name,arguments:{},callId:ToolCallId('digest-'+ ++seq),signal:AbortSignal.timeout(5000)})
 for(const name of digestTools)assert.equal((await call(name)).isError,false)
 assert.equal(bodies,3)
 assert.match(JSON.stringify(await call(mcpResourceTools[2])),/MCP 资源工具未在员工执行范围内授权。/)
 assert.match(JSON.stringify(await call(externalEgressTools[0])),/本会话关联了外部业务来源，联网工具未在员工执行范围内授权。/)
 assert.match(JSON.stringify(await call(subagentTaskToolName)),/当前会话不能使用此委派工具，请核对员工执行范围。/)
 assert.equal(bodies,3)
})

test('未授权的执行态会话在写记录之前就被拒：记录写口一次都不许被调用',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('guard-web-record-order'),agentOptions:{provider:'test',model:'test'}})
 let bodies=0,allowedTools:string[]=[],argumentRules:TaskToolArgumentRule[]|undefined
 const records:{kind:string;value:string}[]=[]
 for(const name of externalEgressTools)ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return 'executed'}}))
 // 未绑定业务来源的执行态会话：外发闸这一维放行，被拒的只可能是岗位清单或参数范围那两道既有闸。
 registerTaskToolGuard(ctx,async()=>({allowedTools,...(argumentRules?{argumentRules}:{})}),[],async()=>false,undefined,{
  policy:async signal=>{signal.throwIfAborted();return {enabled:true,blocked:[]}},
  record:async(_sessionId,entry,signal)=>{signal.throwIfAborted();records.push(entry);return 'written'},
 })
 let seq=0
 const call=(name:string,args:Record<string,unknown>)=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId('web-record-'+ ++seq),signal:AbortSignal.timeout(5000)})
 // 岗位清单里没有这两个工具：逐字回既有那句理由，且只追加的记录表上一条都不该多出来。
 const denied=await call('web_search',{queries:['明天的天气']})
 assert.match(JSON.stringify(denied),/当前任务未授权使用此工具，请核对员工执行范围。/)
 assert.match(JSON.stringify(await call('web_fetch',{url:'https://example.com/a'})),/当前任务未授权使用此工具，请核对员工执行范围。/)
 assert.equal(records.length,0);assert.equal(bodies,0)
 // 工具在清单里但参数超范围：同样先于写记录被拒，理由逐字是既有那一句。
 allowedTools=['web_fetch'];argumentRules=[{name:'web_fetch',allowed:[{url:'https://allowed.example/a'}]}]
 assert.match(JSON.stringify(await call('web_fetch',{url:'https://example.com/a'})),/工具参数超出本次任务授权的数据范围或版本。/)
 assert.equal(records.length,0);assert.equal(bodies,0)
 // 两道闸都过了才落账：这一条是「一次已放行的外发」，记录与派发同时发生。
 assert.equal((await call('web_fetch',{url:'https://allowed.example/a'})).isError,false)
 assert.deepEqual(records,[{kind:'fetch',value:'https://allowed.example/a'}]);assert.equal(bodies,1)
})

test('teloa_skill_http 不是外发类基线成员，也不自授权（它自己判上网策略与身份）',async()=>{
 const {externalEgressTools}=await import('../src/role-tool-grants.ts')
 const {skillHttpToolName}=await import('../src/skill-http-tool.ts')
 assert.ok(!(externalEgressTools as readonly string[]).includes(skillHttpToolName))
 const source=await import('node:fs').then(fs=>fs.readFileSync(new URL('../src/index.ts',import.meta.url),'utf8'))
 assert.ok(!/selfAuthorizedToolNames=\[[^\]]*teloa_skill_http/.test(source))
})
