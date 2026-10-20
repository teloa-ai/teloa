import type {Context} from '@deepseek-ai/cordis'
import {join} from 'node:path'
import {installNativeWorkingDirectory} from './native-working-directory.ts'
import {LocalJobRegistry} from '@deepseek-ai/dsh-jobs-local'
import {createManagedSubagentRuntime} from '../../src/managed-subagent.ts'
import {TeamService} from '@deepseek-ai/dsh-experimental-agent-team'
import {SandboxPolicyService} from '@deepseek-ai/dsh-sandbox-policy'
import {PermissionPresetService} from '@deepseek-ai/dsh-permission-presets'
import {official} from '../../../../tests/native-auto-review-fixture.mjs'
import {LlmRuntime,LlmAdapter,type StreamChunk,type UserMessage} from '@deepseek-ai/dsh-llm'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import type {Agent} from '@deepseek-ai/dsh-agent'
import TeloaAttachmentStore from '../../src/attachment-guard.ts'
import {TeloaNativeInput,requireNativeInputProvider} from '../../src/native-input-provider.ts'
import {patchedCorePackages} from './native-final-session.ts'
import {patchedControllerPackage} from './native-controller-admission.ts'
import {createManagedSessionController} from '../../src/managed-session-controller.ts'
import {createManagedToolJobs} from '../../src/managed-tool-jobs.ts'
import {patchedNativePackage} from './native-patched-package.ts'

const graphs=new WeakMap<Context,ReturnType<typeof patchedCorePackages>>()
type NativeHostTestPorts={collectTool?:(definition:unknown)=>unknown;modelMetadata?:{resolveModelInfo?:(...args:never[])=>unknown;resolveCallConfig?:(...args:never[])=>unknown}}
const testPorts=new WeakMap<Context,NativeHostTestPorts>()
/** 只替代外部模型元数据和收集工具定义，不能替代输入/执行准入服务。 */
export function configureNativeHostTestPorts(ctx:Context,ports:NativeHostTestPorts):void{testPorts.set(ctx,{...testPorts.get(ctx),...ports})}
function nativeGraph(ctx:Context){
 let graph=graphs.get(ctx)
 if(!graph){graph=patchedCorePackages({after:action=>{ctx.effect(()=>()=>action())}});graphs.set(ctx,graph)}
 return graph
}

/** 供仅替代工具体/模型的集成夹具使用，日志和 Agent 身份始终由原生实现生成。 */
export async function installNativeSessions(ctx:Context):Promise<void>{
 const ports=testPorts.get(ctx)
 const graph=await nativeGraph(ctx)
 await ctx.plugin(graph.llmPackage.LlmRuntime)
 // 模型元数据仍可由用例控制；真正的 stream admission 保持官方实现。
 for(const name of ['resolveModelInfo','resolveCallConfig']){
  const method=ports?.modelMetadata&&Reflect.get(ports.modelMetadata,name)
  if(typeof method==='function')Reflect.set(ctx.llm,name,method)
 }
 await ctx.plugin(graph.sessionPackage.SessionStore)
 await ctx.plugin(SessionProjectionRegistry)
 await ctx.plugin(SystemPrompt)
 await ctx.plugin((await official('dsh-skill')).SkillRegistry)
 await ctx.plugin(graph.toolsPackage.ToolRuntime)
 // 原夹具收集注册定义；同一份定义同时进入实际运行器，不替代最终工具准入。
 const collect=ports?.collectTool
 if(typeof collect==='function'){
  const register=ctx.tools.register.bind(ctx.tools)
  ctx.tools.register=definition=>{collect(definition);return register(definition)}
 }
 await ctx.plugin(graph.agentPackage.AgentRegistry)
 await ctx.plugin(TeloaNativeInput)
 await ctx.plugin(graph.loopPackage.AgentLoop,{agents:[]})
}

/** 生产装配必需的原生服务。外部模型仍由各集成用例控制，不替换 jobs/Team/权限实现。 */
export async function installNativeHostServices(ctx:Context,directory:string):Promise<void>{
 // 与宿主 inject 契约一致，使用官方本机路由服务承接对外接口，不替代业务处理或鉴权。
 if(!Reflect.get(ctx,'webServer'))await ctx.plugin((await official('dsh-host-webserver')).WebServer,{host:'127.0.0.1',port:0})
 if(!Reflect.get(ctx,'attachments'))await ctx.plugin(TeloaAttachmentStore,{dshHome:directory})
 await ctx.plugin(LocalJobRegistry,{})
 await ctx.plugin((await nativeGraph(ctx)).persistencePackage,{root:join(directory,'sessions'),compression:'none'})
 await installNativeWorkingDirectory(ctx,directory)
 const subagent=await patchedNativePackage<typeof import('@deepseek-ai/dsh-subagent')>({after:action=>{ctx.effect(()=>()=>action())}},{packageName:'@deepseek-ai/dsh-subagent',compatBasename:'dsh-subagent-0.2.1-rc.2-prompt-admission'})
 await ctx.plugin(createManagedSubagentRuntime(subagent.namespace.SubagentRuntime),{maxDepth:1,maxActiveSubagents:6})
 await ctx.plugin(TeamService,{maxMembers:8})
 await ctx.plugin((await official('dsh-user-approval')).ApprovalService,{policy:'ask'})
 await ctx.plugin(SandboxPolicyService,{mode:'workspace-write',workspaceRoot:directory})
 // 这些验收没有命令执行；仅提供官方权限服务要求的执行器默认模式，不提供 execute。
 ctx.provide('shell',{sandboxMode:'workspace-write'})
 await ctx.plugin(PermissionPresetService,{presets:{'read-only':{sandbox:'read-only',approval:'ask'},'workspace-write':{sandbox:'workspace-write',approval:'ask'}}})
}
export async function installNativeSessionController(ctx:Context,config:ConstructorParameters<typeof import('@deepseek-ai/dsh-api-session-controller').SessionController>[1]):Promise<void>{
 const sdk=await patchedControllerPackage({after:action=>{ctx.effect(()=>()=>action())}})
 // 不调用模型的官方图也装配只读元数据服务；空目录代表未核实，不模拟密钥可用。
 if(!ctx.get('settings'))ctx.provide('settings',{describe:()=>[]} as never)
 if(!ctx.get('credentials'))ctx.provide('credentials',{describe:async()=>{throw Error('本夹具没有凭据记录')},resolve:()=>{throw Error('本夹具禁止读取密钥')}} as never)
 await ctx.plugin(createManagedSessionController(sdk.SessionController),config)
}
export async function installNativeJobTools(ctx:Context,config:import('@deepseek-ai/dsh-tool-jobs').Config):Promise<void>{
 const sdk=await patchedNativePackage<typeof import('@deepseek-ai/dsh-tool-jobs')>({after:action=>{ctx.effect(()=>()=>action())}},{packageName:'@deepseek-ai/dsh-tool-jobs',compatBasename:'dsh-tool-jobs-0.2.1-rc.2-completion-admission'})
 await ctx.plugin(createManagedToolJobs(sdk.namespace),config)
}

/** 只给人工控制轮次的业务夹具提供原生模型元数据；误启动推理立即失败。 */
export class ControlledPromptModel extends LlmAdapter{
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,defaultMaxTokens:1024}}
 async *stream():AsyncIterable<StreamChunk>{throw Error('人工控制轮次的夹具不得启动模型推理')}
}
/** 浏览器 prompt 的模型替身仍经真实最终输入受理，不直接调用未授权的 Agent.followup。 */
export async function publishNativeFixtureInput(ctx:Context,agent:Agent,message:UserMessage):Promise<void>{
 await requireNativeInputProvider(ctx).input.withNewInput(agent,message,{producer:'prompt',identity:'fixture-owner-prompt:'+message.id},()=>{agent.followup(message)})
}
/** 业务断言继续人工控制回复；生产附件准入保留，新的排队入口与旧控制器共用同一个同步桩。 */
export function controlTaskQueue(ctx:Context,agent:Agent):void{
 const controller=Reflect.get(ctx,'sessionController') as unknown as {prompt:(request:{sessionId:string;requestId:string;content:UserMessage['content']})=>unknown}
 agent.followup=message=>{
  if(message.source.kind!=='user'||!('rpcId' in message.source)||!message.source.rpcId)throw Error('任务排队必须携带原生请求标识')
  // 实际最终受理必须经过官方 Inbox；人工控制回复只替代模型 IO，不伪造输入回执。
  agent.inbox.append('next-turn',message)
  const position=agent.inbox.nextTurn.findIndex(input=>input.id===message.id)
  if(position<0)throw Error('人工模型未能取得实际受理的本轮输入')
  // 用例的人工模型取得这一轮，避免未消费 Inbox 被生产收口判据正确地视为后台待办。
  agent.inbox.splice('next-turn',position,1,[])
  controller.prompt({sessionId:agent.session.id,requestId:message.source.rpcId,content:message.content})
 }
}
