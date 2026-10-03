import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {patchedSessionFixture,patchedCorePackages,type FinalSessionStore} from './native-final-session.ts'

type Cleanup={after:(action:()=>unknown)=>void}

/** 真 Session/Registry/Loop；仅对官方 Controller 未用到的外部 IO 提供 inert ports。 */
export async function nativeProviderFixture(t:Cleanup){
 const f=await patchedSessionFixture(t),{ctx}=f
 const maintain=(agent:Agent)=>agent.runMaintenance(signal=>new Promise<void>(done=>{
  signal.addEventListener('abort',()=>done(),{once:true})
 }))
 void maintain(f.agent);void maintain(f.other)
 const noop=()=>()=>{}
 ctx.provide('typert',{lookups:{register:noop,configure:noop},contexts:{configureHost:noop}} as never)
 ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'test',model:'test'}),saveSelection:async()=>{}} as never)
 ctx.provide('workspaceRegistry',{get:()=>undefined,list:()=>[],archivedSessionIds:[]} as never)
 ctx.provide('attachments',{
  imageLimits:{maxImageBytes:1000,maxImagePixels:1000,maxImageDimension:100},
  admitPromptContent:async(content:readonly unknown[])=>structuredClone(content),
 } as never)
 ctx.provide('fileUploads',{
  registerAgentResolver:noop,resolve:()=>undefined,
  bindPrompt:()=>({commit(){},[Symbol.dispose](){}}),retirePrompt:()=>{},
 } as never)
 ctx.provide('fs',{} as never);ctx.provide('sessionQuery',{} as never)
 return f
}

/** 尚未启动AgentLoop的真核心图，用于验证profile注入先后顺序。 */
export async function nativeProviderKernel(t:Cleanup){
 const {sessionPackage,llmPackage,toolsPackage,loopPackage}=await patchedCorePackages(t),ctx=new Context()
 t.after(()=>ctx.fiber.dispose())
 for(const plugin of [llmPackage.LlmRuntime,sessionPackage.SessionStore,SessionProjectionRegistry,SystemPrompt,toolsPackage.ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 return {ctx,sessionPackage,loopPackage,sessions:Reflect.get(ctx,'sessions') as unknown as FinalSessionStore}
}
