import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import type {CapabilitySnapshot} from '@teloa/contract'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
// 逻辑模块（无 JSX）从构建产物导入：这些文件的内部相对导入用 .js 扩展名，node --test 直接跑源码会解析失败
// （同 team-roster-i18n.test.ts 对 i18n/messages 的处理）；只有本文件要验证的 .tsx 走 ts.transpileModule 现读现译。
import {translateMessage} from '../lib/types/client/i18n/messages.js'
import * as industryComposition from '../lib/types/client/industry-composition.js'
import * as capabilityComposition from '../lib/types/client/capability-composition.js'
import * as teamCapabilitiesPresentation from '../lib/types/client/team-capabilities-presentation.js'
import * as industryWorkspaceProjection from '../lib/types/client/industry-workspace-projection.js'
import {COMPOSITION_ROWS,CAPABILITY_ROW_IDS} from '../lib/types/client/industry-composition.js'

// 手法同 market-component-harness.ts：.tsx 走 ts.transpileModule 产出 CommonJS，配一份支持
// useState/useSyncExternalStore 的最小假 React；真实取数模块（capability-composition 等）原样接入，
// 只有 CSS Modules、图标与 i18n provider 换成假实现——但 t() 换成真的 translateMessage，好断言真实 zh-CN 文案。
export type Node={type:any;props:Record<string,any>;children:any[]}
export const nodes=(node:any):Node[]=>node&&typeof node==='object'&&'props'in node?[node,...node.children.flatMap(nodes)]:[]
const zh=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params)
const css=new Proxy({},{get:(_,key)=>String(key)})

function mount(file:string){
 const states:any[]=[];let cursor=0
 const React={
  createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children:children.flat(Infinity)}),
  useMemo:(factory:()=>unknown)=>factory(),
  useEffect:()=>{},
  useId:()=>'fixture-id',
  useSyncExternalStore:(_subscribe:unknown,getSnapshot:()=>unknown)=>getSnapshot(),
  useState:(initial:any)=>{const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],(next:any)=>states[i]=typeof next==='function'?next(states[i]):next]},
  useRef:(value:any)=>{const i=cursor++;return states[i]??(states[i]={current:value})},
 }
 const modules:Record<string,unknown>={
  react:React,
  'lucide-react':new Proxy({},{get:()=>()=>undefined}),
  './industry-workspace-projection.js':industryWorkspaceProjection,
  './team-capabilities-presentation.js':teamCapabilitiesPresentation,
  './capability-composition.js':capabilityComposition,
  './industry-composition.js':industryComposition,
  './directory-focus.js':{useDirectoryFocus:()=>({})},
  './i18n/provider.js':{useI18n:()=>({t:zh,locale:'zh-CN',list:(values:string[])=>values.join('、')})},
  './CreateEntry.js':{CreateEntry:()=>null},
 }
 const require=(id:string)=>modules[id]??(id.endsWith('.css')?{default:css}:new Proxy({},{get:()=>()=>undefined}))
 const code=ts.transpileModule(readFileSync(new URL('../src/client/'+file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const exported:Record<string,any>={}
 new Function('require','exports','React',code)(require,exported,React)
 // 假 React 的 createElement 只造描述对象，不会像真实 React 那样递归下钻子组件；
 // 这里补一个最小递归求值，把函数型节点（如 TeamCapabilitiesPage 内部未导出的 NativeCapabilityCatalog）
 // 换成它真正渲染出的树，游标在整次渲染里单调递增，足够一次性渲染场景使用。
 const renderElement=(element:any):any=>{
  if(!element||typeof element!=='object')return element
  if(typeof element.type==='function')return renderElement(element.type(element.props))
  return {...element,children:element.children.map(renderElement)}
 }
 return {exported,render:(name:string,props:any)=>{cursor=0;return renderElement(exported[name](props)) as Node}}
}

const conversation={id:'conversation-1',ownerId:'self',title:'当前会话',scopeIds:['general'],version:1,status:'ready',requestedSessionId:'session-1',sessionId:'session-1',createdAt:'2026-09-12T00:00:00.000Z'}
const snapshot:CapabilitySnapshot={
 schema:'teloa.capabilities/v1',conversation:conversation as CapabilitySnapshot['conversation'],observedAt:'2026-09-12T00:00:00.000Z',
 skills:[{name:'review',description:'核对资料',source:'/skills/review.md',provider:'local',modelInvocable:true,userInvocable:true}],
 knowledge:{status:'ready',resources:[]},
 connections:{status:'observed',tools:[{name:'mcp__notes__search',description:'搜索笔记'}]},
 writes:{status:'not-implemented'},
}
const work={subscribe:()=>()=>{},getSnapshot:()=>({sessionId:'session-1',status:'ready',conversation,error:undefined,capabilities:snapshot,catalogStatus:'ready',catalogError:undefined}),readCatalog:async()=>{}}

// 同一模板包（templateId 稳定）在两个业务范围各加载一次，用于验证跨业务合并与业务归属副标。
const loadSOC:IndustryLoadRecord={
 id:'load-soc',ownerId:'self',contentId:'content-1',contentHash:'a'.repeat(64),
 templateId:'ops-pack',templateVersion:'2.0.0',templateTitle:'运营包',domain:'ops',scope:'SOC',description:'',
 targetVersion:1,space:{id:'space-soc',name:'安全运营',version:1,scope:'SOC'},
 items:[
  {localId:'triage',instanceId:'11111111-1111-4111-8111-111111111111',kind:'skill',title:'告警分诊',version:'1.0.0',required:true,status:'active'},
  {localId:'edr',instanceId:'22222222-2222-4222-8222-222222222222',kind:'mcp',title:'EDR 连接',version:'1.0.0',required:true,status:'active'},
  {localId:'ticketing',instanceId:'33333333-3333-4333-8333-333333333333',kind:'plugin',title:'工单插件',version:'1.0.0',required:false,status:'active'},
  {localId:'flow',instanceId:'44444444-4444-4444-8444-444444444444',kind:'work-template',title:'分诊流程',version:'1.0.0',required:true,status:'active'},
 ],
 relations:[],entrypoints:[],createdAt:'2026-09-12T00:00:00.000Z',mappingHash:'b'.repeat(64),status:'active',
}
const loadGeneral:IndustryLoadRecord={
 id:'load-general',ownerId:'self',contentId:'content-2',contentHash:'a'.repeat(64),
 templateId:'ops-pack',templateVersion:'2.0.0',templateTitle:'运营包',domain:'ops',scope:'general',description:'',
 targetVersion:1,space:{id:'space-general',name:'通用工作',version:1,scope:'general'},
 items:[
  {localId:'triage',instanceId:'55555555-5555-4555-8555-555555555555',kind:'skill',title:'告警分诊',version:'1.0.0',required:true,status:'pending-adapter'},
  {localId:'edr',instanceId:'66666666-6666-4666-8666-666666666666',kind:'mcp',title:'EDR 连接',version:'1.0.0',required:true,status:'active'},
  {localId:'ticketing',instanceId:'77777777-7777-4777-8777-777777777777',kind:'plugin',title:'工单插件',version:'1.0.0',required:false,status:'active'},
 ],
 relations:[],entrypoints:[],createdAt:'2026-09-12T00:00:00.000Z',mappingHash:'b'.repeat(64),status:'active',
}

function renderPage(navigationState:{category:string;selectedId:string|undefined;mobileLayer:string}={category:'skill',selectedId:undefined,mobileLayer:'list'},overrides:Record<string,unknown>={}){
 const page=mount('TeamCapabilitiesPage.tsx')
 const props={
  visible:true,work,runtimeExtensions:{subscribe:()=>()=>{},getSnapshot:()=>({status:'ready',items:[]}),refresh:async()=>{}},resolveExtensionText:(text:string)=>text,plugins:[],refreshPlugins:async()=>{},industryLoads:[loadSOC,loadGeneral],industryLoadsReady:true,
  openMarket:()=>{},nativeSettings:()=>{},openConversation:()=>{},configureIndustryResource:()=>{},
  businessNames:{SOC:'安全运营',general:'通用工作'},go:()=>{},
  navigationState,mode:'catalog',catalog:()=>{},...overrides,
 }
 return page.render('TeamCapabilitiesPage',props)
}
const text=(tree:Node):string[]=>nodes(tree).flatMap(node=>node.children.filter(child=>typeof child==='string'))

test('四分节标题逐字等于 COMPOSITION_ROWS 的 zh-CN 标签，顺序为 技能/接入源/任务模板/扩展',()=>{
 const expectedIds=COMPOSITION_ROWS.filter(row=>CAPABILITY_ROW_IDS.includes(row.id)).map(row=>row.id)
 assert.deepEqual(expectedIds,['skill','source','method','extension'])
 const tree=renderPage()
 const taxonomy=nodes(tree).find(node=>node.props['aria-label']===zh('teamCapability.taxonomy.aria'))!
 const buttons=nodes(taxonomy).filter(node=>node.type==='button')
 assert.equal(buttons.length,4)
 assert.deepEqual(buttons.map(button=>nodes(button).find(node=>node.type==='strong')!.children[0]),['技能','接入源','任务模板','扩展'])
})

test('页面不出现 AI 同事、依据资料、业务看板三行以外的分节',()=>{
 const tree=renderPage()
 const flat=text(tree).join(' ')
 for(const banned of ['AI 员工','依据资料','业务看板'])assert.doesNotMatch(flat,new RegExp(banned))
})

test('技能行默认可见，条目带状态词与「去配置」',()=>{
 const tree=renderPage()
 const flat=text(tree).join(' ')
 assert.match(flat,/告警分诊/)
 // 两次加载合并后取最差状态：SOC 已就绪(active→installed)、general 待适配(pending-adapter→pending-install) → 待安装。
 assert.match(flat,/待安装/)
 const detail=renderPage({category:'skill',selectedId:undefined,mobileLayer:'detail'})
 assert.ok(text(detail).includes(zh('composition.action.configure')),'详情面板应有一颗「去配置」按钮')
})

test('接入源条目副标只出现「读 / 写 / 写 · 需你审批」三种，不叠加业务归属句',()=>{
 const tree=renderPage({category:'source',selectedId:undefined,mobileLayer:'list'})
 const rowList=nodes(tree).find(node=>node.props.role==='listbox')!
 const subtitles=nodes(rowList).filter(node=>node.type==='small').flatMap(node=>node.children)
 assert.ok(subtitles.length>0)
 const allowed=new Set([zh('composition.mode.read'),zh('composition.mode.write'),zh('composition.mode.write')+' · '+zh('composition.mode.approval')])
 for(const value of subtitles)assert.ok(allowed.has(value),`接入源副标不应出现「${value}」`)
})

test('跨业务条目副标出现业务名，原生条目副标是「工作室通用」',()=>{
 const tree=renderPage({category:'skill',selectedId:undefined,mobileLayer:'list'})
 const flat=text(tree).join(' ')
 assert.match(flat,new RegExp(zh('capability.item.businesses',{businesses:'安全运营'+zh('capability.list.separator')+'通用工作'})))
 assert.match(flat,new RegExp(zh('composition.extension.note')))
})

test('每条都有状态词，选中后详情面板有「去配置」按钮',()=>{
 const tree=renderPage({category:'extension',selectedId:undefined,mobileLayer:'detail'})
 const flat=text(tree).join(' ')
 assert.match(flat,new RegExp(zh('extension.unverified')))
 assert.ok(text(tree).includes(zh('composition.action.configure')),'详情面板应展示统一的「去配置」文案')
})

test('源码不写字面四行 id 数组，且不出现禁用行业词',async()=>{
 const source=await readFile(new URL('../src/client/TeamCapabilitiesPage.tsx',import.meta.url),'utf8')
 assert.doesNotMatch(source,/\['skill','source','method','extension'\]/)
 assert.doesNotMatch(source,/SOC|AppSec|告警|资产|Splunk/)
})

test('390px 下三层各自单列、aria-current 与 listbox 语义在位',async()=>{
 const [source,styles]=await Promise.all([
  readFile(new URL('../src/client/TeamCapabilitiesPage.tsx',import.meta.url),'utf8'),
  readFile(new URL('../src/client/TeamCapabilitiesPage.module.css',import.meta.url),'utf8'),
 ])
 assert.match(styles,/@media\(max-width:720px\)\{[\s\S]*data-mobile-layer=category[\s\S]*data-mobile-layer=list[\s\S]*data-mobile-layer=detail/)
 assert.match(source,/aria-current=\{category===row\.id\?'page':undefined\}/)
 assert.match(source,/role="listbox"/)
 assert.match(source,/role="option" aria-selected=\{selected\?\.key===row\.key\}/)
})


test('去配置进入对应已加载资源，原生能力进入运行环境，不再原地选中自身',()=>{
 const targets:unknown[]=[];let settings=0
 const overrides={configureIndustryResource:(target:unknown)=>targets.push(target),nativeSettings:()=>{settings++}}
 for(const category of ['skill','source','method']){
  const tree=renderPage({category,selectedId:undefined,mobileLayer:'detail'},overrides)
  nodes(tree).find(node=>node.type==='button'&&node.children.includes(zh('composition.action.configure')))!.props.onClick()
 }
 assert.deepEqual(targets,[{loadId:loadGeneral.id,itemInstanceId:loadGeneral.items[0]!.instanceId},{loadId:loadSOC.id,itemInstanceId:loadSOC.items[1]!.instanceId},{loadId:loadSOC.id,itemInstanceId:loadSOC.items[3]!.instanceId}])
 const native=renderPage({category:'skill',selectedId:'skill:review',mobileLayer:'detail'},overrides)
 nodes(native).find(node=>node.type==='button'&&node.children.includes(zh('composition.action.configure')))!.props.onClick()
 assert.equal(settings,1)
})

test('已有目录刷新失败仍显示错误，保留原条目供查看',()=>{
 const tree=renderPage(undefined,{work:{...work,getSnapshot:()=>({...work.getSnapshot(),catalogStatus:'failed'})}})
 assert.ok(nodes(tree).some(node=>node.props.role==='alert'))
 assert.ok(nodes(tree).some(node=>node.props.role==='option'))
})

test('业务扩展目录读取失败给出错误与重试，不把旧 active 实例继续显示为已安装',()=>{
 const tree=renderPage({category:'extension',selectedId:undefined,mobileLayer:'detail'},{pluginDirectory:{loading:false,error:'offline',partial:false},plugins:[{loadId:loadSOC.id,itemInstanceId:loadSOC.items[2]!.instanceId,state:'active'}]})
 assert.ok(nodes(tree).some(node=>node.props.role==='alert'&&text(node).join(' ').includes(zh('extension.business.readFailed'))))
 assert.ok(text(tree).includes(zh('extension.unverified')))
 assert.ok(!text(tree).includes(zh('composition.state.installed')))
})
