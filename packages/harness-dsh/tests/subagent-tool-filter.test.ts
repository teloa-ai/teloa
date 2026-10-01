import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {LlmRuntime,ToolCallId} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'

test('toolFilter 只能过滤全局工具，预设作用域工具仍可见且可执行',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('tool-filter-child'),agentOptions:{provider:'test',model:'test'}})
 let globalBodies=0,scopedBodies=0
 ctx.tools.register(defineTool({name:'global_probe',description:'global',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{globalBodies++;return 'global'}}))
 agent.ctx.tools.register(defineTool({name:'preset_probe',description:'scoped',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{scopedBodies++;return 'scoped'}}))
 // `applyChildComposition` 也是在子 Agent 的作用域上调用 restrict；该调用不影响同作用域的预设注册。
 agent.ctx.tools.restrict({deny:['global_probe']})
 assert.deepEqual(ctx.tools.schemas(agent).map(schema=>schema.name),['preset_probe'])
 const signal=AbortSignal.timeout(5000)
 assert.equal((await ctx.tools.execute({agent,name:'global_probe',arguments:{},callId:ToolCallId('filter-global'),signal})).isError,true)
 assert.equal((await ctx.tools.execute({agent,name:'preset_probe',arguments:{},callId:ToolCallId('filter-scoped'),signal})).isError,false)
 assert.equal(globalBodies,0);assert.equal(scopedBodies,1)
})
