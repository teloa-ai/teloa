import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
registerHooks({
 resolve:(specifier,context,next)=>/\.(module\.css|svg)$/.test(specifier)?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.svg')?{format:'module',shortCircuit:true,source:'export default '+JSON.stringify(url)}:url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {WorkbenchNavigationItems,WorkbenchHubNavigation}=await import('../lib/types/client/WorkbenchNavigationChrome.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const paint=(view:string)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(WorkbenchNavigationItems,{view:view as never,onSelect:()=>{},needCount:17,attentionKnown:false})))

test('工作台次级页面仍高亮工作台并保留待办提示，不重复一级导航',()=>{
 for(const view of ['home','attention','tasks','plans']){
  const html=paint(view)
  assert.match(html,/<button[^>]*aria-current="page"[^>]*>[\s\S]*?<span>工作台<\/span>/)
  assert.match(html,/至少 17 项/)
  assert.match(html,/>17\+</)
  for(const label of ['需要你','任务','自动化'])assert.doesNotMatch(html,new RegExp('<span>'+label+'</span>'))
  assert.match(html,/<span>项目<\/span>/,'项目仍保留当前一级入口')
 }
})

test('四个工作台次级入口保持原视图身份与单一选中项；待办数量只在侧栏与首页卡片出现',()=>{
 for(const [view,label] of [['home','总览'],['attention','需要你'],['tasks','任务'],['plans','自动化']]){
  const html=renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(WorkbenchHubNavigation,{view:view as never,onSelect:()=>{}})))
  assert.match(html,/<nav[^>]*aria-label="工作台"/)
  assert.equal(html.match(/aria-current="page"/g)?.length,1)
  assert.match(html,new RegExp('<button[^>]*aria-current="page"[^>]*>'+label))
  assert.equal(html.match(/<button/g)?.length,4)
  assert.doesNotMatch(html,/class="count"/,'1.0 页签不重复角标')
 }
 const html=renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(WorkbenchHubNavigation,{view:'messages',onSelect:()=>{}})))
 assert.equal(html,'','普通会话与业务页面不混入工作台导航')
})
