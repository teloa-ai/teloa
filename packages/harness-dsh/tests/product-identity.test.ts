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
import {LlmAdapter,LlmRuntime,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt,renderPrompt,renderContextSnapshot} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {LocalJobRegistry} from '@deepseek-ai/dsh-jobs-local'
import {SubagentRuntime} from '@deepseek-ai/dsh-subagent'
import {TeamService} from '@deepseek-ai/dsh-experimental-agent-team'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type {DigitalRole} from '@teloa/contract'
import {leaseEmployeeSystemPrompt} from '../src/employee-system-prompt.ts'
import {registerRoleConversationContext} from '../src/role-conversation-context.ts'
import {installNativeWorkingDirectory} from './fixtures/native-working-directory.ts'
import {groupRoutingInputNotice} from '../src/group-routing.ts'
import {refineWorkBehavior} from '../src/work-behavior.ts'
import {productIdentityText} from '../src/work-prompts/product-identity.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'

const require=createRequire(import.meta.url),officialRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const {parse}=require('yaml'),yaml=(source:string)=>parse(source,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>value}]})
const bundle=yaml(await readFile(new URL('../../bundle/cordis.patch.yml',import.meta.url),'utf8'))
const systemConfig=bundle.find((row:any)=>row.id==='system-prompt')?.config??{}
const identity=bundle.flatMap((row:any)=>row.insert??[]).find((row:any)=>row.id==='teloa-product-identity')
const standard=yaml(await readFile(new URL('../../bundle/agent-presets/teloa-standard/agent.cordis.yml',import.meta.url),'utf8'))[0].insert[0].config
class Capture extends LlmAdapter{
 requests:GenerateOptions[]=[]
 beforeFinish?:(options:GenerateOptions)=>Promise<void>
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions):AsyncGenerator<StreamChunk>{this.requests.push(options);await this.beforeFinish?.(options);yield {type:'finish',reason:{kind:'stop'}}}
}
const trustedInput=(request:GenerateOptions)=>request.messages.filter(row=>row.role==='system'||row.source?.kind==='runtime-context').flatMap(row=>row.content.flatMap(block=>block.type==='text'?[block.text]:[])).join('\n\n')

test('实际bundle与官方SystemPrompt装配只保留Teloa产品身份，不再同时自称DeepSeek Harness产品',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
 await ctx.plugin(SystemPrompt,systemConfig);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new Capture();ctx.llm.registerAdapter(['minimax-fixture'],adapter)
 let permission='本人权限：只读已提供资料；未经确认不得发送。'
 ctx.systemPrompt.context({name:'fixture:permission',order:110,text:()=>permission})
 ctx.tools.register(defineTool({name:'read_fixture',description:'只读已授权资料',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>'fixture'}))
 if(identity)await ctx.plugin(await import(identity.name),identity.config)
 const {agent}=await ctx.agents.create({sessionId:SessionId('product-identity-default'),agentOptions:{provider:'minimax-fixture',model:'MiniMax-M3'}})
 const legacyProducts=['# Teloa 产品与用量事实\n\n旧静态产品规则。','# Teloa identity and usage\n\nOld static product rule.']
 const legacy=legacyProducts.map(legacyProduct=>{
  const sections=[{name:'teloa:product-identity',text:legacyProduct},{name:'fixture:historical-permission',text:'历史权限事实：只读旧资料。'}]
  return agent.session.append('user/message',createUserMessage({source:{kind:'runtime-context',form:'snapshot',sections},content:[{type:'text',text:'Original wrapper prefix\n'+sections.map(row=>row.text).join('\n\n')+'\nOriginal wrapper suffix'},{type:'text',text:'Other content block remains literal: {{not-a-variable}}'}]}),{surfaceOp:'append'})
 })
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
 for(const legacyProduct of legacyProducts)assert.ok(!text.includes(legacyProduct),'已知中英文旧版静态正文均应从模型投影中退休')
 assert.match(text,/Original wrapper prefix\n历史权限事实：只读旧资料。\nOriginal wrapper suffix/)
 assert.match(text,/Other content block remains literal: \{\{not-a-variable\}\}/)
 for(const [index,event] of legacy.entries()){
  const original=readSessionEvents(agent.session).find(row=>row.seq===event.seq)
  assert.ok(original?.type==='user/message'&&original.data.content.some(block=>block.type==='text'&&block.text.includes(legacyProducts[index]!)),'原始历史事件必须保留，退休只追加可追溯替换')
 }
 assert.equal(refineWorkBehavior(assembly,true).contexts.filter(row=>row.name==='teloa:product-identity').length,1,'工具收窄仍保留唯一产品与用量规则')
 assert.match(renderContextSnapshot(assembly),/本人权限：只读已提供资料；未经确认不得发送。/)
 assert.deepEqual(assembly.tools.map(row=>row.name),['read_fixture'])
 assert.ok(request.messages.some(row=>row.role==='user'&&row.content.some(block=>block.type==='text'&&block.text==='介绍当前平台；当前会话消耗是否较小？')))
 permission='本人权限：仍只读；当前资料范围缩小为本人指定的一份记录。'
 agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'继续原会话，不执行。'}]}));await agent.whenIdle()
 assert.equal(trustedInput(adapter.requests.at(-1)!).split(productIdentityText).length-1,1,'连续会话不重复注入相同产品规则')
 assert.match(trustedInput(adapter.requests.at(-1)!),/只读已提供资料；未经确认不得发送/,'旧权限事实不能随静态规则被抹掉')
 assert.ok(trustedInput(adapter.requests.at(-1)!).includes(permission),'当前权限事实仍进入真实请求')
 const runtimeCount=()=>readSessionEvents(agent.session).filter(row=>row.type==='user/message'&&row.data.source.kind==='runtime-context').length
 const beforeUnchanged=runtimeCount()
 agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'保持当前范围，不执行。'}]}));await agent.whenIdle()
 assert.equal(trustedInput(adapter.requests.at(-1)!).split(productIdentityText).length-1,1)
 assert.equal(runtimeCount(),beforeUnchanged,'上下文未变时不应重复投影产品规则')
 let changeDuringAdmission=true
 const release=agent.ctx.on('agent/pre-step',async(_payload,next)=>{
  const decision=await next()
  if(changeDuringAdmission){permission='准备期间更新权限：仍只读最后指定的记录。';changeDuringAdmission=false}
  return decision
 },{prepend:true})
 agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'核对更新后的范围，不执行。'}]}));await agent.whenIdle();release()
 assert.ok(trustedInput(adapter.requests.at(-1)!).includes(permission),'最终 admission 刷新不能丢当前权限')
 assert.match(trustedInput(adapter.requests.at(-1)!),/历史权限事实：只读旧资料/)
 agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'继续当前范围，不执行。'}]}));await agent.whenIdle()
 assert.equal(trustedInput(adapter.requests.at(-1)!).split(productIdentityText).length-1,1,'准备期间的交错更新至下一次装配收敛，不让静态副本继续累积')
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
  assert.equal(trustedInput(adapter.requests.at(-1)!).split('# Conversational style').length-1,1,id+'自然简洁规则须覆盖所有模式且不重复')
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
  assert.equal(trustedInput(adapter.requests.at(-1)!).split('# Conversational style').length-1,1,kind+'岗位职责不应导致自我介绍展开清单')
 }
})

test('真实官方Team身份仅作内部路由；主会话、可信分身与员工各用Teloa工作身份且不增加权限',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'teloa-product-identity-')),ctx=new Context();t.after(async()=>{await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true})})
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry])await ctx.plugin(plugin)
 await ctx.plugin(SystemPrompt,systemConfig);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 await ctx.plugin(JsonlSessionPersistence,{root:directory,compression:'none'});await ctx.plugin(LocalJobRegistry,{});await installNativeWorkingDirectory(ctx,directory);await ctx.plugin(SubagentRuntime,{maxDepth:1,maxActiveSubagents:2});await ctx.plugin(Spawn,{providerName:'spawn'});await ctx.plugin(TeamService,{maxMembers:2})
 const adapter=new Capture();ctx.llm.registerAdapter(['byok-fixture'],adapter)
 const owner='local:identity-test',at='2026-10-21T00:00:00.000Z',roles=new Map<string,DigitalRole>(),agents:{agent:Agent;kind:string;originalTeam:string;originalTools:string[]}[]=[]
 for(const kind of ['ordinary','twin','employee','internal-json'] as const){
  const {agent}=await ctx.agents.create({sessionId:SessionId('team-identity-'+kind),meta:{cwd:directory},agentOptions:{provider:'byok-fixture',model:'actual-BYOK-model'}})
  if(kind==='twin'||kind==='employee')roles.set(agent.id,{id:'role-'+kind,ownerId:owner,name:kind==='twin'?'验收本人的分身':'资料核验员',kind,state:'paused',version:3,scopes:['general'],duty:'核对本人提供的资料',dataScope:'仅本轮给定资料',executionScope:'只读，不审批、不外发',skills:[],knowledge:[],createdAt:at,updatedAt:at})
  if(kind==='internal-json')agent.ctx.systemPrompt.section({name:'fixture:routing-json',order:9900,text:groupRoutingInputNotice,interpolate:false})
  agents.push({agent,kind,originalTeam:'',originalTools:[]})
 }
 const teamPackage=await patchedNativePackage<typeof import('@deepseek-ai/dsh-experimental-tool-agent-team')>(t,{packageName:'@deepseek-ai/dsh-experimental-tool-agent-team',compatBasename:'dsh-experimental-tool-agent-team-0.2.1-rc.2-routing-context'})
 await ctx.plugin(teamPackage.namespace,{freshProvider:'spawn',forkProvider:'fork'})
 for(const row of agents){
  const {agent}=row,base=await ctx.systemPrompt.assemble({agent,scope:agent}),team=base.contexts.find(row=>row.name==='team:identity')
  assert.ok(team,'夹具必须实际挂载经固定摘要核验的官方TeamTools');assert.match(team.text,/Native Team routing metadata: role="lead", name="lead", lead="lead"\./)
  row.originalTeam=team.text;row.originalTools=base.tools.map(row=>row.name)
 }
 registerRoleConversationContext(ctx,{owner,conversation:async sessionId=>({id:'binding-'+sessionId,ownerId:owner,sessionId,status:'ready'}),requestedRoleId:async id=>roles.get(id)?.id??null,links:async sessionId=>{const role=roles.get(sessionId);return role?[{kind:'role',objectId:role.id,conversationId:'binding-'+sessionId,sessionId,scopeId:'general',active:true}]:[]},role:async roleId=>[...roles.values()].find(role=>role.id===roleId)??null})
 await ctx.plugin(await import(identity.name),identity.config)
 const legacyLead='You are the Team Lead named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).'
 const employee=agents.find(row=>row.kind==='employee')!.agent
 const sections=[{name:'team:identity',text:legacyLead},{name:'fixture:historical-permission',text:'旧会话范围：仅原合成订单，无联网权限。'}]
 const legacy=employee.session.append('user/message',createUserMessage({source:{kind:'runtime-context',form:'snapshot',sections},content:[{type:'text',text:'Original Team wrapper\n'+sections.map(row=>row.text).join('\n\n')}]}),{surfaceOp:'append'})
 for(const {agent,kind,originalTeam,originalTools} of agents){
  const assembly=await ctx.systemPrompt.assemble({agent,scope:agent}),team=assembly.contexts.find(row=>row.name==='team:identity')!
  assert.equal(assembly.contexts.filter(row=>row.name==='team:identity').length,1,kind+'保留官方required路由上下文');assert.equal(team.text,originalTeam,kind+'原路由名与工具协议逐字保留')
  const metadata=assembly.contexts.find(row=>row.name==='teloa:team-routing-metadata')!
  assert.match(metadata.text,/Teloa group routing boundary/);assert.match(metadata.text,/separate from the native Team roster/);assert.match(metadata.text,/does not require listing or spawning/)
  assert.ok(assembly.contexts.indexOf(metadata)<assembly.contexts.indexOf(team),'在原生Team身份之前标明精确上下文用途')
  assert.deepEqual(assembly.tools.map(row=>row.name),originalTools,kind+'身份规则不能授予或撤下工具')
  const snapshot=renderContextSnapshot(assembly),role=roles.get(agent.id)
  if(role){assert.match(snapshot,new RegExp(role.name));assert.match(snapshot,/Role version: 3/);assert.match(snapshot,/只读，不审批、不外发/);assert.match(snapshot,kind==='twin'?/the user's personal twin in Teloa/:/a Teloa AI employee/);if(kind==='twin')assert.doesNotMatch(snapshot,/a Teloa AI employee/)}
  agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:kind==='internal-json'?'只输出约定 JSON，不作身份介绍。':'你是谁？不执行任何动作。'}]}));await agent.whenIdle()
  const request=adapter.requests.at(-1)!,text=trustedInput(request)
  assert.doesNotMatch(text,/Use list_agents\(\{\}\) to find your teammates and their names\./,'最终模型输入不得无条件要求枚举原生队友')
  const refreshed=await ctx.systemPrompt.refreshContext(assembly,{agent,scope:agent})
  assert.doesNotMatch(renderContextSnapshot(refreshed),/Use list_agents\(\{\}\) to find your teammates and their names\./,'发送前 refreshContext 必须保留按实际协作需要发现队友的契约')
  assert.match(text,/Teloa group routing boundary/,'发送前官方refreshContext不能抹掉群与原生Team边界')
  assert.match(text,/only when the current task requires native teammate collaboration/)
  assert.match(text,/whose routing name is unknown, use list_agents\(\{\}\); otherwise use the known target directly/)
  assert.equal(text.split(productIdentityText).length-1,1,kind+'仍只注入一份产品规则')
  assert.match(text,/ordinary conversation.*Teloa assistant/);assert.match(text,/personal twin.*employee/);assert.match(text,/Never impersonate the user/);assert.match(text,/actual.*model|model.*actual/)
  assert.match(text,/only when.*technical architecture/);assert.match(text,/Internal routing and JSON.*take precedence/)
  assert.doesNotMatch(text,/You are an AI agent powered by DeepSeek Harness\./)
  assert.match(text,/actual-BYOK-model/,'真实BYOK模型变量保留，不改成虚构模型')
  if(kind==='internal-json')assert.ok(text.includes(groupRoutingInputNotice),'原内部JSON协议逐字保留')
  if(kind==='employee')assert.match(text,/Original Team wrapper\n旧会话范围：仅原合成订单，无联网权限。/,'退休旧Team引导必须保留原包装与权限')
 }
 assert.ok(readSessionEvents(employee.session).some(row=>row.seq===legacy.seq&&row.type==='user/message'&&row.data.content.some(block=>block.type==='text'&&block.text.includes(legacyLead))),'原失败指令事件保留，历史投影退休不能删原始证据')
 assert.equal(adapter.requests.length,4)
 const agent=agents[0]!.agent
 agent.ctx.systemPrompt.section({name:'fixture:complete-persona',complete:true,order:0,text:'Complete native mode; preserve required runtime facts.',interpolate:false})
 agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'继续原会话，说明当前身份，不执行。'}]}));await agent.whenIdle()
 const complete=trustedInput(adapter.requests.at(-1)!)
 assert.equal(complete.split(productIdentityText).length-1,1,'完整persona模式继续保留单份产品规则')
 assert.equal(complete.split('# Reply language').length-1,1,'完整persona替换所有section后仍须保留唯一语言契约')
 assert.equal(complete.split('# Conversational style').length-1,1,'完整persona也须保留同一简洁交流规则')
 assert.equal(complete.split('Teloa group routing boundary').length-1,1,'完整persona及连续会话仍保留单份required群路由边界')
 assert.ok(complete.includes(agents[0]!.originalTeam),'完整persona模式不删除原Team身份路由协议')
 assert.equal(adapter.requests.length,5)
 // 显式需要协作时，真实子代理仍按原生姓名/lead 路由，不能把员工名字映射成原生成员。
 let releaseChild!:()=>void;const childGate=new Promise<void>(resolve=>{releaseChild=resolve});t.after(releaseChild)
 adapter.beforeFinish=async options=>{if(String(options.sessionId)!==String(agent.id)){
  options.signal?.addEventListener('abort',releaseChild,{once:true})
  try{await childGate}finally{options.signal?.removeEventListener('abort',releaseChild)}
 }}
 const spawned=await ctx.agentTeams.spawnTeammate(agent,{name:'reviewer',description:'复核合成事实',prompt:[{type:'text',text:'只读合成材料，完成后向原生 lead 汇报。'}],context:'fresh',provider:'spawn',signal:AbortSignal.timeout(5000)})
 const child=ctx.agents.get(spawned.member.id)!;assert.ok(child)
 for(let attempt=0;attempt<100&&!adapter.requests.some(row=>String(row.sessionId)===String(child.id));attempt++)await new Promise(resolve=>setTimeout(resolve,5))
 assert.equal(child.session.header.parentSession,agent.id)
 const legacyMember=legacyLead.replace('You are the Team Lead named "lead".','You are teammate "reviewer".\nYour Team Lead is named "lead".\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).')
 const legacyChild=child.session.append('user/message',createUserMessage({source:{kind:'runtime-context',form:'snapshot',sections:[{name:'team:identity',text:legacyMember},{name:'fixture:permission',text:'子成员历史权限：只读。'}]},content:[{type:'text',text:legacyMember+'\n\n子成员历史权限：只读。'}]}),{surfaceOp:'append'})
 const childAssembly=await ctx.systemPrompt.assemble({agent:child,scope:child})
 const childRefreshed=await ctx.systemPrompt.refreshContext(childAssembly,{agent:child,scope:child})
 const childContext=renderContextSnapshot(childRefreshed)
 assert.match(childContext,/role="teammate", name="reviewer", lead="lead"/)
 assert.match(childContext,/When the task requires reporting.*send_message\(\{ target: "lead", message: "\.\.\." \}\)/)
 assert.doesNotMatch(childContext,/Use list_agents\(\{\}\) to find your teammates/)
 const childSurface=new Set(child.session.surface.nodes),visibleChild=readSessionEvents(child.session).filter(row=>childSurface.has(row.seq)&&row.type==='user/message').map(row=>JSON.stringify(row.data)).join('\n')
 assert.doesNotMatch(visibleChild,/Use list_agents\(\{\}\) to find your teammates/);assert.match(visibleChild,/子成员历史权限：只读/)
 assert.ok(readSessionEvents(child.session).some(row=>row.seq===legacyChild.seq&&JSON.stringify(row.data).includes('Use list_agents')),'旧成员原始事件也保留')
 const childRequest=adapter.requests.find(row=>String(row.sessionId)===String(child.id))!
 assert.ok(childRequest);assert.match(trustedInput(childRequest),/role="teammate", name="reviewer", lead="lead"/)
 assert.ok(childRequest.messages.some(row=>row.content.some(block=>block.type==='text'&&block.text.includes('只读合成材料'))),'子代理实际任务与权限上下文保留')
 const listed=await child.ctx.tools.execute({agent:child,name:'list_agents',arguments:{},callId:ToolCallId('team-list-needed'),signal:AbortSignal.timeout(5000)})
 assert.equal(listed.isError,false);assert.match(JSON.stringify(listed),/reviewer/);assert.match(JSON.stringify(listed),/lead/)
 const sent=await child.ctx.tools.execute({agent:child,name:'send_message',arguments:{target:'lead',message:'原生复核完成，仅已给定合成材料。'},callId:ToolCallId('team-report-needed'),signal:AbortSignal.timeout(5000)})
 assert.equal(sent.isError,false);await agent.whenIdle()
 assert.ok(adapter.requests.at(-1)!.messages.some(row=>row.content.some(block=>block.type==='text'&&block.text.includes('原生复核完成'))),'原生成员到lead的工具路由仍实际可用')
 releaseChild();await child.whenIdle()
})
