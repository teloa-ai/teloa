/** 官方服务测试夹具的公开边界；实现留在可独立运行的 Node 验收脚本中。 */
declare module '*native-auto-review-fixture.mjs' {
 import type {Context} from '@deepseek-ai/cordis'
 import type {Agent} from '@deepseek-ai/dsh-agent'
 import type {SessionMetadata} from '@deepseek-ai/dsh-session'
 import type {TestContext} from 'node:test'
 export {defineTool} from '@deepseek-ai/dsh-tools'
 export {ToolCallId} from '@deepseek-ai/dsh-llm'
 export {SessionId} from '@deepseek-ai/dsh-session'
 export function official(name:'dsh-user-approval'):Promise<{ApprovalService:new(ctx:Context,config:{policy:'ask'|'never'})=>import('@deepseek-ai/cordis').Service}>
 export function createRuntime(t:TestContext):Promise<{ctx:Context;create:(id:string,meta?:Partial<SessionMetadata>)=>Promise<Agent>}>
}
