import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {employeeSystemPrompt,employeeSystemPromptSection,employeeSystemPromptVersion,leaseEmployeeSystemPrompt,withEmployeeSystemPrompt} from '../src/employee-system-prompt.ts'
import {autoReviewCausalityFixture} from './fixtures/native-auto-review-causality.ts'
import {textAnswer,toolAnswer} from './fixtures/native-hot-causality.ts'

class Adapter extends LlmAdapter{
 requests:GenerateOptions[]=[]
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions):AsyncGenerator<StreamChunk>{this.requests.push(options);yield {type:'finish',reason:{kind:'stop'}}}
}

test('员工 Run 的公共指令进入真实系统请求，工具不增权；撤销租约后下一轮不携带',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry])await ctx.plugin(plugin)
 await ctx.plugin(SystemPrompt,{personaPrefix:'You are a coding agent powered by the {{model}} model.'})
 for(const plugin of [ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new Adapter();ctx.llm.registerAdapter(['capture'],adapter)
 ctx.tools.register(defineTool({name:'read_fixture',description:'只读夹具',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=> 'fixture'}))
 const {agent}=await ctx.agents.create({sessionId:SessionId('employee-system'),agentOptions:{provider:'capture',model:'capture'}})
 const assemble=()=>ctx.systemPrompt.assemble({agent,scope:agent}),before=await assemble()
 const release=leaseEmployeeSystemPrompt(agent,'employee'),after=await assemble()
 assert.equal(after.sections.filter(section=>section.name===employeeSystemPromptSection).length,1)
 assert.deepEqual(after.tools,before.tools)
 assert.deepEqual(after.contexts,before.contexts)
 const {agent:other}=await ctx.agents.create({sessionId:SessionId('employee-other'),agentOptions:{provider:'capture',model:'capture'}})
 assert.equal((await ctx.systemPrompt.assemble({agent:other,scope:agent})).sections.some(section=>section.name===employeeSystemPromptSection),false,'不能把目标员工的规则经继承作用域赋给其他 Agent')
 const send=async(text:string)=>{agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}));await agent.whenIdle()}
 await send('接手当前已授权任务')
 const system=(request:GenerateOptions)=>JSON.stringify(request.messages.filter(message=>message.role==='system'))
 const employeeSystemText=adapter.requests[0]!.messages.filter(message=>message.role==='system').flatMap(message=>message.content).map(part=>part.type==='text'?part.text:'').join('\n')
 assert.ok(employeeSystemText.includes(employeeSystemPrompt),'员工完整规则进入真实请求，包括当前任务明确终止边界')
 const employeeRequest=system(adapter.requests[0]!)
 assert.match(employeeRequest,/An explicit output contract governs the entire final response/)
 assert.match(employeeRequest,/Do not add preambles, closing remarks, process reports or statements about actions not taken/)
 assert.match(employeeRequest,/You are an AI employee in Teloa/)
 assert.doesNotMatch(employeeRequest,/You are a coding agent/)
 assert.match(employeeRequest,/Use tools only for necessary, authorized work/)
 assert.match(employeeRequest,/Do not call tools merely to manufacture verification/)
 assert.match(employeeRequest,/Use the returned result consistently in the headline, details and conclusion/,'专用Run与普通员工复用同一回执事实规则')
 assert.match(employeeRequest,/Get current facts and runtime state from actual sources; distinguish process failure, business rejection, infrastructure failure and unknown outcomes/)
 assert.doesNotMatch(employeeSystemPrompt,/\p{Script=Han}/u,'公共静态规则应为英文；用户资料不进入该常量')
 assert.match(employeeRequest,/full final body in the last assistant response for the host to save and route; no separate tool call is needed/,'完整正文交付不依赖提醒或附件调用')
 assert.ok(employeeRequest.includes(employeeSystemPromptVersion),'行为版本必须随真实系统正文进入请求，不能只有未使用常量')
 assert.match(employeeRequest,/Tool visibility is a capability ceiling, not permission for this Run/)
 assert.match(employeeRequest,/retained owner restrictions apply to the receiving employee/)
 assert.match(employeeRequest,/take precedence over generic checking methods, tool availability and employee handoff text/)
 assert.match(employeeRequest,/Every run_code invocation, including SDK or tool wrappers, is code execution and an action[\s\S]*Reminders, notifications, memory proposals and housekeeping are not exceptions/,'内部API包装不能规避当前任务的代码与动作限制')
 assert.match(employeeRequest,/only a later explicit owner change can revise them/)
 assert.match(employeeRequest,/Existing host-verified role or workflow authorization remains valid when it covers the action and its implementation and no current task restriction forbids them; fresh task-specific approval is not required merely because the task does not restate that authorization/,'原宿主角色/流程授权持续有效，但必须覆盖实现且未被当前任务限制')
 assert.match(employeeRequest,/rejection denies the attempted operation/)
 assert.match(employeeRequest,/Do not repeat a materially equivalent operation by rewriting code, changing tools or wrapping it differently unless the user explicitly requests that operation again/)
 assert.match(employeeRequest,/Optional reminders and attachments are not prerequisites for delivering the complete final text/)
 assert.match(employeeRequest,/does not revoke unrelated work or cleanup that is independently authorized and permitted by the current task limits/)

 assert.match(employeeRequest,/does not grant tool, data or external-action permission/)
 assert.match(employeeRequest,/Submit reusable experience or change a Skill only when the current task permits that action and its implementation[\s\S]*Do not promote a restriction stated only for this task into lasting memory or a general employee rule without explicit owner intent/,'经验改进仍可获准，但本次限制不自动成为长期规则')
 assert.match(employeeRequest,/Address the user as you or their verified name/)
 assert.match(employeeRequest,/Separate the user's submissions and approvals from your checks and actions/)
 assert.match(employeeRequest,/Never describe your review or execution as the user's own action/)
 assert.match(employeeRequest,/First-person drafting is allowed when explicitly requested; the draft is not approval, execution or submission/,'身份区分不能禁止原本获准的第一人称代拟文稿')
 release();await send('继续普通工作')
 assert.doesNotMatch(system(adapter.requests[1]!),/AI employee working rules/)
 assert.match(system(adapter.requests[1]!),/You are a coding agent/,'租约释放恢复原预设身份，不改本人或普通代码会话')
 assert.deepEqual((await assemble()).tools,before.tools)
 assert.strictEqual(withEmployeeSystemPrompt(before,'twin'),before)
 assert.strictEqual(withEmployeeSystemPrompt(before,undefined),before)
 assert.throws(()=>withEmployeeSystemPrompt(after,'employee'),{code:'teloa/conflict'},'重复占用系统规则不能静默叠加')
})

test('本人实际拒绝回执与窄重试规则同时进入下一次原生模型请求，工具未执行且授权不变',{timeout:15000},async t=>{
 const f=await autoReviewCausalityFixture(t),before=await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent})
 const release=leaseEmployeeSystemPrompt(f.agent,'employee');t.after(release)
 let asks=0
 f.ctx.on('approval/request',async()=>{asks++;return 'rejected'})
 const deny=textAnswer.map(chunk=>chunk.type==='text-delta'?{...chunk,text:'{"risk":"medium","decision":"deny"}'}:chunk.type==='block-end'?{...chunk,block:{type:'text' as const,text:'{"risk":"medium","decision":"deny"}'}}:chunk)
 f.adapter.scripts.push(toolAnswer,deny,textAnswer)
 await f.send('只处理原资料，不使用代码工具。');await f.agent.whenIdle()
 assert.equal(asks,1);assert.equal(f.counters.tools,0)
 assert.equal(f.adapter.requests.length,3)
 const next=JSON.stringify(f.adapter.requests[2]!.messages)
 assert.match(next,/the user rejected tool/);assert.match(next,/hot-tool-call/);assert.match(next,/isError":true/)
 assert.match(next,/Do not repeat a materially equivalent operation/)
 assert.deepEqual((await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent})).tools,before.tools)
})
