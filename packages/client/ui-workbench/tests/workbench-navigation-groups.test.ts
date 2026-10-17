import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

registerHooks({
 resolve:(specifier,context,next)=>/\.(module\.css|svg)$/.test(specifier)?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:url.endsWith('.svg')?{format:'module',shortCircuit:true,source:'export default "fixture.svg"'}:next(url,context),
})
const {WorkbenchNavigationItems}=await import('../lib/types/client/WorkbenchNavigationChrome.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

test('三组主导航保持工作、团队与业务、资源层次，项目归工作，不复制任务和计划',()=>{
 for(const [locale,labels] of [['zh-CN',['工作','团队与业务','资源']],['zh-Hant',['工作','團隊與業務','資源']],['en',['Work','Team and business','Resources']]] as const){
  const snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key:string)=>translateMessage(locale,key as never),subscribe:()=>()=>{},getSnapshot:()=>snapshot}
  const html=renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(WorkbenchNavigationItems,{view:'projects',onSelect:()=>{}})))
  const groups=[...html.matchAll(/<div class="navLabel navGroupLabel">([^<]+)<\/div>/g)]
  assert.deepEqual(groups.map(match=>match[1]),labels)
  const sections=groups.map((group,index)=>html.slice(group.index,groups[index+1]?.index??html.length))
  const names=(section:string)=>[...section.matchAll(/<button\b[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g)].map(match=>match[1])
  assert.deepEqual(names(sections[0]!),['navigation.home','navigation.v2.conversations','navigation.projects'].map(key=>runtime.t(key)))
  assert.deepEqual(names(sections[1]!),['navigation.v2.colleagues','navigation.v2.business'].map(key=>runtime.t(key)))
  assert.deepEqual(names(sections[2]!),['navigation.v2.library','market.title'].map(key=>runtime.t(key)))
  assert.equal((html.match(/aria-current="page"/g)??[]).length,1)
  assert.match(sections[0]!,/aria-current="page"[^>]*>[\s\S]*?<span>/)
  for(const key of ['navigation.tasks','navigation.plans','navigation.attention'])assert.ok(!names(html).includes(runtime.t(key)))
 }
})
