import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatDate,
  formatDateTime,
  formatList,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime,
} from '../lib/types/client/i18n/format.js'

test('日期时间固定按传入 locale 与时区格式化', () => {
  const input = '2026-09-13T12:34:56Z'
  const options = {timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short'} as const
  assert.equal(formatDateTime('zh-CN', input, options), '2026年9月13日 12:34')
  assert.equal(formatDateTime('zh-Hant', input, options), '2026年9月13日 中午12:34')
  assert.equal(formatDateTime('en', input, options), 'Sep 13, 2026, 12:34 PM')
  assert.equal(formatDateTime('ja', input, options), '2026/09/13 12:34')
  // ICU 版本可能使用韩文或拉丁下午标记；日期、时区与时间仍须一致。
  assert.match(formatDateTime('ko', input, options), /^2026\. 9\. 13\. (?:오후|PM) 12:34$/)
  assert.equal(formatDateTime('vi', input, options), '12:34 13 thg 9, 2026')
  assert.equal(formatDateTime('es', input, options), '13 sept 2026, 12:34')
  assert.equal(formatDateTime('fr', input, options), '13 sept. 2026, 12:34')
  assert.equal(formatDateTime('de', input, options), '13.09.2026, 12:34')
  assert.equal(formatDateTime('pt', input, options), '13 de set. de 2026, 12:34')
})

test('列表按当地语言的连接与标点习惯格式化', () => {
  const values = ['Alpha', 'Beta', 'Gamma']
  assert.equal(formatList('zh-CN', values), 'Alpha、Beta和Gamma')
  assert.equal(formatList('en', values), 'Alpha, Beta, and Gamma')
  assert.equal(formatList('ja', values), 'Alpha、Beta、Gamma')
  assert.equal(formatList('en', []), '')
})

test('日期与时间便捷函数各自使用明确的默认展示范围', () => {
  const input = '2026-09-13T12:34:56Z'
  assert.equal(formatDate('en', input, {timeZone: 'UTC'}), 'Sep 13, 2026')
  assert.equal(formatTime('en', input, {timeZone: 'UTC'}), '12:34 PM')
})

test('相对时间、数字和百分比不依赖宿主默认 locale', () => {
  assert.equal(formatRelativeTime('en', -1, 'day'), 'yesterday')
  assert.equal(formatRelativeTime('zh-TW', -1, 'day'), '昨天')
  assert.equal(formatRelativeTime('ja', -1, 'day'), '昨日')
  assert.equal(formatNumber('de', 12345.6, {maximumFractionDigits: 1}), '12.345,6')
  assert.equal(formatNumber('fr', 12345.6, {maximumFractionDigits: 1}), '12 345,6')
  assert.equal(formatPercent('en', 0.125, {maximumFractionDigits: 1}), '12.5%')
  assert.equal(formatPercent('vi', 0.125, {maximumFractionDigits: 1}), '12,5%')
})

test('格式化拒绝非法日期和非有限数值', () => {
  assert.throws(() => formatDateTime('en', 'not-a-date', {timeZone: 'UTC'}), /date|日期/i)
  assert.throws(() => formatNumber('en', Number.NaN), /finite|有限/i)
  assert.throws(() => formatPercent('en', Number.POSITIVE_INFINITY), /finite|有限/i)
  assert.throws(() => formatRelativeTime('en', Number.NaN, 'day'), /finite|有限/i)
})
