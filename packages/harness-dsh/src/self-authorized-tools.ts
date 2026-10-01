import {roleMemoryProposalToolName} from './role-memory.ts'
import {roleDailyDigestToolNames} from './role-daily-log.ts'
import {groupAttachToolName} from './group-attach-tool.ts'
import {groupReactToolName} from './group-react-tool.ts'

/**
 * 任务执行会话里不经岗位授权清单即可调用的工具（`registerTaskToolGuard` 第三参数）。
 *
 * 这四个名字只登记意图或写受限记录，既不是 MCP 资源工具、编排类、委派工具，也不是外发通道，
 * 因此过得了守卫的三条装配期断言；各自真正的许可核对在自己的 handler / pre-execute 闸里。
 * 会话内安装的八个工具（`teloa_market_*` / `teloa_mcp_connect` / `teloa_industry_*` / `teloa_model_prepare`）不在此列：
 * 任务、分身、协作群、子 Agent 会话一律被守卫按 `allowedTools` 拒绝，本人普通会话再经确认卡。
 */
export const selfAuthorizedToolNames=[roleMemoryProposalToolName,...roleDailyDigestToolNames,groupAttachToolName,groupReactToolName] as const
