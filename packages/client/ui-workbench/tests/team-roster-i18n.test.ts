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

test('team.roster.* / team.profile.* / team.page.* 词条十一列齐全、每列非空', () => {
  const rows = TEAM_DETAIL_MESSAGE_ROWS.filter(row => row[0].startsWith('team.roster.') || row[0].startsWith('team.profile.') || row[0].startsWith('team.page.'))
  assert.ok(rows.length > 0)
  for (const row of rows) {
    assert.equal(row.length, locales.length + 1, row[0])
    for (const [index, locale] of locales.entries()) assert.ok(row[index + 1]?.trim(), `${row[0]}: ${locale}`)
  }
})

test('team.roster.count / team.roster.countNote 的占位符在十一列里出现次数一致', () => {
  const count = TEAM_DETAIL_MESSAGE_ROWS.find(row => row[0] === 'team.roster.count')!
  assert.ok(count)
  const placeholders = [...(count[3]?.match(/\{[^}]+\}/g) ?? [])].sort()
  for (const [index] of locales.slice(3).entries()) assert.deepEqual([...(count[index + 4]?.match(/\{[^}]+\}/g) ?? [])].sort(), placeholders, `team.roster.count: ${locales[index + 3]}`)
  const note = TEAM_DETAIL_MESSAGE_ROWS.find(row => row[0] === 'team.roster.countNote')!
  assert.ok(note)
  assert.ok(note.slice(1).every(value => !/\{[^}]+\}/.test(value)), 'countNote 不带占位符')
})

test('全宽通讯录页头摘要词条齐全，三档计数文案的占位符各列一致', () => {
  const rows = new Map(TEAM_DETAIL_MESSAGE_ROWS.map(row => [row[0], row]))
  for (const key of ['team.page.eyebrow', 'team.page.summary', 'team.page.summaryBusy', 'team.page.summaryQuiet', 'team.page.summaryNoEmployees', 'team.page.summaryEmpty'] as const) assert.ok(rows.get(key), `缺 ${key}`)
  assert.ok(rows.get('team.page.eyebrow')!.slice(1).every(value => !/\{[^}]+\}/.test(value)), 'eyebrow 不带占位符')
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

test('目录总数 chip 接线：TeamPage.tsx 在 StaffRoster 之前调用 rosterTotal/rosterHasMultiScope，并用 aria-describedby 关联小字说明', async () => {
  const source = await readFile(new URL('TeamPage.tsx', clientRoot), 'utf8')
  assert.match(source, /import\s*\{\s*rosterTotal,\s*rosterHasMultiScope[^}]*\}\s*from\s*'\.\/team-roster-grouping\.js'/)
  const chipIndex = source.indexOf("t('team.roster.count'")
  const rosterIndex = source.indexOf('<StaffRoster')
  assert.ok(chipIndex > 0 && rosterIndex > chipIndex, '总数 chip 必须渲染在 <StaffRoster/> 之前')
  assert.match(source, /rosterTotal\(rows\)/)
  assert.match(source, /rosterHasMultiScope\(rows,\s*scopeLabels\)/)
  assert.match(source, /aria-describedby=\{rosterHasMultiScope\(rows,\s*scopeLabels\)\s*\?\s*'team-roster-count-note'\s*:\s*undefined\}/)
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

test('分区副标题按 BusinessScopeLabel.kind 渲染三档人话，「其他」分区不给副标题', () => {
  const mixed: BusinessScopeLabel[] = [
    {scope: 'general', title: '通用工作', kind: 'builtin', loads: 0, activeLoads: 0, tasks: 0, groups: 0},
    {scope: 'SOC', title: '安全运营', kind: 'domain', loads: 0, activeLoads: 0, tasks: 0, groups: 0},
    {scope: 'legacy-ops', title: '老运维', kind: 'legacy', loads: 0, activeLoads: 0, tasks: 0, groups: 0},
  ]
  const markup = render({roles: [role('a', ['general']), role('b', ['SOC']), role('c', ['legacy-ops']), role('d', ['Design'])], labels: mixed})
  assert.match(markup, /内置员工/)
  assert.match(markup, /来自行业模板/)
  assert.match(markup, /历史范围/)
  assert.match(markup, /其他/)
  assert.equal(markup.match(/内置员工/g)!.length, 1, '副标题一个分区只出现一次')
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

test('搜索态分区头用 aria-disabled 而不是 disabled，仍可聚焦', () => {
  const markup = render({roles, searching: true})
  assert.match(markup, /aria-disabled="true"/)
  assert.doesNotMatch(markup, /<button[^>]*class="groupHead"[^>]*disabled=""/)
})
