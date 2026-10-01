import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {OfficialCatalogService,type MarketContentStore} from '@teloa/backend'
import {registerMarketSessionTools,type MarketSessionToolsPorts} from '../src/market-session-tools.ts'
import {pullCardFacts} from '../src/model-prepare.ts'
import type {PullFacts,LocalModelPullInput} from '../src/local-models.ts'

const entry=new OfficialCatalogService({} as MarketContentStore).listLocalModelEntries().find(row=>row.id==='teloa.model.local.qwen3')!
const baseFacts:PullFacts={entryId:entry.id,version:entry.version,variant:0,name:'qwen3:4b',title:entry.model.title,quant:'Q4_K_M',baseURL:'http://127.0.0.1:11434',catalogDigest:'sha256:'+'a'.repeat(64),sizeBytes:3*2**30,diskFreeBytes:64*2**30,local:true,licenseTier:'restricted',licenseName:'Apache 2.0',licenseURL:'https://www.apache.org/licenses/LICENSE-2.0',restrictions:[{'zh-CN':'请核对许可',en:'Check license'}],fit:'good',runtime:'running'}
type Options={subagent?:boolean;task?:boolean;im?:boolean;instruction?:boolean;deny?:boolean;cloud?:boolean;missing?:boolean;priorDeny?:boolean;onApprove?:()=>void;policy?:MarketSessionToolsPorts['readTaskPolicy']}
async function setup(options:Options={}){
 const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId(randomUUID()),...(options.subagent?{meta:{origin:'subagent' as const,delegationDepth:1}}:{}),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1})
 if(options.instruction!==false)agent.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'prepare'},content:[{type:'text',text:'帮我下载这个本机模型'}]}),{surfaceOp:'append'})
 const reasons:string[]=[],starts:{input:LocalModelPullInput;approved:PullFacts|undefined}[]=[]
 let factsReads=0,catalogReads=0
 const unused=async()=>{throw Error('不应调用其他写端口')}
 const facts={...structuredClone(baseFacts),runtime:options.missing?'missing' as const:'running' as const}
 const ports:MarketSessionToolsPorts={owner:'local:owner',conversation:async sessionId=>({ownerId:'local:owner',sessionId,status:'ready'}),readTaskPolicy:options.policy??(async()=>options.task?{allowedTools:['teloa_model_prepare']}:null),isImSession:()=>!!options.im,
  catalog:async()=>{catalogReads++;return {catalogVersion:'test',items:[{entry:options.cloud?{...entry,model:{...entry.model,form:'cloud'}}:entry,artifact:null,addedContentId:null,addedRoleId:null}],nextCursor:null}},github:unused,content:unused,skills:unused,mcp:unused,connectorEntry:()=>undefined,skillSecrets:()=>[],skillSecretMeta:()=>({}),skillSecretGroupMembers:()=>[],industryLoads:unused,industryPrepare:unused,currentSpace:unused,bundledExtensions:unused,
  localModels:{pullFacts:async()=>{factsReads++;return facts},startPull:async(input,approved)=>{starts.push({input,approved});return {pullId:'11111111-1111-4111-8111-111111111111',name:'qwen3:4b',phase:'pulling',completed:0,total:null,error:null}}},
 }
 registerMarketSessionTools(ctx,ports)
 if(options.priorDeny)ctx.on('tools/pre-execute',async()=>({kind:'deny' as const,reason:'原生规则拒绝'}))
 ctx.provide('approval',{request:async(input:{reason?:string})=>{reasons.push(input.reason??'');options.onApprove?.();return options.deny?'denied':'allowed-once'}})
 const call=(args:Record<string,unknown>={entryId:entry.id},callId='model-prepare',name='teloa_model_prepare')=>ctx.tools.execute({agent,name,arguments:args,callId:ToolCallId(callId),signal:AbortSignal.timeout(5000)})
 return {ctx,call,reasons,starts,facts,reads:()=>({factsReads,catalogReads})}
}
const textOf=(result:{content:readonly {type:string;text?:string}[]})=>result.content.map(item=>item.text??'').join('\n')

test('原生审批只出一张卡，执行使用同次批准的模型事实及幂等请求',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const result=await e.call()
 assert.equal(result.isError,false,textOf(result));assert.equal(e.reasons.length,1)
 for(const word of ['qwen3:4b','Q4_K_M','3.0 GiB','64.0 GiB','sha256:','许可','请核对许可','硬件适配','联网','加载模型并核验可用上下文','设置 · 本地模型'])assert.ok(e.reasons[0]!.includes(word),word)
 assert.deepEqual(e.starts[0]!.approved,baseFacts)
 assert.deepEqual({...e.starts[0]!.input,requestId:'stable'},{entryId:entry.id,version:entry.version,variant:0,acknowledgeRestrictions:true,requestId:'stable'})
 assert.deepEqual(JSON.parse(textOf(result)),{pullId:'11111111-1111-4111-8111-111111111111',name:'qwen3:4b',next:{page:'settings/local-models',entryId:entry.id}})
 await e.call();assert.equal(e.starts[1]!.input.requestId,e.starts[0]!.input.requestId)
})

test('拒绝确认不下载；原生拒绝优先；任务、子 Agent、IM 会话、无指令都不能进入确认',async t=>{
 for(const options of [{deny:true},{priorDeny:true},{task:true},{subagent:true},{im:true},{instruction:false}]){
  const e=await setup(options);t.after(()=>e.ctx.fiber.dispose())
  const result=await e.call()
  assert.equal(result.isError,true,JSON.stringify(options));assert.equal(e.starts.length,0)
  if(!options.deny)assert.equal(e.reasons.length,0)
  if(options.task||options.subagent||options.im||options.instruction===false)assert.deepEqual(e.reads(),{factsReads:0,catalogReads:0})
  if(options.im)assert.match(textOf(result),/IM 发起的会话不能下载模型/)
 }
})

test('云端条目与未运行 Ollama 返回真实配置入口，不下载',async t=>{
 for(const [options,pattern] of [[{cloud:true},/设置 · 模型/],[{missing:true},/https:\/\/ollama.com\/download/]] as const){
  const e=await setup(options);t.after(()=>e.ctx.fiber.dispose())
  const result=await e.call();assert.equal(result.isError,true);assert.match(textOf(result),pattern);assert.equal(e.starts.length,0);assert.equal(e.reasons.length,0)
 }
})

test('地址、密钥、未知字段和非法变体在读取任何目录前拒绝，不回显密钥',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const fake='sk-'+randomBytes(24).toString('hex')
 for(const input of [{entryId:entry.id,baseURL:'http://evil.test'},{entryId:fake},{entryId:entry.id,variant:-1},{entryId:entry.id,variant:6},{entryId:entry.id,variant:0.5}]){
  const result=await e.call(input);assert.equal(result.isError,true);assert.ok(!textOf(result).includes(fake))
 }
 assert.deepEqual(e.reads(),{factsReads:0,catalogReads:0});assert.equal(e.starts.length,0)
})

test('确认期间变为受管任务，执行前再授权会拒绝；目标快照不会随原对象被改写',async t=>{
 let tasked=false
 const e=await setup({onApprove:()=>{tasked=true},policy:async()=>tasked?{allowedTools:['teloa_model_prepare']}:null});t.after(()=>e.ctx.fiber.dispose())
 assert.equal((await e.call()).isError,true);assert.equal(e.starts.length,0)
 const copy=await setup({onApprove:()=>{copy.facts.baseURL='http://127.0.0.1:1'}});t.after(()=>copy.ctx.fiber.dispose())
 assert.equal((await copy.call()).isError,false);assert.equal(copy.starts[0]!.approved!.baseURL,baseFacts.baseURL)
})

test('本机条目 add 只引导到 prepare，不伪装已下载，不出写确认卡',async t=>{
 const e=await setup();t.after(()=>e.ctx.fiber.dispose())
 const resolved=JSON.parse(textOf(await e.call({reference:entry.id},'resolve','teloa_market_resolve'))).candidate
 const result=await e.call({candidate:{kind:'catalog',entryId:entry.id},expectedFingerprint:resolved.fingerprint},'add','teloa_market_add')
 assert.equal(result.isError,false,textOf(result));assert.match(textOf(result),/teloa_model_prepare/);assert.equal(e.starts.length,0);assert.equal(e.reasons.length,0)
})

test('远程 Ollama 卡显示真实目标，不把本机硬件与磁盘当作远程事实',()=>{
 const text=pullCardFacts({...baseFacts,local:false,baseURL:'https://models.example.com:443'})
 assert.match(text,/已配置的远程 Ollama https:\/\/models.example.com:443/);assert.match(text,/远程硬件适配：无法核对/);assert.doesNotMatch(text,/64.0 GiB|本机硬件适配/)
})
