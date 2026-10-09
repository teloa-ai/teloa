import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {mount,nodes,marketProps} from './market-component-harness.ts'
import {sandboxMarket} from '../src/client/market-preview.ts'
import {marketResourceIndex} from '../src/client/market-resource-index.ts'
import {marketCategoryLabel,visibleMarketCategories} from '../src/client/market-home-presentation.ts'

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

test('市场在 390px 保留八个直接分类入口与可触达的单列列表',async()=>{
  const styles=await read('MarketPage.module.css')
  const catalogModule=mount('MarketResourceCatalog.tsx').exported,page=mount('MarketPage.tsx',{'./MarketResourceCatalog.js':catalogModule})
  const props=marketProps({category:'home'})
  let tree=page.render('TestCatalog',props)
  const nav=nodes(tree).find(node=>node.type==='nav'&&node.props['aria-label']==='market.category.aria')!
  const buttons=nodes(nav).filter(node=>node.type==='button')
  // 未接官方目录（counts 未知）时「模型」隐藏，其余七类直接可见
  const categories=visibleMarketCategories(undefined)
  const expected=[...categories.map(category=>marketCategoryLabel(((key:string)=>key) as any,category)),'market.solution.addedTab']
  assert.deepEqual(buttons.map(node=>node.children[0]),expected)
  assert.equal(buttons.filter(node=>node.props['aria-current']==='page').length,1)
  buttons[categories.indexOf('skill')]!.props.onClick()
  tree=page.render('TestCatalog',props)
  assert.equal(tree.props['data-mobile-layer'],'list')
  assert.ok(nodes(tree).find(node=>node.type===catalogModule.MarketResourceCatalog))
  assert.match(styles,/\.categories\{[^}]*display:flex[^}]*overflow-x:auto/)
  assert.match(styles,/\.page \.categories\{[^}]*flex-wrap:nowrap/)
  assert.doesNotMatch(styles,/data-mobile-layer=category[^}]*\.categories\{[^}]*display:grid/)
  assert.match(styles,/@media\(max-width:740px\)\{[\s\S]*data-mobile-layer=detail[^}]*\.categories[^}]*display:none/)
  assert.match(styles,/@media\(max-width:740px\)\{[\s\S]*\.page button\{[^}]*min-height:44px[^}]*min-width:44px/)
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
  assert.match(team,/if\(inCapabilityCenter\|\|state\.catalogStatus!==['"]ready['"][^)]*\)return/)
  assert.match(resource,/if\(!knowledgeTree\)return/)
  assert.match(market,/catalogReadyRef\.current\?\./)
  assert.match(frame,/onCatalogReady=\{availableIds=>/)
  assert.doesNotMatch(frame,/restorePending\.current\.market[^\n]+market\.items\.map/)
  assert.doesNotMatch(frame,/onNavigationChange=\{next=>\{actions\.rememberDirectory\('resources',[\s\S]{0,500}reconcileAvailableDirectoryTarget/)
})

test('行业目录恢复等待行业加载目录完成',async()=>{
  const [team,frame]=await Promise.all([read('TeamCapabilitiesPage.tsx'),read('WorkbenchFrame.tsx')])
  assert.match(team,/industryLoadsReady:boolean/)
  assert.match(team,/if\(inCapabilityCenter\|\|state\.catalogStatus!==['"]ready['"]\|\|!industryLoadsReady\)return/)
  assert.match(frame,/industryLoadDirectory/)
  assert.match(frame,/if\(industryLoadDirectory!==['"]ready['"]\)return/)
  assert.match(frame,/<TeamCapabilitiesPage[^\n]+industryLoadsReady=\{industryLoadDirectory===['"]ready['"]\}/)
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
  assert.match(market,/data-teloa-pane=\{item\|\|inlineSelectedId\?'detail':'directory'\}/)
  assert.match(focus,/closest(?:<HTMLElement>)?\(['"]\[data-teloa-entry\]['"]\)/)
  assert.match(focus,/original\?\.key\?\?before\.selected/)
})

test('团队能力移动端返回文案说明真实返回层级',async()=>{
  const [team,messages]=await Promise.all([read('TeamCapabilitiesPage.tsx'),read('i18n/locales/team-capability-catalog.ts')])
  assert.doesNotMatch(team,/t\(['"]market\.back['"]\)/)
  assert.match(team,/t\(['"]teamCapability\.back\.categories['"]\)/)
  assert.match(team,/t\(['"]teamCapability\.back\.directory['"]\)/)
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
  nodes(detail).find(node=>node.type==='button'&&node.children.includes('market.back'))!.props.onClick()
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
  assert.match(styles,/@media\(max-width:740px\)\{[\s\S]*\.page button\{[^}]*min-height:44px[^}]*min-width:44px/)
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
