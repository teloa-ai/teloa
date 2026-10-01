import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {translateMessage} from '../lib/types/client/i18n/messages.js'
import {marketCountText} from '../lib/types/client/i18n/market-count.js'

const translate = (locale: string) => (key: Parameters<typeof translateMessage>[1], params?: Parameters<typeof translateMessage>[2]) => translateMessage(locale, key, params)

test('市场数量文案按当地语言选择单复数完整句式', () => {
  const de = translate('de')
  assert.equal(marketCountText(de, 'de', 'category', 1, {category: 'Skill'}), '1 Eintrag · Skill')
  assert.equal(marketCountText(de, 'de', 'category', 2, {category: 'Skill'}), '2 Einträge · Skill')
  assert.equal(marketCountText(de, 'de', 'resource', 1), '1 Ressource')
  assert.equal(marketCountText(de, 'de', 'resource', 2), '2 Ressourcen')

  const en = translate('en')
  assert.equal(marketCountText(en, 'en', 'search', 1), '1 matching item; open details by resource identity.')
  assert.equal(marketCountText(en, 'en', 'search', 2), '2 matching items; open details by resource identity.')
  assert.equal(marketCountText(en, 'en', 'attachment', 1), '1 attached file')
  assert.equal(marketCountText(en, 'en', 'attachment', 2), '2 attached files')
})

test('十种产品语言的市场数量文案均为已翻译文本', () => {
  for (const locale of ['zh-CN', 'zh-Hant', 'en', 'ja', 'ko', 'vi', 'es', 'fr', 'de', 'pt']) {
    const t = translate(locale)
    for (const kind of ['search', 'category', 'resource', 'entrypoint', 'attachment'] as const) {
      const text = marketCountText(t, locale, kind, 1, {category: 'Skill'})
      assert.ok(text.includes('1'), `${locale}/${kind} 应包含本地化数量`)
      assert.doesNotMatch(text, /^market\./, `${locale}/${kind} 不应泄漏词条键`)
    }
  }
})

test('市场视图不再拼接复数名词片段', async () => {
  const source = await readFile(new URL('../src/client/MarketPage.tsx', import.meta.url), 'utf8')
  // 分类计数改为统一结果行「共 N 项」（MarketResultLine），不再走 category 句式
  assert.match(source, /<MarketResultLine count=\{templateRows\.length\}\/>/)
  for (const kind of ['search', 'resource', 'entrypoint', 'attachment']) {
    assert.match(source, new RegExp(`marketCountText\\(t,locale,'${kind}'`))
  }
  for (const key of ['market.search.resultsDescriptionSuffix', 'market.results.itemCountClassifier', 'market.results.categoryContentSuffix', 'market.industry.resourceCountSuffix', 'market.industry.entrypointCountSuffix', 'market.skill.attachedFilesCountPrefix']) {
    assert.doesNotMatch(source, new RegExp(key.replaceAll('.', '\\.')))
  }
})
