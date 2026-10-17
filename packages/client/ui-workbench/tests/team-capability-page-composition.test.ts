import assert from 'node:assert/strict'
import test from 'node:test'
import {existsSync,readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import type {CapabilitySnapshot} from '@teloa/contract'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
// 逻辑模块读取本轮源码，避免未构建时使用旧能力目录投影。
registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('.js')&&specifier.startsWith('.')&&context.parentURL?.includes('/ui-workbench/src/client/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL)
  if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const {translateMessage}=await import('../src/client/i18n/messages.ts')
const industryComposition=await import('../src/client/industry-composition.ts')
const capabilityComposition=await import('../src/client/capability-composition.ts')
const teamCapabilitiesPresentation=await import('../src/client/team-capabilities-presentation.ts')
const industryWorkspaceProjection=await import('../src/client/industry-workspace-projection.ts')
const capabilitySkillRuntime=await import('../src/client/capability-skill-runtime.ts')
const capabilityCenterCatalog=await import('../src/client/capability-center-catalog.ts')
const {COMPOSITION_ROWS,CAPABILITY_ROW_IDS}=industryComposition

// 手法同 market-component-harness.ts：.tsx 走 ts.transpileModule 产出 CommonJS，配一份支持
// useState/useSyncExternalStore 的最小假 React；真实取数模块（capability-composition 等）原样接入，
// 只有 CSS Modules、图标与 i18n provider 换成假实现——但 t() 换成真的 translateMessage，好断言真实 zh-CN 文案。
export type Node={type:any;props:Record<string,any>;children:any[]}
export const nodes=(node:any):Node[]=>node&&typeof node==='object'&&'props'in node?[node,...node.children.flatMap(nodes)]:[]
const zh=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params)
const css=new Proxy({},{get:(_,key)=>String(key)})

function mount(file:string){
 const states:any[]=[],effects:Array<()=>void>=[];let cursor=0
 const React={
  createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children:children.flat(Infinity)}),
  useMemo:(factory:()=>unknown)=>factory(),
  useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>{const i=cursor++,prior=states[i];if(prior&&deps.every((value,index)=>Object.is(value,prior.deps[index])))return;prior?.cleanup?.();states[i]={deps};effects.push(()=>{states[i].cleanup=effect()})},
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
  './capability-skill-runtime.js':capabilitySkillRuntime,
  // 接入源分组按服务器合并 MCP 工具（原「我的能力」中心行为，现为唯一形态），用真模块
  './capability-center-catalog.js':capabilityCenterCatalog,
  './industry-composition.js':industryComposition,
  './directory-focus.js':{useDirectoryFocus:()=>({})},
  './i18n/provider.js':{useI18n:()=>({t:zh,locale:'zh-CN',list:(values:string[])=>values.join('、')})},
  './CreateEntry.js':{CreateEntry:()=>null},
  './ContextDrawer.js':{ContextDrawer:({children}:any)=>React.createElement('dialog',{},children)},
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
  if(typeof element.type==='function')return renderElement(element.type({...element.props,children:element.children}))
  return {...element,children:element.children.map(renderElement)}
 }
 return {exported,render:async(name:string,props:any)=>{let tree:Node;for(let i=0;i<3;i++){cursor=0;tree=renderElement(exported[name](props)) as Node;for(const effect of effects.splice(0))effect();await new Promise(resolve=>setImmediate(resolve))}return tree!}}
}

const conversation={id:'conversation-1',ownerId:'self',title:'当前会话',scopeIds:['general'],version:1,status:'ready',requestedSessionId:'session-1',sessionId:'session-1',createdAt:'2026-09-12T00:00:00.000Z'}
const snapshot:CapabilitySnapshot={
 schema:'teloa.capabilities/v1',conversation:conversation as CapabilitySnapshot['conversation'],observedAt:'2026-09-12T00:00:00.000Z',
 skills:[{name:'review',description:'核对资料',source:'/skills/review.md',provider:'local',modelInvocable:true,userInvocable:true}],
 knowledge:{status:'ready',resources:[]},
 connections:{status:'observed',tools:[{name:'mcp__notes__search',description:'搜索笔记'}]},
 writes:{status:'not-implemented'},
}
const work={subscribe:()=>()=>{},getSnapshot:()=>({sessionId:'session-1',status:'ready',conversation,error:undefined,capabilities:snapshot,catalogStatus:'ready',catalogError:undefined}),readCatalog:async()=>{},readHomeSkills:async()=>snapshot.skills}

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

async function renderPage(navigationState:{category:string;selectedId:string|undefined;mobileLayer:string}={category:'skill',selectedId:undefined,mobileLayer:'list'},overrides:Record<string,unknown>={}){
 const page=mount('TeamCapabilitiesPage.tsx')
 const props={
  visible:true,work,runtimeExtensions:{subscribe:()=>()=>{},getSnapshot:()=>({status:'ready',items:[]}),refresh:async()=>{}},resolveExtensionText:(text:string)=>text,plugins:[],refreshPlugins:async()=>{},industryLoads:[loadSOC,loadGeneral],industryLoadsReady:true,skillInstallApi:{list:async()=>({items:[],usages:[]}),preview:async(source:{loadId:string;itemInstanceId:string})=>{const load=[loadSOC,loadGeneral].find(row=>row.id===source.loadId)!;const item=load.items.find(row=>row.instanceId===source.itemInstanceId)!;return {source:{kind:'industry',...source,contentId:load.contentId,contentHash:load.contentHash,resourceId:item.localId,resourceVersion:item.version}}}},
  openMarket:()=>{},nativeSettings:()=>{},openConversation:()=>{},configureIndustryResource:()=>{},
  businessNames:{SOC:'安全运营',general:'通用工作'},go:()=>{},
  navigationState,mode:'catalog',catalog:()=>{},...overrides,
 }
 return page.render('TeamCapabilitiesPage',props)
}
const text=(tree:Node):string[]=>nodes(tree).flatMap(node=>node.children.filter(child=>typeof child==='string'))
// 并入市场「已添加」后详情只随用户选择在抽屉展开，不再默认选中第一行；详情用例先取列表首行的真实键再选中。
async function firstKey(category:string,overrides:Record<string,unknown>={}){
 const tree=await renderPage({category,selectedId:undefined,mobileLayer:'list'},overrides)
 const key=nodes(tree).find(node=>node.props.role==='option')?.props['data-teloa-entry'] as string|undefined
 assert.ok(key,category+' 分组应有可选条目');return key
}

test('四分节沿用当前定稿标题，顺序为技能/连接器/工作安排/应用',async()=>{
 const expectedIds=COMPOSITION_ROWS.filter(row=>CAPABILITY_ROW_IDS.includes(row.id)).map(row=>row.id)
 assert.deepEqual(expectedIds,['skill','source','method','extension'])
 const tree=await renderPage()
 assert.equal(nodes(tree).some(node=>node.type==='h1'),false,'并入市场已添加页签后没有自己的页标题')
 const taxonomy=nodes(tree).find(node=>node.props['aria-label']===zh('capabilityCenter.groupsAria'))!
 const buttons=nodes(taxonomy).filter(node=>node.type==='button')
 assert.equal(buttons.length,4)
 assert.deepEqual(buttons.map(button=>nodes(button).find(node=>node.type==='strong')!.children[0]),['技能','连接器','工作安排','应用'])
})

test('页面不出现 AI 同事、依据资料、业务看板三行以外的分节',async()=>{
 const tree=await renderPage()
 const flat=text(tree).join(' ')
 for(const banned of ['AI 员工','依据资料','业务看板'])assert.doesNotMatch(flat,new RegExp(banned))
})

test('技能行默认可见，条目带状态词与「去配置」',async()=>{
 const tree=await renderPage()
 const flat=text(tree).join(' ')
 assert.match(flat,/告警分诊/)
 // 原声明 active 不是安装证明；两个实例均核实没有安装记录。
 assert.match(flat,new RegExp(zh('capabilityCenter.skill.not-installed')))
 assert.equal(text(tree).includes(zh('composition.action.configure')),false,'未选中时不展开详情抽屉')
 const detail=await renderPage({category:'skill',selectedId:await firstKey('skill'),mobileLayer:'detail'})
 assert.ok(text(detail).includes(zh('composition.action.configure')),'详情面板应有一颗「去配置」按钮')
})

test('接入源条目副标只出现「读 / 写 / 写 · 需你审批」三种，不叠加业务归属句',async()=>{
 const tree=await renderPage({category:'source',selectedId:undefined,mobileLayer:'list'})
 const rowList=nodes(tree).find(node=>node.props.role==='listbox')!
 const rows=nodes(rowList).filter(node=>node.props.role==='option')
 assert.ok(rows.length>0)
 const allowed=new Set([zh('composition.mode.read'),zh('composition.mode.write'),zh('composition.mode.write')+' · '+zh('composition.mode.approval')])
 for(const row of rows){
  const subtitles=nodes(row).filter(node=>node.type==='small').flatMap(node=>node.children)
  // 会话里发现的同服务器 MCP 工具合并成一个连接器，副标只报工具数；业务接入源仍只写读／写／需审批
  if(String(row.props['data-teloa-entry']).startsWith('connector:')){assert.deepEqual(subtitles,[zh('capabilityCenter.tools',{count:subtitles.length?Number(/\d+/.exec(String(subtitles[0]))?.[0]):0})]);continue}
  assert.ok(subtitles.length>0,'业务接入源行应有读／写副标')
  for(const value of subtitles)assert.ok(allowed.has(value),`接入源副标不应出现「${value}」`)
 }
})

test('跨业务条目副标出现业务名，原生条目副标是「工作室通用」',async()=>{
 const tree=await renderPage({category:'skill',selectedId:undefined,mobileLayer:'list'})
 const flat=text(tree).join(' ')
 assert.match(flat,new RegExp(zh('capability.item.businesses',{businesses:'安全运营'+zh('capability.list.separator')+'通用工作'})))
 assert.match(flat,new RegExp(zh('composition.extension.note')))
})

test('每条都有状态词，选中后详情面板有「去配置」按钮',async()=>{
 const tree=await renderPage({category:'extension',selectedId:await firstKey('extension'),mobileLayer:'detail'})
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
 assert.match(source,/aria-current=\{category===id\?'page':undefined\}/)
 assert.match(source,/role="listbox"/)
 assert.match(source,/role="option" aria-selected=\{selected\?\.key===row\.key\}/)
})


test('去配置进入对应已加载资源，原生能力进入运行环境，不再原地选中自身',async()=>{
 const targets:unknown[]=[];let settings=0
 const overrides={configureIndustryResource:(target:unknown)=>targets.push(target),nativeSettings:()=>{settings++}}
 for(const category of ['skill','source','method']){
  const tree=await renderPage({category,selectedId:await firstKey(category,overrides),mobileLayer:'detail'},overrides)
  nodes(tree).find(node=>node.type==='button'&&node.children.includes(zh('composition.action.configure')))!.props.onClick()
 }
 assert.deepEqual(targets,[{loadId:loadSOC.id,itemInstanceId:loadSOC.items[0]!.instanceId},{loadId:loadSOC.id,itemInstanceId:loadSOC.items[1]!.instanceId},{loadId:loadSOC.id,itemInstanceId:loadSOC.items[3]!.instanceId}])
 const native=await renderPage({category:'skill',selectedId:'skill:review',mobileLayer:'detail'},overrides)
 nodes(native).find(node=>node.type==='button'&&node.children.includes(zh('composition.action.configure')))!.props.onClick()
 assert.equal(settings,1)
})

test('已有目录刷新失败仍显示错误，保留原条目供查看',async()=>{
 const tree=await renderPage({category:'source',selectedId:undefined,mobileLayer:'list'},{work:{...work,getSnapshot:()=>({...work.getSnapshot(),catalogStatus:'failed'})}})
 assert.ok(nodes(tree).some(node=>node.props.role==='alert'))
 assert.ok(nodes(tree).some(node=>node.props.role==='option'))
})

test('业务扩展目录读取失败给出错误与重试，不把旧 active 实例继续显示为已安装',async()=>{
 const tree=await renderPage({category:'extension',selectedId:undefined,mobileLayer:'detail'},{pluginDirectory:{loading:false,error:'offline',partial:false},plugins:[{loadId:loadSOC.id,itemInstanceId:loadSOC.items[2]!.instanceId,state:'active'}]})
 assert.ok(nodes(tree).some(node=>node.props.role==='alert'&&text(node).join(' ').includes(zh('extension.business.readFailed'))))
 assert.ok(text(tree).includes(zh('extension.unverified')))
 assert.ok(!text(tree).includes(zh('composition.state.installed')))
})
