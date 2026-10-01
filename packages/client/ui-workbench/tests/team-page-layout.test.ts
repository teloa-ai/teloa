import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import type {BusinessScopeLabel} from '../src/client/business-directory.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'
import type {PreviewTask} from '../src/client/task-preview.ts'

// 和 team-roster-i18n.test.ts / team-profile-sections.test.ts 同样的取巧：.tsx 走 tsc 产物，CSS Modules 换成类名代理。
registerHooks({
  resolve: (specifier, context, next) => specifier.endsWith('.module.css') ? {url: new URL(specifier, context.parentURL).href, shortCircuit: true} : next(specifier, context),
  load: (url, context, next) => url.endsWith('.module.css') ? {format: 'module', shortCircuit: true, source: 'export default new Proxy({},{get:(_,key)=>String(key)})'} : next(url, context),
})

const {TeamPage} = await import('../lib/types/client/TeamPage.js')
const {I18nProvider} = await import('../lib/types/client/i18n/provider.js')
const {translateMessage} = await import('../lib/types/client/i18n/messages.js')
const {emptyTaskPreview} = await import('../lib/types/client/task-preview.js')
const {emptyCollaboration} = await import('../lib/types/client/collaboration-preview.js')

const baseline = JSON.parse(await readFile(new URL('./fixtures/ui-freeze-baseline.json', import.meta.url), 'utf8'))
const zh = (key: string, params?: Record<string, string | number>) => translateMessage('zh-CN', key as never, params)
const runtime = {t: zh, subscribe: () => () => {}, getSnapshot: () => ({locale: 'zh-CN' as const, dshLocale: 'zh', revision: 1})}
const noop = () => {}
const noopNode = () => null

const labels: BusinessScopeLabel[] = [{scope: 'general', title: '通用工作', kind: 'builtin', loads: 0, activeLoads: 0, tasks: 0, groups: 0}]
const role: PreviewRole = {
  id: 'role-1', name: '安全分析师', kind: 'employee', scopes: ['general'] as PreviewRole['scopes'], state: 'active', version: 1,
  duty: '负责安全告警的初筛与结论输出。', dataScope: '仅限只读日志', executionScope: '只读与代拟', skills: [], knowledge: [], memories: [], history: [],
}
// `taskNeeds` 非空（need:'approval'）才会被 rosterCounts 计进 waiting。
const task: PreviewTask = {
  id: 'task-1', title: '复核高危告警', goal: '给出处置结论', scope: 'general' as PreviewTask['scope'], object: '', version: 1, state: 'waiting',
  need: 'approval', request: '', authorId: 'self', assigneeId: 'role-1', assigneeHistory: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  result: '', evidence: [], history: [], supplements: [], approvalRequired: true, risk: {key: 'task.risk.none'} as PreviewTask['risk'], execution: 'not_started',
}

// persistence 缺省时目录走示例沙盒模式（exampleDirectoryMode(false)），所以这里的岗位不带 storage:'persistent'。
const render = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(I18nProvider, {runtime: runtime as never}, createElement(TeamPage as never, {
  work: {}, resourceApi: {}, conversations: noopNode, visible: true,
  state: {...emptyTaskPreview(), roles: [role]}, collaboration: emptyCollaboration(),
  selected: null, select: noop, change: noop, examples: noop, openTask: noop, openGroup: noop, resources: noop, nativeSettings: noop,
  capabilities: noopNode, plans: noopNode, scopeLabels: labels, ...props,
} as never)))

test('非嵌入且未选中：一页全宽名单，没有目录栏 aside、没有空详情落地页', () => {
  const markup = render()
  // 两栏结构的两个标志：aside 目录栏与右侧的空详情落地页，都不该再出现。
  assert.doesNotMatch(markup, /<aside/)
  assert.doesNotMatch(markup, /data-teloa-pane="detail"/)
  assert.doesNotMatch(markup, new RegExp(zh('team.landingTitle')))
  assert.match(markup, /<h1>员工<\/h1>/)
  assert.match(markup, new RegExp(zh('team.page.eyebrow')))
})

test('非嵌入且未选中：页头副标题区分暂无待办、有待办和等你处理', () => {
  assert.match(render(), /1 位员工在岗，暂无待办/)
  const second = {...role, id: 'role-2', name: '值班员'}
  const idle = {...role, id: 'role-3', name: '观察员'}
  const twin = {...role, id: 'self-twin', name: '我的分身', kind: 'twin' as const}
  const busyTasks = [
    {...task, id: 'busy-1', state: 'running' as const, need: null, approvalRequired: false},
    {...task, id: 'busy-2', state: 'running' as const, need: null, approvalRequired: false, assigneeId: second.id},
  ]
  const busyMarkup = render({state: {...emptyTaskPreview(), roles: [role, second, idle, twin], tasks: busyTasks}})
  assert.match(busyMarkup, /3 位员工在岗，2 位有待办/)
  assert.doesNotMatch(busyMarkup, /暂无待办/)
  // 暂停只是不接新任务且仍可聊天，但不算「在岗」；与业务首页保持 active 口径。
  assert.match(render({state: {...emptyTaskPreview(), roles: [role, {...role, id: 'role-2', name: '值班员', state: 'paused'}, {...role, id: 'role-3', name: '老同事', state: 'retired'}]}}), /1 位员工在岗/)
})

test('默认分身不冒充在岗数字员工，名单状态明确写默认分身', () => {
  const twin = {...role, id: 'self-twin', name: '我的分身', kind: 'twin' as const}
  const markup = render({state: {...emptyTaskPreview(), roles: [twin]}})
  assert.match(markup, /默认分身已就位，还没有在岗员工/)
  assert.match(markup, /data-roster-status="twin"/)
  assert.match(markup, />默认分身</)
  assert.doesNotMatch(markup, /1 位员工在岗/)
})

test('零员工且目录里没有分身时，不宣称默认分身已就位',()=>{
  const markup=render({state:{...emptyTaskPreview(),roles:[]}})
  assert.match(markup,/还没有在岗员工/)
  assert.doesNotMatch(markup,/默认分身已就位/)
})

test('页头「件事在等你」全局去重：跨两个范围的同事，他名下的一件待办只数一次', () => {
  const twoScopes: BusinessScopeLabel[] = [
    {scope: 'general', title: '通用工作', kind: 'builtin', loads: 0, activeLoads: 0, tasks: 0, groups: 0},
    {scope: 'SOC', title: '安全运营', kind: 'builtin', loads: 0, activeLoads: 0, tasks: 0, groups: 0},
  ]
  const crossScope = {...role, scopes: ['general', 'SOC'] as PreviewRole['scopes']}
  const markup = render({
    scopeLabels: twoScopes,
    state: {...emptyTaskPreview(), roles: [crossScope], tasks: [task]},
  })
  // 按分区求和会得到 2；这里必须是 1。
  assert.match(markup, /1 位员工在岗，1 件事在等你/)
  // 同一位同事确实在两个分区里各出现一次（所以这条守卫真的在挡重复计数，而不是分区本身没生效）。
  assert.equal((markup.match(/data-teloa-entry="role-1"/g) ?? []).length, 2)
})

test('旧筛选记忆里界面不再暴露的状态档折叠回「全部」，名单不被静默过滤', () => {
  const markup = render({navigation: {state: {category: JSON.stringify({status: 'retired', kind: 'all'})}, change: noop}})
  assert.match(markup, /data-teloa-entry="role-1"/)
  assert.match(markup, new RegExp(`aria-pressed="true">${zh('team.page.statusPill.all')}`))
  assert.equal((markup.match(/aria-pressed="true"/g) ?? []).length, 1)
})

test('focusScope 透传给 StaffRoster：被聚焦的分区强制展开', () => {
  // 七个人超过 ROSTER_FOLD_LIMIT=6，默认折叠；只有 focusScope 命中时才展开。
  const many = Array.from({length: 7}, (_, index) => ({...role, id: `role-${index}`, name: `同事${index}`}))
  const state = {...emptyTaskPreview(), roles: many}
  assert.doesNotMatch(render({state}), /data-teloa-entry=/)
  assert.match(render({state, focusScope: 'general'}), /data-teloa-entry=/)
})

test('非嵌入且未选中：状态胶囊三档（全部/正在忙/暂停），全部用 aria-pressed', () => {
  const markup = render()
  assert.equal((markup.match(/aria-pressed=/g) ?? []).length, 3)
  // 第三档是筛选档专用的「暂停」，不是行尾状态点的「先歇一会」。
  for (const key of ['team.page.statusPill.all', 'team.roster.status.busy', 'team.page.statusPill.paused']) assert.match(markup, new RegExp(`aria-pressed="(?:true|false)">${zh(key)}<`), key)
  // 身份筛选（数字员工/分身）已从界面撤掉，team.filter.* 三条词条在孤儿清理二期一并删除；
  // 上一行「恰好三个 aria-pressed」即是它不会回来的回归守卫。
})

test('非嵌入且已选中：整页只剩个人主页，不再渲染分区头', () => {
  const markup = render({selected: 'role-1'})
  assert.match(markup, /data-teloa-pane="detail"/)
  // 分区头的两个标志：aria-controls 指向 staff-roster-* 折叠面板，以及成员行的 data-teloa-entry。
  assert.doesNotMatch(markup, /aria-controls="staff-roster-/)
  assert.doesNotMatch(markup, /data-teloa-entry=/)
  assert.doesNotMatch(markup, /<h1>员工<\/h1>/)
  assert.match(markup, new RegExp(zh('team.detail.back')))
})

test('沙盒数字员工只能预览，不能进入正式会话或渲染关联管理',()=>{
  let talks=0,conversationPanels=0
  const markup=render({
    selected:'role-1',
    talk:async()=>{talks++;return true},
    conversations:()=>{conversationPanels++;return createElement('div',null,'关联管理')},
  })
  assert.match(markup,/<button[^>]*class="identityPrimary"[^>]*disabled=""[^>]*>找它说话<\/button>/)
  assert.match(markup,/这是预览身份，保存为员工后才能开始会话。/)
  assert.equal(talks,0)
  assert.equal(conversationPanels,0)
})

test('沙盒分身同样只预览，不接入账号分身的正式会话',()=>{
  let conversationPanels=0
  const twin={...role,id:'preview-twin',name:'预览分身',kind:'twin' as const}
  const markup=render({
    state:{...emptyTaskPreview(),roles:[twin]},selected:twin.id,
    talk:async()=>{throw Error('不应调用')},
    conversations:()=>{conversationPanels++;return createElement('div',null,'关联管理')},
  })
  assert.match(markup,/<button[^>]*class="chatToggle"[^>]*disabled=""[^>]*>找它说话<\/button>/)
  assert.match(markup,/这是预览身份，保存为员工后才能开始会话。/)
  assert.equal(conversationPanels,0)
})

test('嵌入态：结构与现状一致，只有详情，没有全宽页头', () => {
  const markup = render({embedded: true, selected: 'role-1'})
  assert.match(markup, /data-teloa-pane="detail"/)
  assert.doesNotMatch(markup, /<h1>员工<\/h1>/)
  assert.doesNotMatch(markup, /data-teloa-pane="directory"/)
})

// 终审 T1：公开设计黄金保留定稿的搜索占位，原型同步在 test:prototype 核对。
test('搜索占位与公开设计黄金逐字一致，十列词条全部换掉旧文案', () => {
  const expected = baseline.teamSearch
  assert.equal(zh('team.search'), expected)
  assert.match(render(), new RegExp(`placeholder="${expected}"`))
  const locales = ['zh-CN', 'zh-Hant', 'en', 'ja', 'ko', 'vi', 'es', 'fr', 'de', 'pt']
  for (const locale of locales) {
    const text = translateMessage(locale as never, 'team.search' as never)
    assert.ok(text && !/岗位、职责|responsibilities, or skills/.test(text), `${locale} 仍是旧占位：${text}`)
  }
})

test('正式同事页面的窄屏搜索与状态操作至少保留 44px 命中区', async () => {
  const formal = await readFile(new URL('../src/client/TeamPage.module.css', import.meta.url), 'utf8')
  assert.match(formal, /@media\(max-width:760px\)\{[\s\S]*?\.rosterSearch\{[^}]*min-height:44px/)
  assert.match(formal, /@media\(max-width:760px\)\{[\s\S]*?\.teamPage \.rosterSearchClear\{[^}]*width:44px[^}]*height:44px[^}]*min-height:44px/)
  assert.match(formal, /@media\(max-width:760px\)\{[\s\S]*?\.teamPage \.statusPills button\{[^}]*min-height:44px/)
})
