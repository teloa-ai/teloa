import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import type {MarketItem} from '../src/client/market-preview.ts'

// 与 market-solution-presentation.test.ts 同一条路子：.tsx 走 tsc 产物，CSS Modules 换成类名代理，
// 所以下面断言里的 class 名就是源码里写的键名（itemList / itemCard / …）。
registerHooks({
 resolve:(specifier,context,next)=>/\.(module\.css|svg|webp)$/.test(specifier)?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier),
 load:(url,context,next)=>/\.(svg|webp)$/.test(url)?{format:'module',shortCircuit:true,source:'export default '+JSON.stringify(url)}:url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {MarketResourceCatalog}=await import('../lib/types/client/MarketResourceCatalog.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const render=(node:unknown)=>renderToStaticMarkup(createElement(I18nProvider as never,{runtime:runtime as never},node as never))
const item=(patch:Partial<MarketItem>={}):MarketItem=>({id:'skill-a',kind:'skill',title:'周报整理',version:'1.0.0',scope:'general',visibility:'public',summary:'把散落的进展整理成一份周报。',requirements:[],output:'结果',author:'作者',license:'许可',source:{kind:'builtin'},owner:'Teloa',compatibility:'待核对',components:[],...patch})
const catalog=(items:readonly MarketItem[],kind:'skill'|'role'|'resource')=>render(createElement(MarketResourceCatalog as never,{items,kind,open:()=>{}}))

test('条目卡是单列列表：一层 itemList 容器 + 整行按钮，行内带形象、标题与 chevron',()=>{
 const html=catalog([item()],'skill')
 assert.match(html,/class="itemList"[^>]*role="listbox"/)
 assert.match(html,/<button[^>]*class="itemCard"[^>]*role="option"/)
 // 单列：一条数据就只有一个行按钮，没有两栏网格留下的第二层包装。
 assert.equal((html.match(/class="itemCard"/g)??[]).length,1)
 assert.doesNotMatch(html,/class="catalogGrid"/)
 assert.doesNotMatch(html,/class="catalogCard"/)
 assert.match(html,/class="icon[^"]*"/)
 assert.match(html,/class="itemMain"/)
 assert.match(html,/class="resourceTitle">周报整理</)
 assert.match(html,/class="resourceDescription">把散落的进展整理成一份周报。</)
 // chevron 收在行尾：整行是一个按钮，不再摆「查看并安装」这类状态句当链接。
 assert.match(html,/lucide-chevron-right[\s\S]*<\/button>/)
 assert.doesNotMatch(html,/查看并安装/)
})

test('适用范围与来源收进行内第二行「范围 · 来源」，不再各占一个 dt',()=>{
 const html=catalog([item()],'skill')
 assert.match(html,/class="resourceFacts">通用 · Teloa 内置示例</)
 assert.doesNotMatch(html,/<dt>/)
 assert.doesNotMatch(html,/适用范围/)
 // 运行归属与引用计数退出卡面（原委仍在右侧详情里）：行里不出现生态与加载状态这类系统话。
 assert.doesNotMatch(html,/尚未加载/)
 assert.doesNotMatch(html,/Teloa 生态/)
 assert.doesNotMatch(html,/由 Teloa 管理与绑定/)
})

test('同事行用本人形象，其余类型用类型图标',()=>{
 const staff=catalog([item({id:'role-a',kind:'role',title:'研究助理'})],'role')
 assert.match(staff,/class="icon avatar"[^>]*>.*researcher\.webp/)
 assert.doesNotMatch(staff,/class="itemArt"/)
 assert.match(catalog([item()],'skill'),/class="icon skill"[^>]*>.*lucide-braces/)
})

test('conflict 条目在行里给「有冲突」记号，不落「可添加」',()=>{
 const html=catalog([item({id:'dup'}),item({id:'dup',kind:'role',title:'重名条目'})],'skill')
 assert.match(html,/class="mark mark_conflict"[^>]*title="有冲突"/)
 assert.match(html,/class="srOnly">有冲突</)
 assert.doesNotMatch(html,/可添加/)
})

test('通用目录卡（工作模板页签与搜索结果）与资源目录同一套单列行',async()=>{
 const source=await readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8')
 const cards=source.slice(source.indexOf('function MarketCards'),source.indexOf('function MarketCatalog'))
 assert.match(cards,/className=\{css\.itemList\}/)
 assert.match(cards,/className=\{css\.itemCard\}/)
 assert.match(cards,/<ItemArt kind=\{marketCategoryOf\(item\)\} title=\{copy\.title\} seed=\{item\.id\}\/>/)
 assert.match(cards,/<span className=\{css\.resourceFacts\}>\{display\.scope\} · \{display\.source\}<\/span>/)
 assert.match(cards,/<ChevronRight size=\{16\}\/>/)
 // 两个 dt 与「查看并……」链接都退场了。
 assert.doesNotMatch(cards,/<dl>/)
 assert.doesNotMatch(cards,/css\.cardLink/)
 assert.doesNotMatch(cards,/display\.action/)
})
