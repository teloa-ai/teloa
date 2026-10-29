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
  // 使用动作与资源阅读直接可达；来源折叠只承接来源、版本和治理。
  assert.doesNotMatch(market, /className=\{css\.secondaryActions\}/)
  assert.match(market, /className=\{css\.provenanceBody\}/)
  assert.match(market, /aria-label=\{t\('market\.industry\.otherUsage'\)\}/)
  assert.doesNotMatch(market, /<aside className=\{css\.detailRail\} aria-label=\{t\('market\.industry\.statusActionsAria'\)\}/)
  // 加载面板抽成本机页与官方方案页共用的 SolutionLoadPanel（审查 M1），里面仍是 IndustryLoadForm 的两段式确认
  assert.match(market, /actionPanel==='load'\?<SolutionLoadPanel /)
  assert.match(market, /<IndustryLoadForm embedded item=\{item\}/)
  assert.match(market, /:actionPanel\?<section className=\{css\.actionWorkspace\} aria-label=\{t\('market\.intent\.configurePanelAria'\)\}>[\s\S]*?<IndustryIntentPanel /)
  assert.equal(market.match(/className=\{css\.primaryAction\}/g)?.length,1)
  assert.match(market, /<ToolbarIconButton label=\{t\('market\.template\.backToContent'\)\} icon=\{ArrowLeft\} onClick=\{\(\)=>setActionPanel\(null\)\}\/>/)
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

test('加载只有一屏核对摘要并须显式确认，不在默认详情堆出完整表单', () => {
  // 个人版只有本空间一个目的地：去掉空的「选择位置」步骤后，首屏就是核对摘要。
  assert.match(loadForm, /t\('market\.industry\.load\.review'\)/)
  assert.match(loadForm, /<dt>\{t\('market\.industry\.load\.destination'\)\}<\/dt><dd>\{summary\.target\}<\/dd>/)
  assert.match(loadForm, /<dt>\{t\('market\.industry\.load\.effect'\)\}<\/dt><dd>\{summary\.effect\}<\/dd>/)
  assert.doesNotMatch(loadForm, /\bstage\b|market\.industry\.load\.(back|next|stepLocation|stepReview)|<select|<input|<form/)
  // 首次提交与冲突确认各有一次写入；覆盖重试必须携带原请求和用户确认的知识清单。
  const submit=loadForm.slice(loadForm.indexOf('const submit='),loadForm.indexOf('const confirmKnowledgeReset='))
  const confirm=loadForm.slice(loadForm.indexOf('const confirmKnowledgeReset='),loadForm.indexOf('return <section'))
  assert.equal(loadForm.match(/\bload\(/g)?.length, 2)
  assert.equal(submit.match(/\bload\(input\)/g)?.length, 1)
  assert.match(submit,/knowledgeResetFromError\(reason\)/)
  assert.match(confirm,/if\(!reset\|\|reset\.key!==selection\.current\)return/)
  assert.equal(confirm.match(/\bload\(\{\.\.\.reset\.input,knowledgeResetDigest:reset\.preview\.digest\}\)/g)?.length, 1)
  assert.match(loadForm,/<KnowledgeResetConfirmation preview=\{knowledgeReset\.preview\} busy=\{busy\} confirm=\{\(\)=>void confirmKnowledgeReset\(\)\} cancel=\{\(\)=>setKnowledgeReset\(undefined\)\}/)
  assert.match(loadForm, /onClick=\{\(\)=>void submit\(\)\}>\{busy\?t\('market\.industry\.load\.loading'\):t\('market\.industry\.load\.confirm'\)\}/)
})

test('模板详情直接说明资源加载后的统一正式落点',()=>{
  assert.match(contents,/t\('market\.industry\.destination\.title'\)/)
  assert.match(contents,/industryResourceDestinationGroups/)
  assert.match(contents,/t\('market\.industry\.destination\.aria'\)/)
})
