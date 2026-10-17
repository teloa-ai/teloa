import assert from 'node:assert/strict'
import test from 'node:test'
import {mount,nodes,marketProps,appsDirectory} from './market-component-harness.ts'
import * as preview from '../src/client/market-preview.ts'
import * as presentation from '../src/client/market-home-presentation.ts'

const section=function MarketCatalogSection(){return null}
const marketCatalogApi={list:async()=>({counts:{solution:2,dashboard:1,role:2,skill:3,connector:2,model:1}})}
const fixture=preview.sandboxMarket().items
const render=(category:string,query='')=>nodes(mount('MarketPage.tsx',{'./MarketCatalogSection.js':{MarketCatalogSection:section}}).render('TestCatalog',{...marketProps({category,query},fixture),marketCatalogApi}))
const directory=(tree:ReturnType<typeof render>)=>tree.find(node=>node.type===section)!
// 2026-10-14 用户选 B：应用入口改接 MarketAppsDirectory（统一列连接器应用与技能），不再经 MarketCatalogSection
const apps=(tree:ReturnType<typeof render>)=>tree.find(node=>node.type===appsDirectory)!

test('市场首页即「AI 员工」，主导航只有员工／团队两项，应用是主导航旁的快捷入口，技术资源不再另列高级分类',()=>{
 const tree=render('home'),nav=tree.find(node=>node.type==='nav'&&node.props['aria-label']==='market.category.aria')!
 assert.deepEqual(nodes(nav).filter(node=>node.type==='button').map(node=>node.children.join('')),['market.primary.employees','market.primary.teams'])
 assert.deepEqual(directory(tree).props.kinds,['role','solution'])
 assert.equal(directory(tree).props.presentation,'employees')
 assert.equal(!!directory(tree).props.sidebar,false)
 assert.equal(tree.some(node=>node.props['aria-label']==='market.primary.advancedAria'),false)
 assert.equal(tree.some(node=>node.type==='summary'&&node.children.includes('market.primary.more')),false)
 // 应用是主导航旁的快捷入口：不与员工／团队同级进主导航，也不再收进高级资源组；点击进入统一应用目录：连接器应用与技能同列，官方目录分区不再出现
 const shortcut=(tree:ReturnType<typeof render>)=>tree.filter(node=>node.type==='button'&&node.props.className==='appsShortcut')
 const appsButtons=shortcut(tree)
 assert.equal(appsButtons.length,1);assert.deepEqual(appsButtons[0]!.children,['market.apps.title'],'快捷入口与统一目录同名「应用」');assert.equal(appsButtons[0]!.props['aria-current'],undefined)
 assert.equal(nodes(nav).some(node=>node.props.className==='appsShortcut'||node.children.includes('market.apps.title')||node.children.includes('market.primary.apps')),false)
 const appsTree=render('apps')
 assert.equal(shortcut(appsTree).length,0,'进入应用后不重复市场入口')
 assert.equal(appsTree.some(node=>node.type==='h1'&&node.children.includes('market.title')),false,'应用没有外层市场标题')
 assert.equal(appsTree.some(node=>node.type==='nav'&&node.props['aria-label']==='market.category.aria'),false,'应用不重复员工市场的分类')
 assert.equal(appsTree.some(node=>node.type===section),false,'Apps 页不再渲染官方目录分区')
 const props=apps(appsTree).props
 assert.equal(props.catalogApi,marketCatalogApi)
 assert.equal(props.view.query,'');assert.equal('detail' in props.view,false)
 // 本机行业模板按真实清单交给统一目录判定资源包，不把员工模板当应用
 assert.ok(['bundle-general','bundle-security','bundle-design'].every(id=>props.packages.some((row:any)=>row.id===id&&row.manifest)))
 assert.equal(props.packages.some((row:any)=>fixture.find(item=>item.id===row.id)?.kind==='role'),false)
 for(const key of ['openConnection','openContent','openPackage','onImportSkill','onManagePlugins'])assert.equal(typeof props[key],'function',key)
})

test('官方员工和团队目录不补入个人旧方案；仍按单员工和团队分类读取正式条目',()=>{
 const employees=directory(render('employees')).props,teams=directory(render('teams')).props
 assert.deepEqual(employees.kinds,['role','solution']);assert.equal(employees.presentation,'employees')
 assert.deepEqual(teams.kinds,['solution','dashboard']);assert.equal(teams.presentation,'teams');assert.equal(!!teams.sidebar,false)
 assert.deepEqual(employees.localRows,[]);assert.deepEqual(teams.localRows,[])
 assert.equal(fixture.filter(item=>presentation.marketPrimaryItem(item,'employees')).some(item=>item.id==='bundle-general'),true)
 assert.equal(fixture.filter(item=>presentation.marketPrimaryItem(item,'teams')).some(item=>item.id==='bundle-security'),true)
})

test('个人员工包及包内引用不重复补进官方推荐，原包和引用身份保留',()=>{
 const original=structuredClone(fixture),employees=directory(render('employees')).props.localRows
 assert.deepEqual(employees,[])
 assert.deepEqual(fixture,original)
 assert.ok(fixture.some(item=>item.id==='bundle-general'))
 const direct=nodes(mount('MarketPage.tsx').render('TestCatalog',{...marketProps({category:'employees'},fixture),itemId:'bundle-general',marketCatalogApi}))
 assert.ok(direct.some(node=>node.props.item?.id==='bundle-general'),'已导入原包仍可经原身份打开')
})

test('旧技术 category 保留原 kind，不能被重写为应用或空模板列表',()=>{
 const expected={industry:['solution'],agent:['role'],skill:['skill'],connector:['connector'],model:['model']}
 for(const [category,kinds] of Object.entries(expected)){
  const tree=render(category)
  assert.deepEqual(directory(tree).props.kinds,kinds,category)
  assert.equal(tree.some(node=>node.props['aria-label']==='market.primary.advancedAria'),false,category)
 }
})

test('重新进入市场只回到方案 B 主目录：旧方案回团队、旧连接器回应用、其余技术类别回 AI 员工',()=>{
 const entry=Reflect.get(presentation,'marketEntryCategory')
 assert.equal(typeof entry,'function')
 assert.deepEqual(Object.fromEntries((['home','employees','teams','apps','intents','industry','connector','agent','skill','plugin','dashboard','model','knowledge','work-template'] as const).map(kind=>[kind,entry(kind)])),
  {home:'home',employees:'employees',teams:'teams',apps:'apps',intents:'intents',industry:'teams',connector:'apps',agent:'home',skill:'home',plugin:'apps',dashboard:'teams',model:'home',knowledge:'home','work-template':'home'})
 // 主动进入的技术类别（高级资源、业务配置请求）仍按原 kind 渲染原目录，恢复映射不删除这些入口
 assert.deepEqual(directory(render('industry')).props.kinds,['solution'])
 assert.deepEqual(directory(render(entry('industry'))).props.presentation,'teams')
})

test('应用归并可安装插件，系统实现分类不再成为导航',()=>{
 const base=fixture.find(row=>row.kind==='resource')!
 assert.equal(presentation.marketPrimaryItem({...base,resourceKind:'plugin'},'apps'),true)
 assert.equal(presentation.marketPrimaryItem({...base,resourceKind:'plugin'},'employees'),false)
 assert.equal(Reflect.get(presentation,'MARKET_SECONDARY_GROUPS'),undefined,'退出旧高级分类定义，应用实现类型不再单列')
 assert.ok(Reflect.get(presentation,'MARKET_CATEGORIES').includes('work-template'))
})

test('独立行业看板可从团队目录发现，仍标为看板，不混入员工或应用，也不改变原条目',()=>{
 const base=fixture.find(row=>row.kind==='bundle')!
 const local={...base,manifest:{...(base.manifest as any),resources:[{kind:'business-configuration'}]}}
 const official={entry:{kind:'dashboard'},contents:{'business-configuration':1}} as any
 const original=structuredClone({local,official})
 for(const [view,expected] of [['employees',false],['teams',true],['apps',false]] as const){
  assert.equal(presentation.marketPrimaryItem(local,view),expected,view)
  assert.equal(presentation.marketPrimaryCatalogItem(official,view),expected,view)
 }
 assert.equal(presentation.marketItemGroup(local),'market.presentation.category.dashboard')
 assert.equal(presentation.marketCatalogItemGroup(official),'market.presentation.category.dashboard')
 assert.deepEqual({local,official},original)
})

test('模板按员工数归同事或团队：一位归同事，多位归团队，没有组成计数的官方方案保留在团队方案里',()=>{
 const role=fixture.find(row=>row.kind==='role')!
 assert.equal(presentation.marketPrimaryItem(role,'employees'),true);assert.equal(presentation.marketPrimaryItem(role,'teams'),false)
 const bundles=fixture.filter(row=>row.kind==='bundle'&&row.manifest&&'resources'in row.manifest)
 for(const bundle of bundles){
  const roles=(bundle.manifest as any).resources.filter((row:any)=>row.kind==='role').length
  assert.equal(presentation.marketPrimaryItem(bundle,'employees'),roles===1,bundle.id)
  assert.equal(presentation.marketPrimaryItem(bundle,'teams'),roles>1,bundle.id)
  assert.equal(presentation.marketItemGroup(bundle),roles===1?'market.primary.employees':roles>1?'market.primary.teams':'market.primary.businessGroup',bundle.id)
 }
 const entry=(kind:'role'|'solution'|'skill',contents?:Record<string,number>)=>({entry:{kind},...(contents?{contents}:{})}) as any
 assert.equal(presentation.marketPrimaryCatalogItem(entry('role'),'employees'),true)
 assert.equal(presentation.marketPrimaryCatalogItem(entry('role'),'teams'),false)
 assert.equal(presentation.marketPrimaryCatalogItem(entry('solution',{role:1}),'employees'),true)
 assert.equal(presentation.marketPrimaryCatalogItem(entry('solution',{role:3}),'teams'),true)
 assert.equal(presentation.marketPrimaryCatalogItem(entry('solution',{role:3}),'employees'),false)
 assert.equal(presentation.marketPrimaryCatalogItem(entry('solution'),'teams'),true)
 assert.equal(presentation.marketPrimaryCatalogItem(entry('solution',{role:0}),'teams'),false)
 assert.equal(presentation.marketPrimaryCatalogItem(entry('skill'),'employees'),false)
 assert.equal(presentation.marketCatalogItemGroup(entry('solution',{role:2})),'market.primary.teams')
 assert.equal(presentation.marketCatalogItemGroup(entry('skill')),'market.primary.methodsGroup')
})

test('主入口搜索查询完整官方目录；本人技能不混成推荐，Apps 搜索保持原独立目录',()=>{
 for(const category of ['home','employees','teams']){
  const tree=render(category,'报告'),props=directory(tree).props
  assert.equal(props.kinds,undefined,category)
  assert.deepEqual(props.localRows,[],category+' 个人资源保留在我的资源')
  assert.equal(tree.some(node=>node.type===appsDirectory),false,category+' 主入口搜索不切到应用目录')
 }
 const tree=render('apps','报告')
 assert.equal(tree.some(node=>node.type===section),false,'Apps 内搜索不回退到官方目录')
 assert.equal(apps(tree).props.view.query,'报告')
})

test('只有旧方案引用的员工不冒充官方独立员工，原方案内容与引用身份保留',()=>{
 assert.deepEqual(directory(render('employees')).props.localRows,[])
 const direct=nodes(mount('MarketPage.tsx').render('TestCatalog',{...marketProps({category:'teams'},fixture),itemId:'bundle-security',marketCatalogApi}))
 const detail=direct.find(node=>node.props.item?.id==='bundle-security')
 assert.ok(detail,'旧团队可以通过原身份打开')
 assert.equal(detail!.props.item.id,'bundle-security')
})
