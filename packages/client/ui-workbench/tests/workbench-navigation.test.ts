import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import {openAttentionItem,type AttentionItem} from '../src/client/attention-item.ts'
import {marketSkillInstallationSelection} from '../src/client/market-installation-selection.ts'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

const frameUrl=new URL('../src/client/WorkbenchFrame.tsx',import.meta.url)

// 客户端产物使用 .js 导入；源码直跑测试只为新增纯状态模块解析 .ts。
const sourceHooks=registerHooks({resolve(specifier,context,next){
  if(specifier==='./workbench-detail-target.js')return next('./workbench-detail-target.ts',context)
  if(specifier==='./workbench-navigation-state.js')return next('./workbench-navigation-state.ts',context)
  return next(specifier,context)
}})
const {createWorkbenchStore,shouldFollowCurrentSession}=await import('../src/client/store.ts')

test('读取任务成果的来源会话时，原生主面板同步不关闭独立成果面板',()=>{
 const store=createWorkbenchStore().create()
 store.actions.openTask('task-a')
 store.actions.openArtifacts({kind:'task',id:'task-a'})
 store.actions.selectPanel(null)
 assert.equal(store.getSnapshot().view,'tasks')
 assert.equal(store.getSnapshot().detail.open,true)
 store.actions.closeDetail()
 store.actions.selectPanel(null)
 assert.equal(store.getSnapshot().view,'messages')
})
sourceHooks.deregister()

test('窄屏导航进入原生设置目录后收起遮罩，其他入口保持相同行为',()=>{
  const store=createWorkbenchStore().create()
  store.actions.toggleNavigation()
  store.actions.openDirectory()
  assert.equal(store.getSnapshot().view,'settings')
  assert.equal(store.getSnapshot().directoryOpen,true)
  assert.equal(store.getSnapshot().navOpen,false)
  store.actions.toggleNavigation()
  store.actions.openResources('draft-1')
  assert.equal(store.getSnapshot().resourceDraftId,'draft-1')
  assert.equal(store.getSnapshot().navOpen,false)
  store.actions.toggleNavigation()
  store.actions.navigate('home')
  assert.equal(store.getSnapshot().view,'home')
  assert.equal(store.getSnapshot().navOpen,false)
})

test('会话保存回执打开本次工作资料，不沿用其他草案或旧资料目标',()=>{
  const store=createWorkbenchStore().create()
  store.actions.openResources('draft-1')
  store.actions.openResource('resource-1')
  const first=store.getSnapshot()
  assert.equal(first.view,'resources')
  assert.equal(first.resourceDraftId,null)
  assert.deepEqual(first.resourceTarget,{id:'resource-1',request:1})
  store.actions.openResources()
  assert.equal(store.getSnapshot().resourceTarget,null)
  store.actions.openResource('resource-1')
  assert.deepEqual(store.getSnapshot().resourceTarget,{id:'resource-1',request:2})
})

test('工作资料深链读取完成后只清理一次性目标并保留刷新选择',()=>{
  const store=createWorkbenchStore().create()
  store.actions.openResource('resource-1')
  store.actions.clearResourceTarget()
  const state=store.getSnapshot()
  assert.equal(state.resourceTarget,null)
  assert.equal(state.navigationDirectories.resources?.selectedId,'resource-1')
})

test('对话一级入口先打开统一目录，选择具体条目后再进入真实通道',()=>{
  const store=createWorkbenchStore().create()
  store.actions.openMessages('groups')
  store.actions.navigate('home')
  store.actions.closeSidebar()
  store.actions.openConversationDirectory()
  assert.equal(store.getSnapshot().view,'messages')
  assert.equal(store.getSnapshot().messageMode,'directory')
  assert.equal(store.getSnapshot().directoryOpen,true)
  store.actions.openMessages('native')
  assert.equal(store.getSnapshot().messageMode,'native')
  store.actions.openMessages('groups')
  store.actions.openDirectory()
  assert.equal(store.getSnapshot().view,'settings')
  assert.equal(store.getSnapshot().messageMode,'native')
  assert.equal(store.getSnapshot().directoryOpen,true)
})

test('会话搜索停留在统一目录根态，不把当前 DSH 会话冒充搜索结果页',()=>{
  const store=createWorkbenchStore().create()
  store.actions.closeSidebar()
  store.actions.focusConversationSearch()
  const state=store.getSnapshot()
  assert.equal(state.view,'messages')
  assert.equal(state.messageMode,'directory')
  assert.equal(state.directoryOpen,true)
  assert.equal(state.searchFocusRequest,1)
})

test('设置内部完成操作后返回进入前的工作视图且保留页面草稿身份',()=>{
  const store=createWorkbenchStore().create()
  store.actions.openResources('draft-1')
  store.actions.openDirectory()
  store.actions.openDirectory()
  store.actions.closeSettings()
  assert.equal(store.getSnapshot().view,'resources')
  assert.equal(store.getSnapshot().resourceDraftId,'draft-1')
})

test('首次会话恢复不抢占已打开页面，后续显式切换仍可跟随',()=>{
  assert.equal(shouldFollowCurrentSession(undefined,'session-1','settings'),false)
  assert.equal(shouldFollowCurrentSession(undefined,'session-1','home'),false)
  assert.equal(shouldFollowCurrentSession('session-1','session-1','home'),false)
  assert.equal(shouldFollowCurrentSession(undefined,'session-1','team'),false)
  assert.equal(shouldFollowCurrentSession('session-1','session-2','home'),false)
})

test('从任务返回来源话题保持消息身份并关闭窄屏导航，不切入原生会话',()=>{
  const store=createWorkbenchStore().create()
  store.actions.openTask('task-1')
  store.actions.toggleNavigation()
  store.actions.openGroupTopic('group-1','root-1')
  assert.equal(store.getSnapshot().view,'messages')
  assert.equal(store.getSnapshot().messageMode,'groups')
  assert.deepEqual(store.getSnapshot().groupTarget,{groupId:'group-1',rootId:'root-1'})
  assert.equal(store.getSnapshot().navOpen,false)
  store.actions.openTask('task-1')
  assert.equal(store.getSnapshot().taskId,'task-1')
  assert.equal(store.getSnapshot().view,'tasks')
})

test('进入需要你总是回到决策队列，清除旧任务选择但保留任务目录筛选',()=>{
  const store=createWorkbenchStore().create()
  store.actions.rememberDirectory('tasks',{query:'审计',category:'open'})
  store.actions.openTask('task-1')
  store.actions.toggleNavigation()
  store.actions.openAttention()
  const state=store.getSnapshot()
  assert.equal(state.view,'attention')
  assert.equal(state.taskId,null)
  assert.equal(state.navOpen,false)
  assert.deepEqual(state.navigationDirectories.tasks,{query:'审计',category:'open'})
})

test('绑定详情返回目录仍留在业务绑定，只有原生目录入口才切换页签',()=>{
  const store=createWorkbenchStore().create()
  store.actions.openBinding('binding-1')
  store.actions.openBinding(null)
  assert.equal(store.getSnapshot().capabilityMode,'bindings')
  assert.equal(store.getSnapshot().capabilityBindingId,null)
  store.actions.openCapabilityCatalog()
  assert.equal(store.getSnapshot().capabilityMode,'catalog')
  assert.equal(store.getSnapshot().view,'capabilities')
})

test('异常入口固定指定配置版本，普通打开不会沿用另一绑定的历史版本',()=>{
  const store=createWorkbenchStore().create()
  store.actions.openBinding('binding-a',2)
  assert.equal(store.getSnapshot().capabilityVersion,2)
  assert.equal(store.getSnapshot().capabilityBindingId,'binding-a')
  store.actions.openBinding('binding-b')
  assert.equal(store.getSnapshot().capabilityVersion,null)
  store.actions.openBinding(null)
  assert.equal(store.getSnapshot().capabilityBindingId,null)
})

test('统一待办目标使用现有任务、业务、计划、绑定和安装 action',()=>{
  const calls:unknown[][]=[]
  const actions={
    openTask:(id:string)=>calls.push(['task',id]),
    openArtifact:(source:unknown,id:string,version:number)=>calls.push(['artifact',source,id,version]),
    openGroup:(id:string)=>calls.push(['group',id]),
    openMarket:(id:string)=>calls.push(['market',id]),
    openIndustrySkill:(loadId:string,itemInstanceId:string)=>calls.push(['industry-skill',loadId,itemInstanceId]),
    openBusiness:(target:unknown)=>calls.push(['business',target]),
    openPlans:(target:unknown)=>calls.push(['plans',target]),
    openBinding:(id:string,version?:number)=>calls.push(['binding',id,version]),
    openInstallation:(id:string)=>calls.push(['installation',id]),
  }
  const base:Omit<AttentionItem,'id'|'target'>={kind:'review',source:'task',persistence:'saved',title:'待办',reason:{kind:'text',text:'核对'},scope:'general',occurredAt:'2026-09-13T08:00:00.000Z'}
  const targets:AttentionItem['target'][]=[
    {kind:'task',id:'task-1'},
    {kind:'artifact',source:{kind:'task',id:'task-1'},artifactId:'artifact-1',version:2},
    {kind:'group',id:'group-1'},
    {kind:'market',itemId:'market-1'},
    {kind:'industry-skill',loadId:'load-1',itemInstanceId:'item-1'},
    {kind:'business',target:{scope:'general',section:'analysis',id:'run-1'}},
    {kind:'run',id:'run-1'},
    {kind:'binding',id:'binding-1',version:2},
  ]
  targets.forEach((target,index)=>openAttentionItem({...base,id:'attention-'+index,target},actions))
  assert.deepEqual(calls,[
    ['task','task-1'],
    ['artifact',{kind:'task',id:'task-1'},'artifact-1',2],
    ['group','group-1'],
    ['market','market-1'],
    ['industry-skill','load-1','item-1'],
    ['business',{scope:'general',section:'analysis',id:'run-1'}],
    ['plans',{kind:'run',id:'run-1'}],
    ['binding','binding-1',2],
  ])
})

test('安装待办使用市场可解析的选择键并走真实安装维护 action',()=>{
  const store=createWorkbenchStore().create()
  const item:AttentionItem={id:'installation:installation-123',kind:'error',source:'installation',persistence:'example',target:{kind:'installation',selection:'skill:installation-123'},title:'研究 Skill',reason:{kind:'text',text:'安装结果待核对'},scope:'general',occurredAt:'2026-09-13T08:00:00.000Z'}
  openAttentionItem(item,{openTask:store.actions.openTask,openArtifact:()=>{},openGroup:()=>{},openMarket:store.actions.openMarket,openIndustrySkill:store.actions.openIndustrySkill,openBusiness:store.actions.openBusiness,openPlans:store.actions.openPlans,openBinding:store.actions.openBinding,openInstallation:store.actions.openInstallations})
  const state=store.getSnapshot()
  assert.equal(state.view,'market')
  assert.equal(state.marketMode,'installations')
  assert.equal(state.installationId,'skill:installation-123')
  assert.equal(marketSkillInstallationSelection(state.installationId),'installation-123')
})

test('行业 Skill 待办固定加载与资源实例身份，并打开含恢复控件的行业资源位置',()=>{
 const store=createWorkbenchStore().create()
 store.actions.openIndustrySkill('load-1','skill-instance-1')
 assert.equal(store.getSnapshot().view,'market')
 assert.equal(store.getSnapshot().marketMode,'industry-resources')
 assert.deepEqual(store.getSnapshot().industryResourceTarget,{loadId:'load-1',itemInstanceId:'skill-instance-1'})
})

test('行业资源工作台可从固定加载或业务空间进入且不新增一级模块',()=>{
 const store=createWorkbenchStore().create()
 store.actions.openIndustryResources({loadId:'load-1'})
 assert.equal(store.getSnapshot().view,'market')
 assert.equal(store.getSnapshot().marketMode,'industry-resources')
 assert.deepEqual(store.getSnapshot().industryResourceTarget,{loadId:'load-1'})
 store.actions.openIndustryResources({scope:'space-12345678-1234-4234-8234-123456789012'})
 assert.deepEqual(store.getSnapshot().industryResourceTarget,{scope:'space-12345678-1234-4234-8234-123456789012'})
})

test('行业资源筛选不持久化时刷新回到市场目录，避免空白资源页',()=>{
 const restored={schema:'teloa.workbench-navigation/v1' as const,view:'market' as const,messageMode:'native' as const,capabilityMode:'catalog' as const,marketMode:'industry-resources' as const,selected:{},directories:{},detail:{open:false,target:null}}
 const store=createWorkbenchStore('light',restored).create()
 assert.equal(store.getSnapshot().view,'market')
 assert.equal(store.getSnapshot().marketMode,'catalog')
 assert.equal(store.getSnapshot().industryResourceTarget,null)
})

test('rc.1 布局状态保留主面板选择和原生右栏呈现',()=>{
  const store=createWorkbenchStore().create()
  store.actions.selectPanel('workspace-settings' as MainPanelId)
  assert.equal(store.getSnapshot().panelInfo.activePanelId,'workspace-settings')
  store.actions.retainMainPanels(['conversation'])
  assert.equal(store.getSnapshot().panelInfo.activePanelId,null)
  // 右栏呈现与“开着哪个对象的详情”是两件互不替代的事：呈现单独记一份，detail 不被它覆盖。
  // 呈现只记“这条轨道该不该占位”：track 与 fullscreen 由 DSH 自己在右栏内部处置。
  store.actions.openRightbar()
  assert.deepEqual(store.getSnapshot().rightbar,{shown:true})
  assert.deepEqual(store.getSnapshot().detail,{open:false,target:null})
  store.actions.closeRightbar()
  assert.deepEqual(store.getSnapshot().rightbar,{shown:false})
})

test('原生插件页在设置中显示，关闭后仍可返回原先工作页面',()=>{
  const store=createWorkbenchStore().create()
  store.actions.openResources('draft-1')
  store.actions.selectPanel('plugins' as MainPanelId)
  assert.equal(store.getSnapshot().view,'settings')
  assert.equal(store.getSnapshot().panelInfo.activePanelId,'plugins')
  store.actions.openDirectory()
  assert.equal(store.getSnapshot().panelInfo.activePanelId,null)
  store.actions.closeSettings()
  assert.equal(store.getSnapshot().view,'resources')
  assert.equal(store.getSnapshot().resourceDraftId,'draft-1')
})

test('官方打开会话动作退出插件页并显示原生对话',()=>{
  const store=createWorkbenchStore().create()
  store.actions.selectPanel('plugins' as MainPanelId)
  store.actions.selectPanel(null)
  assert.equal(store.getSnapshot().view,'messages')
  assert.equal(store.getSnapshot().messageMode,'native')
  assert.equal(store.getSnapshot().panelInfo.activePanelId,null)
})

test('从插件页进入各业务入口时，原生面板不残留覆盖页面',()=>{
  const store=createWorkbenchStore().create()
  const routes=[
    ()=>store.actions.navigate('home'),()=>store.actions.openConversationDirectory(),
    ()=>store.actions.openMessages('groups'),()=>store.actions.openResources(),
    ()=>store.actions.openResource('resource-1'),()=>store.actions.openPlans(),
    ()=>store.actions.openAttention(),()=>store.actions.openTask('task-1'),
    ()=>store.actions.openRole('role-1'),()=>store.actions.openCapabilityCatalog(),
    ()=>store.actions.openMarket(),()=>store.actions.openGroupTopic('group-1','root-1'),
    ()=>store.actions.openBusiness({scope:'SOC',section:'overview'}),()=>store.actions.focusConversationSearch(),
  ]
  for(const route of routes){store.actions.selectPanel('plugins' as MainPanelId);route();assert.equal(store.getSnapshot().panelInfo.activePanelId,null)}
})

test('原生右栏呈现不占用详情这一格，迟到的原生关闭不关闭任何详情',()=>{
 const store=createWorkbenchStore().create()
 store.actions.openRightbar()
 store.actions.openArtifacts({kind:'session',id:'s1'})
 assert.deepEqual(store.getSnapshot().detail,{open:true,target:{kind:'artifact',source:{kind:'session',id:'s1'}}})
 store.actions.closeRightbar()
 assert.equal(store.getSnapshot().detail.open,true)
 // 会话对象详情已经占着这一格时，DSH 同步上来的 shown:true 不能把对象身份冲掉。
 store.actions.openConversationObject('s1',{kind:'task',id:'t9'})
 store.actions.openRightbar()
 assert.deepEqual(store.getSnapshot().detail.target,{kind:'conversation-object',sessionId:'s1',objectKind:'task',id:'t9'})
 store.actions.openArtifacts({kind:'task',id:'t1'},{id:'a1',version:2})
 assert.deepEqual(store.getSnapshot().detail.target,{kind:'artifact',source:{kind:'task',id:'t1'},artifactId:'a1',version:2})
 store.actions.openConversationObject('s1',{kind:'role',id:'r1',version:3})
 assert.deepEqual(store.getSnapshot().detail.target,{kind:'conversation-object',sessionId:'s1',objectKind:'role',id:'r1',version:3})
 store.actions.closeDetail()
 const target=store.getSnapshot().detail.target
 assert.equal(store.getSnapshot().detail.open,false)
 store.actions.openDetail(target!)
 assert.equal(store.getSnapshot().detail.open,true)
 store.actions.retainDetailForSession('s2')
 assert.deepEqual(store.getSnapshot().detail,{open:false,target:null})
 // 页签是真源：切回 s1 时它自己的详情回来，页签正文的“关闭”不再是死控件。
 assert.deepEqual(store.getSnapshot().detailSeeds,{s1:target})
 store.actions.retainDetailForSession('s1')
 assert.deepEqual(store.getSnapshot().detail,{open:true,target})
 const state=store.getSnapshot()
 for(const field of ['detailsOpen','producedFile'])assert.equal(field in state,false,field)
})

/**
 * 能力页接线：目录筛选白名单改四行 id、`{kind:'connectors'}` 落点改「接入源」分节、
 * `TeamCapabilitiesPage` 补齐跨业务四行取数所需的三个 props。这几处只靠源码正则钉，
 * 因为 `WorkbenchFrame.tsx` 本身太大，不值得为它另起一套渲染测试基础设施。
 */
test('能力页目录筛选白名单改四行 id，旧持久值 connection 不在名单内',async()=>{
 const frame=await readFile(frameUrl,'utf8')
 assert.match(frame,/const capabilityNavigation=readDirectoryFilterCategory\(state\.navigationDirectories\.capabilities\?\.category,\{category:'skill',mobileLayer:'category'\},\{category:\['skill','source','method','extension'\],mobileLayer:\['category','list','detail'\]\}\)/)
 assert.doesNotMatch(frame,/category:\['skill','connection'\]/)
})

test('业务面板「接入」落点改记忆「接入源」分节，不再写旧的 connection 值',async()=>{
 const frame=await readFile(frameUrl,'utf8')
 const start=frame.indexOf('const openComposition=')
 const end=frame.indexOf('\n  }',start)
 assert.ok(start>=0&&end>start,'没有抓到七行落点的装配段')
 const route=frame.slice(start,end)
 assert.match(route,/target\.kind==='connectors'\)\{actions\.rememberDirectory\('capabilities',\{category:writeDirectoryFilterCategory\(\{category:'source',mobileLayer:'list'\}\)\}\);actions\.navigate\('capabilities'\)\}/)
 assert.doesNotMatch(route,/category:'connection'/)
})

test('能力页保留业务名称和共享派发，任务模板目录不接收自动化计划',async()=>{
 const frame=await readFile(frameUrl,'utf8')
 const start=frame.indexOf('<TeamCapabilitiesPage ')
 const end=frame.indexOf('/>',start)
 assert.ok(start>=0&&end>start,'没有抓到能力页装配段')
 const wiring=frame.slice(start,end)
 assert.doesNotMatch(wiring,/plans=/)
 assert.match(wiring,/businessNames=\{localizedScopeNames\}/)
 assert.match(wiring,/go=\{openComposition\}/)
})

test('扩展的页内新建入口重新接上能力页，WorkbenchFrame 把真实插件安装 API 与市场落点一起交给它',async()=>{
 const frame=await readFile(frameUrl,'utf8')
 const start=frame.indexOf('<TeamCapabilitiesPage ')
 const end=frame.indexOf('/>',start)
 assert.ok(start>=0&&end>start,'没有抓到能力页装配段')
 const wiring=frame.slice(start,end)
 assert.match(wiring,/marketPluginInstallApi:marketPluginInstallApi/)
 assert.match(wiring,/openExtensionMarket:\(\)=>openMarketCategory\('plugin'\)/)
 const page=await readFile(new URL('../src/client/TeamCapabilitiesPage.tsx',import.meta.url),'utf8')
 assert.match(page,/import \{ExtensionCreateEntry\} from '\.\/ExtensionCreateEntry\.js'/)
 assert.match(page,/category==='extension'&&pageCreate\?\.marketPluginInstallApi&&<div[^>]*><CreateEntry entity="extension"/)
 assert.match(page,/<ExtensionCreateEntry preview=\{preview\} api=\{pageCreate\.marketPluginInstallApi!\} apply=\{apply\}\/>/)
})

test('业务首页新建开启独立搭建；技能页仍准备普通会话，不把草稿名当正式业务范围',async()=>{
 const frame=await readFile(frameUrl,'utf8')
 const ast=ts.createSourceFile('WorkbenchFrame.tsx',frame,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 const attribute=(tag:string,name:string)=>{
  let found:ts.Expression|undefined
  const visit=(node:ts.Node)=>{
   if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText()===tag){
    const prop=node.attributes.properties.find(prop=>ts.isJsxAttribute(prop)&&prop.name.getText()===name) as ts.JsxAttribute|undefined
    if(prop?.initializer&&ts.isJsxExpression(prop.initializer))found=prop.initializer.expression
   }
   ts.forEachChild(node,visit)
  }
  visit(ast);assert.ok(found,'没有找到实际装配：'+tag+'.'+name);return found
 }
 const intents:unknown[]=[],requestCreation=(intent:unknown)=>intents.push(intent)
 const addBusiness=new Function('requestCreation','return '+attribute('BusinessHome','addBusiness').getText())(requestCreation) as ()=>void
 addBusiness()
 const pageCreate=attribute('TeamCapabilitiesPage','pageCreate') as ts.ObjectLiteralExpression
 const prepare=pageCreate.properties.find(prop=>ts.isPropertyAssignment(prop)&&prop.name.getText()==='prepare') as ts.PropertyAssignment
 assert.ok(prepare)
 const prepareSkill=new Function('requestCreation','return '+prepare.initializer.getText())(requestCreation) as (prompt:{text:string;sourceId:string})=>void
 prepareSkill({text:'帮我创建技能',sourceId:'skill:草稿显示名'})
 assert.deepEqual(intents,[{builder:true},{goal:'帮我创建技能'}])
})

test('设置页「前往市场「扩展」」经 store 发出类目请求：市场页已挂载时也按新 serial 切到扩展类目',async()=>{
 const store=createWorkbenchStore().create()
 assert.deepEqual(store.getSnapshot().marketCategoryRequest,{category:'home',serial:0})
 store.actions.openDirectory()
 store.actions.closeSettings()
 store.actions.openMarketCategory('plugin')
 assert.equal(store.getSnapshot().view,'market')
 assert.equal(store.getSnapshot().marketMode,'catalog')
 assert.deepEqual(store.getSnapshot().marketCategoryRequest,{category:'plugin',serial:1})
 // 同一类目再点一次也换新 serial，市场页才会再落定一次。
 store.actions.openMarketCategory('plugin')
 assert.deepEqual(store.getSnapshot().marketCategoryRequest,{category:'plugin',serial:2})
 const frame=await readFile(frameUrl,'utf8')
 assert.match(frame,/const openMarketCategory=\(category:MarketCategory\|'home'\)=>actions\.openMarketCategory\(category\)/)
 assert.match(frame,/<MarketPage [^\n]*forceCategory=\{state\.marketCategoryRequest\}/)
 const index=await readFile(new URL('../src/client/index.ts',import.meta.url),'utf8')
 assert.match(index,/openMarket:\(\)=>\{const bound=requireActions\(\);[^}]*\}\)\}\);bound\.closeSettings\(\);bound\.openMarketCategory\('plugin'\)\}/)
})
