import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {groupCapabilityConnectors} from '../src/client/capability-center-catalog.ts'
import {mount,nodes,marketProps,appsDirectory} from './market-component-harness.ts'

test('市场与我的能力共用一个「市场」侧栏入口，不再出现能力中心，保留资料库',()=>{
 for(const view of ['market']){
  const page=mount('WorkbenchNavigationChrome.tsx')
  const tree=page.render('WorkbenchNavigationItems',{view,onSelect:()=>{}})
  const buttons=nodes(tree).filter(node=>node.type==='button')
  const contains=(node:any,key:string)=>nodes(node).some(n=>n.children.includes(key))
  assert.equal(buttons.filter(node=>contains(node,'market.title')).length,1)
  assert.equal(buttons.some(node=>contains(node,'capabilityCenter.title')||contains(node,'navigation.v2.market')),false)
  assert.equal(buttons.find(node=>contains(node,'market.title'))?.props['aria-current'],'page')
  assert.ok(buttons.some(node=>contains(node,'navigation.v2.library')))
 }
})

test('左栏资源组「市场」与「应用」并列：应用打开同一市场的应用视图，二者高亮互斥',()=>{
 const page=mount('WorkbenchNavigationChrome.tsx')
 const contains=(node:any,key:string)=>nodes(node).some(n=>n.children.includes(key))
 const opened:string[]=[]
 const render=(view:string,marketApps:boolean)=>nodes(page.render('WorkbenchNavigationItems',{view,marketApps,onSelect:(id:string)=>opened.push(id),onApps:()=>opened.push('apps')})).filter(node=>node.type==='button')
 const pick=(buttons:any[],key:string)=>buttons.filter(node=>contains(node,key))
 let buttons=render('market',false)
 assert.equal(pick(buttons,'market.apps.title').length,1);assert.equal(pick(buttons,'market.title').length,1)
 const order=buttons.map(node=>contains(node,'market.title')?'market':contains(node,'market.apps.title')?'apps':contains(node,'navigation.v2.library')?'library':'other').filter(id=>id!=='other')
 assert.deepEqual(order,['library','market','apps'],'资源组顺序：资料、市场、应用')
 assert.equal(pick(buttons,'market.title')[0].props['aria-current'],'page');assert.equal(pick(buttons,'market.apps.title')[0].props['aria-current'],undefined)
 buttons=render('market',true)
 assert.equal(pick(buttons,'market.apps.title')[0].props['aria-current'],'page');assert.equal(pick(buttons,'market.title')[0].props['aria-current'],undefined)
 buttons=render('market',false)
 assert.equal(pick(buttons,'market.title')[0].props['aria-current'],'page','我的资源归属市场「已添加」，左栏仍是市场');assert.equal(pick(buttons,'market.apps.title')[0].props['aria-current'],undefined)
 pick(buttons,'market.apps.title')[0].props.onClick();pick(buttons,'market.title')[0].props.onClick()
 assert.deepEqual(opened,['apps','market'])
 assert.equal(nodes(page.render('WorkbenchNavigationItems',{view:'market',onSelect:()=>{}})).some(node=>contains(node,'market.apps.title')),false,'没有打开端口（访客）时不显示失效入口')
 const work=readFileSync(new URL('../src/client/WorkNavigation.tsx',import.meta.url),'utf8'),frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),store=readFileSync(new URL('../src/client/store.ts',import.meta.url),'utf8')
 assert.match(work,/marketApps=\{marketApps\} onApps=\{\(\)=>actions\.openMarketCategory\('apps'\)\}/,'复用原市场类别请求，不另建执行入口')
 assert.match(frame,/<WorkNavigation marketApps=\{state\.marketMode==='catalog'&&marketNavigation\.category==='apps'\}/)
 assert.match(store,/openMarketCategory\(state,category:MarketCategoryRequest\)/)
 assert.match(store,/export type MarketCategoryRequest=MarketCategory\|'home'\|'apps'\|'intents'/)
})

test('同服务器多项 MCP 工具合并，含下划线服务器名也保留独立身份',()=>{
 const tool=(name:string)=>({key:'source:'+name,rowId:'source',title:name,state:'discovered',origin:{kind:'studio'},go:{kind:'connectors'}} as any)
 const original=[tool('mcp__github__search'),tool('mcp__github__get_issue'),tool('mcp__my_notes__read'),tool('mcp__my_notes__write')]
 const rows=groupCapabilityConnectors(original)
 assert.equal(rows.length,2)
 assert.equal(rows[0]!.title,'GitHub')
 assert.equal(rows[0]!.state,'discovered','发现工具不变为已连接')
 assert.equal(rows[1]!.key,'connector:my_notes')
 assert.equal(rows[1]!.toolKeys?.length,2)
 assert.equal(original[0].key,'source:mcp__github__search','不改共享能力来源')
})

test('图标识别产品自身，不把 Codex 市场来源当作每个技能的 Logo',()=>{
 const page=mount('ResourceIcon.tsx',{'./resource-icon-assets.js':{resourceBrands:{github:'github.svg',codex:'codex.svg'},resourceAvatars:{general:'general.webp'}}})
 assert.equal(page.exported.resourceBrand('codex.research','资料研究'),undefined)
 assert.equal(page.exported.resourceBrand('teloa.github','GitHub'),'github')
 assert.equal(page.exported.resourceBrand('source:mcp__github__search','GitHub'),'github')
})

test('实际工作台把市场、资料库和能力搜索写回导航目录',()=>{
 const frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 for(const directory of ['market','resources','capabilities']){
  // 市场与资料库是 JSX 属性；我的资源经 MarketPage 的 mine 对象传入（`onNavigationChange:next=>…`）
  const source=frame.match(new RegExp("onNavigationChange(?:=\\{|:)next=>(actions\\.rememberDirectory\\('"+directory+"',\\{[^}]+category:[^}]+\\}\\),selectedId:next\\.selectedId\\}\\))[},]"))?.[1]
  assert.ok(source,directory+' 目录回写入口')
  let written:any
  new Function('actions','writeDirectoryFilterCategory','next',source)({rememberDirectory:(name:string,state:any)=>written={name,state}},(value:any)=>JSON.stringify(value),{query:'测试搜索',category:'skill',mobileLayer:'list',selectedId:undefined})
  assert.equal(written.state.query,'测试搜索',directory+' 应保留搜索')
 }
})

test('统一发现首页进入 AI 员工，团队方案只列方案，应用改接统一应用目录；原技能和连接器分类仍限定类型，主入口搜索覆盖原目录',()=>{
 const section=()=>null
 const marketCatalogApi={}
 const render=(navigation:Record<string,unknown>)=>nodes(mount('MarketPage.tsx',{'./MarketCatalogSection.js':{MarketCatalogSection:section}}).render('TestCatalog',{...marketProps(navigation),inCapabilityCenter:true,marketCatalogApi,runtime:{state:'ready',facts:[]}}))
 for(const [category,kinds] of [['home',['role','solution']],['employees',['role','solution']],['teams',['solution','dashboard']],['skill',['skill']],['connector',['connector']]] as const){
  const tree=render({category}),catalog=tree.find(node=>node.type===section)!
  assert.ok(catalog)
  assert.deepEqual(catalog.props.kinds,kinds)
  assert.equal(catalog.props.cardLayout,true)
  assert.equal(tree.some(node=>node.type===appsDirectory),false,category)
  assert.deepEqual(tree.filter(node=>node.type==='h1').map(node=>node.children.join('')),['market.title'],'方案 B 只有市场标题，不再套能力中心标题')
 }
 // 2026-10-14 用户选 B：应用入口是统一应用目录（连接器应用与技能同列、各守已装/已连接状态），不再是只列连接器的官方目录
 assert.equal(render({category:'home'}).some(node=>node.props.className==='appsShortcut'),false,'工作台内应用只在左栏，不在页内重复')
 const appsTree=render({category:'apps'})
 assert.equal(appsTree.some(node=>node.type===section),false)
 assert.equal(appsTree.find(node=>node.type===appsDirectory)!.props.catalogApi,marketCatalogApi)
 // 统一应用目录自带「应用」标题与搜索（见 market-primary-navigation / market-primary.browser），工作台内不再外套市场标题与市场分类
 assert.deepEqual(appsTree.filter(node=>node.type==='h1').map(node=>node.children.join('')),[],'应用目录不再套市场标题')
 assert.equal(appsTree.some(node=>node.type==='nav'&&node.props['aria-label']==='market.category.aria'),false,'应用不重复员工市场的分类')
 const searched=render({category:'employees',query:'研究'})
 assert.equal(searched.find(node=>node.type===section)!.props.kinds,undefined,'主入口搜索不能丢失技能等次级类型')
 assert.equal(searched.some(node=>node.type===appsDirectory),false,'主入口搜索不切到应用目录')
 const appsSearched=render({category:'apps',query:'研究'})
 assert.equal(appsSearched.some(node=>node.type===section),false,'Apps 内搜索不回退到官方目录')
 assert.equal(appsSearched.find(node=>node.type===appsDirectory)!.props.view.query,'研究','Apps 内统一搜索应用与技能')
})

test('市场页头：独立「我的能力」入口退出、已添加进入原目录、创建或导入只有模板和技能导入',()=>{
 const page=mount('MarketPage.tsx',{'./MarketCatalogSection.js':{MarketCatalogSection:()=>null}})
 const tree=nodes(page.render('TestCatalog',{...marketProps({category:'home'}),inCapabilityCenter:true,marketCatalogApi:{},capabilities:()=>{},runtime:{state:'ready',facts:[]}}))
 const header=tree.find(node=>node.type==='header'&&node.props.className==='pageHeader')!
 assert.ok(header,'工作台内也渲染方案 B 页头')
 const inHeader=nodes(header)
 assert.equal(inHeader.some(node=>node.type==='button'&&node.children.includes('capabilityCenter.mineTitle')),false,'页头不再有独立「我的能力」入口')
 assert.equal(inHeader.filter(node=>node.type==='button'&&node.props.className==='addedBadge').length,1)
 const summary=inHeader.find(node=>node.type==='summary')!
 assert.equal(summary.props['aria-label'],'capabilityCenter.createOrImport');assert.equal(summary.props.title,'capabilityCenter.createOrImport')
 assert.equal(inHeader.filter(node=>node.type==='summary').length,1,'创建与导入只有一个入口')
 const menu=inHeader.find(node=>node.type==='details')!
 assert.deepEqual(nodes(menu).filter(node=>node.type==='button').map(node=>node.children.join('')),['market.import.industry','market.import.skill'],'任务模板新建入口已退出')
 assert.equal(tree.some(node=>node.type==='button'&&node.children.includes('market.solution.addedTab')),false,'已添加不在工具行重复')
})

test('已添加只列模板，原能力目录按原选择在应用上下文中访问',()=>{
 const mineCatalog=function TeamCapabilitiesPage(){return null}
 const replacements={'./MarketCatalogSection.js':{MarketCatalogSection:()=>null},'./TeamCapabilitiesPage.js':{TeamCapabilitiesPage:mineCatalog}}
 const mine={work:{},industryLoads:[],industryLoadsReady:true,navigationState:{category:'source',selectedId:'connector:github',mobileLayer:'detail',query:''},onNavigationChange:()=>{},go:()=>{}}
 const added=mount('MarketPage.tsx',replacements)
 const tree=nodes(added.render('TestCatalog',{...marketProps({category:'intents'}),inCapabilityCenter:true,marketCatalogApi:{},capabilities:()=>{},mine,runtime:{state:'ready',facts:[]}}))
 assert.equal(tree.some(node=>node.type===mineCatalog),false,'常用目录不挂载旧四分组管理')
 assert.equal(tree.some(node=>node.type==='section'&&node.props.className==='mineApps'),false)
 const context=mount('MarketPage.tsx',replacements)
 const restored=nodes(context.render('TestCatalog',{...marketProps({category:'resources'}),inCapabilityCenter:true,marketCatalogApi:{},capabilities:()=>{},mine,runtime:{state:'ready',facts:[]}}))
 const catalog=restored.find(node=>node.type===mineCatalog)!
 assert.ok(catalog,'资源深链仍读取原目录')
 assert.equal(catalog.props.contextual,true)
 assert.equal(catalog.props.navigationState,mine.navigationState)
 assert.equal(catalog.props.work,mine.work)
 const apps=restored.find(node=>node.type===appsDirectory)!
 assert.ok(apps);assert.equal(apps.props.view.mine,true)
})

test('真实工作台入口：市场外层不再套能力中心，恢复落点走方案 B，我的能力在面包屑里归属市场',()=>{
 const frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.doesNotMatch(frame,/CapabilityCenterHeader/,'父页不再渲染能力中心标题与我的／发现切换')
 // 只在启动恢复时落回主目录：首次挂载读映射值并把存下的旧类别改写一次，业务配置等主动进入的类别在重挂载时保留
 assert.match(frame,/const marketEntryNavigation=marketStartup\.current\?\{\.\.\.marketNavigation,category:marketEntryCategory\(marketNavigation\.category\)\}:marketNavigation/)
 assert.match(frame,/useEffect\(\(\)=>\{\n   marketStartup\.current=false\n   const saved=readMarketNavigation\(state\.navigationDirectories\.market\?\.category\),entry=marketEntryCategory\(saved\.category\)\n   if\(entry!==saved\.category\)actions\.rememberDirectory\('market',\{category:writeDirectoryFilterCategory\(\{category:entry,mobileLayer:saved\.mobileLayer,appsMine:String\(saved\.appsMine\),appsCategory:saved\.appsCategory\?\?'all'\}\)\}\)\n  \},\[\]\)/)
 assert.match(frame,/<MarketPage [^\n]*navigationState=\{\{\.\.\.marketEntryNavigation,/,'市场挂载读取映射后的恢复落点')
 assert.match(frame,/market:t\('market\.title'\)/);assert.doesNotMatch(frame,/capabilityCenter\.mineTitle/,'独立「我的能力」标题与面包屑已退出')
 assert.doesNotMatch(frame,/state\.view==='capabilities'/)
 assert.doesNotMatch(frame,/<TeamCapabilitiesPage/,'Frame 不再单独挂载独立能力页')
 assert.match(frame,/<MarketPage [^\n]*mine=\{\{skillInstallApi:skillInstallApi,[^\n]*onNavigationChange:next=>actions\.rememberDirectory\('capabilities',/,'我的资源经市场页 mine 属性接入并沿用 capabilities 目录记忆')
 assert.match(frame,/capabilities=\{\(\)=>actions\.openCapabilityCatalog\(\)\}/)
 const market=readFileSync(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8')
 assert.match(market,/onManagePlugins=\{\(\)=>props\.installations\.open\('plugin:directory'\)\}/,'安装恢复经应用页原记录入口访问')
})

test('应用目录取得全局受管连接：根注入逐次核验连接代次，业务连接原样，未就绪业务时回落全局',async()=>{
 const index=readFileSync(new URL('../src/client/index.ts',import.meta.url),'utf8'),frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 const injected=index.match(/inject:\(bound: WorkbenchActions\)=>\{actions=bound;return \{([^\n]+)/)?.[1]??''
 assert.match(injected,/,createBusinessMcpConnection,managedMcpConnectionApi,/,'根注入传入全局受管连接')
 assert.match(index,/const managedMcpConnectionApi=createManagedMcpConnectionApi\(\(endpoint,payload\)=>createGenerationGuardedCall\(\(\)=>connection\.state\.getSnapshot\(\)==='connected'\?connection\.generation\.getSnapshot\(\):undefined,marketCatalogCall\)\(endpoint,payload\)\)/)
 assert.match(index,/const createBusinessMcpConnection=\(namespace:string,token:typeof businessBuilderApi\)=>createManagedMcpConnectionApi\(createGenerationGuardedCall\(\(\)=>connection\.state\.getSnapshot\(\)==='connected'\?connection\.generation\.getSnapshot\(\):undefined,marketCatalogCall,\(\)=>\{const current=businessBuilder\.getSnapshot\(\);return current\.status==='ready'&&current\.namespace===namespace&&current\.api===token\}\)\)/,'业务连接保持本人与业务代次核验')
 assert.match(frame,/const marketMcpConnectionApi=useMemo\(\(\)=>createBusinessMcpConnection&&builderState\.status==='ready'&&builderState\.api&&builderState\.namespace\?createBusinessMcpConnection\(builderState\.namespace,builderState\.api\):managedMcpConnectionApi,/)
 // 逐次核验：断线时拒绝、代次变化后拒绝，正常连接时透传原调用
 const {createGenerationGuardedCall}=await import('../src/client/business-setup-navigation.ts')
 let generation:number|undefined=1;const calls:string[]=[]
 const call=(endpoint:string,payload:unknown)=>createGenerationGuardedCall(()=>generation,async(name:string)=>{calls.push(name);return {ok:true}})(endpoint,payload)
 assert.deepEqual(await call('mcp-connections/list',{}),{ok:true})
 generation=undefined;await assert.rejects(call('mcp-connections/list',{}),/业务连接已变化/)
 generation=2;assert.deepEqual(await call('mcp-connections/list',{}),{ok:true},'重连后新调用取当前代次')
 assert.deepEqual(calls,['mcp-connections/list','mcp-connections/list'])
})
