import type {Translate} from '@deepseek-ai/dsh-client-ui-slots'
import {catalogs, regionCatalogs, validateCatalogs, type MessageKey} from './messages.js'
import {resolveProductLocale, type ProductLocale} from './locale.js'
import {installDshSettingsLanguagePack} from './dsh-settings.js'
import {installDshSidebarLanguagePack} from './dsh-sidebar.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'teloa.workbench': MessageKey
  }
}

export const TELOA_LOCALE_NAMESPACE = 'teloa.workbench'

export type DshLocalePort = {
  getSnapshot: () => {active: string; revision: number}
  subscribe: (listener: () => void) => () => void
  bind: (namespace: string) => Translate
  addLanguage: (input: {id: string; label: string; fallback: string}) => () => void
  register: (namespace: string, locale: string, dictionary: Readonly<Record<string, string>>) => () => void
}

export type TeloaI18nSnapshot = Readonly<{
  locale: ProductLocale
  dshLocale: string
  revision: number
}>

export type TeloaTranslate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string

export type TeloaI18n = {
  readonly t: TeloaTranslate
  readonly getSnapshot: () => TeloaI18nSnapshot
  readonly subscribe: (listener: () => void) => () => void
}

const languages = [
  {id: 'ja', label: '日本語', fallback: 'en'},
  {id: 'ko', label: '한국어', fallback: 'en'},
  {id: 'vi', label: 'Tiếng Việt', fallback: 'en'},
  {id: 'es', label: 'Español', fallback: 'en'},
  {id: 'fr', label: 'Français', fallback: 'en'},
  {id: 'de', label: 'Deutsch', fallback: 'en'},
  {id: 'pt', label: 'Português', fallback: 'en'},
] as const

type TraditionalLocale = 'zh-Hant' | 'zh-TW' | 'zh-HK'

export type TeloaI18nInstallOptions = Readonly<{
  browserLocales?: readonly string[]
}>

function readBrowserLocales(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  return [...(navigator.languages ?? []), navigator.language].filter((locale): locale is string => Boolean(locale))
}

/** 浏览器语言是 Web 端可获得的操作系统地区信号；菜单始终只展示一个繁体中文入口。 */
export function resolveTraditionalLocale(browserLocales: readonly string[]): TraditionalLocale {
  for (const browserLocale of browserLocales) {
    const parts = browserLocale.trim().toLowerCase().split('-')
    if (parts[0] !== 'zh') continue
    if (parts.includes('tw')) return 'zh-TW'
    if (parts.includes('hk') || parts.includes('mo')) return 'zh-HK'
  }
  return 'zh-Hant'
}

function traditionalDictionary(locale: TraditionalLocale): Readonly<Record<string, string>> {
  if (locale === 'zh-Hant') return catalogs['zh-Hant']
  const overrides = Object.fromEntries(
    Object.entries(regionCatalogs[locale]).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  return {...catalogs['zh-Hant'], ...overrides}
}

function runtime(locale: DshLocalePort): TeloaI18n {
  const native = locale.bind(TELOA_LOCALE_NAMESPACE)
  // DSH 的 locale store 在不同宿主实现中不保证复用 snapshot 对象。
  // useSyncExternalStore 需要同一逻辑状态返回同一引用，否则 React 会把每次读取
  // 误认成状态变化并无限重渲染。用公开的值字段作为缓存身份，而非对象身份。
  let sourceActive: string | undefined
  let sourceRevision: number | undefined
  let snapshot: TeloaI18nSnapshot | undefined
  return {
    t: (key, params) => native(key, params),
    subscribe: listener => locale.subscribe(listener),
    getSnapshot: () => {
      const next = locale.getSnapshot()
      if (sourceActive !== next.active || sourceRevision !== next.revision || snapshot === undefined) {
        sourceActive = next.active
        sourceRevision = next.revision
        snapshot = Object.freeze({locale: resolveProductLocale(next.active), dshLocale: next.active, revision: next.revision})
      }
      return snapshot
    },
  }
}

/** 把 Teloa 语言包作为一个可卸载 effect 安装到 DSH 的唯一 locale 服务。 */
export function installTeloaI18n(locale: DshLocalePort, options: TeloaI18nInstallOptions = {}): {runtime: TeloaI18n; dispose: () => void} {
  validateCatalogs(catalogs, regionCatalogs)
  const traditionalLocale = resolveTraditionalLocale(options.browserLocales ?? readBrowserLocales())
  const disposers: Array<() => void> = []
  try {
    disposers.push(locale.addLanguage({id: traditionalLocale, label: '繁體中文', fallback: 'en'}))
    for (const language of languages) disposers.push(locale.addLanguage(language))
    disposers.push(locale.register(TELOA_LOCALE_NAMESPACE, 'zh', catalogs['zh-CN']))
    for (const [id, dictionary] of Object.entries(catalogs)) {
      if (id !== 'zh-CN' && id !== 'zh-Hant') disposers.push(locale.register(TELOA_LOCALE_NAMESPACE, id, dictionary))
    }
    disposers.push(locale.register(TELOA_LOCALE_NAMESPACE, traditionalLocale, traditionalDictionary(traditionalLocale)))
    disposers.push(...installDshSettingsLanguagePack(locale, traditionalLocale))
    disposers.push(...installDshSidebarLanguagePack(locale, traditionalLocale))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  const installedRuntime = runtime(locale)
  let active = true
  return {
    runtime: installedRuntime,
    dispose: () => {
      if (!active) return
      active = false
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}
