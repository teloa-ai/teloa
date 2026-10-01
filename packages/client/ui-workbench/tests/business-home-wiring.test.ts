import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {nextBusinessHome} from '../src/client/business-home-presentation.ts'
import {
 businessLedgerHomeShown,
 businessNavStep,
 businessPageEntryProps,
 businessPageVisible,
 businessTargetKey,
 nextBusinessEntry,
 openBusinessScopeSteps,
 openStaffOfScopeSteps,
 teamFocusScopeAfterView,
 type BusinessNavSeen,
} from '../src/client/workbench-business-navigation.ts'

/**
 * 业务台账首页与范围内页之间那一位（`businessHome`）、以及业务/同事之间那几次交接的测试。
 * 这些决策全部由纯函数独自做完（`nextBusinessHome` 判这一位怎么翻，`workbench-business-navigation.ts`
 * 管已见取值、进入态、聚焦范围、市场请求），测试直接喂输入断输出，不再钉 `WorkbenchFrame.tsx` 的原文。
 * 唯一保留的源码守卫是那条计数：进入业务只许经 `enterBusiness` 一处。
 */

const frameUrl=new URL('../src/client/WorkbenchFrame.tsx',import.meta.url)

/** 起点：已见视图与已见目标都停在冷启动默认（业务视图之外、默认目标）。 */
const seenAt=(view:string,target:Parameters<typeof businessTargetKey>[0]):BusinessNavSeen=>
 ({viewSeen:view,targetSeen:businessTargetKey(target)})
const DEFAULT_TARGET={scope:'SOC',section:'overview'} as const

test('首页/内页这一位的判据：用户明确要进内页时不看「目标变没变」（终审 H1 的那一格）',()=>{
 const signal=(origin:Parameters<typeof nextBusinessHome>[0]['origin'],changed:{view?:boolean;target?:boolean}={})=>
  nextBusinessHome({origin,viewChanged:changed.view===true,targetChanged:changed.target===true})
 // (a) 从别处打开一个业务：目标与当前深度相等（冷启动默认 {scope:'SOC',section:'overview'} 就是这一格），
 //     仍然进内页——这正是 H1 的缺陷：只靠「目标取值变了」判会把用户留在台账首页。
 assert.equal(signal('enter'),false)
 assert.equal(signal('enter',{target:true}),false)
 // (b) 「← 业务台账」回首页。
 assert.equal(signal('back-home'),true)
 // (c) 换到业务视图（左栏点「业务」）回首页；视图没变就不翻。
 assert.equal(signal('view',{view:true}),true)
 assert.equal(signal('view'),null)
 // (d) 目标取值真变了才算用户打开了一个范围。
 assert.equal(signal('target',{target:true}),false)
 // (e) 恢复期先 settle 把已见取值推平，这里读到「没变」，不翻这一位。
 assert.equal(signal('target'),null)
})

test('已见取值比的是目标取值而不是对象身份：同值的两个目标算「没变」',()=>{
 assert.equal(businessTargetKey({scope:'SOC',section:'overview'}),businessTargetKey({scope:'SOC',section:'overview'}))
 assert.notEqual(businessTargetKey({scope:'SOC',section:'overview'}),businessTargetKey({scope:'SOC',section:'data'}))
 assert.notEqual(businessTargetKey({scope:'SOC',section:'data',id:'obj-1'}),businessTargetKey({scope:'SOC',section:'data'}))
 assert.notEqual(
  businessTargetKey({scope:'SOC',section:'data',id:'obj-1',objectType:'alert'}),
  businessTargetKey({scope:'SOC',section:'data',id:'obj-1'}),
 )
})

test('换视图这一路：只有真的换到业务视图才回首页',()=>{
 const seen=seenAt('home',DEFAULT_TARGET)
 // 左栏点「业务」：视图换到 spaces，回台账首页，并记下新的已见视图。
 const entered=businessNavStep(seen,{kind:'view',view:'spaces'})
 assert.equal(entered.home,true)
 assert.equal(entered.seen.viewSeen,'spaces')
 assert.equal(entered.seen.targetSeen,seen.targetSeen,'换视图不该动已见目标')
 // 已经在业务视图里再跑一次（React 重跑 effect）：视图没变，这一位不翻。
 assert.equal(businessNavStep(entered.seen,{kind:'view',view:'spaces'}).home,null)
 // 换到别的视图：不翻这一位（离开业务视图本身不改首页/内页的位置），但已见视图要跟上。
 const left=businessNavStep(entered.seen,{kind:'view',view:'team'})
 assert.equal(left.home,null)
 assert.equal(left.seen.viewSeen,'team')
})

test('换目标这一路：取值真变了才算用户打开了一个范围',()=>{
 const seen=seenAt('spaces',DEFAULT_TARGET)
 const moved=businessNavStep(seen,{kind:'target',target:{scope:'SOC',section:'data',id:'obj-1'}})
 assert.equal(moved.home,false)
 assert.equal(moved.seen.targetSeen,businessTargetKey({scope:'SOC',section:'data',id:'obj-1'}))
 assert.equal(moved.seen.viewSeen,'spaces','换目标不该动已见视图')
 // 同值再来一次：不翻。
 assert.equal(businessNavStep(moved.seen,{kind:'target',target:{scope:'SOC',section:'data',id:'obj-1'}}).home,null)
})

test('从别处打开业务：进内页这一步顺手把已见视图推到 spaces，紧接着的视图 effect 不会把这一位翻回首页（终审 H1）',()=>{
 const seen=seenAt('home',DEFAULT_TARGET)
 // enterBusiness 这一步：进内页 + 推平已见视图（`openBusiness` 会把视图切到 spaces）。
 const enter=businessNavStep(seen,{kind:'enter'})
 assert.equal(enter.home,false)
 assert.equal(enter.seen.viewSeen,'spaces')
 assert.equal(enter.seen.targetSeen,seen.targetSeen)
 // 随后跑的视图 effect 读到「视图没变」，这一位保持在内页；不推平的话这里会算出 true 把用户弹回首页。
 assert.equal(businessNavStep(enter.seen,{kind:'view',view:'spaces'}).home,null)
 assert.equal(businessNavStep(seen,{kind:'view',view:'spaces'}).home,true,'没推平已见视图就会回首页——这正是 H1')
 // 目标与当前深度相等（冷启动默认那一格）时，目标 effect 会短路，但这一位已经由 enter 翻好了。
 assert.equal(businessNavStep(enter.seen,{kind:'target',target:DEFAULT_TARGET}).home,null)
})

test('「← 业务台账」回首页，且不动两份已见取值',()=>{
 const seen=seenAt('spaces',{scope:'SOC',section:'data',id:'obj-1'})
 const back=businessNavStep(seen,{kind:'back-home'})
 assert.equal(back.home,true)
 assert.deepEqual(back.seen,seen)
})

test('启动恢复期改业务目标不算「打开了一个范围」：先推平已见取值，精确内页位置才直接进内页（终审 L4）',()=>{
 const seen=seenAt('spaces',DEFAULT_TARGET)
 // 范围回退到另一个总览：只推平已见取值，这一位不翻，用户留在台账首页。
 const fallback=businessNavStep(seen,{kind:'settle',target:{scope:'OPS',section:'overview'}})
 assert.equal(fallback.home,null)
 assert.equal(fallback.seen.targetSeen,businessTargetKey({scope:'OPS',section:'overview'}))
 // 推平之后目标 effect 读到「没变」，不会把用户踢进内页。
 assert.equal(businessNavStep(fallback.seen,{kind:'target',target:{scope:'OPS',section:'overview'}}).home,null)
 // 恢复到的是一个精确内页位置（非总览，或带着一条对象 id）：那是用户上次停的地方，直接进内页。
 assert.equal(businessNavStep(seen,{kind:'settle',target:{scope:'SOC',section:'projects'}}).home,false)
 assert.equal(businessNavStep(seen,{kind:'settle',target:{scope:'SOC',section:'overview',id:'obj-1'}}).home,false)
 // settle 不动已见视图：恢复不是一次视图切换。
 assert.equal(fallback.seen.viewSeen,'spaces')
})

test('首页卡片只打开正式业务数据，每次进入换一个新 serial',()=>{
 assert.deepEqual(openBusinessScopeSteps({scope:'SOC',mode:'real',businessLoaded:false}),
  {seedExamples:false,target:{scope:'SOC',section:'overview'}})
 assert.deepEqual(nextBusinessEntry({serial:0}),{serial:1})
})

test('右栏 teloa.business 页签与主视图各用各的进入态：首页点卡不重挂右栏',()=>{
 // 右栏页签那次不传 entry：key 恒为 business-tab。
 assert.deepEqual(businessPageEntryProps(undefined),{key:'business-tab',props:{}})
 // 主视图那次才传，且 key 随 serial 变。
 assert.deepEqual(businessPageEntryProps({serial:3}),{key:'business-3',props:{}})
})

test('台账首页与范围内页各占主视图的哪一刻：右栏/嵌入态永远直接是内页',()=>{
 assert.equal(businessLedgerHomeShown({view:'spaces',home:true,embedded:false}),true)
 assert.equal(businessLedgerHomeShown({view:'spaces',home:false,embedded:false}),false)
 assert.equal(businessLedgerHomeShown({view:'spaces',home:true,embedded:true}),false,'嵌入态不出台账首页')
 assert.equal(businessLedgerHomeShown({view:'team',home:true,embedded:false}),false)
 // 内页可见性与上面那一位互斥；嵌入态（右栏页签）不看当前视图。
 assert.equal(businessPageVisible({embedded:false,view:'spaces',ledgerHome:false}),true)
 assert.equal(businessPageVisible({embedded:false,view:'spaces',ledgerHome:true}),false)
 assert.equal(businessPageVisible({embedded:false,view:'team',ledgerHome:false}),false)
 assert.equal(businessPageVisible({embedded:true,view:'team',ledgerHome:false}),true)
})

test('「看这队的同事 →」先清掉选中的同事再交范围：否则会落在那位的个人主页而不是这队名单',()=>{
 // selected 不清就会命中 TeamPage 里的 role 查找，停在个人页。
 assert.deepEqual(openStaffOfScopeSteps('SOC'),{selectedRole:null,focusScope:'SOC',view:'team'})
})

test('聚焦范围只在同事页里有意义：离开同事页即清空',()=>{
 assert.equal(teamFocusScopeAfterView('team','SOC'),'SOC')
 assert.equal(teamFocusScopeAfterView('spaces','SOC'),null)
 assert.equal(teamFocusScopeAfterView('team',null),null)
})

test('从别处打开业务一律走 enterBusiness：外壳里只剩它一处直接调 actions.openBusiness',async()=>{
 const frame=await readFile(frameUrl,'utf8')
 assert.equal((frame.match(/actions\.openBusiness\(/g)??[]).length,1,'还有直传点没换成 enterBusiness')
})

test('正式业务目录只读服务标签，加载、失败和真空目录不回退 preview 数据',async()=>{
 const frame=await readFile(frameUrl,'utf8')
 const start=frame.indexOf('const [businessSpace')
 const end=frame.indexOf('const [savedIndustryLoads',start)
 assert.ok(start>=0&&end>start,'没有抓到业务目录装配段')
 const directory=frame.slice(start,end)
 assert.match(directory,/businessScopeApi\.list\(\)/)
 assert.match(directory,/useState<'loading'\|'ready'\|'failed'>\('loading'\)/)
 assert.match(directory,/setBusinessDirectoryStatus\('ready'\)/)
 assert.match(directory,/setBusinessDirectoryStatus\('failed'\)/)
 assert.match(directory,/const scopeLabels:readonly BusinessScopeLabel\[\]=businessScopeLabels/)
 assert.doesNotMatch(directory,/tasks\.business\.spaces/)
 assert.match(frame,/<BusinessHome labels=\{scopeLabels\} directory=\{\{status:businessDirectoryStatus,/)
})

test('业务首页与范围页都读取正式数据源实例，不再把行业模板声明当作已接入',async()=>{
 const frame=await readFile(frameUrl,'utf8')
 const homeStart=frame.indexOf('{businessLedgerHome&&<BusinessHome')
 const homeEnd=frame.indexOf('/>}',homeStart)
 assert.ok(homeStart>=0&&homeEnd>homeStart,'没有抓到业务首页装配段')
 const home=frame.slice(homeStart,homeEnd)
 assert.match(home,/dataSources=\{industryDataSources\}/)
 // 加载记录只喂卡上的七行摘要（`composeFromWorkspace`）；接入数仍然只认已授权的正式实例，两者不共用一个数。
 assert.match(home,/loads=\{savedIndustryLoads\}/)
 assert.match(home,/goComposition=\{openComposition\}/)

 const pageStart=frame.indexOf('<BusinessPage ')
 const pageEnd=frame.indexOf('/>',pageStart)
 assert.ok(pageStart>=0&&pageEnd>pageStart,'没有抓到业务范围页装配段')
 assert.match(frame.slice(pageStart,pageEnd),/dataSources=\{industryDataSources\}/)
})

test('七行的「去配置」只落到既有入口：没有为它新开页面，也没有第二套跳法',async()=>{
 const frame=await readFile(frameUrl,'utf8')
 const start=frame.indexOf('const openComposition=')
 const end=frame.indexOf('\n  }',start)
 assert.ok(start>=0&&end>start,'没有抓到七行落点的装配段')
 const route=frame.slice(start,end)
 for(const pattern of [
  /target\.kind==='team'\)openStaffOfScope\(target\.scope\)/,
  /target\.kind==='capabilities'\)actions\.navigate\('capabilities'\)/,
  /target\.kind==='knowledge'\)actions\.openResources\(\)/,
  /target\.kind==='connectors'\)\{actions\.rememberDirectory\('capabilities',\{category:writeDirectoryFilterCategory\(\{category:'source'/,
  /target\.kind==='plans'\)actions\.openPlans\(\{kind:'plans',scope:target\.scope\}\)/,
  /target\.kind==='market'\)openMarketCategory\(target\.category\)/,
  /enterBusiness\(\{scope:target\.scope as CollaborationScope,section:'overview'\}\)/,
 ])assert.match(route,pattern)
 // 自动化读真实的持续计划，归档的不算。
 assert.match(frame,/const businessCompositionPlans=savedPlans\.filter\(plan=>plan\.state!=='archived'\)/)
})
