import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {captureRetrievalPreparation,WorkError,readRetrievalSearchResult,retrievalEndpoints,type RetrievalSearchResult} from '@teloa/contract'
import type {ResourceActor} from '@teloa/backend'
import {registerLocalRetrieval,readEmbeddingProvider,knowledgeSearchToolName,embeddingProviderId,type LocalRetrievalPorts,type EmbeddingServiceLike} from '../src/local-retrieval.ts'
import {retrievalPreparationDetails} from '../../local-embedding/src/preparation-details.ts'
import {registerTaskToolGuard,type TaskToolPolicy} from '../src/task-tool-guard.ts'

const owner='local:teloa-owner',sessionId='retrieval-session',profileHash='a'.repeat(64),sha='b'.repeat(64)
const preparationDetails=retrievalPreparationDetails('fp32','/test/models','/test/runtime')
const resourceId='11111111-1111-4111-8111-111111111111'
const human:ResourceActor={ownerId:owner,kind:'human',scopeIds:['general','design']}
const fixture:RetrievalSearchResult={
 coverage:{searched:[{resourceId,title:'差旅报销制度',version:3}],pending:[],note:'仅检索已加入本地检索且当前会话有权读取的资料，不是全部资料。'},
 results:[{resourceId,resourceVersion:3,title:'差旅报销制度',sourceId:'src_policy',sourceVersion:sha,lines:[4,6],chars:[30,88],heading:'差旅报销制度 > 审批流程',score:0.71,excerpt:'报销单先由部门负责人审批，再交财务复核。'}],
}

type Deferred={promise:Promise<void>;resolve:()=>void}
const deferred=():Deferred=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}

function stubEmbedding(phase:string,hooks:{onEmbed?:()=>void}={}){
 const prepared:string[]=[],cancelled:string[]=[],embedded:{id:string;kind:string;texts:string[]}[]=[],sources:unknown[]=[]
 const service:EmbeddingServiceLike={
  snapshot:()=>({providers:[{id:embeddingProviderId,location:'host-local',catalogId:'teloa.model.qwen3-embedding-0-6b',catalogVersion:'1.0.0',profileHash,variant:'fp32',preparationDetails,totalMemoryBytes:16*1024**3,memoryRisk:false,preparation:phase==='downloading'?{phase,stage:'assets',resource:'onnx/model.onnx',completedBytes:1,totalBytes:2}:phase==='loading'||phase==='checking'||phase==='cancelling'?{phase,startedAt:1}:phase==='failed'?{phase,message:'准备失败'}:{phase}}]}),
  prepare:(id,options)=>{prepared.push(id);sources.push(options?.source)},
  cancelPreparation:async id=>{cancelled.push(id)},
  embed:async(id,input)=>{embedded.push({id,kind:input.kind,texts:[...input.texts]});hooks.onEmbed?.();return {profileHash,vectors:input.texts.map(()=>new Float32Array(1024))}},
 }
 return {service,prepared,cancelled,embedded,sources}
}

const expectedFor=(service:EmbeddingServiceLike)=>captureRetrievalPreparation(readEmbeddingProvider(service.snapshot(),embeddingProviderId)!)

function stubRetrieval(options:{build?:()=>Promise<void>}={}){
 const calls:{method:string;args:unknown[]}[]=[]
 const record=(method:string,...args:unknown[])=>{calls.push({method,args})}
 const retrieval={
  async search(actor:ResourceActor,targetScopes:string[],input:unknown,embedder:{profileHash:string;embed:(kind:'query'|'passage',texts:string[],signal:AbortSignal)=>Promise<Float32Array[]>},signal:AbortSignal){
   record('search',actor,targetScopes,input,embedder.profileHash)
   // 真实服务会先嵌入查询：这里也调一次，证明适配器把 embed 转给了扩展服务。
   await embedder.embed('query',[(input as {query:string}).query],signal)
   return structuredClone(fixture)
  },
  async enroll(actor:ResourceActor,input:unknown){record('enroll',actor,input)},
  async remove(actor:ResourceActor,input:unknown){record('remove',actor,input)},
  async status(actor:ResourceActor,hash:string|null){record('status',actor,hash);return {items:[],enrolled:0,chunks:0}},
  async buildPending(actor:ResourceActor,embedder:{profileHash:string},signal:AbortSignal,opts:{retryFailed?:boolean}={}){
   record('buildPending',actor,embedder.profileHash,opts)
   if(options.build)await Promise.race([options.build(),new Promise<void>(done=>signal.addEventListener('abort',()=>done(),{once:true}))])
   return {ready:1,failed:0}
  },
  async reconcile(hash?:string){record('reconcile',hash);return {removed:0}},
 }
 return {retrieval,calls,of:(method:string)=>calls.filter(call=>call.method===method)}
}

async function setup(overrides:Partial<LocalRetrievalPorts>={},options:{subagent?:boolean;phase?:string;noService?:boolean;build?:()=>Promise<void>}={}){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId(sessionId),...(options.subagent?{meta:{origin:'subagent' as const,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1})
 agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'request'},content:[{type:'text',text:'报销流程是什么'}]}),{surfaceOp:'append'})
 const embedding=stubEmbedding(options.phase??'ready'),store=stubRetrieval({...(options.build?{build:options.build}:{})})
 const logs:string[]=[],taskAuthorizations:string[]=[]
 const ports:LocalRetrievalPorts={
  owner,
  conversation:async id=>({ownerId:owner,sessionId:id,status:'ready',scopeIds:['general','design']}),
  readTaskPolicy:async()=>null,
  taskAuthorization:async id=>{taskAuthorizations.push(id);return {actor:{ownerId:owner,kind:'agent',scopeIds:['SOC']},targetScopes:['SOC']}},
  humanActor:async()=>human,
  retrieval:async()=>store.retrieval,
  embedding:()=>options.noService?undefined:embedding.service,
  admit:work=>work(),
  log:(level,message)=>{logs.push(level+':'+message)},
  ...overrides,
 }
 const registered=registerLocalRetrieval(ctx,ports)
 const call=(args:Record<string,unknown>,withAgent=true)=>ctx.tools.execute({...(withAgent?{agent}:{}),name:knowledgeSearchToolName,arguments:args,callId:ToolCallId('call-'+Math.random()),signal:AbortSignal.timeout(5000)})
 return {ctx,agent,call,embedding,store,logs,taskAuthorizations,registered,handle:(endpoint:string,payload:unknown)=>registered.handle(endpoint,payload,AbortSignal.timeout(5000))}
}
const text=(result:{content:Array<{type:string;text?:string}>})=>result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n')

test('工具经公开工具注册；没有绑定会话时报 not-bound，子 Agent 会话拒绝',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 assert.ok(e.ctx.tools.get(knowledgeSearchToolName,e.agent),'工具已注册')
 const unbound=await e.call({query:'报销'},false)
 assert.equal(unbound.isError,true);assert.match(text(unbound),/绑定/)
 const sub=await setup({},{subagent:true});t.after(()=>sub.ctx.fiber.dispose())
 const denied=await sub.call({query:'报销'})
 assert.equal(denied.isError,true);assert.match(text(denied),/子 Agent/)
 assert.equal(e.store.of('search').length+sub.store.of('search').length,0)
})

test('本人普通会话：模型就绪即默认可用，按会话绑定范围检索，结果经契约守卫并带原文位置与覆盖说明',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const result=await e.call({query:'报销流程',limit:3})
 assert.equal(result.isError,false,text(result))
 const value=readRetrievalSearchResult(JSON.parse(text(result)))
 assert.deepEqual(value,fixture)
 assert.match(value.coverage.note,/不是全部资料/)
 assert.deepEqual(value.results[0]!.lines,[4,6]);assert.deepEqual(value.results[0]!.chars,[30,88]);assert.equal(value.results[0]!.heading,'差旅报销制度 > 审批流程')
 const [search]=e.store.of('search')
 assert.deepEqual(search!.args,[{ownerId:owner,kind:'agent',scopeIds:['general','design']},['general','design'],{query:'报销流程',limit:3},profileHash])
 assert.deepEqual(e.embedding.embedded,[{id:embeddingProviderId,kind:'query',texts:['报销流程']}],'查询嵌入经扩展服务且带 provider id')
 assert.equal(e.taskAuthorizations.length,0,'普通会话不走任务授权')
 assert.equal(e.embedding.prepared.length,0)
 // limit 缺省时不由宿主补默认值，交给服务端（规格默认 5）。
 const plain=await e.call({query:'报销'})
 assert.equal(plain.isError,false);assert.deepEqual(e.store.of('search')[1]!.args[2],{query:'报销'})
})

test('受管任务：用 taskKnowledgeAuthorization 给出的主体与目标范围；未授予时 task-tool-guard 与工具正文都拒绝',async t=>{
 let policy:TaskToolPolicy={allowedTools:[knowledgeSearchToolName]}
 const e=await setup({readTaskPolicy:async()=>policy});t.after(()=>e.ctx.fiber.dispose())
 registerTaskToolGuard(e.ctx,async()=>policy)
 const granted=await e.call({query:'告警处置'})
 assert.equal(granted.isError,false,text(granted))
 assert.ok(e.taskAuthorizations.length>=1&&e.taskAuthorizations.every(id=>id===sessionId),'前置守卫与正文各核一次')
 assert.deepEqual(e.store.of('search')[0]!.args.slice(0,2),[{ownerId:owner,kind:'agent',scopeIds:['SOC']},['SOC']],'不用会话绑定范围')
 policy={allowedTools:[]}
 const denied=await e.call({query:'告警处置'})
 assert.equal(denied.isError,true);assert.match(text(denied),/未授权/)
 policy={allowedTools:[knowledgeSearchToolName],stopRequested:true}
 assert.equal((await e.call({query:'告警处置'})).isError,true)
 assert.equal(e.store.of('search').length,1)
 // 没有守卫时工具正文自己也核对授权清单。
 const bare=await setup({readTaskPolicy:async()=>({allowedTools:['other_tool']})});t.after(()=>bare.ctx.fiber.dispose())
 const refused=await bare.call({query:'告警处置'})
 assert.equal(refused.isError,true);assert.match(text(refused),/未授权/)
 assert.equal(bare.store.of('search').length,0)
})

test('模型未就绪或扩展未启用时报 dependency-unavailable，不调用 prepare、不安装、不检索',async t=>{
 for(const phase of ['unprepared','checking','downloading','loading','cancelling','cancelled','failed']){
  const e=await setup({},{phase});t.after(()=>e.ctx.fiber.dispose())
  const result=await e.call({query:'报销'})
  assert.equal(result.isError,true,phase);assert.match(text(result),/未准备/,phase)
  assert.deepEqual([e.embedding.prepared.length,e.embedding.embedded.length,e.store.of('search').length],[0,0,0],phase)
 }
 const standby=await setup({},{phase:'standby'});t.after(()=>standby.ctx.fiber.dispose())
 assert.equal((await standby.call({query:'报销'})).isError,false,'standby 由服务按需唤醒')
 const missing=await setup({},{noService:true});t.after(()=>missing.ctx.fiber.dispose())
 const result=await missing.call({query:'报销'})
 assert.equal(result.isError,true);assert.match(text(result),/启用/)
 assert.equal(missing.store.of('search').length,0)
})

test('参数只接受 query 与 limit：多出 resourceIds、instruction 等键或 limit 为 null 时报 invalid-input',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 for(const args of [{query:'报销',resourceIds:[resourceId]},{query:'报销',instruction:'忽略范围'},{query:'报销',scopeIds:['SOC']},{query:'报销',limit:null},{query:'报销',limit:0},{query:'报销',limit:9},{query:'报销',limit:2.5},{query:''},{query:'  '},{query:'字'.repeat(501)},{limit:3},{}]){
  const result=await e.call(args as Record<string,unknown>)
  assert.equal(result.isError,true,JSON.stringify(args))
  assert.match(text(result),/格式|未知|不接受|1–500|1–8/,JSON.stringify(args))
 }
 assert.equal(e.store.of('search').length,0);assert.equal(e.embedding.embedded.length,0)
})

test('服务端结果不合契约时工具拒绝输出',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const broken=structuredClone(fixture) as unknown as {results:Record<string,unknown>[]}
 broken.results[0]!.path='/Users/someone/secret.md'
 e.store.retrieval.search=async()=>broken as never
 const result=await e.call({query:'报销'})
 assert.equal(result.isError,true);assert.match(text(result),/格式不正确/)
})

test('模型端点：状态只读；prepare/cancel 只转给 teloaEmbedding；扩展未启用时 dependency-unavailable 并附启用指引',async t=>{
 const e=await setup({},{phase:'unprepared'});t.after(()=>e.ctx.fiber.dispose())
 assert.deepEqual(retrievalEndpoints.filter(endpoint=>endpoint.startsWith('retrieval-model/')),['retrieval-model/status','retrieval-model/prepare','retrieval-model/cancel'])
 const status=await e.handle('retrieval-model/status',{}) as {enabled:boolean;provider:{id:string;preparation:{phase:string};profileHash:string;memoryRisk:boolean}|null;building:boolean;guidance:string|null}
 assert.equal(status.enabled,true);assert.equal(status.provider!.id,embeddingProviderId);assert.equal(status.provider!.preparation.phase,'unprepared');assert.equal(status.provider!.profileHash,profileHash);assert.equal(status.building,false);assert.equal(status.guidance,null)
 assert.equal(e.embedding.prepared.length,0,'读状态不触发准备')
 const prepared=await e.handle('retrieval-model/prepare',{expected:expectedFor(e.embedding.service)}) as {provider:{id:string}}
 assert.deepEqual(e.embedding.prepared,[embeddingProviderId]);assert.equal(prepared.provider.id,embeddingProviderId)
 await e.handle('retrieval-model/cancel',{})
 assert.deepEqual(e.embedding.cancelled,[embeddingProviderId])
 await assert.rejects(e.handle('retrieval-model/prepare',{force:true}),{code:'teloa/invalid-input'})
 await assert.rejects(e.handle('retrieval/unknown',{}),{code:'teloa/not-found'})
 const missing=await setup({},{noService:true});t.after(()=>missing.ctx.fiber.dispose())
 const off=await missing.handle('retrieval-model/status',{}) as {enabled:boolean;provider:unknown;guidance:string|null}
 assert.equal(off.enabled,false);assert.equal(off.provider,null);assert.match(off.guidance!,/启用/)
 await assert.rejects(missing.handle('retrieval-model/prepare',{expected:expectedFor(e.embedding.service)}),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/dependency-unavailable'&&/启用/.test(error.message)&&error.details?.extension==='local-embedding')
 await assert.rejects(missing.handle('retrieval-model/cancel',{}),{code:'teloa/dependency-unavailable'})
})

test('资料端点：enroll/remove/status 以本人主体转发；status 带当前 profileHash，扩展未启用时传 null',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const enrolled=await e.handle('retrieval/enroll',{sourceIds:['src_policy']}) as {items:unknown[];building:boolean}
 assert.deepEqual(e.store.of('enroll')[0]!.args,[human,{sourceIds:['src_policy']}])
 assert.ok('items' in enrolled)
 await e.registered.idle()
 assert.deepEqual(e.store.of('buildPending').map(call=>call.args.slice(0,3)),[[human,profileHash,{retryFailed:false}]],'加入后启动一次后台建索引，不重试失败资料')
 await e.handle('retrieval/remove',{sourceIds:['src_policy']})
 assert.deepEqual(e.store.of('remove')[0]!.args,[human,{sourceIds:['src_policy']}])
 await e.handle('retrieval/status',{})
 assert.ok(e.store.of('status').every(call=>JSON.stringify(call.args)===JSON.stringify([human,profileHash])))
 await assert.rejects(e.handle('retrieval/status',{sessionId:'x'}),{code:'teloa/invalid-input'})
 const missing=await setup({},{noService:true});t.after(()=>missing.ctx.fiber.dispose())
 await missing.handle('retrieval/status',{})
 assert.deepEqual(missing.store.of('status')[0]!.args,[human,null])
 await missing.handle('retrieval/enroll',{sourceIds:['src_policy']})
 await missing.registered.idle()
 assert.equal(missing.store.of('buildPending').length,0,'模型不可用时只登记加入，不建索引')
})

test('重建：模型未就绪时 dependency-unavailable；就绪时后台按 retryFailed 重建，同一时间只跑一个，重复请求合并为一次补跑',async t=>{
 const cold=await setup({},{phase:'unprepared'});t.after(()=>cold.ctx.fiber.dispose())
 await assert.rejects(cold.handle('retrieval/reindex',{}),{code:'teloa/dependency-unavailable'})
 assert.equal(cold.store.of('buildPending').length,0)
 let gate=deferred()
 const e=await setup({},{build:()=>gate.promise});t.after(()=>e.ctx.fiber.dispose())
 const first=await e.handle('retrieval/reindex',{}) as {building:boolean}
 assert.equal(first.building,true)
 const second=await e.handle('retrieval/reindex',{}) as {building:boolean}
 assert.equal(second.building,true)
 await e.handle('retrieval/enroll',{sourceIds:['src_more']})
 assert.equal(e.store.of('buildPending').length,1,'在跑时不并发第二个')
 const running=gate;gate=deferred()
 running.resolve()
 await new Promise(done=>setTimeout(done,20))
 assert.equal(e.store.of('buildPending').length,2,'结束后补跑一次')
 assert.deepEqual(e.store.of('buildPending').map(call=>(call.args[2] as {retryFailed:boolean}).retryFailed),[true,true],'补跑保留重建语义')
 gate.resolve()
 await e.registered.idle()
 assert.equal(e.store.of('buildPending').length,2)
 assert.equal((await e.handle('retrieval/status',{}) as {building:boolean}).building,false)
})

test('宿主启动对账只在进程内调用并带当前 profileHash；停止时中止后台建索引',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 await e.registered.reconcile()
 assert.deepEqual(e.store.of('reconcile')[0]!.args,[profileHash])
 assert.equal(retrievalEndpoints.some(endpoint=>/reconcile/.test(endpoint)),false,'对账不是 RPC 端点')
 const missing=await setup({},{noService:true});t.after(()=>missing.ctx.fiber.dispose())
 await missing.registered.reconcile()
 assert.deepEqual(missing.store.of('reconcile')[0]!.args,[undefined])
 const slow=await setup({},{build:()=>new Promise(()=>{})});t.after(()=>slow.ctx.fiber.dispose())
 await slow.handle('retrieval/reindex',{})
 await slow.registered.dispose()
 assert.equal(slow.registered.building(),false)
 await assert.rejects(slow.handle('retrieval/reindex',{}),{code:'teloa/dependency-unavailable'})
 await assert.rejects(slow.handle('retrieval-model/prepare',{}),{code:'teloa/dependency-unavailable'})
 assert.equal(slow.embedding.prepared.length,0,'停止后不再接受新的下载')
})

test('已取消的界面请求不开始下载、加入或重建',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const reason=new Error('浏览器请求已取消'),signal=AbortSignal.abort(reason)
 for(const [endpoint,payload] of [['retrieval-model/prepare',{}],['retrieval/enroll',{sourceIds:['src_policy']}],['retrieval/reindex',{}],['retrieval/cancel',{}]] as const){
  await assert.rejects(e.registered.handle(endpoint,payload,signal),error=>error===reason)
 }
 assert.equal(e.embedding.prepared.length,0)
 assert.equal(e.store.calls.length,0)
 assert.equal(e.registered.building(),false)
})

test('模型快照内存须为有限的正整数字节，异常快照不能宣称可准备',()=>{
 const snapshot=stubEmbedding('ready').service.snapshot() as {providers:Array<{totalMemoryBytes:number}>}
 for(const totalMemoryBytes of [NaN,Infinity,-1,0,1.5]){
  snapshot.providers[0]!.totalMemoryBytes=totalMemoryBytes
  assert.throws(()=>readEmbeddingProvider(snapshot,embeddingProviderId),{code:'teloa/dependency-unavailable'})
 }
})

test('本人取消索引：中止当前批、清补跑、等收尾；短 RPC 取消不影响已受理任务，之后可续建',{timeout:5000},async t=>{
 const e=await setup()
 const started=deferred(),aborted=deferred(),settled=deferred()
 t.after(async()=>{settled.resolve();await e.registered.dispose();await e.ctx.fiber.dispose()})
 let builds=0,buildSignal:AbortSignal|undefined
 e.store.retrieval.buildPending=async(_actor,_embedder,signal)=>{
  builds++;buildSignal=signal
  if(builds===1){started.resolve();signal.addEventListener('abort',aborted.resolve,{once:true});await settled.promise}
  return {ready:1,failed:0}
 }
 const rpc=new AbortController()
 await e.registered.handle('retrieval/reindex',{},rpc.signal)
 await started.promise
 rpc.abort()
 assert.equal(buildSignal!.aborted,false,'已受理后台任务不绑定短 RPC')
 await e.handle('retrieval/reindex',{})
 await e.handle('retrieval/enroll',{sourceIds:['src_more']})
 let responded=false
 const cancelled=e.handle('retrieval/cancel',{}).then(value=>{responded=true;return value})
 await aborted.promise
 assert.equal(responded,false,'必须等待当前批收尾')
 await assert.rejects(e.handle('retrieval/reindex',{}),{code:'teloa/conflict'})
 await e.handle('retrieval/enroll',{sourceIds:['src_during_cancel']})
 const repeated=e.handle('retrieval/cancel',{})
 settled.resolve()
 assert.equal((await cancelled as {building:boolean}).building,false)
 await repeated
 await e.registered.idle()
 assert.equal(builds,1,'取消时清掉补跑，重复取消不新建任务')
 await e.handle('retrieval/reindex',{})
 await e.registered.idle()
 assert.equal(builds,2,'取消后允许以新 signal 续建')
 assert.equal(buildSignal!.aborted,false)
 assert.deepEqual(e.embedding.cancelled,[],'取消索引不取消模型准备或删除权重')
 await assert.rejects(e.handle('retrieval/cancel',{sourceIds:['src_more']}),{code:'teloa/invalid-input'})
})

test('建索引尚在准入队列时取消，出队后不调用后端，也不补跑',async t=>{
 const entered=deferred(),release=deferred()
 const e=await setup({admit:async work=>{entered.resolve();await release.promise;return work()}})
 t.after(async()=>{release.resolve();await e.registered.dispose();await e.ctx.fiber.dispose()})
 await e.handle('retrieval/reindex',{})
 await entered.promise
 await e.handle('retrieval/reindex',{})
 const cancelled=e.handle('retrieval/cancel',{})
 release.resolve()
 await cancelled
 assert.equal(e.store.of('buildPending').length,0)
 assert.equal(e.registered.building(),false)
})

test('真实 embedding 服务队列：取消排在查询后的索引不终止查询，也不执行已取消的 passage',{timeout:5000},async t=>{
 const {createEmbeddingProvider,createEmbeddingService}=await import('../../local-embedding/src/service.ts')
 const queryStarted=deferred(),queryDone=deferred(),passageQueued=deferred(),kinds:string[]=[]
 const provider=createEmbeddingProvider({
  id:embeddingProviderId,catalogId:'teloa.model.qwen3-embedding-0-6b',catalogVersion:'1.0.0',profileHash,variant:'fp32',preparationDetails,totalMemoryBytes:16*1024**3,idleTimeoutMs:0,
  runtime:{resource:'test',source:'registry.npmjs.org',check:async()=>true,install:async()=>{throw Error('不得安装')}},
  assets:{resource:'test',inspect:async()=>'complete',prepare:async()=>{throw Error('不得下载')}},
  startEngine:async()=>({exited:new Promise(()=>{}),close:async()=>{},embed:async(kind,texts,signal)=>{
   kinds.push(kind)
   if(kind==='query'){queryStarted.resolve();await queryDone.promise;assert.equal(signal.aborted,false,'索引取消不能取消前方查询')}
   return {vectors:texts.map(()=>new Float32Array(1024)),truncated:0}
  }}),
 })
 await provider.inspected
 const embedding=createEmbeddingService([provider]),store=stubRetrieval()
 const retrieval:Awaited<ReturnType<LocalRetrievalPorts['retrieval']>>={...store.retrieval,async buildPending(_actor,embedder,signal){
  const work=embedder.embed('passage',['制度'],signal)
  passageQueued.resolve()
  await work
  return {ready:1,failed:0}
 }}
 const e=await setup({retrieval:async()=>retrieval,embedding:()=>embedding})
 t.after(async()=>{queryDone.resolve();await e.registered.dispose();await provider.dispose();await e.ctx.fiber.dispose()})
 const query=embedding.embed(embeddingProviderId,{kind:'query',texts:['查询']},AbortSignal.timeout(4000))
 await queryStarted.promise
 await e.handle('retrieval/reindex',{})
 await passageQueued.promise
 await e.handle('retrieval/cancel',{})
 assert.deepEqual(kinds,['query'])
 queryDone.resolve();await query
 await e.handle('retrieval/reindex',{});await e.registered.idle()
 assert.deepEqual(kinds,['query','passage'],'仅新的续建进入引擎')
})

test('加入/移出在等待服务或本人主体时取消/停机，写入前拒绝；不会启动索引',async t=>{
 for(const endpoint of ['retrieval/enroll','retrieval/remove'])for(const waitAt of ['service','actor'])for(const reason of ['cancel','stop']){
  const entered=deferred(),release=deferred(),store=stubRetrieval()
  const wait=async()=>{entered.resolve();await release.promise}
  const e=await setup({retrieval:async()=>{if(waitAt==='service')await wait();return store.retrieval},humanActor:async()=>{if(waitAt==='actor')await wait();return human}})
  t.after(async()=>{release.resolve();await e.registered.dispose();await e.ctx.fiber.dispose()})
  const rpc=new AbortController(),error=new Error('请求等待中取消')
  const pending=e.registered.handle(endpoint,{sourceIds:['src_policy']},rpc.signal)
  const rejected=assert.rejects(pending,cause=>reason==='cancel'?cause===error:(cause as WorkError).code==='teloa/dependency-unavailable')
  await entered.promise
  if(reason==='cancel')rpc.abort(error);else await e.registered.dispose()
  release.resolve()
  await rejected
  assert.deepEqual(store.calls,[],`${endpoint}/${waitAt}/${reason} 不得调用变更或后台任务`)
 }
})

test('加入已进入提交后才取消请求：不承诺回滚，已受理的建索引继续',async t=>{
 const e=await setup();t.after(async()=>{await e.registered.dispose();await e.ctx.fiber.dispose()})
 const entered=deferred(),committed=deferred(),rpc=new AbortController()
 let writes=0
 e.store.retrieval.enroll=async()=>{entered.resolve();await committed.promise;writes++}
 const pending=e.registered.handle('retrieval/enroll',{sourceIds:['src_policy']},rpc.signal)
 await entered.promise
 rpc.abort()
 committed.resolve()
 await pending
 await e.registered.idle()
 assert.equal(writes,1)
 assert.equal(e.store.of('buildPending').length,1)
})

test('真实 Cordis 兄弟服务：冷启动先通用对账，扩展出现补当前 profile；停用不对账，重新提供跟新 profile',{timeout:5000},async t=>{
 const ctx=new Context(),store=stubRetrieval(),held=deferred(),waiting=deferred(),reconciling=deferred(),finishReconcile=deferred()
 for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime])await ctx.plugin(plugin)
 let host:ReturnType<typeof registerLocalRetrieval>|undefined,hostScope:Context|undefined
 t.after(async()=>{held.resolve();finishReconcile.resolve();await host?.dispose();await ctx.fiber.dispose()})
 const hashes:(string|undefined)[]=[],first=deferred(),second=deferred()
 let hash=profileHash,delayRead=false,delayReconcile=false
 const embedding=stubEmbedding('standby'),service=embedding.service
 const snapshot=service.snapshot
 service.snapshot=()=>{const value=snapshot() as {providers:{profileHash:string}[]};value.providers[0]!.profileHash=hash;return value}
 const extensionPlugin={name:'retrieval-lifecycle-extension',inject:['teloaWork'],apply(scope:Context){scope.provide('teloaEmbedding',service)}}
 const extension=ctx.plugin(extensionPlugin)
 const hostFiber=ctx.plugin({name:'retrieval-lifecycle-host',inject:['tools'],async apply(scope:Context){
  hostScope=scope
  host=registerLocalRetrieval(scope,{
   owner,conversation:async id=>({ownerId:owner,sessionId:id,status:'ready',scopeIds:['general']}),readTaskPolicy:async()=>null,taskAuthorization:async()=>({actor:human,targetScopes:['general']}),humanActor:async()=>human,
   retrieval:async()=>{if(delayRead){waiting.resolve();await held.promise}return {...store.retrieval,async reconcile(value?:string){
    hashes.push(value)
    if(value===profileHash)first.resolve()
    if(value==='c'.repeat(64))second.resolve()
    if(delayReconcile){reconciling.resolve();await finishReconcile.promise}
    return {removed:0}
   }}},
   embedding:()=>scope.reflect.get('teloaEmbedding') as EmbeddingServiceLike|undefined,admit:work=>work(),log:()=>{},
  })
  await host.reconcile()
  scope.provide('teloaWork',{})
 }})
 await hostFiber;await extension
 await first.promise
 assert.deepEqual(hashes,[undefined,profileHash])
 assert.equal((await host!.handle('retrieval-model/status',{},AbortSignal.timeout(1000)) as {enabled:boolean}).enabled,true)
 await extension.dispose()
 assert.equal(hostScope!.reflect.get('teloaEmbedding'),undefined)
 assert.deepEqual(hashes,[undefined,profileHash],'停用不发清理或准备操作')
 hash='c'.repeat(64)
 const replacement=ctx.plugin(extensionPlugin)
 await replacement
 await second.promise
 assert.deepEqual(hashes,[undefined,profileHash,hash])
 await replacement.dispose()
 delayRead=true;hash='d'.repeat(64)
 const pending=ctx.plugin(extensionPlugin)
 await pending;await waiting.promise
 const stopped=pending.dispose()
 await new Promise<void>(resolve=>setImmediate(resolve))
 held.resolve()
 await stopped
 assert.deepEqual(hashes,[undefined,profileHash,'c'.repeat(64)],'等待读口期间停用，不能用旧 profile 发起清理')
 assert.deepEqual(embedding.prepared,[])
 assert.deepEqual(embedding.cancelled,[])
 delayRead=false;delayReconcile=true;hash='e'.repeat(64)
 await ctx.plugin(extensionPlugin)
 await reconciling.promise
 let disposed=false
 const dispose=host!.dispose().then(()=>{disposed=true})
 await new Promise<void>(resolve=>setImmediate(resolve))
 assert.equal(disposed,false,'关库前等待已经开始的 profile 对账')
 finishReconcile.resolve()
 await dispose
 assert.equal(disposed,true)
})

test('审查 P2-2：确认 A 的 status 后换成 B，不得对 B 无条件 prepare',async t=>{
 const a=stubEmbedding('unprepared'),b=stubEmbedding('unprepared')
 const base=b.service.snapshot
 b.service.snapshot=()=>{const value=base() as {providers:Array<Record<string,unknown>>};return {providers:value.providers.map(p=>({...p,profileHash:'b'.repeat(64)}))}}
 let current=a.service
 const e=await setup({embedding:()=>current});t.after(()=>e.ctx.fiber.dispose())
 await e.handle('retrieval-model/status',{})
 current=b.service
 await assert.rejects(e.handle('retrieval-model/prepare',{}))
 assert.equal(b.prepared.length,0)
})

test('P2-2 接缝：最后一次 status 返回 A，派发前换 B（profile/路径/工件/版本变化）一律 conflict 且 B.prepare=0',async t=>{
 for(const patch of [
  {profileHash:'b'.repeat(64)},
  {catalogVersion:'2.0.0'},
  {preparationDetails:{...preparationDetails,modelDirectory:'/new/models'}},
  {preparationDetails:{...preparationDetails,files:preparationDetails.files.map((file,i)=>i===0?{...file,sha256:'c'.repeat(64)}:file)}},
 ]){
  const a=stubEmbedding('unprepared'),b=stubEmbedding('unprepared'),base=b.service.snapshot
  b.service.snapshot=()=>{const value=base() as {providers:Array<Record<string,unknown>>};return {providers:value.providers.map(p=>({...p,...patch}))}}
  let current=a.service
  const e=await setup({embedding:()=>current});t.after(()=>e.ctx.fiber.dispose())
  const status=await e.handle('retrieval-model/status',{}) as {provider:Parameters<typeof captureRetrievalPreparation>[0]}
  const expected=captureRetrievalPreparation(status.provider)
  current=b.service
  await assert.rejects(e.handle('retrieval-model/prepare',{expected}),{code:'teloa/conflict'})
  assert.equal(b.prepared.length,0);assert.equal(a.prepared.length,0)
 }
})
test('P2-2 同次捕获：核对后的 prepare 仅调用捕获服务，旧 {} 与不完整 expected 均无下载',async t=>{
 const a=stubEmbedding('unprepared'),b=stubEmbedding('unprepared')
 let current=a.service,gets=0
 const e=await setup({embedding:()=>{gets++;return current}});t.after(()=>e.ctx.fiber.dispose())
 const expected=expectedFor(a.service),base=a.service.snapshot
 a.service.snapshot=()=>{current=b.service;return base()}
 gets=0
 await e.handle('retrieval-model/prepare',{expected})
 assert.equal(gets,1,'prepare 执行段不能二次解析服务')
 assert.deepEqual(a.prepared,[embeddingProviderId]);assert.equal(b.prepared.length,0)
 for(const payload of [{},{expected:{}},{expected,force:true}]){
  await assert.rejects(e.handle('retrieval-model/prepare',payload),{code:'teloa/invalid-input'})
 }
 assert.equal(b.prepared.length,0)
})

test('prepare 下载来源：只把已核对的 source 交给扩展，缺省不带；未知来源、多余键被拒且不触发准备',async t=>{
 const e=await setup({},{phase:'unprepared'});t.after(()=>e.ctx.fiber.dispose())
 const expected=expectedFor(e.embedding.service)
 assert.deepEqual(expected.preparationDetails.downloadSources?.map(row=>row.id),['official','hf-mirror'])
 for(const payload of [{expected,source:'evil-mirror'},{expected,source:null},{expected,source:'hf-mirror',force:true}]){
  await assert.rejects(e.handle('retrieval-model/prepare',payload),{code:'teloa/invalid-input'})
 }
 assert.equal(e.embedding.prepared.length,0)
 await e.handle('retrieval-model/prepare',{expected,source:'hf-mirror'})
 await e.handle('retrieval-model/prepare',{expected})
 await e.handle('retrieval-model/prepare',{expected,source:'official'})
 assert.deepEqual(e.embedding.sources,['hf-mirror',undefined,'official'])
})

test('模型就绪后自动整理：准备完成（就绪或待机）只触发一次建索引；准备失败或取消不触发',{timeout:5000},async t=>{
 let phase='unprepared'
 const base=stubEmbedding('ready')
 const service:EmbeddingServiceLike={...base.service,snapshot:()=>stubEmbedding(phase).service.snapshot()}
 const e=await setup({embedding:()=>service,readyPollMs:5});t.after(()=>e.ctx.fiber.dispose())
 await e.handle('retrieval/enroll',{sourceIds:['src_policy']})
 await e.registered.idle()
 assert.equal(e.store.of('buildPending').length,0,'模型未准备时加入只登记')
 await e.handle('retrieval-model/prepare',{expected:expectedFor(service)})
 phase='downloading'
 await new Promise(done=>setTimeout(done,30))
 assert.equal(e.store.of('buildPending').length,0,'准备过程中不整理')
 phase='ready'
 await new Promise(done=>setTimeout(done,30))
 await e.registered.idle()
 assert.deepEqual(e.store.of('buildPending').map(call=>call.args[2]),[{retryFailed:false}],'就绪后自动整理一次，不重试失败资料')
 await new Promise(done=>setTimeout(done,30))
 assert.equal(e.store.of('buildPending').length,1,'就绪后不反复整理')
 const failed=await setup({embedding:()=>({...base.service,snapshot:()=>stubEmbedding(phase).service.snapshot()}),readyPollMs:5});t.after(()=>failed.ctx.fiber.dispose())
 phase='downloading'
 await failed.handle('retrieval-model/prepare',{expected:expectedFor(service)})
 phase='failed'
 await new Promise(done=>setTimeout(done,30))
 phase='ready'
 await new Promise(done=>setTimeout(done,30))
 assert.equal(failed.store.of('buildPending').length,0,'准备失败后停止跟踪，不在之后偷偷整理')
})

test('资料更新后自动跟着更新：状态里出现新的待更新资料且模型可用时整理一次；同一批不反复整理，本人取消后不自动续建',{timeout:5000},async t=>{
 let stale=[{sourceId:'src_policy',resourceId,title:'差旅报销制度',version:3,state:'stale' as const,chunkCount:null}]
 const base=stubRetrieval()
 const e=await setup({retrieval:async()=>({...base.retrieval,status:async(actor:ResourceActor,hash:string|null)=>{await base.retrieval.status(actor,hash);return {items:stale,enrolled:1,chunks:0}},buildPending:base.retrieval.buildPending})});t.after(()=>e.ctx.fiber.dispose())
 await e.handle('retrieval/status',{})
 await e.registered.idle()
 assert.equal(base.of('buildPending').length,1,'看到待更新资料时整理一次')
 await e.handle('retrieval/status',{})
 await e.registered.idle()
 assert.equal(base.of('buildPending').length,1,'同一批待更新资料不反复整理')
 stale=[{...stale[0]!,version:4}]
 await e.handle('retrieval/status',{})
 await e.registered.idle()
 assert.equal(base.of('buildPending').length,2,'资料又有新版本时再整理一次')
 await e.handle('retrieval/cancel',{})
 stale=[{...stale[0]!,version:5}]
 await e.handle('retrieval/status',{})
 await e.registered.idle()
 assert.equal(base.of('buildPending').length,2,'本人取消后不自动续建')
 await e.handle('retrieval/reindex',{})
 await e.registered.idle()
 assert.equal(base.of('buildPending').length,3,'本人重建后恢复自动整理')
 const cold=await setup({retrieval:async()=>({...base.retrieval,status:async()=>({items:stale,enrolled:1,chunks:0})})},{phase:'unprepared'});t.after(()=>cold.ctx.fiber.dispose())
 await cold.handle('retrieval/status',{})
 await cold.registered.idle()
 assert.equal(base.of('buildPending').length,3,'模型未就绪时读状态不整理')
})

test('就绪跟踪：准备被取消或回到未准备即停止跟踪；本人停止整理后就绪也不自动整理；停机后计时器不再触发',{timeout:5000},async t=>{
 const wait=(ms=30)=>new Promise(done=>setTimeout(done,ms))
 const base=stubEmbedding('ready')
 for(const ending of ['cancelled','unprepared']){
  let phase='downloading'
  const service:EmbeddingServiceLike={...base.service,snapshot:()=>stubEmbedding(phase).service.snapshot()}
  const e=await setup({embedding:()=>service,readyPollMs:5});t.after(()=>e.ctx.fiber.dispose())
  await e.handle('retrieval-model/prepare',{expected:expectedFor(service)})
  phase=ending;await wait()
  phase='ready';await wait()
  assert.equal(e.store.of('buildPending').length,0,ending+' 后停止跟踪')
 }
 {
  let phase='downloading'
  const service:EmbeddingServiceLike={...base.service,snapshot:()=>stubEmbedding(phase).service.snapshot()}
  const e=await setup({embedding:()=>service,readyPollMs:5});t.after(()=>e.ctx.fiber.dispose())
  await e.handle('retrieval-model/prepare',{expected:expectedFor(service)})
  await e.handle('retrieval/cancel',{})
  phase='ready';await wait()
  assert.equal(e.store.of('buildPending').length,0,'准备中本人点了停止整理：就绪后不自动整理')
 }
 {
  let phase='downloading'
  const service:EmbeddingServiceLike={...base.service,snapshot:()=>stubEmbedding(phase).service.snapshot()}
  const e=await setup({embedding:()=>service,readyPollMs:5});t.after(()=>e.ctx.fiber.dispose())
  await e.handle('retrieval-model/prepare',{expected:expectedFor(service)})
  await e.registered.dispose()
  phase='ready';await wait()
  assert.equal(e.store.of('buildPending').length,0,'停机后计时器不再触发整理')
 }
})

test('本人停止整理的选择跨重启保留：下次启动读到后不自动整理，直到本人再点重建或重新准备模型',{timeout:5000},async t=>{
 const stale=[{sourceId:'src_policy',resourceId,title:'差旅报销制度',version:3,state:'stale' as const,chunkCount:null}]
 let saved=false
 const autoPause={read:async()=>saved,write:async(paused:boolean)=>{saved=paused}}
 const make=async(phase='ready')=>{
  const base=stubRetrieval()
  const e=await setup({autoPause,retrieval:async()=>({...base.retrieval,status:async()=>({items:stale,enrolled:1,chunks:0})})},{phase});t.after(()=>e.ctx.fiber.dispose())
  return {e,base}
 }
 const first=await make()
 await first.e.handle('retrieval/cancel',{})
 assert.equal(saved,true,'停止整理写入持久记录')
 const restarted=await make()
 await restarted.e.handle('retrieval/status',{})
 await restarted.e.registered.idle()
 assert.equal(restarted.base.of('buildPending').length,0,'重启后仍不自动整理')
 await restarted.e.handle('retrieval/reindex',{})
 await restarted.e.registered.idle()
 assert.equal(saved,false,'本人重建后清除记录')
 assert.equal(restarted.base.of('buildPending').length,1)
 saved=true
 const again=await make('unprepared')
 await again.e.handle('retrieval-model/prepare',{expected:expectedFor(again.e.embedding.service)})
 assert.equal(saved,false,'本人重新准备模型也清除记录')
})
