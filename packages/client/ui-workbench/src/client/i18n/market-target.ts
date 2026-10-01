import type { MarketTargetCheck, MarketTargetRef } from '../market-target.js'
import type { TeloaTranslate } from './index.js'

export function marketTargetKindLabel(t: TeloaTranslate, kind: MarketTargetRef['kind']): string {
  return t(`capability.targetKind.${kind}`)
}

export function marketTargetCheckLabel(t: TeloaTranslate, check: MarketTargetCheck): string {
  if (check.status === 'unavailable') {
    return t('capability.targetCheck.unavailable', { state: t(`capability.targetState.${check.params.state}`) })
  }
  return t(`capability.targetCheck.${check.status}`)
}
