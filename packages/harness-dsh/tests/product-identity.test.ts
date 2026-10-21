import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {tmpdir} from 'node:os'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt,renderPrompt,renderContextSnapshot} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {LocalJobRegistry} from '@deepseek-ai/dsh-jobs-local'
import {SubagentRuntime} from '@deepseek-ai/dsh-subagent'
import {TeamService} from '@deepseek-ai/dsh-experimental-agent-team'
import * as TeamTools from '@deepseek-ai/dsh-experimental-tool-agent-team'
import type {DigitalRole} from '@teloa/contract'
import {leaseEmployeeSystemPrompt} from '../src/employee-system-prompt.ts'
import {registerRoleConversationContext} from '../src/role-conversation-context.ts'
import {installNativeWorkingDirectory} from './fixtures/native-working-directory.ts'
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
 assert.match(text,/Teloa Community/);assert.match(text,/BYOK/);assert.match(text,/API, SDK and MCP/)
 assert.match(text,/DeepSeek Harness \(DSH\) is its execution framework/);assert.match(text,/MiniMax/)
 assert.match(text,/input tokens/);assert.match(text,/cache/);assert.match(text,/cumulative/);assert.match(text,/context-window utilization/)
 assert.match(text,/Without actual data, say usage cannot be confirmed/);assert.match(text,/do not guess.*uses little/)
 assert.match(text,/do not routinely recommend a new session for every task/)
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
  assert.equal(trustedInput(adapter.requests.at(-1)!).split('# Reply language').length-1,1,id+'原生Loop实际请求必须保留唯一语言契约')
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
  assert.match(renderContextSnapshot(assembly),/Internal routing and JSON.*take precedence/)
  assert.deepEqual(assembly.tools,[],kind+'产品规则不增加工具或授权')
  const input=kind==='internal-json'?'只输出约定 JSON，不作平台介绍。':'说明当前工作身份，不执行。'
  agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:input}]}));await agent.whenIdle()
  assert.ok(trustedInput(adapter.requests.at(-1)!).includes('Teloa Community'),kind+'实际请求仍含产品规则')
  assert.equal(trustedInput(adapter.requests.at(-1)!).split('# Reply language').length-1,1,kind+'语言契约不能依赖可选岗位或模式section')
 }
})

test('真实官方Team身份仅作内部路由；主会话、可信分身与员工各用Teloa工作身份且不增加权限',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'teloa-product-identity-')),ctx=new Context();t.after(async()=>{await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true})})
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry])await ctx.plugin(plugin)
 await ctx.plugin(SystemPrompt,systemConfig);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 await ctx.plugin(JsonlSessionPersistence,{root:directory,compression:'none'});await ctx.plugin(LocalJobRegistry,{});await installNativeWorkingDirectory(ctx,directory);await ctx.plugin(SubagentRuntime,{maxDepth:1,maxActiveSubagents:2});await ctx.plugin(TeamService,{maxMembers:2})
 const adapter=new Capture();ctx.llm.registerAdapter(['byok-fixture'],adapter)
 const owner='local:identity-test',at='2026-10-21T00:00:00.000Z',roles=new Map<string,DigitalRole>(),agents:{agent:Agent;kind:string;originalTeam:string;originalTools:string[]}[]=[]
 for(const kind of ['ordinary','twin','employee','internal-json'] as const){
  const {agent}=await ctx.agents.create({sessionId:SessionId('team-identity-'+kind),meta:{cwd:directory},agentOptions:{provider:'byok-fixture',model:'actual-BYOK-model'}})
  if(kind==='twin'||kind==='employee')roles.set(agent.id,{id:'role-'+kind,ownerId:owner,name:kind==='twin'?'验收本人的分身':'资料核验员',kind,state:'paused',version:3,scopes:['general'],duty:'核对本人提供的资料',dataScope:'仅本轮给定资料',executionScope:'只读，不审批、不外发',skills:[],knowledge:[],createdAt:at,updatedAt:at})
  if(kind==='internal-json')agent.ctx.systemPrompt.section({name:'fixture:routing-json',order:9900,text:groupRoutingInputNotice,interpolate:false})
  agents.push({agent,kind,originalTeam:'',originalTools:[]})
 }
 await ctx.plugin(TeamTools,{freshProvider:'spawn',forkProvider:'fork'})
 for(const row of agents){
  const {agent}=row,base=await ctx.systemPrompt.assemble({agent,scope:agent}),team=base.contexts.find(row=>row.name==='team:identity')
  assert.ok(team,'夹具必须实际挂载官方TeamTools');assert.ok(team.text.includes('You are the Team Lead named "lead".'),'不能用自写字符串代替原生路由上下文')
  row.originalTeam=team.text;row.originalTools=base.tools.map(row=>row.name)
 }
 registerRoleConversationContext(ctx,{owner,conversation:async sessionId=>({id:'binding-'+sessionId,ownerId:owner,sessionId,status:'ready'}),requestedRoleId:async id=>roles.get(id)?.id??null,links:async sessionId=>{const role=roles.get(sessionId);return role?[{kind:'role',objectId:role.id,conversationId:'binding-'+sessionId,sessionId,scopeId:'general',active:true}]:[]},role:async roleId=>[...roles.values()].find(role=>role.id===roleId)??null})
 await ctx.plugin(await import(identity.name),identity.config)
 for(const {agent,kind,originalTeam,originalTools} of agents){
  const assembly=await ctx.systemPrompt.assemble({agent,scope:agent}),team=assembly.contexts.find(row=>row.name==='team:identity')!
  assert.equal(assembly.contexts.filter(row=>row.name==='team:identity').length,1,kind+'保留官方required路由上下文');assert.equal(team.text,originalTeam,kind+'原路由名与工具协议逐字保留')
  const metadata=assembly.contexts.find(row=>row.name==='teloa:team-routing-metadata')!
  assert.match(metadata.text,/Internal collaboration routing metadata/);assert.match(metadata.text,/not your user-facing identity/)
  assert.ok(assembly.contexts.indexOf(metadata)<assembly.contexts.indexOf(team),'在原生Team身份之前标明精确上下文用途')
  assert.deepEqual(assembly.tools.map(row=>row.name),originalTools,kind+'身份规则不能授予或撤下工具')
  const snapshot=renderContextSnapshot(assembly),role=roles.get(agent.id)
  if(role){assert.match(snapshot,new RegExp(role.name));assert.match(snapshot,/Role version: 3/);assert.match(snapshot,/只读，不审批、不外发/);assert.match(snapshot,kind==='twin'?/the user's personal twin in Teloa/:/a Teloa AI employee/);if(kind==='twin')assert.doesNotMatch(snapshot,/a Teloa AI employee/)}
  agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:kind==='internal-json'?'只输出约定 JSON，不作身份介绍。':'你是谁？不执行任何动作。'}]}));await agent.whenIdle()
  const request=adapter.requests.at(-1)!,text=trustedInput(request)
  assert.match(text,/Internal collaboration routing metadata/,'发送前官方refreshContext不能抹掉内部路由分类')
  assert.equal(text.split(productIdentityText).length-1,1,kind+'仍只注入一份产品规则')
  assert.match(text,/ordinary conversation.*Teloa assistant/);assert.match(text,/personal twin.*employee/);assert.match(text,/Never impersonate the user/);assert.match(text,/actual.*model|model.*actual/)
  assert.match(text,/only when.*technical architecture/);assert.match(text,/Internal routing and JSON.*take precedence/)
  assert.doesNotMatch(text,/You are an AI agent powered by DeepSeek Harness\./)
  assert.match(text,/actual-BYOK-model/,'真实BYOK模型变量保留，不改成虚构模型')
  if(kind==='internal-json')assert.ok(text.includes(groupRoutingInputNotice),'原内部JSON协议逐字保留')
 }
 assert.equal(adapter.requests.length,4)
 const agent=agents[0]!.agent
 agent.ctx.systemPrompt.section({name:'fixture:complete-persona',complete:true,order:0,text:'Complete native mode; preserve required runtime facts.',interpolate:false})
 agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'继续原会话，说明当前身份，不执行。'}]}));await agent.whenIdle()
 const complete=trustedInput(adapter.requests.at(-1)!)
 assert.equal(complete.split(productIdentityText).length-1,1,'完整persona模式继续保留单份产品规则')
 assert.equal(complete.split('# Reply language').length-1,1,'完整persona替换所有section后仍须保留唯一语言契约')
 assert.equal(complete.split('Internal collaboration routing metadata').length-1,1,'完整persona及连续会话仍保留单份required路由分类')
 assert.ok(complete.includes(agents[0]!.originalTeam),'完整persona模式不删除原Team身份路由协议')
 assert.equal(adapter.requests.length,5)
})
