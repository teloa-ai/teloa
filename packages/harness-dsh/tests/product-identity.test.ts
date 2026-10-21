import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt,renderPrompt,renderContextSnapshot} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {leaseEmployeeSystemPrompt} from '../src/employee-system-prompt.ts'
import {groupRoutingInputNotice} from '../src/group-routing.ts'
import {refineWorkBehavior} from '../src/work-behavior.ts'
import {productIdentityText} from '../src/work-prompts/product-identity.ts'

const require=createRequire(import.meta.url),officialRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const {parse}=require('yaml'),yaml=(source:string)=>parse(source,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>value}]})
const bundle=yaml(await readFile(new URL('../../bundle/cordis.patch.yml',import.meta.url),'utf8'))
const systemConfig=bundle.find((row:any)=>row.id==='system-prompt')?.config??{}
const identity=bundle.flatMap((row:any)=>row.insert??[]).find((row:any)=>row.id==='teloa-product-identity')
const standard=yaml(await readFile(new URL('../../bundle/agent-presets/teloa-standard/agent.cordis.yml',import.meta.url),'utf8'))[0].insert[0].config
class Capture extends LlmAdapter{
 requests:GenerateOptions[]=[]
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions):AsyncGenerator<StreamChunk>{this.requests.push(options);yield {type:'finish',reason:{kind:'stop'}}}
}
const trustedInput=(request:GenerateOptions)=>request.messages.filter(row=>row.role==='system'||row.source?.kind==='runtime-context').flatMap(row=>row.content.flatMap(block=>block.type==='text'?[block.text]:[])).join('\n\n')

test('实际bundle与官方SystemPrompt装配只保留Teloa产品身份，不再同时自称DeepSeek Harness产品',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
 await ctx.plugin(SystemPrompt,systemConfig);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new Capture();ctx.llm.registerAdapter(['minimax-fixture'],adapter)
 ctx.systemPrompt.context({name:'fixture:permission',order:110,text:'本人权限：只读已提供资料；未经确认不得发送。'})
 ctx.tools.register(defineTool({name:'read_fixture',description:'只读已授权资料',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>'fixture'}))
 if(identity)await ctx.plugin(await import(identity.name),identity.config)
 const {agent}=await ctx.agents.create({sessionId:SessionId('product-identity-default'),agentOptions:{provider:'minimax-fixture',model:'MiniMax-M3'}})
 const persona=standard.plugins.find((row:any)=>row.id==='persona'),behavior=standard.plugins.find((row:any)=>row.id==='teloa-work-behavior')
 await agent.ctx.plugin(await import(pathToFileURL(officialRequire.resolve(persona.name)).href),persona.config)
 await agent.ctx.plugin(await import(behavior.name),behavior.config)
 agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'介绍当前平台；当前会话消耗是否较小？'}]}));await agent.whenIdle()
 assert.equal(adapter.requests.length,1)
 const request=adapter.requests[0]!,text=trustedInput(request),assembly=await ctx.systemPrompt.assemble({agent,scope:agent})
 assert.doesNotMatch(text,/You are an AI agent powered by DeepSeek Harness\./,'官方默认HARNESS_IDENTITY仍与Teloa persona同时进入真实模型请求')
 assert.equal(systemConfig.includeHarnessIdentity,false)
 assert.ok(identity,'产品规则应在宿主作用域覆盖所有官方模式')
 assert.match(text,/Teloa 社区版/);assert.match(text,/BYOK/);assert.match(text,/API、SDK、MCP/)
 assert.match(text,/DeepSeek Harness（DSH）是底层执行框架/);assert.match(text,/MiniMax/)
 assert.match(text,/输入 token/);assert.match(text,/缓存/);assert.match(text,/累计/);assert.match(text,/上下文窗口占比/)
 assert.match(text,/没有真实数据时明确说无法确认/);assert.match(text,/不能猜测.*较小/)
 assert.match(text,/不能一概建议每个任务新建会话/)
 assert.equal(assembly.contexts.filter(row=>row.name==='teloa:product-identity').length,1)
 assert.equal(text.split(productIdentityText).length-1,1,'实际请求只注入一份产品与用量规则')
 assert.equal(refineWorkBehavior(assembly,true).contexts.filter(row=>row.name==='teloa:product-identity').length,1,'工具收窄仍保留唯一产品与用量规则')
 assert.match(renderContextSnapshot(assembly),/本人权限：只读已提供资料；未经确认不得发送。/)
 assert.deepEqual(assembly.tools.map(row=>row.name),['read_fixture'])
 assert.ok(request.messages.some(row=>row.role==='user'&&row.content.some(block=>block.type==='text'&&block.text==='介绍当前平台；当前会话消耗是否较小？')))
 agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'继续原会话，不执行。'}]}));await agent.whenIdle()
 assert.equal(trustedInput(adapter.requests.at(-1)!).split(productIdentityText).length-1,1,'连续会话不重复注入相同产品规则')
})

test('普通/分身/员工/Run及所有官方模式继承同一短规则，可信身份权限和内部JSON协议不被改写',async t=>{
 assert.ok(identity,'缺少宿主产品规则装配')
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry])await ctx.plugin(plugin)
 await ctx.plugin(SystemPrompt,systemConfig);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new Capture();ctx.llm.registerAdapter(['minimax-fixture'],adapter)
 await ctx.plugin(await import(identity.name),identity.config)
 const presetRoot=dirname(officialRequire.resolve('@deepseek-ai/dsh-web-app/package.json'))
 for(const id of ['teloa-standard','standard','ptc','ptc-persistent','ptc-python','minimal','cordis']){
  const row=id==='teloa-standard'?undefined:yaml(await readFile(id==='minimal'?join(presetRoot,'presets/minimal.patch.yml'):new URL('../../bundle/agent-presets/'+id+'.patch.yml',import.meta.url),'utf8'))[0]
  const preset=id==='teloa-standard'?standard:(row.insert?.[0]??row).config
  const {agent}=await ctx.agents.create({sessionId:SessionId('product-mode-'+id),agentOptions:{provider:'minimax-fixture',model:'MiniMax-M3'}})
  const persona=preset.plugins?.find((row:any)=>row.id==='persona')
  if(persona)await agent.ctx.plugin(await import(pathToFileURL(officialRequire.resolve(persona.name)).href),persona.config)
  const before=await ctx.systemPrompt.assemble({agent,scope:agent})
  assert.equal(before.contexts.filter(row=>row.name==='teloa:product-identity').length,1,id)
  assert.doesNotMatch(renderPrompt(before),/You are an AI agent powered by DeepSeek Harness\./,id)
  agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'介绍平台，不执行。'}]}));await agent.whenIdle()
  assert.equal(trustedInput(adapter.requests.at(-1)!).split(productIdentityText).length-1,1,id+'实际请求只含唯一短规则')
 }
 for(const kind of ['ordinary','twin','employee','run','plan','internal-json']){
  const {agent}=await ctx.agents.create({sessionId:SessionId('product-scope-'+kind),agentOptions:{provider:'minimax-fixture',model:'MiniMax-M3'}})
  const fact=kind==='internal-json'?groupRoutingInputNotice:'宿主核实身份='+kind+'；权限=只读；模式='+kind+'；不得自动确认。'
  agent.ctx.systemPrompt.context({name:'fixture:trusted-role',order:110,text:fact,required:true,interpolate:false})
  if(kind==='employee'||kind==='run')leaseEmployeeSystemPrompt(agent,'employee')
  if(kind==='internal-json')agent.ctx.systemPrompt.section({name:'fixture:internal-json',order:9900,text:groupRoutingInputNotice,interpolate:false})
  const assembly=await ctx.systemPrompt.assemble({agent,scope:agent})
  assert.equal(assembly.contexts.filter(row=>row.name==='teloa:product-identity').length,1,kind)
  assert.ok(renderContextSnapshot(assembly).includes(fact),kind+'原可信上下文必须逐字保留')
  assert.match(renderContextSnapshot(assembly),/内部路由、JSON.*协议优先/)
  assert.deepEqual(assembly.tools,[],kind+'产品规则不增加工具或授权')
  const input=kind==='internal-json'?'只输出约定 JSON，不作平台介绍。':'说明当前工作身份，不执行。'
  agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:input}]}));await agent.whenIdle()
  assert.ok(trustedInput(adapter.requests.at(-1)!).includes('Teloa 社区版'),kind+'实际请求仍含产品规则')
 }
})
