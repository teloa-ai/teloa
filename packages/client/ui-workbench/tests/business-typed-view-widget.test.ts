import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import test from 'node:test'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import ts from 'typescript'
// @ts-expect-error 完整协议夹具为 MJS 模块。
import {typedViewFixture} from './fixtures/business-typed-view.mjs'

// 直接渲染源码，避免把生成物是否刷新混入客户端行为断言。
registerHooks({
 resolve:(specifier,context,next)=>{
  if(specifier.endsWith('.module.css'))return {url:new URL(specifier,context.parentURL).href,shortCircuit:true}
  if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL?.includes('/src/client/')){
   for(const suffix of ['.ts','.tsx']){const candidate=new URL(specifier.slice(0,-3)+suffix,context.parentURL);if(existsSync(candidate))return {url:candidate.href,shortCircuit:true}}
  }
  return next(specifier,context)
 },
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:url.endsWith('.tsx')?{format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText}:next(url,context),
})
const {BusinessDashboardGrid}=await import('../src/client/BusinessDashboardGrid.tsx')
const {I18nProvider}=await import('../src/client/i18n/provider.tsx')
const {translateMessage}=await import('../src/client/i18n/messages.ts')
function render(fixture:any,locale='zh-CN'){
 const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage(locale as never,key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale,dshLocale:locale==='en'?'en':'zh',revision:1})}
 return renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(BusinessDashboardGrid,{dashboard:{layout:[{widget:fixture.widget.id,x:0,y:0,w:12,h:2}]},widgets:[fixture.widget],results:[fixture.result],viewRefs:[fixture.ref],colorScheme:'light'} as never)))
}

test('类型化金额按精确文本展示超安全整数、22位负数、真实零与空值，均值口径可核对',()=>{
 let html='';assert.doesNotThrow(()=>{html=render(typedViewFixture())})
 assert.match(html,/CNY 9,007,199,254,740,993\.0001/)
 assert.match(html,/CNY -9,999,999,999,999,999,999,999\.9999/)
 assert.match(html,/USD -0\.0001/)
 assert.match(html,/CNY 0<\/td>/)
 assert.match(html,/>—<\/td>/)
 assert.match(html,/四位小数/)
 assert.match(html,/half-even/)
})
test('成员统计、快照覆盖、缺字段和两层截断可见，英文具备相同含义',()=>{
 const html=render(typedViewFixture(),'en')
 assert.match(html,/membership/i);assert.match(html,/multiple labels/i)
 assert.match(html,/3 records/);assert.match(html,/8 entries in total; the first 3/i)
 assert.match(html,/missing/i);assert.match(html,/5,000/)
 assert.match(html,/CNY total/);assert.match(html,/USD mean/)
})
test('日期维度按稳定UTC桶和界面语言展示，英文不沿用服务端中文标签',()=>{
 for(const [bucket,dimension,label,want] of [
  ['hour','2026-09-29T00:00:00.000Z','2026年9月29日 00时',/Sep 29, 2026, 00/],
  ['day','2026-09-29T00:00:00.000Z','2026年9月29日',/September 29, 2026/],
  ['week','2026-09-28T00:00:00.000Z','2026年9月28日',/September 28, 2026/],
  ['month','2026-09-01T00:00:00.000Z','2026年9月',/September 2026/],
 ] as const){
  const fixture=typedViewFixture('line');fixture.ref.view.dimension.bucket=bucket
  fixture.result.view.rows=[{dimension,label,values:fixture.result.view.rows[0].values}]
  const html=render(fixture,'en')
  assert.match(html,want);assert.doesNotMatch(html,/>2026年/)
  if(bucket==='day')assert.match(render(fixture,'zh-CN'),/>2026年9月29日</)
 }
})
test('损坏日期维度明确失败，不沿用中文标签或抛出Intl异常',()=>{
 const fixture=typedViewFixture('line');fixture.result.view.rows[0].dimension='not-a-date'
 const html=render(fixture,'en');assert.match(html,/role="alert"/);assert.doesNotMatch(html,/<table|<svg/)
})
test('所有声明图形同时保留精确可访问表格；负数、空值与零不会产生无穷坐标',()=>{
 for(const chart of ['number','table','bar','pie','line']){
  const html=render(typedViewFixture(chart))
  assert.match(html,new RegExp('data-typed-view="'+chart+'"'))
  assert.match(html,/9,007,199,254,740,993\.0001/)
  if(chart!=='number')assert.match(html,/<table/)
  if(['bar','line'].includes(chart)){assert.match(html,/data-typed-series="cny"/);assert.match(html,/data-typed-series="usd"/);assert.match(html,/data-typed-series="count"/)}
  assert.doesNotMatch(html,/NaN|Infinity/)
  assert.doesNotMatch(html,/<button|data-drilldown/)
 }
})
test('饼图以正值的最大值计算比例，超大负数不会使合法正值从图形消失',()=>{
 const html=render(typedViewFixture('pie'))
 assert.match(html,/<svg[^>]+class="pie"/)
 assert.match(html,/stroke-dasharray="100 0"/)
 assert.match(html,/CNY -9,999,999,999,999,999,999,999\.9999/)
})
test('回包格式/引用/币种/声明不一致明确失败，不把坏数据降为零或画错图',()=>{
 for(const mutate of [
  (f:any)=>{f.result.format='unknown'},
  (f:any)=>{delete f.result.format},
  (f:any)=>{f.result.view.rows[0].values[0].decimal='NaN'},
  (f:any)=>{f.result.view.rows[0].values[0].currency='USD'},
  (f:any)=>{f.result.view.viewId='other'},
  (f:any)=>{f.result.view.chart='bar'},
  (f:any)=>{f.ref.view.measures[0].currency='USD'},
 ]){const f=typedViewFixture();mutate(f);const html=render(f);assert.match(html,/role="alert"/);assert.doesNotMatch(html,/<table|<svg|9,007/)}
})
test('维度、度量和缺字段中的参数只作文本，HTML不执行且原标签可核对',()=>{
 const fixture=typedViewFixture(),html=render(fixture)
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/)
 assert.doesNotMatch(html,/<img|<script|dangerouslySetInnerHTML/)
})
