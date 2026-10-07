import assert from 'node:assert/strict'
import type {TestContext} from 'node:test'
import {Context} from '@deepseek-ai/cordis'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {AgentRegistry,type Agent,type InboxTarget} from '@deepseek-ai/dsh-agent'
import {SessionStore,SessionId,type SessionEvent,type UserMessage} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime,type ToolExecutionInput,type ToolRunContext,type ToolExecutionResult} from '@deepseek-ai/dsh-tools'
import {LlmRuntime,LlmAdapter,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {patchedNativePackage} from './native-patched-package.ts'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'

export type LoopWorkInput=Readonly<{agent:Agent;turn:number;signal:AbortSignal}>&(
 |Readonly<{kind:'turn-start'|'turn-end';event:Readonly<SessionEvent>}>
 |Readonly<{kind:'step-start'|'step-end';step:number;event:Readonly<SessionEvent>}>
 |Readonly<{kind:'claim';step:number;target:InboxTarget;message:UserMessage}>
 |Readonly<{kind:'request';step:number;options:Readonly<GenerateOptions>}>
 |Readonly<{kind:'tool-prepare';step:number;input:ToolExecutionInput}>
 |Readonly<{kind:'context';step:number;exec:ToolRunContext;result:ToolExecutionResult;context:UserMessage;publish:()=>void}>
)
export type LoopWorkPolicy=(input:LoopWorkInput)=>void
export type LoopWorkRuntime=AgentLoop&{
 requireWorkAdmission:()=>void
 installWorkAdmission:(policy:LoopWorkPolicy)=>void
 requireInputCheckpoint:()=>void
 installInputCheckpoint:(policy:(input:unknown)=>unknown)=>void
 requireProgressCheckpoint:()=>void
 installProgressCheckpoint:(policy:(input:unknown)=>unknown)=>void
}
export type LoopWorkPackage=typeof import('@deepseek-ai/dsh-agent-loop')&{AgentLoop:new(ctx:Context,config:import('@deepseek-ai/dsh-agent-loop').Config)=>LoopWorkRuntime}
export const loopWorkCompat='dsh-agent-loop-0.2.1-alpha.1-work-admission'
export async function patchedLoopWorkPackage(t:TestContext,overrides?:Readonly<Record<string,string>>){
 return patchedNativePackage<LoopWorkPackage>(t,{packageName:'@deepseek-ai/dsh-agent-loop',compatBasename:loopWorkCompat,...overrides===undefined?{}:{overrides}})
}
export const loopText:readonly StreamChunk[]=[
 {type:'block-start',index:0,blockType:'text'},
 {type:'text-delta',index:0,text:'done'},
 {type:'block-end',index:0,block:{type:'text',text:'done'}},
 {type:'finish',reason:{kind:'stop'}},
]
export const loopTool:readonly StreamChunk[]=[
 {type:'block-start',index:0,blockType:'tool-call'},
 {type:'tool-call-delta',index:0,id:ToolCallId('loop-call'),name:'loop_result',argumentsDelta:'{}'},
 {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('loop-call'),name:'loop_result',arguments:'{}'}},
 {type:'finish',reason:{kind:'tool-calls'}},
]
export class LoopWorkAdapter extends LlmAdapter{
 readonly requests:GenerateOptions[]=[]
 readonly scripts:Array<readonly StreamChunk[]>=[]
 async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions):AsyncIterable<StreamChunk>{
  this.requests.push(options);const script=this.scripts.shift();assert.ok(script,'实际模型调用超出明确脚本')
  for(const chunk of script)yield chunk
 }
}
/** 官方全组件；只替换精确 Loop npm 副本，不安装业务因果/许可策略。 */
export async function loopWorkFixture(t:TestContext,original=false,persistenceRoot?:string){
 const pkg=original?undefined:await patchedLoopWorkPackage(t),ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 if(persistenceRoot)await ctx.plugin(Persistence,{root:persistenceRoot,compression:'none'})
 const adapter=new LoopWorkAdapter();ctx.llm.registerAdapter(['loop-test'],adapter)
 await ctx.plugin(pkg?.namespace.AgentLoop??AgentLoop,{agents:[]})
 const loop=ctx.agentLoop as LoopWorkRuntime
 const {agent}=await ctx.agents.create({sessionId:SessionId('loop-work-a'),agentOptions:{provider:'loop-test',model:'loop-model'}})
 const events:SessionEvent[]=[];ctx.on('session/event',(session,event)=>{if(session===agent.session)events.push(event)},{global:true})
 return {ctx,agent,loop,adapter,events,packageRoot:pkg?.root,
  async send(rpcId='loop-input'){
   const message=createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text:'真实Loop SDK接缝验收'}]})
   agent.followup(message);await agent.whenIdle();return message
  },
 }
}
