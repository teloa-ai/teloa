import './fixtures/message-source.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime,LlmAdapter,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionStore,SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { isRecord } from '@teloa/contract'
import { registerSkillContextDedup } from '../src/skill-context.ts'

class RepeatedSkillAdapter extends LlmAdapter {
  requests:GenerateOptions[]=[]
  override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
  async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
    this.requests.push(options)
    if(this.requests.length===1){
      const id=ToolCallId('redundant-skill'),name='skill',args=JSON.stringify({name:'read-once'})
      yield {type:'block-start',index:0,blockType:'tool-call'}
      yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:args}
      yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:args}}
      yield {type:'finish',reason:{kind:'tool-calls'}}
    }else{
      yield {type:'block-start',index:0,blockType:'text'}
      yield {type:'text-delta',index:0,text:'已使用当前技能。'}
      yield {type:'block-end',index:0,block:{type:'text',text:'已使用当前技能。'}}
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
}

test('原生 Skill 先校验再去掉重复正文；跨会话、变更、压缩和策略不能被旧加载状态覆盖',{timeout:15000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'teloa-skill-context-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const dir=join(root,'skills/read-once'),file=join(dir,'SKILL.md'),body='唯一技能正文标记：请核对来源版本。'
  await mkdir(dir,{recursive:true})
  const save=async(text:string)=>writeFile(file,'---\nname: read-once\ndescription: 去重验收技能\n---\n\n'+text+'\n')
  await save(body)
  const ctx=new Context()
  t.after(()=>ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]});await ctx.plugin(SkillRegistry)
  const mountProvider=()=>ctx.plugin(SkillFileSystem,{includeDefaultRoots:false,customSkillDirs:[join(root,'skills')],watch:false})
  let provider=mountProvider();await provider
  const nativeSkill=await ctx.skills.get('read-once',{cwd:root});assert.ok(nativeSkill)
  await ctx.plugin(ToolSkill)
  registerSkillContextDedup(ctx)
  const adapter=new RepeatedSkillAdapter()
  ctx.llm.registerAdapter(['test-skill-dedup'],adapter)
  const {agent}=await ctx.agents.create({sessionId:SessionId('skill-main'),meta:{cwd:root},agentOptions:{provider:'test-skill-dedup',model:'scripted'}})
  agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'/read-once /read-once\n请完成技能验收。'}]}))
  await agent.whenIdle()
  assert.equal(adapter.requests.length,2)
  const injected=agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.source.kind==='skill-invocation')
  assert.equal(injected.length,1,'重复用户标记仍只注入一条原生 Skill 消息')
  assert.equal(JSON.stringify(adapter.requests[1]!.messages).split(body).length-1,1,'自动注入后模型再次调用，完整正文仍只进入模型上下文一次')
  const load=(target=agent,args:unknown={name:'read-once'},signal=AbortSignal.timeout(5000))=>ctx.tools.execute({callId:ToolCallId('load-'+Math.random()),name:'skill',arguments:args,agent:target,signal})
  const repeated=await load()
  assert.equal(repeated.isError,false)
  assert.ok(isRecord(repeated.value),'原生结果仍保留结构化值')
  assert.equal(repeated.value.content,nativeSkill.content,'结构化工具值保留原生 provider 的完整正文')
  assert.ok(repeated.content.some(block=>block.type==='text'&&block.text.includes('已在当前上下文提供')))

  const {agent:other}=await ctx.agents.create({sessionId:SessionId('skill-other'),meta:{cwd:root},agentOptions:{provider:'test-skill-dedup',model:'scripted'}})
  const invocation=injected[0]!
  assert.equal(invocation.type,'user/message')
  if(invocation.type!=='user/message')throw Error('缺少原生注入消息')
  other.session.append('user/message',createUserMessage({source:{kind:'user'},content:invocation.data.content}),{surfaceOp:'append'})
  assert.ok((await load(other)).content.some(block=>block.type==='text'&&block.text.includes(body)),'其他会话中的用户文字不能伪装成已加载指令')
  other.session.append('user/message',createUserMessage({source:invocation.data.source,content:invocation.data.content}),{surfaceOp:'append'})
  other.session.append('user/message',createUserMessage({source:invocation.data.source,content:[{type:'text',text:'最近同名技能已经更换正文。'}]}),{surfaceOp:'append'})
  assert.ok((await load(other)).content.some(block=>block.type==='text'&&block.text.includes(body)),'不能越过最近不同版本，命中更早相同正文而错误省略')

  await save('变化后的完整技能正文。');await provider.dispose();provider=mountProvider();await provider
  assert.ok((await load()).content.some(block=>block.type==='text'&&block.text.includes('变化后的完整技能正文。')),'同名不同正文必须重新提供')
  await provider.dispose()
  assert.equal((await load()).isError,true,'技能不可用仍由原生校验拒绝，不能把历史加载当成功')
  await save(body);provider=mountProvider();await provider

  const stop=ctx.on('tools/post-execute',async()=>({kind:'block',feedback:[{type:'text',text:'测试策略拒绝'}]}))
  const denied=await load();assert.equal(denied.isError,true);assert.ok(denied.content.some(block=>block.type==='text'&&block.text.includes('测试策略拒绝')));stop()
  const replace=ctx.on('tools/post-execute',async()=>({kind:'accept',content:[{type:'text',text:'另一策略的输出'}]}))
  assert.deepEqual((await load()).content,[{type:'text',text:'另一策略的输出'}]);replace()
  assert.equal((await load(agent,{name:'../invalid'})).isError,true)
  const cancel=new AbortController();cancel.abort();assert.equal((await load(agent,{name:'read-once'},cancel.signal)).isError,true)

  agent.session.append('user/message',createUserMessage({source:{kind:'teloa-test-context'},content:[{type:'text',text:'压缩后摘要不含技能正文。'}]}),{surfaceOp:{op:'replace',startSeq:invocation.seq,endSeq:invocation.seq},sourceEventSeqs:[invocation.seq]})
  assert.ok((await load()).content.some(block=>block.type==='text'&&block.text.includes(body)),'压缩移除原上下文后必须重新提供完整正文')
})
