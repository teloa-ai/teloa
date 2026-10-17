import './employee-asset-test-loader.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import type {BusinessScopeLabel} from '../src/client/business-directory.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'

// 与 team-page-layout.test.ts 同一取巧：.tsx 走 tsc 产物，CSS Modules 换成类名代理。
registerHooks({
  resolve: (specifier, context, next) => specifier.endsWith('.module.css') ? {url: new URL(specifier, context.parentURL).href, shortCircuit: true} : next(specifier, context),
  load: (url, context, next) => url.endsWith('.module.css') ? {format: 'module', shortCircuit: true, source: 'export default new Proxy({},{get:(_,key)=>String(key)})'} : next(url, context),
})

const {TeamPage} = await import('../lib/types/client/TeamPage.js')
const {rosterShowsRetired} = await import('../lib/types/client/team-roster-grouping.js')
const {I18nProvider} = await import('../lib/types/client/i18n/provider.js')
const {translateMessage} = await import('../lib/types/client/i18n/messages.js')
const {emptyTaskPreview} = await import('../lib/types/client/task-preview.js')
const {emptyCollaboration} = await import('../lib/types/client/collaboration-preview.js')

const zh = (key: string, params?: Record<string, string | number>) => translateMessage('zh-CN', key as never, params)
const runtime = {t: zh, subscribe: () => () => {}, getSnapshot: () => ({locale: 'zh-CN' as const, dshLocale: 'zh', revision: 1})}
const noop = () => {}
const noopNode = () => null
const labels: BusinessScopeLabel[] = [{scope: 'general', title: '通用工作', kind: 'builtin', loads: 0, activeLoads: 0, tasks: 0, groups: 0}]
const base: PreviewRole = {
  id: 'role-active', name: '安全分析师', kind: 'employee', scopes: ['general'] as PreviewRole['scopes'], state: 'active', version: 1,
  duty: '负责安全告警的初筛与结论输出。', dataScope: '仅限只读日志', executionScope: '只读与代拟', skills: [], knowledge: [], memories: [], history: [],
}
const paused: PreviewRole = {...base, id: 'role-paused', name: '值班员', state: 'paused'}
const retired: PreviewRole = {...base, id: 'role-retired', name: '旧验收员工', state: 'retired', retirementReason: '示例已退役'} as PreviewRole
const roles = [base, paused, retired]
const render = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(I18nProvider, {runtime: runtime as never}, createElement(TeamPage as never, {
  work: {}, resourceApi: {}, conversations: noopNode, visible: true,
  state: {...emptyTaskPreview(), roles}, collaboration: emptyCollaboration(),
  selected: null, select: noop, change: noop, examples: noop, openTask: noop, openGroup: noop, resources: noop, nativeSettings: noop,
  capabilities: noopNode, plans: noopNode, scopeLabels: labels, ...props,
} as never)))
const pills = (markup: string) => [zh('team.page.statusPill.all'), zh('team.roster.status.busy'), zh('team.page.statusPill.paused')].every(label => markup.includes(`>${label}</button>`))

test('默认「全部」只列 active/paused，退役员工不进普通名单，但保留查看入口', () => {
  const markup = render()
  assert.match(markup, /安全分析师/)
  assert.match(markup, /值班员/)
  assert.doesNotMatch(markup, /旧验收员工/)
  assert.ok(pills(markup), '三个状态胶囊保持不变')
  assert.match(markup, /data-roster-retired-toggle/)
  assert.match(markup, new RegExp(zh('team.page.retired.show', {count: 1}).replace(/[()（）]/g, '.')))
  assert.match(markup, /aria-pressed="false"[^>]*data-roster-retired-toggle|data-roster-retired-toggle[^>]*aria-pressed="false"/)
  // 没有退役员工时不出现这个入口。
  assert.doesNotMatch(render({state: {...emptyTaskPreview(), roles: [base, paused]}}), /data-roster-retired-toggle/)
})

test('搜索旧名字仍能找到退役员工', () => {
  const markup = render({navigation: {state: {query: '旧验收'}, change: noop}})
  assert.match(markup, /旧验收员工/)
  assert.doesNotMatch(markup, /安全分析师/)
})

test('旧 deep link 直接打开退役档案：详情与历史入口不丢', () => {
  const markup = render({selected: retired.id})
  assert.match(markup, /旧验收员工/)
  assert.match(markup, /示例已退役/)
  assert.match(markup, new RegExp(zh('team.profile.action.history')))
})

test('「暂停」胶囊仍按 role.state 精确筛选，不受退役入口影响', () => {
  const markup = render({navigation: {state: {category: JSON.stringify({status: 'paused', kind: 'all', business: 'all', sort: 'name'})}, change: noop}})
  assert.match(markup, /值班员/)
  assert.doesNotMatch(markup, /安全分析师/)
  assert.doesNotMatch(markup, /旧验收员工/)
})

test('显式显示退役后进入名单；关闭后按默认规则隐藏', () => {
  const view = {searching: false, showRetired: false, selected: null}
  assert.equal(rosterShowsRetired(retired, view), false)
  assert.equal(rosterShowsRetired(base, view), true)
  assert.equal(rosterShowsRetired(paused, view), true)
  assert.equal(rosterShowsRetired(retired, {...view, showRetired: true}), true)
  assert.equal(rosterShowsRetired(retired, {...view, searching: true}), true)
  assert.equal(rosterShowsRetired(retired, {...view, selected: retired.id}), true)
})
