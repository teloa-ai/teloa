import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt,renderPrompt,renderContextSnapshot,type PromptAssembly} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'

class CaptureAdapter extends LlmAdapter{
 requests:GenerateOptions[]=[]
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions):AsyncGenerator<StreamChunk>{
  this.requests.push(options)
  yield {type:'block-start',index:0,blockType:'text'}
  yield {type:'text-delta',index:0,text:'已收到'}
  yield {type:'block-end',index:0,block:{type:'text',text:'已收到'}}
  yield {type:'finish',reason:{kind:'stop'}}
 }
}

test('默认预设的完整行为进入模型请求，保留原生工具及权限上下文，隔离其他会话',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
 await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new CaptureAdapter();ctx.llm.registerAdapter(['capture'],adapter)
 ctx.systemPrompt.context({name:'fixture:permission',order:110,text:'当前授权仅允许读取测试资料。'})
 ctx.tools.register(defineTool({name:'read_fixture',description:'读取已授权测试资料',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=> '测试资料'}))
 const {agent:standard}=await ctx.agents.create({sessionId:SessionId('full-behavior-standard'),agentOptions:{provider:'capture',model:'model'}})
 const {agent:other}=await ctx.agents.create({sessionId:SessionId('full-behavior-other'),agentOptions:{provider:'capture',model:'model'}})
 const {parse}=createRequire(import.meta.url)('yaml')
 const preset=parse(await readFile(new URL('../../bundle/agent-presets/teloa-standard/agent.cordis.yml',import.meta.url),'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>value}]})[0].insert[0]
 const row=preset.config.plugins.find((entry:{id:string})=>entry.id==='teloa-work-behavior')
 assert.ok(row,'默认预设尚未接入完整行为插件')
 const plugin=await import(row.name)
 const before=(await ctx.systemPrompt.assemble({agent:standard,scope:standard})).tools
 const mounted=await standard.ctx.plugin(plugin,row.config??{})
 const assembled=await ctx.systemPrompt.assemble({agent:standard,scope:standard})
 assert.deepEqual(assembled.tools,before,'行为接入不能改动原生工具 schema 或工具范围')
 assert.match(renderContextSnapshot(assembled),/当前授权仅允许读取测试资料/)
 assert.equal(assembled.sections.filter(section=>section.name==='teloa:work-behavior').length,1)
 assert.equal((await ctx.systemPrompt.assemble({agent:other,scope:other})).sections.some(section=>section.name==='teloa:work-behavior'),false)
 standard.followup(createUserMessage({source:{kind:'user',rpcId:'full-behavior-input'},content:[{type:'text',text:'核对测试资料'}]}));await standard.whenIdle()
 assert.equal(adapter.requests.length,1)
 const system=adapter.requests[0]!.messages.filter(message=>message.role==='system').flatMap(message=>message.content.filter(block=>block.type==='text').map(block=>block.text)).join('\n\n')
 assert.equal(system,renderPrompt(assembled))
 assert.match(system,/本轮可用且适用的连接器或直接接口/)
 assert.match(system,/视觉核对或接口未覆盖时用界面操作/)
 assert.match(system,/路径切换不改变权限、宿主与资料范围/)
 assert.match(system,/下一步只能来自当前工具或界面明确提供的入口/)
 assert.match(system,/不推测按钮、页面和流程/)
 assert.match(system,/本人只要求核对平台资源或原稿的当前状态时，答复止于名称、可读状态和本人需要的原稿入口/)
 assert.match(system,/这不限制本人要求的正文读取、总结、分析或组合任务/)
 assert.doesNotMatch(system,/只读查询完成后，答复止于/)
 assert.match(system,/不附加未要求的安装、启用、重建或跳转页面建议/)
 assert.match(system,/明确授权后的配置或应用继续沿原会话工具/)
 assert.match(system,/历史工具快照只能作为定位线索/)
 assert.match(system,/源记录与成果不能合称为同一记录的版本/)
 // 事实边界（caf 诊断与首批 8 例真实输出）：few-shot 示例变事实、提供摘录却称已打开应用、未知阶段写成已完成/不变。四条约定随核心模块进入真实请求。
 // 澄清（v2）：只约束明确作为示例/范文的内容，不否定方法里的实际业务定义；“真实授权回执”只约束助手自己本轮声称的动作，资料记载的他人已完成动作可忠实转述。
 assert.match(system,/模板或工作方法中明确作为示例、范文或演示的人物、数字、案例与对话只说明格式与方法，不能当作本次客户或本人的经历/)
 assert.match(system,/方法里的实际业务定义、规则与本人授权的背景按其来源使用/)
 assert.match(system,/本人为假设情境提供的合成资料只在该情境内使用，不外推为真实经营结果/)
 assert.match(system,/资料记载的他人已完成动作按来源忠实转述/)
 assert.match(system,/助手自己本轮声称已连接、打开、查询、发送或建单，只能以本轮真实授权回执为据/)
 assert.match(system,/提到某个应用或收到其摘录不等于自己打开或查询过它/)
 assert.match(system,/未知的阶段、日期、负责人或结论写明未知，不写成已完成、没有变化或默认值/)
 assert.match(system,/本人明确要求虚构写作或示意文案时按要求创作，不附加无关提醒/)
 // 反例：v1 的过宽措辞不再出现（它会否定方法里的真实业务定义，以及资料中他人已完成的动作，如 Writing 素材里“Priya 已审核明细”）。
 assert.doesNotMatch(system,/模板、工作方法和示例里的人物、数字、案例与范文只说明格式与方法，不是本轮已发生的事实/)
 assert.doesNotMatch(system,/只有本轮真实授权回执能支持“已打开、已发送、已建单”这类动作完成的说法/)
 assert.match(JSON.stringify(adapter.requests[0]!.messages),/当前授权仅允许读取测试资料/)
 const facts=runtimeFacts(assembled)
 assert.equal(facts.behavior_version,'2026-10-15.fact-language.v3')
 assert.deepEqual(facts.modules,['01-core','02-tools','03-planning','08-artifacts'])
 const input=adapter.requests[0]!.messages.find(message=>message.source?.kind==='user'&&message.content.some(block=>block.type==='text'&&block.text==='核对测试资料'))
 assert.ok(input,'追加规则不能把实际用户输入改成工作资料')
 await mounted.dispose()
 assert.equal((await ctx.systemPrompt.assemble({agent:standard,scope:standard})).sections.some(section=>section.name==='teloa:work-behavior'),false)
 assert.equal((await ctx.systemPrompt.assemble({agent:standard,scope:standard})).contexts.some(row=>row.name==='teloa:work-behavior-runtime'),false)
})

function runtimeFacts(assembly:PromptAssembly):{modules:string[];behavior_version:string}{
 const context=assembly.contexts.find(row=>row.name==='teloa:work-behavior-runtime')
 assert.ok(context,'本轮缺少九模块的原生适用范围上下文')
 const facts=JSON.parse(context.text.split('\n').at(-1)!)
 assert.deepEqual(Object.keys(facts).sort(),['behavior_version','capability_basis','grants_permissions','modules'],
  '适用范围只声明规则选择依据，不能重复或维护另一份原生工具目录')
 assert.equal(facts.capability_basis,'visible-tool-catalog')
 assert.equal(facts.grants_permissions,false)
 return facts
}

async function scopedRuntime(t:TestContext){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new CaptureAdapter();ctx.llm.registerAdapter(['capture'],adapter)
 const {agent}=await ctx.agents.create({sessionId:SessionId('capability-'+t.name),agentOptions:{provider:'capture',model:'model'}})
 const plugin=await import('../src/work-behavior.ts')
 return {ctx,agent,plugin}
}

function registerFixtureTool(ctx:Context,name:string){
 return ctx.tools.register(defineTool({name,description:'本测试作用域可见的工具',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=> 'fixture'}))
}

test('实际工具变化后重新选择模块，撤销能力不留旧规则或工具事实',async t=>{
 const {ctx,agent,plugin}=await scopedRuntime(t)
 await agent.ctx.plugin(plugin)
 const assemble=()=>ctx.systemPrompt.assemble({agent,scope:agent})
 assert.deepEqual(runtimeFacts(await assemble()).modules,['01-core','03-planning','08-artifacts'])
 const disposers=['read_fixture','memory','skill_view','subagent_task','job_await'].map(name=>registerFixtureTool(ctx,name))
 const full=await assemble()
 assert.deepEqual(runtimeFacts(full).modules,['01-core','02-tools','03-planning','04-memory','05-skills','06-collaboration','07-background','08-artifacts'])
 assert.deepEqual(full.tools.map(tool=>tool.name),['job_await','memory','read_fixture','skill_view','subagent_task'])
 for(const dispose of disposers)dispose()
 const empty=await assemble()
 assert.deepEqual(runtimeFacts(empty).modules,['01-core','03-planning','08-artifacts'])
 assert.deepEqual(empty.tools,[])
})

test('按权限过滤后的最终目录选择模块，保留原生身份、上下文与工具参数',async t=>{
 const {ctx,agent,plugin}=await scopedRuntime(t)
 for(const name of ['read_fixture','memory','skill_view','subagent_task','job_await'])registerFixtureTool(ctx,name)
 ctx.systemPrompt.context({name:'fixture:mode',order:115,text:'模式=只读；岗位=研究助理；允许范围=本次测试资料。'})
 ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{
  const result=await next()
  return {...result,tools:result.tools.filter(tool=>tool.name==='read_fixture')}
 })
 const before=await ctx.systemPrompt.assemble({agent,scope:agent})
 await agent.ctx.plugin(plugin)
 const after=await ctx.systemPrompt.assemble({agent,scope:agent})
 assert.deepEqual(after.tools,before.tools)
 assert.deepEqual(after.sections.filter(row=>row.name!=='teloa:work-behavior'),before.sections)
 assert.deepEqual(after.contexts.filter(row=>row.name!=='teloa:work-behavior-runtime'),before.contexts)
 assert.deepEqual(runtimeFacts(after).modules,['01-core','02-tools','03-planning','08-artifacts'])
 assert.deepEqual(after.tools.map(tool=>tool.name),['read_fixture'])
})

test('目录只剩自授权工具时不注入泛化工具说明，岗位记忆候选仍取得记忆规则',async t=>{
 const {ctx,agent,plugin}=await scopedRuntime(t)
 const {selfAuthorizedToolNames}=await import('../src/self-authorized-tools.ts')
 for(const name of selfAuthorizedToolNames)registerFixtureTool(ctx,name)
 await agent.ctx.plugin(plugin)
 const assemble=()=>ctx.systemPrompt.assemble({agent,scope:agent})
 assert.deepEqual(runtimeFacts(await assemble()).modules,['01-core','03-planning','04-memory','08-artifacts'])
 const extra=registerFixtureTool(ctx,'read_fixture')
 assert.deepEqual(runtimeFacts(await assemble()).modules,['01-core','02-tools','03-planning','04-memory','08-artifacts'])
 extra()
})

test('同一宿主的不同 Agent 只取得本人范围的模块和动态事实',async t=>{
 const {ctx,agent,plugin}=await scopedRuntime(t)
 const {agent:other}=await ctx.agents.create({sessionId:SessionId('capability-other'),agentOptions:{provider:'capture',model:'other-model'}})
 registerFixtureTool(agent.ctx,'memory')
 await agent.ctx.plugin(plugin)
 await other.ctx.plugin(plugin)
 const own=await ctx.systemPrompt.assemble({agent,scope:agent})
 const separate=await ctx.systemPrompt.assemble({agent:other,scope:other})
 assert.deepEqual(runtimeFacts(own).modules,['01-core','02-tools','03-planning','04-memory','08-artifacts'])
 assert.deepEqual(runtimeFacts(separate).modules,['01-core','03-planning','08-artifacts'])
 assert.deepEqual(separate.tools,[])
})

test('现有 Teloa 技能草案、安装、员工协作和原生后台入口取得对应规则',async t=>{
 const {ctx,agent,plugin}=await scopedRuntime(t)
 for(const name of ['skill','teloa_create_draft','teloa_skills_preview','teloa_work_dispatch','job_output'])registerFixtureTool(ctx,name)
 await agent.ctx.plugin(plugin)
 const assembly=await ctx.systemPrompt.assemble({agent,scope:agent})
 assert.deepEqual(runtimeFacts(assembly).modules,['01-core','02-tools','03-planning','04-memory','05-skills','06-collaboration','07-background','08-artifacts'])
 assert.deepEqual(assembly.tools.map(tool=>tool.name),['job_output','skill','teloa_create_draft','teloa_skills_preview','teloa_work_dispatch'])
})

test('对外发送与同名代理消息工具根据实际参数区分，不凭名称宣称协作能力',async t=>{
 const {ctx,agent,plugin}=await scopedRuntime(t)
 const register=(parameters:Record<string,{type:'string';required:true}>)=>ctx.tools.register(defineTool({name:'send_message',description:'消息工具',parameters,output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=> 'fixture'}))
 const external=register({to:{type:'string',required:true},body:{type:'string',required:true}})
 await agent.ctx.plugin(plugin)
 const assemble=()=>ctx.systemPrompt.assemble({agent,scope:agent})
 assert.deepEqual(runtimeFacts(await assemble()).modules,['01-core','02-tools','03-planning','08-artifacts'])
 external()
 register({target:{type:'string',required:true},message:{type:'string',required:true}})
 assert.deepEqual(runtimeFacts(await assemble()).modules,['01-core','02-tools','03-planning','06-collaboration','08-artifacts'])
})

test('停用完整行为后恢复原有系统提示、工具和上下文',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime)
 ctx.systemPrompt.section({name:'fixture:existing',order:0,text:'原有工作身份'})
 ctx.systemPrompt.context({name:'fixture:current',order:100,text:'当前范围'})
 const before=await ctx.systemPrompt.assemble()
 const plugin=await import('../src/work-behavior.ts').catch(error=>assert.fail('缺少可停用的行为插件：'+error.code))
 await ctx.plugin(plugin,{enabled:false})
 const after=await ctx.systemPrompt.assemble()
 assert.deepEqual(after,before)
})


test('标准模式向真实模型请求注入 DSH 官方时钟与请求时区，而不改写用户输入',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
 await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new CaptureAdapter();ctx.llm.registerAdapter(['capture'],adapter)
 const {parse}=createRequire(import.meta.url)('yaml')
 const preset=parse(await readFile(new URL('../../bundle/agent-presets/teloa-standard/agent.cordis.yml',import.meta.url),'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>value}]})[0].insert[0]
 const row=preset.config.plugins.find((entry:{id:string})=>entry.id==='time-context')
 assert.ok(row,'标准模式遗漏了 DSH 官方时间上下文，无法可靠解释明天、每周一等自然语言时间')
 const require=createRequire(import.meta.url),officialRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
 const {pathToFileURL}=await import('node:url')
 await ctx.plugin(await import(pathToFileURL(officialRequire.resolve(row.name)).href),row.config??{})
 const {agent}=await ctx.agents.create({sessionId:SessionId('standard-request-clock'),agentOptions:{provider:'capture',model:'model'}})
 const input='明天上午十点整理工作，不创建计划。'
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'standard-request-clock-input',clientTimeZone:'Asia/Singapore'},content:[{type:'text',text:input}]}));await agent.whenIdle()
 assert.equal(adapter.requests.length,1)
 const texts=adapter.requests[0]!.messages.flatMap(message=>message.content.filter(block=>block.type==='text').map(block=>block.text))
 assert.ok(texts.includes(input),'用户原请求必须保持原文')
 assert.match(texts.join('\n'),/Browser time zone for this request: Asia\/Singapore/)
 assert.match(texts.join('\n'),/\+08:00\[Asia\/Singapore\]/)
 const readings=agent.session.snapshotEvents().filter(event=>{
  if(event.type!=='user/message')return false
  // 官方时钟模块动态加载；读取真实 source，保留严格的来源字符串判定。
  const source:{kind:string}=event.data.source
  return source.kind==='time-context'
 })
 assert.equal(readings.length,1,'一次请求只登记一份原生时间上下文')
})
