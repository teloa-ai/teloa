import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {mount,nodes,marketProps,type MarketNode as Node} from './market-component-harness.ts'
import * as preview from '../src/client/market-preview.ts'
import * as resources from '../src/client/market-resource-index.ts'
import * as presentation from '../src/client/market-home-presentation.ts'
const t=(key:string)=>key
const catalogModule=mount('MarketResourceCatalog.tsx').exported
const item=(id:string):preview.MarketItem=>({id,kind:'skill',title:id,version:'1.0.0',scope:'general',visibility:'public',summary:'Example',requirements:[],output:'Report',author:'Author',license:'MIT',source:{kind:'builtin'},owner:'Teloa',compatibility:'',components:[]})

test('实体资源单击直达正式详情，返回恢复筛选、选中行与目录层',()=>{
 const items=[item('skill-a'),{...item('skill-b'),owner:'DSH' as const}],page=mount('MarketPage.tsx',{'./MarketResourceCatalog.js':catalogModule})
 let itemId:string|undefined,navigation:any
 const props=()=>({visible:true,state:{items,intents:[]},itemId,intentId:null,open:(id?:string)=>{itemId=id},change:()=>{},seed:null,clearSeed:()=>{},navigationState:{category:'skill'},onNavigationChange:(value:any)=>{navigation=value},installations:{visible:false,selected:null},industryLoads:{loads:[]},skillInstallApi:{pending:()=>undefined},runtime:{state:'ready',facts:[]}})
 const catalogProps=(tree:Node)=>nodes(tree).find(node=>node.type===catalogModule.MarketResourceCatalog)!.props
 let root=page.render('TestCatalog',props()),childProps=catalogProps(root)
 childProps.onFiltersChange({...childProps.filters,ecosystem:'Teloa'})
 root=page.render('TestCatalog',props());childProps=catalogProps(root)
 const child=mount('MarketResourceCatalog.tsx'),tree=child.render('MarketResourceCatalog',childProps)
 const entries=nodes(tree).filter(node=>node.props.role==='option')
 assert.equal(entries.length,1)
 const selectedKey=entries[0]!.props['data-teloa-entry']
 entries[0]!.props.onClick()
 assert.equal(itemId,'skill-a')
 root=page.render('TestCatalog',props())
 assert.equal(root.props['data-mobile-layer'],'detail')
 const detail=nodes(root).find(node=>node.type?.name==='MarketDetail')!
 assert.ok(detail)
 detail.props.back()
 root=page.render('TestCatalog',props());childProps=catalogProps(root)
 assert.equal(itemId,undefined)
 assert.equal(root.props['data-mobile-layer'],'list')
 assert.equal(childProps.filters.ecosystem,'Teloa')
 assert.equal(childProps.selectedId,selectedKey)
 assert.equal(childProps.detailOpen,false)
 assert.equal(navigation.mobileLayer,'list')
 const returned=mount('MarketResourceCatalog.tsx').render('MarketResourceCatalog',childProps)
 assert.equal(nodes(returned).find(node=>node.props['aria-selected']===true)?.props['data-teloa-entry'],selectedKey)
 assert.equal(nodes(returned).find(node=>node.props['aria-selected']===true)?.props.tabIndex,0)
 assert.equal(nodes(returned).some(node=>node.props['data-teloa-pane']==='detail'),false)
 // 分类入口通过已保留的分类词典识别，不把筛选控件当成页签。
 const categoryNav=nodes(root).find(node=>node.type==='nav'&&node.props['aria-label']==='market.category.aria')!
 const tab=nodes(categoryNav).find(node=>node.type==='button'&&node.props['aria-current']!== 'page')!
 assert.ok(tab)
 tab.props.onClick()
 root=page.render('TestCatalog',props())
 // 重新进入技能页：跨分类切换时清除上一类的筛选。
 const nextNav=nodes(root).find(node=>node.type==='nav'&&node.props['aria-label']==='market.category.aria')!
 const skillTab=nodes(nextNav).find(node=>node.type==='button'&&node.children.includes(presentation.marketCategoryLabel(t as any,'skill')))!
 skillTab.props.onClick()
 assert.deepEqual(catalogProps(page.render('TestCatalog',props())).filters,catalogModule.emptyMarketResourceFilters)
})

test('纯引用与身份冲突保留摘要，不能绕过冲突直开安装详情',()=>{
 const fixture=preview.sandboxMarket().items,report=fixture.find(row=>row.id==='skill-report')!,bundle=structuredClone(fixture.find(row=>row.id==='bundle-security')!)
 if(bundle.manifest?.format!=='teloa.business-package/v2')throw Error('fixture')
 bundle.manifest.resources.find(row=>row.source.kind==='public'&&row.source.id==='skill-report')!.kind='mcp'
 for(const items of [[bundle],[report,bundle]]){
  const entry=resources.marketResourceIndex(items).find(row=>row.id==='skill-report')!
  const opened:string[]=[],component=mount('MarketResourceCatalog.tsx')
  const props={items,kind:'resource',resourceKinds:['skill','mcp'],open:(id:string)=>opened.push(id)}
  let tree=component.render('MarketResourceCatalog',props)
  nodes(tree).find(node=>node.props['data-teloa-entry']===entry.key)!.props.onClick()
  tree=component.render('MarketResourceCatalog',props)
  assert.deepEqual(opened,[])
  assert.equal(tree.props['data-resource-layer'],'detail')
  assert.ok(nodes(tree).find(node=>node.props['data-teloa-pane']==='detail'))
  const page=mount('MarketPage.tsx',{'./MarketResourceCatalog.js':catalogModule})
  let itemId:string|undefined=bundle.id,navigation:any
  const propsForPage=()=>({visible:true,state:{items,intents:[]},itemId,intentId:null,open:(id?:string)=>{itemId=id},change:()=>{},seed:null,clearSeed:()=>{},navigationState:{category:entry.kind==='skill'?'skill':'connector',selectedId:entry.key,mobileLayer:'detail'},onNavigationChange:(value:any)=>{navigation=value},installations:{visible:false,selected:null},industryLoads:{loads:[]},skillInstallApi:{pending:()=>undefined},runtime:{state:'ready',facts:[]}})
  let pageTree=page.render('TestCatalog',propsForPage())
  nodes(pageTree).find(node=>node.type?.name==='MarketDetail')!.props.back()
  pageTree=page.render('TestCatalog',propsForPage())
  const returned=nodes(pageTree).find(node=>node.type===catalogModule.MarketResourceCatalog)!
  assert.equal(returned.props.selectedId,entry.key)
  assert.equal(returned.props.detailOpen,true)
  assert.equal(navigation.mobileLayer,'detail')
 }
})

test('本机资源：两排行业 / 功能筛选在外，其余维度收进「更多筛选」；所选条件在外部可见且可一次清空',()=>{
 const component=mount('MarketResourceCatalog.tsx'),props={items:[item('skill-a')],kind:'skill',hideQuery:true,open:()=>{}}
 let tree=component.render('MarketResourceCatalog',props)
 const bar=nodes(tree).find(node=>node.props.tags&&node.props.filter)!
 assert.deepEqual(bar.props.filter,{industry:null,fn:null})
 const more=nodes(bar).find(node=>node.props.label==='market.catalog.official.moreFilters')!
 assert.ok(nodes(more).some(node=>node.type==='select'&&node.props['aria-label']==='market.catalog.ecosystem'))
 assert.ok(nodes(tree).some(node=>node.props.count===1),'结果行写「共 N 项」')
 nodes(tree).find(node=>node.type==='select'&&node.props['aria-label']==='market.catalog.ecosystem')!.props.onChange({target:{value:'Teloa'}})
 tree=component.render('MarketResourceCatalog',props)
 const summary=nodes(tree).find(node=>node.props.className==='filterSummary')!
 assert.ok(JSON.stringify(summary).includes('market.presentation.ecosystem.teloa'),'来源以白话词条显示')
 nodes(summary).find(node=>node.type==='button')!.props.onClick()
 tree=component.render('MarketResourceCatalog',props)
 assert.equal(nodes(tree).some(node=>node.props.className==='filterSummary'),false)
})


test('旧实体摘要恢复为选中列表，正式详情仍恢复正式详情，纯引用保留摘要',()=>{
 const items=preview.sandboxMarket().items
 const entity=resources.marketResourceIndex(items).find(row=>row.kind==='skill'&&row.itemId&&row.status!=='conflict')!
 const bundle=items.find(row=>row.id==='bundle-security')!
 const reference=resources.marketResourceIndex([bundle]).find(row=>row.kind==='skill')!
 for(const [entry,catalog,expectedLayer] of [[entity,items,'list'],[reference,[bundle],'detail']] as const){
  const page=mount('MarketPage.tsx',{'./MarketResourceCatalog.js':catalogModule})
  const props=marketProps({category:'skill',query:entry.id,selectedId:entry.key,mobileLayer:'detail'},catalog)
  const root=page.render('TestCatalog',props)
  assert.equal(root.props['data-mobile-layer'],expectedLayer)
  const directory=nodes(root).find(node=>node.type===catalogModule.MarketResourceCatalog)!
  assert.equal(directory.props.selectedId,entry.key)
  assert.equal(directory.props.query,entry.id)
 }
 const page=mount('MarketPage.tsx',{'./MarketResourceCatalog.js':catalogModule})
 const props=marketProps({category:'skill',selectedId:entity.key,mobileLayer:'detail'},items)
 props.itemId=entity.itemId
 const restored=page.render('TestCatalog',props)
 assert.equal(restored.props['data-mobile-layer'],'detail')
 assert.equal(nodes(restored).find(node=>node.type?.name==='MarketDetail')!.props.item.id,entity.itemId)
})

test('工作模板用两排行业 / 功能筛选与「共 N 项」，详情返回保留筛选',()=>{
 const component=mount('MarketPage.tsx'),props=marketProps({category:'work-template'})
 props.open=id=>{props.itemId=id}
 let tree=component.render('TestCatalog',props)
 const bar=(root:Node)=>nodes(root).find(node=>node.props.tags&&node.props.filter&&node.props.onChange)!
 assert.deepEqual(bar(tree).props.filter,{industry:null,fn:null})
 assert.equal(nodes(tree).some(node=>node.type==='select'),false,'不再有范围 / 可见范围下拉')
 const header=nodes(tree).find(node=>node.type==='header'&&node.props.className==='pageHeader')!
 assert.equal(nodes(header).filter(node=>node.type==='button').length,1)
 assert.equal(nodes(tree).some(node=>node.type==='button'&&node.children.includes('market.home')),false)
 const all=nodes(tree).find(node=>node.type?.name==='MarketCards')!.props.items.length
 bar(tree).props.onChange({industry:'general',fn:null})
 tree=component.render('TestCatalog',props)
 const cards=nodes(tree).find(node=>node.type?.name==='MarketCards')!
 assert.ok(cards.props.items.length>0&&cards.props.items.length<=all)
 assert.ok(cards.props.items.every((item:preview.MarketItem)=>item.scope==='general'))
 assert.ok(nodes(tree).some(node=>node.props.count===cards.props.items.length),'结果行与列表同数')
 cards.props.open(cards.props.items[0].id)
 tree=component.render('TestCatalog',props)
 nodes(tree).find(node=>node.type?.name==='MarketDetail')!.props.back()
 tree=component.render('TestCatalog',props)
 assert.deepEqual(bar(tree).props.filter,{industry:'general',fn:null})
})

test('非方案目录移除冗余返回后，窄屏保留市场标题与已添加入口',()=>{
 const css=readFileSync(new URL('../src/client/MarketPage.module.css',import.meta.url),'utf8')
 assert.doesNotMatch(css,/\.homeLink/)
 assert.doesNotMatch(css,/\.page\[data-mobile-layer=list\] \.pageHeader>div:first-child[^}]*display:none/)
 assert.doesNotMatch(css,/\.page\[data-mobile-layer=list\] \.headerActions\{display:none/)
})

test('同事页顶部接官方 AI 同事区块（kind=role、带 openRole）；模型页只渲染官方模型区块（带去配置深链），不渲染本地资源目录',()=>{
 // 本机没有同事条目时不摆空的本机目录块（2026-09-28 版面修正）；有同事条目时照常显示
 const section=function MarketCatalogSection(){return null}
 const openRole=(_id:string)=>{},nativeModels=()=>{},marketCatalogApi={list:async()=>({counts:{solution:0,role:0,skill:0,connector:0,model:0}})}
 // 每个类别单独挂载：桩 React 的 useState 只在首渲染读 navigationState
 const render=(category:string)=>mount('MarketPage.tsx',{'./MarketResourceCatalog.js':catalogModule,'./MarketCatalogSection.js':{MarketCatalogSection:section}}).render('TestCatalog',{...marketProps({category},[item('skill-a')]),marketCatalogApi,openRole,nativeModels})
 const agent=nodes(render('agent'))
 const agentSection=agent.find(node=>node.type===section)!
 assert.deepEqual(agentSection.props.kinds,['role']);assert.equal(agentSection.props.openRole,openRole)
 // 与官方目录合成一个列表：本机同事作为 localRows 交给目录区块，不另挂本机目录
 assert.equal(agent.some(node=>node.type===catalogModule.MarketResourceCatalog),false)
 assert.deepEqual(agentSection.props.localRows,[])
 const role={...item('role-a'),kind:'role' as const}
 const withRole=nodes(mount('MarketPage.tsx',{'./MarketResourceCatalog.js':catalogModule,'./MarketCatalogSection.js':{MarketCatalogSection:section}}).render('TestCatalog',{...marketProps({category:'agent'},[role]),marketCatalogApi,openRole,nativeModels}))
 assert.equal(withRole.some(node=>node.type===catalogModule.MarketResourceCatalog),false)
 assert.deepEqual(withRole.find(node=>node.type===section)!.props.localRows.map((row:{title:string})=>row.title),['role-a'])
 const model=nodes(render('model'))
 const modelSection=model.find(node=>node.type===section)!
 assert.deepEqual(modelSection.props.kinds,['model']);assert.equal(modelSection.props.openModels,nativeModels)
 assert.equal(model.some(node=>node.type===catalogModule.MarketResourceCatalog),false)
 // counts 未就绪时导航不出现「模型」
 assert.equal(nodes(render('home')).some(node=>node.children.includes('market.presentation.category.model')),false)
 assert.ok(nodes(render('home')).some(node=>node.children.includes('market.presentation.category.agent')))
})

test('从无目录区块的页面（资料、任务模板、扩展）进入市场：挂载即取一次计数，「模型」立即出现；有目录区块的页面不另发请求',async()=>{
 const section=function MarketCatalogSection(){return null}
 // 连接页签现在接官方连接器目录（2026-09-28 版面修正），计数由区块回传，归入下方「有目录区块」一组
 for(const category of ['knowledge','work-template','plugin']){
  const requests:unknown[]=[]
  const marketCatalogApi={list:async(request:unknown)=>{requests.push(request);return {counts:{solution:0,role:0,skill:0,connector:0,model:2}}}}
  const component=mount('MarketPage.tsx',{'./MarketResourceCatalog.js':catalogModule,'./MarketCatalogSection.js':{MarketCatalogSection:section}})
  const props={...marketProps({category},[item('skill-a')]),marketCatalogApi}
  assert.equal(nodes(component.render('TestCatalog',props)).some(node=>node.children.includes('market.presentation.category.model')),false)
  component.effects.forEach(effect=>effect());await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(requests,[{limit:1}],category)
  assert.ok(nodes(component.render('TestCatalog',props)).some(node=>node.children.includes('market.presentation.category.model')),category)
  // 计数已就绪后重渲染不再请求
  component.effects.forEach(effect=>effect());await new Promise(resolve=>setImmediate(resolve))
  assert.equal(requests.length,1,category)
 }
 for(const category of ['home','industry','agent','model','skill','connector']){
  const requests:unknown[]=[]
  const marketCatalogApi={list:async(request:unknown)=>{requests.push(request);return {counts:{solution:0,role:0,skill:0,connector:0,model:2}}}}
  const component=mount('MarketPage.tsx',{'./MarketResourceCatalog.js':catalogModule,'./MarketCatalogSection.js':{MarketCatalogSection:section}})
  component.render('TestCatalog',{...marketProps({category},[item('skill-a')]),marketCatalogApi})
  component.effects.forEach(effect=>effect());await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(requests,[],category)
 }
})
