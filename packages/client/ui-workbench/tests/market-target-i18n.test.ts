import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { translateMessage } from '../lib/types/client/i18n/messages.js'
import { checkMarketTarget, type MarketTarget, type MarketTargetRef } from '../src/client/market-target.ts'

const locales = ['zh-CN', 'zh-Hant', 'en', 'ja', 'ko', 'vi', 'es', 'fr', 'de', 'pt'] as const
const kinds = ['business', 'role', 'group'] as const

test('三种目标类型和五种检查状态均由十语言词条渲染', async () => {
  const presentation = await import('../src/client/i18n/market-target.ts').catch(() => null)
  assert.ok(presentation, '缺少市场目标本地化展示层')
  for (const locale of locales) {
    const t = (key: Parameters<typeof translateMessage>[1], params?: Parameters<typeof translateMessage>[2]) => translateMessage(locale, key, params)
    for (const kind of kinds) {
      const target: MarketTarget = { kind, id: kind, scope: 'general', version: 1, title: kind, availability: 'active' }
      const ref: MarketTargetRef = { ...target }
      const checks = [
        checkMarketTarget(undefined, [target]),
        checkMarketTarget(ref, [target]),
        checkMarketTarget(ref, []),
        checkMarketTarget(ref, [{ ...target, version: 2 }]),
        checkMarketTarget(ref, [{ ...target, availability: 'paused' }]),
      ]
      assert.equal(presentation.marketTargetKindLabel(t, kind), t(`capability.targetKind.${kind}`))
      for (const check of checks) {
        const label = presentation.marketTargetCheckLabel(t, check)
        assert.ok(label.trim(), `${locale}/${kind}/${check.status} 不应为空`)
        assert.doesNotMatch(label, /^capability\./)
        if (check.status === 'unavailable') assert.ok(label.includes(t('capability.targetState.paused')))
      }
    }
  }
})

test('市场页只消费本地化后的目标标签和检查结果', async () => {
  const source = await readFile(new URL('../src/client/MarketPage.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /checkMarketTarget\([^\n]+\)\.message|check\.message/)
  assert.doesNotMatch(source, /marketTargetKinds\[[^\]]+\]|Object\.entries\(marketTargetKinds\)/)
})
