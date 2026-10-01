import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {MESSAGE_KEYS, catalogs, translateMessage} from '../lib/types/client/i18n/messages.js'

/**
 * UI 定型基线：2026-09-19 与用户核对完的选型（公开黄金 fixtures/ui-freeze-baseline.json 与
 * design specification「终审收口」节）钉死在这份守卫里，
 * 防止后续开发把已经定稿的一级导航顺序、市场分类、业务范围页头、分身称呼或系统黑话悄悄改回去。
 * 逐条断言写明来源，改动这些选型前必须先跟用户对齐、再回来同步这份文件。
 */

const baseline = JSON.parse(await readFile(new URL('./fixtures/ui-freeze-baseline.json', import.meta.url), 'utf8'))
const clientRoot = new URL('../src/client/', import.meta.url)
const read = (name: string) => readFile(new URL(name, clientRoot), 'utf8')

test('导航按日常工作、团队与业务、资源排序，设置固定底部', async () => {
  const source = await read('WorkNavigation.tsx')
  const navMatch = source.match(/const primaryNavigation=\[([\s\S]*?)\]\s*as const/)
  assert.ok(navMatch)
  const ids = [...(navMatch?.[1] ?? '').matchAll(/\['([a-z]+)'/g)].map(row => row[1])
  assert.deepEqual(ids, ['home','attention','messages','tasks','projects','plans','team','spaces','resources','capabilities','market'])
  const footer=source.slice(source.indexOf('<div className={css.navFooter}>'))
  assert.match(footer,/navigation.v2.settings/)
  assert.doesNotMatch(footer,/navigation.tasks|navigation.capabilities|navigation.v2.library|navigation.v2.market|navigation.v2.other/)
  assert.ok(source.indexOf('<div className={css.navScroll}>')<source.indexOf('<nav '),'所有导航内容能在短窗口中滚动')
})

test('zh-CN 的 navigation.capabilities 恒为「能力」', () => {
  assert.equal(catalogs['zh-CN']['navigation.capabilities'], '能力')
})

test('navigation.capabilities 与 teamCapability.title 十一列逐字相同', () => {
  const locales = ['zh-CN', 'zh-Hant', 'en', 'ja', 'ko', 'vi', 'es', 'fr', 'de', 'pt'] as const
  for (const locale of locales) {
    assert.equal(
      catalogs[locale]['navigation.capabilities'],
      catalogs[locale]['teamCapability.title'],
      `${locale} 列 navigation.capabilities 与 teamCapability.title 不一致`,
    )
  }
})

test('zh-CN 词表扫描：系统黑话（工作空间/单空间/尚未加载/内容待读取/项资源）只剩一条版本边界说明的白名单', () => {
  const forbidden = /工作空间|单空间|尚未加载|内容待读取|项资源/
  // 白名单只放「个人版 / 专业版·企业版功能边界」这类必须提到工作空间概念本身的文案，并注明理由；
  // 其余命中一律直接改词条（本次审计已把另外 33 条命中改写，详见 edition.ts / market-page.ts /
  // market-industry.ts / market-installations.ts / business-page.ts / knowledge-document.ts /
  // workspace-search.ts / artifact-knowledge-secondary.ts / zh-CN.ts 的对应改动）。
  const whitelist: Record<string, string> = {
    'edition.gate.body': '这条解释的是个人版与专业版/企业版之间「单工作空间 vs 多工作空间」的版本能力边界本身，' +
      '“工作空间”在此是被解释的概念，不是可替换的系统黑话，故保留（UI 定型审计 2026-09-19）。',
  }
  const hits = Object.entries(catalogs['zh-CN']).filter(([, value]) => forbidden.test(String(value)))
  for (const [key, value] of hits) assert.ok(key in whitelist, `${key} => ${String(value)} 未在白名单里，请直接改词条或补充白名单理由`)
  assert.deepEqual(hits.map(([key]) => key).sort(), Object.keys(whitelist).sort())
})

test('已删除的孤儿键 navigation.v2.today 不再登记在 MESSAGE_KEYS 或 zh-CN 词典里', () => {
  assert.ok(!MESSAGE_KEYS.includes('navigation.v2.today' as never))
  assert.ok(!('navigation.v2.today' in catalogs['zh-CN']))
})

// IndustryLoadForm 走真实 React + 真实 zh-CN 翻译渲染（和 team-roster-i18n.test.ts 同一手法），
// 用来断言真正显示给用户的文案，而不是断言源码字符串或桩 t() 回显的 key 名。
registerHooks({
  resolve: (specifier, context, next) => specifier.endsWith('.module.css') ? {url: new URL(specifier, context.parentURL).href, shortCircuit: true} : next(specifier, context),
  load: (url, context, next) => url.endsWith('.module.css') ? {format: 'module', shortCircuit: true, source: 'export default new Proxy({},{get:(_,key)=>String(key)})'} : next(url, context),
})
const {IndustryLoadForm} = await import('../lib/types/client/IndustryLoadForm.js')
const {I18nProvider} = await import('../lib/types/client/i18n/provider.js')

test('IndustryLoadForm 真实渲染的中文静态文案不含「工作空间/范围/单空间」', () => {
  const zh = (key: string, params?: Record<string, string | number>) => translateMessage('zh-CN', key as never, params)
  const runtime = {t: zh, subscribe: () => () => {}, getSnapshot: () => ({locale: 'zh-CN' as const, dshLocale: 'zh', revision: 1})}
  const contentId = '22222222-2222-4222-8222-222222222222', contentHash = 'a'.repeat(64)
  const item = {
    id: 'directory-' + contentHash,
    title: '调查行业模板',
    summary: '模板摘要',
    contentStorage: {contentId, loaded: true},
    manifest: {format: 'teloa.business-package/v2', domain: 'research', scope: 'research', resources: [{kind: 'role'}, {kind: 'knowledge'}]},
  }
  const space = {id: '11111111-1111-4111-8111-111111111111', name: '我的工作空间', description: '', version: 4, kind: 'personal', createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z'}
  const render = () => renderToStaticMarkup(createElement(I18nProvider, {runtime: runtime as never}, createElement(IndustryLoadForm as never, {
    item, space, pending: undefined, recoveryError: undefined, load: async () => {}, recover: async () => {},
  })))
  const markup = render()
  assert.doesNotMatch(markup, /工作空间|范围|单空间/)
})

test('市场分类数组恒为 industry/dashboard/agent/skill/connector/model/knowledge/work-template/plugin，且「已添加」是独立页签', async () => {
  const {MARKET_CATEGORIES} = await import('../lib/types/client/market-home-presentation.js')
  assert.deepEqual(MARKET_CATEGORIES, ['industry', 'dashboard', 'agent', 'skill', 'connector', 'model', 'knowledge', 'work-template', 'plugin'])
  const source = await read('MarketPage.tsx')
  assert.match(source, /t\('market\.solution\.addedTab'/, '「已添加」页签必须用 market.solution.addedTab 这个独立键')
  assert.doesNotMatch(source, /市场\.单项|market\.tab\.single|market\.solution\.single/, '不应该出现单项/single 这类页签键命名')
})

test('BusinessPage 无页签条；抽出的更多菜单仍是原生 details 并挂在范围摘要条', async () => {
  const [source,menu] = await Promise.all([read('BusinessPage.tsx'),read('BusinessMoreMenu.tsx')])
  assert.doesNotMatch(source, /role="tablist"/)
  const header = source.slice(source.indexOf('<header className={css.pageHeader}'), source.indexOf('<section className={css.scopeBar}'))
  assert.doesNotMatch(header, /aria-current="page"/)
  assert.match(source, /<BusinessMoreMenu scope=\{target\.scope\} choose=\{chooseMore\}\/>/)
  assert.match(menu, /<details[^>]*className=\{css\.scopeMore\}[^>]*>/, '更多菜单必须仍是原生 <details>，不是页签条')
})

test('分身称呼已定型：twinDisplayName(\'Max\') 恒为「Max 的分身」，navigation.twin 的 zh-CN 恒为「我的分身」', async () => {
  const {twinDisplayName} = await import('../lib/types/client/team-presentation.js')
  assert.equal(twinDisplayName('Max'), 'Max 的分身')
  assert.equal(catalogs['zh-CN']['navigation.twin'], '我的分身')
})

test('个人版界面不渲染空间名：市场产品页的「看看它带进来什么」按业务范围说话，不拼 load.space.name',async()=>{
  // 个人版只有一个空间，后端把它固定叫「我的工作空间」（packages/backend/src/work/business-spaces.ts）；用户 2026-09-16 裁定个人版界面不出现该字样，所以任何页面都不得把空间名拼进文案。
  const market=await read('MarketPage.tsx')
  assert.doesNotMatch(market,/\.space\.name\b/)
  assert.match(market,/scopeNames\[load\.space\.scope\]/)
})

// 业务结构七行分类法（design specification）定稿：
// 市场包、业务卡摘要、业务范围内页三处只读 packages/client/ui-workbench/src/client/industry-composition.ts
// 这一份共享模块，顺序、标签、措辞逐字相同；公开黄金钉死定稿值，原型镜像在 test:prototype 单独核对。

test('COMPOSITION_ROWS 七行 id 顺序恒为 staff/skill/knowledge/source/board/method/extension，zh-CN 主标签逐字恒定', async () => {
  const {COMPOSITION_ROWS} = await import('../lib/types/client/industry-composition.js')
  assert.deepEqual(COMPOSITION_ROWS.map(row => row.id), baseline.compositionRows.map((row: {id: string}) => row.id))
  const expectedLabels = Object.fromEntries(baseline.compositionRows.map((row: {id: string; label: string}) => [row.id, row.label]))
  for (const row of COMPOSITION_ROWS) {
    assert.equal(catalogs['zh-CN'][row.label], expectedLabels[row.id], `${row.id} 行的 zh-CN 主标签应逐字为「${expectedLabels[row.id]}」`)
  }
})

test('SolutionCards / MarketPage / BusinessHome / BusinessPage 只读共享的七行分类模块，不各写一份行标签、不沿用旧市场分组键', async () => {
  for (const file of ['SolutionCards.tsx', 'MarketPage.tsx', 'BusinessHome.tsx', 'BusinessPage.tsx']) {
    const source = await read(file)
    assert.match(source, /import\s+.*from\s+'\.\/industry-composition/, `${file} 必须从共享模块 ./industry-composition 引入七行分类，不得自写一份`)
    assert.doesNotMatch(source, /market\.solution\.group\./, `${file} 不应再引用工程分层年代的旧市场分组键 market.solution.group.*`)
  }
})

test('zh-CN 词表零「工作模板」：契约 work-template 的用户词汇统一为「任务模板」（design.md 第三节裁定，市场实现回退过的「工作模板」不得再出现）', () => {
  const hits = Object.entries(catalogs['zh-CN']).filter(([, value]) => typeof value === 'string' && value.includes('工作模板'))
  assert.deepEqual(hits, [], `以下 zh-CN 词条仍含「工作模板」，应改为「任务模板」：${JSON.stringify(hits)}`)
})
