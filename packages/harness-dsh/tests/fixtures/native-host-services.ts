import type {Context} from '@deepseek-ai/cordis'
import {join} from 'node:path'
import {LocalJobRegistry} from '@deepseek-ai/dsh-jobs-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {SubagentRuntime} from '@deepseek-ai/dsh-subagent'
import {TeamService} from '@deepseek-ai/dsh-experimental-agent-team'
import {SandboxPolicyService} from '@deepseek-ai/dsh-sandbox-policy'
import {PermissionPresetService} from '@deepseek-ai/dsh-permission-presets'
import {official} from '../../../../tests/native-auto-review-fixture.mjs'
import {LlmRuntime,LlmAdapter,type StreamChunk,type UserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import TeloaAttachmentStore from '../../src/attachment-guard.ts'

/** 供仅替代工具体/模型的集成夹具使用，日志和 Agent 身份始终由原生实现生成。 */
export async function installNativeSessions(ctx:Context):Promise<void>{
 if(!Reflect.get(ctx,'llm'))await ctx.plugin(LlmRuntime)
 await ctx.plugin(SessionStore)
 await ctx.plugin(SessionProjectionRegistry)
 await ctx.plugin(SystemPrompt)
 await ctx.plugin(AgentRegistry)
 await ctx.plugin(AgentLoop,{agents:[]})
}

/** 生产装配必需的原生服务。外部模型仍由各集成用例控制，不替换 jobs/Team/权限实现。 */
export async function installNativeHostServices(ctx:Context,directory:string):Promise<void>{
 if(!Reflect.get(ctx,'attachments'))await ctx.plugin(TeloaAttachmentStore,{dshHome:directory})
 await ctx.plugin(LocalJobRegistry,{})
 await ctx.plugin(JsonlSessionPersistence,{root:join(directory,'sessions'),compression:'none'})
 await ctx.plugin(SubagentRuntime,{maxDepth:1,maxActiveSubagents:6})
 await ctx.plugin(TeamService,{maxMembers:8})
 await ctx.plugin((await official('dsh-user-approval')).ApprovalService,{policy:'ask'})
 await ctx.plugin(SandboxPolicyService,{mode:'workspace-write',workspaceRoot:directory})
 // 这些验收没有命令执行；仅提供官方权限服务要求的执行器默认模式，不提供 execute。
 ctx.provide('shell',{sandboxMode:'workspace-write'})
 await ctx.plugin(PermissionPresetService,{presets:{'read-only':{sandbox:'read-only',approval:'ask'},'workspace-write':{sandbox:'workspace-write',approval:'ask'}}})
}

/** 只给人工控制轮次的业务夹具提供原生模型元数据；误启动推理立即失败。 */
export class ControlledPromptModel extends LlmAdapter{
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
 async *stream():AsyncIterable<StreamChunk>{throw Error('人工控制轮次的夹具不得启动模型推理')}
}
/** 业务断言继续人工控制回复；生产附件准入保留，新的排队入口与旧控制器共用同一个同步桩。 */
export function controlTaskQueue(ctx:Context,agent:Agent):void{
 const controller=Reflect.get(ctx,'sessionController') as unknown as {prompt:(request:{sessionId:string;requestId:string;content:UserMessage['content']})=>unknown}
 agent.followup=message=>{
  if(message.source.kind!=='user'||!('rpcId' in message.source)||!message.source.rpcId)throw Error('任务排队必须携带原生请求标识')
  controller.prompt({sessionId:agent.session.id,requestId:message.source.rpcId,content:message.content})
 }
}
