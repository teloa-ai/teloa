import {installNativeWorkingDirectory} from './native-working-directory.ts'
import {Context} from '@deepseek-ai/cordis'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {patchedSessionFixture,patchedCorePackages,type FinalSessionStore} from './native-final-session.ts'

type Cleanup={after:(action:()=>unknown)=>void}

/** 本夹具没有常驻员工工作；仍装配必需的归属服务，不绕过生产 requireResident。 */
export function installStandaloneResidentAdmission(ctx:Context){
 ctx.provide('teloaResidentInputAdmission' as never,{acquire:async()=>null,restore:(input:unknown,base:(input:unknown)=>unknown)=>base(input)} as never)
}

/** 真 Session/Registry/Loop；仅对官方 Controller 未用到的外部 IO 提供 inert ports。 */
export async function nativeProviderFixture(t:Cleanup){
 const f=await patchedSessionFixture(t),{ctx}=f
 installStandaloneResidentAdmission(ctx)
 const maintain=(agent:Agent)=>agent.runMaintenance(signal=>new Promise<void>(done=>{
  signal.addEventListener('abort',()=>done(),{once:true})
 }))
 void maintain(f.agent);void maintain(f.other)
 const noop=()=>()=>{}
 ctx.provide('typert',{resources:{register:noop},lookups:{register:noop,configure:noop},contexts:{configureHost:noop}} as never)
 ctx.provide('remoteAccess',{allows:()=>true} as never)
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
 await installNativeWorkingDirectory(ctx)
 ctx.provide('sessionQuery',{} as never)
 const modelReadiness={namespaces:[] as {ns:string;value:unknown}[],configured:new Set<string>(),descriptions:[] as string[],resolutions:0}
 ctx.provide('settings',{describe:()=>modelReadiness.namespaces} as never)
 ctx.provide('credentials',{describe:async(ref:string)=>{modelReadiness.descriptions.push(ref);return {configured:modelReadiness.configured.has(ref)}},resolve:()=>{modelReadiness.resolutions++;throw Error('本夹具禁止读取密钥')}} as never)
 return {...f,modelReadiness}
}

/** 尚未启动AgentLoop的真核心图，用于验证profile注入先后顺序。 */
export async function nativeProviderKernel(t:Cleanup){
 const {sessionPackage,agentPackage,persistencePackage,llmPackage,toolsPackage,loopPackage}=await patchedCorePackages(t),ctx=new Context()
 t.after(()=>ctx.fiber.dispose())
 installStandaloneResidentAdmission(ctx)
 for(const plugin of [llmPackage.LlmRuntime,sessionPackage.SessionStore,SessionProjectionRegistry,SystemPrompt,toolsPackage.ToolRuntime,agentPackage.AgentRegistry])await ctx.plugin(plugin)
 return {ctx,sessionPackage,loopPackage,persistencePackage,sessions:Reflect.get(ctx,'sessions') as unknown as FinalSessionStore}
}
