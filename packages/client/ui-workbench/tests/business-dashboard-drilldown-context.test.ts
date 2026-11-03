import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import * as React from 'react'
import ts from 'typescript'
import * as contract from '@teloa/contract'
import type {BusinessTimeRange} from '@teloa/contract'
import * as surface from '../src/client/business-configuration-surface.ts'
import * as localization from '../src/client/business-definition-localization.ts'
import * as presentation from '../src/client/business-widget-presentation.ts'
import * as ledgerApi from '../src/client/business-ledger-api.ts'
import * as customization from '../src/client/business-customization-presentation.ts'
import {ledger,block,listView,ledgerObject} from './business-ledger-fixtures.ts'
import {createBusinessBuilderApi} from '../src/client/business-builder-api.ts'
import {BusinessConfigurationSurfaceController} from '../src/client/business-configuration-surface.ts'
import type {BusinessTarget} from '../src/client/business-preview.ts'
const hash='a'.repeat(64),stamp='2026-09-29T00:00:00.000Z'
const definition=(id:string)=>({id,kind:'records' as const,title:id,objectType:'order',fields:['stage'],allowCreate:true,allowEdit:true,allowArchive:true})
const objectType={format:'teloa.business-object-type/v1',id:'order',version:'1.0.0',domain:'sales',title:'订单',unit:'单',lead:'从第一条开始',sourceId:'local',fields:[{name:'stage',label:'阶段',from:'阶段',type:'text',required:false}]}
const current=()=>({scope:'sales',version:1,hash,createdAt:stamp,manifest:{format:'teloa.business-configuration/v1',scope:'sales',title:'客户订单',sources:[{sourceId:'local',kind:'local-records'}],definitions:[{kind:'object-type',localId:'order',version:1,definitionHash:hash}],pages:[definition('orders')],homePageId:'orders'}})
function fixture(){return {controller:new BusinessConfigurationSurfaceController(createBusinessBuilderApi(async endpoint=>endpoint.endsWith('/current')?current():{mode:'saved',scope:'sales',configurationVersion:1,configurationHash:hash,page:{kind:'records',definition:definition('orders'),objectType,emptyState:'no-records'}}),'sales')}}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return{promise,resolve}}
function dashboardDrilldownFixture(){
 const board={id:'statistics',kind:'dashboard' as const,title:'订单统计',dashboardId:'statistics'}
 const config=current();config.manifest.pages=[board,definition('orders')] as any;config.manifest.homePageId='statistics'
 config.manifest.definitions.push({kind:'dashboard' as any,localId:'statistics',version:1,definitionHash:hash},{kind:'widget' as any,localId:'orders',version:1,definitionHash:hash})
 const calls:unknown[]=[]
 let read:((input:any)=>Promise<unknown>)|undefined
 let options:BusinessTimeRange[]|undefined=['all','24h'],defaultRange:BusinessTimeRange='all'
 const api=createBusinessBuilderApi(async(endpoint,input:any)=>{
  calls.push({endpoint,input})
  if(endpoint.endsWith('/current'))return config
  if(read)return read(input)
  const selected=config.manifest.pages.find(page=>page.id===input.pageId) as unknown as typeof board
  return {mode:'saved',scope:'sales',configurationVersion:config.version,configurationHash:config.hash,page:{kind:'dashboard',definition:selected,dashboard:{format:'teloa.business-dashboard/v1',id:selected.dashboardId,version:'1.0.0',domain:'sales',title:'订单统计',widgets:['orders'],layout:[{widget:'orders',x:0,y:0,w:12,h:4}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false,...(options?{filters:{timeRange:{options,default:defaultRange}}}:{})},widgets:[{format:'teloa.business-widget/v1',id:'orders',version:'1.0.0',domain:'sales',title:'订单',kind:'table',query:'select _id from orders',timeFilter:{table:'orders',column:'_observed_at'},drilldown:{objectType:'order',idColumn:'_id'}}],results:[{widgetId:'orders',definitionHash:hash,computedAt:stamp,status:'ok',columns:[{name:'_id',type:'text'}],rows:[['order-1']],rowCount:1,truncated:false,bytes:1,stale:false}],viewRefs:[],timeRange:input.timeRange??defaultRange}}
 })
 return {api,config,controller:new BusinessConfigurationSurfaceController(api,'sales',undefined,undefined,'dashboard'),calls,setRead:(value:typeof read)=>{read=value},setOptions:(values:BusinessTimeRange[]|undefined,initial:BusinessTimeRange)=>{options=values;defaultRange=initial}}
}
test('看板下钻开关保留同一24h页面与选择，不重读或走主路由',async()=>{
 const f=dashboardDrilldownFixture();await f.controller.load();await f.controller.select('statistics','24h')
 const before=f.controller.getSnapshot(),count=f.calls.length
 const target:BusinessTarget={scope:'sales',section:'data',objectType:'order',id:'order-1',match:{field:'_id',value:'order-1'}}
 assert.equal(f.controller.openDrilldown(target),true)
 assert.deepEqual(f.controller.getSnapshot().drilldown,target)
 target.match!.value='mutated'
 assert.equal(f.controller.getSnapshot().drilldown?.match?.value,'order-1','不能持有可被外部改写的目标')
 f.controller.closeDrilldown()
 assert.equal(f.controller.getSnapshot().drilldown,null)
 assert.equal(f.controller.getSnapshot().page,before.page)
 assert.equal(f.controller.getSnapshot().selectedId,'statistics')
 assert.equal((f.controller.getSnapshot().page!.page as any).timeRange,'24h')
 assert.equal(f.calls.length,count)
})
test('下钻清单、记录和match只在同一合法看板内切换；固定引用与跨范围不被截获',async()=>{
 const f=dashboardDrilldownFixture()
 assert.equal(f.controller.openDrilldown({scope:'sales',section:'data',objectType:'order'}),false)
 await f.controller.load()
 for(const target of [{scope:'other',section:'data',objectType:'order'},{scope:'sales',section:'work'},{scope:'sales',section:'data'},{scope:'sales',section:'data',objectType:'order',recordReference:{scope:'sales',type:'order',id:'order-1',version:1,snapshotHash:hash}}])assert.equal(f.controller.openDrilldown(target as BusinessTarget),false)
 assert.equal(f.controller.openDrilldown({scope:'sales',section:'data',objectType:'order',match:{field:'stage',value:'新'}}),true)
 assert.equal(f.controller.openDrilldown({scope:'sales',section:'data',objectType:'order',id:'order-1',match:{field:'stage',value:'新'}}),true)
 assert.equal(f.controller.openDrilldown({scope:'sales',section:'data',objectType:'order',match:{field:'stage',value:'新'}}),true)
 assert.equal(f.controller.getSnapshot().drilldown?.id,undefined)
 const record=fixture();await record.controller.load()
 assert.equal(record.controller.openDrilldown({scope:'sales',section:'data',objectType:'order'}),false)
 f.controller.dispose();assert.equal(f.controller.openDrilldown({scope:'sales',section:'data',objectType:'order'}),false)
})
test('刷新或换范围立即关闭下钻，在途读取不能重新带回旧目标',async()=>{
 const f=dashboardDrilldownFixture();await f.controller.load();await f.controller.select('statistics','24h')
 f.controller.openDrilldown({scope:'sales',section:'data',objectType:'order',id:'order-1'})
 const original=f.controller.getSnapshot().page!,gate=deferred<unknown>()
 f.setRead(()=>gate.promise);const pending=f.controller.select('statistics','all')
 assert.equal(f.controller.getSnapshot().drilldown,null)
 assert.equal(f.controller.openDrilldown({scope:'sales',section:'data',objectType:'order'}),false)
 gate.resolve({...original,page:{...original.page,timeRange:'all'}});await pending
 assert.equal(f.controller.getSnapshot().drilldown,null)
 f.controller.openDrilldown({scope:'sales',section:'data',objectType:'order'})
 const reload=f.controller.load();assert.equal(f.controller.getSnapshot().drilldown,null);await reload
 assert.equal(f.controller.getSnapshot().drilldown,null)
})

test('旧页面投影的下钻回调在换范围或刷新完成后仍失效',async()=>{
 const f=dashboardDrilldownFixture(),target:BusinessTarget={scope:'sales',section:'data',objectType:'order'}
 await f.controller.load();const old=f.controller.getSnapshot().page!
 await f.controller.select('statistics','24h')
 assert.equal(f.controller.openDrilldown(target,old),false)
 const latest=f.controller.getSnapshot().page!
 assert.equal(f.controller.openDrilldown(target,latest),true)
 await f.controller.load()
 assert.equal(f.controller.openDrilldown(target,latest),false)
 assert.equal(f.controller.getSnapshot().drilldown,null)
})

type TestNode={type:any;props:Record<string,any>;scrollTop:number}
type Hook={value?:any;deps?:readonly unknown[]|undefined;cleanup?:(()=>void)|undefined}
const text=(node:any):string=>Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'&&'props'in node?text(node.props.children):node===null||node===undefined||typeof node==='boolean'?'':String(node)
/**
 * Node 中运行真实组件接线并保留每个组件的 hook、effect 清理和宿主节点身份。
 * 只替换 React 调度及原生抽屉端口；不模拟浏览器滚动、焦点或 dialog 行为。
 */
function componentFixture(){
 const instances=new Map<string,{type:any;hooks:Hook[];cursor:number;seen:boolean}>(),hosts=new Map<string,TestNode>(),seenHosts=new Set<string>()
 let active:ReturnType<typeof instances.get>,dirty=true,effects:Array<()=>void>=[],tree:any,props:any
 const equal=(a:readonly unknown[]|undefined,b:readonly unknown[]|undefined)=>a!==undefined&&b!==undefined&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]))
 const hook=()=>{assert.ok(active,'hook 必须属于组件');return active.hooks[active.cursor++]??(active.hooks[active.cursor-1]={})}
 const effect=(run:()=>void|(()=>void),deps?:readonly unknown[])=>{const slot=hook();if(!equal(slot.deps,deps)){slot.deps=deps;effects.push(()=>{slot.cleanup?.();slot.cleanup=run()||undefined})}}
 const hooks={...React,
  useState:(initial:any)=>{const slot=hook();if(!('value'in slot))slot.value=typeof initial==='function'?initial():initial;return[slot.value,(next:any)=>{const value=typeof next==='function'?next(slot.value):next;if(!Object.is(slot.value,value)){slot.value=value;dirty=true}}]},
  useRef:(value:any)=>{const slot=hook();return slot.value??(slot.value={current:value})},
  useMemo:(factory:()=>any,deps:readonly unknown[])=>{const slot=hook();if(!equal(slot.deps,deps)){slot.deps=deps;slot.value=factory()}return slot.value},
  useEffect:effect,useLayoutEffect:effect,
  useSyncExternalStore:(subscribe:(listener:()=>void)=>()=>void,get:()=>any)=>{effect(()=>subscribe(()=>{dirty=true}),[subscribe]);return get()},
 }
 const empty=()=>null,t=(key:string,params?:Record<string,unknown>)=>key+(params?JSON.stringify(params):'')
 const modules:Record<string,any>={react:hooks,'@teloa/contract':contract,
  './i18n/provider.js':{useI18n:()=>({t,locale:'zh-CN',number:String,dateTime:String,date:String,list:(values:string[])=>values.join(', ')})},
  './business-configuration-surface.js':surface,'./business-definition-localization.js':localization,'./business-widget-presentation.js':presentation,
  './business-ledger-api.js':ledgerApi,'./business-customization-presentation.js':customization,
  './ContextDrawer.js':{ContextDrawer:({children,close}:any)=>React.createElement('dialog',null,React.createElement('button',{'data-test-close':true,onClick:close},'close'),children)},
  './ToolbarIconButton.js':{ToolbarIconButton:({label,onClick,disabled}:any)=>React.createElement('button',{'aria-label':label,onClick,disabled},label)},
  './BusinessTypedViewWidget.js':{BusinessTypedViewWidget:empty,BusinessTypedViewNotes:empty,typedViewSharedCoverage:()=>new Map()},
  './BusinessDashboardShare.js':{DashboardShareProvider:({children}:any)=>children,BusinessDashboardShareButton:empty},
  './business-scope-context.js':{useBusinessScopes:()=>({sales:'客户订单'})},
  './industry-workspace-projection.js':{projectIndustryWorkspace:()=>[]},'./industry-composition.js':{composeFromWorkspace:()=>[]},
  './business-preview.js':{projectTypeLabel:()=> '项目'},'./business-library-presentation.js':{businessLibraryText:()=>({})},
 }
 function load(file:string){
  const code=ts.transpileModule(readFileSync(new URL('../src/client/'+file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
  const exported:Record<string,any>={}
  const require=(id:string)=>modules[id]??(id==='lucide-react'?new Proxy({},{get:()=>empty}):id.endsWith('.css')?{default:new Proxy({},{get:(_,key)=>String(key)})}:new Proxy({},{get:()=>empty}))
  new Function('require','exports','React',code)(require,exported,hooks)
  modules['./'+file.replace(/\.tsx$/,'.js')]=exported
  return exported
 }
 for(const file of ['BusinessLedger.tsx','BusinessWidgets.tsx','BusinessDashboardGrid.tsx','BusinessConfigurationPage.tsx','BusinessConfigurationSurface.tsx'])load(file)
 const {BusinessPage}=load('BusinessPage.tsx')
 function visit(value:any,path:string):any{
  if(Array.isArray(value))return value.map((child,index)=>visit(child,path+'/'+(child?.key??index)))
  if(!React.isValidElement<Record<string,any>>(value))return value
  if(value.type===React.Fragment)return visit(value.props.children,path+'/fragment')
  if(typeof value.type==='function'){
   let instance=instances.get(path)
   if(instance?.type!==value.type){
    instance?.hooks.forEach(slot=>slot.cleanup?.())
    for(const [childPath,child]of instances)if(childPath.startsWith(path+'/')){child.hooks.forEach(slot=>slot.cleanup?.());instances.delete(childPath)}
    for(const hostPath of hosts.keys())if(hostPath.startsWith(path+'/'))hosts.delete(hostPath)
    instance={type:value.type,hooks:[],cursor:0,seen:true};instances.set(path,instance)
   }
   instance.cursor=0;instance.seen=true;active=instance
   const output=(value.type as (props:any)=>any)(value.props);active=undefined
   return visit(output,path+'/output')
  }
  let node=hosts.get(path);if(node?.type!==value.type){node={type:value.type,props:{},scrollTop:0};hosts.set(path,node)}
  seenHosts.add(path)
  node.props={...value.props,children:visit(value.props.children,path+'/children')}
  if(value.props.ref&&typeof value.props.ref==='object')value.props.ref.current=node
  return node
 }
 function render(next=props,commit=true){
  props=next;dirty=false;seenHosts.clear();instances.forEach(instance=>{instance.seen=false})
  tree=visit(React.createElement(BusinessPage,props),'root')
  for(const [path,instance]of instances)if(!instance.seen){instance.hooks.forEach(slot=>slot.cleanup?.());instances.delete(path)}
  for(const path of hosts.keys())if(!seenHosts.has(path))hosts.delete(path)
  if(commit){const pending=effects;effects=[];pending.forEach(run=>run())}
  return tree
 }
 const nodes=(node:any):TestNode[]=>Array.isArray(node)?node.flatMap(child=>nodes(child)):node&&typeof node==='object'&&'props'in node?[node,...nodes(node.props.children)]:[]
 return {render,nodes:()=>nodes(tree),async settle(){for(let index=0;index<16;index++){await Promise.resolve();if(dirty)render()}},unmount(){instances.forEach(instance=>instance.hooks.forEach(slot=>slot.cleanup?.()));instances.clear();hosts.clear()}}
}
async function mountedDashboard(){
 const f=dashboardDrilldownFixture(),ui=componentFixture(),external:BusinessTarget[]=[],reads:any[]=[]
 const value=await ledgerApi.readBusinessLedger(ledger({scope:'sales',actions:[],blocks:[block({scope:'sales',definition:{...objectType,defaultAction:null},defaultAction:null,objects:1,views:[listView('sales','order',[ledgerObject('sales','order','order-1',{fields:[{label:'阶段',value:'新'}]})])]})]}),'sales')
 const businessLedgerApi={read:async(input:any)=>{reads.push(input);return value}}
 const nothing=()=>{},props:any={visible:true,target:{scope:'sales',section:'dashboards'},configuration:{api:f.api,records:{api:{}},capabilities:{},adjust:nothing},colorScheme:'light',businessLedgerApi,businessTaskApi:{pending:()=>undefined},state:{roles:[],tasks:[]},industryLoads:[],dataSources:[],pageCreate:{api:{},prepare:nothing},backHome:nothing,go:(target:BusinessTarget)=>external.push(target)}
 ui.render(props);await ui.settle()
 const find=(predicate:(node:TestNode)=>boolean)=>{const node=ui.nodes().find(predicate);assert.ok(node);return node}
 const range=find(node=>node.type==='select'&&node.props.value==='all');range.props.onChange({target:{value:'24h'}});await ui.settle()
 return{f,ui,props,external,reads,find,row:()=>find(node=>node.props['data-drilldown-row']!==undefined),drawer:()=>ui.nodes().find(node=>node.type==='dialog'),scroll:()=>find(node=>node.props.className==='scroll')}
}
test('真实BusinessPage接线：SQL行下钻、回清单和关闭保留24h与原滚动容器',async t=>{
 const f=await mountedDashboard();t.after(()=>f.ui.unmount())
 const scroll=f.scroll();scroll.scrollTop=276;const count=f.f.calls.length
 f.row().props.onClick();await f.ui.settle()
 assert.ok(f.drawer());assert.deepEqual(f.external,[])
 assert.ok(f.reads.some(read=>read.objectType==='order'&&read.match?.value==='order-1'))
 const back=f.find(node=>node.type==='button'&&text(node).includes('business.ledger.backDirectory'))
 back.props.onClick();await f.ui.settle();assert.ok(f.drawer())
 f.find(node=>node.props['data-test-close']).props.onClick();await f.ui.settle()
 assert.equal(f.drawer(),undefined);assert.equal(f.scroll(),scroll);assert.equal(scroll.scrollTop,276)
 assert.equal(f.find(node=>node.type==='select'&&node.props.value==='24h').props.value,'24h')
 assert.equal(f.f.calls.length,count);assert.deepEqual(f.external,[])
 // 对照真正离开并重挂载：宿主身份必须变化，夹具不能用缓存伪造滚动容器保留。
 f.ui.render({...f.props,visible:false});f.ui.render(f.props);await f.ui.settle();assert.notEqual(f.scroll(),scroll)
})
test('台账或动作API身份切换在effect前隐藏旧抽屉，旧回调不能走主路由',async t=>{
 for(const field of ['businessLedgerApi','businessTaskApi']){
  const f=await mountedDashboard();t.after(()=>f.ui.unmount())
  const stale=f.row().props.onClick;stale();await f.ui.settle();assert.ok(f.drawer())
  const oldClose=f.find(node=>node.props['data-test-close']).props.onClick
  const next={...f.props,[field]:{...f.props[field]}}
  f.ui.render(next,false)
  assert.equal(f.drawer(),undefined,field+' 切换时不能暂显旧详情')
  stale();oldClose();assert.deepEqual(f.external,[])
  f.ui.render(next);await f.ui.settle();stale();await f.ui.settle()
  assert.equal(f.drawer(),undefined);assert.deepEqual(f.external,[])
 }
})
test('旧页面和已关闭抽屉的事件失效，当前详情仍可回清单',async t=>{
 const f=await mountedDashboard();t.after(()=>f.ui.unmount())
 const stalePage=f.row().props.onClick
 f.find(node=>node.type==='select'&&node.props.value==='24h').props.onChange({target:{value:'all'}});await f.ui.settle()
 stalePage();await f.ui.settle();assert.equal(f.drawer(),undefined)
 f.row().props.onClick();await f.ui.settle()
 const staleBack=f.find(node=>node.type==='button'&&text(node).includes('business.ledger.backDirectory')).props.onClick
 const staleClose=f.find(node=>node.props['data-test-close']).props.onClick
 staleClose();await f.ui.settle();staleBack();await f.ui.settle();assert.equal(f.drawer(),undefined)
 f.row().props.onClick();await f.ui.settle();staleClose();await f.ui.settle();assert.ok(f.drawer(),'旧关闭不能关闭新一层详情')
 f.find(node=>node.type==='button'&&text(node).includes('business.ledger.backDirectory')).props.onClick();await f.ui.settle();assert.ok(f.drawer())
 assert.deepEqual(f.external,[])
})

test('刷新范围：同配置保留24h且只重读一次页面',async()=>{
 const f=dashboardDrilldownFixture();await f.controller.load();await f.controller.select('statistics','24h')
 const before=f.calls.length
 await f.controller.load()
 assert.equal((f.controller.getSnapshot().page!.page as any).timeRange,'24h')
 assert.deepEqual((f.calls.slice(before) as any[]).map(call=>call.input),[{scope:'sales'},{scope:'sales',pageId:'statistics',timeRange:'24h'}])
})
test('刷新范围：读取失败与刷新在途再次刷新均保留显式选择',async()=>{
 const f=dashboardDrilldownFixture();await f.controller.load()
 f.setRead(async()=>{throw Error('controlled read failure')})
 await f.controller.select('statistics','24h')
 assert.equal(f.controller.getSnapshot().pageStatus,'failed')
 f.setRead(undefined);await f.controller.load()
 assert.equal((f.controller.getSnapshot().page!.page as any).timeRange,'24h')
 const original=f.controller.getSnapshot().page!,gate=deferred<unknown>()
 f.setRead(()=>gate.promise);const old=f.controller.load()
 await Promise.resolve()
 f.setRead(undefined);await f.controller.load()
 gate.resolve({...original,page:{...original.page,timeRange:'all'}});await old
 assert.equal((f.controller.getSnapshot().page!.page as any).timeRange,'24h','迟到的旧读取不能改变已恢复的范围')
})
test('刷新范围：不同看板分别保留选择，身份新实例不继承',async()=>{
 const f=dashboardDrilldownFixture()
 f.config.manifest.pages.push({id:'second',kind:'dashboard',title:'第二看板',dashboardId:'second'} as any)
 f.config.manifest.definitions.push({kind:'dashboard' as any,localId:'second',version:1,definitionHash:hash})
 await f.controller.load();await f.controller.select('statistics','24h')
 await f.controller.select('second')
 assert.equal((f.controller.getSnapshot().page!.page as any).timeRange,'all')
 await f.controller.select('statistics')
 assert.equal((f.controller.getSnapshot().page!.page as any).timeRange,'24h')
 const next=new BusinessConfigurationSurfaceController(f.api,'sales',undefined,undefined,'dashboard');await next.load()
 assert.equal((next.getSnapshot().page!.page as any).timeRange,'all')
})
test('刷新范围：新配置先核对选项，仍支持时恢复原范围',async()=>{
 const f=dashboardDrilldownFixture();await f.controller.load();await f.controller.select('statistics','24h')
 f.config.version=2;f.config.hash='b'.repeat(64)
 const before=f.calls.length
 await f.controller.load()
 const state=f.controller.getSnapshot()
 assert.equal(state.pageStatus,'ready');assert.equal((state.page!.page as any).timeRange,'24h')
 assert.deepEqual((f.calls.slice(before) as any[]).filter(call=>call.endpoint.endsWith('/page')).map(call=>call.input),[{scope:'sales',pageId:'statistics'},{scope:'sales',pageId:'statistics',timeRange:'24h'}])
})
test('刷新范围：新配置移除旧范围后采用新默认，并只读一次',async()=>{
 const f=dashboardDrilldownFixture();await f.controller.load();await f.controller.select('statistics','24h')
 f.config.version=2;f.config.hash='b'.repeat(64);f.setOptions(['7d','all'],'7d')
 const before=f.calls.length
 await f.controller.load()
 assert.equal(f.controller.getSnapshot().pageStatus,'ready')
 assert.equal((f.controller.getSnapshot().page!.page as any).timeRange,'7d')
 assert.equal((f.calls.slice(before) as any[]).filter(call=>call.endpoint.endsWith('/page')).length,1)
 await f.controller.load()
 assert.equal((f.controller.getSnapshot().page!.page as any).timeRange,'7d')
})
test('刷新范围：未显式选择时跟随新配置默认，不把旧默认当偏好',async()=>{
 const f=dashboardDrilldownFixture();await f.controller.load()
 f.config.version=2;f.config.hash='b'.repeat(64);f.setOptions(['all','24h'],'24h')
 const before=f.calls.length
 await f.controller.load()
 assert.equal((f.controller.getSnapshot().page!.page as any).timeRange,'24h')
 assert.equal((f.calls.slice(before) as any[]).filter(call=>call.endpoint.endsWith('/page')).length,1)
})
test('刷新范围：旧显式选择失效后不把fallback记为偏好，后续仍跟随默认',async()=>{
 const f=dashboardDrilldownFixture();await f.controller.load();await f.controller.select('statistics','24h')
 f.config.version=2;f.config.hash='b'.repeat(64);f.setOptions(['all','7d'],'7d')
 await f.controller.load();assert.equal((f.controller.getSnapshot().page!.page as any).timeRange,'7d')
 f.config.version=3;f.config.hash='c'.repeat(64);f.setOptions(['all','7d'],'all')
 await f.controller.load()
 assert.equal((f.controller.getSnapshot().page!.page as any).timeRange,'all')
})
test('刷新范围：移除全部filters清除显式all，恢复filters后跟随新默认',async()=>{
 const f=dashboardDrilldownFixture();await f.controller.load();await f.controller.select('statistics','all')
 f.config.version=2;f.config.hash='b'.repeat(64);f.setOptions(undefined,'all')
 await f.controller.load()
 assert.equal((f.controller.getSnapshot().page!.page as any).dashboard.filters,undefined)
 assert.equal((f.controller.getSnapshot().page!.page as any).timeRange,'all')
 f.config.version=3;f.config.hash='c'.repeat(64);f.setOptions(['all','24h'],'24h')
 await f.controller.load()
 assert.equal((f.controller.getSnapshot().page!.page as any).timeRange,'24h')
})
