import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,createUserMessage,ToolCallId,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {restrictRunTools} from '../src/task-run-dsh.ts'
import {createReviewSourceCatalog,deliveryReviewToolName,leaseTaskDeliveryReview,type DeliveryReviewLease} from '../src/task-delivery-review.ts'

// 真正的 SDK 组装、循环、工具执行与回执；仅模型传输为合成 adapter，绝不调用 provider 或解释器。
class SyntheticAdapter extends LlmAdapter{
 requests:GenerateOptions[]=[]
 handler!:(request:GenerateOptions,index:number)=>AsyncGenerator<StreamChunk>
 override async resolveModel(provider:string,id:string){return {provider,id,name:id,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions){const index=this.requests.length;this.requests.push(options);yield* this.handler(options,index)}
}
async function* draft():AsyncGenerator<StreamChunk>{
 yield {type:'block-start',index:0,blockType:'text'}
 yield {type:'text-delta',index:0,text:'合成正文。'}
 yield {type:'block-end',index:0,block:{type:'text',text:'合成正文。'}}
 yield {type:'finish',reason:{kind:'stop'}}
}
async function* submit(index:number,args:Record<string,unknown>):AsyncGenerator<StreamChunk>{
 yield {type:'block-start',index:0,blockType:'tool-call'}
 yield {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('review-'+index),name:deliveryReviewToolName,arguments:JSON.stringify(args)}}
 yield {type:'finish',reason:{kind:'tool-calls'}}
}
const revise={phase:'revise',issues:[]}
const verify={phase:'verify',verdict:'accept',checks:['goal',1,2,3,4,5,6,7,8].map(id=>({id,status:'pass'})),changeChecks:[],findings:[]}
async function runtime(t:TestContext,language:'typescript'|'python'='typescript',ownedNative=false){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt])await ctx.plugin(plugin)
 ctx.provide('ptcRuntime',{language,isolation:'fixture',resolve:(request:unknown)=>request,run:async()=>{throw Error('不得执行解释器')}} as never)
 await ctx.plugin(ToolRuntime,{mode:'ptc'});await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new SyntheticAdapter();ctx.llm.registerAdapter(['capture'],adapter)
 const {agent}=await ctx.agents.create({sessionId:SessionId('review-presentation-'+randomUUID()),agentOptions:{provider:'capture',model:'synthetic'}})
 const nativeRelease=ownedNative?agent.ctx.tools.presentAs('native'):undefined
 const restrictRelease=restrictRunTools(agent,[],{group:false,digest:false})
 const goal='仅核对全新合成文本。',requestId=randomUUID(),material={goal,inputs:{knowledge:0,group:false,context:false},methods:[],catalog:createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:goal,origin:{field:'inputText',pointer:'/task/goal'}}])}
 const traces:string[]=[]
 const lease=(publish?:DeliveryReviewLease['publish'])=>leaseTaskDeliveryReview(agent,{runId:randomUUID(),requestId,material,trace:row=>traces.push(row.state),publish:publish??(async message=>{agent.inject(message)})})
 const start=()=>agent.followup(createUserMessage({source:{kind:'user',rpcId:requestId},content:[{type:'text',text:goal}]}))
 const assemble=()=>ctx.systemPrompt.assemble({agent,scope:agent})
 return {ctx,agent,adapter,lease,start,traces,assemble,nativeRelease,restrictRelease}
}

for(const language of ['typescript','python']as const)test('PTC '+language+' 真实三步复核仅临时原生呈现，完成后恢复原 PTC',async t=>{
 const f=await runtime(t,language),release=f.lease();let outputSchema:unknown
 assert.ok(f.agent.ctx.tools.get('run_code',f.agent))
 f.adapter.handler=async function*(options,index){
  if(index===0){assert.deepEqual(options.tools?.map(t=>t.name),['run_code']);yield* draft();return}
  assert.deepEqual(options.tools?.map(t=>t.name),[deliveryReviewToolName])
  assert.equal(f.agent.ctx.tools.get('run_code',f.agent),undefined)
  // 官方 SDK 在 native 下保留空 section 注册，实际渲染为空；不把空注册误当仍有 PTC 声明。
  const assembly=await f.assemble();assert.ok(!assembly.sections.some(s=>s.name==='tools:sdk'&&s.text.trim().length>0))
  assert.equal(Reflect.get(options.tools![0]!.parameters,'additionalProperties'),false)
  const schema=f.agent.ctx.tools.get(deliveryReviewToolName,f.agent)!.output.schema
  if(index===1)outputSchema=structuredClone(schema);else assert.deepEqual(schema,outputSchema)
  yield* submit(index,index===1?revise:verify)
 }
 f.start();await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,3);assert.ok(f.traces.includes('applied'));assert.ok(f.traces.includes('delivered'))
 assert.ok(f.agent.ctx.tools.get('run_code',f.agent));assert.ok(!(await f.assemble()).tools.some(t=>t.name===deliveryReviewToolName))
 const nativeAgain=f.agent.ctx.tools.presentAs('native');nativeAgain();assert.ok(f.agent.ctx.tools.get('run_code',f.agent),'没有遗留同层 native 声明')
 release();f.restrictRelease()
})

test('已有同 scope native 呈现不重复覆盖，复核结束与显式释放均保留调用方 native',async t=>{
 const f=await runtime(t,'typescript',true),release=f.lease()
 f.adapter.handler=async function*(options,index){if(index===0){yield* draft();return}assert.deepEqual(options.tools?.map(t=>t.name),[deliveryReviewToolName]);yield* submit(index,index===1?revise:verify)}
 f.start();await f.agent.whenIdle();assert.equal(f.adapter.requests.length,3);assert.ok(f.traces.includes('delivered'))
 release();assert.equal(f.agent.ctx.tools.get('run_code',f.agent),undefined)
 f.nativeRelease!();assert.ok(f.agent.ctx.tools.get('run_code',f.agent));f.restrictRelease()
})

test('复核 schema 真正拒绝后失败，原 PTC 恢复且不产生接受回执',async t=>{
 const f=await runtime(t),release=f.lease()
 f.adapter.handler=async function*(options,index){if(index===0){yield* draft();return}assert.deepEqual(options.tools?.map(t=>t.name),[deliveryReviewToolName]);yield* submit(index,{phase:'invalid'})}
 f.start();await f.agent.whenIdle();assert.ok(f.traces.includes('failed'));assert.ok(!f.traces.includes('applied'))
 assert.ok(f.agent.ctx.tools.get('run_code',f.agent));release();f.restrictRelease()
})

test('publish 拒绝会恢复呈现，不发送第二次模型请求',async t=>{
 const f=await runtime(t),release=f.lease(async()=>{assert.equal(f.agent.ctx.tools.get('run_code',f.agent),undefined);throw Error('synthetic publish denied')})
 f.adapter.handler=async function*(){yield* draft()};f.start();await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,1);assert.ok(f.traces.includes('failed'));assert.ok(f.agent.ctx.tools.get('run_code',f.agent));release();f.restrictRelease()
})

for(const action of ['cancel','release']as const)test('复核在途 '+action+' 按真实 SDK 终态恢复原 PTC',async t=>{
 const f=await runtime(t),release=f.lease();let entered!:()=>void
 const started=new Promise<void>(resolve=>{entered=resolve})
 f.adapter.handler=async function*(options,index){
  if(index===0){yield* draft();return}
  assert.deepEqual(options.tools?.map(t=>t.name),[deliveryReviewToolName]);assert.ok(options.signal)
  entered()
  await new Promise<void>(resolve=>{if(options.signal!.aborted){resolve();return}options.signal!.addEventListener('abort',()=>resolve(),{once:true})})
  options.signal!.throwIfAborted()
 }
 f.start();await started;assert.equal(f.agent.ctx.tools.get('run_code',f.agent),undefined)
 if(action==='release'){release();assert.ok(f.agent.ctx.tools.get('run_code',f.agent))}
 f.agent.cancel({kind:'user'});await f.agent.whenIdle();assert.ok(f.agent.ctx.tools.get('run_code',f.agent))
 assert.ok(!f.traces.includes('applied'));release();f.restrictRelease()
})
