import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {readFileSync} from 'node:fs'
import {marketDerivativeChangeTypes,readMarketCatalogEntry} from '@teloa/contract'

registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {MarketDerivativeChanges}=await import('../lib/types/client/MarketDerivativeChanges.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const {derivativeEntry}=await import('./market-catalog-fixture.ts')

const runtime=(locale:'zh-CN'|'en')=>({t:(key:string,params?:Record<string,string|number>)=>translateMessage(locale,key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale,dshLocale:locale==='en'?'en':'zh',revision:1})})
const entry=()=>readMarketCatalogEntry(derivativeEntry()) as unknown as {derivation:unknown;upstream:{repository:{owner:string;repo:string};commit:string}}
const render=(locale:'zh-CN'|'en'='zh-CN',patch:(value:ReturnType<typeof entry>)=>void=()=>{})=>{
 const value=entry();patch(value)
 return renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime(locale) as never},createElement(MarketDerivativeChanges,{derivation:value.derivation,repository:value.upstream.repository,commit:value.upstream.commit} as never)))
}
const commit='33375500bcea98d610eb30ce10ac4e59b89c390d'

test('五条修改跨三类：三个默认收起的分组，按类优先级排序，summary 带类名与条数，组内按 id 升序',()=>{
 const html=render()
 assert.match(html,/修改清单（5 项）/)
 const groups=[...html.matchAll(/<details([^>]*)><summary>([^<]*)<\/summary>/g)]
 assert.deepEqual(groups.map(match=>match[2]),['安全修复（2）','修复（1）','新增（2）'])
 for(const match of groups)assert.doesNotMatch(match[1]!,/\bopen\b/,'分组默认收起')
 const ids=[...html.matchAll(/class="id">(ICM-M\d+)</g)].map(match=>match[1])
 assert.deepEqual(ids,['ICM-M01','ICM-M02','ICM-M03','ICM-M04','ICM-M05'])
 assert.match(html,/摘要 ICM-M01/);assert.match(html,/原因：原因说明 ICM-M01/)
 assert.match(html,/SKILL\.md · L10-L24/);assert.match(html,/SKILL\.md · §2/)
})

test('原版链接为锁定提交的 blob 地址（逐段编码），新开页且不带来源；原版没有的新文件不给链接',()=>{
 const html=render()
 const links=[...html.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)]
 assert.equal(links.length,3,'upstream 非空的 3 条各一个链接')
 for(const [,attributes,text] of links){
  assert.equal(text,'查看原版')
  assert.match(attributes!,/target="_blank"/);assert.match(attributes!,/rel="noreferrer"/)
 }
 const hrefs=links.map(match=>match[1]!.match(/href="([^"]+)"/)![1])
 assert.deepEqual(hrefs,[
  `https://github.com/anthropics/skills/blob/${commit}/skills/internal-comms/SKILL.md`,
  `https://github.com/anthropics/skills/blob/${commit}/skills/internal-comms/references/guide.md`,
  `https://github.com/anthropics/skills/blob/${commit}/skills/internal-comms/SKILL.md`,
 ])
 assert.equal([...html.matchAll(/原版没有这个文件/g)].length,2)
 // upstream 为 null 的两条（M04、M05）所在列表项里没有链接
 for(const id of ['ICM-M04','ICM-M05']){
  const item=html.match(new RegExp(`<li[^>]*>(?:(?!</li>).)*class="id">${id}<(?:(?!</li>).)*</li>`))![0]
  assert.doesNotMatch(item,/<a /,id)
 }
})

test('路径含空格与非 ASCII 时逐段编码；指向别的仓库或提交的出处不生成链接',()=>{
 const html=render('zh-CN',value=>{
  const derivation=value.derivation as {changes:{upstream:string|null}[]}
  derivation.changes[0]!.upstream=`anthropics/skills@${commit}:skills/internal-comms/references/my notes/中文.md`
  derivation.changes[1]!.upstream=`someone/else@${commit}:skills/internal-comms/SKILL.md`
 })
 assert.ok(html.includes(`href="https://github.com/anthropics/skills/blob/${commit}/skills/internal-comms/references/my%20notes/%E4%B8%AD%E6%96%87.md"`))
 assert.doesNotMatch(html,/someone/)
})

test('出处路径含 .、.. 或空段时不生成链接（不让编码后的 %2E%2E 之类进地址）',()=>{
 for(const path of ['skills/internal-comms/../x/SKILL.md','skills/./internal-comms/SKILL.md','skills//internal-comms/SKILL.md','skills/internal-comms/..']){
  const html=render('zh-CN',value=>{(value.derivation as {changes:{upstream:string|null}[]}).changes[1]!.upstream=`anthropics/skills@${commit}:${path}`})
  assert.equal([...html.matchAll(/<a /g)].length,2,path)
  assert.doesNotMatch(html,/%2E|\/\.\.?\//i,path)
 }
})

test('未修改文件说明按数量选句式；英文界面取英文文本',()=>{
 assert.match(render(),/其余 1 个文件与原版一致（已校验）/)
 const en=render('en')
 assert.match(en,/Change list \(5\)/);assert.match(en,/Security fix \(2\)/);assert.match(en,/Fix \(1\)/);assert.match(en,/Added \(2\)/)
 assert.match(en,/Why: Reason ICM-M01/);assert.match(en,/View original/);assert.match(en,/Not in the original/)
 assert.match(en,/The other file matches the original \(verified\)/)
 assert.doesNotMatch(en,/[㐀-鿿]/)
 const many=render('en',value=>{(value.derivation as {unchangedFiles:string[]}).unchangedFiles=['LICENSE.txt','a.md','b.md']})
 assert.match(many,/The other 3 files match the original \(verified\)/)
 assert.doesNotMatch(render('zh-CN',value=>{(value.derivation as {unchangedFiles:string[]}).unchangedFiles=[]}),/与原版一致/)
})

test('七类都有十语词条；组件分组顺序取契约常量；源码无中文字面量',()=>{
 const source=readFileSync(new URL('../src/client/MarketDerivativeChanges.tsx',import.meta.url),'utf8')
 assert.match(source,/marketDerivativeChangeTypes/)
 const code=source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'')
 assert.doesNotMatch(code,/[㐀-鿿]/)
 for(const type of marketDerivativeChangeTypes){
  for(const locale of ['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt']){
   const value=translateMessage(locale,('market.catalog.derivative.type.'+type) as never)
   assert.ok(value&&!value.startsWith('market.'),locale+' '+type)
  }
 }
})
