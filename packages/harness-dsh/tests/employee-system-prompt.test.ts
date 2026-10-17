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
import {employeeSystemPrompt,employeeSystemPromptSection,leaseEmployeeSystemPrompt,withEmployeeSystemPrompt} from '../src/employee-system-prompt.ts'

class Adapter extends LlmAdapter{
 requests:GenerateOptions[]=[]
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions):AsyncGenerator<StreamChunk>{this.requests.push(options);yield {type:'finish',reason:{kind:'stop'}}}
}

test('员工 Run 的公共指令进入真实系统请求，工具不增权；撤销租约后下一轮不携带',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
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
 assert.ok(system(adapter.requests[0]!).includes(employeeSystemPrompt.split('\n')[0]!))
 const employeeRequest=system(adapter.requests[0]!)
 assert.match(employeeRequest,/用户称为“你”或材料中已确认的实际姓名/)
 assert.match(employeeRequest,/用户提交或确认的内容与本岗位核对\/执行的动作须明确区分/)
 assert.match(employeeRequest,/不把本岗位的核对说明或操作表述成用户“本人”的提交或行动/)
 assert.match(employeeRequest,/用户明确要求代拟第一人称文稿时，可在文稿中使用“我\/本人”等用户视角/,'身份区分不能禁止原本获准的第一人称代拟文稿')
 release();await send('继续普通工作')
 assert.doesNotMatch(system(adapter.requests[1]!),/AI 员工共同工作规则/)
 assert.deepEqual((await assemble()).tools,before.tools)
 assert.strictEqual(withEmployeeSystemPrompt(before,'twin'),before)
 assert.strictEqual(withEmployeeSystemPrompt(before,undefined),before)
 assert.throws(()=>withEmployeeSystemPrompt(after,'employee'),{code:'teloa/conflict'},'重复占用系统规则不能静默叠加')
})
