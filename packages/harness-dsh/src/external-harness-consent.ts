import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import {WorkError} from '@teloa/contract'
import type {ExternalHarnessPorts} from './external-harness-admission.ts'
import {isPlatformModelProvider} from './platform-model-connection.ts'

/** 复用原生卡与asked/decided审计；许可只属于当前工具、任务、引擎和工作目录。 */
export function createExternalHarnessConsent(ctx:Context):ExternalHarnessPorts['consent']{
 return async({exec,permit})=>{
  if(!exec.agent)throw new WorkError('teloa/forbidden','当前工具没有可核对的本人会话。')
  const engine=permit.provider==='codex'?'Codex':'Claude Agent'
  const platform=isPlatformModelProvider(exec.agent.session.requestContext()?.provider)
  const en=`Allow ${engine} to perform this one task using ${platform?'the platform model service and its native permissions':'its own native account and permissions'}? Teloa's file boundaries and per-action approvals are not forwarded to the engine. Working directory: ${permit.workspaceRoot}`
  const zh=`允许 ${engine} 使用${platform?'平台模型服务及引擎原生权限':'其原生账号和权限'}执行本次任务？Teloa 的文件范围与逐项审批不会传入该引擎。此许可仅限本次任务。工作目录：${permit.workspaceRoot}`
  const traditional=`允許 ${engine} 使用${platform?'平台模型服務及引擎原生權限':'其原生帳號和權限'}執行本次任務？Teloa 的檔案範圍與逐項審批不會傳入該引擎。此授權僅限本次任務。工作目錄：${permit.workspaceRoot}`
  const outcome=await ctx.approval.request({agent:exec.agent,toolName:exec.name,callId:exec.callId,signal:exec.signal,reason:'External harness uses independent native permissions for this one task.',displayReason:{en,zh,'zh-CN':zh,'zh-TW':traditional,'zh-HK':traditional}})
  if(outcome!=='allowed-once')throw new WorkError('teloa/forbidden','本次外部执行未获允许，未启动引擎。')
 }
}
