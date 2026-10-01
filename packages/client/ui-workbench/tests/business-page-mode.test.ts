import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import {BUSINESS_PAGE_MESSAGE_ROWS} from '../src/client/i18n/locales/business-page.ts'
import {businessPageSurface,businessSectionAwayFromLedger} from '../src/client/business-page-mode.ts'
import {businessHomeSources} from '../src/client/business-home-presentation.ts'
import * as composition from '../src/client/industry-composition.ts'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
import type {IndustryDataSourceInstance} from '../src/client/industry-data-source-api.ts'

type Node={type:unknown;props:Record<string,any>;children:Node[]}
const nodes=(node:unknown):Node[]=>node&&typeof node==='object'&&'children' in (node as Node)
 ?[node as Node,...(node as Node).children.flatMap(child=>Array.isArray(child)?child.flatMap(nodes):nodes(child))]
 :[]
const text=(node:unknown):string=>typeof node==='string'?node:typeof node==='number'?String(node):node&&typeof node==='object'?((node as Node).children??[]).map(text).join(''):''

const dataSource=(id:string,scope:string,state:'needs_authorization'|'active'):IndustryDataSourceInstance=>{
 const stamp='2026-09-16T01:00:00.000Z'
 const base={id,ownerId:'local:teloa-owner',loadId:'load-'+id,itemInstanceId:'item-'+id,itemLocalId:'source-'+id,contentId:'content-'+id,contentHash:'a'.repeat(64),itemVersion:'1.0.0',scope,createdAt:stamp,updatedAt:stamp}
 return state==='active'
  ? {...base,state,revision:2,binding:{sourceId:'source-'+id,scopes:[scope],definitionHash:'b'.repeat(64),probedAt:stamp}}
  : {...base,state,revision:1,binding:null}
}

const [pageSource,styles]=await Promise.all([
 readFile(new URL('../src/client/BusinessPage.tsx',import.meta.url),'utf8'),
 readFile(new URL('../src/client/BusinessPage.module.css',import.meta.url),'utf8'),
])

test('真实业务模式按 B3 在概览直接呈现对象台账，目录与详情仍走 data 深链',()=>{
 assert.equal(businessPageSurface({mode:'real',section:'overview',scope:'SOC'}),'real-ledger')
 assert.equal(businessPageSurface({mode:'real',section:'overview',scope:'AppSec'}),'real-ledger')
 assert.equal(businessPageSurface({mode:'real',section:'analysis',scope:'SOC'}),'real-section')
 assert.doesNotMatch(pageSource,/function BusinessCurrent/)
 assert.match(pageSource,/const ledgerVisible=target\.section==='overview'\|\|target\.section==='data'/)
 assert.match(pageSource,/ledgerVisible&&<BusinessLedgerSurface/)
})

test('正式业务页只呈现真实目录，示例状态没有产品入口',()=>{
 assert.equal(businessPageSurface({mode:'real',section:'data',scope:'SOC'}),'real-directory')
 assert.doesNotMatch(pageSource,/真实数据 \+ 界面示例/)
 assert.doesNotMatch(pageSource,/页面示例仍在下方/)
 assert.doesNotMatch(pageSource,/aria-label=\{t\('business\.mode\.aria'\)\}/)
 assert.doesNotMatch(pageSource,/t\('business\.mode\.enterSandbox'\)/)
 assert.doesNotMatch(pageSource,/initialMode/)
 assert.doesNotMatch(pageSource,/sandbox-(?:ledger|directory|section)/)
 assert.doesNotMatch(pageSource,/BusinessDataSourceSummary|AnalysisDetail|OperationDetail|BusinessForm/)
})

test('对象台账恢复为业务首屏，旧的大盘与四宫格不会回流',()=>{
 assert.equal(businessPageSurface({mode:'real',section:'overview',scope:'SOC'}),'real-ledger')
 assert.equal(businessPageSurface({mode:'real',section:'projects',scope:'SOC'}),'project-workspace')
 for(const pattern of [/GuidedSetup/,/businessGuideSteps/,/business\.overview\./])assert.doesNotMatch(pageSource,pattern)
 for(const removed of ['business.section.overview','business.overview.flowTitle','business.overview.stage.data.title','business.overview.capabilities.title'])
  assert.ok(!BUSINESS_PAGE_MESSAGE_ROWS.some(row=>row[0]===removed),removed)
 for(const pattern of [/\.overviewLead\{/,/\.pulseStamp\{/,/\.overviewWork/,/\.overviewAside/,/\.activityList/,/\.sectionTitle/])assert.doesNotMatch(styles,pattern)
 assert.doesNotMatch(styles,/\.primarySections\{/)
})

test('范围内页不再摆三入口页签，更多菜单接收当前业务范围',()=>{
 const view=mountPage(pageProps())
 assert.equal(nodes(view).filter(node=>node.props.className==='primarySections').length,0)
 const bar=nodes(view).find(node=>node.props.className==='scopeBar')!
 const more=nodes(bar).find(node=>node.type==='business-more-menu')!
 assert.equal(more.props.scope,'SOC')
 assert.equal(typeof more.props.choose,'function')
 for(const section of ['overview','data'])
  assert.equal(nodes(mountPage(pageProps({target:{scope:'SOC',section}}))).filter(node=>node.props.className==='backLedger').length,0,section)
 for(const section of ['projects','analysis','execution']){
  assert.ok(businessSectionAwayFromLedger(section as never),section)
  assert.equal(nodes(mountPage(pageProps({target:{scope:'SOC',section}}))).filter(node=>node.props.className==='backLedger').length,1,section)
 }
 assert.equal(businessSectionAwayFromLedger('work'),true)
 assert.equal(nodes(mountPage(pageProps({target:{scope:'SOC',section:'work'}}))).filter(node=>node.props.className==='backLedger').length,1)
 assert.ok(text(mountPage(pageProps({target:{scope:'SOC',section:'work'}}))).includes('business.done.empty.title'))
 for(const section of ['analysis','execution'])
  assert.ok(text(mountPage(pageProps({target:{scope:'SOC',section}}))).includes('business.connection.guideTitle'),section)
})

test('数据页由真实台账提供筛选，不再额外显示不可操作的全部状态按钮',()=>{
 const view=mountPage(pageProps({target:{scope:'SOC',section:'data'}}))
 assert.equal(nodes(view).filter(node=>node.props.className==='filterPills').length,0)
 assert.equal(nodes(view).filter(node=>node.type==='button'&&text(node)==='business.directory.stage.all').length,0)
})

/**
 * 把 `BusinessPage` 转译进测试进程渲染（与 `business-home.test.ts` 同一手法）：
 * 页头这几件事看渲染出来的节点，不再用正则去钉 JSX 字面（复审 L7）。
 */
function mountPage(props:Record<string,unknown>){
 return pageHarness().render(props)
}

/**
 * 需要看副作用（例如面板的看板行要等台账回话）的用例用这个：先渲染一次、跑掉 `useEffect`、
 * 等一圈微任务，再渲染第二次。状态就地改写，因此第二次渲染读到的是副作用写回去的值。
 */
function pageHarness(){
 const source=readFileSync(new URL('../src/client/BusinessPage.tsx',import.meta.url),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const states:unknown[]=[];let cursor=0
 const effects:Array<()=>unknown>=[]
 const createElement=(type:any,props:Record<string,unknown>|null,...children:unknown[]):any=>{
  const node={type,props:props??{},children:children.flat(Infinity)}
  return typeof type==='function'&&/^[A-Z]/.test(String(type.name))?type({...node.props,children:node.children}):node
 }
 const React={
  createElement,
  useState:(initial:unknown)=>{const index=cursor++;if(!(index in states))states[index]=typeof initial==='function'?(initial as ()=>unknown)():initial;return [states[index],(value:unknown)=>{states[index]=typeof value==='function'?(value as (previous:unknown)=>unknown)(states[index]):value}]},
  useRef:(value:unknown)=>{const index=cursor++;return states[index]??(states[index]={current:value})},
  useEffect:(effect:()=>unknown)=>{effects.push(effect)},useLayoutEffect:()=>{},useMemo:(factory:()=>unknown)=>factory(),
 }
 const cssProxy=new Proxy({},{get:(_,key)=>String(key)})
 const require=(id:string)=>{
  if(id==='react')return React
  if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
  if(id.endsWith('business-scope-context.js'))return {useBusinessScopes:()=>({SOC:'安全运营'})}
  if(id.endsWith('business-page-mode.js'))return {businessPageSurface,businessSectionAwayFromLedger,businessTargetMissing:()=>false}
  if(id.endsWith('business-preview.js'))return {queryObjects:()=>[],objectRef:(ref:unknown)=>ref,projectTypeLabel:()=>'project.type.general'}
  if(id.endsWith('business-home-presentation.js'))return {businessHomeSources,businessHomeStaff:()=>[{id:'r1'},{id:'r2'}]}
  if(id.endsWith('industry-composition.js'))return composition
  if(id.endsWith('business-current-presentation.js'))return {businessCurrentTasks:()=>[],businessCurrentWaiting:()=>[],businessCompletedTasks:()=>[]}
  // 声明行按 `IndustryResourceDeclarations` 真实读到的那几项给全，否则「更多」进来的目录那一档一渲染就炸。
  if(id.endsWith('industry-workspace-projection.js'))return {projectIndustryWorkspace:()=>[1,2,3].map(index=>({destination:'business-data',instanceId:'instance-'+index,title:'来源 '+index,kind:'data-source',version:1,required:true,source:{spaceName:'本人空间',templateTitle:'模板',templateId:'template-1',templateVersion:'1.0.0',contentHash:'a'.repeat(64)}}))}
  if(id.endsWith('workbench-navigation-state.js'))return {readDirectoryFilterCategory:()=>({mode:'real',source:'all',quality:'all',period:'all',analysis:'all',execution:'all'}),writeDirectoryFilterCategory:()=>''}
  if(id.endsWith('business-task-presentation.js'))return {businessTasksForMode:()=>[],persistentSocAssignees:()=>[],BusinessTaskActionPanel:()=>null}
  if(id.endsWith('BusinessMoreMenu.js'))return {BusinessMoreMenu:function BusinessMoreMenu(props:Record<string,unknown>){return createElement('business-more-menu',props)}}
  if(id.endsWith('provider.js'))return {useI18n:()=>({locale:'zh-CN',t:(key:string,params?:Record<string,unknown>)=>params?key+':'+JSON.stringify(params):key,number:(value:number)=>String(value),dateTime:(value:string)=>value})}
  if(id.endsWith('.css'))return {default:cssProxy}
  return new Proxy({default:cssProxy},{get:(_,key)=>key==='default'?cssProxy:()=>'none'})
 }
 const exports:Record<string,any>={}
 new Function('require','exports','React',js)(require,exports,React)
 return {
  render:(props:Record<string,unknown>)=>{cursor=0;return exports.BusinessPage(props) as Node},
  flush:async()=>{for(const effect of effects.splice(0))effect();await new Promise(resolve=>setTimeout(resolve,0))},
 }
}

const pageProps=(patch:Record<string,unknown>={})=>({
 embedded:false,visible:true,backHome:()=>{},openStaff:()=>{},manageIndustryResources:()=>{},industryLoads:[],dataSources:[],
 openArtifacts:()=>{},state:{roles:[],tasks:[],business:{loaded:false,objects:[],runs:[],operations:[],projects:[],flows:[]}},
 target:{scope:'SOC',section:'overview'},go:()=>{},change:()=>{},examples:()=>{},openTask:()=>{},openWork:()=>{},messages:()=>{},groups:()=>{},
 team:()=>{},resources:()=>{},teamCapabilities:()=>{},market:()=>{},nativeSettings:()=>{},capabilities:()=>null,openPlans:()=>{},
 businessLedgerApi:{},businessCustomizationApi:{},pageCreate:{api:{},prepare:()=>{},openMarket:()=>{}},businessTaskApi:{pending:()=>undefined},createBusinessTask:async()=>{},recoverBusinessTask:async()=>{},
 ...patch,
})

test('范围内页页头不再管理业务空间：没有空间名、没有范围下拉，也没有治理菜单',()=>{
 // 个人版只有一个空间，「只有一个的东西不命名」：管理菜单、范围下拉与空间名一起摘掉，词条随实现一起删。
 for(const pattern of [/business\.workspace\.manageAria/,/business\.workspace\.create/,/business\.workspace\.editCurrent/,/business\.scope\.switcherAria/,/navigation\.spaceFallback/,/edition\.personal\.subtitle/,/business\.workspace\.principle/,/spaceMenu/,/BusinessSpaceForm/,/EditionGate/])
  assert.doesNotMatch(pageSource,pattern)
 const view=mountPage(pageProps())
 // 页头只剩「← 业务台账」与范围标题；页头里既没有范围切换器也没有治理菜单。
 const header=nodes(view).find(node=>node.props.className==='pageHeader')!
 assert.equal(text(nodes(view).find(node=>node.type==='h1')),'安全运营')
 assert.deepEqual(nodes(header).filter(node=>node.type==='button').map(text),['business.scope.backHome'])
 assert.equal(nodes(header).filter(node=>node.type==='select'||node.type==='details').length,0)
 // 嵌入态（右栏页签）不给「← 业务台账」。
 const tab=mountPage(pageProps({embedded:true,openFull:()=>{}}))
 assert.ok(!text(nodes(tab).find(node=>node.props.className==='pageHeader')).includes('business.scope.backHome'))
 // 孤儿样式随引用一起清理。
 assert.doesNotMatch(styles,/\.spaceMenu[>{]/)
 assert.doesNotMatch(styles,/\.intro\{/)
})

test('范围摘要条照原型摆三条「图标 + 人话 + 数」，右端只保留业务内操作',()=>{
 const staff:string[]=[]
 const dataSources=[dataSource('active-1','SOC','active'),dataSource('pending','SOC','needs_authorization'),dataSource('active-2','SOC','active'),dataSource('other','AppSec','active')]
 const view=mountPage(pageProps({automations:4,dataSources,openStaff:(scope:string)=>staff.push(scope)}))
 const bar=nodes(view).find(node=>node.props.className==='scopeBar')!
 // 原型 `业务对象方案.jsx` 的 dl：每一条先说这是什么（dt），再给数（dd）。
 const stats=nodes(bar).filter(node=>node.props.className==='scopeStat')
 assert.equal(nodes(bar).find(node=>node.props.className==='scopeStats')!.type,'dl')
 assert.deepEqual(stats.map(stat=>text(nodes(stat).find(node=>node.type==='dt'))),[
  'business.scope.stat.sources',
  'business.scope.stat.staff',
  'business.scope.stat.automations',
 ])
 // 三个数都走当地数字格式；来源数只认当前业务里已授权的正式实例，模板声明、待授权和别的业务都不算。
 assert.deepEqual(stats.map(stat=>text(nodes(stat).find(node=>node.type==='dd'))),[
  'business.scope.stat.sourcesValue:'+JSON.stringify({n:'2'}),
  'business.scope.stat.staffValue:'+JSON.stringify({n:'2'}),
  'business.scope.stat.automationsValue:'+JSON.stringify({n:'4'}),
 ])
 const pendingBar=nodes(mountPage(pageProps({dataSources:[dataSource('pending-only','SOC','needs_authorization')]}))).find(node=>node.props.className==='scopeBar')!
 const pendingSource=nodes(pendingBar).filter(node=>node.props.className==='scopeStat')[0]!
 assert.equal(text(nodes(pendingSource).find(node=>node.type==='dd')),'business.scope.stat.sourcesValue:'+JSON.stringify({n:'0'}),'待授权实例必须显示 0 个来源已接上')
 // 每条 dt 都带一个图标，说明这是什么类型的数。
 for(const stat of stats)assert.equal(nodes(stat).filter(node=>typeof node.type==='function').length,1)
 // 自动化数读不到就整项不摆，不拿 0 冒充「一个都没有」。
 const withoutAutomations=nodes(mountPage(pageProps())).find(node=>node.props.className==='scopeBar')!
 assert.deepEqual(nodes(withoutAutomations).filter(node=>node.props.className==='scopeStat').length,2)
 // 「看这队的同事 →」把当前范围交给调用方；嵌入态（右栏页签）不给这个入口，免得把主视图带走。
 nodes(bar).find(node=>node.props.className==='scopeStaff')!.props.onClick()
 assert.deepEqual(staff,['SOC'])
 const embeddedBar=nodes(mountPage(pageProps({embedded:true,openFull:()=>{}}))).find(node=>node.props.className==='scopeBar')!
 assert.equal(nodes(embeddedBar).filter(node=>node.props.className==='scopeStaff').length,0)
 // 摘要条自己带读屏名；真实数据状态不再用“真实／示例”胶囊占位。
 assert.equal(bar.type,'section')
 assert.equal(bar.props['aria-label'],'business.scope.barAria')
 assert.equal(bar.props.role,undefined)
 assert.equal(nodes(bar).filter(node=>node.props.className==='modeSwitch').length,0)
 // 摘要条本身：底边线 + 基线对齐。
 assert.match(styles,/\.scopeBar\{[^}]*align-items:flex-end/)
 assert.match(styles,/\.scopeBar\{[^}]*border-bottom:1px solid var\(--teloa-border\)/)
})

test('页头文字按钮在窄屏仍有至少 44px 的触控目标',()=>{
 const mobile=styles.match(/@media\(max-width:740px\)\{[^@]*\.page \.backHome\{min-height:44px\}[^@]*/)
 assert.ok(mobile,'缺少 740px 以下的触控目标兜底')
 assert.ok(mobile![0].includes('.page .scopeStaff{min-height:44px}'))
 // 桌面态也不能把 TaskPage 的按钮高度压成 0：文字按钮仍留 28px 命中区。
 for(const name of ['.page .backHome','.page .scopeStaff'])assert.match(styles,new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\{[^}]*min-height:28px'))
})

const load=(scope:string,items:readonly {kind:string;title:string;status?:string}[]):IndustryLoadRecord=>({
 id:'load-'+scope,ownerId:'local:teloa-owner',contentId:'content-'+scope,contentHash:'a'.repeat(64),
 templateId:'template-'+scope,templateVersion:'1.0.0',templateTitle:'模板',domain:'domain',scope,description:'',targetVersion:1,
 space:{id:'11111111-1111-4111-8111-111111111111',name:'空间',version:1,scope},
 items:items.map((item,index)=>({localId:'local-'+index,instanceId:'instance-'+index,kind:item.kind,title:item.title,version:'1.0.0',required:true,status:item.status??'active'})),
 relations:[],entrypoints:[],createdAt:'2026-09-16T01:00:00.000Z',mappingHash:'b'.repeat(64),status:'active',
} as unknown as IndustryLoadRecord)

test('「这个业务有什么」：七行按共享模块的顺序摆开，每项一句状态词加一个「去配置」',()=>{
 const went:unknown[]=[]
 const industryLoads=[load('SOC',[
  {kind:'skill',title:'研判'},{kind:'knowledge',title:'处置手册'},{kind:'data-source',title:'接入一'},
  {kind:'object-type',title:'工单'},{kind:'work-template',title:'日常处置'},{kind:'plugin',title:'扩展一',status:'instantiated'},
 ]),load('AppSec',[{kind:'skill',title:'别的业务的技能'}])]
 const view=mountPage(pageProps({
  industryLoads,
  state:{roles:[{id:'r1',name:'值班员',kind:'employee',state:'active',scopes:['SOC']},{id:'t1',name:'我的分身',kind:'twin',state:'active',scopes:['SOC']}],tasks:[],business:{loaded:false,objects:[],runs:[],operations:[],projects:[],flows:[]}},
  plans:[{scope:'SOC',state:'active',title:'每日巡检'},{scope:'AppSec',state:'active',title:'别的业务的自动化'}],
  goComposition:(target:unknown)=>went.push(target),
 }))
 const bar=nodes(view).find(node=>node.props.className==='scopeBar')!
 const panel=nodes(bar).find(node=>node.props.className==='composition')!
 assert.equal(panel.type,'details','面板走原生 <details>，不是自己搭的弹层')
 assert.equal(text(nodes(panel).find(node=>node.type==='summary')),'business.composition.panel')
 // 七行主标签与副标逐字来自共享模块，顺序就是模块里的固定顺序。
 const rows=nodes(panel).filter(node=>node.type==='section')
 assert.deepEqual(rows.map(row=>text(nodes(row).find(node=>node.type==='h3'))),
  composition.COMPOSITION_ROWS.map(row=>row.label+row.question))
 // 每一项：名字 + 状态词 +「去配置」；状态词只能是词表里的那几条。
 const items=nodes(panel).filter(node=>node.type==='li')
 // 这一例没有台账（宿主还没回话）：看板行按加载声明回落，说「还没进数据」；资料行在岗即「已固定版本」。
 assert.deepEqual(items.map(item=>text(nodes(item).find(node=>node.type==='em'))),[
  'composition.state.active','composition.state.defaultTwin','composition.state.installed','composition.state.pinnedVersion',
  'composition.state.connected','composition.state.noData','composition.state.available','composition.state.active',
  'extension.unverified',
 ])
 // 默认分身如实列出并标「默认分身」；别的业务的东西不串进来。
 assert.ok(text(panel).includes('我的分身')&&text(panel).includes('composition.state.defaultTwin'))
 assert.ok(!text(panel).includes('别的业务的'))
 // 接入源每条带一句模式副标。
 assert.ok(text(items.find(item=>text(item).includes('接入一'))!).includes('composition.mode.read'))
 // 「去配置」把落点交给宿主：共享的技能与接入去配置页，业务自有的东西回这个业务。
 const configure=nodes(panel).filter(node=>node.type==='button'&&text(node)==='business.composition.configure')
 assert.equal(configure.length,items.length)
 for(const button of configure)button.props.onClick()
 assert.deepEqual(went,[
  {kind:'team',scope:'SOC'},{kind:'team',scope:'SOC'},{kind:'capabilities'},{kind:'knowledge'},{kind:'connectors'},
  {kind:'business',scope:'SOC',section:'local-3'},{kind:'business',scope:'SOC'},{kind:'plans',scope:'SOC'},
  {kind:'extension',instanceId:'instance-5'},
 ])
 // 组件里不出现行业名词，面板的字全是词条键与加载记录里的标题。
 for(const word of ['SOC','告警','资产','Splunk'])assert.ok(!text(panel).includes(word),word)
})

test('面板的两条空态句只给接入源与业务看板，别的行没有就整行不摆',()=>{
 const view=mountPage(pageProps({
  industryLoads:[load('SOC',[{kind:'skill',title:'研判'}])],
  state:{roles:[],tasks:[],business:{loaded:false,objects:[],runs:[],operations:[],projects:[],flows:[]}},
  goComposition:()=>{},
 }))
 const panel=nodes(view).find(node=>node.props.className==='composition')!
 const rows=nodes(panel).filter(node=>node.type==='section')
 assert.deepEqual(rows.map(row=>text(nodes(row).find(node=>node.type==='h3'))),
  ['composition.row.skillcomposition.question.skill','composition.row.sourcecomposition.question.source','composition.row.boardcomposition.question.board'])
 assert.deepEqual(nodes(panel).filter(node=>node.type==='p').map(text),['composition.empty.source','composition.empty.board'])
 // 没有 goComposition 就没有「去配置」可点，面板整块不摆，免得摆一个点不动的入口。
 assert.equal(nodes(mountPage(pageProps())).filter(node=>node.props.className==='composition').length,0)
})

test('面板的看板行读真实台账：拿到台账后逐块如实说，不再一律回落成「还没进数据」',async()=>{
 const ledger={
  schema:'teloa.business-ledger/v1',scope:'SOC',computedAt:'2026-09-20T00:00:00.000Z',actions:[],
  blocks:[
   {objectType:{source:{},definition:{id:'alpha',title:'工单'}},objects:3,source:{sourceId:'src',connected:true},missingFields:[],views:[{},{}]},
   {objectType:{source:{},definition:{id:'beta',title:'资产台账'}},objects:0,source:{sourceId:'src',connected:true},missingFields:['owner'],views:[]},
  ],
 }
 const reads:unknown[]=[]
 const harness=pageHarness()
 const props=pageProps({
  industryLoads:[load('SOC',[{kind:'object-type',title:'工单'}])],
  goComposition:()=>{},
  businessLedgerApi:{read:async(request:unknown)=>{reads.push(request);return ledger}},
 })
 harness.render(props)
 await harness.flush()
 const panel=nodes(harness.render(props)).find(node=>node.props.className==='composition')!
 const board=nodes(panel).filter(node=>node.type==='section')
  .find(row=>text(nodes(row).find(node=>node.type==='h3')).startsWith('composition.row.board'))!
 // 状态来自块：有数据、缺字段各说各的；台账里有而声明里没有的那一类也列出来。
 assert.deepEqual(nodes(board).filter(node=>node.type==='li').map(item=>text(nodes(item).find(node=>node.type==='em'))),
  ['composition.state.hasData','composition.state.missingField'])
 assert.ok(text(board).includes('资产台账'))
 // 面板按范围读一次全量，不带 objectType 收窄，也不为一次渲染连发两回。
 assert.deepEqual(reads,[{scope:'SOC'}])
})

test('面板宽度按容器算：挂在摘要条上右对齐，嵌入态右栏不会横向溢出',()=>{
 assert.match(styles,/\.scopeBar\{[^}]*position:relative/)
 assert.match(styles,/\.compositionRows\{[^}]*right:0/)
 assert.match(styles,/\.compositionRows\{[^}]*width:min\(640px,100%\)/)
 assert.doesNotMatch(styles,/\.compositionRows\{[^}]*100vw/)
})

test('面板在窄屏收成单列',()=>{
 assert.match(styles,/\.compositionRows\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
 assert.match(styles,/@media\(max-width:740px\)\{\.compositionRows\{grid-template-columns:1fr\}\}/)
})

test('看板栏目离开台账、走真实分区面（business-page-mode 不改即成立）',()=>{
 assert.equal(businessSectionAwayFromLedger('dashboards'),true)
 assert.equal(businessPageSurface({mode:'real',section:'dashboards',scope:'SOC'}),'real-section')
})
