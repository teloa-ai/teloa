import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import * as React from 'react'
import * as contract from '@teloa/contract'

const source=(name:string)=>readFile(new URL('../src/client/'+name,import.meta.url),'utf8')

test('看板页打开时调度器正在刷新：定时静默重读，直到 refreshing 结束；本地手动刷新期间不重复读；卸载与重读前清定时器并中止请求',async()=>{
 const page=await source('BusinessDashboardPage.tsx')
 assert.match(page,/const dashboardRefreshingPollMs=3000/)
 assert.match(page,/serverRefreshing=state\.status==='ready'&&state\.page\.refreshing/)
 assert.match(page,/if\(!serverRefreshing\|\|refreshing\)return/)
 assert.match(page,/setTimeout\(\(\)=>void api\.read\(\{scope,dashboardId,timeRange:range\},controller\.signal\)/)
 assert.match(page,/return \(\)=>\{clearTimeout\(timer\);controller\.abort\(\)\}/)
})

test('看板页组件 key 带业务范围：两个范围里同 id 的看板切换时重新挂载',async()=>{
 const business=await source('BusinessPage.tsx')
 assert.match(business,/<BusinessDashboardPage key=\{JSON\.stringify\(\[target\.scope,target\.dashboardId\]\)\}/)
})

/**
 * 整页时间范围（规格 §3.3 / §3.5）：真实运行 BusinessDashboardPage 的组件函数与 effect，只替换钩子调度
 * （手法与 auto-dream-settings-visibility.test.ts 一致），不经过 jsdom；子组件 BusinessWidget 只看传入的 props。
 */
type Element=React.ReactElement<Record<string,any>>
const elements=(node:React.ReactNode):Element[]=>{
 if(Array.isArray(node))return node.flatMap(elements)
 if(!React.isValidElement<Record<string,any>>(node))return []
 if(node.type===BusinessDashboardGrid)return [node,...elements(BusinessDashboardGrid(node.props))]
 return [node,...elements(node.props.children)]
}
const presentation=await import('../src/client/business-widget-presentation.ts')
function BusinessWidgetStub(){return null}
// 运行抽出的真实布局，仅组件内容继续使用原 stub；保留容器请求和刷新断言。
const gridExports:Record<string,any>={}
const gridCode=ts.transpileModule(readFileSync(new URL('../src/client/BusinessDashboardGrid.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
new Function('require','exports','React',gridCode)((id:string)=>{
 if(id.endsWith('BusinessWidgets.js'))return {BusinessWidget:BusinessWidgetStub}
 if(id.endsWith('BusinessTypedViewWidget.js'))return {BusinessTypedViewWidget:BusinessWidgetStub}
 if(id.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})}
 throw Error('布局的未预期依赖：'+id)
},gridExports,React)
const BusinessDashboardGrid=gridExports.BusinessDashboardGrid as (props:Record<string,any>)=>React.ReactNode

function mountPage(api:unknown){
 let slots:unknown[]=[],cursor=0,dirty=true,tree:React.ReactNode
 const effects=new Map<number,{deps:readonly unknown[];cleanup?:(()=>void)|undefined}>()
 let pending:Array<()=>void>=[]
 const hooks={...React,
  useState:(initialValue:unknown)=>{const index=cursor++;if(!(index in slots))slots[index]=typeof initialValue==='function'?(initialValue as ()=>unknown)():initialValue;return [slots[index],(next:unknown)=>{const value=typeof next==='function'?(next as (before:unknown)=>unknown)(slots[index]):next;if(!Object.is(value,slots[index])){slots[index]=value;dirty=true}}]},
  useEffect:(run:()=>void|(()=>void),deps:readonly unknown[])=>{
   const index=cursor++,previous=effects.get(index)
   if(previous&&deps.every((value,depIndex)=>Object.is(value,previous.deps[depIndex])))return
   pending.push(()=>{previous?.cleanup?.();effects.set(index,{deps,cleanup:run()??undefined})})
  },
  useRef:(initialValue:unknown)=>{const index=cursor++;if(!(index in slots))slots[index]={current:initialValue};return slots[index]},
 }
 const t=(key:string,params?:Record<string,string|number>)=>params?key+':'+JSON.stringify(params):key
 const stub=(id:string):unknown=>{
  if(id==='react')return hooks
  if(id==='lucide-react')return new Proxy({},{get:()=>()=>null})
  if(id==='@teloa/contract')return contract
  if(id.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})}
  if(id.endsWith('i18n/provider.js'))return {useI18n:()=>({t,locale:'zh-CN',dateTime:()=>'time'})}
  if(id.endsWith('business-definition-localization.js'))return {localizedBusinessViewTitle:(value:{title:string})=>value.title}
  if(id.endsWith('business-widget-presentation.js'))return presentation
  if(id.endsWith('BusinessDashboardGrid.js'))return {BusinessDashboardGrid}
  throw Error('未预期的依赖：'+id)
 }
 const code=ts.transpileModule(readFileSync(new URL('../src/client/BusinessDashboardPage.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const exported:Record<string,any>={}
 new Function('require','exports','React',code)(stub,exported,hooks)
 const Component=exported.BusinessDashboardPage as (props:Record<string,unknown>)=>React.ReactNode
 const props={scope:'SOC',dashboardId:'soc-ops',api,colorScheme:'light',back:()=>{}}
 const render=()=>{
  let guard=0
  do{
   assert.ok(guard++<20,'组件不应无限重渲染')
   dirty=false;cursor=0;pending=[]
   tree=Component(props)
   for(const run of pending)run()
  }while(dirty)
  return tree
 }
 const flush=async()=>{for(let round=0;round<12;round++){await new Promise(resolve=>setImmediate(resolve));render()}return tree}
 const all=(match:(el:Element)=>boolean)=>elements(render()).filter(match)
 const find=(match:(el:Element)=>boolean)=>{const matches=all(match);assert.equal(matches.length,1,'元素身份必须唯一，命中 '+matches.length+' 个');return matches[0]!}
 /** 卸载：跑掉所有 effect 的清理函数（离开页面）。 */
 const unmount=()=>{for(const effect of effects.values())effect.cleanup?.();effects.clear()}
 return {flush,all,find,unmount}
}

const head={format:'teloa.business-widget/v1',version:'1.0.0',domain:'SOC',kind:'metric',query:'select count(*) as n from soc_alert',metric:{valueColumn:'n'}}
const bound={...head,id:'alert-count',title:'告警数',timeFilter:{table:'soc_alert',column:'_observed_at'}}
const unbound={...head,id:'asset-count',title:'资产数'}
const result=(widgetId:string)=>({widgetId,definitionHash:'a'.repeat(64),computedAt:'2026-09-28T00:00:00.000Z',status:'ok',columns:[{name:'n',type:'number'}],rows:[[1]],rowCount:1,truncated:false,bytes:1,stale:false})
const board=(filters:boolean)=>({format:'teloa.business-dashboard/v1',id:'soc-ops',version:'1.0.0',domain:'SOC',title:'安全运营大盘',widgets:['alert-count','asset-count'],
 layout:[{widget:'alert-count',x:0,y:0,w:6,h:2},{widget:'asset-count',x:6,y:0,w:6,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false,
 ...(filters?{filters:{timeRange:{options:['7d','30d','90d'],default:'7d'}}}:{})})
const dashPage=(selected:string|null,results:string[]=['alert-count','asset-count'])=>({schema:'teloa.business-dashboard-page/v1',scope:'SOC',dashboard:board(selected!==null),widgets:[bound,unbound],
 results:results.map(result),updatedAt:null,nextRefreshAt:null,refreshing:false,timeRange:selected===null?null:{selected,options:['7d','30d','90d']}})

function fakeApi(reply:{read:(input:{timeRange?:string})=>unknown;refresh?:(input:{timeRange?:string})=>unknown}){
 const calls:Array<{method:string;input:Record<string,unknown>;signal?:AbortSignal|undefined}>=[]
 const api={
  read:async(input:Record<string,unknown>,signal?:AbortSignal)=>{calls.push({method:'read',input,signal});return reply.read(input)},
  refresh:async(input:Record<string,unknown>,signal?:AbortSignal)=>{calls.push({method:'refresh',input,signal});if(!reply.refresh)throw Error('refresh 未被覆写');return reply.refresh(input)},
 }
 return {api,calls}
}
const radios=(app:ReturnType<typeof mountPage>)=>app.all(el=>el.type==='button'&&el.props.role==='radio')
const choose=(app:ReturnType<typeof mountPage>,label:string)=>app.find(el=>el.type==='button'&&el.props.role==='radio'&&el.props.children===label).props.onClick()
const refreshes=(calls:Array<{method:string;input:Record<string,unknown>}>)=>calls.filter(call=>call.method==='refresh')

test('看板没有声明时间范围：不出现范围控件；组件卡不标「不随时间范围变化」',async()=>{
 const {api}=fakeApi({read:()=>dashPage(null)})
 const app=mountPage(api)
 await app.flush()
 assert.equal(app.all(el=>el.props.role==='radiogroup').length,0)
 assert.equal(app.all(el=>el.type==='select').length,0)
 assert.deepEqual(app.all(el=>el.type===BusinessWidgetStub).map(el=>el.props.ranged),[false,false])
})

test('看板有时间范围：按声明顺序出单选按钮组与窄屏下拉，默认选中回包所选；组件卡都知道看板有范围',async()=>{
 const {api,calls}=fakeApi({read:()=>dashPage('7d')})
 const app=mountPage(api)
 await app.flush()
 assert.deepEqual(calls.map(({method,input})=>({method,input})),[{method:'read',input:{scope:'SOC',dashboardId:'soc-ops'}}])
 const group=app.find(el=>el.props.role==='radiogroup')
 assert.equal(group.props['aria-label'],'business.dashboards.range.label')
 assert.deepEqual(radios(app).map(el=>[el.props.children,el.props['aria-checked']]),[['business.dashboards.range.7d',true],['business.dashboards.range.30d',false],['business.dashboards.range.90d',false]])
 const select=app.find(el=>el.type==='select')
 assert.equal(select.props.value,'7d')
 assert.deepEqual(app.all(el=>el.type==='option').map(el=>[el.props.value,el.props.children]),[['7d','business.dashboards.range.7d'],['30d','business.dashboards.range.30d'],['90d','business.dashboards.range.90d']])
 assert.deepEqual(app.all(el=>el.type===BusinessWidgetStub).map(el=>el.props.ranged),[true,true])
})

test('切到非默认范围且接入组件缺结果：带该范围读一次，再恰好发 1 次带该范围、新请求标识的刷新',async()=>{
 const {api,calls}=fakeApi({read:input=>dashPage(input.timeRange??'7d',input.timeRange==='30d'?['asset-count']:undefined),refresh:input=>dashPage(input.timeRange!)})
 const app=mountPage(api)
 await app.flush()
 choose(app,'business.dashboards.range.30d')
 await app.flush();await app.flush()
 assert.deepEqual(calls.map(call=>[call.method,call.input.timeRange]),[['read',undefined],['read','30d'],['refresh','30d']])
 assert.match(String(refreshes(calls)[0]!.input.requestId),/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
 assert.deepEqual(radios(app).map(el=>el.props['aria-checked']),[false,true,false])
 assert.equal(app.find(el=>el.type==='select').props.value,'30d')
 // 手动刷新沿用所选范围。
 app.find(el=>el.type==='button'&&el.props['aria-busy']===false).props.onClick()
 await app.flush()
 assert.deepEqual(refreshes(calls).map(call=>call.input.timeRange),['30d','30d'])
 assert.notEqual(refreshes(calls)[0]!.input.requestId,refreshes(calls)[1]!.input.requestId)
})

test('宿主对缺结果组件回「尚未计算」占位（status failed + teloa/not-found）：同样算缺结果，切到非默认范围自动刷新 1 次',async()=>{
 // 与 packages/backend/src/work/business-dashboards.ts 读取回包同形：没有结果的组件不是缺席，而是一条占位。
 const placeholder=(widgetId:string)=>({widgetId,definitionHash:'a'.repeat(64),computedAt:'2026-09-28T00:00:00.000Z',status:'failed',columns:[],rows:[],rowCount:0,truncated:false,bytes:0,error:{code:'teloa/not-found',reason:'尚未计算'},stale:false})
 const withPlaceholder=(selected:string)=>({...dashPage(selected,['asset-count']),results:[placeholder('alert-count'),result('asset-count')]})
 const {api,calls}=fakeApi({read:input=>input.timeRange==='30d'?withPlaceholder('30d'):dashPage('7d'),refresh:input=>dashPage(input.timeRange!)})
 const app=mountPage(api)
 await app.flush()
 choose(app,'business.dashboards.range.30d')
 await app.flush();await app.flush()
 assert.deepEqual(calls.map(call=>[call.method,call.input.timeRange]),[['read',undefined],['read','30d'],['refresh','30d']])
 // 占位以外的失败（例如 SQL 超时）不是缺结果，不触发按需刷新。
 const failed={...placeholder('alert-count'),error:{code:'teloa/dependency-unavailable',reason:'查询超过 5 秒已中止'}}
 const other=fakeApi({read:input=>input.timeRange==='90d'?{...dashPage('90d'),results:[failed,result('asset-count')]}:dashPage('7d'),refresh:input=>dashPage(input.timeRange!)})
 const second=mountPage(other.api)
 await second.flush()
 choose(second,'business.dashboards.range.90d')
 await second.flush();await second.flush()
 assert.deepEqual(refreshes(other.calls),[])
})

test('按需刷新失败：走一期错误映射提示，不循环重试',async()=>{
 const {api,calls}=fakeApi({read:input=>dashPage(input.timeRange??'7d',input.timeRange?[]:undefined),refresh:()=>{throw Object.assign(Error('x'),{code:'teloa/conflict'})}})
 const app=mountPage(api)
 await app.flush()
 choose(app,'business.dashboards.range.90d')
 for(let round=0;round<4;round++)await app.flush()
 assert.equal(refreshes(calls).length,1)
 assert.equal(app.find(el=>el.type==='p'&&el.props.role==='alert').props.children,'business.dashboards.error.conflict')
 assert.deepEqual(radios(app).map(el=>el.props['aria-checked']),[false,false,true])
})

test('接入组件已有结果、或切回默认范围：只读不刷新；窄屏下拉与按钮组同一条路径',async()=>{
 const {api,calls}=fakeApi({read:input=>dashPage(input.timeRange??'7d',input.timeRange==='7d'?[]:undefined)})
 const app=mountPage(api)
 await app.flush()
 choose(app,'business.dashboards.range.30d')
 await app.flush()
 app.find(el=>el.type==='select').props.onChange({target:{value:'7d'}})
 await app.flush()
 app.find(el=>el.type==='select').props.onChange({target:{value:'1y'}})
 await app.flush()
 assert.deepEqual(calls.map(call=>[call.method,call.input.timeRange]),[['read',undefined],['read','30d'],['read','7d']])
})

test('还没选范围时手动刷新：载荷不带 timeRange',async()=>{
 const {api,calls}=fakeApi({read:()=>dashPage('7d'),refresh:()=>dashPage('7d')})
 const app=mountPage(api)
 await app.flush()
 app.find(el=>el.type==='button'&&el.props['aria-busy']===false).props.onClick()
 await app.flush()
 assert.deepEqual(refreshes(calls).map(call=>'timeRange' in call.input&&call.input.timeRange!==undefined),[false])
})

/** 手动放行的回包：测试里控制读取何时返回。 */
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}

test('切换范围的读取失败：所选范围不变、提示读取错误；之后手动刷新仍不带范围',async()=>{
 const {api,calls}=fakeApi({read:input=>{if(input.timeRange==='30d')throw Object.assign(Error('x'),{code:'teloa/source-unavailable'});return dashPage('7d')},refresh:()=>dashPage('7d')})
 const app=mountPage(api)
 await app.flush()
 choose(app,'business.dashboards.range.30d')
 await app.flush()
 assert.deepEqual(radios(app).map(el=>el.props['aria-checked']),[true,false,false])
 assert.equal(app.find(el=>el.type==='select').props.value,'7d')
 assert.equal(app.all(el=>el.type==='p'&&el.props.role==='alert').length,1)
 assert.deepEqual(refreshes(calls),[])
 app.find(el=>el.type==='button'&&el.props['aria-busy']===false).props.onClick()
 await app.flush()
 assert.deepEqual(refreshes(calls).map(call=>call.input.timeRange),[undefined])
})

test('服务端刷新中的静默轮询：带所选范围重读',async context=>{
 context.mock.timers.enable({apis:['setTimeout']})
 const {api,calls}=fakeApi({read:input=>({...dashPage(input.timeRange??'7d'),refreshing:input.timeRange==='30d'})})
 const app=mountPage(api)
 await app.flush()
 choose(app,'business.dashboards.range.30d')
 await app.flush()
 assert.deepEqual(calls.map(call=>[call.method,call.input.timeRange]),[['read',undefined],['read','30d']])
 context.mock.timers.tick(3000)
 await app.flush()
 assert.deepEqual(calls.map(call=>[call.method,call.input.timeRange]),[['read',undefined],['read','30d'],['read','30d']])
})

test('离开页面：在途的范围读取被中止，读取回来后不再自动补算、不改页面',async()=>{
 const gate=deferred<unknown>()
 const {api,calls}=fakeApi({read:input=>input.timeRange==='30d'?gate.promise:dashPage('7d'),refresh:input=>dashPage(input.timeRange!)})
 const app=mountPage(api)
 await app.flush()
 choose(app,'business.dashboards.range.30d')
 await app.flush()
 const pending=calls.find(call=>call.input.timeRange==='30d')!
 assert.ok(pending.signal,'范围读取带中止信号')
 assert.equal(pending.signal!.aborted,false)
 app.unmount()
 assert.equal(pending.signal!.aborted,true)
 gate.resolve(dashPage('30d',['asset-count']))
 await app.flush()
 assert.deepEqual(refreshes(calls),[],'离开后不发自动补算')
})

test('再次切换范围：中止上一次在途读取，上一次的回包不覆盖页面、也不触发补算',async()=>{
 const slow=deferred<unknown>()
 const {api,calls}=fakeApi({read:input=>input.timeRange==='30d'?slow.promise:dashPage(input.timeRange??'7d'),refresh:input=>dashPage(input.timeRange!)})
 const app=mountPage(api)
 await app.flush()
 choose(app,'business.dashboards.range.30d')
 await app.flush()
 choose(app,'business.dashboards.range.90d')
 await app.flush()
 const first=calls.find(call=>call.input.timeRange==='30d')!
 assert.equal(first.signal?.aborted,true)
 assert.deepEqual(radios(app).map(el=>el.props['aria-checked']),[false,false,true])
 slow.resolve(dashPage('30d',['asset-count']))
 await app.flush()
 assert.deepEqual(radios(app).map(el=>el.props['aria-checked']),[false,false,true],'上一次的回包不覆盖')
 assert.deepEqual(refreshes(calls),[],'上一次不补算')
 assert.equal(app.find(el=>el.type==='button'&&el.props['aria-busy']!==undefined).props.disabled,false,'刷新按钮不被上一次卡住')
})
