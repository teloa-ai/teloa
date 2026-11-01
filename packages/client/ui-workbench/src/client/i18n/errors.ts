import {readWorkBudgetExhaustedCode} from '@teloa/contract'
import {translateMessage, type MessageKey} from './messages.js'
import {marketTargetCheckLabel} from './market-target.js'
import {personalProfileValidationCopy} from '../personal-profile-validation-copy.js'
import {roleMemoryConflictCopy} from '../role-memory-conflict-copy.js'
import type {MarketTargetCheck} from '../market-target.js'

export type WorkErrorLike = Readonly<{code?: unknown; message?: unknown; check?: unknown}>

const errorKeys: Readonly<Record<string, MessageKey>> = {
  'teloa/role-create-pending':'error.roleCreatePending',
  'teloa/industry-role-pending':'error.industryRolePending',
  'teloa/role-create-busy':'error.roleCreateBusy',
  'teloa/recovery-write-failed':'error.browserRecoveryWrite',
  'teloa/recovery-clear-failed':'error.browserRecoveryClear',
  'teloa/dependency-unavailable':'error.dependencyUnavailable',
  'teloa/invalid-host-response':'error.invalidHostResponse',
  'teloa/storage-corrupt':'error.storageCorrupt',
  'teloa/invalid-input': 'error.invalidInput',
  'teloa/forbidden': 'error.forbidden',
  'teloa/not-found': 'error.notFound',
  'teloa/conflict': 'error.conflict',
  'teloa/version-conflict': 'error.versionConflict',
  'teloa/budget-exhausted': 'planWork.budget.exhausted',
  'teloa/file-changed': 'artifactFiles.fileChanged',
  'teloa/no-work-evidence':'error.noWorkEvidence',
  'teloa/source-unavailable': 'error.sourceUnavailable',
  'teloa/storage-unavailable': 'error.storageUnavailable',
  'teloa/run-configuration-failed': 'error.configurationFailed',
  'teloa/delivery-review-required': 'error.deliveryReviewRequired',
  'teloa/draft-not-carried': 'conversationDialog.draftNotCarried',
}

export function errorMessageKey(code: unknown): MessageKey {
  return typeof code === 'string' ? errorKeys[code] ?? 'error.unknown' : 'error.unknown'
}

function codeOf(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'code' in error
    ? (error as WorkErrorLike).code
    : undefined
}

function marketTargetCheckOf(error: unknown): MarketTargetCheck | undefined {
  if (codeOf(error) !== 'teloa/market-target-check' || error === null || typeof error !== 'object' || !('check' in error)) return undefined
  const check = (error as WorkErrorLike).check
  if (check === null || typeof check !== 'object' || !('status' in check) || !('params' in check)) return undefined
  const status = (check as {status?: unknown}).status
  if (!['unselected', 'current', 'missing', 'changed', 'unavailable'].includes(String(status))) return undefined
  if (status === 'unavailable') {
    const state = (check as {params?: {state?: unknown}}).params?.state
    if (!['paused', 'retired', 'archived'].includes(String(state))) return undefined
  }
  return check as MarketTargetCheck
}

function detailsFieldOf(error: unknown,field:string): unknown {
  if (error === null || typeof error !== 'object' || !('details' in error)) return undefined
  const details = (error as {details?: unknown}).details
  return details !== null && typeof details === 'object' && field in details ? Reflect.get(details,field) : undefined
}

export const isTaskWorkOutstandingError=(error:unknown):boolean=>codeOf(error)==='teloa/conflict'&&detailsFieldOf(error,'reason')==='task-work-outstanding'
export const isNoWorkEvidenceError=(error:unknown):boolean=>codeOf(error)==='teloa/no-work-evidence'
const contextGoalKey=(error:unknown):MessageKey|undefined=>codeOf(error)!=='teloa/invalid-input'?undefined:detailsFieldOf(error,'reason')==='employee-context-goal-required'?'error.employeeContextGoalRequired':detailsFieldOf(error,'reason')==='detached-project-goal-required'?'error.detachedProjectGoalRequired':undefined
export const isContextGoalRequiredError=(error:unknown):boolean=>contextGoalKey(error)!==undefined

/** 服务端 message 仅供日志；用户提示只由稳定 code 和当前产品词典决定。 */
export function localizeWorkError(locale: string, error: unknown): string {
  const contextGoal=contextGoalKey(error)
  if(contextGoal)return translateMessage(locale,contextGoal)
  if(codeOf(error)==='teloa/conflict'&&detailsFieldOf(error,'reason')==='role-memory-slot-conflict')return roleMemoryConflictCopy(locale)
  if(codeOf(error)==='teloa/invalid-input'){
    const reason=detailsFieldOf(error,'reason'),copy=personalProfileValidationCopy(locale)
    if(reason==='profile-name-empty')return copy.empty
    if(reason==='profile-name-email')return copy.email
    if(reason==='profile-name-too-long')return copy.tooLong
  }
  if (codeOf(error) === 'teloa/conflict' && detailsFieldOf(error,'reason') === 'local-material-registration-mismatch') return translateMessage(locale, 'error.localMaterialRegistrationMismatch')
  if (codeOf(error) === 'teloa/invalid-input' && detailsFieldOf(error,'reason') === 'local-material-format-unsupported') return translateMessage(locale, 'knowledge.local.unsupportedFormat')
  if (codeOf(error) === 'teloa/invalid-input' && detailsFieldOf(error,'reason') === 'secret-in-message') return translateMessage(locale, 'error.secretInMessage')
  // 员工资料范围含不可用资料：只按稳定原因给出可操作提示，不回显内部资料 ID。
  if (codeOf(error) === 'teloa/invalid-input' && detailsFieldOf(error,'reason') === 'role-knowledge-unavailable') return translateMessage(locale, 'error.roleKnowledgeUnavailable')
  if (codeOf(error) === 'teloa/conflict' && detailsFieldOf(error,'reason') === 'role-work-outstanding') return translateMessage(locale, 'error.roleWorkOutstanding')
  // 请求错误带 details；会话本轮失败只有原生 code（teloa/budget-exhausted/<reason>/<scope>）。
  const exhausted=codeOf(error)==='teloa/budget-exhausted'?{reason:detailsFieldOf(error,'reason'),scope:detailsFieldOf(error,'scope')}:readWorkBudgetExhaustedCode(codeOf(error))
  if(exhausted){
    const {reason,scope}=exhausted
    const key=reason==='tokens'?'planWork.budget.exhausted.tokens':reason==='rounds'?'planWork.budget.exhausted.rounds':reason==='concurrent'?'planWork.budget.exhausted.concurrent':reason==='elapsed'?'planWork.budget.exhausted.elapsed':'planWork.budget.exhausted'
    return translateMessage(locale,key,{scope:translateMessage(locale,scope==='owner'?'planWork.budget.owner':scope==='work'?'planWork.budget.account':'planWork.budget.title')})
  }
  if (isTaskWorkOutstandingError(error)) return translateMessage(locale, 'taskCompletion.workOutstanding')
  if(codeOf(error)==='teloa/storage-corrupt'&&error!==null&&typeof error==='object'&&'origin' in error&&error.origin==='browser-recovery')return translateMessage(locale,'error.browserRecoveryStorage')
  const targetCheck = marketTargetCheckOf(error)
  if (targetCheck) return marketTargetCheckLabel((key,params)=>translateMessage(locale,key,params),targetCheck)
  return translateMessage(locale, errorMessageKey(codeOf(error)))
}
