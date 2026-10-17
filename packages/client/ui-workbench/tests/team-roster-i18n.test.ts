import './employee-asset-test-loader.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import ts from 'typescript'
import {TEAM_DETAIL_MESSAGE_ROWS} from '../src/client/i18n/locales/team-details.ts'
import {MESSAGE_KEYS} from '../lib/types/client/i18n/messages.js'
import type {BusinessScopeLabel} from '../src/client/business-directory.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'
import type {PreviewTask} from '../src/client/task-preview.ts'
import {chineseUiLiterals} from './i18n-ast.ts'

// 简报把「11 列词表补齐」落在既有的 team-details.ts（T1 已经这么做，见 task-8-brief.md「不要搬家」的说明），
// 本文件只补规格 §7.1 要求的结构性守卫，不新建 team-roster.ts。
const clientRoot = new URL('../src/client/', import.meta.url)
const locales = ['zh-CN', 'zh-Hant', 'en', 'ja', 'ko', 'vi', 'es', 'fr', 'de', 'pt'] as const

test('既有团队词条十一列齐全，新增退役入口按定稿三语言精确核对', () => {
  const rows = TEAM_DETAIL_MESSAGE_ROWS.filter(row => row[0].startsWith('team.roster.') || row[0].startsWith('team.profile.') || row[0].startsWith('team.page.'))
  assert.ok(rows.length > 0)
  for (const row of rows) {
    // 2026-10-07 起新增词条只定稿 zh-CN / zh-Hant / en 三列，其余语言走统一回退，不为本断言擅自补译；旧词条仍须十一列齐全。
    assert.equal(row.length, ['team.page.retired.show','team.page.retired.hide'].includes(row[0]) ? 4 : locales.length + 1, row[0])
    for (const [index, locale] of locales.slice(0, row.length - 1).entries()) assert.ok(row[index + 1]?.trim(), `${row[0]}: ${locale}`)
  }
})

test('team.roster.count 的占位符在既有语言中出现次数一致', () => {
  const count = TEAM_DETAIL_MESSAGE_ROWS.find(row => row[0] === 'team.roster.count')!
  assert.ok(count)
  const placeholders = [...(count[3]?.match(/\{[^}]+\}/g) ?? [])].sort()
  for (const [index] of locales.slice(3).entries()) assert.deepEqual([...(count[index + 4]?.match(/\{[^}]+\}/g) ?? [])].sort(), placeholders, `team.roster.count: ${locales[index + 3]}`)

})

test('全宽通讯录页头摘要词条齐全，三档计数文案的占位符各列一致', () => {
  const rows = new Map<string,readonly string[]>(TEAM_DETAIL_MESSAGE_ROWS.map(row => [row[0], row]))
  for (const key of ['team.page.summary', 'team.page.summaryBusy', 'team.page.summaryQuiet', 'team.page.summaryNoEmployees', 'team.page.summaryEmpty'] as const) assert.ok(rows.get(key), `缺 ${key}`)
  assert.equal(rows.has('team.page.eyebrow'),false,'已移除的冗余眉题不能回流')
  for (const [key, expected] of [['team.page.summary', ['{people}', '{waiting}']], ['team.page.summaryBusy', ['{people}', '{busy}']], ['team.page.summaryQuiet', ['{people}']]] as const) {
    for (const [index, locale] of locales.entries()) assert.deepEqual([...(rows.get(key)![index + 1]?.match(/\{[^}]+\}/g) ?? [])].sort(), [...expected].sort(), `${key}: ${locale}`)
  }
})

test('team.hire.action.{id}.{level} 五类动作三档共十五行齐全', () => {
  const ids = ['read', 'think', 'draft', 'change', 'send']
  const levels = ['self', 'ask', 'never']
  const found: Set<string> = new Set(TEAM_DETAIL_MESSAGE_ROWS.filter(row => /^team\.hire\.action\.[a-z]+\.(self|ask|never)$/.test(row[0])).map(row => row[0]))
  for (const id of ids) for (const level of levels) assert.ok(found.has(`team.hire.action.${id}.${level}`), `缺 team.hire.action.${id}.${level}`)
  assert.equal(found.size, 15)
})

test('已删除的孤儿键 team.profile.related 不再登记在 MESSAGE_KEYS 或 team-details.ts', () => {
  assert.ok(!TEAM_DETAIL_MESSAGE_ROWS.some(row => (row[0] as string) === 'team.profile.related'))
  assert.ok(!MESSAGE_KEYS.includes('team.profile.related' as never))
})

test('StaffRoster.tsx 固定界面文案全部来自词典，无裸中文字面量', async () => {
  const source = await readFile(new URL('StaffRoster.tsx', clientRoot), 'utf8')
  assert.match(source, /useI18n\(/)
  assert.deepEqual(chineseUiLiterals(source, 'StaffRoster.tsx'), [])
})

test('TeamPage.tsx 目录栏（TeamPage 函数到 RoleDetail 之前）无裸中文字面量', async () => {
  const source = await readFile(new URL('TeamPage.tsx', clientRoot), 'utf8')
  const body = source.slice(source.indexOf('export function TeamPage'), source.indexOf('function RoleDetail'))
  assert.deepEqual(chineseUiLiterals(body, 'TeamPage.tsx'), [])
})

test('目录总数按身份去重，卡片不需要重复分区计数解释', async () => {
  const source = await readFile(new URL('TeamPage.tsx', clientRoot), 'utf8')
  const chipIndex = source.indexOf("t('team.roster.count'")
  const rosterIndex = source.indexOf('<StaffRoster')
  assert.ok(chipIndex > 0 && rosterIndex > chipIndex, '总数 chip 必须渲染在 <StaffRoster/> 之前')
  assert.match(source, /rosterTotal\(rows\)/)
  assert.doesNotMatch(source,/team-roster-count-note/)
})

// 和 team-avatar.test.ts / team-profile-sections.test.ts 同样的取巧：.tsx 走 tsc 产物，CSS Modules 换成类名代理。
registerHooks({
  resolve: (specifier, context, next) => specifier.endsWith('.module.css') ? {url: new URL(specifier, context.parentURL).href, shortCircuit: true} : next(specifier, context),
  load: (url, context, next) => url.endsWith('.module.css') ? {format: 'module', shortCircuit: true, source: 'export default new Proxy({},{get:(_,key)=>String(key)})'} : next(url, context),
})
const {StaffRoster, dutyLead} = await import('../lib/types/client/StaffRoster.js')
const {I18nProvider} = await import('../lib/types/client/i18n/provider.js')
const {translateMessage} = await import('../lib/types/client/i18n/messages.js')

const zh = (key: string, params?: Record<string, string | number>) => translateMessage('zh-CN', key as never, params)
const runtime = {t: zh, subscribe: () => () => {}, getSnapshot: () => ({locale: 'zh-CN' as const, dshLocale: 'zh', revision: 1})}

const labels: BusinessScopeLabel[] = [
  {scope: 'general', title: '通用工作', kind: 'builtin', loads: 0, activeLoads: 0, tasks: 0, groups: 0},
  {scope: 'SOC', title: '安全运营', kind: 'builtin', loads: 0, activeLoads: 0, tasks: 0, groups: 0},
]
const role = (id: string, scopes: string[], duty = ''): PreviewRole => ({id, name: id, kind: 'employee', scopes: scopes as PreviewRole['scopes'], state: 'active', version: 1, duty, dataScope: '', executionScope: '', skills: [], knowledge: [], memories: [], history: []})
const roles = [role('a', ['general', 'SOC']), role('b', ['general'])]
const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(I18nProvider, {runtime: runtime as never}, createElement(StaffRoster as never, {
  labels, tasks: [] as PreviewTask[], selected: null, fold: {toggled: []}, onFoldChange: () => {}, searching: false, onSelect: () => {}, onHire: () => {}, ...props,
})))

test('StaffRoster 真实渲染：分区标题来自 labels、空闲成员回退 team.roster.idle', () => {
  const markup = render({roles})
  assert.match(markup, /通用工作/)
  assert.match(markup, /安全运营/)
  assert.match(markup, /手上暂时没有事/)
})

test('卡片显示真实业务标签，不拿来源分类代替业务归属', () => {
  const mixed: BusinessScopeLabel[] = [
    {scope: 'general', title: '通用工作', kind: 'builtin', loads: 0, activeLoads: 0, tasks: 0, groups: 0},
    {scope: 'SOC', title: '安全运营', kind: 'domain', loads: 0, activeLoads: 0, tasks: 0, groups: 0},
    {scope: 'legacy-ops', title: '老运维', kind: 'legacy', loads: 0, activeLoads: 0, tasks: 0, groups: 0},
  ]
  const markup = render({roles: [role('a', ['general']), role('b', ['SOC']), role('c', ['legacy-ops']), role('d', ['Design'])], labels: mixed})
  for(const label of ['通用工作','安全运营','老运维','Design'])assert.ok(markup.includes(label))
  assert.equal((markup.match(/data-teloa-entry=/g)??[]).length,4)
})

test('成员行副文案是岗位一句话首句，不再显示 scopes 原值；duty 为空时整行不渲染', () => {
  const markup = render({roles: [role('a', ['general', 'SOC'], '负责安全告警的初筛与结论输出。第二句不该出现。'), role('b', ['general'])]})
  assert.match(markup, /负责安全告警的初筛与结论输出/)
  assert.doesNotMatch(markup, /第二句不该出现/)
  assert.doesNotMatch(markup, /通用工作 \/ 安全运营/)
})

test('成员行首句兼容中英标点和换行，长语言不会把整段职责塞进目录', () => {
  assert.equal(dutyLead('Review alerts. Escalate confirmed incidents.'), 'Review alerts')
  assert.equal(dutyLead('Prüft Befunde! Eskaliert bestätigte Risiken.'), 'Prüft Befunde')
  assert.equal(dutyLead('Revisa las alertas? Escala los incidentes confirmados.'), 'Revisa las alertas')
  assert.equal(dutyLead('核对来源\n形成可审阅结论'), '核对来源')
})

test('搜索态身份卡保留可操作入口，不为搜索禁用员工', () => {
  const markup = render({roles, searching: true})
  assert.match(markup, /data-teloa-entry="a"/)
  assert.doesNotMatch(markup, /<button[^>]*class="cardIdentity"[^>]*disabled=""/)
})
