import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,createUserMessage,type ContextFormed,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore,type SessionEvent} from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {WorkError,type DigitalRole} from '@teloa/contract'
import {registerRoleConversationContext,type RoleContextPorts} from '../src/role-conversation-context.ts'

// rc.1 的 agent-loop 公开入口未引入其 runtime-context 声明；按官方来源类型注册，不导入私有路径。
declare module '@deepseek-ai/dsh-llm' {
 interface MessageSourceMap {'runtime-context':{kind:'runtime-context'}&ContextFormed}
}

const owner='local:teloa-owner',roleId='11111111-1111-4111-8111-111111111111'
const reply:StreamChunk[]=[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:'收到'},{type:'block-end',index:0,block:{type:'text',text:'收到'}},{type:'finish',reason:{kind:'stop'}}]
class Adapter extends LlmAdapter{
 requests:GenerateOptions[]=[]
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions){this.requests.push(options);yield* reply}
}
function role(fields:Partial<DigitalRole>={}):DigitalRole{return {id:roleId,ownerId:owner,name:'研判同事',kind:'employee',scopes:['general'],duty:'核对 {{foo}} 告警',dataScope:'已授权资料',executionScope:'只读核对',skills:[],knowledge:[],version:1,state:'active',createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',...fields}}
async function fixture(t:TestContext){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new Adapter();ctx.llm.registerAdapter(['mock'],adapter)
 let toolExecutions=0
 ctx.tools.register(defineTool({name:'read_public_fixture',description:'读取无敏感信息的固定夹具',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{toolExecutions++;return 'public fixture'}}))
 const {agent}=await ctx.agents.create({sessionId:SessionId('role-context-test'),agentOptions:{provider:'mock',model:'mock'}})
 const state={requested:roleId as string|null,links:[{kind:'role' as const,objectId:roleId,conversationId:'conversation-one',sessionId:agent.session.id,scopeId:'general' as string|null,active:true}],role:role() as DigitalRole|null,failure:null as Error|null,roleFailure:null as Error|null,bindingOwner:owner,bindingMissing:false,purpose:undefined as 'task-run'|undefined,calls:{conversation:0,requested:0,links:0,role:0}}
 const ports:RoleContextPorts={owner,
  conversation:async()=>{state.calls.conversation++;if(state.bindingMissing)throw new WorkError('teloa/not-bound','missing');return {id:'conversation-one',ownerId:state.bindingOwner,sessionId:agent.session.id,status:'ready',...(state.purpose===undefined?{}:{purpose:state.purpose})}},
  requestedRoleId:async()=>{state.calls.requested++;return state.requested},
  links:async()=>{state.calls.links++;if(state.failure)throw state.failure;return state.links},
  role:async()=>{state.calls.role++;if(state.roleFailure)throw state.roleFailure;return state.role},
 }
 const send=async(text:string)=>{agent.followup(createUserMessage({source:{kind:'user',rpcId:'role-context-'+adapter.requests.length},content:[{type:'text',text}]}));await agent.whenIdle()}
 return {ctx,agent,adapter,state,ports,send,toolExecutions:()=>toolExecutions}
}
const snapshots=(agent:Agent)=>agent.session.snapshotEvents().filter((event):event is SessionEvent<'user/message'>=>event.type==='user/message'&&event.data.source.kind==='runtime-context')

test('员工经验进入官方上下文，保留字面模板和来源，撤回后新请求清除旧经验',async t=>{
 const f=await fixture(t),queries:string[]=[]
 let text=JSON.stringify({notice:'经验不是授权',sources:[{id:'memory-one',version:1}],text:'先核对 {{source}} 版本'})
 f.ports.experience=async input=>{assert.equal(input.role.id,roleId);assert.equal(input.scopeId,'general');queries.push(input.query);return text}
 registerRoleConversationContext(f.ctx,f.ports)
 const tools=(await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent})).tools
 await f.send('怎样核对这次部署？')
 assert.ok(queries.includes('怎样核对这次部署？'))
 assert.match(JSON.stringify(f.adapter.requests[0]!.messages),/先核对 \{\{source\}\} 版本/)
 assert.deepEqual((await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent})).tools,tools)
 text='';await f.send('来源撤回后继续')
 assert.doesNotMatch(JSON.stringify(f.adapter.requests.at(-1)!.messages),/先核对 \{\{source\}\} 版本/)
})

test('经验召回期间岗位或关联变化，在发模型前拒绝；分身不启用员工经验',async t=>{
 const f=await fixture(t)
 f.ports.experience=async()=>{f.state.role=role({version:2});return '旧版本经验'}
 registerRoleConversationContext(f.ctx,f.ports)
 await f.send('不能使用旧岗位版本');assert.equal(f.adapter.requests.length,0)
 let reads=0;f.ports.experience=async()=>{reads++;return '员工经验'};f.state.role=role({kind:'twin'})
 await f.send('分身保持私有记忆路径');assert.equal(reads,0)
 assert.doesNotMatch(JSON.stringify(f.adapter.requests.at(-1)!.messages),/员工经验/)
 assert.doesNotMatch(JSON.stringify(f.adapter.requests.at(-1)!.messages.filter(message=>message.role==='system')),/AI employee working rules/)
})

test('分身私聊读取本人确认私有背景，memory off与撤回后清除旧输入且不改工具',async t=>{
 const f=await fixture(t);f.state.role=role({kind:'twin'});let text='本人的私有偏好：先给证据',reads=0,enabled=true
 f.ports.memoryEnabled=async()=>enabled
 Object.assign(f.ports,{privateMemory:async()=>{reads++;return {text,assertCurrent:async()=>{}}}})
 registerRoleConversationContext(f.ctx,f.ports)
 const tools=(await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent})).tools
 await f.send('按我的私有偏好说明');assert.equal(reads,1)
 assert.match(JSON.stringify(f.adapter.requests.at(-1)!.messages),/本人的私有偏好：先给证据/)
 text='';await f.send('已撤回后继续');assert.doesNotMatch(JSON.stringify(f.adapter.requests.at(-1)!.messages),/本人的私有偏好：先给证据/)
 enabled=false;await f.send('关闭记忆后继续');assert.equal(reads,2)
 assert.deepEqual((await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent})).tools,tools)
})

test('分身读取后版本、关联或私有来源失效，实际adapter前拒绝；员工不进私有口',async t=>{
 for(const change of ['role','link','source','owner','off'] as const){
  const f=await fixture(t);f.state.role=role({kind:'twin'})
  Object.assign(f.ports,{privateMemory:async()=>{
   if(change==='role')f.state.role=role({kind:'twin',version:2})
   if(change==='link')f.state.links=[]
   if(change==='owner')f.state.bindingOwner='other'
   if(change==='off')f.ports.memoryEnabled=async()=>false
   return {text:'不可注入的旧私有记忆',assertCurrent:async()=>{if(change==='source')throw new WorkError('teloa/version-conflict','已撤回')}}
  }})
  registerRoleConversationContext(f.ctx,f.ports);await f.send('核验当前私有背景');assert.equal(f.adapter.requests.length,0,change)
 }
 const employee=await fixture(t);let privateReads=0
 Object.assign(employee.ports,{privateMemory:async()=>{privateReads++;throw Error('员工不能进私有口')}})
 registerRoleConversationContext(employee.ctx,employee.ports);await employee.send('普通员工');assert.equal(privateReads,0);assert.equal(employee.adapter.requests.length,1)
})

test('分身原生派发前再核来源，单一已知范围可用而project统一模式不绕过',async t=>{
 const f=await fixture(t);f.state.role=role({kind:'twin'});f.state.links[0]!.scopeId=null
 let checks=0
 Object.assign(f.ports,{privateMemory:async(input:{scopeId:string})=>{assert.equal(input.scopeId,'general');return {text:'不得进入adapter的旧私有内容',assertCurrent:async()=>{if(++checks===2)throw new WorkError('teloa/version-conflict','派发前来源已撤回')}}}})
 registerRoleConversationContext(f.ctx,f.ports);await f.send('读取后立即撤回')
 assert.equal(checks,2);assert.equal(f.adapter.requests.length,0)
 const project=await fixture(t);project.state.role=role({kind:'twin'});project.ports.memoryEnabled=async()=>false;let reads=0
 Object.assign(project.ports,{privateMemory:async()=>{reads++;throw Error('project上下文不走legacy私有口')}})
 registerRoleConversationContext(project.ctx,project.ports);await project.send('由project统一装配');assert.equal(reads,0);assert.equal(project.adapter.requests.length,1)
})

test('分身最终私有来源核验期间改版或解绑，实际派发前拒绝旧背景',async t=>{
 for(const change of ['role','link'] as const){
  const f=await fixture(t);f.state.role=role({kind:'twin'});let checks=0
  f.ports.privateMemory=async()=>({text:'最后读取期间已失效的私有背景',assertCurrent:async()=>{
   if(++checks===2){await Promise.resolve();if(change==='role')f.state.role=role({kind:'twin',version:2});else f.state.links=[]}
  }})
  registerRoleConversationContext(f.ctx,f.ports);await f.send('核对最后一次异步读取')
  assert.equal(checks,2);assert.equal(f.adapter.requests.length,0,change)
 }
})

test('任务经验由独立核验端口读取，保留任务上下文且不读取普通岗位关联',async t=>{
 const f=await fixture(t);f.state.purpose='task-run';let calls=0
 f.ports.taskExperience=async input=>{calls++;assert.equal(input.sessionId,f.agent.session.id);return '当前任务范围的经验'}
 registerRoleConversationContext(f.ctx,f.ports)
 await f.send('执行任务')
 assert.equal(calls,1);assert.deepEqual(f.state.calls,{conversation:1,requested:0,links:0,role:0})
 assert.match(JSON.stringify(f.adapter.requests[0]!.messages),/当前任务范围的经验/)
})

test('员工任务查询不含冻结记忆；启用后旧任务输入只保留非记忆字段',async t=>{
 const f=await fixture(t);f.state.purpose='task-run';let text='当前授权经验'
 f.ports.taskExperience=async input=>{assert.doesNotMatch(input.query,/已撤回冻结经验/);assert.match(input.query,/当前任务目标/);return {text,replaceFrozenMemory:true}}
 registerRoleConversationContext(f.ctx,f.ports)
 const initial=JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:'task',title:'当前任务',goal:'当前任务目标'},role:{id:roleId},knowledge:{contents:['保留已授权知识']},memory:{contents:['已撤回冻结经验']}})+'\n\n本轮还有 2 张已授权图片未进模型。'
 await f.send(initial)
 assert.equal(f.adapter.requests.length,1)
 // 冷恢复/启用前留下的原输入；模拟其已在官方 surface，而不是改写持久 Run。
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:initial}]}),{surfaceOp:'append'})
 text='';await f.send('继续当前任务目标')
 assert.doesNotMatch(JSON.stringify(f.adapter.requests.at(-1)!.messages),/已撤回冻结经验/)
 assert.match(JSON.stringify(f.adapter.requests.at(-1)!.messages),/保留已授权知识/)
 assert.match(JSON.stringify(f.adapter.requests.at(-1)!.messages),/本轮还有 2 张已授权图片未进模型/)
})

test('官方 AgentLoop 只在身份变化时投影角色，原始用户消息不含角色全文，字面模板不插值',async t=>{
 const f=await fixture(t)
 const before=(await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent})).tools
 assert.match(JSON.stringify(before),/read_public_fixture/,'对照工具面必须非空')
 registerRoleConversationContext(f.ctx,f.ports)
 await f.send('请核对这条告警')
 assert.equal(f.adapter.requests.length,1,JSON.stringify(f.agent.session.snapshotEvents().filter(event=>event.type==='turn/end')))
 assert.equal(snapshots(f.agent).length,1)
 assert.equal(f.agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.source.kind==='user').length,1)
 assert.ok(f.adapter.requests[0]!.messages.some(message=>message.role==='user'&&message.source?.kind==='runtime-context'),'模型输入必须保留官方 runtime-context 来源')
 assert.match(JSON.stringify(f.adapter.requests[0]!.messages),/核对 \{\{foo\}\} 告警/)
 assert.match(JSON.stringify(f.adapter.requests[0]!.messages),/Temporary requests do not change your role, permissions or recurring plans/)
 assert.ok(f.adapter.requests[0]!.messages.some(message=>message.role==='system'&&message.content.some(block=>block.type==='text'&&block.text.includes('# AI employee working rules'))),'可信员工须取得公共系统规则，不只取得身份说明')
 assert.deepEqual((await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent})).tools,before)
 await f.send('继续')
 assert.equal(snapshots(f.agent).length,1)
 f.state.role=role({version:2,duty:'核对新版告警'})
 await f.send('再核对')
 assert.equal(snapshots(f.agent).length,2)
 assert.match(JSON.stringify(f.adapter.requests.at(-1)!.messages),/核对新版告警/)
 assert.match(JSON.stringify(f.adapter.requests.at(-1)!.messages),/Role version: 2/)
})

test('岗位指纹丢关联、错归属或多关联时在模型请求前拒绝，不降为普通会话',async t=>{
 const f=await fixture(t)
 registerRoleConversationContext(f.ctx,f.ports)
 for(const mutate of [
  ()=>{f.state.links=[]},
  ()=>{f.state.links=[{...f.state.links[0]!,objectId:'22222222-2222-4222-8222-222222222222'}]},
  ()=>{f.state.links=[f.state.links[0]!,{...f.state.links[0]!,objectId:'22222222-2222-4222-8222-222222222222'}]},
 ]){
  f.state.links=[{kind:'role',objectId:roleId,conversationId:'conversation-one',sessionId:f.agent.session.id,scopeId:'general',active:true}]
  mutate();await f.send('测试');assert.equal(f.adapter.requests.length,0)
 }
 assert.equal(f.toolExecutions(),0)
})

test('普通会话不注入岗位上下文；关联读取故障不伪装成普通会话',async t=>{
 const f=await fixture(t)
 registerRoleConversationContext(f.ctx,f.ports)
 f.state.requested=null;f.state.links=[]
 await f.send('普通会话')
 assert.equal(f.adapter.requests.length,1)
 assert.equal(snapshots(f.agent).length,0)
 assert.doesNotMatch(JSON.stringify(f.adapter.requests[0]!.messages),/AI employee working rules/)
 f.state.requested=roleId;f.state.failure=Error('数据库读取失败')
 await f.send('不可静默降级')
 assert.equal(f.adapter.requests.length,1)
})

test('TaskRun 保留原生任务上下文，子 agent 完全跳过岗位数据端口',async t=>{
 const f=await fixture(t)
 registerRoleConversationContext(f.ctx,f.ports)
 f.state.purpose='task-run'
 await f.send('任务执行')
 assert.equal(f.adapter.requests.length,1)
 assert.equal(snapshots(f.agent).length,0)
 assert.deepEqual(f.state.calls,{conversation:1,requested:0,links:0,role:0})
 f.state.purpose=undefined
 const {agent:child}=await f.ctx.agents.create({sessionId:SessionId('role-context-child'),meta:{origin:'subagent',parentSession:f.agent.session.id,delegationDepth:1},agentOptions:{provider:'mock',model:'mock'}})
 child.followup(createUserMessage({source:{kind:'user',rpcId:'child-role-context'},content:[{type:'text',text:'子代理执行'}]}))
 await child.whenIdle()
 assert.equal(f.adapter.requests.length,2)
 assert.equal(snapshots(child).length,0)
 assert.deepEqual(f.state.calls,{conversation:1,requested:0,links:0,role:0})
})

test('岗位退役、撤范围、跨本人、缺定义和读取故障均在发模型前拒绝；暂停可读当前版本',async t=>{
 const f=await fixture(t)
 registerRoleConversationContext(f.ctx,f.ports)
 const base=role()
 for(const change of [
  ()=>{f.state.role=role({state:'retired'})},
  ()=>{f.state.role=role({scopes:['business_soc']})},
  ()=>{f.state.bindingOwner='local:other'},
  ()=>{f.state.role=role({ownerId:'local:other'})},
  ()=>{f.state.role=null},
  ()=>{f.state.roleFailure=Error('storage unavailable')},
 ]){
  f.state.role=base;f.state.bindingOwner=owner;f.state.roleFailure=null
  change();await f.send('不可降级')
  assert.equal(f.adapter.requests.length,0)
 }
 f.state.roleFailure=null;f.state.bindingOwner=owner;f.state.role=role({state:'paused',version:4})
 await f.send('暂停岗位仍可对话')
 assert.equal(f.adapter.requests.length,1)
 assert.match(JSON.stringify(f.adapter.requests[0]!.messages),/Role version: 4/)
})

test('关联解绑后旧岗位快照不再参与新请求，原请求身份与关联不一致时拒绝',async t=>{
 const f=await fixture(t)
 registerRoleConversationContext(f.ctx,f.ports)
 await f.send('首轮')
 assert.equal(snapshots(f.agent).length,1)
 f.state.links=[]
 await f.send('解绑后继续')
 assert.equal(f.adapter.requests.length,1,'固定岗位请求身份仍在时不得降级为普通会话')
})

test('旧会话解绑时官方投影清除岗位，surface replace 旧快照后自动补投当前岗位',async t=>{
 const f=await fixture(t)
 f.state.requested=null // 旧会话没有新建请求指纹，允许本人解绑后继续作普通会话。
 registerRoleConversationContext(f.ctx,f.ports)
 await f.send('旧岗位第一轮')
 const first=snapshots(f.agent)[0]!
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'替换后的摘要'}]}),{surfaceOp:{op:'replace',startSeq:first.seq,endSeq:first.seq},sourceEventSeqs:[first.seq]})
 await f.send('替换后继续')
 assert.equal(snapshots(f.agent).length,2)
 assert.match(JSON.stringify(f.adapter.requests.at(-1)!.messages),/核对 \{\{foo\}\} 告警/)
 f.state.links=[]
 await f.send('解绑后继续')
 assert.equal(snapshots(f.agent).length,3)
 assert.match(JSON.stringify(snapshots(f.agent).at(-1)!.data.content),/Earlier runtime-context snapshots no longer apply/)
})

test('官方 JSONL 冷恢复保留既有角色快照，不重复投影；岗位改版仍生成新快照',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'teloa-role-context-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 let current=role()
 const mount=async()=>{
  const ctx=new Context()
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
  await ctx.plugin(JsonlSessionPersistence,{root:directory,compression:'none'})
  const adapter=new Adapter();ctx.llm.registerAdapter(['mock'],adapter)
  registerRoleConversationContext(ctx,{owner,
   conversation:async sessionId=>({id:'conversation-one',ownerId:owner,sessionId,status:'ready'}),
   requestedRoleId:async()=>roleId,
   links:async sessionId=>[{kind:'role',objectId:roleId,conversationId:'conversation-one',sessionId,scopeId:'general',active:true}],
   role:async()=>current,
  })
  return {ctx,adapter}
 }
 const first=await mount()
 const {agent:initial}=await first.ctx.agents.create({sessionId:SessionId('role-cold-restart'),agentOptions:{provider:'mock',model:'mock'}})
 initial.followup(createUserMessage({source:{kind:'user',rpcId:'before-restart'},content:[{type:'text',text:'第一轮'}]}));await initial.whenIdle()
 assert.equal(snapshots(initial).length,1)
 await first.ctx.fiber.dispose()
 const second=await mount();t.after(()=>second.ctx.fiber.dispose())
 const {agent:restored}=await second.ctx.agents.resume({resumeSessionId:initial.session.id,agentOptions:{provider:'mock',model:'mock'}})
 assert.equal(snapshots(restored).length,1)
 restored.followup(createUserMessage({source:{kind:'user',rpcId:'after-restart'},content:[{type:'text',text:'继续'}]}));await restored.whenIdle()
 assert.equal(snapshots(restored).length,1)
 current=role({version:2,duty:'新版职责'})
 restored.followup(createUserMessage({source:{kind:'user',rpcId:'after-edit'},content:[{type:'text',text:'再核对'}]}));await restored.whenIdle()
 assert.equal(snapshots(restored).length,2)
 assert.match(JSON.stringify(second.adapter.requests.at(-1)!.messages),/新版职责/)
})

test('官方 JSONL 冷恢复后关闭经验服务，新请求移除历史经验并保留岗位',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'teloa-experience-cold-'));t.after(()=>rm(directory,{recursive:true,force:true}))
 const mount=async(enabled:boolean)=>{
  const ctx=new Context()
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
  await ctx.plugin(JsonlSessionPersistence,{root:directory,compression:'none'})
  const adapter=new Adapter();ctx.llm.registerAdapter(['mock'],adapter)
  registerRoleConversationContext(ctx,{owner,conversation:async sessionId=>({id:'conversation-one',ownerId:owner,sessionId,status:'ready'}),requestedRoleId:async()=>roleId,links:async sessionId=>[{kind:'role',objectId:roleId,conversationId:'conversation-one',sessionId,scopeId:'general',active:true}],role:async()=>role(),...(enabled?{experience:async()=> '冷恢复前的固定经验正文'}:{})})
  return {ctx,adapter}
 }
 const first=await mount(true),{agent}=await first.ctx.agents.create({sessionId:SessionId('memory-cold-restart'),agentOptions:{provider:'mock',model:'mock'}})
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'before'},content:[{type:'text',text:'第一轮'}]}));await agent.whenIdle()
 assert.match(JSON.stringify(first.adapter.requests[0]!.messages),/冷恢复前的固定经验正文/)
 await first.ctx.fiber.dispose()
 const second=await mount(false);t.after(()=>second.ctx.fiber.dispose())
 const {agent:restored}=await second.ctx.agents.resume({resumeSessionId:agent.session.id,agentOptions:{provider:'mock',model:'mock'}})
 restored.followup(createUserMessage({source:{kind:'user',rpcId:'after'},content:[{type:'text',text:'继续'}]}));await restored.whenIdle()
 assert.doesNotMatch(JSON.stringify(second.adapter.requests[0]!.messages),/冷恢复前的固定经验正文/)
 assert.match(JSON.stringify(second.adapter.requests[0]!.messages),/核对 \{\{foo\}\} 告警/)
 assert.ok(restored.session.snapshotEvents().some(event=>event.type==='user/message'&&JSON.stringify(event.data).includes('冷恢复前的固定经验正文')),'审计事件保留原始来源')
})
