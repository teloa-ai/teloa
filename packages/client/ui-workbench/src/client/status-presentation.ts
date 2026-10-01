import type {PreviewTask} from './task-preview.ts'
import type {ContinuousPlan} from './continuous-preview.ts'

export type StatusMark='enabled'|'inactive'|'paused'|'retired'|'running'|'waiting'|'complete'|'blocked'|'info'

export const taskStatusMark=(state:PreviewTask['state']):StatusMark=>({ready:'inactive',running:'running',paused:'paused',waiting:'waiting',blocked:'blocked',completed:'complete',cancelled:'retired'} as const)[state]

/** 生命周期只读计划自身；岗位不可执行、交接等阻塞原因由另一行说明。 */
export const planLifecycle=(plan:Pick<ContinuousPlan,'archived'|'enabled'>):'archived'|'active'|'paused'=>plan.archived?'archived':plan.enabled?'active':'paused'
