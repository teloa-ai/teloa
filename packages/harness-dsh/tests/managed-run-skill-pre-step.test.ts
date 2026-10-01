import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {SkillRegistry} from '@deepseek-ai/dsh-skill'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import {registerManagedRunSkillPreStep} from '../src/managed-run-skill-pre-step.ts'

for(const lineage of ['bound','missing-parent','offline'] as const)test(`子 Agent Run Skill：${lineage} 按根会话绑定，断链不可降级`,async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(SkillRegistry)
 const parent={session:{id:'skill-parent',header:{}}} as unknown as Agent
 const child={session:{id:'skill-child',header:{origin:'subagent',...(lineage==='missing-parent'?{}:{parentSession:'skill-parent'}),delegationDepth:1}}} as unknown as Agent
 ctx.agents.get=id=>lineage==='bound'&&id===parent.session.id?parent:undefined
 const events:string[]=[],signal=new AbortController().signal,messages=[createUserMessage({source:{kind:'user'},content:[]})]
 registerManagedRunSkillPreStep(ctx,async(id,actualSignal)=>{assert.equal(id,parent.session.id);assert.equal(actualSignal,signal);events.push('reader');return {runId:'parent-run'}},async(agent,binding,actualSignal)=>{assert.equal(agent,child);assert.equal(binding.runId,'parent-run');assert.equal(actualSignal,signal);events.push('ensure')})
 const run=()=>ctx.waterfall('agent/pre-step',{agent:child,messages,turn:1,step:1,signal},async()=>{events.push('next');return {kind:'enter' as const,messages}})
 if(lineage==='bound'){assert.equal((await run()).kind,'enter');assert.deepEqual(events,['reader','ensure','next'])}
 else{await assert.rejects(run,/subagent/);assert.deepEqual(events,[])}
})

for(const placement of ['before','after'] as const){
 for(const outcome of ['bound','ordinary','reader-failed','ensure-failed','aborted-before','aborted-reader','aborted-ensure'] as const){
  test(`真实 DSH 双 pre-step：${placement} 注册，${outcome}`,async t=>{
   const ctx=new Context();t.after(()=>ctx.fiber.dispose())
   await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);await ctx.plugin(SkillRegistry)
   const agent={session:{id:'fixed-session',header:{cwd:'/fixed-workspace'},surface:{nodes:[]},events:[]}} as unknown as Agent
   const events:string[]=[],controller=new AbortController(),failure=new Error('固定绑定不可读取')
   let bound=false
   ctx.skills.register({name:'fixed-method',description:'global',content:'global fallback',source:'runtime'})
   const snapshot=ctx.skills.snapshot.bind(ctx.skills),get=ctx.skills.get.bind(ctx.skills)
   ctx.skills.snapshot=async lookup=>{events.push('catalog');assert.equal(lookup?.scope,agent);return snapshot(lookup)}
   ctx.skills.get=async(name,lookup)=>{events.push('/name');assert.equal(lookup?.scope,agent);return get(name,lookup)}
   const hook=()=>registerManagedRunSkillPreStep(ctx,async(sessionId,signal)=>{
    events.push('reader');assert.equal(sessionId,agent.session.id);assert.equal(signal,controller.signal)
    if(outcome==='reader-failed')throw failure
    if(outcome==='aborted-reader')controller.abort(failure)
    return outcome==='ordinary'?undefined:{runId:'fixed-run'}
   },async(target,binding,signal)=>{
    events.push('ensure-start');assert.equal(target,agent);assert.equal(binding.runId,'fixed-run');assert.equal(signal,controller.signal)
    await Promise.resolve()
    if(outcome==='ensure-failed')throw failure
    if(outcome==='aborted-ensure')controller.abort(failure)
    bound=true;events.push('ensure-done')
   })
   if(placement==='before')hook()
   await ctx.plugin(ToolSkill)
   if(placement==='after')hook()
   if(outcome==='aborted-before')controller.abort(failure)
   const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'/fixed-method 请执行'}]})]
   const dispatch=()=>ctx.waterfall('agent/pre-step',{agent,messages,turn:1,step:1,signal:controller.signal},async()=>{
    events.push('next');return {kind:'enter' as const,messages}
   })
   if(outcome==='bound'||outcome==='ordinary'){
    const decision=await dispatch()
    assert.equal(decision.kind,'enter')
    assert.deepEqual(events,outcome==='bound'?['reader','ensure-start','ensure-done','next','catalog','/name']:['reader','next','catalog','/name'])
    assert.equal(bound,outcome==='bound')
    assert.ok(decision.kind==='enter'&&decision.messages.some(message=>message.source.kind==='skill-catalog'))
    assert.ok(decision.kind==='enter'&&decision.messages.some(message=>message.source.kind==='skill-invocation'))
   }else{
    await assert.rejects(dispatch,error=>error===failure)
    assert.ok(!events.includes('next'))
    assert.ok(!events.includes('catalog')&&!events.includes('/name'),'失败必须阻断真实全局 Skill 读取，不能回退')
   }
  })
 }
}
