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
import {installSessionToolLoading,isCoreTool,toolLoaderName} from '../src/tool-loading.ts'
import {conversationWorkToolNames} from '../src/conversation-work-tool-names.ts'
import {createVoiceToolLoading} from '../src/voice-tool-loading.ts'
import {groupRoutingSessionId} from '@teloa/contract'
import {groupRoutingDenyReason,registerGroupRoutingGuard} from '../src/group-routing-guard.ts'
import {isRoutingSession} from '../src/group-routing.ts'
import * as workBehavior from '../src/work-behavior.ts'

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

async function setup(t:TestContext,options:{loading?:boolean;sessionId?:string;routing?:boolean}={}){
 const ctx=new Context(),adapter=new Adapter(),executed:string[]=[];t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 ctx.llm.registerAdapter(['capture'],adapter)
 const register=(name:string,description:string)=>ctx.tools.register(defineTool({name,description:description+padding,parameters:{target:{type:'string',description:'操作对象'}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{executed.push(name);return 'ok:'+name}}))
 for(const name of core)register(name,'常驻工具'+name)
 for(const [name,description] of Object.entries(deferred))register(name,description)
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

test('普通会话首个请求只广告常驻核心与加载器，加载器描述列出可加载类别，提示词随核心集合变小',async t=>{
 const before=await setup(t,{loading:false});await before.send()
 const after=await setup(t);await after.send()
 const full=before.adapter.requests[0]!,slim=after.adapter.requests[0]!
 assert.deepEqual(names(slim),[...core,toolLoaderName].sort())
 assert.ok(slim.tools!.length<=core.length+1)
 for(const name of [...Object.keys(deferred),...runOnly])assert.ok(!names(slim).includes(name),name+' 不应在首步广告')
 const loader=slim.tools!.find(tool=>tool.name===toolLoaderName)!
 for(const label of ['新建与草案','市场与行业','员工与团队','项目','资料库'])assert.match(loader.description,new RegExp(label))
 assert.doesNotMatch(loader.description,/群管理|计划（/,'没有可加载工具的类别不列出')
 assert.doesNotMatch(system(slim),/项目工具规则/,'延后工具的 tool: 说明随参数一起延后')
 assert.match(system(full),/# 项目配置/);assert.doesNotMatch(system(slim),/# 项目配置/)
 assert.match(system(full),/# 记忆与经验/);assert.doesNotMatch(system(slim),/# 记忆与经验/)
 const bytes=(request:GenerateOptions)=>JSON.stringify(request.tools).length
 t.diagnostic(`改前 ${full.tools!.length} 个工具 ${bytes(full)} 字节，系统提示 ${system(full).length} 字符；改后 ${slim.tools!.length} 个 ${bytes(slim)} 字节，系统提示 ${system(slim).length} 字符`)
 assert.ok(bytes(slim)<bytes(full)*0.7)
 assert.ok(system(slim).length<system(full).length)
})

test('调用加载器后下一请求出现被加载工具，同一会话后续轮次仍在，对应提示词模块恢复',async t=>{
 const f=await setup(t)
 f.adapter.scripts.push(call(toolLoaderName,{names:['teloa_projects_list']}),text)
 await f.send()
 assert.ok(!names(f.adapter.requests[0]).includes('teloa_projects_list'))
 assert.ok(names(f.adapter.requests[1]).includes('teloa_projects_list'))
 assert.match(system(f.adapter.requests[1]!),/项目工具规则/)
 assert.match(system(f.adapter.requests[1]!),/# 项目配置/)
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
 assert.doesNotMatch(results(f.agent),/本次未执行/)
 assert.deepEqual(f.executed,['teloa_employees_create'],'许可内工具按名称直接调用即由原工具执行，参数与权限仍走原工具自身校验')
 assert.ok(names(f.adapter.requests[1]).includes('teloa_employees_create'),'执行后下一步可见正式参数')
 f.adapter.scripts.push(call('teloa_group_attach',{target:'a.txt'}),text)
 await f.send()
 assert.match(results(f.agent),/teloa_group_attach 只适用于受管任务运行，当前会话不可用，本次未执行/)
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
 await assert.rejects(f.ctx.tools.get(toolLoaderName,f.agent)!.execute({names:['teloa_projects_list']},{agent:f.agent,signal:new AbortController().signal} as never),/不在工具加载阶段/,'路由会话不建立加载状态')
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
 assert.match(results(f.agent),/技能名/)
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
