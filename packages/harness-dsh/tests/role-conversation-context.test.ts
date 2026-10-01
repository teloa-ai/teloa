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
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
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
 const state={requested:roleId as string|null,links:[{kind:'role' as const,objectId:roleId,conversationId:'conversation-one',sessionId:agent.session.id,scopeId:'general',active:true}],role:role() as DigitalRole|null,failure:null as Error|null,roleFailure:null as Error|null,bindingOwner:owner,bindingMissing:false,purpose:undefined as 'task-run'|undefined,calls:{conversation:0,requested:0,links:0,role:0}}
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
 assert.deepEqual((await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent})).tools,before)
 await f.send('继续')
 assert.equal(snapshots(f.agent).length,1)
 f.state.role=role({version:2,duty:'核对新版告警'})
 await f.send('再核对')
 assert.equal(snapshots(f.agent).length,2)
 assert.match(JSON.stringify(f.adapter.requests.at(-1)!.messages),/核对新版告警/)
 assert.match(JSON.stringify(f.adapter.requests.at(-1)!.messages),/版本：2/)
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
 assert.match(JSON.stringify(f.adapter.requests[0]!.messages),/版本：4/)
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
