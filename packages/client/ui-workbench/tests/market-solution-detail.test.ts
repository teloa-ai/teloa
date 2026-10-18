import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// 与本仓库其余 MarketPage.tsx 结构性用例（market-cognition.test.ts、market-detail-i18n.test.ts、
// industry-template-detail-presentation.test.ts）同一套做法：MarketDetail 未导出，且真渲染需要
// 十几个深依赖 prop（industryReview、targets、installations…），这里改用源码顺序扫描核对纵向结构，
// 比强行搭一整套 MarketPage mock 更贴合既有测试基建、也更不容易因无关重构而假阳性。
const market = await readFile(new URL('../src/client/MarketPage.tsx', import.meta.url), 'utf8')

// 加载面板与「看看它带进来什么 · 空间」入口抽成本机页与官方方案页共用的组件（审查 M1、L5），这里取组件源码一并核对。
const sharedComponent = (name: string) => {
 const start = market.indexOf('function ' + name + '(')
 assert.ok(start >= 0, '找不到共用组件：' + name)
 return market.slice(start, market.indexOf('\n}\n', start))
}
const loadPanel = sharedComponent('SolutionLoadPanel')
const loadLinks = sharedComponent('SolutionLoadLinks')

const industryBranch = (() => {
 const start = market.indexOf('if(isIndustryManifest(item.manifest)){')
 assert.ok(start >= 0, '找不到行业模板详情支')
 const end = market.indexOf('\n  }', start)
 return market.slice(start, end)
})()

function order(...markers: string[]) {
 let cursor = -1
 for (const marker of markers) {
  const index = industryBranch.indexOf(marker)
  assert.ok(index >= 0, '找不到标记：' + marker)
  assert.ok(index > cursor, marker + ' 出现的位置早于前一个标记，纵向顺序不对')
  cursor = index
 }
}

test('产品页纵向顺序：回到市场 → hero → 问一问 → 按真实组成分类查看 → 资源与用法 → 来源与版本', () => {
 order(
  "t('market.solution.back')",
  "className={css.solutionHero}",
  '<h1>{copy.title}</h1>',
  '<p>{copy.summary}</p>',
  "t('market.industry.loadWorkspace')",
  "t('market.solution.askFit')",
  "t('market.solution.youGet')",
  '<MarketTemplateDetails sections=',
  "className={css.youGet}",
  "t('market.solution.contents')",
  "t('market.industry.otherUsage')",
  "className={css.provenance}",
  "t('market.solution.provenance')",
  "t('market.template.governance.title')",
 )
})

test('「添加后你会得到」按七行分节，顺序、标签、副标、计数与附注全部读共享模块', () => {
 // 行本身、顺序与空行过滤都来自 composeFromManifest；组件不自己写一份分类，也不自己拼中文。
 assert.match(industryBranch, /const rows=composeFromManifest\(manifest\)/)
 assert.match(industryBranch, /rows\.filter\(row=>row\.count>0\)\.map\(row=>\{/)
 assert.match(industryBranch, /const meta=COMPOSITION_ROWS\.find\(value=>value\.id===row\.id\)!/)
 assert.match(industryBranch, /<h3>\{t\(meta\.label\)\}<em className=\{css\.solutionGroupQuestion\}>\{t\(meta\.question\)\}<\/em>/)
 // 计数文字（含单复数与业务看板配置份数）由共享模块的 compositionCountText 统一给出
 assert.match(industryBranch, /\{compositionCountText\(row,t,number\)\}/)
 // 接入源每条都要说清它是拿数据、能操作还是都能；模式词也只从共享模块的词条读。
 // 读写与官方方案页同一口径（设计约束 4）：按包内连接声明对照官方连接器目录判定只读，判定不了才按资源类型的保守口径。
 assert.match(industryBranch, /const label=row\.id==='source'\?connectorModeLabel\(sourceConnectorMode\(resource,readOnlyConnections\)\?\?\{\},t\):undefined/)
 assert.match(industryBranch, /\{label&&<small className=\{css\.solutionResourceType\}>\{label\}<\/small>\}/)
 // 附注只有两行有：任务模板的自动化与动作分布、扩展的「工作室通用」。
 assert.match(industryBranch, /compositionMethodNote\(row\.detail,t,number\)/)
 assert.match(industryBranch, /t\(COMPOSITION_EXTENSION_NOTE_KEY\)/)
 // 旧的六组分层说明与「分别添加」整套退场。
 assert.doesNotMatch(industryBranch, /SolutionCompositionNote/)
 assert.doesNotMatch(industryBranch, /solutionGroupCounts/)
})

test('七行之后只剩一个页级折叠：来源与版本，且默认收起', () => {
 const groups = industryBranch.indexOf("className={css.youGet}")
 const tail = industryBranch.slice(groups)
 // 原始清单那一段的 <details><summary>查看原始内容</summary> 是块内的长文收纳，不算页级折叠。
 const pageLevel = tail.match(/<details className=\{css\.[A-Za-z]+\}/g) ?? []
 assert.deepEqual(pageLevel, ['<details className={css.provenance}'], '七行之后只应有「来源与版本」一个页级折叠')
 assert.doesNotMatch(industryBranch, /<details className=\{css\.provenance\}\s+open/)
 assert.doesNotMatch(industryBranch, /className=\{css\.secondaryActions\}/)
 assert.doesNotMatch(industryBranch, /className=\{css\.governance\}/)
})

test('产品页版心照原型的 680 单栏', async () => {
 const styles = await readFile(new URL('../src/client/MarketPage.module.css', import.meta.url), 'utf8')
 assert.match(styles, /\.industryDetail\{[^}]*max-width:680px[^}]*margin:0 auto/)
 assert.doesNotMatch(styles, /\.industryDetail\{[^}]*max-width:1200px/)
})

test('必须保留、只是移位：状态句、已加载入口、其他用法两个动作、治理三件套与原始清单全部还在', () => {
 assert.match(industryBranch, /const currentStatus=matchingLoads\.length\?t\('market\.workspace\.loadedPersonal'\)/)
 assert.match(industryBranch, /\{currentStatus\}/)
 assert.match(industryBranch, /<SolutionLoadLinks loads=\{matchingLoads\} manage=\{props\.manageIndustryLoad\}\/>/)
 assert.match(loadLinks, /loads\.map\(load=><button type="button" key=\{load\.id\} onClick=\{\(\)=>manage\(load\.id\)\}>/)
 assert.match(industryBranch, /t\('market\.industry\.otherUsage'\)/)
 assert.match(industryBranch, /\{draft&&<button type="button" aria-label=\{t\('market\.intent\.view'\)\}/)
 assert.match(industryBranch, /aria-label=\{t\('market\.conversation\.use'\)\}/)
 assert.match(industryBranch, /<IndustryReferences item=\{item\} items=\{props\.state\.items\} save=\{props\.saveResolved\}\/>/)
 assert.match(industryBranch, /<IndustryUpdatePreview item=\{item\} items=\{props\.state\.items\} spaces=\{props\.spaces\} \{\.\.\.props\.industryReview\}\/>/)
 assert.match(industryBranch, /<IndustryExport item=\{item\}\/>/)
 assert.match(industryBranch, /\{item\.raw&&<section className=\{css\.sourceSection\}>/)
 assert.match(industryBranch, /SHA-256：\{item\.hash\}/)
})

test('来源与版本块里必须能看到「添加只是加入」的提醒，且提醒落在该折叠区内', () => {
 const provenanceStart = industryBranch.indexOf('className={css.provenance}')
 const bodyStart = industryBranch.indexOf('className={css.provenanceBody}')
 const noticeIndex = industryBranch.indexOf("t('market.solution.provenance.notice')")
 assert.ok(noticeIndex > provenanceStart && noticeIndex < bodyStart, '提醒必须出现在来源与版本折叠区内')
})

test('内容与用法直接可达，来源折叠保留运行环境、治理与核对', () => {
 const body = industryBranch.slice(industryBranch.indexOf('className={css.provenanceBody}'))
 for (const key of ['market.template.sourceRuntimeAria', 'market.template.sourceRuntime.title', 'market.template.governance.title', 'market.template.governance.description']) {
  assert.ok(body.includes("t('" + key + "')"), '折叠块里找不到：' + key)
 }
 assert.doesNotMatch(body, /<IndustryContents|market\.industry\.otherUsage/, '长资源清单和使用动作不再藏进来源说明')
 assert.match(industryBranch, /<IndustryContents manifest=\{manifest\} content=\{item\.packageContent\} persisted=\{!!item\.contentStorage\?\.loaded\}\/>/)
 assert.match(body, /onClick=\{props\.nativeSettings\}/)
})

test('已加载时主按钮显示已添加，原内容仍有待核对申请时保留正规恢复入口', () => {
 assert.match(industryBranch, /disabled=\{!!matchingLoads\.length&&!recoveringCurrentLoad\}[\s\S]{0,80}onClick=\{\(\)=>setActionPanel\('load'\)\}>\{recoveringCurrentLoad\?t\('market\.industry\.load\.reviewResult'\):matchingLoads\.length\?t\('market\.solution\.added'\):t\('market\.industry\.loadWorkspace'\)\}/)
 assert.match(industryBranch, /<SolutionLoadLinks loads=\{matchingLoads\}/)
 assert.match(loadLinks, /t\('market\.solution\.openLoad'\)/)
})

test('同事小卡数量由 solutionMembers 逐个 role 资源生成，与 IndustryContents 的落点计数同源（T6 已单测保证 1:1）', () => {
 assert.match(industryBranch, /const members=solutionMembers\(manifest,locale,manifest\.id\)/)
 assert.match(industryBranch, /\{members\.map\(member=><span key=\{member\.id\}><StaffAvatar initial=\{member\.initial\} seed=\{member\.seed\} size="md"\/><strong>\{member\.title\}<\/strong><\/span>\)\}/)
})

test('一键添加只有一个调用点：只保留一次 setActionPanel(\'load\')，且不直接绕过 IndustryLoadForm 调用 industryLoads.save', () => {
 const calls = industryBranch.match(/setActionPanel\('load'\)/g) ?? []
 assert.equal(calls.length, 1, '只应有一个按钮触发一键添加')
 assert.doesNotMatch(industryBranch, /props\.industryLoads\.save\(/)
 assert.match(industryBranch, /actionPanel==='load'\?<SolutionLoadPanel \{\.\.\.props\} item=\{item\} close=\{\(\)=>setActionPanel\(null\)\}\/>/)
 assert.match(loadPanel, /<IndustryLoadForm embedded item=\{item\}[^>]*load=\{props\.industryLoads\.save\}/, 'IndustryLoadForm 仍应拿到 save 引用，走它自己的显式核对确认')
 assert.doesNotMatch(loadPanel, /props\.industryLoads\.save\(/)
 // 外层只留返回；标题与 eyebrow 只由 IndustryLoadForm 自己显示一次，不再重复。
 assert.doesNotMatch(loadPanel, /market\.industry\.loadEyebrow|<h3>|css\.eyebrow/)
 assert.match(loadPanel, /<ToolbarIconButton label=\{t\('market\.template\.backToContent'\)\} icon=\{ArrowLeft\} onClick=\{close\}\/>/)
 // 放弃草稿与「已放弃」提示随面板走，本机页与官方页都有
 assert.match(loadPanel, /props\.industryLoads\.api\.discard\(\);setLoadDiscarded\(true\)/)
 assert.match(loadPanel, /t\('recovery\.discarded'\)/)
})
