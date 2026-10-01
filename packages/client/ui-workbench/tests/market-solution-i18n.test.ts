import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {MARKET_SOLUTION_MESSAGE_ROWS} from '../src/client/i18n/locales/market-solution.ts'
import {MARKET_INDUSTRY_MESSAGE_ROWS} from '../src/client/i18n/locales/market-industry.ts'
import {MARKET_PAGE_MESSAGE_ROWS} from '../src/client/i18n/locales/market-page.ts'
import {MESSAGE_KEYS} from '../lib/types/client/i18n/messages.js'
import {chineseUiLiterals} from './i18n-ast.ts'

const clientRoot = new URL('../src/client/', import.meta.url)
const locales = ['zh-CN', 'zh-Hant', 'en', 'ja', 'ko', 'vi', 'es', 'fr', 'de', 'pt'] as const

test('market-solution.ts 十一列齐全、每列非空、占位符跨列一致', () => {
  assert.ok(MARKET_SOLUTION_MESSAGE_ROWS.length >= 17)
  for (const row of MARKET_SOLUTION_MESSAGE_ROWS) {
    assert.equal(row.length, locales.length + 1, row[0])
    for (const [index, locale] of locales.entries()) assert.ok(row[index + 1]?.trim(), `${row[0]}: ${locale}`)
    const placeholders = [...(row[3]?.match(/\{[^}]+\}/g) ?? [])].sort()
    for (const [index] of locales.slice(3).entries()) assert.deepEqual([...(row[index + 4]?.match(/\{[^}]+\}/g) ?? [])].sort(), placeholders, `${row[0]}: ${locales[index + 3]} placeholders`)
  }
})

test('market-solution.ts 的键在并入 core-pages.ts 之后与 MESSAGE_KEYS 里其余键零重复', () => {
  const solutionKeys = MARKET_SOLUTION_MESSAGE_ROWS.map(row => row[0])
  const others = MESSAGE_KEYS.filter(key => !solutionKeys.includes(key as never))
  const dup = solutionKeys.filter(key => others.includes(key as never))
  assert.deepEqual(dup, [])
  assert.equal(new Set(MESSAGE_KEYS).size, MESSAGE_KEYS.length, 'MESSAGE_KEYS 整体不得有重复键')
})

test('MarketPage.tsx / SolutionCards.tsx 引用的 market.solution.* 键全部在词表登记', async () => {
  const files = ['MarketPage.tsx', 'SolutionCards.tsx']
  const registered: Set<string> = new Set(MARKET_SOLUTION_MESSAGE_ROWS.map(row => row[0]))
  for (const file of files) {
    const source = await readFile(new URL(file, clientRoot), 'utf8')
    for (const key of [...source.matchAll(/market\.solution\.[a-zA-Z0-9.]+/g)].map(match => match[0])) {
      assert.ok(registered.has(key), `调用了但未登记: ${key}`)
    }
  }
})

test('旧的六组词条整套退场：分组名、分组说明、分组计数与「分别添加」都不留键，也无人再引用', async () => {
  const orphans = ['staff', 'skill', 'connect', 'work', 'knowledge', 'business']
    .flatMap(group => ['market.solution.group.' + group, 'market.solution.description.' + group, 'market.solution.groupCount.' + group])
    .concat(['market.solution.composition.teamCapabilities', 'market.solution.composition.businessLedger', 'market.solution.composition.complete',
      'market.solution.composition.teamCapabilitiesDescription', 'market.solution.composition.businessLedgerDescription', 'market.solution.composition.completeDescription',
      'market.solution.workTemplate', 'market.solution.plan'])
  for (const key of orphans) {
    assert.ok(!MARKET_SOLUTION_MESSAGE_ROWS.some(row => (row[0] as string) === key), `market-solution.ts 仍留着孤儿键 ${key}`)
    assert.ok(!MESSAGE_KEYS.includes(key as never), `MESSAGE_KEYS 仍留着孤儿键 ${key}`)
  }
  for (const file of ['MarketPage.tsx', 'SolutionCards.tsx']) {
    const source = await readFile(new URL(file, clientRoot), 'utf8')
    assert.doesNotMatch(source, /SolutionCompositionNote|solutionGroupCounts|SOLUTION_GROUP_KINDS/, file + ' 仍在用旧六组')
  }
})

test('市场卡「包含」与产品页七行读同一个共享模块，顺序由 COMPOSITION_ROWS 决定', async () => {
  const cards = await readFile(new URL('SolutionCards.tsx', clientRoot), 'utf8')
  const page = await readFile(new URL('MarketPage.tsx', clientRoot), 'utf8')
  assert.match(cards, /compositionSummary\(composeFromManifest\(manifest\)/)
  assert.match(page, /composeFromManifest\(manifest\)/)
  assert.match(page, /COMPOSITION_ROWS\.find\(value=>value\.id===row\.id\)/)
  // 七行的标签、副标、单位、模式词与附注一律走词条键；组件里不留任何行业名或对象类型名。
  for (const source of [cards, page]) assert.doesNotMatch(source, /SOC|AppSec|告警|资产|Splunk/)
})

test('SolutionCards.tsx 固定界面文案全部来自词典，无裸中文字面量', async () => {
  const source = await readFile(new URL('SolutionCards.tsx', clientRoot), 'utf8')
  assert.match(source, /useI18n\(/)
  assert.deepEqual(chineseUiLiterals(source, 'SolutionCards.tsx'), [])
})

test('市场工具行里搜索框旁有「问一问」按钮，走产品页同一条 props.prepare 路径', async () => {
  const source = await readFile(new URL('MarketPage.tsx', clientRoot), 'utf8')
  const registered: Set<string> = new Set(MARKET_SOLUTION_MESSAGE_ROWS.map(row => row[0]))
  for (const key of ['market.solution.ask', 'market.solution.askDraft', 'market.solution.askDraftEmpty']) assert.ok(registered.has(key), `缺 ${key}`)
  // 按钮紧挨着全局搜索框，同一条工具行里；工具行整体排在页签之下。
  assert.ok(source.indexOf('<nav className={css.categories}') < source.indexOf('className={css.toolRow}'), '工具行必须排在页签之下')
  const row = source.slice(source.indexOf('className={css.toolRow}'), source.indexOf('className={css.toolMenu}'))
  assert.match(row, /css\.globalSearch/)
  assert.match(row, /t\('market\.solution\.ask'\)/)
  // 搜索词有无决定用哪条草稿，最终都交给既有的 props.prepare，不新起端点。
  assert.match(source, /trimmed\?t\('market\.solution\.askDraft',\{query:trimmed\}\):t\('market\.solution\.askDraftEmpty'\)/)
  assert.match(source, /props\.prepare\(target,draft\)/)
})

test('问一问的两条草稿都带上人话提问，占位符只出现在带搜索词的那条', () => {
  const draft = MARKET_SOLUTION_MESSAGE_ROWS.find(row => row[0] === 'market.solution.askDraft')!
  const empty = MARKET_SOLUTION_MESSAGE_ROWS.find(row => row[0] === 'market.solution.askDraftEmpty')!
  assert.equal(draft[1], '我想找一个能帮我做 {query} 的方案，有推荐吗？')
  assert.equal(empty[1], '我想找一个适合我的方案，有推荐吗？')
  assert.ok(draft.slice(1).every(value => value.includes('{query}')), 'askDraft 十列都要带 {query}')
  assert.ok(empty.slice(1).every(value => !/\{[^}]+\}/.test(value)), 'askDraftEmpty 不带占位符')
})

test('market-industry.ts 分类导航七行改值后仍是十一列，且顺序与人话名对上规格 §5.1', () => {
  const order = ['industry', 'agent', 'skill', 'connector', 'knowledge', 'work-template', 'plugin']
  const expectZh = ['方案', '员工', '技能', '连接', '资料', '任务模板', '扩展']
  for (const [index, id] of order.entries()) {
    const row = MARKET_INDUSTRY_MESSAGE_ROWS.find(candidate => candidate[0] === 'market.presentation.category.' + id)!
    assert.ok(row, id)
    assert.equal(row.length, 11, id)
    assert.ok(row.slice(1).every(value => value.trim()), id)
    assert.equal(row[1], expectZh[index], id)
  }
})

test('market-page.ts 就地改值与新增的词条仍是十一列', () => {
  for (const key of ['market.home.heroTitle', 'market.search.placeholder', 'market.industry.loadWorkspace', 'market.title', 'market.addedCount', 'market.tool.import', 'market.tool.create']) {
    const row = MARKET_PAGE_MESSAGE_ROWS.find(candidate => candidate[0] === key)!
    assert.ok(row, key)
    assert.equal(row.length, 11, key)
    assert.ok(row.slice(1).every(value => value.trim()), key)
  }
})

test('孤儿键 market.intent.countPrefix 已删除，且全仓无残留引用', async () => {
  assert.ok(!MARKET_PAGE_MESSAGE_ROWS.some(row => (row[0] as string) === 'market.intent.countPrefix'))
  assert.ok(!MESSAGE_KEYS.includes('market.intent.countPrefix' as never))
})

test('C1 页头与工具行的新词条齐全：标题「市场」、徽标「已添加 · N」、两个下拉入口', () => {
  const rows = new Map(MARKET_PAGE_MESSAGE_ROWS.map(row => [row[0] as string, row]))
  assert.equal(rows.get('market.title')![1], '市场')
  assert.equal(rows.get('market.addedCount')![1], '已添加 · {count}')
  assert.equal(rows.get('market.tool.import')![1], '导入')
  assert.equal(rows.get('market.tool.create')![1], '自己做一个')
  // 徽标的计数占位符十列都要在，否则某些语言会丢掉数字。
  assert.ok(rows.get('market.addedCount')!.slice(1).every(value => value.includes('{count}')), 'market.addedCount 十列都要带 {count}')
})

test('方案卡「包含：{list}」十一列齐全，占位符每列都在', () => {
  const row = MARKET_SOLUTION_MESSAGE_ROWS.find(candidate => candidate[0] === 'market.solution.contains')!
  assert.ok(row, '缺 market.solution.contains')
  assert.equal(row.length, 11)
  assert.equal(row[1], '包含：{list}')
  assert.ok(row.slice(1).every(value => value.includes('{list}')), 'market.solution.contains 十列都要带 {list}')
})

test('C1 改版腾出来的九条孤儿键已从词表与 MESSAGE_KEYS 里删干净', () => {
  // 页头副标题、旧 eyebrow、「导入或创建」折叠、首页三集合的标题与说明——落点都没了，键也不留。
  const orphans = ['market.eyebrow', 'market.home.heroDescription', 'market.createImport.menu',
    'market.home.recommendedTitle', 'market.home.recommendedDescription',
    'market.home.loadedTitle', 'market.home.loadedDescription',
    'market.home.recentTitle', 'market.home.recentDescription']
  for (const key of orphans) {
    assert.ok(!MARKET_PAGE_MESSAGE_ROWS.some(row => (row[0] as string) === key), `market-page.ts 仍留着孤儿键 ${key}`)
    assert.ok(!MESSAGE_KEYS.includes(key as never), `MESSAGE_KEYS 仍留着孤儿键 ${key}`)
  }
  // 「团队能力」按钮虽退场，这条键在 SavedIndustryDirectory.tsx 仍有落点，不得误删。
  assert.ok(MARKET_PAGE_MESSAGE_ROWS.some(row => (row[0] as string) === 'market.teamCapabilities'))
})
