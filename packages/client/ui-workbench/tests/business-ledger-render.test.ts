import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {readBusinessLedger} from '../src/client/business-ledger-api.ts'
import {block,ledger,ledgerObject,listView,otherLedger,viewResult} from './business-ledger-fixtures.ts'

// 和 attention-decision-card.test.ts 同样的取巧：.tsx 走 tsc 产物，CSS Modules 换成类名代理。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {BusinessLedgerView}=await import('../lib/types/client/BusinessLedger.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

type TestLocale='zh-CN'|'en'
const runtime=(locale:TestLocale)=>({t:(key:string,params?:Record<string,string|number>)=>translateMessage(locale,key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale,dshLocale:locale==='en'?'en':'zh',revision:1})})
const paint=(props:Record<string,unknown>,locale:TestLocale='zh-CN')=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime(locale) as never},createElement(BusinessLedgerView as never,{go:()=>{},connect:()=>{},...props} as never)))
const render=async(value:unknown,props:Record<string,unknown>={},locale:TestLocale='zh-CN')=>paint({ledger:await readBusinessLedger(value,String((value as {scope:string}).scope)),...props},locale)

test('五档空态各有固定文案与可操作的下一步',async()=>{
 // 1 范围下没有对象类型声明
 assert.match(await render(ledger({blocks:[]})),/暂无可显示的业务数据/)
 // 2 有声明、数据源未连接
 const disconnected=await render(ledger({blocks:[block({connected:false,objects:0})]}),{objectType:'alert-ticket'})
 assert.match(disconnected,/数据源未连接/)
 assert.match(disconnected,/去连接这个来源/)
 // 3 已进入对象目录、已连接、零对象：不画空图
 const empty=await render(ledger({blocks:[block({objects:0})]}),{objectType:'alert-ticket'})
 assert.match(empty,/暂无业务记录/)
 assert.ok(!empty.includes('data-view-distribution'))
 // 4 字段缺失
 const missing=await render(ledger({blocks:[block({views:[viewResult('SOC','alert-ticket','risk-distribution',[{dimension:'高',label:'高',values:[7]}],{missingFields:['severity']})]})]}),{objectType:'alert-ticket'})
 assert.match(missing,/未纳入统计/)
 assert.match(missing,/严重度/,'缺失提示要给声明里的字段标签，不给内部字段名')
 // 5 统计截断
 const truncated=await render(ledger({blocks:[block({coverage:{objects:5000,latestReceivedAt:'2026-09-15T01:05:00.000Z',truncated:true},views:[viewResult('SOC','alert-ticket','risk-distribution',[{dimension:'高',label:'高',values:[7]}])]})]}),{objectType:'alert-ticket'})
 assert.match(truncated,/只统计了最近 5000 条/)
})

test('未连接来源用模板声明的称呼，固定来源身份保留在提示中',async()=>{
 const value=ledger({blocks:[block({connected:false})]})
 Object.assign(value.blocks[0]!.source,{sourceNoun:'告警源'})
 for(const props of [{},{objectType:'alert-ticket'}]){
  const html=await render(value,props)
  assert.ok(html.includes('告警源'))
  assert.ok(html.includes(value.blocks[0]!.source.sourceId))
 }
})

test('来源待连接时仍可浏览已经固定进台账的对象与详情',async()=>{
 const object=ledgerObject('SOC','alert-ticket','a-1')
 const value=ledger({blocks:[block({connected:false,objects:1,views:[listView('SOC','alert-ticket',[object])]})]})
 const directory=await render(value,{objectType:'alert-ticket'})
 assert.match(directory,/工单 a-1/)
 assert.match(directory,/数据源未连接/)
 assert.match(directory,/数据源/,'没有行业称呼时使用人类可读的通用称呼，不把技术 source id 当主文案')
 assert.ok(!directory.includes('>security-alert-http<'))
 const detail=await render(value,{objectType:'alert-ticket',objectId:'a-1'})
 assert.match(detail,/这条还没有人看过/)
 assert.match(detail,/a-1/)
 assert.match(detail,/<dd title="EDR">数据源<\/dd>/,'详情页也要以人类可读的来源名为主文案，把原始标识留在标题中')
})

test('业务范围有锁定对象但来源未连接时，首屏明确说明存档不会实时更新',async()=>{
 const value=ledger({blocks:[block({connected:false,objects:1,views:[listView('SOC','alert-ticket',[ledgerObject('SOC','alert-ticket','a-1')])]})]})
 const overview=await render(value)
 assert.match(overview,/data-fixed-snapshot/)
 assert.match(overview,/当前显示的是上次保存的存档，不会实时更新/)
 assert.match(overview,/当前存档共 1 条/)
 assert.ok(!overview.includes('统计基于已同步的 1 条'))
 const connected=await render(ledger({blocks:[block({connected:true,objects:1})]}))
 assert.ok(!connected.includes('data-fixed-snapshot'))
})

test('对象目录照样把分母与缺失如实写出来',async()=>{
 const html=await render(ledger({blocks:[block({views:[],missingFields:['severity']})]}),{objectType:'alert-ticket'})
 assert.match(html,/统计基于已同步的 12 条/,'零视图块也要有分母交代')
 assert.match(html,/严重度/)
 assert.match(html,/未纳入统计/)
 const truncated=await render(ledger({blocks:[block({views:[],coverage:{objects:5000,latestReceivedAt:'2026-09-15T01:05:00.000Z',truncated:true}})]}),{objectType:'alert-ticket'})
 assert.match(truncated,/只统计了最近 5000 条/)
})

test('缺失字段按当前语言的列表习惯排版，不固定使用中文顿号',async()=>{
 const value=ledger({blocks:[block({views:[],missingFields:['severity','first-seen-at']})]})
 const html=await render(value,{objectType:'alert-ticket'},'en')
 assert.match(html,/severity and first seen/i)
 assert.ok(!html.includes('、'))
})

test('换一个范围组件零改动：两份 domain 不同的声明渲染出两套台账',async()=>{
 const one=await render(ledger()),other=await render(otherLedger())
 assert.match(one,/告警工单/)
 assert.match(other,/漏洞/)
 assert.ok(!other.includes('告警工单'))
 const source=readFileSync(new URL('../src/client/BusinessLedger.tsx',import.meta.url),'utf8')
 for(const name of ['SOC','AppSec','alert-ticket','vulnerability','security-alert-http'])assert.ok(!source.includes(name),'组件里不得出现任何行业名或声明标识：'+name)
})

test('覆盖率三项如实出现在界面上',async()=>{
 const html=await render(ledger())
 assert.match(html,/统计基于已同步的 12 条/)
 assert.match(html,/最近同步/)
 const never=await render(ledger({blocks:[block({coverage:{objects:3,latestReceivedAt:null,truncated:false},views:[viewResult('SOC','alert-ticket','risk-distribution',[{dimension:'高',label:'高',values:[7]}])]})]}))
 assert.match(never,/还没有同步记录/)
})

test('只有真被截断了才说共几项显示前几项，没截断时一个字都不多说',async()=>{
 const full=await render(ledger({blocks:[block({views:[viewResult('SOC','alert-ticket','risk-distribution',[{dimension:'高',label:'高',values:[7]},{dimension:'中',label:'中',values:[5]},{dimension:'低',label:'低',values:[1]}])]})]}),{objectType:'alert-ticket'})
 assert.ok(!full.includes('显示前'),'三个取值全画出来了，没有可截断的')
 const cut=await render(ledger({blocks:[block({views:[viewResult('SOC','alert-ticket','risk-distribution',[{dimension:'高',label:'高',values:[7]}],{dimensionValues:9})]})]}),{objectType:'alert-ticket'})
 assert.match(cut,/共 9 项，显示前 1 项/)
})

test('范围总览只画对象类型卡，图表进入对象目录',async()=>{
 const rows=[{dimension:'2026-09-14T00:00:00.000Z',label:'09-14',values:[3]},{dimension:'2026-09-15T00:00:00.000Z',label:'09-15',values:[5]}]
 const value=ledger({blocks:[block({views:[
  viewResult('SOC','alert-ticket','pending-board',[{dimension:'',label:'待处理告警',values:[4]}],{kind:'board-card',chart:'number',title:'待处理告警',dimensionValues:1}),
  viewResult('SOC','alert-ticket','risk-distribution',[{dimension:'高',label:'高',values:[7]}]),
  viewResult('SOC','alert-ticket','severity-share',[{dimension:'高',label:'高',values:[7]},{dimension:'中',label:'中',values:[3]}],{chart:'pie',title:'严重度占比'}),
  viewResult('SOC','alert-ticket','alert-trend',rows,{kind:'trend',chart:'line',title:'告警趋势'}),
  viewResult('SOC','alert-ticket','severity-table',[{dimension:'高',label:'高',values:[7]}],{chart:'table',title:'严重度明细'}),
  listView('SOC','alert-ticket',[ledgerObject('SOC','alert-ticket','a-1')]),
 ]})]})
 const overview=await render(value)
 assert.match(overview,/data-object-type-block/)
 assert.match(overview,/data-block-summary/)
 assert.ok(!overview.includes('data-view-board-card'),'范围总览不再叠图表')
 assert.ok(!overview.includes('data-view-list'),'范围总览不画清单')
 const html=await render(value,{objectType:'alert-ticket'})
 assert.match(html,/data-view-board-card/)
 assert.match(html,/data-view-distribution/)
 assert.match(html,/data-view-pie/)
 assert.match(html,/data-view-trend/)
 assert.match(html,/data-view-table/)
 assert.match(html,/data-view-list/)
 assert.match(html,/<polyline/,'趋势用纯 SVG 画，不引第三方图表库')
 assert.match(html,/<rect/,'条形用纯 SVG 画')
 assert.match(html,/<circle/,'饼用纯 SVG 的圆环切片画')
 assert.match(html,/待处理告警/,'大盘卡写的是视图标题，不是 rows[0].label 撞巧对上的那一串')
})

test('大盘卡的卡面文案取视图标题，与行标签无关',async()=>{
 const html=await render(ledger({blocks:[block({views:[
  viewResult('SOC','alert-ticket','pending-board',[{dimension:'',label:'',values:[4]}],{kind:'board-card',chart:'number',title:'待处理告警',dimensionValues:1}),
 ]})]}),{objectType:'alert-ticket'})
 assert.match(html,/待处理告警/)
})

test('趋势里读不出取值的点断线，不把两端连起来',async()=>{
 const rows=[
  {dimension:'2026-09-13T00:00:00.000Z',label:'09-13',values:[3]},
  {dimension:'2026-09-14T00:00:00.000Z',label:'09-14',values:[null]},
  {dimension:'2026-09-15T00:00:00.000Z',label:'09-15',values:[5]},
 ]
 const html=await render(ledger({blocks:[block({views:[viewResult('SOC','alert-ticket','alert-trend',rows,{kind:'trend',chart:'line',title:'告警趋势'})]})]}),{objectType:'alert-ticket'})
 assert.equal([...html.matchAll(/<polyline/g)].length,2,'一项度量被一个空点断成两段，画两条折线')
})

test('趋势里的孤立点用圆头描边显形，不是消失的零长度线段（复审 N-4）',async()=>{
 const rows=[
  {dimension:'2026-09-13T00:00:00.000Z',label:'09-13',values:[null]},
  {dimension:'2026-09-14T00:00:00.000Z',label:'09-14',values:[3]},
  {dimension:'2026-09-15T00:00:00.000Z',label:'09-15',values:[null]},
 ]
 const html=await render(ledger({blocks:[block({views:[viewResult('SOC','alert-ticket','alert-trend',rows,{kind:'trend',chart:'line',title:'告警趋势'})]})]}),{objectType:'alert-ticket'})
 const points=[...html.matchAll(/<polyline[^>]*points="([^"]+)"/g)].map(match=>match[1]!)
 assert.equal(points.length,1,'只有一个非空点，画一条单点段')
 const [first,second]=points[0]!.split(' ')
 assert.equal(first,second,'单点段首尾坐标相同，靠圆头描边显形，不是给两个不同的点连线')
 const css=readFileSync(new URL('../src/client/BusinessLedger.module.css',import.meta.url),'utf8')
 assert.match(css,/\.lines polyline\{[^}]*stroke-linecap:\s*round/,'零长度线段必须是圆头描边才会显形，方头描边（默认）什么都不画')
})

test('负值条形不塌：基线取零，负数那一侧照样有宽度',async()=>{
 const html=await render(ledger({blocks:[block({views:[viewResult('SOC','alert-ticket','delta',[{dimension:'高',label:'高',values:[-6]},{dimension:'中',label:'中',values:[6]}])]})]}),{objectType:'alert-ticket'})
 const widths=[...html.matchAll(/<rect[^>]*width="([\d.]+)"/g)].map(match=>Number(match[1]))
 assert.equal(widths.length,2)
 assert.ok(widths.every(width=>width>1),'两条都要有实际宽度，负数那条不能塌成一条线：'+widths.join(','))
})

test('对象目录用清单组件，第四列列头取该视图度量的标签，不写死「进展」',async()=>{
 const objects=[ledgerObject('SOC','alert-ticket','a-1'),ledgerObject('SOC','alert-ticket','a-2',{quality:'missing'})]
 const html=await render(ledger({blocks:[block({views:[listView('SOC','alert-ticket',objects)]})]}),{objectType:'alert-ticket'})
 assert.match(html,/data-view-list/)
 assert.match(html,/<th[^>]*>条数<\/th>/)
 assert.match(html,/<th[^>]*>对象<\/th>/)
 assert.equal([...html.matchAll(/<th scope="col"/g)].length,4,'四个列头都带 scope="col"')
 assert.match(html,/回到全部对象/)
 assert.match(html,/工单 a-1/)
})

test('下钻筛选的对象清单顶上有提示条：字段取本地化标题、取值原样，附「看全部」；对象详情与无筛选时不出',async()=>{
 const objects=[ledgerObject('SOC','alert-ticket','a-1')]
 const value=ledger({blocks:[block({views:[listView('SOC','alert-ticket',objects)]})]})
 const zh=await render(value,{objectType:'alert-ticket',match:{field:'severity',value:'高'}})
 assert.match(zh,/data-ledger-match/)
 assert.match(zh,/只看 严重度 为「高」的对象/)
 assert.match(zh,/<button type="button">看全部<\/button>/)
 assert.match(await render(value,{objectType:'alert-ticket',match:{field:'severity',value:'高'}},'en'),/Only objects where Severity is “高”/,'字段标题按界面语言取本地化')
 assert.match(await render(value,{objectType:'alert-ticket',match:{field:'_id',value:'a-1'}}),/只看 对象编号 为「a-1」的对象/)
 assert.doesNotMatch(await render(value,{objectType:'alert-ticket'}),/data-ledger-match/)
 assert.doesNotMatch(await render(value,{objectType:'alert-ticket',objectId:'a-1',match:{field:'_id',value:'a-1'}}),/data-ledger-match/,'对象详情不出提示条')
})

test('声明了进度的对象目录显示业务状态，并以人类来源名替代技术标识',async()=>{
 const definition={
  fields:[{name:'state',label:'修复状态',type:'enum',required:true,from:'修复状态',values:['未修复','修复中','已修复']}],
  progress:{stageField:'state',unfinished:['未修复','修复中'],waitingForYou:[]},
 }
 const object=ledgerObject('AppSec','vulnerability','APP-F-17',{fields:[{label:'修复状态',value:'修复中'}]})
 const html=await render(ledger({scope:'AppSec',blocks:[block({scope:'AppSec',definition:{...definition,id:'vulnerability',domain:'AppSec',sourceId:'appsec-finding-http'},connected:false,objects:1,progress:{unfinished:1,waitingForYou:0,latestChangedAt:null},views:[listView('AppSec','vulnerability',[object])]})],actions:[]}),{objectType:'vulnerability'})
 assert.match(html,/<th scope="col">修复状态<\/th>/)
 assert.match(html,/>修复中<\/td>/)
 assert.match(html,/>数据源<\/span>/)
 assert.ok(!html.includes('>appsec-finding-http<'))
})

test('对象目录先展示可操作的清单，低频分析折叠到清单之后',async()=>{
 const objects=[ledgerObject('SOC','alert-ticket','a-1')]
 const analysis=viewResult('SOC','alert-ticket','risk-distribution',[{dimension:'高',label:'高',values:[1]}])
 const html=await render(ledger({blocks:[block({views:[analysis,listView('SOC','alert-ticket',objects)]})]}),{objectType:'alert-ticket'})
 assert.ok(html.indexOf('data-view-list')<html.indexOf('data-view-distribution'),'目录首屏先给对象清单，再给分析图')
 assert.match(html,/<details class="analysisViews">/)
 assert.match(html,/<summary>持续分析<\/summary>/)
})

test('对象目录服务端截断与完整性筛选差额分开各说各的，互不冒充（复审 N-2）',async()=>{
 const objects=[ledgerObject('SOC','alert-ticket','a-1'),ledgerObject('SOC','alert-ticket','a-2',{quality:'missing'})]
 // 1 没有截断也没有筛选：两句都不该出现
 const plain=await render(ledger({blocks:[block({views:[listView('SOC','alert-ticket',objects)]})]}),{objectType:'alert-ticket'})
 assert.ok(!plain.includes('显示前')&&!plain.includes('筛选后'),'既没截断也没筛选，一个字都不该多说')
 // 2 服务端截断了（9 组只给 2 行），默认不筛选：只出现服务端截断那句，不受筛选状态影响
 const truncated=listView('SOC','alert-ticket',objects) as {dimensionValues:number}
 truncated.dimensionValues=9
 const html=await render(ledger({blocks:[block({views:[truncated]})]}),{objectType:'alert-ticket'})
 assert.match(html,/共 9 项，显示前 2 项/,'服务端截断不受筛选影响，必须照常披露')
 assert.ok(!html.includes('筛选后'),'没有主动筛选就不该出现筛选差额那句')
})

test('选中的对象展开成字段行加摘要，未在声明里出现的快照字段仍原样列出',async()=>{
 const object=ledgerObject('SOC','alert-ticket','a-1',{fields:[{label:'严重度',value:'高'},{label:'处置人',value:'值班员工'}]})
 const html=await render(ledger({blocks:[block({views:[listView('SOC','alert-ticket',[object])]})]}),{objectType:'alert-ticket',objectId:'a-1'})
 assert.match(html,/这条还没有人看过。/)
 assert.match(html,/处置人/,'声明里没有的快照字段不能丢')
 assert.match(html,/值班员工/)
 assert.match(html,new RegExp(object.snapshotHash))
 assert.ok(!html.includes('data-view-list'),'对象详情替换目录，不追加在目录后面')
 assert.ok(!html.includes('data-view-distribution'),'详情不夹带目录中的图表')
 assert.match(html,/返回告警工单目录/)
 assert.match(html,/回到全部对象/,'返回目录和返回台账是独立入口')
})

test('只有进度声明指向的枚举才提供状态筛选，不从状态字段名字推断',async()=>{
 const fields=[{name:'phase',label:'处理阶段',type:'enum',required:true,from:'工单阶段',values:['待看','完成']}]
 const objects=[ledgerObject('SOC','alert-ticket','a-1',{fields:[{label:'工单阶段',value:'待看'}]})]
 const base={fields}
 const without=await render(ledger({blocks:[block({definition:base,views:[listView('SOC','alert-ticket',objects)]})]}),{objectType:'alert-ticket'})
 assert.ok(!without.includes('aria-label="按状态看"'),'只有枚举字段，没有 progress 就不能猜状态')
 assert.match(without,/aria-label="资料完整性"/,'无进度声明仍保留完整性筛选')
 const withProgress=await render(ledger({blocks:[block({definition:{...base,progress:{stageField:'phase',unfinished:['待看'],waitingForYou:[]}},progress:{unfinished:1,waitingForYou:0,latestChangedAt:null},views:[listView('SOC','alert-ticket',objects)]})]}),{objectType:'alert-ticket'})
 assert.match(withProgress,/role="group" aria-label="按状态看"/)
 assert.match(withProgress,/aria-pressed="true"[^>]*>全部状态/)
 assert.match(withProgress,/aria-pressed="false"[^>]*>待看/)
 assert.match(withProgress,/aria-pressed="false"[^>]*>完成/,'声明中暂未出现的状态也可选，空结果不伪造对象')
})

test('对象直达失效时给出可返回的未找到状态，不静默退成目录',async()=>{
 const html=await render(ledger({blocks:[block({views:[listView('SOC','alert-ticket',[ledgerObject('SOC','alert-ticket','a-1')])]})]}),{objectType:'alert-ticket',objectId:'missing'})
 assert.match(html,/role="status"/)
 assert.match(html,/返回告警工单目录/)
 assert.ok(!html.includes('data-view-list'))
 assert.ok(!html.includes('工单 a-1'))
})

test('对象详情和类型目录返回台账时都落数据面根，不跳正在处理或残留对象标识',()=>{
 const source=readFileSync(new URL('../src/client/BusinessLedger.tsx',import.meta.url),'utf8')
 const buttons=[...source.matchAll(/<button\s+type="button"\s+onClick=\{\(\)=>go\((\{[^}]+\})\)\}>\{t\('business\.ledger\.back'\)\}<\/button>/g)]
 assert.equal(buttons.length,2,'分别检查详情和目录的返回台账按钮，不命中返回类型目录按钮')
 for(const button of buttons)assert.equal(button[1],"{scope,section:'data'}")
})

test('execution-tool 动作第一期不给入口',async()=>{
 const html=await render(ledger({blocks:[block({defaultAction:{actionId:'isolate-endpoint',title:'隔离这台主机',targetKind:'execution-tool',available:false}})]}))
 assert.ok(!html.includes('隔离这台主机'))
})

test('工作模板动作在对象类型卡上保留默认动作，但不伪造确认建任务入口',async()=>{
 const html=await render(ledger())
 assert.match(html,/<button[^>]+data-default-action="assign-alert-review"[^>]*>交给同事核对<\/button>/)
 assert.match(html,/alert-triage-review/)
 assert.match(html,/自动填入 2 项任务资料/)
 assert.ok(!html.includes('确认建任务'),'不能把未接线的动作伪装成可确认的按钮')
})

test('对象类型卡只显示真实的同步摘要，不用“暂无”占位或伪造阶段进度',async()=>{
 const html=await render(ledger())
 assert.match(html,/data-block-summary/)
 assert.match(html,/最近同步/)
 assert.ok(!html.includes('还没完、等你各多少：暂无'))
 assert.ok(!html.includes('最近变化：暂无'))
 // 每个块各有一份真实摘要，两个块就是两份。
 const two=await render(ledger({blocks:[block(),block({definition:{id:'alert-asset',title:'资产'}})]}))
 assert.equal([...two.matchAll(/data-block-summary/g)].length,2)
 // 同步摘要预留两行高度，块的下缘不会因为时间文案长短参差。
 assert.match(readFileSync(new URL('../src/client/BusinessLedger.module.css',import.meta.url),'utf8'),/\.blockSummary\{[^}]*min-height:3\.4em/)
})

test('模板声明了阶段和变化时间时，对象类型卡展示真实摘要，不用同步时刻替代变化时间',async()=>{
 const definition={
  fields:[
   {name:'state',label:'状态',type:'enum',required:true,from:'状态',values:['新建','等确认','完成']},
   {name:'changed-at',label:'最近变化',type:'datetime',required:true,from:'最近变化'},
  ],
  progress:{stageField:'state',unfinished:['新建','等确认'],waitingForYou:['等确认'],changedAtField:'changed-at'},
 }
 const html=await render(ledger({blocks:[block({definition,progress:{unfinished:8,waitingForYou:2,latestChangedAt:'2026-09-15T01:00:00.000Z'}})]}))
 assert.match(html,/待完成 8 项 · 待你处理 2 项/)
 assert.match(html,/最近变化/)
 assert.match(html,/data-block-progress/)
 assert.match(html,/data-block-change/)
})

test('定义已更新时块上标出来',async()=>{
 const html=await render(ledger(),{updated:new Set(['alert-ticket'])})
 assert.match(html,/业务配置已更新/)
 assert.ok(!(await render(ledger())).includes('业务配置已更新'))
})

test('datetime 度量按回包给的 fieldType 当时刻读，count 度量与它同名也不受影响',async()=>{
 const at=Date.parse('2026-09-14T22:00:00.000Z')
 const html=await render(ledger({blocks:[block({views:[viewResult('SOC','alert-ticket','first-seen-board',[{dimension:'',label:'首次出现',values:[at]}],{kind:'board-card',chart:'number',title:'最早一条',dimensionValues:1,measures:[{id:'first-seen-at',label:'最早一条',fieldType:'datetime'}]})]})]}),{objectType:'alert-ticket'})
 assert.ok(!html.includes(String(at)),'毫秒时刻不能直接摆在界面上')
 assert.match(html,/2026/)
 // 度量标识恰好与一个 datetime 字段同名、但它其实是 count：没有 fieldType 就该按数字读，不能画成 1970 年。
 const counted=await render(ledger({blocks:[block({views:[viewResult('SOC','alert-ticket','first-seen-count',[{dimension:'',label:'首次出现',values:[3]}],{kind:'board-card',chart:'number',title:'条数',dimensionValues:1,measures:[{id:'first-seen-at',label:'条数'}]})]})]}),{objectType:'alert-ticket'})
 assert.ok(!counted.includes('1970'),'count 度量不带 fieldType，按数字读')
 assert.match(counted,/>3</)
})

test('声明里的文字只作为文本节点落地，界面上没有 HTML 渲染位',async()=>{
 const html=await render(ledger({blocks:[block({definition:{title:'<img src=x onerror=alert(1)>'}})]}))
 assert.ok(!html.includes('<img src=x'))
 assert.match(html,/&lt;img src=x/)
 const source=readFileSync(new URL('../src/client/BusinessLedger.tsx',import.meta.url),'utf8')
 assert.doesNotMatch(source,/dangerouslySetInnerHTML/)
})
