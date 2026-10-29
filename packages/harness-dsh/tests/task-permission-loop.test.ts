import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,LlmAdapter,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {until} from './fixtures/native-schedule-admission.ts'

type Cleanup={after:(callback:()=>unknown)=>void}
async function fixture(t:Cleanup,options:{employee?:boolean;ordinary?:boolean;native?:boolean;selfKnowledge?:boolean;employeeRead?:()=>Promise<boolean>}={}){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('permission-loop'),agentOptions:{provider:'permission-test',model:'finite',maxTokens:100}})
 let requestId='request-one',sequence=0,modelCalls=0,modelRequests=0,bodies=0
 for(const name of ['forbidden_read','business_read','teloa_tools_load','network_read','approval_read','teloa_knowledge_search'])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;if(name==='network_read')throw Error('synthetic network failure');return 'done'}}))
 ctx.on('llm/stream',async function*(request,next):AsyncIterable<StreamChunk>{modelRequests++;yield* next()},{global:true})
 const policy=()=>options.ordinary?null:{nativeRequestId:requestId,allowedTools:['business_read','teloa_tools_load','network_read','approval_read']}
 registerTaskToolGuard(ctx,async()=>policy(),options.selfKnowledge?['teloa_knowledge_search']:[],undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,async(_session,id)=>options.employeeRead?options.employeeRead():options.employee!==false&&id===requestId)
 ctx.on('tools/pre-execute',async(exec,next)=>exec.name==='approval_read'?{kind:'deny',reason:'本人拒绝审批'}:next())
 class Adapter extends LlmAdapter{
  override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
  async *stream(_request:GenerateOptions):AsyncIterable<StreamChunk>{
   modelCalls++
   if(options.native){const id=ToolCallId('native-denial-'+modelCalls);yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id,name:'forbidden_read',arguments:'{}'}};yield {type:'finish',reason:{kind:'tool-calls'}}}
   else yield {type:'finish',reason:{kind:'stop'}}
  }
 }
 ctx.llm.registerAdapter(['permission-test'],new Adapter())
 const message=()=>createUserMessage({source:{kind:'user',rpcId:requestId},content:[{type:'text',text:'合成的员工工作'}]})
 if(!options.native){agent.session.append('turn/start',{turn:0});agent.session.append('user/message',message(),{surfaceOp:'append'})}
 return {ctx,agent,message,modelCalls:()=>modelCalls,modelRequests:()=>modelRequests,bodies:()=>bodies,
  call:(name:string)=>ctx.tools.execute({agent,name,arguments:{},callId:ToolCallId('call-'+ ++sequence),signal:AbortSignal.timeout(5000)}),
  model:async()=>{for await(const _ of ctx.llm.stream({provider:'permission-test',model:'finite',messages:[],sessionId:agent.id,signal:AbortSignal.timeout(5000)})){}},
  newRequest:()=>{requestId='request-two';agent.session.append('user/message',message(),{surfaceOp:'append'})},
 }
}

test('一次本地拒绝后合法替代工具成功即重置；不能把普通失败或审批拒绝当本地权限循环',async t=>{
 const f=await fixture(t)
 await f.call('forbidden_read');await f.model();assert.equal(f.modelCalls(),1)
 await f.call('business_read');await f.call('forbidden_read');await f.model();assert.equal(f.modelCalls(),2)
 await f.call('network_read');await f.call('network_read');await f.call('approval_read');await f.call('approval_read');await f.model();assert.equal(f.modelCalls(),3)
})
test('第二次同类本地拒绝阻断下一模型；发现成功不充当业务进展，新请求不继承',async t=>{
 const f=await fixture(t)
 await f.call('forbidden_read');await f.call('teloa_tools_load');await f.call('teloa_tools_load');await f.model();assert.equal(f.modelCalls(),1,'第一拒绝后发现不提前触发硬停')
 await f.call('forbidden_read');await assert.rejects(f.model(),{code:'teloa/permission-stalled'});assert.equal(f.modelCalls(),1)
 f.newRequest();await f.model();assert.equal(f.modelCalls(),2)
})
test('owner执行与普通本人会话不受员工拒绝循环硬停影响',async t=>{
 for(const options of [{employee:false},{ordinary:true}]){
  const f=await fixture(t,options)
  await f.call('forbidden_read');await f.call('forbidden_read');await f.model();assert.equal(f.modelCalls(),1)
 }
})
test('原生Loop保留两次真实拒绝轨迹并以稳定码结束本轮，不派发第三次模型',{timeout:15000},async t=>{
 const f=await fixture(t,{native:true})
 f.agent.followup(f.message())
 await until(()=>f.agent.status==='idle'&&f.agent.inbox.nextTurn.length===0)
 const events=readSessionEvents(f.agent.session),end=[...events].reverse().find(event=>event.type==='turn/end')
 assert.equal(f.modelCalls(),2);assert.equal(f.modelRequests(),2,'在进入任何模型派发和预算hook前停止第三步');assert.equal(f.bodies(),0,'未授权工具体始终未派发')
 assert.equal(events.filter(event=>event.type==='tool/result'&&event.data.message.isError).length,2)
 if(end?.type!=='turn/end'||end.data.reason.kind!=='error')throw Error('本轮必须以原生错误收口')
 assert.equal(end.data.reason.error.code,'teloa/permission-stalled')
})

test('在途员工核对迟到时不把旧请求的停止结论套给新输入',async t=>{
 let release!:()=>void
 const waiting=new Promise<boolean>(resolve=>{release=()=>resolve(true)})
 const f=await fixture(t,{employeeRead:()=>waiting})
 await f.call('forbidden_read');await f.call('forbidden_read')
 const pending=f.model();await new Promise<void>(resolve=>setImmediate(resolve))
 f.newRequest();release();await pending;assert.equal(f.modelCalls(),1)
})

test('已核验自授权知识检索成功属于业务进展，清除此前的权限拒绝计数',async t=>{
 const f=await fixture(t,{selfKnowledge:true})
 await f.call('forbidden_read');assert.equal((await f.call('teloa_knowledge_search')).isError,false)
 await f.call('forbidden_read');await f.model();assert.equal(f.modelCalls(),1)
})
