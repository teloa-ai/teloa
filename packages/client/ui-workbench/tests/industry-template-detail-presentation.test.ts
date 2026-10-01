import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [market, resources, loadForm, contents, savedDirectory] = await Promise.all([
  readFile(new URL('../src/client/MarketPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/client/IndustryResourceBrowser.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/client/IndustryLoadForm.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/client/IndustryContents.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/client/SavedIndustryDirectory.tsx', import.meta.url), 'utf8'),
])

test('行业模板产品页用「添加后你会得到」取代三栏资源摘要，动作面板仍是切换视图', () => {
  assert.match(market, /<header className=\{css\.solutionHero\} aria-label=\{t\('market\.industry\.overviewAria'\)\}>/)
  assert.match(market, /<h2>\{t\('market\.solution\.youGet'\)\}<\/h2>/)
  assert.match(market, /className=\{css\.youGet\}/)
  assert.match(market, /className=\{css\.actionWorkspace\}/)
  // 「其他使用方式」不再自成一个折叠，两个动作压进唯一的「来源与版本」折叠正文里。
  assert.doesNotMatch(market, /className=\{css\.secondaryActions\}/)
  assert.match(market, /className=\{css\.provenanceBody\}/)
  assert.match(market, /aria-label=\{t\('market\.industry\.otherUsage'\)\}/)
  assert.doesNotMatch(market, /<aside className=\{css\.detailRail\} aria-label=\{t\('market\.industry\.statusActionsAria'\)\}/)
  // 加载面板抽成本机页与官方方案页共用的 SolutionLoadPanel（审查 M1），里面仍是 IndustryLoadForm 的两段式确认
  assert.match(market, /actionPanel==='load'\?<SolutionLoadPanel /)
  assert.match(market, /<IndustryLoadForm embedded item=\{item\}/)
  assert.match(market, /:actionPanel\?<section className=\{css\.actionWorkspace\} aria-label=\{t\('market\.intent\.configurePanelAria'\)\}>[\s\S]*?<IndustryIntentPanel /)
  assert.equal(market.match(/className=\{css\.primaryAction\}/g)?.length,1)
  assert.match(market, /<button type="button" onClick=\{\(\)=>setActionPanel\(null\)\}>.*\{t\('market\.template\.backToContent'\)\}<\/button>/)
})

test('行业资源浏览器提供可选择的目录和默认资源预览', () => {
  assert.match(resources, /selectedId/)
  assert.match(resources, /role="option"/)
  assert.match(resources, /aria-selected=/)
  assert.match(resources, /t\('market\.industry\.browser\.preview'\)/)
  assert.match(resources, /t\('market\.industry\.browser\.selectHelp'\)/)
})

test('工作环境只显示标准落点分类，不重复显示行业资源目录', () => {
  assert.match(resources, /showCategories=true/)
  assert.match(resources, /showCategories&&<div className=\{css\.tree\}/)
  assert.match(resources, /className=\{showCategories\?css\.browser:css\.browserWithoutTree\}/)
  assert.match(resources, /title\?\?\(kind==='all'\?t\('market\.industry\.browser\.allResources'\):kindLabel\(kind\)\)/)
  assert.match(savedDirectory, /<IndustryResourceBrowser[^>]*showCategories=\{false\}/)
  assert.match(savedDirectory, /showCategories=\{false\} title=\{selectedGroup\?\.title\}/)
})

test('加载配置先选目标再确认，不在默认详情堆出完整表单', () => {
  assert.match(loadForm, /stage==='target'/)
  assert.match(loadForm, /stage==='review'/)
  assert.match(loadForm, /t\('market\.industry\.load\.review'\)/)
  assert.match(loadForm, /t\('market\.industry\.load\.back'\)/)
})

test('模板详情直接说明资源加载后的统一正式落点',()=>{
  assert.match(contents,/t\('market\.industry\.destination\.title'\)/)
  assert.match(contents,/industryResourceDestinationGroups/)
  assert.match(contents,/t\('market\.industry\.destination\.aria'\)/)
})
