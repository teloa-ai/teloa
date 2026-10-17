/** 官方服务测试夹具的公开边界；实现留在可独立运行的 Node 验收脚本中。 */
declare module '*native-auto-review-fixture.mjs' {
 import type {Context,Plugin,Service} from '@deepseek-ai/cordis'
 import type {Agent} from '@deepseek-ai/dsh-agent'
 import type {SessionMetadata} from '@deepseek-ai/dsh-session'
 import type {TestContext} from 'node:test'
 import type {StreamChunk} from '@deepseek-ai/dsh-llm'
 import type {} from '@deepseek-ai/dsh-agent-preset-registry'
 export {defineTool} from '@deepseek-ai/dsh-tools'
 export {ToolCallId} from '@deepseek-ai/dsh-llm'
 export {SessionId} from '@deepseek-ai/dsh-session'
 /** 只声明测试实际消费的官方公开面；非直接依赖按固定 alpha3 声明保留最窄构造/工具契约。 */
 type WorktreeRuntime=Service&{create:(agent:Agent,request?:{name?:string;from?:string},signal?:AbortSignal)=>Promise<{path:string;branch:string;baseCommit:string;repositoryRoot:string}>}
 type WorktreeConfig={directory?:string;namePrefix?:string;gitCommand?:string;nodeCommand?:string;timeoutMs?:number;graceMs?:number;maxOutputBytes?:number}
 type ToolModule={name:string;inject:string[];apply:(ctx:Context)=>void}
 type OfficialModules={
  'dsh-skill':typeof import('@deepseek-ai/dsh-skill')
  'dsh-user-approval':typeof import('@deepseek-ai/dsh-user-approval')
  'dsh-sandbox-policy':typeof import('@deepseek-ai/dsh-sandbox-policy')
  'dsh-fs-sandbox':{default:new(ctx:Context,config:import('@deepseek-ai/dsh-fs-local').Config)=>Context['fs']}
  'dsh-subprocess-local':{default:new(ctx:Context)=>Context['subprocess']}
  'dsh-sandbox-local':{default:new(ctx:Context,config:{runnerCommand?:string[];runnerFailureSignatures?:string[];probeTimeoutMs?:number})=>Context['sandbox']}
  'dsh-ptc-runtime-node':typeof import('@deepseek-ai/dsh-ptc-runtime-node')
  'dsh-permission-presets':typeof import('@deepseek-ai/dsh-permission-presets')
  'cordis-plugin-loader':{Loader:new(ctx:Context,config?:{baseUrl?:string})=>Context['loader'];Group:Plugin<Context['loader']['root']['data']>}
  'dsh-tool-working-directory':ToolModule
  'dsh-session-query':{SessionQueryEngine:new(ctx:Context)=>Context['sessionQuery']}
  'dsh-subagent':typeof import('@deepseek-ai/dsh-subagent')
  'dsh-subagent-spawn-in-process':typeof import('@deepseek-ai/dsh-subagent-spawn-in-process')
  'dsh-experimental-worktree':{default:new(ctx:Context,config:WorktreeConfig)=>WorktreeRuntime}
  'dsh-experimental-tool-worktree':ToolModule
 }
 export function official<Name extends keyof OfficialModules>(name:Name):Promise<OfficialModules[Name]>
 export function textResponse(text:string):StreamChunk[]
 export function createRuntime(t:TestContext):Promise<{ctx:Context;create:(id:string,meta?:Partial<SessionMetadata>)=>Promise<Agent>}>
}
