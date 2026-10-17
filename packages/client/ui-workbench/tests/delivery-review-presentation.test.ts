import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash} from 'node:crypto'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {readHostReviewDelivery,sha256Hex,verifyHostReviewDelivery} from '../src/client/delivery-review-presentation.ts'

// .tsx 组件走 tsc 产物；*.module.css 换成类名代理（与 evidence-list.test.ts 同一做法）。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {DeliveryReviewContextView}=await import('../lib/types/client/DeliveryReviewContextView.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}

const sha=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex')
const deliveryText='## 结论\n已知：8 家说排班省时。\n| 档 | 条件 |\n|---|---|\n| 升级 | ≥3 |'
const deliverySource={kind:'plugin:teloa.delivery-review',form:'notice',summary:'复核后交付',runId:'run',draftMessageId:'draft',planMessageId:'plan',draftSha256:sha('草稿'),deliverySha256:sha(deliveryText),edits:2}
const contextNode=(source:unknown,text:string)=>({key:'context:9',kind:'context',data:{kind:'context',seq:9,time:0,source,content:[{type:'text',text}],producer:{role:'inject',label:'plugin:teloa.delivery-review'},form:'notice'}})

test('只认宿主交付复核来源且摘要为「复核后交付」的正文；编辑计划、待校正草稿、复核要求与其他来源都交给原生呈现',()=>{
 assert.deepEqual(readHostReviewDelivery(contextNode(deliverySource,deliveryText).data),{text:deliveryText,edits:2,deliverySha256:sha(deliveryText),planMessageId:'plan'})
 for(const summary of ['交付编辑计划','待校正草稿','交付改写'])assert.equal(readHostReviewDelivery(contextNode({...deliverySource,summary},deliveryText).data),null,summary)
 assert.equal(readHostReviewDelivery(contextNode({...deliverySource,kind:'plugin:other'},deliveryText).data),null,'其他插件来源')
 assert.equal(readHostReviewDelivery(contextNode({kind:'model',provider:'p',model:'m'},deliveryText).data),null,'模型来源不被当作宿主交付')
 assert.equal(readHostReviewDelivery(contextNode(deliverySource,'  ').data),null,'空正文不呈现为交付')
 assert.deepEqual(readHostReviewDelivery(contextNode({...deliverySource,edits:-1,deliverySha256:'not-a-hash'},deliveryText).data),{text:deliveryText,edits:null,deliverySha256:null,planMessageId:'plan'},'不可信的编辑数与摘要不展示为数据')
})

test('会话展示的正文摘要与宿主记录（即任务结果正文的摘要）逐字节核对：一致为 true，被改动为 false，无摘要为 null',async()=>{
 assert.equal(await sha256Hex(deliveryText),sha(deliveryText),'浏览器 SHA-256 与 Node 同算法')
 const delivery=readHostReviewDelivery(contextNode(deliverySource,deliveryText).data)!
 assert.equal(await verifyHostReviewDelivery(delivery),true)
 assert.equal(await verifyHostReviewDelivery({...delivery,text:deliveryText+' '}),false)
 assert.equal(await verifyHostReviewDelivery({...delivery,deliverySha256:null}),null)
})

const Native=({node}:{node:{key:string}})=>createElement('div',{'data-native':node.key},'原生上下文行')
const nativeEntry={options:{key:'context',priority:0},component:Native}
const renderer={subscribe:()=>()=>{},getSnapshot:()=>[nativeEntry],isLive:(entry:unknown)=>entry===nativeEntry}
const render=(node:ReturnType<typeof contextNode>)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(DeliveryReviewContextView as never,{node,renderer,sessionId:'s'})))

test('「复核后交付」呈现为可读、可复制的完整交付卡，标明由宿主按复核编辑计划生成而非模型原文；不再折叠成原生 notice 行',()=>{
 const html=render(contextNode(deliverySource,deliveryText))
 assert.ok(html.includes('复核后交付'))
 assert.ok(html.includes('由宿主按模型复核编辑计划生成，不是模型原文'),'来源标为宿主复核交付')
 assert.ok(html.includes('按复核编辑计划修改 2 处'))
 assert.ok(html.includes('<h2>结论</h2>')&&html.includes('已知：8 家说排班省时。')&&html.includes('<table'),'完整正文按 Markdown 直接展开阅读')
 assert.ok(html.includes('复制交付全文'))
 assert.ok(!html.includes('原生上下文行'),'交付卡取代该节点的原生折叠行')
 assert.ok(!/assistant|助手回复/.test(html),'不呈现为模型助手回复')
 const unchanged=render(contextNode({...deliverySource,edits:0},deliveryText))
 assert.ok(unchanged.includes('复核确认无需修改'))
})

test('其他上下文行（含复核要求、编辑计划相关 notice 与其他插件）仍由原生 context renderer 呈现，不被改写',()=>{
 for(const source of [{...deliverySource,summary:'交付编辑计划'},{...deliverySource,summary:'待校正草稿'},{kind:'runtime-context'}]){
  const html=render(contextNode(source,'复核要求正文'))
  assert.ok(html.includes('data-native="context:9"')&&html.includes('原生上下文行'),JSON.stringify(source))
  assert.ok(!html.includes('复核后交付'))
 }
 const withoutNative=renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},createElement(DeliveryReviewContextView as never,{node:contextNode({kind:'runtime-context'},'x'),renderer:{...renderer,getSnapshot:()=>[]},sessionId:'s'})))
 assert.equal(withoutNative,'','原生 renderer 不在时不自造替代行')
})
