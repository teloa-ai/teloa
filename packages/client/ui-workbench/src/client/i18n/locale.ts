export const MAIN_LOCALES = ['zh-CN', 'zh-Hant', 'en', 'ja', 'ko', 'vi', 'es', 'fr', 'de', 'pt'] as const
export const REGION_LOCALES = ['zh-TW', 'zh-HK'] as const

export type MainLocale = typeof MAIN_LOCALES[number]
export type RegionLocale = typeof REGION_LOCALES[number]
export type ProductLocale = MainLocale | RegionLocale

export const LOCALE_FALLBACKS: Readonly<Record<ProductLocale, ProductLocale | null>> = {
  'zh-CN': 'en',
  'zh-Hant': 'en',
  'zh-TW': 'zh-Hant',
  'zh-HK': 'zh-Hant',
  en: null,
  ja: 'en',
  ko: 'en',
  vi: 'en',
  es: 'en',
  fr: 'en',
  de: 'en',
  pt: 'en',
}

const languageLocales: Readonly<Record<string, MainLocale>> = {en: 'en', ja: 'ja', ko: 'ko', vi: 'vi', es: 'es', fr: 'fr', de: 'de', pt: 'pt'}
const localePattern = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/

/** 将 DSH 的 locale id 与浏览器地区标签收窄为 Teloa 的产品语言。 */
export function resolveProductLocale(input: string): ProductLocale {
  const value = input.trim()
  if (!localePattern.test(value)) return 'en'
  const parts = value.toLowerCase().split('-')
  const language = parts[0]!
  if (language === 'zh') {
    if (parts.includes('tw')) return 'zh-TW'
    if (parts.includes('hk') || parts.includes('mo')) return 'zh-HK'
    if (parts.includes('hant')) return 'zh-Hant'
    return 'zh-CN'
  }
  return languageLocales[language] ?? 'en'
}

/** 验证每个节点都存在、没有循环，并最终终止于英文。 */
export function validateFallbackGraph(graph: Readonly<Record<string, string | null>>): void {
  if (!Object.hasOwn(graph, 'en') || graph.en !== null) throw Error('fallback graph must terminate at en')
  for (const start of Object.keys(graph)) {
    if (!start.trim()) throw Error('fallback locale id must not be empty')
    const seen = new Set<string>()
    let current: string | null = start
    while (current !== null) {
      if (seen.has(current)) throw Error(`fallback cycle includes ${current}`)
      seen.add(current)
      if (!Object.hasOwn(graph, current)) throw Error(`unknown fallback locale ${current}`)
      const next: string | null | undefined = graph[current]
      if (next === undefined) throw Error(`unknown fallback locale ${current}`)
      if (next === null && current !== 'en') throw Error(`fallback chain for ${start} does not reach en`)
      current = next
    }
  }
}

validateFallbackGraph(LOCALE_FALLBACKS)

export function fallbackChain(input: string): ProductLocale[] {
  const chain: ProductLocale[] = []
  let current: ProductLocale | null = resolveProductLocale(input)
  const seen = new Set<ProductLocale>()
  while (current !== null) {
    if (seen.has(current)) throw Error(`fallback cycle includes ${current}`)
    seen.add(current)
    chain.push(current)
    current = LOCALE_FALLBACKS[current]
  }
  return chain
}

export function intlLocale(input: string): string {
  return resolveProductLocale(input)
}
