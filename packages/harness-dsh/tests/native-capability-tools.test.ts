import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {WorkAccess} from '@teloa/backend'

test('普通Agent的实际Team工具体受parallel能力限制，停止和读取工具仍执行',async t=>{
 const module=await import('../src/native-capability-tools.ts').catch(()=>({} as typeof import('../src/native-capability-tools.ts')))
 assert.equal(typeof module.registerNativeCapabilityTools,'function')
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]});const {agent}=await ctx.agents.create({sessionId:SessionId('capability-tool-owner'),agentOptions:{provider:'test',model:'test'}})
 const access=new WorkAccess();access.installPolicy(async request=>{if(request.kind==='capability'&&request.capability==='parallel-agents')throw Error('locked');return {assertCurrent(){}}})
 module.registerNativeCapabilityTools(ctx,'actual-owner',access)
 const bodies:string[]=[]
 for(const name of ['spawn_teammate','send_message','interrupt_agent','list_agents'])ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies.push(name);return name}}))
 for(const name of ['spawn_teammate','send_message','interrupt_agent','list_agents']){
  const result=await ctx.tools.execute({agent,name,arguments:{},callId:ToolCallId(name),signal:AbortSignal.timeout(5000)})
  assert.equal(result.isError,['spawn_teammate','send_message'].includes(name),name+' '+JSON.stringify(result))
 }
 assert.deepEqual(bodies,['interrupt_agent','list_agents'])
})
