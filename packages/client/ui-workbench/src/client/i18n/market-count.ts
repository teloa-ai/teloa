import type {TeloaTranslate} from './index.js'
import {formatNumber} from './format.js'
import {intlLocale} from './locale.js'

export type MarketCountKind = 'search' | 'category' | 'resource' | 'entrypoint' | 'attachment'

const keys = {
  search: {one: 'market.count.search.one', other: 'market.count.search.other'},
  category: {one: 'market.count.category.one', other: 'market.count.category.other'},
  resource: {one: 'market.count.resource.one', other: 'market.count.resource.other'},
  entrypoint: {one: 'market.count.entrypoint.one', other: 'market.count.entrypoint.other'},
  attachment: {one: 'market.count.attachment.one', other: 'market.count.attachment.other'},
} as const

/** 数量和名词必须作为完整本地化句式选择，不能在视图中拼接复数词片段。 */
export function marketCountText(
  t: TeloaTranslate,
  locale: string,
  kind: MarketCountKind,
  count: number,
  params: Readonly<Record<string, string | number>> = {},
): string {
  if (!Number.isSafeInteger(count) || count < 0) throw Error('market count must be a non-negative safe integer')
  const form = new Intl.PluralRules(intlLocale(locale)).select(count) === 'one' ? 'one' : 'other'
  return t(keys[kind][form], {count: formatNumber(locale, count), ...params})
}
