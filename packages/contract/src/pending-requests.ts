/**
 * 只有这些浏览器写命令能进入跨浏览器恢复目录。这里故意不用“所有带 requestId 的命令”推断，
 * 新增命令需要经过载荷与凭据边界审查后再明确加入。
 * 携带凭据原值的命令（im/channels/save）不得列入：目录会原样冻结请求体。它按 channelId 覆盖保存，天然幂等，无需跨浏览器恢复。
 * market-content/import 的原文件可达 20 MiB，不重复冻结到此目录；客户端只保存固定请求身份并通过 market-content/receipt 恢复。
 */
export const pendingRequestEndpoints=[
 'security-actions/propose','security-actions/submit','security-actions/decide','security-actions/withdraw-submission','security-actions/withdraw-approval','security-actions/acknowledge-failure','security-actions/execute','security-actions/observe',
 'task-runs/prepare','tasks/materials/add','business-tasks/create','tasks/create','tasks/transition','roles/create',
 'plans/create','plans/change','plans/trigger','handoffs/change','object-conversations/change',
 'role-memory/create','role-memory/confirm','role-memory/withdraw','artifacts/create',
 'industry-loads/create','industry-loads/unload','industry-loads/upgrade','industry-knowledge/instantiate','industry-data-sources/instantiate','industry-data-sources/authorize','industry-execution-tools/instantiate','industry-execution-tools/authorize','industry-mcp-connections/instantiate','industry-mcp-connections/connect','industry-plugins/instantiate','industry-plugins/install','industry-roles/instantiate','industry-tasks/create','industry-plans/create',
 'skill-installations/install','market-plugins/install','skill-selections/change','skill-availability/change','market-content/import-github','market-content/import-github-skill','market-catalog/add','market/github/resolve','groups/create','groups/change','groups/messages/send','groups/resources/save','groups/resources/withdraw','groups/agent-grants/change','groups/tasks/create','groups/attachments/withdraw',
 'business-dashboards/refresh','business-sync/run',
 'im/channels/enable','im/channels/disable','im/channels/remove','im/pairing/create','im/bindings/remove','im/bindings/change','im/groups/bind','im/groups/unbind',
] as const

export type PendingRequestEndpoint=typeof pendingRequestEndpoints[number]
const endpointSet=new Set<string>(pendingRequestEndpoints)
export function isPendingRequestEndpoint(endpoint:string):endpoint is PendingRequestEndpoint{return endpointSet.has(endpoint)}
