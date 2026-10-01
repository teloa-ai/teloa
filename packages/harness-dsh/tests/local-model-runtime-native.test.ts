import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry,installModelSelection,type Agent} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmRuntime,LlmAdapter,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {TokenMeter} from '@deepseek-ai/dsh-token-meter'
import {BasicCompactionEngine} from '@deepseek-ai/dsh-compaction-basic'
import {LocalModelCompaction,localCompactionConfig} from '../src/local-model-compaction.ts'
import {installLocalModelRequests,estimateLocalRequest} from '../src/local-model-request.ts'
import {installTaskModelRouting} from '../src/task-model-routing.ts'
import {createLocalModelsHandler} from '../src/local-models.ts'
import {OllamaClient} from '../src/ollama-client.ts'
import {startOllamaStub,type StubOptions} from './fixtures/ollama-stub.ts'
import {tempHome} from './fixtures/credentials.ts'

const name='local:small',digest='sha256:'+'a'.repeat(64)
const answer:StreamChunk[]=[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:'done'},{type:'block-end',index:0,block:{type:'text',text:'done'}},{type:'finish',reason:{kind:'stop'}}]
async function setup(t:TestContext,capacity=8192){
 const runtimeRoot=await tempHome(t)
 const options:StubOptions={models:[{name,size:10,digest,allocatedContext:capacity}]}
 const stub=await startOllamaStub(options);t.after(stub.close)
 await writeFile(join(runtimeRoot,'local-models.json'),JSON.stringify({format:'teloa.local-models/v1',address:{baseURL:stub.baseURL,custom:true,updatedAt:'2026-09-26T00:00:00Z'},records:[{entryId:null,version:null,variant:null,name,digest,status:'attached',routeModelId:name,at:'2026-09-26T00:00:00Z'}]}))
 const route={api:'openai-completions',baseURL:stub.baseURL+'/v1',models:[{id:name,contextWindow:capacity,maxTokens:capacity/2}]}
 let revision=1
 const settings={writable:true,describe:()=>[{ns:'llm-pi-ai',revision,value:{providers:{ollama:route}}}],mutate:async(_ns:string,ops:readonly {op:string;path:readonly string[];value?:unknown}[],expected?:number)=>{assert.equal(expected,revision);assert.equal(ops.length,1);route.models=ops[0]!.value as typeof route.models;revision++}}
 const handler=createLocalModelsHandler({runtimeRoot,catalog:()=>[],settings,credentials:{describe:async()=>({configured:true,writable:true}),set:async()=>{throw Error('请求不能改凭据')}},client:address=>new OllamaClient(address),logger:{info(){},warn(){}}});t.after(handler.dispose)
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(TokenMeter)
 const requests:GenerateOptions[]=[]
 class Adapter extends LlmAdapter{
  override async resolveModel(provider:string,model:string){const configured=route.models.find(row=>row.id===model);return {provider,id:model,name:model,inputModalities:['text'] as const,...(configured?{defaultMaxTokens:configured.maxTokens,context:{contextWindow:configured.contextWindow}}:{})}}
  async *stream(input:GenerateOptions){requests.push(input);yield* answer}
 }
 ctx.llm.registerAdapter(['ollama','remote'],new Adapter())
 installLocalModelRequests(ctx,handler)
 const {agent}=await ctx.agents.create({sessionId:SessionId('local-runtime'),agentOptions:{provider:'ollama',model:name}})
 const selection={current:{provider:'ollama',model:name},assembled:undefined};installModelSelection(agent.ctx,selection)
 return {ctx,agent,handler,stub,options,route,requests,selection}
}
async function run(agent:Agent,text='hello'){agent.followup(createUserMessage({source:{kind:'user',rpcId:'input'},content:[{type:'text',text}]}));await agent.whenIdle()}

test('真实循环每轮按实际容量记录预算，容量变小不沿用旧 requestProposal',async t=>{
 const {agent,stub,route,requests,selection}=await setup(t)
 await run(agent)
 assert.equal(requests[0]!.maxTokens,4096)
 stub.models[0]!.allocatedContext=2048
 await run(agent)
 assert.equal(requests[1]!.maxTokens,1024)
 assert.equal(agent.session.requestHeader()?.config.maxTokens,1024)
 assert.equal(route.models[0]!.contextWindow,2048)
 assert.deepEqual(selection.current,{provider:'ollama',model:name})
 assert.equal(stub.calls.filter(row=>row.path==='/api/chat').length,2)
 assert.ok(stub.calls.filter(row=>row.path==='/api/chat').every(row=>JSON.stringify(row.body)===JSON.stringify({model:name,messages:[],stream:false})))
})

test('固定任务不先加载普通会话默认；加载故障同一轮切到明确远程',async t=>{
 const {agent,handler,stub,requests,selection,options}=await setup(t)
 selection.current={provider:'ollama',model:'wrong-default'}
 options.loadError='internal details'
 const switches:unknown[]=[]
 const routing=installTaskModelRouting(agent,{primary:{provider:'ollama',model:name},fallback:{provider:'remote',model:'fallback'}},{prepareRequest:handler.prepareRequest,isRemote:async()=>true,requiresImages:()=>false,recordRecovery:async value=>{switches.push(value)}});t.after(routing.dispose)
 await run(agent)
 assert.deepEqual(requests.map(row=>row.model),['fallback'])
 assert.equal(stub.calls.filter(row=>row.path==='/api/chat').length,1)
 assert.equal((stub.calls.find(row=>row.path==='/api/chat')!.body as any).model,name)
 assert.equal(switches.length,1)
 assert.equal(agent.session.snapshotEvents().filter(row=>row.type==='turn/start').length,1)
 assert.equal(agent.session.snapshotEvents().filter(row=>row.type==='user/message'&&row.data.source.kind==='user').length,1)
 assert.deepEqual(selection.current,{provider:'ollama',model:'wrong-default'})
})

test('容量在 prepare 后再缩小：发送门禁进入官方压缩，同一步重试不丢历史',async t=>{
 const {ctx,agent,stub,requests}=await setup(t,16000)
 // 官方默认预算针对大窗口；此用例显式用官方配置核对小窗口的恢复接缝。
 await agent.ctx.plugin(BasicCompactionEngine,{headroomTokens:128,maxTokens:256,retainTokens:256,compactionRetries:0,maxOverflowRetries:1})
 await run(agent,'a'.repeat(9000))
 assert.equal(requests.length,1)
 let shrunk=false,overflows=0
 agent.ctx.on('agent/request-error',async(payload,next)=>{if(payload.failure.code==='CONTEXT_WINDOW_EXCEEDED')overflows++;return next()},{prepend:true})
 // 此监听先于最终 guard：模拟其他客户端在模型准备之后改变分配。
 ctx.on('llm/stream',async function*(input,next){if(!shrunk&&input.purpose===undefined){shrunk=true;stub.models[0]!.allocatedContext=6000};yield* next()},{prepend:true})
 await run(agent,'请保留之前内容后继续')
 assert.equal(overflows,1)
 assert.equal(requests.filter(row=>row.purpose==='compaction').length,1)
 assert.equal(requests.filter(row=>row.purpose===undefined).length,2)
 assert.equal(requests.at(-1)!.maxTokens,3000)
 const events=agent.session.snapshotEvents()
 assert.equal(events.filter(row=>row.type==='step/start').length,2,'重试不新增步骤')
 assert.ok(events.some(row=>row.type==='compaction/end'),'压缩真实提交到原生日志')
 assert.ok(events.some(row=>row.type==='user/message'&&row.data.content.some(block=>block.type==='text'&&block.text.length===9000)),'原消息仍保留在历史')
 assert.equal(events.filter(row=>row.type==='turn/end').at(-1)?.data.reason.kind,'completed')
})

test('产品默认小窗口策略可自动压缩，无测试特设预算或新轮次',async t=>{
 const {ctx,agent,stub,requests}=await setup(t,16000)
 await agent.ctx.plugin(LocalModelCompaction)
 await run(agent,'a'.repeat(9000))
 let shrunk=false
 ctx.on('llm/stream',async function*(input,next){if(!shrunk&&input.purpose===undefined){shrunk=true;stub.models[0]!.allocatedContext=6000};yield* next()},{prepend:true})
 await run(agent,'保留之前内容继续')
 const summaries=requests.filter(row=>row.purpose==='compaction')
 assert.equal(summaries.length,1)
 assert.equal(summaries[0]!.maxTokens,750)
 assert.equal(requests.at(-1)!.maxTokens,3000)
 const events=agent.session.snapshotEvents()
 assert.ok(events.some(row=>row.type==='compaction/end'))
 assert.equal(events.filter(row=>row.type==='step/start').length,2)
 assert.equal(events.filter(row=>row.type==='turn/end').at(-1)?.data.reason.kind,'completed')
 assert.ok(agent.ctx.get('compaction') instanceof LocalModelCompaction,'临时 backend 不覆盖常驻服务')
 const runtime=ctx.registry.get(BasicCompactionEngine)
 assert.equal(runtime?.fibers.length??0,0,'临时 backend 生命周期已释放')
})

test('本地压缩配置只收紧精确模型，保留云端默认和显式摘要目标',async t=>{
 const {agent}=await setup(t)
 await agent.ctx.plugin(LocalModelCompaction,{modelPolicies:[{provider:'ollama',model:name,maxTokens:128,headroomTokens:64,summarizationProvider:'remote',summarizationModel:'summary'},{provider:'remote',model:'large',maxTokens:65536}]})
 const engine=agent.ctx.get('compaction') as LocalModelCompaction
 const before=structuredClone(engine.config)
 const projected=localCompactionConfig(engine.config,'ollama',name,4096)
 assert.deepEqual(engine.config,before)
 assert.equal(projected.maxTokens,65536)
 assert.equal(projected.modelPolicies?.find(row=>row.provider==='remote')?.maxTokens,65536)
 assert.equal(projected.modelPolicies?.find(row=>row.provider==='ollama')?.maxTokens,128)
 assert.equal(projected.modelPolicies?.find(row=>row.provider==='ollama')?.summarizationModel,'summary')
 const {retainTokens:_retainTokens,retainRatio:_retainRatio,...shared}=engine.config
 const explicit=localCompactionConfig({...shared,retainRatio:0.1},'ollama',name,4096,false)
 assert.equal(explicit.retainRatio,0.1)
 assert.equal(explicit.modelPolicies?.find(row=>row.provider==='ollama')?.retainTokens,undefined,'显式保留策略不应被默认零保留覆盖')
 const remoteSummary=localCompactionConfig({...shared,summarizationProvider:'remote',summarizationModel:'summary-large',retainRatio:0.16,modelPolicies:[]},'ollama',name,4096)
 assert.equal(remoteSummary.modelPolicies?.[0]?.maxTokens,65536,'显式另一摘要模型不能按会话小窗口降低摘要预算')
})

test('轮次之间容量缩小，旧请求头的输出预算不阻断新轮次原生恢复',async t=>{
 const {agent,stub,requests}=await setup(t,16000)
 await agent.ctx.plugin(LocalModelCompaction)
 await run(agent,'a'.repeat(9000))
 assert.equal(agent.session.requestHeader()?.config.maxTokens,8000)
 stub.models[0]!.allocatedContext=4096
 await run(agent,'继续之前工作')
 assert.equal(requests.at(-1)?.maxTokens,2048)
 assert.equal(requests.find(row=>row.purpose==='compaction')?.maxTokens,512)
 assert.equal(agent.session.snapshotEvents().filter(row=>row.type==='turn/end').at(-1)?.data.reason.kind,'completed')
})

for(const capacity of [4096,8192])test(`${capacity} 实际窗口使用产品默认压力策略提前压缩`,async t=>{
 const {agent,requests}=await setup(t,capacity)
 await agent.ctx.plugin(LocalModelCompaction)
 let overflows=0
 agent.ctx.on('agent/request-error',async(payload,next)=>{if(payload.failure.code==='CONTEXT_WINDOW_EXCEEDED')overflows++;return next()},{prepend:true})
 await run(agent,'a'.repeat(Math.floor(capacity*0.8)))
 await run(agent,'b'.repeat(Math.floor(capacity*0.8)))
 await run(agent,'继续')
 assert.equal(overflows,0)
 assert.equal(requests.filter(row=>row.purpose==='compaction').length,1)
 assert.equal(requests.find(row=>row.purpose==='compaction')?.maxTokens,capacity/8)
 assert.equal(agent.session.snapshotEvents().filter(row=>row.type==='turn/end').at(-1)?.data.reason.kind,'completed')
})

test('手工压缩同样适配本地窗口，切到远程后恢复原生预算且不访问 Ollama',async t=>{
 const {agent,requests,stub,selection}=await setup(t,4096)
 await agent.ctx.plugin(LocalModelCompaction)
 const engine=agent.ctx.get('compaction') as LocalModelCompaction
 await run(agent,'a'.repeat(6000))
 assert.ok(await engine.compactNow(agent,new AbortController().signal))
 assert.equal(requests.find(row=>row.purpose==='compaction')?.maxTokens,512)
 selection.current={provider:'remote',model:'remote-large'}
 await run(agent,'b'.repeat(6000))
 // 切换前的压力检查仍以最后一条持久请求为依据；远程请求落盘之后不再访问本地服务。
 const calls=stub.calls.length
 assert.ok(await engine.compactNow(agent,new AbortController().signal))
 assert.equal(requests.at(-1)?.provider,'remote')
 assert.equal(requests.at(-1)?.maxTokens,65536)
 assert.equal(stub.calls.length,calls)
})

test('取消正在生成的摘要不替换历史，临时原生 backend 正常释放',async t=>{
 const {ctx,agent}=await setup(t,4096)
 await agent.ctx.plugin(LocalModelCompaction)
 await run(agent,'a'.repeat(6000))
 const engine=agent.ctx.get('compaction') as LocalModelCompaction
 const generation=agent.session.surface.replaceGeneration
 let entered:()=>void=()=>{}
 const started=new Promise<void>(resolve=>{entered=resolve})
 ctx.on('llm/stream',async function*(options,next){
  if(options.purpose!=='compaction'){yield* next();return}
  entered()
  await new Promise<void>((_resolve,reject)=>{options.signal!.addEventListener('abort',()=>reject(options.signal!.reason),{once:true})})
 },{prepend:true})
 const controller=new AbortController()
 const rejected=assert.rejects(engine.compactNow(agent,controller.signal))
 await started;controller.abort();await rejected
 assert.equal(agent.session.surface.replaceGeneration,generation)
 assert.equal(ctx.registry.get(BasicCompactionEngine)?.fibers.length??0,0)
 assert.equal(agent.status,'idle')
})

test('共享预设两会话并发压缩各用独立原生 backend，不串配置和历史',async t=>{
 const {ctx,agent}=await setup(t,4096)
 await ctx.plugin(LocalModelCompaction)
 const {agent:second}=await ctx.agents.create({sessionId:SessionId('second-local'),agentOptions:{provider:'ollama',model:name}})
 await Promise.all([run(agent,'a'.repeat(6000)),run(second,'b'.repeat(6000))])
 const engine=ctx.get('compaction') as LocalModelCompaction
 const results=await Promise.all([agent,second].map(owner=>engine.compactNow(owner,new AbortController().signal)))
 assert.ok(results.every(Boolean))
 assert.ok([agent,second].every(owner=>owner.session.surface.replaceGeneration===1))
 assert.equal(engine.config.maxTokens,65536)
 assert.equal(ctx.registry.get(BasicCompactionEngine)?.fibers.length??0,0)
})

test('无可压缩历史时明确结束，辅助请求不绕过预算或覆盖记录',async t=>{
 const {ctx,agent,requests}=await setup(t,1024)
 await agent.ctx.plugin(BasicCompactionEngine,{headroomTokens:64,maxTokens:128})
 await run(agent,'x'.repeat(10000))
 assert.equal(requests.length,0)
 const events=agent.session.snapshotEvents()
 assert.equal(events.filter(row=>row.type==='turn/end').at(-1)?.data.reason.kind,'error')
 const header=agent.session.requestHeader()
 const chunks=[]
 for await(const chunk of ctx.llm.stream({provider:'ollama',model:name,maxTokens:4096,purpose:'compaction',messages:[{role:'user',content:[{type:'text',text:'small'}]}]}))chunks.push(chunk)
 assert.equal(chunks.at(-1)?.type,'finish')
 assert.equal(requests.length,0)
 assert.deepEqual(agent.session.requestHeader(),header)
})

test('提供方回报零用量也不能绕过实际消息预算检查',async t=>{
 const {ctx,agent,requests}=await setup(t,4096)
 ctx.on('llm/stream',async function*(options,next){
  for await(const chunk of next()){
   if(chunk.type==='finish')yield {type:'usage',usage:{inputTokens:0,outputTokens:0,totalTokens:0}}
   yield chunk
  }
 },{prepend:true})
 await run(agent,'a'.repeat(3000))
 assert.equal(requests.length,1)
 await run(agent,'b'.repeat(6000))
 assert.equal(requests.length,1,'请求内容超限时不得因零用量下发')
 assert.equal(agent.session.snapshotEvents().filter(row=>row.type==='turn/end').at(-1)?.data.reason.kind,'error')
})

test('辅助计量按实际选出的消息、system 与工具，不混入完整会话',async t=>{
 const {ctx}=await setup(t)
 const input:GenerateOptions={provider:'ollama',model:name,messages:[{role:'user',content:[{type:'text',text:'hello'}]}],maxTokens:12}
 const base=estimateLocalRequest(ctx,input)
 assert.ok(base>0&&base<20)
 assert.ok(estimateLocalRequest(ctx,{...input,system:'x'.repeat(400),tools:[{name:'find',description:'x'.repeat(800),parameters:{type:'object'}}]})>base+250)
})


test('辅助图片估算复用提供方 visualTokens，不用图片句柄长度冒充视觉预算',async t=>{
 const {ctx}=await setup(t)
 class ImagePricing extends LlmAdapter{
  override imageRequestPricing(){return {priceImages:(images:readonly unknown[])=>images.map(()=>({visualTokens:2048,text:'image reference'}))}}
  async *stream():AsyncIterable<StreamChunk>{throw Error('计量不能调用模型')}
 }
 ctx.llm.registerAdapter(['priced-images'],new ImagePricing())
 const input:GenerateOptions={provider:'priced-images',model:'vision',messages:[{role:'user',content:[{type:'image',attachment:{attachmentId:'test-image' as never,mediaType:'image/png',bytes:128,width:640,height:480}}]}]}
 assert.ok(estimateLocalRequest(ctx,input)>=2048)
})


for(const status of [401,403,404,429])test(`加载 HTTP ${status} 按稳定模型故障分类，不把授权拒绝切到云端`,async t=>{
 const {agent,handler,options,requests}=await setup(t)
 options.loadError='not exposed';options.loadErrorStatus=status
 const switches:unknown[]=[]
 const routing=installTaskModelRouting(agent,{primary:{provider:'ollama',model:name},fallback:{provider:'remote',model:'fallback'}},{prepareRequest:handler.prepareRequest,isRemote:async()=>true,requiresImages:()=>false,recordRecovery:async row=>{switches.push(row)}});t.after(routing.dispose)
 await run(agent)
 const recoverable=status===404||status===429
 assert.equal(switches.length,recoverable?1:0)
 assert.deepEqual(requests.map(row=>row.provider),recoverable?['remote']:[])
})
