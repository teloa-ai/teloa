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
import * as workBehavior from '../src/work-behavior.ts'
import {leaseEmployeeSystemPrompt} from '../src/employee-system-prompt.ts'
import {restrictRunTools} from '../src/task-run-dsh.ts'

class CaptureAdapter extends LlmAdapter{
 requests:GenerateOptions[]=[]
 override async resolveModel(provider:string,model:string){return{provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions):AsyncGenerator<StreamChunk>{
  this.requests.push(options)
  yield{type:'block-start',index:0,blockType:'text'}
  yield{type:'text-delta',index:0,text:'Captured'}
  yield{type:'block-end',index:0,block:{type:'text',text:'Captured'}}
  yield{type:'finish',reason:{kind:'stop'}}
 }
}

test('TaskRun真实Loop装配尊重固定版本和权限边界，完整证据直接交付而不改变原题或工具',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new CaptureAdapter();ctx.llm.registerAdapter(['capture'],adapter)
 const {agent}=await ctx.agents.create({sessionId:SessionId('task-run-recovery-contract'),agentOptions:{provider:'capture',model:'model'}})
 const permission='Host-verified TaskRun: employee analyst; fixed source version, read-only scope, no delegation or permission expansion.'
 ctx.systemPrompt.context({name:'fixture:run-authorization',order:110,text:permission})
 ctx.tools.register(defineTool({name:'read_fixed_source',description:'Read the authorized fixed source.',parameters:{version:{type:'integer',required:true}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>assert.fail('装配合同不执行工具')}))
 await agent.ctx.plugin(workBehavior)
 t.after(leaseEmployeeSystemPrompt(agent,'employee'))
 t.after(restrictRunTools(agent,['read_fixed_source'],{group:true,digest:false}))
 const assembly=await ctx.systemPrompt.assemble({agent,scope:agent})
 const runtime=assembly.contexts.find(row=>row.name==='teloa:work-behavior-runtime');assert.ok(runtime)
 const selected=JSON.parse(runtime.text.split('\n').at(-1)!).modules as string[]
 assert.ok(selected.includes('01-core')&&selected.includes('03-planning'))
 const original='Use only the fixed record version. If it changed, preserve its current value and report the conflict; do not retry another version, expand permission or reassign. The authorized material and citations are already complete.'
 agent.followup(createUserMessage({source:{kind:'user',rpcId:'recovery-contract-original'},content:[{type:'text',text:original}]}));await agent.whenIdle()
 // 只捕获正式请求装配；固定adapter不证明真实模型服从或质量题通过。
 assert.equal(adapter.requests.length,1)
 const request=adapter.requests[0]!,system=request.messages.filter(row=>row.role==='system').flatMap(row=>row.content.filter(block=>block.type==='text').map(block=>block.text)).join('\n')
 assert.match(system,/Re-read, merge or retry a version conflict only when the current user's authorization and the operation contract permit it/)
 assert.match(system,/For a fixed-version request or an explicit no-retry instruction, preserve the current value and report the conflict; do not implicitly read a newer version, merge or retry/)
 assert.match(system,/When the owner fixes the scope or explicitly forbids permission expansion or reassignment, do not proactively request expanded permission for the current Run or suggest reassignment/)
 assert.match(system,/When this Run already has complete applicable evidence with its source versions and citations, deliver directly/)
 assert.match(system,/Gather more evidence only for a specific missing fact or unresolved source uncertainty; do not repeatedly discover tools or reread the same complete material/)
 assert.doesNotMatch(system,/Re-read and merge version conflicts\./)
 assert.match(system,/A recorded rejection or cancellation is a decision to respect, not missing permission to repair/)
 assert.match(system,/A later explicit owner request may initiate it through the normal approval flow/)
 assert.match(system,/If permission is missing or unavailable, rather than an operation having been rejected or cancelled/)
 assert.deepEqual(request.tools,assembly.tools,'指导不能增删原生工具或改变参数权限')
 assert.ok(JSON.stringify(request.messages).includes(permission))
 const owners=request.messages.filter(row=>row.source?.kind==='user')
 assert.equal(owners.length,1);assert.deepEqual(owners[0]!.content,[{type:'text',text:original}])
})
