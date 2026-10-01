import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {readFileSync} from 'node:fs'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {MarketCatalogCards,reviewsEnabled}=await import('../lib/types/client/MarketCatalogSection.js')
const {MarketReviews,MarketReviewList,ReviewStars,ReviewDistribution,reviewSummaryLabel,reviewConfirmReducer,publishAllowed,reviewPublishKeys}=await import('../lib/types/client/MarketReviews.js')
const {createMarketReviewsApi}=await import('../lib/types/client/market-reviews-api.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const {MAIN_LOCALES}=await import('../lib/types/client/i18n/locale.js')
const {MARKET_CATALOG_MESSAGE_ROWS}=await import('../lib/types/client/i18n/locales/market-catalog.js')
const {catalogEntry}=await import('./market-catalog-fixture.ts')

const runtime=(locale:'zh-CN'|'en')=>({t:(key:string,params?:Record<string,string|number>)=>translateMessage(locale,key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale,dshLocale:locale==='en'?'en':'zh',revision:1})})
const render=(node:unknown,locale:'zh-CN'|'en'='zh-CN')=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime(locale) as never},node as never))
const artifact={files:[{path:'SKILL.md',sha256:'b'.repeat(64),size:1}],treeHash:'c'.repeat(64)}

test('卡片评价区：有 reviewSlot 时追加在卡片末尾；没有时输出不变',()=>{
 const item={entry:catalogEntry(),artifact,addedContentId:null,addedRoleId:null,secretGroup:null}
 const base={items:[item],busy:undefined,addErrors:{},add:()=>{},open:()=>{}}
 const plain=render(createElement(MarketCatalogCards,base as never))
 const slotted=render(createElement(MarketCatalogCards,{...base,reviewSlot:(entry:{id:string})=>createElement('span',{'data-slot':entry.id})} as never))
 assert.match(slotted,/<span data-slot="anthropic\.internal-comms"><\/span><\/li>/)
 assert.equal(slotted.replace('<span data-slot="anthropic.internal-comms"></span>',''),plain)
})

test('评价折叠区标题：有评分显示均分与条数（中英），无评分只显示「评价」；星级文本',()=>{
 // 这里只验证 SSR 标题与渲染期不访问接口；展开后的 effect 请求由浏览器交互测试验证。
 const api=new Proxy({},{get(_,key){throw Error('未展开却调用了 '+String(key))}}) as never,rating={id:'teloa.soc',count:12,avg:4.6}
 assert.match(render(createElement(MarketReviews,{api,entryId:'teloa.soc',rating})),/<summary>评价 4\.6 分（12）<\/summary>/)
 assert.match(render(createElement(MarketReviews,{api,entryId:'teloa.soc',rating}),'en'),/<summary>Reviews 4\.6 out of 5 \(12\)<\/summary>/)
 assert.match(render(createElement(MarketReviews,{api,entryId:'teloa.soc'})),/<summary>评价<\/summary>/)
 // 星级是五颗单色 SVG（前 N 颗实心），整组 aria-hidden；可读的「N 星」由外层 aria-label 给出。
 const stars=render(createElement(ReviewStars,{rating:4}))
 assert.equal((stars.match(/<svg/g)||[]).length,5)
 assert.equal((stars.match(/data-filled="true"/g)||[]).length,4)
 assert.match(stars,/^<span[^>]*aria-hidden="true"/)
 assert.deepEqual(reviewSummaryLabel({id:'a.b',count:3,avg:5}),{key:'market.catalog.reviews.summary',params:{avg:'5.0',count:3}})
 assert.doesNotMatch(render(createElement(MarketReviews,{api,entryId:'teloa.soc',rating})),/正在读取评价|连接市场账号/)
})

test('API：发表前本机校验（非法不发请求）；回包按契约严格校验；summary 透传 enabled；link-poll 可显式取消',async()=>{
 const calls:[string,unknown][]=[]
 const own={id:'00000000-0000-4000-8000-000000000009',rating:4,body:'好',entryVersion:'1.0.1',status:'visible',createdAt:'2026-09-26T00:00:00.000Z',updatedAt:'2026-09-26T00:00:00.000Z'}
 const api=createMarketReviewsApi(async(endpoint:string,payload:unknown)=>{
  calls.push([endpoint,payload])
  if(endpoint==='market-reviews/summary')return {enabled:false,asOf:null,entries:[]}
  if(endpoint==='market-reviews/publish')return {review:own}
  if(endpoint==='market-reviews/list')return {entryId:'teloa.soc',count:1,avg:null,claimedBy:null,items:[],nextCursor:null}
  if(endpoint==='market-reviews/link-poll')return {status:'idle'}
  if(endpoint==='market-reviews/mine')return {review:null}
  if(endpoint==='market-reviews/delete')return {deleted:true}
  throw Error(endpoint)
 })
 assert.deepEqual(await api.summary(),{enabled:false,asOf:null,entries:[]})
 await assert.rejects(api.publish('teloa.soc',{rating:0,body:''}))
 await assert.rejects(api.publish('teloa.soc',{rating:5,body:'x'.repeat(2001)}))
 assert.equal(calls.filter(([endpoint])=>endpoint==='market-reviews/publish').length,0)
 assert.deepEqual(await api.publish('teloa.soc',{rating:4,body:' 好 '}),own)
 assert.deepEqual(calls.at(-1),['market-reviews/publish',{entryId:'teloa.soc',rating:4,body:'好'}])
 await assert.rejects(api.list('teloa.soc'))
 assert.equal(await api.mine('teloa.soc'),null)
 assert.deepEqual(await api.linkPoll(),{status:'idle'})
 assert.deepEqual(calls.at(-1),['market-reviews/link-poll',{}])
 assert.deepEqual(await api.linkPoll({cancel:true}),{status:'idle'})
 assert.deepEqual(calls.at(-1),['market-reviews/link-poll',{cancel:true}])
 await api.remove('teloa.soc')
 assert.deepEqual(calls.at(-1),['market-reviews/delete',{entryId:'teloa.soc'}])
})

test('评价区显示条件（规格 §14）：没有 reviews 接口、汇总 enabled:false、汇总读取失败都不显示',()=>{
 const reviews={} as never
 assert.equal(reviewsEnabled({reviews},{enabled:true,asOf:null,entries:[]}),true)
 assert.equal(reviewsEnabled({},{enabled:true,asOf:null,entries:[]}),false)
 assert.equal(reviewsEnabled({reviews},{enabled:false,asOf:null,entries:[]}),false)
 assert.equal(reviewsEnabled({reviews},undefined),false)
})

test('二次确认状态机（规格 §13）：发表只在确认态且署名未变时放行；账号变化回到确认前；取消不提交',()=>{
 const none={kind:'none'} as const
 assert.equal(publishAllowed(none,'MaxTester'),false,'未确认不能发表')
 const confirming=reviewConfirmReducer(none,{type:'ask-publish',nickname:'MaxTester'})
 assert.deepEqual(confirming,{kind:'publish',nickname:'MaxTester'})
 assert.equal(publishAllowed(confirming,'MaxTester'),true)
 assert.equal(publishAllowed(confirming,'Other'),false,'换号后不能发表')
 assert.equal(publishAllowed(confirming,null),false,'断开后不能发表')
 assert.deepEqual(reviewConfirmReducer(confirming,{type:'account',nickname:'MaxTester'}),confirming,'署名未变保持确认态')
 assert.deepEqual(reviewConfirmReducer(confirming,{type:'account',nickname:'Other'}),none,'换号回到确认前')
 assert.deepEqual(reviewConfirmReducer(confirming,{type:'account',nickname:null}),none,'断开回到确认前')
 assert.deepEqual(reviewConfirmReducer(confirming,{type:'cancel'}),none)
 assert.deepEqual(reviewConfirmReducer(confirming,{type:'done'}),none)
 const deleting=reviewConfirmReducer(none,{type:'ask-delete'})
 assert.deepEqual(deleting,{kind:'delete'})
 assert.equal(publishAllowed(deleting,'MaxTester'),false)
 assert.deepEqual(reviewConfirmReducer(deleting,{type:'account',nickname:'Other'}),deleting,'删除确认不看署名')
 assert.deepEqual(reviewConfirmReducer(deleting,{type:'account',nickname:null}),none)
})

test('评价列表按纯文本渲染：标签转义、链接不可点、星级可读、昵称隔离方向',()=>{
 const items=[
  {id:'00000000-0000-4000-8000-000000000001',nickname:'Alice',rating:5,body:'<b>不是粗体</b> https://example.com/a\n第二行',entryVersion:'1.0.0',createdAt:'2026-09-20T00:00:00.000Z',updatedAt:'2026-09-21T00:00:00.000Z',reply:{by:'author' as const,name:'<i>anthropic</i>',body:'<script>alert(1)</script>',createdAt:'2026-09-22T00:00:00.000Z'}},
  {id:'00000000-0000-4000-8000-000000000002',nickname:'<img src=x>',rating:4,body:'还行',entryVersion:'1.0.0',createdAt:'2026-09-19T00:00:00.000Z',updatedAt:'2026-09-19T00:00:00.000Z',reply:null},
 ]
 const html=render(createElement(MarketReviewList,{items}))
 assert.match(html,/&lt;b&gt;不是粗体&lt;\/b&gt; https:\/\/example\.com\/a\n第二行/)
 assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
 assert.match(html,/作者 &lt;i&gt;anthropic&lt;\/i&gt; 回复/)
 assert.match(html,/<bdi>&lt;img src=x&gt;<\/bdi>/)
 assert.doesNotMatch(html,/<a |<b>|<i>|<img|<script/)
 // 星级：外层 role=img 带可读的「N 星」，里面五颗单色 SVG（前 N 颗实心）整组 aria-hidden，不含星形符号字符。
 assert.match(html,/<span role="img" aria-label="5 星"><span class="stars" aria-hidden="true">(<svg[^>]*data-filled="true"><path[^>]*><\/path><\/svg>){5}<\/span><\/span>/)
 assert.match(render(createElement(MarketReviewList,{items}),'en'),/aria-label="4 stars"><span class="stars" aria-hidden="true">(<svg[^>]*data-filled="true">.*?<\/svg>){4}<svg[^>]*data-filled="false">/)
 assert.doesNotMatch(html,/[\u2605\u2606]/)
})

test('评价列表只列有正文的评价；GitHub 用户名形态的署名与作者名显示为 @用户名，昵称照原样',()=>{
 const base={entryVersion:'1.0.0',createdAt:'2026-09-20T00:00:00.000Z',updatedAt:'2026-09-20T00:00:00.000Z'}
 const items=[
  {...base,id:'00000000-0000-4000-8000-000000000001',nickname:'octo-cat',rating:5,body:'好用',reply:{by:'author' as const,name:'acme',body:'谢谢',createdAt:'2026-09-21T00:00:00.000Z'}},
  {...base,id:'00000000-0000-4000-8000-000000000002',nickname:'小明',rating:3,body:'一般',reply:null},
  {...base,id:'00000000-0000-4000-8000-000000000003',nickname:'silent',rating:1,body:'',reply:null},
 ]
 const html=render(createElement(MarketReviewList,{items}))
 assert.equal((html.match(/<li>/g)||[]).length,2)
 assert.doesNotMatch(html,/silent/)
 assert.match(html,/<bdi>@octo-cat<\/bdi>/)
 assert.match(html,/<bdi>小明<\/bdi>/)
 assert.match(html,/作者 @acme 回复/)
})

test('评分分布：5 星到 1 星五行横条（纯 CSS，不用星形符号），条长按占比、读屏读「N 星」与条数',()=>{
 const html=render(createElement(ReviewDistribution,{distribution:{1:1,2:0,3:1,4:2,5:4}}))
 assert.match(html,/^<ul class="distribution" aria-label="评分分布">/)
 const rows=[...html.matchAll(/<li><span>([^<]+)<\/span><span class="distributionBar" aria-hidden="true"><i style="width:([\d.]+)%"><\/i><\/span><span>(\d+)<\/span><\/li>/g)].map(match=>[match[1],Number(match[2]),match[3]])
 assert.deepEqual(rows,[['5 星',50,'4'],['4 星',25,'2'],['3 星',12.5,'1'],['2 星',0,'0'],['1 星',12.5,'1']])
 assert.match(render(createElement(ReviewDistribution,{distribution:{1:0,2:0,3:0,4:0,5:0}})),/width:0%/)
 assert.match(render(createElement(ReviewDistribution,{distribution:{1:1,2:0,3:0,4:0,5:0}}),'en'),/aria-label="Rating breakdown".*<span>1 star<\/span>/)
 assert.doesNotMatch(html,/[\u2605\u2606]|<svg/)
})

test('确认文案与按钮按审核方式：先审后发（含未给出）用「提交后经审核公开」「提交评价」「确认提交」，先发后审才用「任何人都能看到」「发表」',()=>{
 const preKeys={confirm:'market.catalog.reviews.confirmPending',publish:'market.catalog.reviews.submit',confirmPublish:'market.catalog.reviews.confirmSubmit'}
 assert.deepEqual(reviewPublishKeys({moderation:'pre'}),preKeys)
 assert.deepEqual(reviewPublishKeys({}),preKeys)
 assert.deepEqual(reviewPublishKeys({moderation:'post'}),{confirm:'market.catalog.reviews.confirm',publish:'market.catalog.reviews.publish',confirmPublish:'market.catalog.reviews.confirmPublish'})
 assert.equal(translateMessage('zh-CN','market.catalog.reviews.submit' as never),'提交评价')
 assert.equal(translateMessage('zh-CN','market.catalog.reviews.confirmSubmit' as never),'确认提交')
 const pending=translateMessage('zh-CN','market.catalog.reviews.confirmPending' as never,{nickname:'@xm',stars:'4 星'})
 assert.match(pending,/提交后经审核公开/);assert.doesNotMatch(pending,/任何人/)
 assert.doesNotMatch(translateMessage('en','market.catalog.reviews.confirmPending' as never,{nickname:'@xm',stars:'4 stars'}),/anyone/i)
})

test('评价正文按纯文本渲染：标签转义、链接不可点；不用 dangerouslySetInnerHTML',()=>{
 const source=readFileSync(new URL('../src/client/MarketReviews.tsx',import.meta.url),'utf8')
 assert.ok(!source.includes('dangerouslySetInnerHTML'))
 // 折叠区外链固定为官网与文档，均带 noreferrer
 assert.ok(!/href=\{item\./.test(source),'评价条目里的任何字段都不能当链接地址')
 assert.match(source,/rel="noreferrer"/)
})

test('评价词条：每键 11 列、10 语言非空、占位符齐、zh-CN 与 en 无禁词',()=>{
 const rows=(MARKET_CATALOG_MESSAGE_ROWS as readonly (readonly string[])[]).filter(row=>row[0]!.startsWith('market.catalog.reviews.'))
 assert.ok(rows.length>=30,'评价词条不足')
 const keys=rows.map(row=>row[0]!)
 assert.equal(new Set(keys).size,keys.length)
 for(const key of ['title','summary','loading','failed','empty','connectHint','connect','connectCode','connectOpen','connectCancel','connectExpired','connected','disconnect','reconnect','alreadyLinked','selfEntry','rateLimited','accountChanged','rating','body','publish','update','confirm','confirmPublish','cancel','published','pending','hidden','delete','confirmDelete','deleted','actionFailed','viewAll','privacy','replyAuthor','replyTeloa','distribution','noText','confirmPending','submit','confirmSubmit'])assert.ok(keys.includes('market.catalog.reviews.'+key),key)
 const params={avg:'4.6',count:12,reason:'r',rating:4,name:'n',code:'ABCD-EFGH',nickname:'nick',stars:'★★★★☆'}
 for(const row of rows){
  assert.equal(row.length,11,row[0])
  for(const [index,locale] of MAIN_LOCALES.entries()){
   const value=translateMessage(locale,row[0] as never,params)
   assert.ok(value.trim().length>0&&!value.startsWith('market.')&&!/\{\w+\}/.test(value),`${locale} ${row[0]}`)
   assert.equal(value,row[index+1]!.replace(/\{(\w+)\}/g,(_,name:string)=>String(params[name as keyof typeof params])))
  }
  assert.doesNotMatch(translateMessage('zh-CN',row[0] as never,params),/工作空间|单空间|实例|投影|尚未加载|内容待读取|\d+\s*项资源|人类/)
  assert.doesNotMatch(translateMessage('en',row[0] as never,params),/workspace|instance|\bhumans?\b/i)
 }
})
