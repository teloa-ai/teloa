import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {marketEntryKinds} from '@teloa/contract'
import {MARKET_CATEGORIES, marketCategoryKind, visibleMarketCategories, restoredMarketCategory, localizedMarketItemCopy, marketCatalogItemCopy, marketCategoryOf, marketItemPresentation, marketResourcePresentation, marketScopeOptions, showMarketGuide} from '../src/client/market-home-presentation.ts'
import {filterMarket, type MarketItem} from '../src/client/market-preview.ts'
import {translateMessage} from '../lib/types/client/i18n/messages.js'
import {MAIN_LOCALES} from '../lib/types/client/i18n/locale.js'

const item=(id:string,kind:MarketItem['kind'],extra:Partial<MarketItem>={}):MarketItem=>({id,kind,title:id,version:'1.0.0',scope:'general',visibility:'public',summary:'说明',requirements:[],output:'结果',author:'作者',license:'许可',source:{kind:'builtin'},owner:'Teloa',compatibility:'待核对',components:[],...extra})

test('市场资源呈现层随产品语言切换名称与摘要，其他语言回退英文',()=>{
  const resource=item('knowledge','resource',{title:'团队知识',summary:'有来源和读取边界的知识。',localized:{title:{original:'团队知识',defaultLocale:'en',locales:{'zh-CN':'团队知识',en:'Team knowledge'}},summary:{original:'有来源和读取边界的知识。',defaultLocale:'en',locales:{'zh-CN':'有来源和读取边界的知识。',en:'Knowledge with clear sources and access boundaries.'}}}})
  assert.deepEqual(localizedMarketItemCopy(resource,'zh-CN'),{title:'团队知识',summary:'有来源和读取边界的知识。'})
  assert.deepEqual(localizedMarketItemCopy(resource,'en'),{title:'Team knowledge',summary:'Knowledge with clear sources and access boundaries.'})
  assert.deepEqual(localizedMarketItemCopy(resource,'ja'),{title:'Team knowledge',summary:'Knowledge with clear sources and access boundaries.'})
})

test('本机固定内容边界从每张目录卡摘要收为目录级状态，普通摘要保持原文',()=>{
 const zhFixed=item('zh-fixed','skill',{summary:'本机固定内容，仅用于展示结构，不表示外部连接已就绪。用于关联同一事件的日志与资产。'})
 assert.deepEqual(marketCatalogItemCopy(zhFixed,'zh-CN'),{title:'zh-fixed',summary:'用于关联同一事件的日志与资产。',localFixed:true})
 const enFixed=item('en-fixed','skill',{summary:'fallback',localized:{summary:{original:'fallback',defaultLocale:'en',locales:{en:'Local fixed content for structural display only; it does not indicate that external connections are ready. Correlates logs and assets.'}}}})
 assert.deepEqual(marketCatalogItemCopy(enFixed,'en'),{title:'en-fixed',summary:'Correlates logs and assets.',localFixed:true})
 assert.deepEqual(marketCatalogItemCopy(item('normal','skill',{summary:'可核对的技能说明。'}),'zh-CN'),{title:'normal',summary:'可核对的技能说明。',localFixed:false})
})

test('市场范围筛选只列实际目录范围，常用范围优先且不制造 security 或 Design',()=>{
 const scopes=marketScopeOptions([
  item('custom','skill',{scope:'Finance'}),item('appsec','skill',{scope:'AppSec'}),item('soc','skill',{scope:'SOC'}),
  item('general','skill',{scope:'general'}),item('duplicate','skill',{scope:'SOC'}),
 ])
 assert.deepEqual(scopes,['general','SOC','AppSec','Finance'])
 assert.ok(!scopes.includes('security'))
 assert.ok(!scopes.includes('Design'))
})

test('市场搜索匹配当前语言实际显示的标题与摘要',()=>{
  const resource=item('knowledge','resource',{title:'团队知识',summary:'有来源和读取边界的知识。',localized:{title:{original:'团队知识',defaultLocale:'en',locales:{'zh-CN':'团队知识',en:'Team knowledge'}},summary:{original:'有来源和读取边界的知识。',defaultLocale:'en',locales:{'zh-CN':'有来源和读取边界的知识。',en:'Knowledge with clear sources and access boundaries.'}}}})
  const filter=(query:string)=>filterMarket([resource],{kind:'all',scope:'all',visibility:'all',query,searchValues:row=>Object.values(localizedMarketItemCopy(row,'de'))})
  assert.deepEqual(filter('Team knowledge').map(row=>row.id),['knowledge'])
  assert.deepEqual(filter('团队知识').map(row=>row.id),['knowledge'],'切换语言后仍可用资源原名查找')
})

test('市场 metadata 的台湾与香港地区默认回退繁体且绝不回退简体',()=>{
  const resource=item('knowledge','resource',{title:'稳定原文',summary:'稳定说明',localized:{
    title:{original:'稳定原文',defaultLocale:'en',locales:{'zh-CN':'简体标题','zh-Hant':'繁體標題',en:'English title'}},
    summary:{original:'稳定说明',defaultLocale:'en',locales:{'zh-CN':'简体说明','zh-Hant':'繁體說明',en:'English summary'}},
  }})
  assert.deepEqual(localizedMarketItemCopy(resource,'zh-TW'),{title:'繁體標題',summary:'繁體說明'})
  assert.deepEqual(localizedMarketItemCopy(resource,'zh-HK'),{title:'繁體標題',summary:'繁體說明'})
  const withoutTraditional=item('english-fallback','resource',{title:'稳定原文',summary:'稳定说明',localized:{
    title:{original:'稳定原文',defaultLocale:'zh-CN',locales:{'zh-CN':'简体标题',en:'English title'}},
    summary:{original:'稳定说明',defaultLocale:'zh-CN',locales:{'zh-CN':'简体说明',en:'English summary'}},
  }})
  assert.deepEqual(localizedMarketItemCopy(withoutTraditional,'zh-TW'),{title:'English title',summary:'English summary'})
})

test('市场反向引用沿用与目录和详情相同的 locale metadata fallback',async()=>{
  const presentation=await import('../src/client/market-home-presentation.ts')
  const localizedMarketResourceUseTitle=Reflect.get(presentation,'localizedMarketResourceUseTitle') as undefined|((use:unknown,locale:string)=>string)
  assert.equal(typeof localizedMarketResourceUseTitle,'function')
  const use={templateId:'industry',templateTitle:'稳定原文',industry:'general',resourceId:'skill',localizedTitle:{original:'稳定原文',defaultLocale:'en',locales:{'zh-CN':'简体标题','zh-Hant':'繁體標題',en:'English title'}}}
  assert.equal(localizedMarketResourceUseTitle!(use,'zh-TW'),'繁體標題')
  assert.equal(localizedMarketResourceUseTitle!(use,'ja'),'English title')
})

test('行业导入、引用选择和 技能版本选择均使用 locale metadata 标题',async()=>{
  const [loadForm,discovery,references,forms,upgrade]=await Promise.all([
    readFile(new URL('../src/client/IndustryLoadForm.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/IndustryDiscoveryList.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/IndustryReferences.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/MarketForms.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/SkillUpgradePanel.tsx',import.meta.url),'utf8'),
  ])
  assert.match(loadForm,/localizedMarketItemCopy\(item,locale\)/)
  assert.doesNotMatch(loadForm,/>\{item\.title\}<\/dd>/)
  assert.match(discovery,/localizedMarketItemCopy\(item,locale\)/)
  assert.doesNotMatch(discovery,/title:item\.title/)
  assert.match(references,/localizedMarketItemCopy\(sourceItem,locale\)\.title/)
  assert.doesNotMatch(references,/sourceItemId\)\?\.title/)
  assert.match(forms,/localizedMarketItemCopy\(row\.item,locale\)\.title/)
  assert.match(upgrade,/localizedMarketItemCopy\(item,locale\)\.title/)
  assert.doesNotMatch(upgrade,/chosen\?chosen\.title/)
})

test('市场一级分类明确区分行业方案、原子资源和工作模板',()=>{
  assert.deepEqual(MARKET_CATEGORIES,['industry','dashboard','agent','skill','connector','model','knowledge','work-template','plugin'])
  assert.equal(marketCategoryOf(item('industry','bundle')),'industry')
  assert.equal(marketCategoryOf(item('agent','role')),'agent')
  assert.equal(marketCategoryOf(item('skill','skill')),'skill')
  assert.equal(marketCategoryOf(item('plugin','resource',{resourceKind:'plugin'})),'plugin')
  assert.equal(marketCategoryOf(item('mcp','resource',{resourceKind:'mcp'})),'connector')
  assert.equal(marketCategoryOf(item('knowledge','resource',{resourceKind:'knowledge'})),'knowledge')
  assert.equal(marketCategoryOf(item('work','template')),'work-template')
})


test('目录卡明确给出类型、范围、来源、状态和唯一主动作',()=>{
  assert.deepEqual(marketItemPresentation(item('knowledge','resource',{resourceKind:'knowledge',scope:'SOC'}),[]),{
    category:'knowledge',type:'knowledge',scope:'SOC',source:'Teloa 内置示例',ecosystem:'Teloa 生态',runtime:'由 Teloa 管理与绑定',status:'绑定状态待核对',action:'查看并绑定',
  })
  const loaded=item('industry','bundle',{manifest:{format:'teloa.business-package/v2',id:'industry',title:'行业',version:'1.0.0',domain:'security',scope:'SOC',description:'说明',resources:[],relations:[],entrypoints:[]}})
  assert.equal(marketItemPresentation(loaded,[{contentId:'different',templateId:'industry'}]).status,'已加载到工作空间')
})

test('公共原子资源目录如实解释来源、适用范围和下一动作',()=>{
  const skill=item('skill-report','skill',{scope:'SOC'})
  assert.deepEqual(marketResourcePresentation({visibility:'public',owner:'Teloa',key:'skill',id:'skill-report',version:'1.0.0',kind:'skill',title:'研究简报',itemId:'skill-report',capabilities:['写作'],uses:[{templateId:'security',templateTitle:'安全运营方案',industry:'SOC',resourceId:'skill-report'}],status:'catalogued'},skill),{
    type:'技能',scope:'SOC',source:'Teloa 内置示例',ecosystem:'Teloa 生态',runtime:'由 Teloa 管理与绑定',status:'安装状态待核对',action:'查看并安装',
  })
  assert.deepEqual(marketResourcePresentation({visibility:'unknown',owner:'unknown',key:'mcp',id:'mcp',version:'1.0.0',kind:'mcp',title:'连接',capabilities:[],uses:[{templateId:'security',templateTitle:'安全运营方案',industry:'SOC',resourceId:'mcp'}],status:'reference'}),{
    type:'MCP',scope:'SOC',source:'安全运营方案中的公共引用',ecosystem:'归属待核对',runtime:'运行归属待核对',status:'尚未取得独立资源内容',action:'查看引用位置',
  })
})

test('市场插件在没有真实生命周期观测时不猜测安装状态',()=>{
 const plugin=item('dsh-visualize','resource',{resourceKind:'plugin',owner:'DSH',source:{kind:'github',url:'https://github.com/Nagi-ovo/dsh-visualize',revision:'9667c0e9cf0ea463b9b45b2845de62da34fd918a'}})
 assert.deepEqual(marketItemPresentation(plugin,[]),{
  category:'plugin',type:'plugin',scope:'通用',source:'https://github.com/Nagi-ovo/dsh-visualize · 9667c0e9cf0ea463b9b45b2845de62da34fd918a',ecosystem:'DSH 生态',runtime:'由 DSH 安装并运行',status:'状态未核验',action:'查看并安装',
 })
 assert.deepEqual(marketResourcePresentation({visibility:'public',owner:'DSH',key:'plugin',id:'dsh-visualize',version:'0.1.2',kind:'plugin',title:'dsh-visualize',itemId:'dsh-visualize',capabilities:['可视化'],uses:[],status:'catalogued'},plugin),{
  type:'扩展',scope:'通用',source:'https://github.com/Nagi-ovo/dsh-visualize · 9667c0e9cf0ea463b9b45b2845de62da34fd918a',ecosystem:'DSH 生态',runtime:'由 DSH 安装并运行',status:'状态未核验',action:'查看并安装',
 })
})

test('市场顶层直接展示已选定的资源分类，保留搜索和资源运行状态',async()=>{
  const [source,catalog]=await Promise.all([
    readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/MarketResourceCatalog.tsx',import.meta.url),'utf8'),
  ])
  assert.match(source,/t\('market\.home\.heroTitle'\)/)
  assert.match(source,/aria-label=\{t\('market\.search\.aria'\)\}/)
  assert.match(source,/aria-label=\{t\('market\.category\.aria'\)\}/)
  assert.match(source,/const visibleCategories=visibleMarketCategories\(catalogCounts\)/)
  assert.doesNotMatch(source,/market\.solution\.(tabItems|itemType)/)
  // 可见范围标签仍用词典（详情页）；目录列表不再有可见范围下拉
  assert.match(source,/marketVisibilityLabel\(t,/)
  assert.match(source,/setError\(t\('market\.content\.directoryReadFailed'\)\)/)
  assert.doesNotMatch(source,/>\{title\}<\/button>/)
  assert.match(source,/visibleCategories\.map/)
  assert.doesNotMatch(source,/marketVisibility\[item\.visibility\]/)
  // 「推荐 / 已加载 / 最近」三集合与「导入或创建」折叠已经退场：首页就是方案卡，导入与自建各自成一个下拉。
  assert.doesNotMatch(source,/market\.home\.recommendedTitle/)
  assert.doesNotMatch(source,/market\.home\.loadedTitle/)
  assert.doesNotMatch(source,/market\.home\.recentTitle/)
  assert.doesNotMatch(source,/market\.createImport\.menu/)
  assert.match(source,/const solutionCategory=kind==='home'\|\|kind==='industry'/)
  assert.match(source,/const atomicCategory=solutionCategory\|\|kind==='intents'\?'agent':kind/)
  assert.match(source,/const listKind:MarketCategory=solutionCategory\?'industry':atomicCategory/)
  // 方案卡有两处合法投影：首页方案与“已添加”均复用同一组件，不能再各造一套卡片实现。
  assert.equal((source.match(/<SolutionCards /g)??[]).length,2)
  // 方案页签：本机方案卡与官方目录上下分区，外层是区块栈（区块间距统一）
  assert.match(source,/:solutionCategory\?<section className=\{css\.sectionStack\}/)
  assert.match(source,/t\('market\.tool\.import'\)/)
  assert.match(source,/t\('market\.tool\.create'\)/)
  assert.match(source,/resourceKinds=\{resourceKinds\}/)
  assert.match(source,/loadMarketSkillRuntime\(props\.skillInstallApi,props\.skillAvailabilityApi\)/)
  assert.match(source,/runtime=\{runtime\}/)
  assert.match(source,/copy=marketCatalogItemCopy\(item,locale\)/)
  assert.match(catalog,/copy=item\?marketCatalogItemCopy\(item,locale\)/)
  assert.match(catalog,/detailCopy=detailItem\?localizedMarketItemCopy\(detailItem,locale\)/)
  assert.match(catalog,/localizedMarketResourceUseTitle\(use,locale\)/)
  assert.match(catalog,/detailCopy\.summary/)
  assert.match(catalog,/marketResourcePresentation\(row,item,runtime,t\)/)
  assert.match(catalog,/openInstallation/)
  // 适用范围与来源改成行内第二行的「范围 · 来源」；运行归属只留在右侧详情，不再上卡面。
  assert.match(catalog,/\{presentation\.scope\} · \{presentation\.source\}/)
  assert.match(catalog,/t\('market\.catalog\.scope'\)\}: \{detailPresentation\.scope\}/)
  assert.doesNotMatch(catalog,/t\('market\.catalog\.runtime'\)/)
  assert.match(catalog,/aria-label=\{t\('market\.catalog\.ecosystem'\)\}/)
  assert.match(catalog,/owner:ecosystem/)
})

test('C1 页头：eyebrow 是那句人话，<h1> 是「市场」，右上是「已添加 · N」徽标，副标题退场',async()=>{
  const source=await readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8')
  const header=source.slice(source.indexOf('<header className={css.pageHeader}>'),source.indexOf('</header>'))
  assert.match(header,/<span className=\{css\.eyebrow\}>\{t\('market\.home\.heroTitle'\)\}<\/span>/)
  assert.match(header,/<h1>\{t\('market\.title'\)\}<\/h1>/)
  assert.match(header,/t\('market\.addedCount',\{count:addedCount\}\)/)
  assert.doesNotMatch(header,/market\.home\.heroDescription/)
  assert.doesNotMatch(header,/market\.installation\.title/)
  // 同名「已添加」徽标与页签进入同一目录，安装维护在目录内明确命名。
  assert.match(header,/className=\{css\.addedBadge\} onClick=\{\(\)=>selectKind\('intents'\)\}/)
  const addedDirectory=source.slice(source.indexOf("kind==='intents'?<section"),source.indexOf(':solutionCategory?<section'))
  assert.match(addedDirectory,/onClick=\{\(\)=>props\.installations\.open\(\)\}>\{t\('market\.installation\.title'\)\}/)
  assert.match(addedDirectory,/market\.solution\.addedDescription/)
  assert.match(source,/const currentCatalog=currentSolutionCatalog\(state\.items\)/)
  assert.match(source,/const addedSolutions=currentCatalog\.filter\(item=>marketCategoryOf\(item\)==='industry'&&solutionInstalled\(item,props\.industryLoads\.loads\)\)/)
  // 计数与目录共用去重后的当前版本目录，历史版本不能再次出现在卡片或数量里。
  assert.match(source,/const addedCount=solutionInstalledCount\(currentCatalog,props\.industryLoads\.loads\)/)
})

test('方案和方案内原子资源共用当前版本目录，历史版本不重复进入资源库',async()=>{
  const source=await readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8')
  assert.match(source,/const currentCatalog=currentSolutionCatalog\(state\.items\)/)
  assert.equal((source.match(/marketResourceIndex\(currentCatalog\)/g)??[]).length,4,'选择、打开、返回与本机条目计数都必须在当前版本目录里解析')
  assert.match(source,/<MarketResourceCatalog[^>]+items=\{currentCatalog\}/)
  assert.doesNotMatch(source,/<MarketResourceCatalog[^>]+items=\{state\.items\}/)
})

test('通用目录卡：状态句换成 StateMark 记号，「{type} · {ecosystem}」那行删掉，适用范围与来源保留',async()=>{
  const source=await readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8')
  const cards=source.slice(source.indexOf('function MarketCards('),source.indexOf('function MarketCatalog('))
  assert.doesNotMatch(cards,/\{display\.type\} · \{display\.ecosystem\}/)
  assert.doesNotMatch(cards,/display\.status/)
  // 记号只有一个口径：marketItemMark。技能与扩展必须吃到实测运行状态，不能被写死成「可添加」。
  assert.match(cards,/<StateMark mark=\{marketItemMark\(item,loads,runtime\)\} t=\{t\}\/>/)
  assert.doesNotMatch(cards,/restartRequired:false/)
  // 适用范围与来源收进行内第二行「范围 · 来源」，两个标签词与 dt 一起退场。
  assert.match(cards,/<span className=\{css\.resourceFacts\}>\{display\.scope\} · \{display\.source\}<\/span>/)
  assert.doesNotMatch(cards,/<dt>/)
})

test('顶部分类直接切换，窄屏目录也始终可切换类型',async()=>{
  const [source,css]=await Promise.all([
    readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8'),
    readFile(new URL('../src/client/MarketPage.module.css',import.meta.url),'utf8'),
  ])
  const nav=source.match(/<nav className=\{css\.categories\} aria-label=\{t\('market\.category\.aria'\)\}>([\s\S]*?)<\/nav>/)?.[1]
  assert.ok(nav,'核对市场分类导航自身，而非其他目录的按钮')
  assert.match(nav,/visibleCategories\.map\(category=><button/)
  assert.match(nav,/category==='industry'\?solutionCategory:kind===category/)
  assert.match(nav,/onClick=\{\(\)=>selectKind\(category\)\}/)
  assert.match(nav,/marketCategoryLabel\(t,category\)/)
  assert.match(nav,/selectKind\('intents'\)/)
  assert.doesNotMatch(nav,/<select|tabItems/)
  assert.doesNotMatch(source,/market\.solution\.itemType/)
  // 分类列表和资源详情仍分层；仅资源详情可以收起顶部分类。
  assert.match(source,/const mobileLayer:MarketPageNavigationState\['mobileLayer'\]=item\|\|inlineSelectedId\?'detail':solutionView\?'category':'list'/)
  assert.doesNotMatch(css,/\[data-mobile-layer=list\] \.categories/)
  assert.doesNotMatch(css,/\[data-mobile-layer=category\] \.categories\{display:grid/)
  assert.match(css,/\.categories\{[^}]*overflow-x:auto/)
  assert.match(source,/className=\{css\.categoryViewport\}/)
  assert.match(source,/className=\{css\.categoryScrollHint\} aria-hidden="true"/)
  assert.match(css,/@media\(max-width:740px\)[\s\S]*\.categoryScrollHint\{[^}]*display:flex/)
  assert.match(css,/@media\(max-width:740px\)[\s\S]*\.categoryViewport\{[^}]*max-width:100%[^}]*overflow:hidden/)
  assert.match(css,/@media\(max-width:740px\)[\s\S]*\.categoryViewport \.categories[^}]*scrollbar-width:thin/)
  assert.match(source,/const showGuide=showMarketGuide\(\{hasItem:!!item,itemId,intentId,kind,solutionView\}\)/)
})

test('市场目录只呈现一次本机固定内容边界；任务模板页不再有范围下拉，改为两排行业 / 功能筛选',async()=>{
 const source=await readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8')
 assert.equal((source.match(/market\.catalog\.localFixedBoundary/g)??[]).length,1)
 // 只看当前页签实际列出的本机条目（行为见 market-layout.test.ts）
 assert.match(source,/const hasLocalFixedContent=!inDetail&&kind!=='intents'&&tabLocalItems\.some\(item=>marketCatalogItemCopy\(item,locale\)\.localFixed\)/)
 assert.match(source,/<MarketFilterBar rows=\{rows\} tags=\{marketItemTaxonomy\} filter=\{templateTaxonomy\}/)
 assert.doesNotMatch(source,/market\.filter\.scopeAria/)
 assert.doesNotMatch(source,/<option value="security">/)
 assert.doesNotMatch(source,/<option value="Design">/)
})

test('引导块只在首页且非方案卡落地时出现：skill/resource/connector/work-template/intents 等其余页签一律不挂',()=>{
  const base={hasItem:false,itemId:null,intentId:null,solutionView:false} as const
  assert.equal(showMarketGuide({...base,kind:'home'}),true,'首页无搜索词以外的空态显示引导块')
  for(const kind of ['agent','skill','connector','knowledge','work-template','plugin','industry','intents'] as const){
    assert.equal(showMarketGuide({...base,kind}),false,`${kind} 页签不挂引导块`)
  }
  assert.equal(showMarketGuide({...base,kind:'home',solutionView:true}),false,'home 无搜索词时是 solutionLanding，不挂引导块')
  assert.equal(showMarketGuide({...base,kind:'industry',solutionView:true}),false,'方案卡落地态不挂引导块')
  assert.equal(showMarketGuide({hasItem:true,itemId:null,intentId:null,kind:'home',solutionView:false}),false,'已选中条目时不挂引导块')
  assert.equal(showMarketGuide({hasItem:false,itemId:'item-1',intentId:null,kind:'home',solutionView:false}),false,'itemId 存在时不挂引导块')
  assert.equal(showMarketGuide({hasItem:false,itemId:null,intentId:'intent-1',kind:'home',solutionView:false}),false,'intentId 存在时不挂引导块')
})

test('A1：应用类别导航中五个目录 kind 的相对顺序等于 marketEntryKinds',()=>{
 const kinds=MARKET_CATEGORIES.map(category=>marketCategoryKind[category]).filter((kind):kind is NonNullable<typeof kind>=>kind!==undefined)
 assert.deepEqual(kinds,[...marketEntryKinds])
})

test('五个 kind 的类别文案 10 语言齐全，zh-CN 无禁词',()=>{
 for(const category of ['industry','agent','skill','connector','model'] as const)for(const locale of MAIN_LOCALES){
  const label=translateMessage(locale,`market.presentation.category.${category}` as never)
  assert.ok(label&&!label.startsWith('market.'),`${locale} ${category}`)
  if(locale==='zh-CN')assert.doesNotMatch(label,/工作空间|单空间|实例|投影|尚未加载|内容待读取|\d+\s*项资源|人类/)
 }
 assert.equal(translateMessage('zh-CN','market.presentation.category.model' as never),'模型')
 assert.equal(translateMessage('en','market.presentation.category.model' as never),'Models')
})

test('catalogSkippedHint：只有 newerApp>0 才给出提示条数，unknownKind 不显示',async()=>{
 // 组件模块引用 .module.css：与 market-catalog-section.test.ts 同法桩掉样式再导入纯函数
 registerHooks({
  resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
  load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default {}'}:next(url,context),
 })
 const {catalogSkippedHint}=await import('../lib/types/client/MarketCatalogSection.js') as {catalogSkippedHint:(skipped:{unknownKind:number;newerApp:number})=>number|null}
 assert.equal(catalogSkippedHint({unknownKind:5,newerApp:0}),null)
 assert.equal(catalogSkippedHint({unknownKind:0,newerApp:3}),3)
 assert.equal(catalogSkippedHint({unknownKind:2,newerApp:1}),1)
})

test('按官方目录 counts 隐藏空类型：model 只在目录有模型条目时出现，其余类别不受影响',()=>{
  const counts=(model:number)=>({dashboard:0,solution:0,role:0,skill:0,connector:0,model})
  assert.deepEqual(visibleMarketCategories(undefined),MARKET_CATEGORIES.filter(category=>category!=='model'))
  assert.deepEqual(visibleMarketCategories(counts(0)),MARKET_CATEGORIES.filter(category=>category!=='model'))
  assert.deepEqual(visibleMarketCategories(counts(2)),[...MARKET_CATEGORIES])
})

test('功能验证 审查：导航恢复到 model 但目录模型计数为 0 时回退首页；counts 未就绪或其他类别不动',()=>{
  const counts=(model:number)=>({dashboard:0,solution:0,role:0,skill:0,connector:0,model})
  assert.equal(restoredMarketCategory('model',counts(0)),'home')
  assert.equal(restoredMarketCategory('model',counts(3)),'model')
  assert.equal(restoredMarketCategory('model',undefined),'model')
  assert.equal(restoredMarketCategory('skill',counts(0)),'skill')
})

test('功能验证 审查：有目录区块的页面类别计数取自 onCounts 回传；list({limit:1}) 只在无区块页面补取一次（行为见 market-resource-navigation）',async()=>{
  const source=await readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8')
  assert.equal(source.match(/list\(\{limit:1\}\)/g)?.length,1)
  assert.match(source,/if\(!visible\|\|!api\|\|catalogCounts\|\|catalogSectionShown\)return/)
  const sections=source.match(/<MarketCatalogSection /g)?.length??0
  // 各类型页签共用一个 officialSection（kinds 随页签），另有连接页「查看目录条目」一处
  assert.ok(sections>=2);assert.equal(source.match(/api=\{props\.marketCatalogApi\} onCounts=\{setCatalogCounts\} /g)?.length,sections)
  assert.match(source,/restoredMarketCategory\(kind,catalogCounts\)/)
})

test('MarketCatalog 的 Hook 全部在提前 return 之前（visible 切换不得触发 React #310）',async()=>{
  const source=await readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8')
  const body=source.slice(source.indexOf('function MarketCatalog('),source.indexOf('\nfunction ',source.indexOf('function MarketCatalog(')+1))
  const firstReturn=body.indexOf('if(!visible)return null')
  assert.ok(firstReturn>0)
  assert.doesNotMatch(body.slice(firstReturn),/\buse(Effect|State|Ref|Memo|Callback)\(/)
})
