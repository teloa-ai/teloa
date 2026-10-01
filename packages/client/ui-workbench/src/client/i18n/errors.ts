import {translateMessage, type MessageKey} from './messages.js'
import {marketTargetCheckLabel} from './market-target.js'
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
  'teloa/file-changed': 'artifactFiles.fileChanged',
  'teloa/source-unavailable': 'error.sourceUnavailable',
  'teloa/storage-unavailable': 'error.storageUnavailable',
  'teloa/run-configuration-failed': 'error.configurationFailed',
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

function detailsReasonOf(error: unknown): unknown {
  if (error === null || typeof error !== 'object' || !('details' in error)) return undefined
  const details = (error as {details?: unknown}).details
  return details !== null && typeof details === 'object' && 'reason' in details ? (details as {reason?: unknown}).reason : undefined
}

/** 服务端 message 仅供日志；用户提示只由稳定 code 和当前产品词典决定。 */
export function localizeWorkError(locale: string, error: unknown): string {
  if (codeOf(error) === 'teloa/invalid-input' && detailsReasonOf(error) === 'secret-in-message') return translateMessage(locale, 'error.secretInMessage')
  if(codeOf(error)==='teloa/storage-corrupt'&&error!==null&&typeof error==='object'&&'origin' in error&&error.origin==='browser-recovery')return translateMessage(locale,'error.browserRecoveryStorage')
  const targetCheck = marketTargetCheckOf(error)
  if (targetCheck) return marketTargetCheckLabel((key,params)=>translateMessage(locale,key,params),targetCheck)
  return translateMessage(locale, errorMessageKey(codeOf(error)))
}
