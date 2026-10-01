import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {businessHomeAttention,businessHomeCards,businessHomeSources,businessHomeStaff,businessHomeSummaryParts,businessHomeWorking} from '../src/client/business-home-presentation.ts'
import {businessScopeNames} from '../src/client/business-directory.ts'
import type {BusinessScopeLabel} from '../src/client/business-directory.ts'
import type {AttentionItem} from '../src/client/attention-item.ts'
import type {PreviewRole} from '../src/client/role-preview.ts'
import type {PreviewTask} from '../src/client/task-preview.ts'
import type {IndustryDataSourceInstance} from '../src/client/industry-data-source-api.ts'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
import {compositionSummary} from '../src/client/industry-composition.ts'
import {BUSINESS_PAGE_MESSAGE_ROWS} from '../src/client/i18n/locales/business-page.ts'

const root=new URL('../src/client/',import.meta.url)

type Node={type:unknown;props:Record<string,any>;children:Node[]}
const nodes=(node:unknown):Node[]=>node&&typeof node==='object'&&'children' in (node as Node)
 ?[node as Node,...(node as Node).children.flatMap(child=>Array.isArray(child)?child.flatMap(nodes):nodes(child))]
 :[]
const text=(node:unknown):string=>typeof node==='string'?node:typeof node==='number'?String(node):node&&typeof node==='object'?((node as Node).children??[]).map(text).join(''):''

/** 与 `personal-space-surfaces.test.ts` 同一手法：把组件转译进测试进程执行，渲染真实节点而不是断言源码字符串。 */
function mount(file:string,props:Record<string,unknown>,modules:Record<string,unknown>={}){
 const source=readFileSync(new URL(file,root),'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 // 这一页的卡片是页内的子组件：命名以大写开头的函数当场展开，lucide 与头像那类桩函数（匿名）留成节点。
 const createElement=(type:any,props:Record<string,unknown>|null,...children:unknown[]):any=>{
  const node={type,props:props??{},children:children.flat(Infinity)}
  return typeof type==='function'&&/^[A-Z]/.test(String(type.name))?type({...node.props,children:node.children}):node
 }
 // 这一页目前只有「再加一类业务」用到 useState/useRef（展开态与 useDismissible 的容器 ref）；
 // 这里没有一套按调用顺序记忆的 cursor 机制，用例也不点开这个面板，桩成「总是给初值、set 不回写」够用。
 const React={createElement,useState:(initial:unknown)=>[typeof initial==='function'?(initial as ()=>unknown)():initial,()=>{}],useRef:(value:unknown)=>({current:value})}
 const cssProxy=new Proxy({},{get:(_,key)=>String(key)})
 const require=(id:string)=>{
  if(id==='react')return React
  if(id==='clsx')return {default:(...values:unknown[])=>values.filter(Boolean).join(' ')}
  for(const [suffix,value] of Object.entries(modules))if(id.endsWith(suffix))return value
  if(id.endsWith('business-directory.js'))return {businessScopeNames}
  if(id.endsWith('provider.js'))return {useI18n:()=>({locale:'zh-CN',t:(key:string,params?:Record<string,unknown>)=>params?key+':'+JSON.stringify(params):({"business.scope.general":"通用工作","business.scope.soc":"安全运营","business.scope.appsec":"应用安全"}[key]??key),number:(value:number)=>String(value)})}
  if(id.endsWith('.css'))return {default:cssProxy}
  return new Proxy({default:cssProxy},{get:(_,key)=>key==='default'?cssProxy:()=>'none'})
 }
 const exports:Record<string,any>={}
 new Function('require','exports','React',js)(require,exports,React)
 const name=file.replace(/\.tsx$/,'').split('/').at(-1)!
 return ()=>exports[name](props) as Node
}

const label=(scope:string,title:string,kind:BusinessScopeLabel['kind'],activeLoads=0):BusinessScopeLabel=>({scope,title,kind,loads:0,activeLoads,tasks:0,groups:0})

const role=(id:string,name:string,scope:string,patch:Partial<PreviewRole>={}):PreviewRole=>({
 id,name,kind:'employee',scopes:[scope],state:'active',version:1,duty:'',dataScope:'',executionScope:'',skills:[],knowledge:[],memories:[],history:[],...patch,
})

const attention=(id:string,scope:string,persistence:AttentionItem['persistence']):AttentionItem=>({
 id,kind:'error',source:'task',persistence,target:{kind:'task',id},title:id,reason:{kind:'text',text:'assigned'},scope,occurredAt:'2026-09-16T01:00:00.000Z',
})

const dataSource=(id:string,scope:string,state:'needs_authorization'|'active'|'drifted'|'detached'):IndustryDataSourceInstance=>{
 const stamp='2026-09-16T01:00:00.000Z'
 const base={id,ownerId:'local:teloa-owner',loadId:'load-'+id,itemInstanceId:'item-'+id,itemLocalId:'source-'+id,contentId:'content-'+id,contentHash:'a'.repeat(64),itemVersion:'1.0.0',scope,createdAt:stamp,updatedAt:stamp}
 const binding={sourceId:'source-'+id,scopes:[scope],definitionHash:'b'.repeat(64),probedAt:stamp}
 if(state==='active')return {...base,state,revision:2,binding}
 if(state==='drifted')return {...base,state:'needs_authorization',revision:3,binding,drift:true}
 if(state==='detached')return {...base,state,revision:3,binding:null}
 return {...base,state,revision:1,binding:null}
}

test('数据源数只数同一业务里已授权的正式实例，待授权、漂移回退和已解除都算未接入',()=>{
 assert.equal(businessHomeSources([],'SOC'),0)
 const rows=[
  dataSource('pending','SOC','needs_authorization'),
  dataSource('active','SOC','active'),
  dataSource('drifted','SOC','drifted'),
  dataSource('detached','SOC','detached'),
  dataSource('other-active','AppSec','active'),
 ]
 assert.equal(businessHomeSources(rows,'SOC'),1)
 assert.equal(businessHomeSources(rows,'AppSec'),1,'别的业务范围不能串入当前卡片')
})

test('在岗数只数这一范围里正在岗的数字员工：暂停、退役与分身都不算',()=>{
 const roles=[
  role('r1','甲','SOC'),
  role('r2','乙','SOC',{state:'paused'}),
  role('r3','丙','SOC',{state:'retired'}),
  role('r4','丁','SOC',{kind:'twin'}),
  role('r5','戊','AppSec'),
  role('r6','己','SOC',{scopes:['SOC','AppSec']}),
 ]
 assert.deepEqual(businessHomeStaff(roles,'SOC').map(item=>item.id),['r1','r6'])
 assert.deepEqual(businessHomeStaff(roles,'AppSec').map(item=>item.id),['r5','r6'])
 // 2026-09-21 用户裁定改判：通用工作（general）对所有在岗正式同事开放（契约 roleSupportsScope），不再要求岗位声明包含 general。
 assert.deepEqual(businessHomeStaff(roles,'general').map(item=>item.id),['r1','r5','r6'])
})

test('等你数排除演示数据，并按范围过滤',()=>{
 const items=[attention('a1','SOC','saved'),attention('a2','SOC','example'),attention('a3','AppSec','saved')]
 assert.equal(businessHomeAttention(items,'SOC'),1)
 assert.equal(businessHomeAttention(items,'AppSec'),1)
 assert.equal(businessHomeAttention(items,'general'),0)
})


test('进行中的任务只统计已保存且未结项的同业务任务',()=>{
 const tasks=[
  {id:'saved-running',scope:'SOC',state:'running',storage:'persistent'},
  {id:'saved-waiting',scope:'SOC',state:'waiting',storage:'persistent'},
  {id:'saved-completed',scope:'SOC',state:'completed',storage:'persistent'},
  {id:'local-ready',scope:'SOC',state:'ready'},
  {id:'other-scope',scope:'AppSec',state:'running',storage:'persistent'},
 ] as PreviewTask[]
 assert.equal(businessHomeWorking(tasks,'SOC'),2)
 assert.equal(businessHomeWorking(tasks,'AppSec'),1)
})

test('卡片按内置→域→遗留排序，同类按标题的当地语序；接没接上决定处境句与行动句',()=>{
 const labels=[label('legacy-x','旧标签','legacy'),label('research','调查行业','domain'),label('SOC','安全运营','builtin'),label('design','设计','domain'),label('general','通用工作','builtin')]
 const cards=businessHomeCards(labels,{roles:[role('r1','甲','SOC')],dataSources:[dataSource('active','SOC','active')],attention:[attention('a1','SOC','saved')],tasks:[],locale:'zh-CN'})
 assert.deepEqual(cards.map(card=>card.scope),['SOC','general','research','design','legacy-x'])
 const soc=cards[0]!
 assert.deepEqual([soc.sources,soc.staff.length,soc.attention,soc.working],[1,1,1,0])
 assert.equal(soc.situationKey,'business.home.situation.connected')
 assert.equal(soc.lineKey,'business.home.line.connected')
 const named=businessHomeCards([{...label('SOC','安全运营','builtin'),sourceNoun:'告警源'}],{roles:[],dataSources:[dataSource('pending','SOC','needs_authorization')],attention:[],tasks:[],locale:'zh-CN'})[0]!
 assert.equal(named.sourceNoun,'告警源','范围标签的唯一模板称呼原样交给卡片，组件不猜行业')
 assert.equal(named.sources,0,'有模板声明但正式实例还待授权时必须仍显示未接入')
 const quiet=cards.find(card=>card.scope==='research')!
 assert.deepEqual([quiet.sources,quiet.staff.length,quiet.attention,quiet.working],[0,0,0,0])
 // 0 人时处境句换一支：不说「0 位数字员工在岗」，说「还没有数字员工在这里」（终审 B2）。
 assert.equal(quiet.situationKey,'business.home.situation.noneNoStaff')
 const connectedNoStaff=businessHomeCards([label('SOC','安全运营','builtin')],{roles:[],dataSources:[dataSource('active','SOC','active')],attention:[],tasks:[],locale:'zh-CN'})[0]!
 assert.equal(connectedNoStaff.situationKey,'business.home.situation.connectedNoStaff')
 const noneWithStaff=businessHomeCards([label('SOC','安全运营','builtin')],{roles:[role('r1','甲','SOC')],dataSources:[dataSource('pending','SOC','needs_authorization')],attention:[],tasks:[],locale:'zh-CN'})[0]!
 assert.equal(noneWithStaff.situationKey,'business.home.situation.none')
 assert.equal(quiet.lineKey,'business.home.line.none')
})

test('首页把范围目录里唯一的来源称呼传给处境句和接入动作',()=>{
 const render=mount('BusinessHome.tsx',{
  directory:{status:'ready',retry:()=>{}},
  labels:[{...label('SOC','安全运营','builtin'),sourceNoun:'告警源'}],roles:[],dataSources:[dataSource('pending','SOC','needs_authorization')],attention:[],tasks:[],
  open:()=>{},openStaff:()=>{},connect:()=>{},addBusiness:()=>{},
 },{'business-home-presentation.js':{businessHomeCards,businessHomeSummaryParts}})
 const output=text(render())
 assert.ok(output.includes('business.home.situation.noneNoStaff:'+JSON.stringify({sources:'0',staff:'0',noun:'告警源'})))
 assert.ok(output.includes('business.home.line.none:'+JSON.stringify({noun:'告警源'})))
 assert.ok(output.includes('business.home.connect:'+JSON.stringify({noun:'告警源'})))
})

test('首页静态渲染：一张卡一个范围，处境句带三个数，动作按钮接到对应回调',()=>{
 const labels=[label('SOC','安全运营','builtin'),label('general','通用工作','builtin'),label('research','调查行业','domain')]
 const calls:string[]=[]
 const render=mount('BusinessHome.tsx',{
  directory:{status:'ready',retry:()=>{}},
  labels,
  roles:[role('r1','甲','SOC'),role('r2','乙','SOC'),role('r3','丙','SOC',{state:'paused'})],
  dataSources:[dataSource('active-1','SOC','active'),dataSource('pending','SOC','needs_authorization'),dataSource('active-2','SOC','active')],
  attention:[attention('a1','SOC','saved'),attention('a2','SOC','example')],tasks:[],
  open:(scope:string)=>calls.push('open:'+scope),
  openStaff:(scope:string)=>calls.push('staff:'+scope),
  connect:(scope:string)=>calls.push('connect:'+scope),
  addBusiness:()=>calls.push('add'),
 },{'business-home-presentation.js':{businessHomeCards,businessHomeSummaryParts}})
 const view=render()
 // 页头：业务名称、说明和右上「再加一类业务」。
 assert.equal(text(nodes(view).find(node=>node.type==='h1')),'business.home.title')
 assert.ok(!text(view).includes('business.home.eyebrow')&&text(view).includes('business.home.subtitle'))
 const cards=nodes(view).filter(node=>node.type==='article')
 assert.equal(cards.length,labels.length)
 // 处境句用的是三数读口算出来的数：两个数据源、两位在岗（暂停的不算）；来源名词作为第三个参数一并传下去（B1）。
 assert.ok(text(cards[0]!).includes('business.home.situation.connected:'+JSON.stringify({sources:'2',staff:'2',noun:'business.source.noun'})))
 // 「接入{noun}」与行动句都吃同一个名词，没有第二处写法。
 assert.ok(text(cards[0]!).includes('business.home.connect:'+JSON.stringify({noun:'business.source.noun'})))
 assert.ok(text(cards[0]!).includes('business.home.line.connected:'+JSON.stringify({noun:'business.source.noun'})))
 assert.ok(text(cards[0]!).includes('business.home.line.connected'))
 // 「N 件等你」排掉演示数据，只有有事的范围才摆这个徽标。
 assert.ok(text(cards[0]!).includes('business.home.waiting:'+JSON.stringify({count:'1'})))
 assert.ok(!text(cards[1]!).includes('business.home.waiting'))
 // 2026-09-21 用户裁定改判：通用工作（general）对所有在岗正式同事开放（契约 roleSupportsScope），
 // 卡片不再要求岗位声明包含 general——两位在岗的 SOC 同事同样算这张卡的在岗人手。
 assert.ok(text(cards[1]!).includes('business.home.situation.none:'+JSON.stringify({sources:'0',staff:'2',noun:'business.source.noun'})))
 assert.ok(!text(cards[1]!).includes('business.home.noStaff'))
 // 没有同事负责的范围（这里是没人声明过的 domain 范围）说人话，不摆一串空头像；处境句也换成「还没有数字员工在这里」那一支。
 assert.ok(text(cards[2]!).includes('business.home.noStaff'))
 assert.ok(text(cards[2]!).includes('business.home.situation.noneNoStaff'))
 assert.ok(text(cards[0]!).includes('business.home.situation.connected'))
 // 三个正式动作各接各的回调；示例数据不是业务入口。
 const buttons=nodes(cards[0]!).filter(node=>node.type==='button')
 for(const button of buttons)button.props.onClick?.()
 nodes(view).filter(node=>node.type==='button'&&text(node)==='business.home.add')[0]!.props.onClick()
 assert.deepEqual(calls,['open:SOC','staff:SOC','connect:SOC','add'])
 // 去术语化：这一页一个系统词都不说。
 for(const word of ['工作空间','空间','范围','实例','投影'])assert.ok(!text(view).includes(word),word)
})

test('业务首页的新词条 11 列齐全，且中文里没有「工作空间」这类系统词',()=>{
 const rows=new Map(BUSINESS_PAGE_MESSAGE_ROWS.map(row=>[row[0] as string,row as readonly string[]]))
 const keys=['business.home.title','business.home.subtitle','business.home.add','business.home.staffMore','business.home.empty.title','business.home.empty.description','business.home.directory.loading','business.home.directory.failed','business.scope.pageAria','business.home.situation.connected','business.home.situation.none','business.home.situation.connectedNoStaff','business.home.situation.noneNoStaff','business.home.line.connected','business.home.line.none','business.home.noStaff','business.home.waiting','business.home.staff','business.home.connect','business.home.working','business.home.quiet','business.scope.backHome','business.scope.barAria','business.scope.stat.sources','business.scope.stat.staff','business.scope.stat.automations','business.scope.stat.sourcesValue','business.scope.stat.staffValue','business.scope.stat.automationsValue']
 for(const key of keys){
  const row=rows.get(key)
  assert.ok(row,key)
  assert.equal(row!.length,11,key)
  for(const value of row!)assert.ok(String(value).trim(),key)
  for(const word of ['工作空间','单空间'])assert.ok(!row![1]!.includes(word),key)
 }
 assert.equal(rows.get('business.home.title')![1],'业务')
 assert.equal(rows.get('business.scope.backHome')![1],'返回业务')
 // B1：来源名词是参数，不写死在词条里；缺省名词由 `business.source.noun` 单独一条给。
 assert.equal(rows.get('business.home.situation.connected')![1],"已接入 {sources} 个{noun}，{staff} 位员工在岗")
 assert.equal(rows.get('business.source.noun')![1],'数据源')
 for(const key of ['business.home.situation.connected','business.home.situation.none','business.home.situation.connectedNoStaff','business.home.situation.noneNoStaff','business.home.line.none','business.home.connect','business.connection.connect']){
  const row=rows.get(key)
  assert.ok(row,key)
  assert.equal(row!.length,11,key)
  for(const value of row!.slice(1))assert.ok(value.includes('{noun}'),key+' 缺 {noun} 占位符')
  // 参数化之后词条里不该再留通用名词的字面写法，否则名词一变就出现两种说法。
  for(const literal of ['数据源','資料來源','data source','データソース'])assert.ok(!row![1]!.includes(literal)&&!row![2]!.includes(literal)&&!row![3]!.includes(literal)&&!row![4]!.includes(literal),key+' 仍写死了通用名词')
 }
})

test('头像串最多五个，多出的折成一句人话；一个范围都没有时给空态并复用「再加一类业务」',()=>{
 const many=Array.from({length:8},(_,index)=>role('r'+index,'员'+index,'SOC'))
 const render=mount('BusinessHome.tsx',{
  directory:{status:'ready',retry:()=>{}},
  labels:[label('SOC','安全运营','builtin')],roles:many,dataSources:[],attention:[],tasks:[],
  open:()=>{},openStaff:()=>{},connect:()=>{},addBusiness:()=>{},
 },{'business-home-presentation.js':{businessHomeCards,businessHomeSummaryParts}})
 const view=render()
 // 五个头像 + 一句「还有 3 位」，不是裸的「+3」。
 assert.equal(nodes(view).filter(node=>node.props.className==='staffAvatar').length,5)
 assert.ok(text(view).includes('business.home.staffMore:'+JSON.stringify({count:'3'})))
 assert.ok(!text(view).includes('+3'))
 // 空态：一句标题、一句说明，主行动就是页头那个「再加一类业务」。
 const added:string[]=[]
 const empty=mount('BusinessHome.tsx',{
  directory:{status:'ready',retry:()=>{}},
  labels:[],roles:[],dataSources:[],attention:[],tasks:[],
  open:()=>{},openStaff:()=>{},connect:()=>{},addBusiness:()=>added.push('add'),
 },{'business-home-presentation.js':{businessHomeCards,businessHomeSummaryParts}})()
 assert.equal(nodes(empty).filter(node=>node.type==='article').length,0)
 assert.ok(text(empty).includes('business.home.empty.title')&&text(empty).includes('business.home.empty.description'))
 const actions=nodes(empty).filter(node=>node.type==='button'&&text(node)==='business.home.add')
 assert.equal(actions.length,2,'页头与空态各有一个，文案同源')
 for(const action of actions)action.props.onClick()
 assert.deepEqual(added,['add','add'])
})

test('业务目录加载、失败与真实空目录三态不会退回内置业务卡',()=>{
 const baseProps={
  labels:[label('SOC','安全运营','builtin')],roles:[],dataSources:[],attention:[],tasks:[],
  open:()=>{},openStaff:()=>{},connect:()=>{},addBusiness:()=>{},
 }
 const loading=mount('BusinessHome.tsx',{...baseProps,directory:{status:'loading',retry:()=>{}}},{'business-home-presentation.js':{businessHomeCards,businessHomeSummaryParts}})()
 assert.equal(nodes(loading).filter(node=>node.type==='article').length,0)
 assert.equal(nodes(loading).filter(node=>node.props.role==='status').length,1)
 assert.ok(text(loading).includes('business.home.directory.loading'))
 assert.ok(!text(loading).includes('安全运营'))
 assert.ok(!text(loading).includes('business.home.empty.title'))

 const retries:string[]=[]
 const failed=mount('BusinessHome.tsx',{...baseProps,directory:{status:'failed',error:'目录服务不可用',retry:()=>retries.push('retry')}},{'business-home-presentation.js':{businessHomeCards,businessHomeSummaryParts}})()
 assert.equal(nodes(failed).filter(node=>node.type==='article').length,0)
 const alert=nodes(failed).filter(node=>node.props.role==='alert')
 assert.equal(alert.length,1)
 assert.ok(text(alert[0]).includes('business.home.directory.failed')&&text(alert[0]).includes('目录服务不可用'))
 nodes(alert[0]).find(node=>node.type==='button')!.props.onClick()
 assert.deepEqual(retries,['retry'])
 assert.ok(!text(failed).includes('business.home.empty.title'))

 const ready=mount('BusinessHome.tsx',{...baseProps,labels:[],directory:{status:'ready',retry:()=>{}}},{'business-home-presentation.js':{businessHomeCards,businessHomeSummaryParts}})()
 assert.equal(nodes(ready).filter(node=>node.type==='article').length,0)
 assert.equal(nodes(ready).filter(node=>node.props.role==='status'||node.props.role==='alert').length,0)
 assert.ok(text(ready).includes('business.home.empty.title')&&text(ready).includes('business.home.empty.description'))
})

const load=(scope:string,items:readonly {kind:string;title:string;status?:string}[]):IndustryLoadRecord=>({
 id:'load-'+scope,ownerId:'local:teloa-owner',contentId:'content-'+scope,contentHash:'a'.repeat(64),
 templateId:'template-'+scope,templateVersion:'1.0.0',templateTitle:'模板',domain:'domain',scope,description:'',targetVersion:1,
 space:{id:'11111111-1111-4111-8111-111111111111',name:'空间',version:1,scope},
 items:items.map((item,index)=>({localId:'local-'+index,instanceId:'instance-'+scope+'-'+index,kind:item.kind,title:item.title,version:'1.0.0',required:true,status:item.status??'active'})),
 relations:[],entrypoints:[],createdAt:'2026-09-16T01:00:00.000Z',mappingHash:'b'.repeat(64),status:'active',
} as unknown as IndustryLoadRecord)

test('卡摘要只说有的那几行：计数、段落顺序与分隔一律出自共享分类模块',()=>{
 const t=(key:string,params?:Record<string,unknown>)=>params?key+':'+JSON.stringify(params):({"business.scope.general":"通用工作","business.scope.soc":"安全运营","business.scope.appsec":"应用安全"}[key]??key)
 const number=(value:number)=>String(value)
 const loads=[load('SOC',[
  {kind:'role',title:'值班员'},{kind:'skill',title:'研判'},{kind:'knowledge',title:'处置手册'},
  {kind:'mcp',title:'连接'},{kind:'object-type',title:'工单'},{kind:'business-view',title:'看板'},
  {kind:'work-template',title:'日常处置'},{kind:'plugin',title:'扩展一'},
 ]),load('AppSec',[{kind:'skill',title:'扫描'}])]
 const cards=businessHomeCards([label('SOC','甲','builtin'),label('AppSec','乙','builtin'),label('quiet','丙','builtin')],
  {roles:[role('r1','甲','SOC'),role('twin','分身','SOC',{kind:'twin'})],dataSources:[],attention:[],tasks:[],locale:'zh-CN',loads})
 const soc=cards.find(card=>card.scope==='SOC')!
 // 七行都有东西：同事行算一位（默认分身如实列出但不计人数），其余行各自的主数字。
 assert.deepEqual(soc.composition.map(row=>[row.id,row.count]),
  [['staff',1],['skill',1],['knowledge',1],['source',1],['board',1],['method',1],['extension',1]])
 // 只有一项技能的业务只出一行；一个东西都没有的业务整行不摆。
 assert.deepEqual(cards.find(card=>card.scope==='AppSec')!.composition.map(row=>row.id),['skill'])
 assert.deepEqual(cards.find(card=>card.scope==='quiet')!.composition,[])
 // 切出来的段拼回去必须逐字等于共享模块给的那一行，首页没有第二套计数或分隔写法。
 const parts=businessHomeSummaryParts(soc.composition,'SOC',t as never,number)
 assert.equal(parts.map(part=>part.text).join(''),compositionSummary(soc.composition,t as never,number))
 assert.deepEqual(parts.filter(part=>part.go).map(part=>part.go),[
  {kind:'team',scope:'SOC'},{kind:'capabilities'},{kind:'knowledge'},{kind:'connectors'},
  {kind:'business',scope:'SOC'},{kind:'business',scope:'SOC'},{kind:'market',category:'plugin'},
 ])
 assert.deepEqual(parts.filter(part=>!part.go).map(part=>part.text),[' · ',' · ',' ｜ ',' ｜ ',' ｜ ',' ｜ '])
 assert.deepEqual(businessHomeSummaryParts([],'quiet',t as never,number),[])
})

test('首页把摘要摆在卡上：每段是按钮，点一下把落点交给宿主；没东西的业务不摆这一行',()=>{
 const loads=[load('SOC',[{kind:'role',title:'值班员'},{kind:'mcp',title:'连接'},{kind:'plugin',title:'扩展一'}])]
 const went:unknown[]=[]
 const render=mount('BusinessHome.tsx',{
  directory:{status:'ready',retry:()=>{}},
  labels:[label('SOC','安全运营','builtin'),label('quiet','通用工作','builtin')],
  roles:[role('r1','甲','SOC')],dataSources:[],attention:[],tasks:[],loads,
  open:()=>{},openStaff:()=>{},connect:()=>{},addBusiness:()=>{},goComposition:(target:unknown)=>went.push(target),
 },{'business-home-presentation.js':{businessHomeCards,businessHomeSummaryParts}})
 const cards=nodes(render()).filter(node=>node.type==='article')
 const summary=nodes(cards[0]!).find(node=>node.props.className==='spaceComposition')!
 assert.ok(summary,'有东西的业务必须在卡上摆摘要行')
 const segments=nodes(summary).filter(node=>node.type==='button')
 assert.deepEqual(segments.map(text),[
  'composition.unit.staff:'+JSON.stringify({count:'1',views:'0'}),
  'composition.unit.source:'+JSON.stringify({count:'1',views:'0'}),
  'composition.unit.extension:'+JSON.stringify({count:'1',views:'0'}),
 ])
 for(const segment of segments)segment.props.onClick()
 assert.deepEqual(went,[{kind:'team',scope:'SOC'},{kind:'connectors'},{kind:'market',category:'plugin'}])
 // 空行不进摘要：这张卡没有技能、资料、看板与任务模板，就不说「0 项技能」。
 assert.ok(!text(summary).includes('composition.unit.skill')&&!text(summary).includes('composition.unit.board'))
 // 一个东西都没有的业务整行不渲染。
 assert.equal(nodes(cards[1]!).filter(node=>node.props.className==='spaceComposition').length,0)
 // 组件里不认识任何行业名词，摘要的字都是词条键。
 for(const word of ['SOC','告警','资产','Splunk'])assert.ok(!text(summary).includes(word),word)
})


test('英文业务入口翻译内置名称且保留用户业务名称',()=>{
 const render=mount('BusinessHome.tsx',{directory:{status:'ready',retry:()=>{}},labels:[label('general','通用工作','builtin'),label('custom','客户原文','domain')],roles:[],dataSources:[],attention:[],tasks:[],open:()=>{},openStaff:()=>{},connect:()=>{},addBusiness:()=>{}},{'business-home-presentation.js':{businessHomeCards,businessHomeSummaryParts},'provider.js':{useI18n:()=>({locale:'en',t:(key:string)=>key==='business.scope.general'?'General work':key,number:String})}})
 const output=text(render());assert.ok(output.includes('General work'));assert.ok(!output.includes('通用工作'));assert.ok(output.includes('客户原文'))
})
