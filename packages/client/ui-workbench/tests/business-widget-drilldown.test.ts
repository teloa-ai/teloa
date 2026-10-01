import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import * as React from 'react'
import * as contract from '@teloa/contract'
import {drilldownTarget} from '../src/client/business-widget-presentation.ts'

/**
 * 组件下钻（二期规格 §4.3–§4.4）：纯函数 `drilldownTarget` 各分支，以及组件卡上的按钮与点击。
 * 组件照 business-dashboard-page-wiring.test.ts 的手法真实运行：源码转译、钩子换成同步桩、函数组件逐层展开，
 * 不经过 jsdom；点击就是直接调元素上的 onClick。
 */

const head={format:'teloa.business-widget/v1',version:'1.0.0',domain:'SOC',title:'告警'}
const widget=(over:Record<string,unknown>)=>contract.readBusinessWidgetDefinition({...head,id:'w',kind:'table',query:'select 1',...over})

test('drilldownTarget：idColumn / match / 只写 objectType / 行缺失 / 空单元格与不可信取值各分支',()=>{
 const byId=widget({drilldown:{objectType:'alert-ticket',idColumn:'_id'}})
 const byMatch=widget({drilldown:{objectType:'alert-ticket',match:{column:'severity',field:'severity'}}})
 const plain=widget({drilldown:{objectType:'alert-ticket'}})
 const base={scope:'SOC',section:'data',objectType:'alert-ticket'}
 assert.equal(drilldownTarget('SOC',widget({}),{severity:'高'}),undefined,'没有下钻声明')
 assert.deepEqual(drilldownTarget('SOC',byId,{_id:'soc-alert-7'}),{...base,id:'soc-alert-7',match:{field:'_id',value:'soc-alert-7'}})
 assert.deepEqual(drilldownTarget('SOC',byMatch,{severity:'高',n:3}),{...base,match:{field:'severity',value:'高'}})
 assert.deepEqual(drilldownTarget('SOC',byMatch,{severity:3}),{...base,match:{field:'severity',value:'3'}})
 assert.deepEqual(drilldownTarget('SOC',byMatch,{severity:true}),{...base,match:{field:'severity',value:'true'}})
 assert.deepEqual(drilldownTarget('SOC',plain,{severity:'高'}),base)
 assert.deepEqual(drilldownTarget('SOC',plain,undefined),base)
 assert.deepEqual(drilldownTarget('SOC',byMatch,undefined),base,'行缺失（标题行按钮）打开未过滤清单')
 assert.equal(drilldownTarget('SOC',byMatch,{severity:null}),undefined,'空单元格不可点')
 assert.equal(drilldownTarget('SOC',byId,{other:'x'}),undefined,'缺下钻列不导航')
 // 图表点击给的数据行来自外部库，不可信：只收有限的文本、数字、布尔，取值 1–200 字无控制字符。
 for(const cell of ['','x'.repeat(201),'高\n',Number.NaN,Number.POSITIVE_INFINITY,{},[1],new Date(0)])
  assert.equal(drilldownTarget('SOC',byMatch,{severity:cell} as never),undefined,String(cell))
 assert.deepEqual(drilldownTarget('SOC',byMatch,{severity:'x'.repeat(200)}),{...base,match:{field:'severity',value:'x'.repeat(200)}})
})

type Node={type:unknown;props:Record<string,any>}
const t=(key:string,params?:Record<string,string|number>)=>params?key+':'+JSON.stringify(params):key
const presentation=await import('../src/client/business-widget-presentation.ts')

/** 转译一个组件源码并用同步桩运行：`useEffect` 立即执行，`useRef` 给一个假容器（图表挂载要用）。 */
function load(file:string,modules:Record<string,unknown>){
 const hooks={...React,useState:(initial:unknown)=>[typeof initial==='function'?(initial as ()=>unknown)():initial,()=>{}],useEffect:(run:()=>void)=>{run()},useRef:()=>({current:{replaceChildren:()=>{}}})}
 const require=(id:string):unknown=>{
  if(id==='react')return hooks
  if(id==='lucide-react')return new Proxy({},{get:()=>()=>null})
  if(id==='@teloa/contract')return contract
  if(id.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})}
  if(id.endsWith('i18n/provider.js'))return {useI18n:()=>({t,locale:'zh-CN',number:String,dateTime:()=>'time'})}
  const found=Object.entries(modules).find(([suffix])=>id.endsWith(suffix))
  if(!found)throw Error('未预期的依赖：'+id)
  return found[1]
 }
 const code=ts.transpileModule(readFileSync(new URL('../src/client/'+file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const exported:Record<string,any>={}
 new Function('require','exports','React',code)(require,exported,hooks)
 return exported
}
/** 函数组件逐层展开成只含宿主元素的树。 */
const expand=(node:unknown):unknown=>{
 if(Array.isArray(node))return node.map(expand)
 if(!React.isValidElement<Record<string,any>>(node))return node
 if(typeof node.type==='function')return expand((node.type as (props:unknown)=>unknown)(node.props))
 return {type:node.type,props:{...node.props,children:expand(node.props.children)}}
}
const walk=(node:unknown):Node[]=>{
 if(Array.isArray(node))return node.flatMap(walk)
 if(!node||typeof node!=='object'||!('props' in node))return []
 const element=node as Node
 return [element,...walk(element.props.children)]
}
const text=(node:unknown):string=>Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'&&'props' in node?text((node as Node).props.children):node===null||node===undefined||typeof node==='boolean'?'':String(node)

const charts:Array<{options:{locale:string;onDatum?:(datum:Record<string,unknown>)=>void}}>=[]
const widgets=load('BusinessWidgets.tsx',{
 './BusinessLedger.js':{ViewBars:()=>null,ViewBoardCard:()=>null,ViewPie:()=>null,ViewTable:()=>null,ViewTrend:()=>null},
 './business-definition-localization.js':{durationText:String,localizedBusinessView:(value:unknown)=>value,localizedBusinessViewTitle:(value:{title:string})=>value.title},
 './business-widget-presentation.js':presentation,
 './business-chart-renderer.js':{businessChartTheme:()=>({}),renderChart:async(...args:unknown[])=>{charts.push({options:args[6] as never});return ()=>{}}},
})
const result=(columns:string[],rows:unknown[][])=>({widgetId:'w',definitionHash:'a'.repeat(64),computedAt:'2026-09-28T00:00:00.000Z',status:'ok',columns:columns.map(name=>({name,type:'text'})),rows,rowCount:rows.length,truncated:false,bytes:1,stale:false})
function card(definition:ReturnType<typeof widget>,value:ReturnType<typeof result>,withGo=true){
 const calls:unknown[]=[]
 const tree=expand(React.createElement(widgets.BusinessWidget,{widget:definition,result:value,colorScheme:'light',...(withGo?{go:(target:unknown)=>calls.push(target)}:{})}))
 const buttons=walk(tree).filter(node=>node.type==='button')
 return {calls,buttons,label:(button:Node)=>button.props['aria-label']??text(button.props.children)}
}
const base={scope:'SOC',section:'data',objectType:'alert-ticket'}

test('表格 / 清单首列是按钮，点一次导航一次；只有首列可点，空单元格那行不可点',()=>{
 const drill={objectType:'alert-ticket',match:{column:'severity',field:'severity'}}
 const table=card(widget({table:{columns:['severity','n']},drilldown:drill}),result(['severity','n'],[['高','3'],['低','5'],[null,'1']]))
 const rows=table.buttons.filter(button=>button.props['data-drilldown-row']!==undefined)
 assert.deepEqual(rows.map(button=>text(button.props.children)),['高','低'])
 assert.equal(rows[0]!.props['aria-label'],'business.dashboards.drilldown.row:{"value":"高"}')
 rows[0]!.props.onClick()
 assert.deepEqual(table.calls,[{...base,match:{field:'severity',value:'高'}}])
 const list=card(widget({kind:'list',table:{columns:['title','severity']},drilldown:{objectType:'alert-ticket',idColumn:'_id'}}),result(['title','severity','_id'],[['工单 1','高','soc-alert-1']]))
 const [row]=list.buttons.filter(button=>button.props['data-drilldown-row']!==undefined)
 assert.equal(text(row!.props.children),'工单 1')
 row!.props.onClick()
 assert.deepEqual(list.calls,[{...base,id:'soc-alert-1',match:{field:'_id',value:'soc-alert-1'}}])
})

test('看板卡片与流水线阶段是按钮：卡片按该行取值，阶段按阶段名（数量为 0 的阶段也能点）',()=>{
 const board=card(widget({kind:'board',board:{statusColumn:'status',titleColumn:'title',idColumn:'id',statuses:['新','已关']},drilldown:{objectType:'alert-ticket',idColumn:'id'}}),result(['status','title','id'],[['新','工单 1','soc-alert-1'],['已关','工单 2','soc-alert-2']]))
 const cards=board.buttons.filter(button=>button.props['data-drilldown-row']!==undefined)
 assert.deepEqual(cards.map(button=>text(button.props.children)),['工单 1','工单 2'])
 cards[1]!.props.onClick()
 assert.deepEqual(board.calls,[{...base,id:'soc-alert-2',match:{field:'_id',value:'soc-alert-2'}}])
 const pipeline=card(widget({kind:'pipeline',pipeline:{stageColumn:'verdict',countColumn:'n',stages:['还没有人看','正在核对']},drilldown:{objectType:'alert-ticket',match:{column:'verdict',field:'verdict'}}}),result(['verdict','n'],[['还没有人看',4]]))
 const stages=pipeline.buttons.filter(button=>button.props['data-drilldown-row']!==undefined)
 assert.deepEqual(stages.map(button=>text(button.props.children)),['还没有人看','正在核对'])
 stages[1]!.props.onClick()
 assert.deepEqual(pipeline.calls,[{...base,match:{field:'verdict',value:'正在核对'}}])
})

test('带下钻的组件标题行有「查看对象」按钮，打开未过滤清单；只写 objectType 的组件行不可点；没有下钻或没有导航（预览）不渲染任何按钮',()=>{
 const metric=card(widget({kind:'metric',metric:{valueColumn:'n'},drilldown:{objectType:'alert-ticket'}}),result(['n'],[[3]]))
 assert.deepEqual(metric.buttons.map(metric.label),['business.dashboards.drilldown.open'])
 metric.buttons[0]!.props.onClick()
 assert.deepEqual(metric.calls,[base])
 const plain=card(widget({table:{columns:['severity']},drilldown:{objectType:'alert-ticket'}}),result(['severity'],[['高']]))
 assert.deepEqual(plain.buttons.map(plain.label),['business.dashboards.drilldown.open'])
 const filtered=card(widget({table:{columns:['severity']},drilldown:{objectType:'alert-ticket',match:{column:'severity',field:'severity'}}}),result(['severity'],[['高']]))
 filtered.buttons.find(button=>button.props['data-drilldown-open']!==undefined)!.props.onClick()
 assert.deepEqual(filtered.calls,[base],'标题行按钮不带 match')
 assert.equal(card(widget({table:{columns:['severity']}}),result(['severity'],[['高']])).buttons.length,0)
 assert.equal(card(widget({table:{columns:['severity']},drilldown:{objectType:'alert-ticket',match:{column:'severity',field:'severity'}}}),result(['severity'],[['高']]),false).buttons.length,0)
})

test('图表：有下钻列时把点击回调交给渲染器，点到的数据行导航一次，缺下钻列不导航；没有下钻或只写 objectType 时不给回调',()=>{
 const spec={engine:'vega-lite',spec:{mark:'bar',encoding:{x:{field:'severity',type:'nominal'},y:{field:'n',type:'quantitative'}}}}
 charts.length=0
 const drilled=card(widget({kind:'chart',chart:spec,drilldown:{objectType:'alert-ticket',match:{column:'severity',field:'severity'}}}),result(['severity','n'],[['高',3]]))
 const onDatum=charts.at(-1)!.options.onDatum!
 assert.equal(typeof onDatum,'function')
 assert.equal(charts.at(-1)!.options.locale,'zh-CN')
 onDatum({severity:'高',n:3})
 onDatum({n:3})
 assert.deepEqual(drilled.calls,[{...base,match:{field:'severity',value:'高'}}])
 card(widget({kind:'chart',chart:spec}),result(['severity','n'],[['高',3]]))
 assert.equal(charts.at(-1)!.options.onDatum,undefined)
 card(widget({kind:'chart',chart:spec,drilldown:{objectType:'alert-ticket'}}),result(['severity','n'],[['高',3]]))
 assert.equal(charts.at(-1)!.options.onDatum,undefined)
})

test('业务页把导航交给看板页、看板页交给组件卡；台账那一层把 match 透给读取与清单',()=>{
 const business=readFileSync(new URL('../src/client/BusinessPage.tsx',import.meta.url),'utf8')
 assert.match(business,/<BusinessDashboardPage [^\n]*go=\{navigate\}\/>/)
 assert.match(business,/<BusinessLedgerSurface [^\n]*\{\.\.\.\(target\.match\?\{match:target\.match\}:\{\}\)\}/)
 const page=readFileSync(new URL('../src/client/BusinessDashboardPage.tsx',import.meta.url),'utf8')
 assert.match(page,/<BusinessDashboardGrid [^\n]*go=\{go\}\/>/)
 const grid=readFileSync(new URL('../src/client/BusinessDashboardGrid.tsx',import.meta.url),'utf8')
 assert.match(grid,/<BusinessWidget [^\n]*go=\{go\}\/>/)
})

test('台账：读取带上 match，清单提示条「看全部」清掉 match 回到同一类对象清单',async()=>{
 const api=await import('../src/client/business-ledger-api.ts')
 const ledgerModule=load('BusinessLedger.tsx',{
  './business-ledger-api.js':api,
  './business-definition-localization.js':await import('../src/client/business-definition-localization.ts'),
  './business-customization-presentation.js':await import('../src/client/business-customization-presentation.ts'),
 })
 const reads:unknown[]=[]
 expand(React.createElement(ledgerModule.BusinessLedgerSurface,{scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:'高'},api:{read:(request:unknown)=>{reads.push(request);return new Promise(()=>{})}},go:()=>{},connect:()=>{}}))
 assert.deepEqual(reads,[{scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:'高'}}])
 const {ledger,block,listView,ledgerObject}=await import('./business-ledger-fixtures.ts')
 const value=await api.readBusinessLedger(ledger({blocks:[block({views:[listView('SOC','alert-ticket',[ledgerObject('SOC','alert-ticket','a-1')])]})]}),'SOC')
 const calls:unknown[]=[]
 const tree=expand(React.createElement(ledgerModule.BusinessLedgerView,{ledger:value,objectType:'alert-ticket',match:{field:'severity',value:'高'},go:(target:unknown)=>calls.push(target),connect:()=>{}}))
 const note=walk(tree).find(node=>node.props['data-ledger-match']!==undefined)!
 assert.equal(text(note.props.children).startsWith('business.ledger.match:{"field":"严重度","value":"高"}'),true)
 walk(note).find(node=>node.type==='button')!.props.onClick()
 assert.deepEqual(calls,[{scope:'SOC',section:'data',objectType:'alert-ticket'}])
})

test('刷新恢复：对象清单（带对象类型、无对象标识或带下钻筛选）与看板同款原样落定，不等沙盒业务数据、不丢 match',()=>{
 // 二期验收发现：恢复副作用对 data 栏目要等沙盒业务数据加载、且重建目标时丢掉 match，刷新后回到业务台账首页。
 const frame=readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.match(frame,/if\(state\.businessTarget\.section==='data'&&state\.businessTarget\.objectType&&\(state\.businessTarget\.id===undefined\|\|state\.businessTarget\.match\)\)\{restorePending\.current\.spaces=false;settleBusinessTarget\(state\.businessTarget\);return\}/)
 const guard=frame.indexOf("state.businessTarget.section==='data'&&state.businessTarget.objectType&&"),wait=frame.indexOf("if(state.businessTarget.section!=='overview'&&!tasks.business.loaded)return")
 assert.ok(guard>0&&guard<wait,'对象清单的原样落定要在等待沙盒数据之前')
})
