import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {BUSINESS_PAGE_MESSAGE_ROWS} from '../src/client/i18n/locales/business-page.ts'
import {catalogs} from '../lib/types/client/i18n/messages.js'
import {chineseUiLiterals} from './i18n-ast.ts'

const pageUrl=new URL('../src/client/BusinessPage.tsx',import.meta.url)

test('业务空间页面的固定用户界面文案全部来自语义化国际化词典',async()=>{
  const source=await readFile(pageUrl,'utf8'),menu=await readFile(new URL('../src/client/BusinessMoreMenu.tsx',import.meta.url),'utf8')
  assert.match(source,/useI18n\(/)
  assert.deepEqual(chineseUiLiterals(source),[])
  assert.doesNotMatch(source,/business\.(?:fixedUi|ui\.\d+)/,'不得用通用或编号词条替代不同界面语义')
  assert.doesNotMatch(source,/error\.message/,'不得向界面直接呈现底层异常')
  assert.ok((source.match(/business\.page/g)??[]).length<=3)
  // 文案数量会随职责下沉改变；逐个核对明确调用的键，不能靠数量猜测是否完成国际化。
  const keys=[...source.matchAll(/\bt\(['"](business\.[\w.]+)['"]/g)].map(match=>match[1]!)
  const registered=new Set([...Object.keys(catalogs['zh-CN']),...BUSINESS_PAGE_MESSAGE_ROWS.map(row=>row[0])])
  assert.ok(keys.length>0)
  for(const key of keys)assert.ok(registered.has(key),`未注册业务词条：${key}`)
  assert.deepEqual(chineseUiLiterals(menu),[])
  for(const match of menu.matchAll(/\bt\(['"](business\.[\w.]+)['"]/g))assert.ok(registered.has(match[1]!),`未注册更多菜单词条：${match[1]}`)
})

test('目录、接入引导、概览和行业资源区段使用业务词典键',async()=>{
  const source=await readFile(pageUrl,'utf8')
  // 概览与对象目录已经交给声明台账（BusinessLedger.tsx），这一页只剩接入引导与行业资源两段自己的区块。
  for(const name of ['BusinessConnectionGuide','IndustryResourceDeclarations','IndustryWorkspaceSummary'])assert.match(source,new RegExp(`function ${name}`))
  assert.match(source,/<BusinessLedgerSurface/)
  for(const key of ['business.connection.guideTitle','business.industry.sourceAndPinnedVersion','business.industry.loadedDataSourceDeclarations','business.industry.loadedExecutionToolDeclarations'])assert.match(source,new RegExp(`t\\('${key}'`))
  assert.match(await readFile(new URL('../src/client/BusinessMoreMenu.tsx',import.meta.url),'utf8'),/t\('business\.section\.continuous'\)/)
})

test('业务空间总览先呈现真实状态，模板来源只保留紧凑摘要',async()=>{
  const source=await readFile(pageUrl,'utf8')
  const summary=source.slice(source.indexOf('function IndustryWorkspaceSummary'),source.indexOf('export function BusinessPage'))
  assert.doesNotMatch(summary,/summary\.map\(/,'总览不得再次渲染七个全局资源目录')
  assert.match(summary,/sources\.map\(/,'模板来源仍需保留固定版本摘要')
  assert.match(summary,/onClick=\{manage\}/,'详细资源映射应进入统一管理入口')
 assert.ok(source.indexOf("target.section==='overview'")>=0&&source.indexOf("target.section==='overview'")<source.lastIndexOf('<IndustryWorkspaceSummary'),'真实状态必须排在模板来源之前')
})

test('业务数据连接失败使用当地语言，不直接显示内部错误码',async()=>{
  const source=await readFile(pageUrl,'utf8')
  const guide=source.slice(source.indexOf('function BusinessConnectionGuide'),source.indexOf('function IndustryResourceDeclarations'))
  // 接入引导只说差在哪儿；台账那两档的读取失败由 BusinessLedger 自己的固定文案交代。
  assert.doesNotMatch(guide,/error\.message/)
  // 空态照原型只说一句人话加一个动作：去掉了「当前缺口 / 可读适配器」这类系统词（终审 B6）。
  assert.match(guide,/t\('business\.connection\.kicker'\)/)
  assert.match(guide,/t\('business\.connection\.guideDescription'\)/)
  // 动作文案按 `{noun}` 参数化（B1）：优先使用行业声明的来源名词，缺省时才回落通用「数据源」。
  assert.match(guide,/noun=sourceNoun\?\?t\('business\.source\.noun'\)/)
  assert.match(guide,/onClick=\{connect\}>\{t\('business\.connection\.connect',\{noun\}\)\}/)
  assert.doesNotMatch(guide,/business\.connection\.(?:currentGap|noReadableAdapter|unconfigured|openMarket)|business\.realMode/)
  const ledger=await readFile(new URL('../src/client/BusinessLedger.tsx',import.meta.url),'utf8')
  // 读取失败按错误码选一条固定文案键（`businessLedgerFailureKey`），组件只负责把它翻出来。
  assert.match(ledger,/t\(state\.reason\)/)
  assert.match(ledger,/businessLedgerFailureKey\(error\)/)
  assert.doesNotMatch(ledger,/error\.message/)
  const api=await readFile(new URL('../src/client/business-ledger-api.ts',import.meta.url),'utf8')
  assert.match(api,/'business\.ledger\.readFailed'/)
  assert.doesNotMatch(api,/\.details|'details'|"details"/,'错误的 details 是服务端诊断字段，一处也不读')
})

test('业务台账直接使用行业声明的对象类型名称，不在页面写死行业目录',async()=>{
  const source=await readFile(pageUrl,'utf8')
  assert.doesNotMatch(source,/businessDataSectionKey|dataSectionName/)
  const ledger=await readFile(new URL('../src/client/BusinessLedger.tsx',import.meta.url),'utf8')
  assert.match(ledger,/localizedBusinessObjectType\(definition,locale\)/)
  assert.match(ledger,/ledger\.blocks\.map/)
  const rows:Map<string,readonly string[]>=new Map(BUSINESS_PAGE_MESSAGE_ROWS.map(row=>[row[0],row]))
  // business.section.data.* 与 business.data.title 是页面写死行业目录时代的兜底名称，界面早已不再引用，
  // 孤儿清理二期把这几行连同十一列翻译一起删了；这里只剩下对仍在用的 business.section.data 的用词核对。
  assert.ok(!rows.get('business.section.data')?.slice(1).some(value=>/数据与对象|資料與物件|Data and objects/i.test(value)))
})

test('对象动作入口只采信服务端台账能力位，并把当前范围带入创建请求',async()=>{
  const source=await readFile(pageUrl,'utf8')
  assert.match(source,/businessTaskSupports/,'必须引入范围闸门函数，不能只靠服务端能力位')
  assert.match(source,/businessTaskSupports\(target\.scope,block\)/,'范围和台账能力位必须一起进入入口判据')
})

test('业务词典为繁中、英、日、韩、越等十种语言提供真实翻译',()=>{
  const rows:Map<string,readonly string[]>=new Map(BUSINESS_PAGE_MESSAGE_ROWS.map(row=>[row[0],row]))
  for(const key of ['business.connection.guideTitle','business.industry.sourceAndPinnedVersion','business.industry.loadedDataSourceDeclarations','business.industry.loadedExecutionToolDeclarations']){
    const row=rows.get(key)
    assert.equal(row?.length,11)
    assert.ok(row?.every(value=>value.trim()))
  }
})

test('业务台账首页与范围摘要条的新词条随业务词典注册，十种语言都有真实翻译',async()=>{
  const source=await readFile(pageUrl,'utf8')
  // 范围内页页头这一侧引用的键。
  for(const key of ['business.scope.backHome','business.scope.barAria','business.scope.openFull','business.scope.stat.sources','business.scope.stat.staff','business.scope.stat.automations','business.scope.stat.sourcesValue','business.scope.stat.staffValue','business.scope.stat.automationsValue','business.home.staff'])assert.match(source,new RegExp(`t\\('${key}'`))
  // 去术语化：嵌入态那个按钮不再说「在业务空间打开」（终审 M2）。
  assert.doesNotMatch(source,/business\.workspace\.openFull/)
  const rows:Map<string,readonly string[]>=new Map(BUSINESS_PAGE_MESSAGE_ROWS.map(row=>[row[0],row]))
  const added=['business.home.title','business.home.subtitle','business.home.add','business.home.situation.connected','business.home.situation.none','business.home.situation.connectedNoStaff','business.home.situation.noneNoStaff','business.home.line.connected','business.home.line.none','business.home.noStaff','business.home.waiting','business.home.staff','business.home.connect','business.scope.backHome','business.scope.barAria','business.scope.openFull','business.scope.stat.sources','business.scope.stat.staff','business.scope.stat.automations','business.scope.stat.sourcesValue','business.scope.stat.staffValue','business.scope.stat.automationsValue','business.connection.kicker','business.connection.connect','business.done.eyebrow','business.done.title','business.done.description','business.done.empty.title','business.done.empty.description']
  for(const key of added){
    const row=rows.get(key)
    assert.equal(row?.length,11,key)
    assert.ok(row?.every(value=>value.trim()),key)
  }
  // 带参的三句在每一种语言里都要把占位符原样带上，少一个就少一个数。
  for(const [key,placeholders] of [['business.home.situation.connected',['{sources}','{staff}']],['business.home.situation.none',['{staff}']],['business.home.situation.connectedNoStaff',['{sources}']],['business.home.waiting',['{count}']],['business.scope.stat.sourcesValue',['{n}']],['business.scope.stat.staffValue',['{n}']],['business.scope.stat.automationsValue',['{n}']]] as const)
    for(const value of rows.get(key)!.slice(1))for(const placeholder of placeholders)assert.ok(value.includes(placeholder),key+' / '+value)
})
