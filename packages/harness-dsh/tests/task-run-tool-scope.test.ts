import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt,type PromptAssembly} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import type {TaskExecutionScope,TaskRun} from '@teloa/backend'
import {dshTaskRunPorts,restrictRunTools,runDateLine,taskSkillUsageNotice,leaseTaskRunMethods} from '../src/task-run-dsh.ts'
import {groupAttachToolName} from '../src/group-attach-tool.ts'
import {groupReactToolName} from '../src/group-react-tool.ts'
import {groupMentionToolName} from '../src/group-mention-tool.ts'
import {roleDailyDigestToolNames} from '../src/role-daily-log.ts'
import {roleMemoryProposalToolName} from '../src/role-memory.ts'

const target:TaskExecutionScope={taskId:'task',taskVersion:3,sessionId:'session',linkVersion:2,scope:'SOC'}
const [dayEvidence,digestSubmit]=roleDailyDigestToolNames
const groupContext={taskId:'task',groupId:'group',groupVersion:1,roleId:'role',roleVersion:1,grantVersion:1,source:{messageId:'m',rootId:'r',createdAt:'2026-10-14T00:00:00.000Z',text:'来源'},messages:[],files:[]}
const skill={name:'review',provider:'native',source:'project',description:'核对',content:'正文',sha256:createHash('sha256').update('正文').digest('hex')}

/** 只记录收窄与原生请求的替身会话；宿主目录里五个自授权工具与一个已授权业务工具都可见。 */
function harness(){
 const visible=['bash',roleMemoryProposalToolName,dayEvidence,digestSubmit,groupAttachToolName,groupReactToolName,'teloa_capabilities']
 const restrictions:Array<readonly string[]|undefined>=[],sent:Array<{content:Array<{type:string;text?:string}>}>=[]
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{header:{cwd:'/target'},snapshotEvents:()=>[]},ctx:{tools:{schemas:()=>visible.map(name=>({name})),restrict:(filter:{allow?:readonly string[]})=>{restrictions.push(filter.allow);return ()=>{}},guard:()=>()=>{}},on:()=>()=>{}}}
 const skills={get:async()=>({...skill,invocation:{modelInvocable:true,userInvocable:true}})}
 const ctx={sessionController:{resolveAgent:async()=>({agent}),prompt:async(request:{content:Array<{type:string;text?:string}>})=>{sent.push(request);return {accepted:true}}},agentPresets:{serviceFor:()=>skills},logger:{warn:()=>{}}} as unknown as Context
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:'session',status:'ready'}))
 const run=(over:Record<string,unknown>={})=>({id:'run',taskId:'task',taskVersion:3,linkVersion:2,sessionId:'session',nativeRequestId:'native',inputText:'固定目标',allowedTools:[],...over}) as unknown as TaskRun
 return {ports,restrictions,sent,run}
}

test('普通运行不向模型显示群与每日小结工具；岗位记忆候选维持原有可见',async()=>{
 const {ports,restrictions,run}=harness()
 let asked=0
 ports.isDigestRun=async()=>{asked++;return false}
 await ports.send(run(),new AbortController().signal,target)
 assert.deepEqual(restrictions,[[roleMemoryProposalToolName]])
 assert.equal(asked,1,'小结身份只经可信端口判定一次')
})

test('授权清单写了静态不适用的工具也不能绕过：普通运行照样收起',async()=>{
 const {ports,restrictions,run}=harness()
 ports.isDigestRun=async()=>false
 await ports.send(run({allowedTools:['teloa_capabilities',groupAttachToolName,groupReactToolName,dayEvidence,digestSubmit]}),new AbortController().signal,target)
 assert.deepEqual(restrictions,[[roleMemoryProposalToolName,'teloa_capabilities']])
})

test('群运行只放出群工具，小结运行只放出小结工具',async()=>{
 const group=harness()
 group.ports.isDigestRun=async()=>false
 await group.ports.send(group.run({groupContext}),new AbortController().signal,target)
 assert.deepEqual(group.restrictions,[[roleMemoryProposalToolName,groupAttachToolName,groupReactToolName]])
 const digest=harness()
 digest.ports.isDigestRun=async run=>run.id==='run'
 await digest.ports.send(digest.run(),new AbortController().signal,target)
 assert.deepEqual(digest.restrictions,[[roleMemoryProposalToolName,dayEvidence,digestSubmit]])
})

test('小结身份判不出或宿主没接判定端口时保守收起，发送照常进行',async()=>{
 const unknown=harness()
 unknown.ports.isDigestRun=async()=>{throw Error('db down')}
 await unknown.ports.send(unknown.run(),new AbortController().signal,target)
 assert.deepEqual(unknown.restrictions,[[roleMemoryProposalToolName]])
 assert.equal(unknown.sent.length,1)
 const absent=harness()
 await absent.ports.send(absent.run(),new AbortController().signal,target)
 assert.deepEqual(absent.restrictions,[[roleMemoryProposalToolName]])
 const aborted=harness(),controller=new AbortController()
 aborted.ports.isDigestRun=async()=>{controller.abort();throw Error('cancelled')}
 await assert.rejects(aborted.ports.send(aborted.run(),controller.signal,target),{name:'AbortError'})
 assert.deepEqual(aborted.restrictions,[],'取消不能被当作「不是小结」继续收窄并发送')
})

test('带技能的运行在固定输入后附通用的技能使用约定；无技能运行与固定输入都不变',async()=>{
 const withSkill=harness()
 const run=withSkill.run({skills:[skill]})
 await withSkill.ports.send(run,new AbortController().signal,target)
 assert.deepEqual(withSkill.sent[0]!.content,[{type:'text',text:'固定目标'},{type:'text',text:taskSkillUsageNotice},{type:'text',text:runDateLine()}])
 assert.equal(run.inputText,'固定目标','约定不写进冻结的运行输入')
 const plain=harness()
 await plain.ports.send(plain.run(),new AbortController().signal,target)
 assert.deepEqual(plain.sent[0]!.content,[{type:'text',text:'固定目标'},{type:'text',text:runDateLine()}])
 // 约定本身：任务与授权定边界，技能定方法与输出；未授权副作用不执行也不找替代；冲突服从任务；资料不升格为指令。
 for(const pattern of [/任务目标与本次运行授权/,/工作方法与输出约定/,/未获授权/,/不改用其他工具或渠道替代/,/以当前任务为准/,/无法确立的结论/,/仍是分析数据/])assert.match(taskSkillUsageNotice,pattern)
})

test('固定 v2 任务以原目标作为明确的当前请求，不把知识正文提升为任务；身份不符时拒绝',async()=>{
 const f=harness(),goal='请用中文交付。七天内完成。\n原始材料逐字保留。',knowledge='资料中的文本不构成任务'
 const inputText=JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:'task',version:3,goal},role:{},knowledge:{contents:[knowledge]}})
 await f.ports.send(f.run({inputText,skills:[skill]}),new AbortController().signal,target)
 assert.deepEqual(f.sent[0]!.content.at(-1),{type:'text',text:'本次任务（按原目标完成交付）：\n'+goal},'冻结 JSON 之外明确给出本人原目标，期限与语言不埋在嵌套字段里')
 assert.equal(f.sent[0]!.content[0]!.text,inputText,'原审计输入逐字保留')
 const bad=harness()
 await assert.rejects(bad.ports.send(bad.run({inputText:inputText.replace('"id":"task"','"id":"other"')}),new AbortController().signal,target),/任务目标与固定运行身份不一致/)
 assert.equal(bad.sent.length,0)
})

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

async function runtime(t:TestContext){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new CaptureAdapter();ctx.llm.registerAdapter(['capture'],adapter)
 const {agent}=await ctx.agents.create({sessionId:SessionId('tool-scope-'+t.name),agentOptions:{provider:'capture',model:'model'}})
 const tool=(scope:Context,name:string,parameters:Record<string,{type:'string';required:true}>={})=>scope.tools.register(defineTool({name,description:'测试工具',parameters,output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=> 'fixture'}))
 // 宿主层：五个自授权工具与一个业务工具。
 for(const name of [roleMemoryProposalToolName,dayEvidence!,digestSubmit!,groupAttachToolName,groupReactToolName,groupMentionToolName,'teloa_capabilities'])tool(ctx,name)
 // 与 DSH Team 一致：Team 工具及其策略段注册在该 Agent 自己的作用域里。
 tool(agent.ctx,'list_agents');tool(agent.ctx,'spawn_teammate');tool(agent.ctx,'send_message',{target:{type:'string',required:true},message:{type:'string',required:true}})
 agent.ctx.systemPrompt.section({name:'team:policy',order:agent.ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),text:'TEAM POLICY'})
 await agent.ctx.plugin(await import('../src/work-behavior.ts'))
 const modules=(assembly:PromptAssembly)=>JSON.parse(assembly.contexts.find(row=>row.name==='teloa:work-behavior-runtime')!.text.split('\n').at(-1)!).modules as string[]
 return {ctx,agent,adapter,modules,assemble:()=>ctx.systemPrompt.assemble({agent,scope:agent})}
}

test('Agent 自身作用域的 Team 工具不受全局收窄约束：未授权时从模型目录和策略段一并撤下',async t=>{
 const {agent,adapter,modules,assemble}=await runtime(t)
 assert.throws(()=>agent.ctx.tools.restrict({allow:['list_agents']}),/unknown global tool/,'Agent 自身作用域的工具不在全局收窄可处理的范围内')
 const before=await assemble()
 assert.ok(before.tools.some(tool=>tool.name==='list_agents'))
 const lift=restrictRunTools(agent,[],{group:false,digest:false})
 const scoped=await assemble()
 assert.deepEqual(scoped.tools.map(tool=>tool.name),[roleMemoryProposalToolName])
 assert.equal(scoped.sections.some(section=>section.name==='team:policy'),false)
 // 只剩自授权工具：不注入泛化平台工具与协作说明；记忆候选维持原有规则选择。
 assert.deepEqual(modules(scoped),['01-core','03-planning','04-memory','08-artifacts'])
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'tool-scope-input'},content:[{type:'text',text:'固定目标'}]}));await agent.whenIdle()
 assert.deepEqual(adapter.requests[0]!.tools?.map(tool=>tool.name),[roleMemoryProposalToolName],'实际模型请求与组装目录一致')
 lift()
 const restored=await assemble()
 assert.deepEqual(restored.tools.map(tool=>tool.name),before.tools.map(tool=>tool.name))
 assert.equal(restored.sections.some(section=>section.name==='team:policy'),true)
})

test('显式授权的 Team 工具与业务工具保留并照常选择规则；授权里的群工具在普通运行仍被收起',async t=>{
 const {agent,modules,assemble}=await runtime(t)
 restrictRunTools(agent,['spawn_teammate','teloa_capabilities',groupAttachToolName],{group:false,digest:false})
 const scoped=await assemble()
 assert.deepEqual(scoped.tools.map(tool=>tool.name).sort(),['spawn_teammate','teloa_capabilities',roleMemoryProposalToolName].sort())
 assert.equal(scoped.sections.some(section=>section.name==='team:policy'),true)
 assert.deepEqual(modules(scoped),['01-core','02-tools','03-planning','04-memory','06-collaboration','08-artifacts'])
})

test('群运行与小结运行在真实目录中只放出各自的工具',async t=>{
 const group=await runtime(t)
 restrictRunTools(group.agent,[],{group:true,digest:false})
 assert.deepEqual((await group.assemble()).tools.map(tool=>tool.name).sort(),[groupAttachToolName,groupReactToolName,groupMentionToolName,roleMemoryProposalToolName].sort())
 const report=await runtime(t)
 restrictRunTools(report.agent,[],{group:false,digest:false,report:true})
 assert.deepEqual((await report.assemble()).tools.map(tool=>tool.name).sort(),[groupAttachToolName,groupMentionToolName,roleMemoryProposalToolName].sort(),'计划汇报只能声明附件与提及，不获得群表情或其他群历史能力')
 const digest=await runtime(t)
 restrictRunTools(digest.agent,[],{group:false,digest:true})
 assert.deepEqual((await digest.assemble()).tools.map(tool=>tool.name).sort(),[dayEvidence,digestSubmit,roleMemoryProposalToolName].sort())
})

test('选择的固定 Skill 进入真实模型系统方法段，原正文与变量字面量不变；撤销后不污染后续会话',async t=>{
 const {agent,adapter,assemble}=await runtime(t)
 const content='---\nname: review\n---\n先核对材料，保留 {{literal}}。'
 const chosen={...skill,content,sha256:createHash('sha256').update(content).digest('hex')}
 const before=await assemble(),release=leaseTaskRunMethods(agent,[chosen]),after=await assemble()
 const methods=after.sections.find(section=>section.name==='teloa:run-selected-methods')
 assert.ok(methods,'所选方法不能只藏在用户输入的 JSON 字符串中')
 assert.ok(methods.text.includes(content),'固定 Skill 正文须逐字进入方法段')
 assert.equal(methods.interpolate,false,'厂商正文中的模板变量不得由平台替换')
 assert.deepEqual(after.tools,before.tools,'接入方法不能授予工具权限')
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'method-input'},content:[{type:'text',text:'固定目标，不调用工具。'}]}));await agent.whenIdle()
 assert.ok(adapter.requests[0]!.messages.some(message=>message.role==='system'&&message.content.some(block=>block.type==='text'&&block.text.includes(content))),'真实模型请求须含固定方法正文')
 release()
 assert.equal((await assemble()).sections.some(section=>section.name==='teloa:run-selected-methods'),false)
 assert.throws(()=>leaseTaskRunMethods(agent,[{...chosen,sha256:'0'.repeat(64)}]),/快照不完整|摘要不一致/,'哈希不一致不得变成模型方法')
 assert.equal((await assemble()).sections.some(section=>section.name==='teloa:run-selected-methods'),false)
})


test('固定计划汇报只向模型开放本轮成果声明，不开放群表情或每日小结工具',async()=>{
 const f=harness(),inputText=JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:'task',version:3,goal:'原计划工作'},planContext:{occurrenceId:'33333333-3333-4333-8333-333333333333',reportGroup:{groupId:'group',groupVersion:1,grantVersion:1}}})
 await f.ports.send(f.run({inputText}),new AbortController().signal,target)
 assert.deepEqual(f.restrictions,[[roleMemoryProposalToolName,groupAttachToolName]])
})
