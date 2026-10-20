import type {RunView} from './task-run-api.js'

import type {StatusPillTone} from './StatusPill.js'
export type TaskRunControl='open'|'start'|'withdraw'|'stop'|'reconcile'

export const taskRunPhaseKeys={prepared:'taskExecution.phase.prepared',submitting:'taskExecution.phase.submitting',accepted:'taskExecution.phase.accepted',active:'taskExecution.phase.active',ended:'taskExecution.phase.ended',withdrawn:'taskExecution.phase.withdrawn',configuration_failed:'taskExecution.phase.configurationFailed'} as const
export const taskRunReasonKeys:Record<string,string>={completed:'taskExecution.reason.completed',aborted:'taskExecution.reason.aborted',blocked:'taskExecution.reason.blocked',error:'taskExecution.reason.error','max-tokens':'taskExecution.reason.maxTokens',interrupted:'taskExecution.reason.interrupted'}

/** 执行记录状态胶囊语气：进行中=info，完成=good，阻塞=warn，失败=danger，停止/撤回/结束=muted，尚未提交=neutral。 */
const reasonTones:Record<string,StatusPillTone>={completed:'good',blocked:'warn',error:'danger','max-tokens':'danger',aborted:'muted',interrupted:'muted'}
const phaseTones:Record<RunView['state'],StatusPillTone>={prepared:'neutral',submitting:'info',accepted:'info',active:'info',ended:'muted',withdrawn:'muted',configuration_failed:'danger'}
export function taskRunTone(row:Pick<RunView,'state'|'reason'>,stopping:boolean):StatusPillTone{
 if(stopping)return 'info'
 return row.reason?reasonTones[row.reason]??'muted':phaseTones[row.state]
}

/**
 * 已请求停止但原生轮次还在跑：返回已等待的整秒数。界面据此显示「停止中」并停用停止按钮，
 * 既不伪造终态，也不把这条反馈留在一次动作就会清空的内存提示里。
 */
export function taskRunStopWaitSeconds(row:Pick<RunView,'state'|'stopRequestedAt'>,now:number):number|undefined{
 if(row.state!=='active'||!row.stopRequestedAt)return undefined
 const requested=Date.parse(row.stopRequestedAt)
 return Number.isFinite(requested)?Math.max(0,Math.floor((now-requested)/1000)):undefined
}

/** UI 与测试共用同一控制模型，配置失败不会泄漏任何会话或状态操作。 */
export function taskRunControls(state:RunView['state']):TaskRunControl[]{
 if(state==='configuration_failed')return []
 if(state==='prepared')return ['open','start','withdraw']
 if(state==='withdrawn')return ['open']
 if(state==='active')return ['open','stop','reconcile']
 return ['open','reconcile']
}
