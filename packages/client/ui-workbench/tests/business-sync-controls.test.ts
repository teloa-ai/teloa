import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import test from 'node:test'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})

const {BusinessSyncControls}=await import('../lib/types/client/BusinessSyncControls.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}

test('独立同步控件在规则读取前只显示加载态，不展示可操作的启停状态',()=>{
 const api={syncStatus:async()=>[],syncRules:async()=>[]}
 const html=renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(BusinessSyncControls,{scope:'SOC',api} as never)))
 assert.match(html,/数据同步/)
 assert.match(html,/正在读取周期规则/)
 assert.doesNotMatch(html,/>启用</)
 assert.doesNotMatch(html,/>暂停</)
})
