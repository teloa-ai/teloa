import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {createMcpToolDefinition} from '@deepseek-ai/dsh-mcp-client'
import {installSessionToolLoading,isCoreTool,toolLoaderName} from '../src/tool-loading.ts'
import {conversationWorkToolNames} from '../src/conversation-work-tool-names.ts'
import {createVoiceToolLoading} from '../src/voice-tool-loading.ts'
import {groupRoutingSessionId} from '@teloa/contract'
import {groupRoutingDenyReason,registerGroupRoutingGuard} from '../src/group-routing-guard.ts'
import {isRoutingSession} from '../src/group-routing.ts'
import * as workBehavior from '../src/work-behavior.ts'
import {registerPageCreateTools} from '../src/page-create-tools.ts'
import {registerCapabilityDraftTools} from '../src/capability-draft-tools.ts'
import {registerMethodReuseTools} from '../src/method-reuse-tools.ts'
import {registerPlanTools} from '../src/plan-tools.ts'
import {registerLibraryTools} from '../src/library-tools.ts'

class Adapter extends LlmAdapter{
 readonly requests:GenerateOptions[]=[]
 readonly scripts:Array<readonly StreamChunk[]>=[]
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions):AsyncGenerator<StreamChunk>{this.requests.push(options);yield* this.scripts.shift()??text}
}
const text:readonly StreamChunk[]=[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:'好的'},{type:'block-end',index:0,block:{type:'text',text:'好的'}},{type:'finish',reason:{kind:'stop'}}]
let calls=0
const call=(name:string,args:unknown):readonly StreamChunk[]=>{const id=ToolCallId('call-'+ ++calls),json=JSON.stringify(args);return [{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id,name,argumentsDelta:json},{type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:json}},{type:'finish',reason:{kind:'tool-calls'}}]}

// 常驻仅保留对话/交办必需工具；原生大工具和 MCP 与平台管理类一起按需展开。
const core=['read','skill','teloa_work_status','teloa_work_stop','teloa_capabilities','teloa_knowledge_search']
const deferred={workflow:'组织多步并行工作 workflow',bash:'运行本机命令 shell command',web_search:'网页搜索 web search',mcp__crm__lookup:'查询客户 CRM lookup',teloa_work_facts:'查询工作统计',teloa_employees_create:'创建员工草案并保存岗位职责',teloa_market_search:'搜索市场中的技能、员工与方案',teloa_projects_list:'列出本人项目及其状态',teloa_create_draft:'保存新建对象草案',teloa_create_drafts:'检索以前保存的新建草案',teloa_library_save:'保存资料库文件版本'}
const runOnly=['teloa_group_attach']
const padding='本工具的完整参数与使用约束说明。'.repeat(30)

async function setup(t:TestContext,options:{loading?:boolean;sessionId?:string;routing?:boolean;productionCatalog?:boolean;englishDescriptions?:boolean}={}){
 const ctx=new Context(),adapter=new Adapter(),executed:string[]=[];t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 ctx.llm.registerAdapter(['capture'],adapter)
 const register=(name:string,description:string)=>ctx.tools.register(defineTool({name,description:options.englishDescriptions?'Original fixture description for '+name:description+padding,parameters:{target:{type:'string',description:'操作对象'}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{executed.push(name);return 'ok:'+name}}))
 for(const name of core)register(name,'常驻工具'+name)
 for(const [name,description] of Object.entries(deferred))if(!options.productionCatalog||!/^teloa_(?:create_|library_)/.test(name))register(name,description)
 if(options.productionCatalog)for(const registerTools of [registerPageCreateTools,registerCapabilityDraftTools,registerMethodReuseTools,registerPlanTools,registerLibraryTools])registerTools(ctx,{} as never)
 for(const name of runOnly)register(name,'群运行贴回文件')
 ctx.systemPrompt.section({name:'tool:teloa_projects_list',order:3000,text:'项目工具规则：只读项目目录。'})
 if(options.routing)registerGroupRoutingGuard(ctx,isRoutingSession)
 const install=()=>installSessionToolLoading(ctx,{isRoutingSession})
 let off=options.loading===false?()=>{}:install()
 const {agent}=await ctx.agents.create({sessionId:SessionId(options.sessionId??'session-tools'),agentOptions:{provider:'capture',model:'model'}})
 await agent.ctx.plugin(workBehavior,{})
 // 与 group-routing.ts hideRoutingTools 相同：按 Agent 登记、外层清空工具广告面。
 if(options.routing)agent.ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>({...await next(),tools:[]}),{prepend:true})
 let turn=0
 const send=async(target:Agent=agent)=>{target.followup(createUserMessage({source:{kind:'user',rpcId:'input-'+ ++turn},content:[{type:'text',text:'第'+turn+'个问题'}]}));await target.whenIdle()}
 return {ctx,adapter,agent,executed,send,install(){off=install()},reinstall(){off();off=install()}}
}
const names=(request:GenerateOptions|undefined)=>(request?.tools??[]).map(tool=>tool.name).sort()
const system=(request:GenerateOptions)=>JSON.stringify(request.messages.filter(message=>message.role==='system'))
const results=(agent:Agent)=>JSON.stringify(agent.session.snapshotEvents().filter(event=>event.type==='tool/result'))

test('加载器静态模型说明统一英文，中文类别别名仍能发现全英文工具且不进入提示词',async t=>{
 for(const [query,expected] of [['文件与命令','bash'],['员工与团队','teloa_employees_create'],['资料库','teloa_library_save']]){
  const f=await setup(t,{englishDescriptions:true}),original=f.ctx.tools.schemas(f.agent).find(tool=>tool.name===expected)!
  f.adapter.scripts.push(call(toolLoaderName,{query}),text);await f.send()
  const first=f.adapter.requests[0]!,loader=first.tools!.find(tool=>tool.name===toolLoaderName)!,directory=JSON.stringify(first.messages.filter(message=>message.source?.kind==='runtime-context'))
  assert.doesNotMatch(loader.description,/\p{Script=Han}/u,'加载器说明/类别不能序列化中文搜索别名');assert.doesNotMatch(JSON.stringify(loader.parameters),/\p{Script=Han}/u)
  assert.doesNotMatch(directory,/\p{Script=Han}/u,'普通发现上下文只保留英文静态规则')
  const loaded=f.adapter.requests[1]!.tools!.find(tool=>tool.name===expected)
  assert.ok(loaded,query+'应通过内部中文别名找到'+expected);assert.equal(loaded.description,original.description);assert.deepEqual(loaded.parameters,original.parameters,'延后加载不能压缩真实schema或翻译原字段说明')
  assert.doesNotMatch(results(f.agent),/\p{Script=Han}/u,'成功回执静态提示为英文');assert.deepEqual(f.executed,[])
  const voice=createVoiceToolLoading(f.ctx);t.after(voice.dispose);const slim=voice.refine(f.agent,await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent}),{voice:true,turn:1})
  assert.doesNotMatch(slim.contexts.find(row=>row.name==='teloa:voice-tool-directory')!.text,/\p{Script=Han}/u)
  await assert.rejects(f.ctx.tools.get(toolLoaderName,f.agent)!.execute({names:['unknown-tool']},{agent:f.agent,signal:new AbortController().signal} as never),error=>{assert.doesNotMatch(String(error),/\p{Script=Han}/u);return (error as {code?:string}).code==='teloa/forbidden'})
 }
})

test('普通会话首个请求只广告常驻核心与加载器，加载器描述列出可加载类别，提示词随核心集合变小',async t=>{
 const before=await setup(t,{loading:false});await before.send()
 const after=await setup(t);await after.send()
 const full=before.adapter.requests[0]!,slim=after.adapter.requests[0]!
 assert.deepEqual(names(slim),[...core,toolLoaderName].sort())
 assert.ok(slim.tools!.length<=core.length+1)
 for(const name of [...Object.keys(deferred),...runOnly])assert.ok(!names(slim).includes(name),name+' 不应在首步广告')
 const loader=slim.tools!.find(tool=>tool.name===toolLoaderName)!
 const visible=JSON.stringify(slim.messages)
 assert.match(visible,/common entry points, not all capabilities/)
 assert.match(visible,/teloa_tools_load/)
 assert.match(visible,/Do not infer lack of support.*unloaded tool/)
 for(const label of ['Creation and drafts','Market and industry','Employees and teams','Projects','Library'])assert.match(loader.description,new RegExp(label))
 assert.doesNotMatch(loader.description,/Groups \(|Plans \(/,'没有可加载工具的类别不列出')
 assert.doesNotMatch(system(slim),/项目工具规则/,'延后工具的 tool: 说明随参数一起延后')
 assert.match(system(full),/# Project configuration/);assert.doesNotMatch(system(slim),/# Project configuration/)
 assert.match(system(full),/# Memory and experience/);assert.doesNotMatch(system(slim),/# Memory and experience/)
 const bytes=(request:GenerateOptions)=>JSON.stringify(request.tools).length
 t.diagnostic(`改前 ${full.tools!.length} 个工具 ${bytes(full)} 字节，系统提示 ${system(full).length} 字符；改后 ${slim.tools!.length} 个 ${bytes(slim)} 字节，系统提示 ${system(slim).length} 字符`)
 assert.ok(bytes(slim)<bytes(full)*0.7)
 assert.ok(system(slim).length<system(full).length)
})

test('真实长说明的员工草案与知识保存工具可按自然动作搜索到，不被只读辅助工具挤出',async t=>{
 for(const [query,expected] of [['新建员工 草案','teloa_create_draft'],['保存员工草案','teloa_create_draft'],['create employee draft','teloa_create_draft'],['保存知识 Markdown','teloa_library_save'],['save knowledge markdown','teloa_library_save']]){
  const f=await setup(t,{productionCatalog:true})
  f.adapter.scripts.push(call(toolLoaderName,{query}),text)
  await f.send()
  assert.ok(names(f.adapter.requests[1]).includes(expected!),query+' 应找到 '+expected+'，实际为 '+names(f.adapter.requests[1]).join(','))
  assert.deepEqual(f.executed,[],'发现工具不能执行业务操作')
 }
})

test('展开知识保存时同时提供其必需的目录读取，撤销目录许可后不恢复该能力',async t=>{
 const f=await setup(t,{productionCatalog:true})
 f.adapter.scripts.push(call(toolLoaderName,{names:['teloa_library_save']}),text)
 await f.send()
 assert.ok(names(f.adapter.requests[1]).includes('teloa_library_save'))
 assert.ok(names(f.adapter.requests[1]).includes('teloa_library_directory'),'保存所需的 parentId 与目录 revision 应通过真实目录读取，不能要求本人提供内部参数')
 assert.deepEqual(f.executed,[],'只展开参数，不读取目录或保存知识')
 f.agent.ctx.tools.restrict({allow:[...core,toolLoaderName,'teloa_library_save']})
 await f.send()
 assert.ok(!names(f.adapter.requests.at(-1)).includes('teloa_library_directory'),'配套参数不得恢复已撤销的许可')
})

test('工具发现回执不重复整份长说明，正式参数仍完整提供并能冷恢复',async t=>{
 const f=await setup(t,{productionCatalog:true})
 f.adapter.scripts.push(call(toolLoaderName,{query:'保存知识 Markdown'}),text)
 await f.send()
 const event=f.agent.session.snapshotEvents().find(event=>event.type==='tool/result')!
 assert.equal(event.type,'tool/result')
 const response=event.data.message.content.filter(row=>row.type==='text').map(row=>row.text).join('\n')
 assert.ok(Buffer.byteLength(response,'utf8')<1024,'发现回执只需短名称凭据；完整说明已在下一步正式工具参数中，不应重复占据历史')
 const save=f.adapter.requests[1]!.tools!.find(tool=>tool.name==='teloa_library_save')!
 assert.match(save.description,/teloa_library_directory/)
 const parameters=save.parameters as {properties:Record<string,unknown>;required:string[]}
 assert.ok(parameters.properties.parentId&&parameters.properties.expectedDirectoryRevision&&parameters.required.includes('parentId')&&parameters.required.includes('expectedDirectoryRevision'),'节省回执不能省略正式必填参数')
 f.reinstall();await f.send()
 assert.ok(names(f.adapter.requests.at(-1)).includes('teloa_library_save'))
 assert.ok(names(f.adapter.requests.at(-1)).includes('teloa_library_directory'))
})

test('调用加载器后下一请求出现被加载工具，同一会话后续轮次仍在，对应提示词模块恢复',async t=>{
 const f=await setup(t)
 f.adapter.scripts.push(call(toolLoaderName,{names:['teloa_projects_list']}),text)
 await f.send()
 assert.ok(!names(f.adapter.requests[0]).includes('teloa_projects_list'))
 assert.ok(names(f.adapter.requests[1]).includes('teloa_projects_list'))
 assert.match(system(f.adapter.requests[1]!),/项目工具规则/)
 assert.match(system(f.adapter.requests[1]!),/# Project configuration/)
 await f.send()
 assert.ok(names(f.adapter.requests[2]).includes('teloa_projects_list'),'加载状态在同一会话内只增不减')
 f.adapter.scripts.push(call(toolLoaderName,{query:'创建员工'}),text)
 await f.send()
 assert.ok(names(f.adapter.requests[4]).includes('teloa_employees_create'),'按动作词搜索加载')
 assert.ok(names(f.adapter.requests[4]).includes('teloa_projects_list'))
 assert.deepEqual(f.executed,[],'加载器本身不执行任何业务工具')
 // 冷恢复：宿主重装后从本会话历史重建已加载名单，不因重启收回已展开的工具。
 f.reinstall();await f.send()
 for(const name of ['teloa_projects_list','teloa_employees_create'])assert.ok(names(f.adapter.requests[5]).includes(name),name+' 应从历史恢复')
})

test('直接调用许可内未加载工具照常执行并补加载；运行专用工具在普通会话不可见也不执行',async t=>{
 const f=await setup(t)
 f.adapter.scripts.push(call('teloa_employees_create',{target:'销售助理'}),text)
 await f.send()
 assert.doesNotMatch(results(f.agent),/nothing executed/)
 assert.deepEqual(f.executed,['teloa_employees_create'],'许可内工具按名称直接调用即由原工具执行，参数与权限仍走原工具自身校验')
 assert.ok(names(f.adapter.requests[1]).includes('teloa_employees_create'),'执行后下一步可见正式参数')
 f.adapter.scripts.push(call('teloa_group_attach',{target:'a.txt'}),text)
 await f.send()
 assert.match(results(f.agent),/teloa_group_attach is for managed task runs only, unavailable in this conversation; nothing executed/)
 assert.ok(!names(f.adapter.requests[3]).includes('teloa_group_attach'))
 assert.deepEqual(f.executed,['teloa_employees_create'])
 await assert.rejects(f.ctx.tools.get(toolLoaderName,f.agent)!.execute({names:['teloa_group_attach']},{agent:f.agent,signal:new AbortController().signal} as never),{code:'teloa/forbidden'},'加载器不能展开当前会话不适用的工具')
})

test('任务运行等已收窄的会话不叠加按需加载',async t=>{
 const f=await setup(t)
 f.agent.ctx.tools.restrict({allow:['read','teloa_projects_list','teloa_group_attach']})
 await f.send()
 assert.deepEqual(names(f.adapter.requests[0]),['read','teloa_group_attach','teloa_projects_list'])
 assert.match(system(f.adapter.requests[0]!),/项目工具规则/)
})

test('语音轮次以普通会话的许可目录为底，按轮次加载；语音外保持普通会话面并保留语音加载结果',async t=>{
 const f=await setup(t),voice=createVoiceToolLoading(f.ctx);t.after(voice.dispose)
 const assembled=await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent})
 assert.deepEqual(assembled.tools.map(tool=>tool.name).sort(),[...core,toolLoaderName].sort())
 assert.equal(voice.refine(f.agent,assembled,{voice:false,turn:1}).tools,assembled.tools,'非语音轮次保持普通会话工具面')
 const slim=voice.refine(f.agent,assembled,{voice:true,turn:1})
 assert.deepEqual(slim.tools.map(tool=>tool.name).sort(),[toolLoaderName,'teloa_work_stop'].sort())
 assert.ok(slim.contexts.some(context=>context.name==='teloa:voice-tool-directory'))
 assert.ok(!slim.contexts.some(context=>context.name==='teloa:session-tool-directory'),'语音使用本轮规则，不重复普通会话发现说明')
 await f.ctx.tools.get(toolLoaderName,f.agent)!.execute({query:'列出项目'},{agent:f.agent,signal:new AbortController().signal} as never)
 const loaded=voice.refine(f.agent,await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent}),{voice:true,turn:1})
 assert.ok(loaded.tools.some(tool=>tool.name==='teloa_projects_list'),'语音可加载普通会话首步延后的工具')
 assert.ok(loaded.sections.some(section=>section.name==='tool:teloa_projects_list'),'对应 tool: 说明随加载补回')
 assert.deepEqual(voice.refine(f.agent,await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent}),{voice:true,turn:2}).tools.map(tool=>tool.name).sort(),[toolLoaderName,'teloa_work_stop'].sort(),'语音加载按轮次重置')
 assert.ok((await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent})).tools.some(tool=>tool.name==='teloa_projects_list'),'普通会话保留语音中已加载的工具')
})

test('Agent 先创建、再安装普通会话加载：语音仍以原许可目录加载，非语音轮次仍按普通会话收窄',async t=>{
 const f=await setup(t,{loading:false}),voice=createVoiceToolLoading(f.ctx);t.after(voice.dispose)
 let input:{voice:boolean;turn?:number}={voice:true,turn:1}
 // 与 voice-model-routing 相同：按 Agent 登记的语音处理先于宿主钩子存在，宿主钩子后登记成为外层。
 f.agent.ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>voice.refine(f.agent,await next(),input),{prepend:true})
 f.install()
 const assemble=async()=>(await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent})).tools.map(tool=>tool.name).sort()
 assert.deepEqual(await assemble(),[toolLoaderName,'teloa_work_stop'].sort())
 await f.ctx.tools.get(toolLoaderName,f.agent)!.execute({names:['teloa_projects_list']},{agent:f.agent,signal:new AbortController().signal} as never)
 assert.ok((await assemble()).includes('teloa_projects_list'),'语音轮次可加载普通会话首步延后的工具')
 input={voice:false}
 assert.deepEqual(await assemble(),[...core,toolLoaderName].sort(),'非语音轮次仍按普通会话收窄')
})

test('群路由会话不进入按需加载：误调工具由路由守卫拒绝',async t=>{
 const f=await setup(t,{routing:true,sessionId:groupRoutingSessionId('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','2026-10-19')})
 f.adapter.scripts.push(call('teloa_employees_create',{target:'销售助理'}),text)
 await f.send()
 assert.deepEqual(names(f.adapter.requests[0]),[])
 assert.match(results(f.agent),new RegExp(groupRoutingDenyReason))
 assert.doesNotMatch(results(f.agent),/尚未通过/)
 assert.deepEqual(f.executed,[])
 await assert.rejects(f.ctx.tools.get(toolLoaderName,f.agent)!.execute({names:['teloa_projects_list']},{agent:f.agent,signal:new AbortController().signal} as never),/not in a tool-loading phase/,'路由会话不建立加载状态')
})

test('常驻核心名单',()=>{
 assert.ok(['teloa_work_directory','teloa_work_dispatch','teloa_work_status','teloa_work_stop','teloa_work_resume'].every(isCoreTool))
 assert.ok(conversationWorkToolNames.filter(name=>!isCoreTool(name)).length>0)
 for(const name of ['teloa_capabilities','teloa_knowledge_search','teloa_skill_http','read','ask_user_question','exit_plan_mode','skill'])assert.ok(isCoreTool(name),name)
 for(const name of ['mcp__any__tool','bash','workflow','team_task_update','web_search','teloa_work_collect_reports','teloa_work_facts','teloa_business_data_query','teloa_employees_create','teloa_market_add','teloa_create_draft','teloa_mcp_save','teloa_plans_create','teloa_groups_create','teloa_projects_create','teloa_library_save','teloa_work_supersede'])assert.ok(!isCoreTool(name),name)
})

test('把技能名误当工具名时仍拒绝执行，并向模型给出当前许可内可继续搜索的入口',async t=>{
 const f=await setup(t)
 f.adapter.scripts.push(call(toolLoaderName,{query:'员工 技能',names:['teloa-skill-creator','skill']}),text)
 await f.send()
 assert.match(results(f.agent),/teloa_employees_create/,'失败回执应给出真实的许可内候选，不能只让模型猜名称')
 assert.match(results(f.agent),/query/)
 assert.match(results(f.agent),/Skill names are not tool names/)
 assert.doesNotMatch(results(f.agent),/teloa_group_attach/,'运行专用工具不能出现在纠正候选中')
 assert.deepEqual(names(f.adapter.requests[1]),[...core,toolLoaderName].sort(),'失败既不部分加载，也不执行业务工具')
 assert.deepEqual(f.executed,[])
 f.agent.ctx.tools.restrict({allow:[...core,toolLoaderName]});await f.send()
 await assert.rejects(f.ctx.tools.get(toolLoaderName,f.agent)!.execute({query:'创建员工',names:['teloa-skill-creator']},{agent:f.agent,signal:new AbortController().signal} as never),error=>{
  assert.doesNotMatch(String(error),/teloa_employees_create|teloa_group_attach/,'撤权后不再给出旧目录候选');return true
 })
})


test('原生大工具和MCP按需加载、撤权后不可见，重装保留真实调用的工具与原约束',async t=>{
 const f=await setup(t)
 f.ctx.systemPrompt.section({name:'tool:workflow:rules',order:3001,text:'工作流的原约束：只在已有授权内执行。'})
 f.ctx.systemPrompt.context({name:'fixture:permission',order:110,text:'本会话只允许fixture工作，不授予其他权限。'})
 f.adapter.scripts.push(call(toolLoaderName,{query:'多步并行工作 workflow'}),call('workflow',{target:'fixture'}),text)
 await f.send()
 assert.ok(!names(f.adapter.requests[0]).includes('workflow'))
 assert.doesNotMatch(system(f.adapter.requests[0]!),/工作流的原约束/)
 assert.ok(names(f.adapter.requests[1]).includes('workflow'))
 assert.match(system(f.adapter.requests[1]!),/工作流的原约束/)
 assert.match(JSON.stringify(f.adapter.requests[1]!.messages),/本会话只允许fixture工作/)
 assert.deepEqual(f.executed,['workflow'])
 f.reinstall();await f.send()
 assert.ok(names(f.adapter.requests.at(-1)).includes('workflow'),'冷恢复不能忘记原生已使用工具')
 f.agent.ctx.tools.restrict({allow:['read',toolLoaderName]});await f.send()
 assert.ok(!names(f.adapter.requests.at(-1)).includes('workflow'),'历史加载不恢复被撤销的工具许可')
 await assert.rejects(f.ctx.tools.get(toolLoaderName,f.agent)!.execute({names:['mcp__crm__lookup']},{agent:f.agent,signal:new AbortController().signal} as never),{code:'teloa/forbidden'})
 assert.deepEqual(f.executed,['workflow'])
})

// 固定 Cua Driver 0.28.0 原目录；仅注册 schemas，任何真实浏览器/桌面调用都会使夹具失败。
const computerBrowserSchemas=[
 {"name":"cua_driver_native__browser_click","description":"Click a page element (by ref) or viewport coordinates in an exactly-bound tab. Default route is trusted hardware-like input (Input.dispatchMouseEvent), and refuses where that route cannot preserve standalone-browser background posture. input_route=\"dom_event\" (synthetic el.click(), ref required) is used only when explicitly requested; it proves dispatch, not control activation, because trust-gated controls may ignore synthetic events. Refused for heuristic bindings.","parameters":{"additionalProperties":true,"properties":{"input_route":{"description":"\"trusted\" (default): Input.dispatchMouseEvent. It refuses rather than foregrounding a standalone browser. \"dom_event\": synthetic full-background DOM click, only when explicitly requested. Dispatch does not prove the control activated; refresh page state and verify the expected postcondition.","enum":["trusted","dom_event"],"type":"string"},"ref":{"description":"Page element ref in the p<snapshot>:<index> namespace from get_browser_state. Refs are invalidated by navigation and by newer snapshots of the same tab.","type":"string"},"session":{"description":"For multi-call work, prefer a short public session label and repeat it on every call that accepts it. Omit it to use the authenticated transport's implicit lifecycle session. Browser targets, tabs, and refs belong to the resolved lifecycle session.","type":"string"},"tab_id":{"description":"Opaque tab id from get_browser_state (session-scoped).","type":"string"},"target_id":{"description":"Opaque browser target id minted by get_browser_state (session-scoped; never a CDP id).","type":"string"},"x":{"description":"Viewport x (CSS px) — alternative to ref.","type":"number"},"y":{"description":"Viewport y (CSS px) — alternative to ref.","type":"number"}},"required":["target_id","tab_id"],"type":"object"}},
 {"name":"cua_driver_native__browser_dialog","description":"Inspect or resolve a page-owned JavaScript alert, confirm, prompt, or beforeunload dialog on one exactly-bound tab. This never handles browser permission UI, extension UI, native dialogs, or file pickers. Inspect returns an opaque dialog_id; accept/dismiss require that exact current id. Resolution defaults to background delivery; Linux callers must explicitly request foreground delivery because Chromium's native modal cannot be resolved there without changing foreground posture.","parameters":{"additionalProperties":true,"properties":{"action":{"enum":["inspect","accept","dismiss"],"type":"string"},"delivery_mode":{"default":"background","description":"Requested foreground posture for accept/dismiss. Linux Chromium requires foreground; inspect is read-only.","enum":["background","foreground"],"type":"string"},"dialog_id":{"description":"Opaque current dialog generation returned by action=inspect.","type":"string"},"prompt_text":{"description":"Sensitive response text, valid only when accepting a prompt dialog.","type":"string"},"session":{"description":"For multi-call work, prefer a short public session label and repeat it on every call that accepts it. Omit it to use the authenticated transport's implicit lifecycle session. Browser targets, tabs, and refs belong to the resolved lifecycle session.","type":"string"},"tab_id":{"description":"Opaque tab id from get_browser_state (session-scoped).","type":"string"},"target_id":{"description":"Opaque browser target id minted by get_browser_state (session-scoped; never a CDP id).","type":"string"}},"required":["target_id","tab_id","action"],"type":"object"}},
 {"name":"cua_driver_native__browser_download","description":"Trigger one download through an exact live browser ref and save it inside an explicitly approved directory. Requires MCP-host destructive-tool approval, refuses ambiguous or stale capabilities, and never returns the source URL, filename, or destination path.","parameters":{"additionalProperties":true,"properties":{"destination_root":{"description":"Absolute, existing, canonical directory approved to receive the download.","type":"string"},"ref":{"description":"Live page ref whose activation initiates the download.","type":"string"},"session":{"description":"For multi-call work, prefer a short public session label and repeat it on every call that accepts it. This tool requires the label that owns its browser target, tab, and refs.","type":"string"},"tab_id":{"description":"Opaque exact tab id from get_browser_state.","type":"string"},"target_id":{"description":"Opaque exact browser target id from get_browser_state.","type":"string"}},"required":["session","target_id","tab_id","ref","destination_root"],"type":"object"}},
 {"name":"cua_driver_native__browser_navigate","description":"Navigate one tab of an exactly-bound browser target to a new URL (http/https/about only). Refused for heuristic bindings. Navigation invalidates all p<snapshot>:<index> refs for the tab.","parameters":{"additionalProperties":true,"properties":{"session":{"description":"For multi-call work, prefer a short public session label and repeat it on every call that accepts it. Omit it to use the authenticated transport's implicit lifecycle session. Browser targets, tabs, and refs belong to the resolved lifecycle session.","type":"string"},"tab_id":{"description":"Opaque tab id from get_browser_state (session-scoped).","type":"string"},"target_id":{"description":"Opaque browser target id minted by get_browser_state (session-scoped; never a CDP id).","type":"string"},"url":{"description":"Destination URL (http:, https:, or about:).","type":"string"}},"required":["target_id","tab_id","url"],"type":"object"}},
 {"name":"cua_driver_native__browser_pointer","description":"Perform hover, right-click, double-click, scroll, or drag in an exactly-bound browser tab. Semantic refs must declare pointer for hover, right-click, double-click, and drag; scroll accepts a scroll or pointer capability. The trusted route uses CDP Input events and refuses if standalone background posture cannot be preserved. The explicit dom_event route requires a page ref and synthesizes full-background DOM events. Never activates or brings a tab to the foreground.","parameters":{"additionalProperties":true,"properties":{"action":{"enum":["hover","right_click","double_click","scroll","drag"],"type":"string"},"delta_x":{"description":"Horizontal scroll delta in CSS pixels.","type":"number"},"delta_y":{"description":"Vertical scroll delta in CSS pixels.","type":"number"},"destination_ref":{"description":"Drag destination page ref in the exact same frame.","type":"string"},"input_route":{"default":"trusted","enum":["trusted","dom_event"],"type":"string"},"ref":{"description":"Origin page ref. Alternative to x/y.","type":"string"},"session":{"description":"For multi-call work, prefer a short public session label and repeat it on every call that accepts it. This tool requires the label that owns its browser target, tab, and refs.","type":"string"},"tab_id":{"description":"Opaque tab id minted by get_browser_state.","type":"string"},"target_id":{"description":"Opaque target id minted by get_browser_state.","type":"string"},"to_x":{"description":"Drag destination viewport x in CSS pixels.","type":"number"},"to_y":{"description":"Drag destination viewport y in CSS pixels.","type":"number"},"x":{"description":"Origin viewport x in CSS pixels.","type":"number"},"y":{"description":"Origin viewport y in CSS pixels.","type":"number"}},"required":["target_id","tab_id","session","action"],"type":"object"}},
 {"name":"cua_driver_native__browser_prepare","description":"Explicitly prepare an owned DevTools endpoint for a browser. pid is required for an existing process or existing-profile attachment, and optional only for allow_launch=true with an isolated profile. Existing endpoints are detected without side effects. Acting setup for an isolated profile follows the runtime permission mode and optional capability manifest. It requires allow_launch=true, launches a separate browser, and never copies, modifies, or terminates the requested user profile. Without pid, only a platform-attested system Chrome/Edge installation (or a root-owned package payload on Linux) is eligible; redirects and user-controlled locations fail closed. Existing-profile attachment is explicit and follows the runtime's immutable permission mode: standard requires an explicit --grant existing-profile launch grant or an embedding authorization host, bounded requires a launch-approved exact resource manifest, and unrestricted requires explicit trusted startup risk acceptance. Ordinary MCP transport approval never proves profile authorization. On proven platforms, an authorized request also permits one bounded exact-window setup: open the recognized browser product's fixed remote-debugging page, toggle its uniquely matched per-instance checkbox, prove the PID-owned loopback endpoint, and close the temporary tab. Every visible effect is reported; ambiguity is refused.","parameters":{"additionalProperties":true,"properties":{"allow_launch":{"description":"Allow a separate driver-owned isolated Chromium process to be launched (default false).","type":"boolean"},"pid":{"description":"Browser process id to prepare. Required except for a driver-owned isolated_new/isolated_named launch with allow_launch=true.","type":"integer"},"profile":{"additionalProperties":false,"properties":{"mode":{"enum":["isolated_new","isolated_named"],"type":"string"},"name":{"description":"Required only for isolated_named; 1-64 path-safe ASCII characters.","type":"string"}},"required":["mode"],"type":"object"},"session":{"description":"For multi-call work, prefer a short public session label and repeat it on every call that accepts it. Omit it to use the authenticated transport's implicit lifecycle session. Browser targets, tabs, and refs belong to the resolved lifecycle session.","type":"string"},"strategy":{"additionalProperties":false,"properties":{"kind":{"enum":["existing_profile"],"type":"string"}},"required":["kind"],"type":"object"},"window_id":{"description":"Exact native window approval anchor; required for strategy.kind=existing_profile.","type":"integer"}},"required":[],"type":"object"}}
]
const playwrightBrowserSchemas=[
 {name:'mcp__playwright-mcp__browser_navigate',description:'Navigate to a URL',parameters:{type:'object',properties:{url:{type:'string',description:'The URL to navigate to'}},required:['url'],additionalProperties:false}},
 {name:'mcp__playwright-mcp__browser_tabs',description:'List, create, close, or select a browser tab.',parameters:{type:'object',properties:{action:{type:'string',enum:['list','new','close','select'],description:'Operation to perform'},index:{type:'number',description:'Tab index, used for close/select. If omitted for close, current tab is closed.'},url:{type:'string',description:'URL to navigate to in the new tab, used for new.'}},required:['action'],additionalProperties:false}},
 {name:'mcp__playwright-mcp__browser_snapshot',description:'Capture accessibility snapshot of the current page, this is better than screenshot',parameters:{type:'object',properties:{target:{type:'string'},filename:{type:'string',description:'Save snapshot to markdown file instead of returning it in the response.'},depth:{type:'number',description:'Limit the depth of the snapshot tree'},boxes:{type:'boolean'}},additionalProperties:false}},
]
function registerBrowserSchemas(f:Awaited<ReturnType<typeof setup>>,options:{playwright?:boolean;computer?:boolean}={playwright:true,computer:true}){
 for(const row of [...options.playwright?playwrightBrowserSchemas:[],...options.computer?computerBrowserSchemas:[]])f.ctx.tools.register(createMcpToolDefinition(f.ctx,{name:row.name,rawName:row.name,description:row.description,inputSchema:row.parameters,call:async()=>{throw Error('Schema discovery must not operate a browser or desktop')}}))
}
function loadedTools(agent:Agent):{loaded:{name:string}[];hasMore?:boolean;providers?:string[];next:string}{
 const event=agent.session.snapshotEvents().filter(event=>event.type==='tool/result').at(-1)!
 assert.equal(event.type,'tool/result');assert.ok(!event.data.message.isError)
 return JSON.parse(event.data.message.content.filter(row=>row.type==='text').map(row=>row.text).join('\n'))
}

test('真实双浏览器目录按当前表面发现：自带浏览器优先Playwright入口，局部匹配不等于全部目录',async t=>{
 for(const query of ['browser open builtin','open built-in browser','browser','打开自带浏览器','打开内置浏览器']){
  const f=await setup(t);registerBrowserSchemas(f)
  f.adapter.scripts.push(call(toolLoaderName,{query}),text);await f.send()
  const loaded=loadedTools(f.agent),next=f.adapter.requests[1]!,visible=next.tools!.map(tool=>tool.name)
  assert.deepEqual(loaded.loaded.slice(0,3).map(tool=>tool.name),playwrightBrowserSchemas.map(tool=>tool.name),query+' 应先提供无需PID的当前Playwright入口')
  assert.deepEqual(loaded.providers,['playwright-mcp','cua-driver-native']);assert.equal(loaded.hasMore,true,'6条结果不能宣称已穷尽原9个浏览器工具')
  assert.match(loaded.next,/full catalog/);assert.match(loaded.next,/parameter/i)
  const loader=f.adapter.requests[0]!.tools!.find(tool=>tool.name===toolLoaderName)!
  assert.match(loader.description,/Browser \(/);assert.match(loader.description,/Computer \(/)
  for(const original of playwrightBrowserSchemas){assert.ok(visible.includes(original.name));assert.deepEqual(next.tools!.find(tool=>tool.name===original.name)!.parameters,original.parameters)}
  assert.deepEqual(f.executed,[],'发现不能发起桌面或浏览器动作')
 }
})

test('明确已有浏览器PID、接管或桌面意图仍能优先发现CUA，不被Playwright路径覆盖',async t=>{
 for(const query of ['existing browser PID attach','desktop browser','attach browser','接管已有浏览器 PID','电脑浏览器']){
  const f=await setup(t);registerBrowserSchemas(f)
  f.adapter.scripts.push(call(toolLoaderName,{query}),text);await f.send()
  const loaded=loadedTools(f.agent)
  assert.ok(loaded.loaded[0]!.name.startsWith('cua_driver_native__'),query)
  assert.ok(loaded.loaded.some(row=>row.name==='cua_driver_native__browser_prepare'),query+' 必须保留真实CUA准备工具')
  const original=computerBrowserSchemas.find(tool=>tool.name.endsWith('__browser_prepare'))!,actual=f.adapter.requests[1]!.tools!.find(tool=>tool.name===original.name)!
  assert.deepEqual(actual.parameters,original.parameters,'不得把可选pid错误改成总是必填或丢掉profile配置')
  assert.deepEqual(f.executed,[])
 }
})

test('浏览器发现只依赖当前许可目录：单一提供方、撤权和精确名称均不合成工具或扩大权限',async t=>{
 for(const options of [{playwright:false,computer:true},{playwright:true,computer:false}]){
  const f=await setup(t);registerBrowserSchemas(f,options)
  f.adapter.scripts.push(call(toolLoaderName,{query:'browser open builtin'}),text);await f.send()
  const loaded=loadedTools(f.agent),visible=names(f.adapter.requests[1])
  assert.ok(loaded.loaded.length>0);assert.ok(loaded.loaded.every(row=>row.name.startsWith(options.playwright?'mcp__playwright-mcp__':'cua_driver_native__')))
  assert.equal(loaded.providers,undefined,'单一提供方不能宣称另一个已可用')
  assert.ok(!visible.some(name=>name.startsWith(options.playwright?'cua_driver_native__':'mcp__playwright-mcp__')))
  assert.deepEqual(f.executed,[])
 }
 const f=await setup(t);registerBrowserSchemas(f)
 f.adapter.scripts.push(call(toolLoaderName,{names:['cua_driver_native__browser_prepare']}),text);await f.send()
 assert.deepEqual(loadedTools(f.agent).loaded,[{name:'cua_driver_native__browser_prepare'}],'真实精确名称不能被偏好覆盖')
 assert.deepEqual(f.adapter.requests[1]!.tools!.find(tool=>tool.name==='cua_driver_native__browser_prepare')!.parameters,computerBrowserSchemas.find(tool=>tool.name.endsWith('__browser_prepare'))!.parameters)
 f.adapter.scripts.push(call(toolLoaderName,{query:'打开自带浏览器'}),text);await f.send()
 assert.ok(names(f.adapter.requests.at(-1)).includes('mcp__playwright-mcp__browser_navigate'))
 f.agent.ctx.tools.restrict({allow:[...core,toolLoaderName,'cua_driver_native__browser_prepare']})
 f.adapter.scripts.push(call(toolLoaderName,{query:'打开自带浏览器'}),text);await f.send()
 assert.ok(!names(f.adapter.requests.at(-1)).some(name=>name.startsWith('mcp__playwright-mcp__')),'撤权后不能从历史或默认推荐恢复Playwright')
 assert.equal(loadedTools(f.agent).providers,undefined);assert.deepEqual(f.executed,[])
})


test('网页检索与读取保持原动作排序，已有标签页不被当成桌面进程接管',async t=>{
 for(const [query,expected] of [['搜索网页','web_search'],['网页检索','web_search'],['web search','web_search'],['fetch web page','web_fetch']]){
  const f=await setup(t);registerBrowserSchemas(f)
  f.ctx.tools.register(defineTool({name:'web_fetch',description:'Fetch a web page by URL',parameters:{url:{type:'string'}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{throw Error('Discovery must not fetch')}}))
  f.adapter.scripts.push(call(toolLoaderName,{query}),text);await f.send()
  const loaded=loadedTools(f.agent).loaded
  assert.ok(loaded[0]!.name.startsWith('web_'),query+' 应保持网页检索/读取入口优先');assert.ok(loaded.slice(0,2).some(row=>row.name===expected),query+' 不能挤掉原检索/读取动作');assert.deepEqual(f.executed,[])
 }
 for(const query of ['existing browser tab','已有浏览器标签页']){
  const f=await setup(t);registerBrowserSchemas(f)
  f.adapter.scripts.push(call(toolLoaderName,{query}),text);await f.send()
  assert.ok(loadedTools(f.agent).loaded[0]!.name.startsWith('mcp__playwright-mcp__'),query+' 不是已有桌面进程/PID接管意图');assert.deepEqual(f.executed,[])
 }
})
