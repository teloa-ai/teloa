import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import type {Session,SessionEvent,SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {patchedNativePackage} from './native-patched-package.ts'

export type AppendAdmissionPolicy=(session:Session,event:Readonly<SessionEvent>)=>void
export type FinalSessionStore=SessionStore&{
 requireAppendAdmission:()=>void
 installAppendAdmission:(policy:AppendAdmissionPolicy)=>void
}
type Cleanup={after:(action:()=>unknown)=>void}

/** 只修改本测试创建的完整 npm 包副本；原包及 peer 依赖都保持只读。 */
export async function patchedSessionPackage(t:Cleanup){
 const result=await patchedNativePackage<typeof import('@deepseek-ai/dsh-session')&{
  SessionStore:new(ctx:Context)=>FinalSessionStore
 }>(t,{packageName:'@deepseek-ai/dsh-session',compatBasename:'dsh-session-0.2.1-alpha.1-append-admission'})
 return result.namespace
}

/** 同一私有完整官方图；Loop 与 Tools 共用 scheduler Symbol，LLM marker/Adapter 保持原模块。 */
export async function patchedCorePackages(t:Cleanup){
 const sessionPackage=await patchedSessionPackage(t)
 const agentPackage=await patchedNativePackage<typeof import('@deepseek-ai/dsh-agent')>(t,{packageName:'@deepseek-ai/dsh-agent',compatBasename:'dsh-agent-0.2.1-alpha.1-announcement-abort'})
 const persistenceSeam=await patchedNativePackage<typeof import('@deepseek-ai/dsh-session-persistence')>(t,{packageName:'@deepseek-ai/dsh-session-persistence',compatBasename:'dsh-session-persistence-0.2.1-alpha.1-open-admission'})
 const persistencePackage=await patchedNativePackage<typeof import('@deepseek-ai/dsh-session-persistence-jsonl')>(t,{packageName:'@deepseek-ai/dsh-session-persistence-jsonl',compatBasename:'dsh-session-persistence-jsonl-0.2.1-alpha.1-open-admission',overrides:{'@deepseek-ai/dsh-session-persistence':persistenceSeam.root}})
 const llmPackage=await patchedNativePackage<typeof import('@deepseek-ai/dsh-llm')>(t,{packageName:'@deepseek-ai/dsh-llm',compatBasename:'dsh-llm-0.2.1-alpha.1-stream-admission'})
 const toolsPackage=await patchedNativePackage<typeof import('@deepseek-ai/dsh-tools')>(t,{packageName:'@deepseek-ai/dsh-tools',compatBasename:'dsh-tools-0.2.1-alpha.1-work-admission'})
 const loopPackage=await patchedNativePackage<typeof import('@deepseek-ai/dsh-agent-loop')>(t,{packageName:'@deepseek-ai/dsh-agent-loop',compatBasename:'dsh-agent-loop-0.2.1-alpha.1-work-admission',overrides:{'@deepseek-ai/dsh-tools':toolsPackage.root,'@deepseek-ai/dsh-agent':agentPackage.root,'@deepseek-ai/dsh-session-persistence':persistenceSeam.root}})
 return {sessionPackage,agentPackage:agentPackage.namespace,persistencePackage:persistencePackage.namespace,llmPackage:llmPackage.namespace,toolsPackage:toolsPackage.namespace,loopPackage:loopPackage.namespace}
}

/** 真 patched Session/LLM/Tools/Loop + 官方 AgentRegistry/Inbox，同一 Context registry。 */
export async function patchedSessionFixture(t:Cleanup){
 const {sessionPackage,agentPackage,persistencePackage,llmPackage,toolsPackage,loopPackage}=await patchedCorePackages(t)
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [llmPackage.LlmRuntime,sessionPackage.SessionStore,SessionProjectionRegistry,SystemPrompt,toolsPackage.ToolRuntime,agentPackage.AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(loopPackage.AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:sessionPackage.SessionId('final-a'),agentOptions:{provider:'test',model:'test'}})
 const {agent:other}=await ctx.agents.create({sessionId:sessionPackage.SessionId('final-b'),agentOptions:{provider:'test',model:'test'}})
 const sessions=Reflect.get(ctx,'sessions') as unknown as FinalSessionStore
 assert.equal(sessions.get(agent.id),agent.session);assert.equal(ctx.agents.get(agent.id),agent)
 assert.ok(agent.session instanceof sessionPackage.Session)
 return {ctx,agent,other,sessions,sessionPackage,loopPackage,persistencePackage}
}
