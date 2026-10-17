import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {mount,nodes,marketProps,appsDirectory} from './market-component-harness.ts'
import {sandboxMarket} from '../src/client/market-preview.ts'
import {marketResourceIndex} from '../src/client/market-resource-index.ts'
import {marketCategoryLabel} from '../src/client/market-home-presentation.ts'

const clientRoot=new URL('../src/client/',import.meta.url)
const read=(name:string)=>readFile(new URL(name,clientRoot),'utf8')

test('团队能力在 390px 只显示分类、列表或详情中的当前一层',async()=>{
  const [source,styles]=await Promise.all([read('TeamCapabilitiesPage.tsx'),read('TeamCapabilitiesPage.module.css')])
  assert.match(source,/data-mobile-layer=\{mobileLayer\}/)
  assert.match(source,/setMobileLayer\('list'\)/)
  assert.match(source,/setMobileLayer\('detail'\)/)
  assert.match(source,/className=\{css\.mobileBack\}/)
  assert.match(styles,/\.rowList>button\[aria-selected=true\]/)
  assert.doesNotMatch(styles,/\.rowList>button\[aria-pressed=true\]/)
  assert.match(styles,/@media\(max-width:720px\)\{[\s\S]*data-mobile-layer=category[\s\S]*data-mobile-layer=list[\s\S]*data-mobile-layer=detail/)
  assert.match(styles,/@media\(max-width:720px\)\{[\s\S]*\.taxonomy button[^{]*\{[^}]*min-height:44px/)
  assert.match(styles,/@media\(max-width:720px\)\{[\s\S]*\.directory header>button[^{]*\{[^}]*min-height:44px/)
  assert.match(styles,/@media\(max-width:720px\)\{[\s\S]*\.workspace button[^{]*\{[^}]*min-height:44px[^}]*min-width:44px/)
})

test('团队能力列表键盘选择与 aria-selected 使用同一真实状态',async()=>{
  const source=await read('TeamCapabilitiesPage.tsx')
  assert.match(source,/role="listbox"/)
  assert.match(source,/role="option" aria-selected=\{selected\?\.key===row\.key\}/)
  assert.match(source,/tabIndex=\{selected\?\.key===row\.key\|\|\(!selected&&index===0\)\?0:-1\}/)
  for(const key of ['ArrowDown','ArrowUp','Home','End'])assert.match(source,new RegExp(`'${key}'`))
})

test('资料目录以树和正文为主，筛选不再占据目录，390px 主要触控目标仍完整',async()=>{
  const [source,styles]=await Promise.all([read('ResourceManager.tsx'),read('ResourceManager.module.css')])
  assert.doesNotMatch(source,/DirectoryFilterPopover/)
  assert.doesNotMatch(source,/ResourceManagerFacetFilters/)
  assert.match(source,/librarySearch/)
  assert.match(source,/library.search/)
  assert.match(styles,/@media\(max-width:720px\)\{[\s\S]*\.treeHeader>div>button[^{]*\{[^}]*min-height:44px[^}]*min-width:44px/)
  assert.match(styles,/@media\(max-width:720px\)\{[\s\S]*\.treeBranch>summary[^{]*\{[^}]*min-height:44px/)
  assert.match(styles,/@media\(max-width:720px\)\{[\s\S]*\.governanceMenu>summary[^{]*\{[^}]*min-height:44px[^}]*min-width:44px/)
  assert.match(styles,/@media\(max-width:720px\)\{[\s\S]*\.page button[^{]*\{[^}]*min-height:44px[^}]*min-width:44px/)
})

test('市场窄窗口保留两主入口与明确分组的原分类，技能仍到达同一列表',async()=>{
  const styles=await read('MarketPage.module.css')
  // 真实工作台总是注入官方目录 API；技能等原分类经同一官方目录区块（kinds 限定类型）到达，本机资源留在「已添加」
  const section=function MarketCatalogSection(){return null}
  const catalogModule=mount('MarketResourceCatalog.tsx').exported,page=mount('MarketPage.tsx',{'./MarketResourceCatalog.js':catalogModule,'./MarketCatalogSection.js':{MarketCatalogSection:section}})
  const props={...marketProps({category:'home'}),marketCatalogApi:{list:async()=>({counts:{solution:0,dashboard:0,role:0,skill:0,connector:0,model:0}})}}
  let tree=page.render('TestCatalog',props)
  const nav=nodes(tree).find(node=>node.type==='nav'&&node.props['aria-label']==='market.category.aria')!
  const buttons=nodes(nav).filter(node=>node.type==='button')
  assert.deepEqual(buttons.map(node=>node.children[0]),['market.primary.employees','market.primary.teams'])
  assert.equal(buttons.filter(node=>node.props['aria-current']==='page').length,1)
  assert.equal(nodes(tree).some(node=>node.props['aria-label']==='market.primary.advancedAria'),false,'市场不再挂高级分类')
  const apps=nodes(tree).filter(node=>node.type==='button'&&node.children.includes('market.apps.title'))
  assert.equal(apps.length,1,'应用是常驻入口，高级菜单不重复')
  apps[0]!.props.onClick();tree=page.render('TestCatalog',props)
  // 进入应用后是统一应用目录（自带「应用」标题与搜索），不再重复市场标题、市场分类与应用快捷入口（见 market-primary-navigation）
  assert.ok(nodes(tree).some(node=>node.type===appsDirectory),'应用入口到达统一应用目录')
  assert.equal(nodes(tree).some(node=>node.type==='button'&&node.children.includes('market.apps.title')),false,'应用内不重复应用入口')
  assert.equal(nodes(tree).some(node=>node.type==='nav'&&node.props['aria-label']==='market.category.aria'),false,'应用不重复市场分类')
  tree=mount('MarketPage.tsx',{'./MarketResourceCatalog.js':catalogModule,'./MarketCatalogSection.js':{MarketCatalogSection:section}}).render('TestCatalog',{...props,navigationState:{category:'skill'}})
  assert.equal(tree.props['data-mobile-layer'],'list')
  assert.deepEqual(nodes(tree).find(node=>node.type===section)!.props.kinds,['skill'],'技能到达同一官方目录区块且只列技能')
  assert.equal(nodes(tree).some(node=>node.type===catalogModule.MarketResourceCatalog),false,'不另挂本机技能块')
  assert.match(styles,/\.categories\{[^}]*display:flex[^}]*overflow-x:auto/)
  assert.match(styles,/\.primaryNavigation \.categories\{[^}]*flex-wrap:nowrap/)
  assert.doesNotMatch(styles,/data-mobile-layer=category[^}]*\.categories\{[^}]*display:grid/)
  assert.match(styles,/@media\(max-width:740px\)\{[\s\S]*data-mobile-layer=detail[^}]*\.categories[^}]*display:none/)
  assert.match(styles,/@media\(max-width:740px\)\{[\s\S]*\.page button:where\(:not\(\[data-teloa-toolbar-icon\]\)\)\{[^}]*min-height:44px[^}]*min-width:44px/)
  assert.match(styles,/\.resourceDestinations li strong\{[^}]*overflow-wrap:anywhere/)
})

test('功能验证 页面样式只使用语义令牌且不引入主题选择器或 Tailwind',async()=>{
  for(const name of ['TeamCapabilitiesPage.module.css','ResourceManager.module.css','MarketPage.module.css']){
    const styles=await read(name)
    assert.doesNotMatch(styles,/#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/)
    assert.doesNotMatch(styles,/\[data-(?:ds-)?(?:dark|light)[^\]]*\]|prefers-color-scheme/)
    assert.doesNotMatch(styles,/@tailwind/)
  }
})

test('三个目录页提供向后兼容的恢复初始值与导航变化回调',async()=>{
  const [team,resource,market]=await Promise.all([read('TeamCapabilitiesPage.tsx'),read('ResourceManager.tsx'),read('MarketPage.tsx')])
  assert.match(team,/export type TeamCapabilitiesNavigationState=/)
  assert.match(team,/navigationState\?:Partial<TeamCapabilitiesNavigationState>/)
  assert.match(team,/navigationState\?\.category\?\?'skill'/)
  assert.match(team,/navigationState\?\.selectedId/)
  assert.match(team,/navigationState\?\.mobileLayer\?\?'category'/)
  assert.match(team,/onNavigationChange\?\./)

  assert.match(resource,/export type ResourceManagerNavigationState=/)
  assert.match(resource,/navigationState\?:Partial<ResourceManagerNavigationState>/)
  // 用户移除的是底部分面筛选；Wiki 树搜索和当前阅读对象仍须跨导航恢复。
  assert.match(resource,/navigationState\?\.query\?\?''/)
  assert.match(resource,/category:'all'/)
  assert.match(resource,/navigationState\?\.selectedId/)
  assert.match(resource,/navigationState\?\.mobileLayer/)
  assert.match(resource,/onNavigationChange\?\./)

  assert.match(market,/export type MarketPageNavigationState=/)
  assert.match(market,/navigationState\?:Partial<MarketPageNavigationState>/)
  assert.match(market,/navigationState\?\.category\?\?'home'/)
  assert.match(market,/navigationState\?\.query\?\?''/)
  assert.match(market,/navigationState\?\.selectedId/)
  assert.match(market,/onNavigationChange\?\./)
})

test('异步目录就绪前不清除冷刷新恢复的详情选择',async()=>{
  const [team,resource,market,frame]=await Promise.all([
    read('TeamCapabilitiesPage.tsx'),
    read('ResourceManager.tsx'),
    read('MarketPage.tsx'),
    read('WorkbenchFrame.tsx'),
  ])
  // 我的资源只随外部目录定位恢复选中，不在目录就绪前后自动改写选中项
  assert.doesNotMatch(team,/remember\(\{selectedId:selected\?\.key\}\)/)
  assert.match(team,/navigationState\?\.selectedId!==undefined&&navigationState\.selectedId!==selectedKey\)setSelectedKey\(navigationState\.selectedId\)/)
  assert.match(resource,/if\(!knowledgeTree\)return/)
  assert.match(market,/catalogReadyRef\.current\?\./)
  assert.match(frame,/onCatalogReady=\{availableIds=>/)
  assert.doesNotMatch(frame,/restorePending\.current\.market[^\n]+market\.items\.map/)
  assert.doesNotMatch(frame,/onNavigationChange=\{next=>\{actions\.rememberDirectory\('resources',[\s\S]{0,500}reconcileAvailableDirectoryTarget/)
})

test('行业目录恢复等待行业加载目录完成',async()=>{
  const [team,frame]=await Promise.all([read('TeamCapabilitiesPage.tsx'),read('WorkbenchFrame.tsx')])
  assert.match(team,/industryLoadsReady:boolean/)
  assert.match(team,/if\(!visible\|\|!industryLoadsReady\)return/)
  assert.match(team,/skillRuntime:industryLoadsReady&&skillRuntime\.loadsKey===skillLoadsKey\?skillRuntime:\{loadsKey:skillLoadsKey,state:'loading',facts:\[\]\}/)
  assert.match(frame,/industryLoadDirectory/)
  assert.match(frame,/if\(industryLoadDirectory!==['"]ready['"]\)return/)
  assert.match(frame,/mine=\{\{[^\n]+industryLoadsReady:industryLoadDirectory===['"]ready['"]/)
})

test('三个目录页接入统一滚动记录和手机返回原行焦点协议',async()=>{
  const [team,resource,market,focus]=await Promise.all([read('TeamCapabilitiesPage.tsx'),read('ResourceManager.tsx'),read('MarketPage.tsx'),read('directory-focus.ts')])
  for(const source of [team,resource,market]){
    assert.match(source,/import \{\s*useDirectoryFocus\s*\} from ['"]\.\/directory-focus\.js['"]/)
    assert.match(source,/useDirectoryFocus\(/)
    assert.match(source,/data-teloa-entry=/)
  }
  for(const source of [team,resource]){
    assert.match(source,/data-teloa-pane="directory"/)
    assert.match(source,/data-teloa-pane="detail"/)
  }
  // 详情成为共享抽屉后，主入口目录保持原布局；旧内联资源摘要仍保留分层。
  assert.match(market,/data-teloa-pane=\{inlineSelectedId&&!primaryView\?'detail':'directory'\}/)
  assert.match(market,/const itemDrawer=item\?<ContextDrawer/)
  assert.match(market,/rememberNavigation\(\{selectedId:lastSelectedId,mobileLayer:'list'\}\)/)
  assert.match(focus,/closest(?:<HTMLElement>)?\(['"]\[data-teloa-entry\]['"]\)/)
  assert.match(focus,/original\?\.key\?\?before\.selected/)
})

test('团队能力目录返回分类，轻详情由共享抽屉关闭并保留当前行',async()=>{
  const [team,messages]=await Promise.all([read('TeamCapabilitiesPage.tsx'),read('i18n/locales/team-capability-catalog.ts')])
  assert.doesNotMatch(team,/t\(['"]market\.back['"]\)/)
  assert.match(team,/t\(['"]teamCapability\.back\.categories['"]\)/)
  assert.match(team,/<ContextDrawer[^>]+close=\{\(\)=>\{setDetailOpen\(false\);setMobileLayer\('list'\);remember\(\{mobileLayer:'list'\}\)/)
  assert.match(messages,/r\(['"]teamCapability\.back\.categories['"]/)
  assert.match(messages,/r\(['"]teamCapability\.back\.directory['"]/)
})

test('Frame 在异步目录挂载和祖先滚动时重新解析当前可见滚动容器',async()=>{
  const frame=await read('WorkbenchFrame.tsx')
  assert.match(frame,/visibleDirectoryPane\(frameRef\.current\)/)
  assert.match(frame,/window\.setTimeout\(restore,50\)/)
  assert.doesNotMatch(frame,/MutationObserver/)
  assert.doesNotMatch(frame,/directoryScrollerRef/)
})

test('纯引用选择与返回通过父页面导航回调保持原目录行',()=>{
  const bundle=sandboxMarket().items.find(item=>item.id==='bundle-security')!,entry=marketResourceIndex([bundle]).find(row=>row.kind==='skill')!
  const catalogModule=mount('MarketResourceCatalog.tsx').exported,page=mount('MarketPage.tsx',{'./MarketResourceCatalog.js':catalogModule})
  const props=marketProps({category:'skill'},[bundle]);let navigation:any
  props.onNavigationChange=value=>{navigation=value}
  let root=page.render('TestCatalog',props)
  const childProps=()=>nodes(root).find(node=>node.type===catalogModule.MarketResourceCatalog)!.props
  const child=mount('MarketResourceCatalog.tsx')
  let tree=child.render('MarketResourceCatalog',childProps())
  nodes(tree).find(node=>node.props['data-teloa-entry']===entry.key)!.props.onClick()
  root=page.render('TestCatalog',props)
  assert.equal(navigation.selectedId,entry.key)
  assert.equal(navigation.mobileLayer,'detail')
  tree=child.render('MarketResourceCatalog',childProps())
  const detail=nodes(tree).find(node=>node.props['data-teloa-pane']==='detail')!
  nodes(detail).find(node=>node.type==='button'&&node.props['aria-label']==='market.back')!.props.onClick()
  root=page.render('TestCatalog',props)
  assert.equal(root.props['data-mobile-layer'],'list')
  assert.equal(navigation.selectedId,entry.key)
  assert.equal(navigation.mobileLayer,'list')
  tree=child.render('MarketResourceCatalog',childProps())
  const selected=nodes(tree).find(node=>node.props['aria-selected']===true)!
  assert.equal(selected.props['data-teloa-entry'],entry.key)
  assert.equal(selected.props.tabIndex,0)
})

test('市场资源子目录在 390px 的触控与摘要规则命中实际 ItemCard',async()=>{
  const styles=await read('MarketPage.module.css')
  const tree=mount('MarketResourceCatalog.tsx').render('MarketResourceCatalog',{items:sandboxMarket().items,kind:'skill',open:()=>{}})
  const row=nodes(tree).find(node=>node.props.role==='option')!
  assert.equal(row.type,'button')
  assert.equal(row.props.className,'itemCard')
  assert.equal(nodes(tree).find(node=>node.props.role==='listbox')!.props.className,'itemList')
  assert.match(styles,/\.itemList\{[^}]*display:flex[^}]*flex-direction:column/)
  assert.match(styles,/\.page \.itemCard\{[^}]*width:100%[^}]*min-width:0/)
  assert.match(styles,/@media\(max-width:740px\)\{[\s\S]*\.page button:where\(:not\(\[data-teloa-toolbar-icon\]\)\)\{[^}]*min-height:44px[^}]*min-width:44px/)
  assert.match(styles,/@media\(max-width:740px\)\{[\s\S]*\.resourceCatalog\[data-resource-layer=list\] \.resourceDescription,[\s\S]*\.resourceCatalog\[data-resource-layer=list\] \.resourceFacts,[\s\S]*display:none/)
})

test('消息详情标题行允许文本缩小和换行，避免操作区挤出容器',async()=>{
  const styles=await read('TaskPage.module.css')
  assert.match(styles,/\.alignedPage \.titleRow\{[^}]*min-width:0/)
  assert.match(styles,/\.alignedPage \.titleRow h2\{[^}]*min-width:0[^}]*overflow-wrap:anywhere/)
})


test('行业模板资源在宽屏下复用市场首页的居中容器且分类网格自适应列宽',async()=>{
  const styles=await read('MarketPage.module.css')
  // 滚动容器里的实际可达性由 market-saved-scroll.browser.test.mjs 验证，不限定外层 JSX 形状。
  assert.match(styles,/\.container\{[^}]*max-width:1120px[^}]*\}/)
  assert.match(styles,/\.environmentCategories\{[^}]*grid-template-columns:repeat\(auto-fit,minmax\(160px,1fr\)\)/)
  assert.doesNotMatch(styles,/\.environmentCategories\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/)
  // 740px 下仍固定两列，触控目标不变。
  assert.match(styles,/@media\(max-width:740px\)\{[\s\S]*\.environmentCategories\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/)
  assert.match(styles,/@media\(max-width:740px\)\{[\s\S]*\.page \.environmentCategories button\{[^}]*min-height:44px/)
  assert.match(styles,/@media\(max-width:740px\)\{[\s\S]*\.container\{padding:26px 21px\}/)
})
