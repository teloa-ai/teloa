import test from 'node:test'
import assert from 'node:assert/strict'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {installTeloaI18n, type DshLocalePort} from '../lib/types/client/i18n/index.js'
import {I18nProvider, useI18n} from '../lib/types/client/i18n/provider.js'

class TestLocale implements DshLocalePort {
  private active = 'en'
  private revision = 0
  private snapshot = {active: this.active, revision: this.revision}
  private readonly cloneSnapshot: boolean
  private readonly listeners = new Set<() => void>()
  private readonly languages = new Map<string, string | null>([['zh', 'en'], ['en', null]])
  private readonly dictionaries = new Map<string, Map<string, Readonly<Record<string, string>>>>()

  constructor(cloneSnapshot = false) {this.cloneSnapshot = cloneSnapshot}

  readonly getSnapshot = () => this.cloneSnapshot ? {...this.snapshot} : this.snapshot
  readonly subscribe = (listener: () => void) => {this.listeners.add(listener); return () => this.listeners.delete(listener)}
  readonly bind = (namespace: string) => (key: string, params?: Record<string, unknown>) => {
    const seen = new Set<string>()
    let locale: string | null = this.active
    while (locale !== null && !seen.has(locale)) {
      seen.add(locale)
      const value = this.dictionaries.get(namespace)?.get(locale)?.[key]
      if (value !== undefined) return value.replace(/\{(\w+)\}/g, (part, name: string) => Object.hasOwn(params ?? {}, name) ? String(params?.[name]) : part)
      locale = this.languages.get(locale) ?? 'en'
    }
    return key
  }
  readonly addLanguage = ({id, fallback}: {id: string; label: string; fallback: string}) => {
    if (!this.languages.has(fallback) || this.languages.has(id)) throw Error('invalid language')
    this.languages.set(id, fallback)
    this.publish()
    return () => {if (this.languages.delete(id)) this.publish()}
  }
  readonly register = (namespace: string, locale: string, dictionary: Readonly<Record<string, string>>) => {
    const entries = this.dictionaries.get(namespace) ?? new Map<string, Readonly<Record<string, string>>>()
    if (entries.has(locale)) throw Error('duplicate dictionary')
    entries.set(locale, dictionary)
    this.dictionaries.set(namespace, entries)
    this.publish()
    return () => {if (entries.delete(locale)) this.publish()}
  }
  setLocale(locale: string) {
    if (!this.languages.has(locale)) throw Error('unknown locale')
    this.active = locale
    this.publish()
  }
  localeIds() {return [...this.languages.keys()]}
  private publish() {
    this.snapshot = {active: this.active, revision: ++this.revision}
    for (const listener of [...this.listeners]) listener()
  }
}

test('繁体中文只占一个入口，并按操作系统台湾地区使用对应词汇', () => {
  const dsh = new TestLocale()
  const installed = installTeloaI18n(dsh, {browserLocales: ['zh-TW']})
  assert.deepEqual(dsh.localeIds(), ['zh', 'en', 'zh-TW', 'ja', 'ko', 'vi', 'es', 'fr', 'de', 'pt'])
  assert.equal(dsh.localeIds().filter(locale => locale.toLocaleLowerCase().startsWith('zh-')).length, 1)
  assert.equal(installed.runtime.getSnapshot().locale, 'en')
  assert.equal(installed.runtime.t('app.edition.personal'), 'Personal')
  dsh.setLocale('zh')
  assert.equal(installed.runtime.getSnapshot().locale, 'zh-CN')
  assert.equal(installed.runtime.t('app.edition.personal'), '个人版')
  dsh.setLocale('zh-TW')
  assert.equal(installed.runtime.getSnapshot().locale, 'zh-TW')
  assert.equal(installed.runtime.t('shell.settings'), '設定')
  assert.equal(installed.runtime.t('navigation.attention'), '需要你')
  installed.dispose()
  assert.deepEqual(dsh.localeIds(), ['zh', 'en'])
  installed.dispose()
})

test('同一个繁体中文入口按香港地区覆写词汇，无地区时使用通用繁体', () => {
  const hongKong = new TestLocale()
  const hk = installTeloaI18n(hongKong, {browserLocales: ['zh-HK']})
  assert.deepEqual(hongKong.localeIds().filter(locale => locale.toLocaleLowerCase().startsWith('zh-')), ['zh-HK'])
  hongKong.setLocale('zh-HK')
  assert.equal(hk.runtime.t('shell.workspace.mine'), '我的工作區')
  hk.dispose()

  const generic = new TestLocale()
  const hant = installTeloaI18n(generic, {browserLocales: ['en-SG']})
  assert.deepEqual(generic.localeIds().filter(locale => locale.toLocaleLowerCase().startsWith('zh-')), ['zh-Hant'])
  generic.setLocale('zh-Hant')
  assert.equal(hant.runtime.t('shell.settings'), '設定')
  hant.dispose()
})

test('DSH locale revision 经 runtime 订阅传播，并保持稳定快照', () => {
  const dsh = new TestLocale()
  const {runtime, dispose} = installTeloaI18n(dsh)
  const first = runtime.getSnapshot()
  assert.equal(runtime.getSnapshot(), first)
  let notified = 0
  const off = runtime.subscribe(() => {notified += 1})
  dsh.setLocale('de')
  assert.equal(notified, 1)
  assert.notEqual(runtime.getSnapshot(), first)
  assert.equal(runtime.getSnapshot().locale, 'de')
  assert.equal(runtime.getSnapshot(), runtime.getSnapshot())
  off()
  dsh.setLocale('fr')
  assert.equal(notified, 1)
  dispose()
})

test('DSH 每次读取返回新 locale 对象时，runtime 仍复用快照避免 React 无限更新', () => {
  const dsh = new TestLocale(true)
  const {runtime, dispose} = installTeloaI18n(dsh)
  const first = runtime.getSnapshot()
  assert.notEqual(dsh.getSnapshot(), dsh.getSnapshot(), '夹具模拟隔离宿主的非稳定原生对象')
  assert.equal(runtime.getSnapshot(), first, '逻辑值未变化时 React 外部状态快照必须稳定')
  dsh.setLocale('de')
  const changed = runtime.getSnapshot()
  assert.notEqual(changed, first)
  assert.equal(runtime.getSnapshot(), changed)
  dispose()
})

test('React Provider 读取当前 snapshot；同一边界再次渲染会得到切换后的语言', () => {
  const dsh = new TestLocale()
  const {runtime, dispose} = installTeloaI18n(dsh)
  const Probe = () => {
    const i18n = useI18n()
    return createElement('span', null, `${i18n.locale}|${i18n.t('shell.workspace.mine')}|${i18n.number(12345.6, {maximumFractionDigits: 1})}|${i18n.list(['A', 'B', 'C'])}`)
  }
  const render = () => renderToStaticMarkup(createElement(I18nProvider, {runtime}, createElement(Probe)))
  assert.equal(render(), '<span>en|My workspace|12,345.6|A, B, and C</span>')
  dsh.setLocale('de')
  assert.equal(render(), '<span>de|Mein Arbeitsbereich|12.345,6|A, B und C</span>')
  dispose()
})

test('外部语言同时覆盖 DSH 设置页的一级导航与通用配置行', () => {
  const dsh = new TestLocale()
  const {dispose} = installTeloaI18n(dsh, {browserLocales: ['zh-HK']})
  const expectations = {
    'zh-HK': ['語言', '權限', '外觀', '對話顯示', '繁忙時的傳送方式', '模型', '外掛程式', 'Agent 預設', '已封存會話'],
    ja: ['言語', '権限', '外観', '会話表示', '実行中の送信方法', 'モデル', 'プラグイン', 'Agent プリセット', 'アーカイブ済みの会話'],
    ko: ['언어', '권한', '화면 모드', '대화 표시', '실행 중 전송 방식', '모델', '플러그인', 'Agent 프리셋', '보관된 대화'],
    vi: ['Ngôn ngữ', 'Quyền', 'Giao diện', 'Hiển thị hội thoại', 'Cách gửi khi đang chạy', 'Mô hình', 'Plugin', 'Cấu hình Agent', 'Cuộc trò chuyện đã lưu trữ'],
    es: ['Idioma', 'Permisos', 'Apariencia', 'Vista de la conversación', 'Envío durante la ejecución', 'Modelos', 'Plugins', 'Perfiles de Agent', 'Conversaciones archivadas'],
    fr: ['Langue', 'Autorisations', 'Apparence', 'Affichage de la conversation', 'Envoi pendant l’exécution', 'Modèles', 'Plugins', 'Profils d’Agent', 'Conversations archivées'],
    de: ['Sprache', 'Berechtigungen', 'Darstellung', 'Gesprächsansicht', 'Senden während der Ausführung', 'Modelle', 'Plugins', 'Agent-Profile', 'Archivierte Unterhaltungen'],
    pt: ['Idioma', 'Permissões', 'Aparência', 'Visualização da conversa', 'Envio durante a execução', 'Modelos', 'Plugins', 'Perfis de Agent', 'Conversas arquivadas'],
  } as const
  const lookups = [
    ['settings.locale', 'language.title'],
    ['settings.permission', 'title'],
    ['settings.theme', 'appearance.title'],
    ['chat', 'settings.transcript.title'],
    ['conversation', 'settings.enter.title'],
    ['settings.models', 'nav'],
    ['settings.plugins', 'nav'],
    ['settings.agentPreset', 'nav'],
    ['settings.archivedSessions', 'nav'],
  ] as const
  for (const [locale, expected] of Object.entries(expectations)) {
    dsh.setLocale(locale)
    assert.deepEqual(lookups.map(([namespace, key]) => dsh.bind(namespace)(key)), expected, locale)
  }
  dispose()
})

test('归档会话分区的外部语言覆盖全部词条，且不出现裸工作区术语', () => {
  const dsh = new TestLocale()
  const {dispose} = installTeloaI18n(dsh, {browserLocales: ['zh-HK']})
  const keys = ['nav', 'search', 'loading', 'empty', 'unavailable', 'emptySearch', 'unarchive', 'unarchiveNamed', 'ungrouped', 'time.now', 'time.minutes', 'time.hours', 'time.days', 'time.months', 'time.years'] as const
  const leaks = /workspace|Workspace|工作區|工作区|Arbeitsbereich|espacio de trabajo|espace de travail|espaço de trabalho|không gian làm việc|ワークスペース|작업 공간/
  for (const locale of ['zh-HK', 'ja', 'ko', 'vi', 'es', 'fr', 'de', 'pt']) {
    dsh.setLocale(locale)
    const t = dsh.bind('settings.archivedSessions')
    for (const key of keys) {
      const value = t(key, {title: '示例', n: 3})
      assert.notEqual(value, key, locale + '/' + key)
      assert.ok(!leaks.test(value), locale + '/' + key + ': ' + value)
    }
  }
  dispose()
})
