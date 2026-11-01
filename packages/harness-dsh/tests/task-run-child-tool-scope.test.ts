import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {registerTaskRunTextScope,type TaskRunToolScopeReader} from '../src/task-run-text-scope.ts'

async function fixture(withScopeReader=true){
 const ctx=new Context();let models=0,executions=0
 class NeverAdapter extends LlmAdapter{
  async resolveModel(provider:string,id:string){return {provider,id,name:id,inputModalities:['text' as const]}}
  async *stream():AsyncGenerator<never>{models++;throw Error('本测试禁止模型')}
 }
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]});ctx.llm.registerAdapter(['offline-never'],new NeverAdapter())
 const options={provider:'offline-never',model:'never'},parent=(await ctx.agents.create({sessionId:SessionId('managed-parent'),agentOptions:options})).agent
 const child=(await ctx.agents.create({sessionId:SessionId('managed-child'),parentAgent:parent,meta:{parentSession:parent.id,origin:'subagent',delegationDepth:1},agentOptions:options})).agent
 for(const name of ['subagent_task','teloa_role_memory_propose','read','bash','write','teloa_business_records_write','teloa_group_attach','teloa_role_day_evidence'])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:()=>[]},execute:async()=>{executions++;throw Error('本测试禁止工具执行')}}))
 let allowed:string[]=['subagent_task'],requestId='original-run',managed=true,scopeAvailable=true,digest=false,group=false,textOnly=false,stopRequested=false
 let scopePause:(()=>Promise<void>)|undefined
 const readPolicy=async(id:string)=>id===parent.id&&managed?{allowedTools:[...allowed],nativeRequestId:requestId,textOnly,stopRequested}:null
 const readScope:TaskRunToolScopeReader=async(id,rpcId)=>{
  assert.equal(id,parent.id);const pause=scopePause;scopePause=undefined;await pause?.()
  const groupContext={taskId:'task',groupId:'group',groupVersion:1,roleId:'role',roleVersion:1,grantVersion:1,source:{messageId:'m',rootId:'m',text:'单元资料',createdAt:'2026-10-31T00:00:00Z'},materials:[],files:[]}
  return scopeAvailable?{run:{sessionId:parent.id,nativeRequestId:rpcId,inputText:'{}',...(group?{groupContext}:{})},digest}:null
 }
 registerTaskRunTextScope(ctx,readPolicy,()=>{throw Error('非text子会话不能借用父RPC安装text租约')},withScopeReader?readScope:undefined)
 const assemble=(agent:Agent=child)=>agent.ctx.systemPrompt.assemble({agent,scope:agent})
 return{ctx,parent,child,assemble,setAllowed:(names:string[])=>{allowed=names},setRequest:(value:string)=>{requestId=value},setManaged:(value:boolean)=>{managed=value},setScopeAvailable:(value:boolean)=>{scopeAvailable=value},setDigest:(value:boolean)=>{digest=value},setGroup:(value:boolean)=>{group=value},setTextOnly:(value:boolean)=>{textOnly=value},setStopRequested:(value:boolean)=>{stopRequested=value},delayNextScope:(pause:()=>Promise<void>)=>{scopePause=pause},counts:()=>({models,executions})}
}

test('真实SDK child无父本地租约的冷组装按root政策收窄，覆盖child自有及迟注册schema',async()=>{
 const f=await fixture()
 try{
  f.child.ctx.tools.register(defineTool({name:'child_local_write',description:'不得进入模型',parameters:{},output:{schema:{type:'string'},render:()=>[]},execute:async()=>{throw Error('不可执行')}}))
  const first=await f.assemble();assert.deepEqual(first.tools.map(t=>t.name).sort(),['subagent_task','teloa_role_memory_propose'])
  f.child.ctx.tools.register(defineTool({name:'late_child_write',description:'迟注册仍不能扩大目录',parameters:{},output:{schema:{type:'string'},render:()=>[]},execute:async()=>{throw Error('不可执行')}}))
  f.child.ctx.systemPrompt.section({name:'tool:late_child_write',order:0,text:'不应广告未授权写工具'})
  const second=await f.assemble();assert.deepEqual(second.tools.map(t=>t.name).sort(),['subagent_task','teloa_role_memory_propose']);assert.ok(!second.sections.some(s=>s.name==='tool:late_child_write'))
  assert.deepEqual(f.counts(),{models:0,executions:0})
 }finally{await f.ctx.fiber.dispose()}
})
test('child按同一applicability保留真正群/每日小结工具，普通个人root无managed policy保持原目录',async()=>{
 for(const kind of ['group','digest','ordinary']as const){const f=await fixture();try{
  if(kind==='group')f.setGroup(true);if(kind==='digest')f.setDigest(true);if(kind==='ordinary')f.setManaged(false)
  const names=(await f.assemble()).tools.map(t=>t.name)
  if(kind==='group'){assert.ok(names.includes('teloa_group_attach'));assert.ok(!names.includes('teloa_role_day_evidence'));assert.ok(!names.includes('write'))}
  if(kind==='digest')assert.deepEqual(names,['teloa_role_day_evidence'])
  if(kind==='ordinary'){assert.ok(names.includes('bash'));assert.ok(names.includes('write'));assert.ok(names.includes('teloa_business_records_write'))}
 }finally{await f.ctx.fiber.dispose()}}
})
test('已受管child后续组装只会收窄，不接受root请求替换或managed降级',async()=>{
 const f=await fixture();try{
  f.setAllowed(['read']);assert.ok((await f.assemble()).tools.some(t=>t.name==='read'))
  f.setAllowed(['read','write']);assert.ok(!(await f.assemble()).tools.some(t=>t.name==='write'))
  f.setAllowed([]);assert.ok(!(await f.assemble()).tools.some(t=>t.name==='read'))
  f.setRequest('replacement');await assert.rejects(f.assemble(),/运行|授权|身份/)
 }finally{await f.ctx.fiber.dispose()}
 const g=await fixture();try{await g.assemble();g.setManaged(false);await assert.rejects(g.assemble(),/运行|授权|身份/)}finally{await g.ctx.fiber.dispose()}
})
test('已知managed child缺失scope或父级离线时拒绝，不把未知解释为普通会话',async()=>{
 const f=await fixture();try{f.setScopeAvailable(false);await assert.rejects(f.assemble(),/范围|授权|运行/)}finally{await f.ctx.fiber.dispose()}
 const g=await fixture();try{
  const original=g.ctx.agents.get.bind(g.ctx.agents)
  g.ctx.agents.get=((id:SessionId)=>id===g.parent.id?undefined:original(id)) as typeof g.ctx.agents.get
  await assert.rejects(g.assemble(),/谱系|授权|父|范围/)
 }finally{await g.ctx.fiber.dispose()}
})

test('缺接线的managed child拒绝，受限文本和停止中的child不保留自授权工具',async()=>{
 const missing=await fixture(false);try{await assert.rejects(missing.assemble(),/范围|授权|运行/)}finally{await missing.ctx.fiber.dispose()}
 for(const kind of ['text','stop']as const){const f=await fixture(false);try{
  if(kind==='text')f.setTextOnly(true);else f.setStopRequested(true)
  assert.deepEqual((await f.assemble()).tools,[])
 }finally{await f.ctx.fiber.dispose()}}
})

test('并发冷组装的迟返回不能覆盖已经收窄的child目录',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void
 const paused=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 try{
  f.setAllowed(['read','write']);f.delayNextScope(async()=>{entered();await gate})
  const slow=f.assemble();await paused
  f.setAllowed(['read']);assert.ok(!(await f.assemble()).tools.some(t=>t.name==='write'))
  f.setAllowed(['read','write']);release()
  assert.ok(!(await slow).tools.some(t=>t.name==='write'))
 }finally{release();await f.ctx.fiber.dispose()}
})
