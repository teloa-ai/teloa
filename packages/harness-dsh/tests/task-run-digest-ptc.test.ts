import test from 'node:test'
import assert from 'node:assert/strict'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {ToolCallId,createUserMessage,type StreamChunk} from '@deepseek-ai/dsh-llm'
import type {SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'
import {textResponse} from '../../../tests/native-auto-review-fixture.mjs'
import {nativePtcToolPath} from './fixtures/native-ptc-tool-path.ts'
import {publishNativeFixtureInput} from './fixtures/native-host-services.ts'
import {dshTaskRunPorts,restrictRunTools} from '../src/task-run-dsh.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {registerRoleDailyDigestTools,roleDailyDigestToolNames,type RoleDailyDigestToolPorts} from '../src/role-daily-log.ts'
import {roleMemoryProposalToolName} from '../src/role-memory.ts'

const [evidenceTool,submitTool]=roleDailyDigestToolNames
const text=(message:{content:readonly {type:string;text?:string}[]})=>message.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n')

test('固定 Run 核对实际组合：首轮前更换模式不能被旧会话头掩盖',{timeout:30000},async t=>{
 const f=await nativePtcToolPath(t),agent=await f.create('ptc')
 f.ctx.provide('sessionController',{resolveAgent:async()=>({agent})} as never)
 const ports=dshTaskRunPorts(f.ctx,'owner',async()=>({ownerId:'owner',sessionId:agent.id,status:'ready'}))
 const run={sessionId:agent.id,agentPresetId:'ptc'},signal=new AbortController().signal
 await ports.check(run,signal)
 await f.ctx.agentPresets.select(agent,'ptc-persistent')
 assert.equal(agent.session.header.agentPreset,'ptc','原生选择不会改写创建时的会话头')
 assert.equal(f.ctx.agentPresets.composedPreset(agent.ctx),'ptc-persistent')
 await assert.rejects(ports.check(run,signal),{code:'teloa/version-conflict'})
 assert.equal(f.adapter.requests.length,0,'错误配置必须在模型调用前拒绝')
})

test('普通员工仅获 run_code 授权时仍能看到并执行计算，不退化为只有记忆提议',{timeout:30000},async t=>{
 const f=await nativePtcToolPath(t),agent=await f.create('ptc')
 f.ctx.tools.register(defineTool({name:roleMemoryProposalToolName,description:'员工经验候选',parameters:{},output:{schema:{type:'boolean'},render:()=>[]},execute:async()=>assert.fail('计算不应写入记忆')}))
 registerTaskToolGuard(f.ctx,async()=>({allowedTools:['run_code']}),[roleMemoryProposalToolName])
 f.ctx.on('approval/request',async()=> 'allowed-once')
 const lift=restrictRunTools(agent,['run_code'],{group:false,digest:false})
 try{
  const wire=await f.ctx.systemPrompt.assemble({scope:agent})
  assert.ok(wire.tools.some(tool=>tool.name==='run_code'),JSON.stringify(wire.tools.map(tool=>tool.name)))
  const result=await f.run(agent,'return (13550 + 6450 - 2000) / 100')
  assert.notEqual(result.isError,true,text(result));assert.match(text(result),/180/)
  assert.ok(f.adapter.requests.every(request=>request.tools?.some(tool=>tool.name==='run_code')),'最终请求必须保留已授权的计算入口')
 }finally{lift()}
})

for(const preset of ['ptc','ptc-persistent','ptc-python'])test(preset+' 的小结临时使用两个原生工具；执行、同预设隔离与释放不改变岗位配置',{timeout:30000},async t=>{
 const f=await nativePtcToolPath(t,{delegation:true}),agent=await f.create(preset),other=await f.create(preset)
 const owner='local:teloa-owner',roleId='22222222-2222-4222-8222-222222222222',runId='33333333-3333-4333-8333-333333333333'
 const nativeRequestId='88888888-8888-4888-8888-888888888888'
 const identity={runId,taskId:'44444444-4444-4444-8444-444444444444',planId:'55555555-5555-4555-8555-555555555555',roleId,roleVersion:2,day:'2026-10-25'}
 let reads=0,submits=0,memoryWrites=0,sourceBindings=0
 const ports:RoleDailyDigestToolPorts={
  owner,run:async sessionId=>sessionId===agent.id?{id:runId,sessionId,state:'active'}:null,digestRun:async()=>identity,
  evidence:async()=>{reads++;return {day:identity.day,timezone:'Asia/Singapore',roleId,roleVersion:2,scopeIds:['general'],runs:[],artifacts:[],approvals:[],revisions:[],groupMessages:[]}},
  bindSourceInput:async(sessionId,evidence)=>{assert.equal(sessionId,agent.id);assert.deepEqual(evidence.artifacts,[]);assert.equal(evidence.day,identity.day);sourceBindings++},
  submit:async()=>{submits++;return {log:{id:'66666666-6666-4666-8666-666666666666',ownerId:owner,roleId,roleVersion:2,kind:'daily-digest',day:identity.day,state:'kept',runId,title:'今天的小结',markdown:'今日没有业务证据。',scopeIds:['general'],evidence:[],pruneHints:[],createdAt:'2026-10-25T15:30:00.000Z',discardedAt:null},candidates:[]}},
 }
 registerTaskToolGuard(f.ctx,async sessionId=>sessionId===agent.id?{allowedTools:[roleMemoryProposalToolName,'run_code'],nativeRequestId}:null,[...roleDailyDigestToolNames,roleMemoryProposalToolName])
 registerRoleDailyDigestTools(f.ctx,ports)
 f.ctx.tools.register(defineTool({name:roleMemoryProposalToolName,description:'不应在小结写入',parameters:{},output:{schema:{type:'boolean'},render:()=>[]},execute:async()=>{memoryWrites++;return true}}))
 f.ctx.permissionPresets.set(agent.session,'read-only')
 const configEvents=()=>agent.session.snapshotEvents().filter(event=>['permission/preset','sandbox/mode','approval/policy','llm/model','agent-preset/select'].includes(event.type))
 const beforeEvents=configEvents(),beforePreset=f.ctx.agentPresets.composedPreset(agent.ctx)
 const before=await f.ctx.systemPrompt.assemble({scope:agent})
 assert.deepEqual(before.tools.map(tool=>tool.name),['run_code'])
 assert.ok(agent.ctx.tools.get('subagent',agent),'正式 modelSelectionSettings 行在 Agent 自身层装配工具')
 assert.ok(before.sections.find(section=>section.name==='tool:subagent')?.text.trim(),'真实委派提示已装配')
 const lift=restrictRunTools(agent,['run_code',roleMemoryProposalToolName],{group:false,digest:true})
 const scoped=await f.ctx.systemPrompt.assemble({scope:agent})
 assert.deepEqual(scoped.tools.map(tool=>tool.name).sort(),[...roleDailyDigestToolNames].sort())
 assert.equal(scoped.sections.some(section=>['tools:ptc-only','tools:sdk'].includes(section.name)&&section.text.trim()),false,'不再告诉小结模型必须使用 run_code')
 assert.equal(scoped.sections.some(section=>section.name==='tool:subagent'),false,'收起已不可用的委派提示')
 assert.equal(scoped.contexts.some(context=>context.name==='tool:subagent:depth'),false)
 const beforeAgents=f.ctx.agents.list().map(agent=>agent.id).sort()
 const calls=[
  {name:evidenceTool,args:{}},
  {name:submitTool,args:{title:'今天的小结',markdown:'今日没有业务证据。',candidates:[],pruneHints:[]}},
  {name:roleMemoryProposalToolName,args:{}},
  {name:'run_code',args:{description:'不允许执行',code:'throw new Error("must not execute")'}},
  {name:'subagent',args:{description:'不允许委派',prompt:'不可创建子代理'}},
 ]
 const scripts:StreamChunk[][]=calls.map(({name,args},index)=>{
  const id=ToolCallId('digest-'+index),argumentsText=JSON.stringify(args)
  return [{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id,name,argumentsDelta:argumentsText},{type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:argumentsText}},{type:'finish',reason:{kind:'tool-calls'}}]
 })
 f.adapter.scripts.set(String(agent.id),[...scripts,textResponse('已提交小结')])
 await publishNativeFixtureInput(f.ctx,agent,createUserMessage({source:{kind:'user',rpcId:nativeRequestId as SessionRequestId},content:[{type:'text',text:'读取今天证据并提交小结。'}]}));await agent.whenIdle()
 for(const [index,call] of calls.entries()){
  const event=agent.session.snapshotEvents().find(event=>event.type==='tool/result'&&event.data.message.toolCallId==='digest-'+index)
  assert.ok(event?.type==='tool/result',call.name)
  assert.equal(Boolean(event.data.message.isError),index>=2,text(event.data.message))
 }
 assert.deepEqual({reads,submits,memoryWrites,sourceBindings},{reads:1,submits:1,memoryWrites:0,sourceBindings:1})
 assert.deepEqual(f.ctx.agents.list().map(agent=>agent.id).sort(),beforeAgents,'被拒委派不能新建 Agent')
 assert.equal(agent.session.snapshotEvents().some(event=>event.type==='subagent/catalog'),false,'被拒委派不能写入子会话目录')
 for(const request of f.adapter.requests){assert.deepEqual(request.tools?.map(tool=>tool.name).sort(),[...roleDailyDigestToolNames].sort());assert.doesNotMatch(JSON.stringify(request.messages),/Start independent delegations|Delegation depth for/);assert.equal(request.provider,'u4-scripted');assert.equal(request.model,'tools')}
 const nextAssembly=await f.ctx.systemPrompt.assemble({scope:agent})
 assert.deepEqual(nextAssembly.tools.map(tool=>tool.name).sort(),[...roleDailyDigestToolNames].sort(),'后续组装仍使用完整白名单')
 assert.equal(nextAssembly.sections.some(section=>section.name==='tool:subagent'),false)
 assert.deepEqual((await f.ctx.systemPrompt.assemble({scope:other})).tools.map(tool=>tool.name),['run_code'],'同一个预设下另一个 Agent 保持 PTC')
 lift()
 const restored=await f.ctx.systemPrompt.assemble({scope:agent})
 assert.deepEqual(restored.tools.map(tool=>tool.name),['run_code'])
 assert.ok(restored.sections.find(section=>section.name==='tools:sdk')?.text.includes(roleMemoryProposalToolName),'释放后恢复原目录')
 assert.ok(restored.sections.some(section=>section.name==='tool:subagent'),'释放后恢复普通委派提示')
 assert.equal(f.ctx.agentPresets.composedPreset(agent.ctx),beforePreset)
 assert.equal(f.ctx.permissionPresets.current(agent.session),'read-only')
 assert.deepEqual(configEvents(),beforeEvents,'租约不得改写预设、模型或权限设置')
})
