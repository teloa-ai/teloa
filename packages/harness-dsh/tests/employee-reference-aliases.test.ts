import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {registerEmployeeReferenceAliases} from '../src/employee-reference-aliases.ts'
import {referenceReadTool} from '../src/role-tool-grants.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'

test('公共只读授权的同文档别名返回固定员工副本且不触发原MCP派发',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId(randomUUID()),agentOptions:{provider:'test',model:'test'}})
 let originalCalls=0,allowed=true
 ctx.tools.register(defineTool({name:referenceReadTool,description:'本地假派发',parameters:{id:{type:'string',required:true},version:{type:'string',required:true}},output:{schema:{type:'object',properties:{content:{type:'array',items:{type:'json'},required:true},structuredContent:{type:'json'}},additionalProperties:false},render:(_args,value)=>value.content as {type:'text';text:string}[]},execute:async()=>{originalCalls++;return {content:[{type:'text',text:'不应发送'}]}}}))
 const origin={id:'teloa-work-guide',version:'a'.repeat(64)},text='本轮固定的员工修订正文',resource={id:randomUUID(),version:1,title:'员工手册',sourceId:'knowledge_'+randomUUID(),sourceVersion:createHash('sha256').update(text).digest('hex'),scopeIds:['general'],text},rules=[{name:referenceReadTool,allowed:[origin]}]
 registerTaskToolGuard(ctx,async()=>({allowedTools:allowed?[referenceReadTool]:[],argumentRules:rules}))
 registerEmployeeReferenceAliases(ctx,{read:async()=>({aliases:[{...origin,resource}],rules})})
 const call=(args:Record<string,unknown>)=>ctx.tools.execute({agent,name:referenceReadTool,arguments:args,callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(10_000)})
 const result=await call(origin);assert.equal(result.isError,false,JSON.stringify(result));assert.equal(originalCalls,0)
 const value=JSON.parse(result.content.filter(row=>row.type==='text').map(row=>row.text).join('\n'));assert.equal(value.text,text);assert.equal(value.id,resource.sourceId);assert.equal(value.version,resource.sourceVersion);assert.deepEqual(value.logicalReference,origin)
 assert.equal((await call({...origin,version:'b'.repeat(64)})).isError,true);assert.equal(originalCalls,0)
 assert.equal((await call({...origin,id:'other-source'})).isError,true);assert.equal(originalCalls,0)
 allowed=false;assert.equal((await call(origin)).isError,true);assert.equal(originalCalls,0)
})
