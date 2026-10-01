export const workErrorCodes = [
  // 八个正式码（design specification §4）
  'teloa/invalid-input',
  'teloa/forbidden',
  'teloa/version-conflict',
  'teloa/conflict',
  'teloa/dependency-unavailable',
  'teloa/storage-corrupt',
  'teloa/source-unavailable',
  'teloa/invalid-host-response',
  // 既有位置接受
  'teloa/storage-unavailable',
  'teloa/not-found',
  // 客户端既有创建与本地恢复状态；与用户提示词典保持同一稳定码。
  'teloa/role-create-pending',
  'teloa/industry-role-pending',
  'teloa/role-create-busy',
  'teloa/recovery-write-failed',
  'teloa/recovery-clear-failed',
  // 既有位置接受，不得扩散：穷举 `new WorkError('teloa/...')` 构造点时发现的既有生产码，
  // 文件:行清单见 design specification
  'teloa/run-configuration-failed',
  'teloa/binding-pending',
  'teloa/cancelled',
  'teloa/copy-in-progress',
  'teloa/copy-lineage-mismatch',
  'teloa/copy-result-unknown',
  'teloa/execution-pending',
  'teloa/file-changed',
  'teloa/file-scope',
  'teloa/file-too-large',
  'teloa/file-unavailable',
  'teloa/flow-not-required',
  'teloa/host-unavailable',
  'teloa/invalid-reference',
  'teloa/not-bound',
  'teloa/preset-unavailable',
  'teloa/resource-withdrawn',
  'teloa/session-not-adoptable',
  'teloa/session-unavailable',
  'teloa/skill-unavailable',
  'teloa/snapshot-conflict',
  'teloa/source-conflict',
  'teloa/source-invalid',
  'teloa/unavailable',
  'teloa/workspace-unavailable',
] as const

export type WorkErrorCode = typeof workErrorCodes[number]

export class WorkError extends Error {
  readonly code: WorkErrorCode
  /** 结构化附加事实（例如卸载阻塞项）：只放本人可见的可枚举内容，宿主按原样回传给客户端。 */
  readonly details?: Record<string, unknown>
  constructor(code: WorkErrorCode, message: string, details?: Record<string, unknown>) { super(message); this.name='WorkError'; this.code=code; if (details !== undefined) this.details = details }
}
