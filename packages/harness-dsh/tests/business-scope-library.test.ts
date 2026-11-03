import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {registerLibraryTools} from '../src/library-tools.ts'
test('NF02资料工具传实际exec，服务等待期间切业务时不读旧目录',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId('scope-library'),agentOptions:{provider:'test',model:'test'}})
 agent.session.append('turn/start',{turn:1});agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'读取当前业务资料'}]}),{surfaceOp:'append'})
 let calls=0,reads=0
 registerLibraryTools(ctx,{owner:'owner',conversation:async sessionId=>({ownerId:'owner',sessionId,status:'ready'}),readTaskPolicy:async()=>null,actor:async(sessionId,kind,exec)=>{assert.equal(exec.agent,agent);assert.equal(exec.agent.session.id,sessionId);return {ownerId:'owner',kind,scopeIds:[++calls===1?'SOC':'AppSec']}},services:async()=>({knowledge:{list:async()=>{reads++;throw Error('不应读取旧目录')}}}) as never})
 const result=await ctx.tools.execute({agent,name:'teloa_library_directory',arguments:{},callId:ToolCallId('scope-library-call'),signal:AbortSignal.timeout(5000)})
 assert.equal(result.isError,true);assert.equal(reads,0);assert.equal(calls,2)
})
