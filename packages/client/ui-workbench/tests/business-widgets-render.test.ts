import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import test from 'node:test'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {BusinessWidget}=await import('../lib/types/client/BusinessWidgets.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const widget={format:'teloa.business-widget/v1',id:'alert-count',version:'1.0.0',domain:'SOC',title:'告警数',kind:'metric',query:'select 1',metric:{valueColumn:'n'}}
const result=(columns:Array<{name:string;type:string}>,rows:unknown[][])=>({widgetId:'alert-count',definitionHash:'a'.repeat(64),computedAt:'2026-09-25T00:00:00.000Z',status:'ok',columns,rows,rowCount:rows.length,truncated:false,bytes:1,stale:false})
const render=(value:unknown)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(BusinessWidget as never,{widget,result:value,colorScheme:'light'} as never)))

test('渲染前再核一次结果形状：缺声明要用的列或指标不是 1 行即显示失败，不画组件',()=>{
 const ok=render(result([{name:'n',type:'number'}],[[3]]))
 assert.doesNotMatch(ok,/data-widget-failed/)
 const missing=render(result([{name:'other',type:'number'}],[[3]]))
 assert.match(missing,/data-widget-failed="alert-count"/)
 assert.match(missing,/缺少组件声明要用的列：n/)
 assert.match(render(result([{name:'n',type:'number'}],[[1],[2]])),/data-widget-failed="alert-count"/)
})

test('看板有时间范围、组件没接入：标题下注明「不随时间范围变化」；接入的组件和没有范围的看板都不标',()=>{
 const ok=result([{name:'n',type:'number'}],[[3]])
 const card=(value:unknown,ranged:boolean)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(BusinessWidget as never,{widget:value,result:ok,colorScheme:'light',ranged} as never)))
 const unbound=card(widget,true)
 assert.match(unbound,/<h3>告警数<\/h3><p[^>]*data-range-unbound="alert-count"[^>]*>不随时间范围变化<\/p>/)
 assert.doesNotMatch(card({...widget,timeFilter:{table:'soc_alert',column:'_observed_at'}},true),/data-range-unbound|不随时间范围变化/)
 assert.doesNotMatch(card(widget,false),/data-range-unbound|不随时间范围变化/)
})
