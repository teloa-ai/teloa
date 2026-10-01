import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {MarketCatalogCards,MarketCatalogSection,marketCatalogMatches,marketCatalogVisible,loadCatalogListing,catalogSortVisible}=await import('../lib/types/client/MarketCatalogSection.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const {catalogEntry,solutionEntry}=await import('./market-catalog-fixture.ts')

const runtime=(locale:'zh-CN'|'en')=>({t:(key:string,params?:Record<string,string|number>)=>translateMessage(locale,key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale,dshLocale:locale==='en'?'en':'zh',revision:1})})
const render=(node:unknown,locale:'zh-CN'|'en'='zh-CN')=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime(locale) as never},node as never))
const artifact={files:[{path:'SKILL.md',sha256:'b'.repeat(64),size:1}],treeHash:'c'.repeat(64)}
const item=(patch:Record<string,unknown>={},entry:Record<string,unknown>={})=>({entry:{...catalogEntry(),...entry},artifact,addedContentId:null,...patch}) as never
const cards=(items:unknown[],extra:Record<string,unknown>={},locale:'zh-CN'|'en'='zh-CN')=>render(createElement(MarketCatalogCards,{items,busy:undefined,addErrors:{},add:()=>{},open:()=>{},...extra} as never),locale)

test('安装型未添加：显示添加按钮、兼容徽标、原作者与许可；来源详情带锁定的提交链接',()=>{
 const html=cards([item()])
 assert.match(html,/添加到我的技能/);assert.match(html,/只有说明，不含程序/);assert.match(html,/原作者 Anthropic · 许可 Apache-2.0/)
 assert.match(html,/href="https:\/\/github.com\/anthropics\/skills\/tree\/33375500bcea98d610eb30ce10ac4e59b89c390d\/skills\/internal-comms"/)
 assert.match(html,/rel="noreferrer"/);assert.match(html,/原样收录，未做修改/);assert.match(html,/不需要额外工具/)
 assert.doesNotMatch(html,/工作空间|单空间|实例|投影|尚未加载|内容待读取|人类/)
})

test('已添加显示查看；内置条目没有按钮；添加中禁用；失败显示原因',()=>{
 assert.match(cards([item({addedContentId:'22222222-2222-4222-8222-222222222222'})]),/已添加[\s\S]*查看/)
 const builtin=cards([item({},{delivery:'builtin',skill:{...catalogEntry().skill,name:'teloa-skill-creator'},compatibility:{...catalogEntry().compatibility,status:'verified'}})])
 assert.match(builtin,/已内置，新建技能时自动使用/);assert.doesNotMatch(builtin,/<button[^>]*>添加到我的技能/);assert.match(builtin,/已验证版本/)
 assert.match(cards([item()],{busy:'anthropic.internal-comms'}),/disabled=""[^>]*>正在添加…/)
 assert.match(cards([item()],{addErrors:{'anthropic.internal-comms':'添加失败：网络中断'}}),/添加失败：网络中断/)
 assert.match(cards([]),/没有匹配的官方资源/)
})

test('英文界面取英文文本，兼容四值各有文案',()=>{
 const html=cards([item(),item({},{id:'a.b',compatibility:{...catalogEntry().compatibility,status:'needs-configuration'}}),item({},{id:'a.c',compatibility:{...catalogEntry().compatibility,status:'unsupported'}})],{},'en')
 assert.match(html,/Internal communications/);assert.match(html,/Add to my skills/);assert.match(html,/Needs configuration/);assert.match(html,/Not supported/);assert.match(html,/Instructions only, no code/)
})

test('区块首屏显示读取中；搜索匹配标题、用途与作者',()=>{
 const html=render(createElement(MarketCatalogSection,{api:{list:()=>new Promise(()=>{}),add:async()=>({contentId:''})},query:'',openContent:()=>{}} as never))
 assert.match(html,/Teloa 官方目录/);assert.match(html,/正在读取官方目录/)
 assert.equal(marketCatalogMatches(item(),'沟通'),true);assert.equal(marketCatalogMatches(item(),'anthropic'),true);assert.equal(marketCatalogMatches(item(),'pdf'),false)
})

test('方案条目：显示标题、简介、能力要点（前两条）与官方徽标',()=>{
 const solutionItem={entry:solutionEntry(),artifact:{files:[{path:'teloa.json',sha256:'a'.repeat(64),size:1},{path:'LICENSE',sha256:'b'.repeat(64),size:1}],treeHash:'c'.repeat(64)},addedContentId:null} as never
 const html=cards([solutionItem])
 assert.match(html,/通用办公/);assert.match(html,/日常办公自动化方案/);assert.match(html,/Teloa 官方方案/)
 assert.match(html,/现在可做/);assert.match(html,/起草邮件与会议纪要/);assert.match(html,/整理工作计划/)
 assert.match(html,/添加方案/);assert.doesNotMatch(html,/添加到我的技能/)  // 方案按钮不能沿用技能文案
 assert.doesNotMatch(html,/生成周报/)  // 第 3 条不在前两条内，不显示
 assert.doesNotMatch(html,/原作者 /)     // 方案无原作者信息行
})

test('搜索可匹配方案字段',()=>{
 const solutionItem={entry:solutionEntry(),artifact:{files:[{path:'teloa.json',sha256:'a'.repeat(64),size:1}],treeHash:'c'.repeat(64)},addedContentId:null} as never
 assert.equal(marketCatalogMatches(solutionItem,'办公'),true)
 assert.equal(marketCatalogMatches(solutionItem,'office'),true)
 assert.equal(marketCatalogMatches(solutionItem,'anthropic'),false)
})

const upstreamEntry=(compatibility:Record<string,unknown>={})=>({format:'teloa.market-catalog-entry/v1',id:'clawhub.byungkyu.gmail',kind:'skill',delivery:'upstream',version:'1.0.0',taxonomy:{functions:['office-docs'],industries:['general']},
 skill:{name:'gmail',title:{'zh-CN':'Gmail 邮件收发',en:'Gmail'},summary:{'zh-CN':'集成 Gmail API。',en:'Integrate Gmail API.'}},
 upstream:{kind:'clawhub',owner:'byungkyu',slug:'gmail',version:'1.0.0',files:[{path:'SKILL.md',sha256:'a'.repeat(64),size:1}]},
 origin:{marketplace:'clawhub',installs:null,installsLabel:'',countedAt:'2026-09-25'},
 alternatives:[],unsupportedComponents:[],modifications:[],license:{spdx:'MIT',files:[]},
 compatibility:{status:'unsupported',teloa:'>=0.2.0',dsh:'any',conditions:[{'zh-CN':'需通过第三方 Maton 网关授权，暂不可添加。','en':'Requires Maton gateway; cannot be added yet.'}],...compatibility},
 requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-25',reviewer:'Teloa 内容安全审查（逐文件）'}})

const upstreamItem=(entryPatch:Record<string,unknown>={})=>({entry:{...upstreamEntry(),...entryPatch},artifact:null,addedContentId:null}) as never

test('上游 unsupported 条目：不渲染添加按钮，改为显示第一条 condition 文本；徽章仍显示兼容状态',()=>{
 const html=cards([upstreamItem()])
 assert.doesNotMatch(html,/<button[^>]*>添加到我的技能/)
 assert.match(html,/需通过第三方 Maton 网关授权，暂不可添加。/)
 assert.match(html,/不支持/)  // 兼容状态徽章
})

test('上游 unsupported 条目：英文界面显示 en condition 文本',()=>{
 const html=cards([upstreamItem()],{},'en')
 assert.doesNotMatch(html,/<button[^>]*>Add to my skills/)
 assert.match(html,/Requires Maton gateway; cannot be added yet\./)
 assert.match(html,/Not supported/)
})

test('上游 content-only 条目：显示添加按钮',()=>{
 const html=cards([upstreamItem({compatibility:{status:'content-only',teloa:'>=0.2.0',dsh:'any',conditions:[]}})])
 assert.match(html,/添加到我的技能/)
})

test('其他来源按本地化标题显示，推荐在前；失效目标不出入口，查看与添加回调分开',()=>{
 const target=item({}, {id:'teloa.alternative',skill:{name:'alternative',title:{'zh-CN':'官方连接方案',en:'Official alternative'},summary:{'zh-CN':'说明',en:'Description'}}})
 const other=item({}, {id:'codex.alternative'})
 const origin=upstreamItem({alternatives:[{entryId:'codex.alternative',marketplace:'codex',installs:null},{entryId:'missing',marketplace:'teloa',installs:null},{entryId:'teloa.alternative',marketplace:'teloa',installs:null,recommended:true}]})
 const extra={catalogItems:[origin,other,target],openEntry:()=>{}}
 const html=cards([origin],extra)
 assert.match(html,/其他来源/);assert.match(html,/推荐改用：官方连接方案/)
 assert.ok(html.indexOf('推荐改用：官方连接方案')<html.indexOf('查看 内部沟通稿'))
 assert.doesNotMatch(html,/missing/)
 assert.match(cards([origin],extra,'en'),/Recommended: Official alternative/)
 assert.doesNotMatch(cards([upstreamItem()],extra),/其他来源/)
 assert.doesNotMatch(cards([origin],{...extra,catalogItems:[]}),/其他来源/)
})

test('NOASSERTION 资源明确只展示出处，不出现添加入口',()=>{
 const provenance=upstreamItem({license:{spdx:'NOASSERTION',files:[]}})
 assert.match(cards([provenance]),/仅展示出处，不能添加/)
 assert.match(cards([provenance],{},'en'),/Source reference only; cannot be added/)
 assert.doesNotMatch(cards([provenance]),/添加到我的技能/)
})

test('种类过滤：技能分类只显示技能，行业模板分类只显示方案，缺省两类都显示',()=>{
 const skill=item(),solution={entry:solutionEntry(),artifact:{files:[{path:'teloa.json',sha256:'a'.repeat(64),size:1}],treeHash:'c'.repeat(64)},addedContentId:null} as never
 const kindsOf=(rows:{entry:{kind:string}}[])=>rows.map(row=>row.entry.kind)
 assert.deepEqual(kindsOf(marketCatalogVisible([skill,solution],'',['skill'])),['skill'])
 assert.deepEqual(kindsOf(marketCatalogVisible([skill,solution],'',['solution'])),['solution'])
 assert.deepEqual(kindsOf(marketCatalogVisible([skill,solution],'')),['skill','solution'])
 // 只有方案能匹配的搜索词，在技能分类里不应出现结果
 const onlySolution=(solutionEntry() as {solution:{packageId:string}}).solution.packageId
 assert.deepEqual(kindsOf(marketCatalogVisible([skill,solution],onlySolution)),['solution'])
 assert.deepEqual(kindsOf(marketCatalogVisible([skill,solution],onlySolution,['skill'])),[])
})

test('全部来源读取六个上游的全部分页，单来源筛选独立读取，来源失败保留其他结果并报告',async()=>{
 const official={entry:{id:'teloa.office'}},up=(id:string)=>({entry:{id}})
 const calls:unknown[]=[]
 const api={list:async(request?:Record<string,unknown>)=>{calls.push(request)
  if(!request?.marketplace||request.marketplace==='teloa')return {catalogVersion:'2026.9.25',items:[official],nextCursor:null}
  if(request.marketplace!=='clawhub')return {catalogVersion:'2026.9.25',items:[up(String(request.marketplace)+'.a')],nextCursor:null}
  return request.cursor?{catalogVersion:'2026.9.25',items:[up('clawhub.b')],nextCursor:null}:{catalogVersion:'2026.9.25',items:[up('clawhub.a')],nextCursor:'clawhub.a'}}}
 const all=await loadCatalogListing(api as never,undefined)
 assert.deepEqual(all.items.map((item:{entry:{id:string}})=>item.entry.id),['teloa.office','claude-code.a','codex.a','dsh.a','openclaw.a','clawhub.a','clawhub.b','hermes.a'])
 assert.equal(calls.length,8)
 assert.ok(calls.some(request=>(request as {cursor?:string}).cursor==='clawhub.a'))
 const onlyUpstream=await loadCatalogListing(api as never,'clawhub')
 assert.deepEqual(onlyUpstream.items.map((item:{entry:{id:string}})=>item.entry.id),['clawhub.a','clawhub.b'])
 const failing={list:async(request?:Record<string,unknown>)=>{if(request?.marketplace==='clawhub')throw Error('offline');return api.list(request)}}
 const partial=await loadCatalogListing(failing as never,undefined)
 assert.equal(partial.items.some((item:{entry:{id:string}})=>item.entry.id==='codex.a'),true)
 assert.deepEqual(partial.unavailableSources,['clawhub'])
 await assert.rejects(loadCatalogListing(failing as never,'clawhub'),/offline/)
 // 宿主上游索引损坏/未加载时报 WorkError（不再回空列表），同样归入「来源暂时无法读取」
 const corrupt={list:async(request?:Record<string,unknown>)=>{if(request?.marketplace&&request.marketplace!=='teloa')throw Object.assign(Error('上游资源索引完整性校验失败'),{code:'teloa/storage-corrupt'});return api.list(request)}}
 const unreadable=await loadCatalogListing(corrupt as never,undefined)
 assert.deepEqual(unreadable.items.map((item:{entry:{id:string}})=>item.entry.id),['teloa.office'])
 assert.deepEqual(unreadable.unavailableSources,['claude-code','codex','dsh','openclaw','clawhub','hermes'])
})

test('目录区块按当前分类读取来源：上游来源只有技能，非技能分类只读 Teloa 目录',async()=>{
 const {catalogSourcesForKinds}=await import('../lib/types/client/market-catalog-api.js')
 const all=['teloa','claude-code','codex','dsh','openclaw','clawhub','hermes']
 assert.deepEqual(catalogSourcesForKinds(undefined),all)
 assert.deepEqual(catalogSourcesForKinds(['skill']),all)
 assert.deepEqual(catalogSourcesForKinds(['skill','solution']),all)
 for(const kinds of [['solution'],['role'],['model'],['connector'],['solution','role']] as const)assert.deepEqual(catalogSourcesForKinds(kinds),['teloa'],kinds.join())
 const calls:unknown[]=[]
 const api={list:async(request?:Record<string,unknown>)=>{calls.push(request?.marketplace);return {catalogVersion:'2026.9.25',items:[],nextCursor:null}}}
 const listing=await loadCatalogListing(api as never,undefined,['teloa'])
 assert.deepEqual(calls,['teloa']);assert.deepEqual(listing.unavailableSources,[])
 // 非技能分类里可见资源的其他来源指向上游技能时，再补读上游来源，推荐导航不因懒加载失效
 const {loadCatalogListingForKinds}=await import('../lib/types/client/market-catalog-api.js')
 const connector=(alternatives:unknown[])=>({entry:{id:'teloa.remote',kind:'connector',delivery:'managed',alternatives}})
 for(const [alternatives,expected] of [[[],['teloa']],[[{entryId:'teloa.other'}],['teloa']],[[{entryId:'clawhub.calendly'}],['teloa',...all]]] as const){
  const seen:unknown[]=[]
  const scoped={list:async(request?:Record<string,unknown>)=>{seen.push(request?.marketplace);return {catalogVersion:'2026.9.25',items:request?.marketplace==='teloa'?[connector([...alternatives]),{entry:{id:'teloa.other',kind:'connector',delivery:'managed'}}]:[],nextCursor:null}}}
  await loadCatalogListingForKinds(scoped as never,['connector'])
  assert.deepEqual(seen,expected,JSON.stringify(alternatives))
 }
})

test('上游 GitHub 来源链接逐段编码，空格与非 ASCII 路径生成规范链接',async()=>{
 const {navigationSkill}=await import('./market-navigation-fixture.ts')
 const entry=navigationSkill();entry.license={spdx:'MIT',files:[]};entry.compatibility={...entry.compatibility,status:'content-only'}
 if(entry.upstream.kind!=='github')throw Error('fixture');entry.upstream.path='skills/my notes/中文'
 const html=cards([{entry,artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null}])
 assert.match(html,/href="https:\/\/github.com\/example\/skills\/tree\/a{40}\/skills\/my%20notes\/%E4%B8%AD%E6%96%87"/)
})

test('来源重复游标或超过分页上限时不把截断目录当作完整结果',async()=>{
 const broken={list:async()=>({catalogVersion:'test',items:[],nextCursor:'same'})}
 await assert.rejects(loadCatalogListing(broken as never,'codex'))
 let page=0
 const huge={list:async()=>({catalogVersion:'test',items:[],nextCursor:String(++page)})}
 await assert.rejects(loadCatalogListing(huge as never,'hermes'))
 assert.equal(page,20)
})

test('跨页目录版本变化或重复资源时拒绝该来源；完整 20 页允许读取',async()=>{
 for(const reason of ['version','duplicate']){
  let page=0
  const api={list:async()=>{page++;return {catalogVersion:reason==='version'?String(page):'1',items:[{entry:{id:reason==='duplicate'?'same':String(page)}}],nextCursor:page===1?'first':null}}}
  await assert.rejects(loadCatalogListing(api as never,'dsh'))
 }
 let page=0
 const complete={list:async()=>({catalogVersion:'1',items:[{entry:{id:String(++page)}}],nextCursor:page<20?String(page):null})}
 assert.equal((await loadCatalogListing(complete as never,'dsh')).items.length,20)
})


test('需厂商白名单且不收用户 client_id 的连接器：卡片不显示「连接」，改显示附录白名单固定文案',async()=>{
 const {oauthAllowlistBlocked}=await import('../lib/types/client/MarketCatalogSection.js')
 const connector=(auth:Record<string,unknown>)=>({format:'teloa.market-catalog-entry/v1',id:'teloa.mcp-figma',kind:'connector',delivery:'managed',version:'1.0.0',taxonomy:{functions:['communication'],industries:['general']},upstream:null,
  connector:{serverName:'figma',title:{'zh-CN':'Figma 远程','en':'Figma Remote'},summary:{'zh-CN':'远程','en':'Remote'},auth,recipe:{transport:'streamable-http',url:'https://mcp.figma.com/mcp'},tools:[],upstreamUrl:'https://developers.figma.com/'},
  modifications:[],license:{spdx:'MIT',files:['LICENSE']},compatibility:{status:'needs-configuration',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},requires:{tools:[],network:true,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-26',reviewer:'Teloa'}})
 const allowlist={kind:'oauth',supported:true,scopes:[],requiresAllowlist:true}
 const userClient={kind:'oauth',supported:true,scopes:['a'],requiresAllowlist:true,requiresUserClientId:true}
 assert.equal(oauthAllowlistBlocked(allowlist as never),true)
 assert.equal(oauthAllowlistBlocked(userClient as never),false)
 assert.equal(oauthAllowlistBlocked({kind:'oauth',supported:true,scopes:[]} as never),false)
 assert.equal(oauthAllowlistBlocked({kind:'oauth',supported:false,reason:'x'} as never),false)
 assert.equal(oauthAllowlistBlocked({kind:'none'} as never),false)
 const blocked=cards([{entry:connector(allowlist),artifact:null,addedContentId:null}])
 assert.match(blocked,/此连接需要厂商审核，当前版本暂不支持（等待白名单获批）。/)
 assert.doesNotMatch(blocked,/<button[^>]*>连接</)
 const open=cards([{entry:connector(userClient),artifact:null,addedContentId:null}])
 assert.match(open,/<button[^>]*>连接</)
 assert.doesNotMatch(open,/此连接需要厂商审核/)
})

const {roleEntry,modelEntry}=await import('./market-catalog-fixture.ts')
const roleItem=(patch:Record<string,unknown>={})=>({entry:roleEntry(),artifact:{files:[{path:'role.json',sha256:'d'.repeat(64),size:9}],treeHash:'e'.repeat(64)},addedContentId:null,...patch}) as never
const modelItem=()=>({entry:modelEntry(),artifact:null,addedContentId:null}) as never

test('role 卡：徽标、来源方案、所需技能、「创建为同事」按钮；模型卡：徽标、国内可达、价格档、「去配置」按钮而非添加',()=>{
 const role=cards([roleItem()])
 assert.match(role,/AI 员工/);assert.match(role,/来自方案 test-sol@1\.0\.0/);assert.match(role,/所需技能：tool-a/);assert.match(role,/可在市场添加，或加载所属方案/);assert.match(role,/<button[^>]*>创建为员工/)
 assert.doesNotMatch(role,/添加到我的技能|添加方案/)
 const model=cards([modelItem()],{openModels:()=>{}})
 assert.match(model,/国内直连/);assert.match(model,/价格：低/);assert.match(model,/<button[^>]*>去配置/);assert.doesNotMatch(model,/<button[^>]*>添加/)
 assert.doesNotMatch(model,/sk-|API_KEY|密钥：|<input/)
 const restricted=cards([{artifact:null,addedContentId:null,entry:{...modelEntry(),model:{...modelEntry().model,license:{...modelEntry().model.license,tier:'restricted',restrictions:[{'zh-CN':'需署名',en:'Attribution'}]}}}} as never])
 assert.match(restricted,/许可有附加条款[\s\S]*需署名/)
 assert.doesNotMatch(role+model,/工作空间|单空间|实例|投影|尚未加载|内容待读取|人类/)
})

test('role 卡已添加回执：created 显示「已创建，默认暂停」，existing 显示「已添加」，都可查看',()=>{
 const created=cards([roleItem()],{roleReceipts:{'teloa.role.test-role':{roleId:'r1',status:'created'}},openRole:()=>{}})
 assert.match(created,/已创建，默认暂停[\s\S]*<button[^>]*>查看/);assert.doesNotMatch(created,/创建为员工/)
 const existing=cards([roleItem()],{roleReceipts:{'teloa.role.test-role':{roleId:'r1',status:'existing'}},openRole:()=>{}})
 assert.match(existing,/已添加[\s\S]*<button[^>]*>查看/)
})

test('搜索命中 roleId / modelId；kinds 过滤 role 与 model；newerApp>0 时区块底部恰一行提示',async()=>{
 assert.equal(marketCatalogMatches(roleItem(),'test-role'),true);assert.equal(marketCatalogMatches(modelItem(),'test-model'),true);assert.equal(marketCatalogMatches(modelItem(),'test-role'),false)
 const items=[item(),roleItem(),modelItem()]
 assert.deepEqual(marketCatalogVisible(items,'',['role']).map((row:{entry:{id:string}})=>row.entry.id),['teloa.role.test-role'])
 assert.deepEqual(marketCatalogVisible(items,'',['model']).map((row:{entry:{id:string}})=>row.entry.id),['teloa.model.test-model'])
 const listing={catalogVersion:'2026.9.25',items:[roleItem()],nextCursor:null,counts:{solution:0,role:1,skill:0,connector:0,model:0},skipped:{unknownKind:2,newerApp:3}}
 const api={list:async()=>listing,add:async()=>({contentId:'x'}),addRole:async()=>({roleId:'x',status:'created',skills:[]})}
 const html=render(createElement(MarketCatalogSection,{api,query:'',openContent:()=>{},kinds:['role']} as never))
 // 首屏为「读取中」（effect 不在 SSR 跑），提示行的渲染逻辑用纯函数单测：
 const {catalogSkippedHint}=await import('../lib/types/client/MarketCatalogSection.js') as {catalogSkippedHint:(skipped:{unknownKind:number;newerApp:number})=>number|null}
 assert.equal(catalogSkippedHint(listing.skipped),3);assert.equal(catalogSkippedHint({unknownKind:5,newerApp:0}),null)
 assert.match(html,/正在读取官方目录/)
})

test('功能验证 审查：role 列表带 addedRoleId 时首屏即显示「已添加」并可查看同一岗位；非 role 忽略',()=>{
 const html=cards([roleItem({addedRoleId:'44444444-4444-4444-8444-444444444444'})],{openRole:()=>{}})
 assert.match(html,/已添加[\s\S]*<button[^>]*>查看/);assert.doesNotMatch(html,/创建为员工/)
 assert.match(cards([roleItem({addedRoleId:null})]),/<button[^>]*>创建为员工/)
})

test('功能验证 审查：模型许可层级译为「可商用 / 有附加限制」，不露英文枚举值；两态词条多语言齐全（契约不收 non-commercial，不留死词条）',()=>{
 const zh=cards([modelItem()]),en=cards([modelItem()],{},'en')
 assert.match(zh,/可商用/);assert.doesNotMatch(zh,/· commercial</)
 assert.match(en,/Commercial use allowed/)
 const restricted=cards([{artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null,entry:{...modelEntry(),model:{...modelEntry().model,license:{...modelEntry().model.license,tier:'restricted',restrictions:[]}}}} as never])
 assert.match(restricted,/有附加限制/)
 for(const key of ['modelTierCommercial','modelTierRestricted'])for(const locale of ['zh-CN','en','ja','de'] as const)assert.notEqual(translateMessage(locale,('market.catalog.official.'+key) as never),'market.catalog.official.'+key)
 assert.equal(translateMessage('zh-CN','market.catalog.official.modelTierNonCommercial' as never),'market.catalog.official.modelTierNonCommercial')
})

test('功能验证 审查：newerApp 提示只在市场首页（不限 kinds）显示；带 kinds 的类别页不显示',async()=>{
 const {catalogSkippedHint}=await import('../lib/types/client/MarketCatalogSection.js') as {catalogSkippedHint:(skipped:{unknownKind:number;newerApp:number},kinds?:readonly string[])=>number|null}
 assert.equal(catalogSkippedHint({unknownKind:0,newerApp:2}),2)
 assert.equal(catalogSkippedHint({unknownKind:0,newerApp:2},['model']),null)
})

test('功能验证 审查：筛选词表为空时不渲染只剩「全部 0」的筛选行',()=>{
 const api={list:async()=>{throw Error('unused')},add:async()=>({contentId:'x'}),addRole:async()=>({roleId:'x',status:'created',skills:[]})}
 const html=render(createElement(MarketCatalogSection,{api,query:'',openContent:()=>{},kinds:['model']} as never))
 assert.doesNotMatch(html,/role="group" aria-label="(行业筛选|功能筛选)/)
 assert.doesNotMatch(html,/全部<span>0<\/span>/)
})

test('M1：scope 不受限的 OAuth 连接器（如 Supabase 远程）卡片显著提示「令牌为全权限，只读依赖服务端参数」；限定 scope 的不提示',async()=>{
 const {oauthFullAccessToken}=await import('../lib/types/client/MarketCatalogSection.js')
 const connector=(auth:Record<string,unknown>)=>({entry:{format:'teloa.market-catalog-entry/v1',id:'teloa.mcp-supabase-remote',kind:'connector',delivery:'managed',version:'1.0.0',taxonomy:{functions:['dev-tools'],industries:['general']},upstream:null,
  connector:{serverName:'supabase_remote',title:{'zh-CN':'Supabase 远程','en':'Supabase Remote'},summary:{'zh-CN':'远程','en':'Remote'},auth,recipe:{transport:'streamable-http',url:'https://mcp.supabase.com/mcp?read_only=true'},tools:[],upstreamUrl:'https://supabase.com/'},
  modifications:[],license:{spdx:'MIT',files:['LICENSE']},compatibility:{status:'needs-configuration',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},requires:{tools:[],network:true,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-26',reviewer:'Teloa'}},artifact:null,addedContentId:null})
 assert.equal(oauthFullAccessToken({kind:'oauth',supported:true,scopes:[]} as never),true)
 assert.equal(oauthFullAccessToken({kind:'oauth',supported:true,scopes:['mcp']} as never),false)
 assert.equal(oauthFullAccessToken({kind:'oauth',supported:false,reason:'x'} as never),false)
 assert.equal(oauthFullAccessToken({kind:'none'} as never),false)
 const full=cards([connector({kind:'oauth',supported:true,scopes:[]})])
 assert.match(full,/<p[^>]*role="note"[^>]*>令牌为全权限[^<]*只读仅依赖服务端参数/)
 assert.match(cards([connector({kind:'oauth',supported:true,scopes:[]})],{},'en'),/Full-access token/)
 assert.doesNotMatch(cards([connector({kind:'oauth',supported:true,scopes:['mcp']})]),/令牌为全权限/)
 for(const locale of ['zh-CN','en','ja','de'] as const)assert.notEqual(translateMessage(locale,'market.catalog.connector.oauthFullAccess' as never),'market.catalog.connector.oauthFullAccess')
})

test('终审 Minor：unsupported 的 AI 同事卡不渲染「创建为同事」，改显示第一条 condition；已添加回执照常可查看',()=>{
 const unsupported=(patch:Record<string,unknown>={})=>roleItem({...patch,entry:{...roleEntry(),compatibility:{...roleEntry().compatibility,status:'unsupported',conditions:[{'zh-CN':'需要新版 Teloa',en:'Requires newer Teloa'}]}}})
 const html=cards([unsupported()],{addRole:()=>{}})
 assert.doesNotMatch(html,/<button[^>]*>创建为员工/);assert.match(html,/需要新版 Teloa/)
 assert.match(cards([unsupported({addedRoleId:'44444444-4444-4444-8444-444444444444'})],{openRole:()=>{}}),/<button[^>]*>查看/)
})

test('unsupported 条目没写 conditions：技能卡与 AI 同事卡都显示兜底文案，不留空白操作区',()=>{
 const skill=cards([upstreamItem({compatibility:{status:'unsupported',teloa:'>=0.2.0',dsh:'any',conditions:[]}})])
 assert.doesNotMatch(skill,/<button[^>]*>添加到我的技能/);assert.match(skill,/<span>当前版本暂不支持添加<\/span>/)
 const role=cards([roleItem({entry:{...roleEntry(),compatibility:{...roleEntry().compatibility,status:'unsupported',conditions:[]}}})],{addRole:()=>{}},'en')
 assert.doesNotMatch(role,/<button[^>]*>Create teammate/);assert.match(role,/<span>Not available to add in this version<\/span>/)
})

test('终审 Minor：模型条目 baseURL 无法解析时来源详情显示原文，不抛错',()=>{
 const entry=modelEntry(),bad={...entry,model:{...entry.model,cloud:{...entry.model.cloud,provider:{kind:'custom',api:'openai-completions',baseURL:'https://[bad'}}}}
 const html=cards([{artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null,entry:bad} as never])
 assert.match(html,/https:\/\/\[bad/)
})

test('终审 Minor：市场打开 AI 同事时读取岗位失败由 loadRoles 自己落错误提示，不留未处理的拒绝，也不挂永不触发的 catch',async()=>{
 const {readFile}=await import('node:fs/promises')
 const source=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 // loadRoles 吞掉读取失败并写进 roleLoadError（同事页显示），因此它永不拒绝；actions.openRole 是同步 reducer，也不抛。
 assert.match(source,/const loadRoles=async\(\)=>\{setRoleLoading\(true\);setRoleLoadError\(undefined\);try\{mergeRoles\(await roleApi\.list\(\)\);setRoleDirectoryKnown\(true\)\}catch\(error\)\{setRoleLoadError\(localizeWorkError\(locale,error\)\)\}finally\{setRoleLoading\(false\)\}\}/)
 // 后面再接的 catch 永远走不到，还会把真实错误覆盖成「岗位已不存在」的误导文案。
 assert.match(source,/openRole=\{roleId=>\{void loadRoles\(\)\.then\(\(\)=>actions\.openRole\(roleId\)\)\}\}/)
})

test('Teloa 内置技能（无上游）的元信息用专用词条「Teloa 内置 · 许可」，不借用筛选按钮的「Teloa 官方」',()=>{
 const builtin=item({},{id:'teloa.dashboard-designer',delivery:'builtin',upstream:null,skill:{...catalogEntry().skill,name:'teloa-dashboard-designer'}})
 const html=cards([builtin])
 assert.match(html,/Teloa 内置 · 许可 Apache-2.0/)
 assert.doesNotMatch(html,/<p[^>]*>Teloa 官方<\/p>/)
 assert.match(cards([builtin],{},'en'),/Built into Teloa · License Apache-2.0/)
})

test('安装量：徽标只在榜单有数时显示；安装量按累计排、热门按近 7 日排，同值保持原序',async()=>{
 const {sortCatalogItems}=await import('../lib/types/client/MarketCatalogSection.js') as {sortCatalogItems:(items:unknown[],ranking:ReadonlyMap<string,{installs:number;recent:number}>,sort:string)=>{entry:{id:string}}[]}
 const a=item({},{id:'a.one'}),b=item({},{id:'b.two'}),c=item({},{id:'c.three'})
 const ranking=new Map([['a.one',{installs:5,recent:0}],['b.two',{installs:2,recent:3}]])
 const ids=(sort:string,items=[a,b,c],map:ReadonlyMap<string,{installs:number;recent:number}>=ranking)=>sortCatalogItems(items,map,sort).map(row=>row.entry.id)
 assert.deepEqual(ids('default'),['a.one','b.two','c.three'])
 assert.deepEqual(ids('installs',[c,b,a]),['a.one','b.two','c.three'])
 assert.deepEqual(ids('popular'),['b.two','a.one','c.three'])
 assert.deepEqual(ids('installs',[c,b,a],new Map()),['c.three','b.two','a.one'])
 assert.match(cards([a],{ranking}),/安装量 5/)
 assert.doesNotMatch(cards([c],{ranking}),/安装量/)
 assert.match(cards([a],{ranking},'en'),/Installs 5/)
 // 标签 + 数字，不涉及复数；数字按当前语言格式化
 const big=new Map([['a.one',{installs:12345,recent:0}]])
 assert.match(cards([a],{ranking:big}),/安装量 12,345/)
 assert.match(cards([a],{ranking:big},'en'),/Installs 12,345/)
})

test('排序行显示条件：当前类别至少一个条目有安装量才显示；模型条目不计，模型类别永不显示',async()=>{
 const {catalogSortVisible}=await import('../lib/types/client/MarketCatalogSection.js') as {catalogSortVisible:(items:unknown[],ranking:ReadonlyMap<string,{installs:number;recent:number}>)=>boolean}
 const a=item({},{id:'a.one'}),b=item({},{id:'b.two'})
 const model=item({},{id:'teloa.model.m',kind:'model'})
 assert.equal(catalogSortVisible([a,b],new Map([['a.one',{installs:1,recent:0}]])),true)
 assert.equal(catalogSortVisible([b],new Map([['a.one',{installs:1,recent:0}]])),false)
 assert.equal(catalogSortVisible([a],new Map([['a.one',{installs:0,recent:0}]])),false)
 assert.equal(catalogSortVisible([model],new Map([['teloa.model.m',{installs:9,recent:9}]])),false)
 assert.equal(catalogSortVisible([a,b],new Map()),false)
})

// 宿主目录快照 + 上游索引 + 榜单过滤 + 目录端点 + 应用接口的真实链路在 harness-dsh/tests/market-ranking.test.ts（客户端包不引入 backend/宿主源码）
test('ClawHub 来源：上游条目有安装量时出现排序行，卡片按语言格式化显示 Teloa 安装量',()=>{
 const upstream=upstreamItem()
 const id=(upstream as unknown as {entry:{id:string}}).entry.id
 const ranking=new Map([[id,{installs:1234,recent:2}]])
 const visible=marketCatalogVisible([upstream],'')
 assert.equal(visible.length,1)
 assert.equal(catalogSortVisible(visible,ranking),true,'ClawHub 来源下出现排序行')
 assert.match(cards(visible,{ranking}),/安装量 1,234/)
})

test('上游卡片只显示一个数字：Teloa 安装量；来源市场的安装数不显示，只保留来源标签',()=>{
 const upstream=upstreamItem({origin:{marketplace:'clawhub',installs:12300,installsLabel:'1.2 万',countedAt:'2026-09-25'}})
 const html=cards([upstream],{ranking:new Map([['clawhub.byungkyu.gmail',{installs:4,recent:1}]])})
 assert.match(html,/安装量 4/)
 assert.doesNotMatch(html,/1\.2 万/)
 assert.match(html,/byungkyu/)
})

test('本机模型卡展示变体、内存建议与本地模型入口，不混入云端价格或配置入口',async()=>{
 const {readFile}=await import('node:fs/promises')
 const entry=JSON.parse(await readFile(new URL('../../../../tests/fixtures/public-market/catalog/models/teloa.model.local.qwen3.json',import.meta.url),'utf8'))
 const html=cards([{entry,artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null} as never],{openLocalModels:()=>{},openModels:()=>{}})
 assert.match(html,/本机运行/);assert.match(html,/实验/);assert.match(html,/qwen3:4b/);assert.match(html,new RegExp(`最低 ${entry.model.variants[0].hardware.minRamGb} GB`));assert.match(html,/去本地模型/)
 assert.doesNotMatch(html,/价格：|>去配置<|国内直连/)
})

test('本地语音卡片走原生准备面，不显示云端密钥、聊天配置或价格',async()=>{
 const {readFile}=await import('node:fs/promises')
 const entry=JSON.parse(await readFile(new URL('../../../../tests/fixtures/public-market/catalog/models/teloa.model.sensevoice.json',import.meta.url),'utf8'))
 const local={entry,artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null}
 assert.equal(marketCatalogMatches(local,'sensevoice-local'),true)
 const html=cards([local],{openModels:()=>{},openLocalModel:()=>{}})
 assert.match(html,/本地语音/);assert.match(html,/准备本地语音/);assert.match(html,/<button[^>]*>准备本地语音/)
 assert.doesNotMatch(html,/去配置|API 密钥|价格：/)
 const unsupported={...local,entry:{...entry,compatibility:{...entry.compatibility,status:'unsupported'}}}
 assert.doesNotMatch(cards([unsupported],{openLocalModel:()=>{}}),/<button[^>]*>准备本地语音/)
})

test('embedding 入口与语音分流：卡片无语音标签，搜索识别 embedding',async()=>{
 const {readFile}=await import('node:fs/promises')
 const speech=JSON.parse(await readFile(new URL('../../../../tests/fixtures/public-market/catalog/models/teloa.model.sensevoice.json',import.meta.url),'utf8'))
 // 只借用通用卡片夹具，模型标识与安装事实不取市场副本。
 const entry={...speech,id:'fixture.embedding',model:{...speech.model,title:{'zh-CN':'检索验收模型',en:'Retrieval fixture'},usage:['embedding'],native:{kind:'teloa-embedding',providerId:'fixture-embedding'}}}
 const row={entry,artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null}
 assert.equal(marketCatalogMatches(row,'embedding'),true)
 const html=cards([row],{openLocalModel:()=>{throw Error('不应调用语音')},openRetrievalModel:()=>{}})
 assert.match(html,/<button[^>]*>准备检索模型/)
 assert.doesNotMatch(html,/>本地语音<|在设置中启用「语音输入」|>准备本地语音</)
 assert.doesNotMatch(cards([row],{openLocalModel:()=>{}}),/<button[^>]*>准备本地语音/)
})

// ---- 二次开发资源（规格 §7.3）----
const {derivativeEntry}=await import('./market-catalog-fixture.ts')
const {navigationSkill}=await import('./market-navigation-fixture.ts')
const derivativeItem=()=>({entry:derivativeEntry(),artifact,addedContentId:null,addedRoleId:null,secretGroup:null}) as never
const githubUpstreamItem=(origin:Record<string,unknown>={})=>{
 const entry=navigationSkill() as unknown as Record<string,any>
 entry.id='codex.frontend-design';entry.license={spdx:'MIT',files:[]};entry.compatibility={...entry.compatibility,status:'content-only'};entry.alternatives=[]
 entry.origin={...entry.origin,...origin}
 return {entry,artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null} as never
}
/** 改动前（04a1af20）旧式 install 条目整卡渲染；新增「问题反馈」按钮之外必须逐字节一致。 */
const legacyBefore={zh:"<ul class=\"list\"><li class=\"card\" data-teloa-catalog-entry=\"anthropic.internal-comms\"><div class=\"top\"><h3 class=\"name\">内部沟通稿</h3><span class=\"badge\">只有说明，不含程序</span></div><p class=\"summary\">起草周报与简讯。</p><p class=\"meta\">原作者 Anthropic · 许可 Apache-2.0</p><div class=\"actions\"><button type=\"button\" class=\"primary\">添加到我的技能</button></div><details class=\"details\"><summary>来源与许可</summary><p><a href=\"https://github.com/anthropics/skills/tree/33375500bcea98d610eb30ce10ac4e59b89c390d/skills/internal-comms\" target=\"_blank\" rel=\"noreferrer\">在 GitHub 查看原始来源</a> · 原始来源提交 33375500bcea</p><p>相对原版的修改</p><ul><li>改写了示例</li></ul><p>不需要额外工具 · 不需要联网</p><p>审核日期 2026-09-25</p><p class=\"mono\">anthropic.internal-comms@1.0.0 · 33375500bcea98d610eb30ce10ac4e59b89c390d</p></details></li></ul>",en:"<ul class=\"list\"><li class=\"card\" data-teloa-catalog-entry=\"anthropic.internal-comms\"><div class=\"top\"><h3 class=\"name\">Internal communications</h3><span class=\"badge\">Instructions only, no code</span></div><p class=\"summary\">Drafts reports.</p><p class=\"meta\">Original author Anthropic · License Apache-2.0</p><div class=\"actions\"><button type=\"button\" class=\"primary\">Add to my skills</button></div><details class=\"details\"><summary>Source and license</summary><p><a href=\"https://github.com/anthropics/skills/tree/33375500bcea98d610eb30ce10ac4e59b89c390d/skills/internal-comms\" target=\"_blank\" rel=\"noreferrer\">View the original source on GitHub</a> · Original source commit 33375500bcea</p><p>Changes from the original</p><ul><li>Rewrote the example</li></ul><p>No extra tools needed · No network access needed</p><p>Reviewed on 2026-09-25</p><p class=\"mono\">anthropic.internal-comms@1.0.0 · 33375500bcea98d610eb30ce10ac4e59b89c390d</p></details></li></ul>"}
const withoutFeedback=(html:string)=>html.replace(/<p><button type="button" aria-haspopup="dialog">[^<]*<\/button><\/p>/g,'')

test('二次开发条目：来源行写「二次开发自 …」，来源详情是分组修改清单，不再平铺「相对原版的修改」',()=>{
 const html=cards([derivativeItem()])
 assert.match(html,/<p class="meta">二次开发自 Anthropic（anthropics\/skills） · 许可 Apache-2.0<\/p>/)
 assert.doesNotMatch(html,/原作者 Anthropic/);assert.doesNotMatch(html,/相对原版的修改/);assert.doesNotMatch(html,/原样收录，未做修改/)
 assert.match(html,/修改清单（5 项）/);assert.match(html,/<summary>安全修复（2）<\/summary>/);assert.match(html,/其余 1 个文件与原版一致（已校验）/)
 assert.match(html,/href="https:\/\/github.com\/anthropics\/skills\/blob\/33375500bcea98d610eb30ce10ac4e59b89c390d\/skills\/internal-comms\/SKILL.md"/)
 assert.doesNotMatch(html,/与原版一致（锁定版本，已校验）/,'二次开发条目不写「与原版一致」')
 assert.match(cards([derivativeItem()],{},'en'),/Derived from Anthropic \(anthropics\/skills\) · License Apache-2.0/)
})

test('旧式条目（无 derivation）渲染与改动前一致，只多一个「问题反馈」按钮',()=>{
 const legacy=item({},{modifications:[{'zh-CN':'改写了示例','en':'Rewrote the example'}]})
 const zh=cards([legacy]),en=cards([legacy],{},'en')
 assert.equal(withoutFeedback(zh),legacyBefore.zh);assert.equal(withoutFeedback(en),legacyBefore.en)
 assert.notEqual(zh,legacyBefore.zh,'问题反馈按钮存在')
})

test('原版条目来源行追加「与原版一致（锁定版本，已校验）」：ClawHub 与 GitHub 都有，旧式与内置条目没有',()=>{
 assert.match(cards([upstreamItem()]),/<p class="meta">ClawHub · byungkyu · 与原版一致（锁定版本，已校验）<\/p>/)
 assert.match(cards([githubUpstreamItem()]),/<p class="meta">GitHub · example\/skills · 与原版一致（锁定版本，已校验）<\/p>/)
 assert.match(cards([githubUpstreamItem()],{},'en'),/GitHub · example\/skills · Matches the original \(locked version, verified\)/)
 assert.doesNotMatch(cards([item()]),/与原版一致/)
})

test('安装量来源：原版条目在来源详情写原始来源的安装量、来源站点、抓取日期与口径；卡片顶部仍只有 Teloa 安装量',()=>{
 const source={url:'https://skills.sh/anthropics/skills/frontend-design',scope:'plugin'}
 const withSource=githubUpstreamItem({marketplace:'claude-code',installs:12300,installsLabel:'1.2 万',countedAt:'2026-09-20',installsSource:source})
 const html=cards([withSource],{ranking:new Map([['codex.frontend-design',{installs:4,recent:1}]])})
 assert.match(html,/<div class="top">.*安装量 4.*<\/div>/);assert.doesNotMatch(html.match(/<div class="top">.*?<\/div>/)![0],/12,300/)
 assert.match(html,/原始来源安装量 12,300 · <a href="https:\/\/skills.sh\/anthropics\/skills\/frontend-design" target="_blank" rel="noreferrer">安装量来自 skills.sh，2026-09-20 抓取（按所在整包统计）<\/a>/)
 assert.doesNotMatch(html,/1\.2 万/)
 const resource=cards([githubUpstreamItem({marketplace:'claude-code',installs:800,installsLabel:'800',countedAt:'2026-09-20',installsSource:{...source,scope:'resource'}})],{},'en')
 assert.match(resource,/Installs at the original source: 800 · <a [^>]*>Install count from skills.sh, retrieved 2026-09-20<\/a>/)
 assert.doesNotMatch(resource,/whole plugin/)
 assert.doesNotMatch(cards([upstreamItem({origin:{marketplace:'clawhub',installs:12300,installsLabel:'1.2 万',countedAt:'2026-09-25'}})]),/原始来源安装量|安装量来自/,'无来源地址的 ClawHub 数字仍不显示')
})

test('每个条目的来源详情末尾都有「问题反馈」按钮',async()=>{
 const {roleEntry,modelEntry}=await import('./market-catalog-fixture.ts')
 const {connectorEntry}=await import('./market-navigation-fixture.ts')
 const rows=[item(),derivativeItem(),upstreamItem(),githubUpstreamItem(),{entry:roleEntry(),artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null},{entry:modelEntry(),artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null},{entry:solutionEntry(),artifact,addedContentId:null,addedRoleId:null,secretGroup:null},{entry:connectorEntry(),artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null}]
 for(const row of rows){
  const html=cards([row as never])
  assert.match(html,/<p><button type="button" aria-haspopup="dialog">问题反馈<\/button><\/p><\/details>/,(row as {entry:{id:string}}).entry.id)
 }
 assert.match(cards([item()],{},'en'),/>Report a problem<\/button>/)
})

test('点「问题反馈」弹出带资源的反馈表单：send 收到 resource 与 appVersion；关闭再开沿用同一草稿',async()=>{
 const {mount,nodes}=await import('./market-component-harness.ts')
 ;(globalThis as {__TELOA_VERSION__?:string}).__TELOA_VERSION__='0.2.0-alpha.7'
 const form=()=>null
 const app=mount('MarketCatalogSection.tsx',{
  './TeloaFeedback.js':{TeloaFeedbackForm:form},
  './TeloaFeedbackClient.js':await import('../src/client/TeloaFeedbackClient.ts'),
  './market-catalog-api.js':await import('../lib/types/client/market-catalog-api.js'),
  './market-taxonomy-filter.js':await import('../lib/types/client/market-taxonomy-filter.js'),
 })
 const payloads:Record<string,unknown>[]=[]
 const receipt={stored:true,receiptId:'TF-0fc6a648-d1bf-4a69-9f3c-9342f9e5b6a7',notification:'sent'}
 const props={entry:derivativeEntry(),send:async(payload:Record<string,unknown>)=>{payloads.push(payload);return {ok:true,receipt}}}
 let tree=app.render('MarketResourceFeedback',props)
 assert.equal(nodes(tree).some(node=>node.type===form),false,'未点击时不弹出')
 const button=nodes(tree).find(node=>node.type==='button')!
 assert.deepEqual(button.children,['market.catalog.official.reportProblem']);assert.equal(button.props['aria-haspopup'],'dialog')
 button.props.onClick()
 tree=app.render('MarketResourceFeedback',props)
 const opened=nodes(tree).find(node=>node.type===form)!
 assert.equal(opened.props.resourceTitle,'Internal communications plus')
 const model=opened.props.model
 assert.deepEqual(model.resource,{entryId:'anthropic.internal-comms-plus',version:'1.1.0'})
 model.edit({message:'装好以后跑不起来'})
 opened.props.onClose()
 tree=app.render('MarketResourceFeedback',props)
 assert.equal(nodes(tree).some(node=>node.type===form),false,'关闭后不再显示')
 nodes(tree).find(node=>node.type==='button')!.props.onClick()
 tree=app.render('MarketResourceFeedback',props)
 const reopened=nodes(tree).find(node=>node.type===form)!
 assert.equal(reopened.props.model,model,'同一条目沿用同一模型');assert.equal(reopened.props.model.getSnapshot().draft.message,'装好以后跑不起来')
 await reopened.props.model.submit()
 assert.deepEqual(payloads[0]?.resource,{entryId:'anthropic.internal-comms-plus',version:'1.1.0'})
 assert.equal(payloads[0]?.appVersion,'0.2.0-alpha.7')
 // 其他条目各用各的模型；同一条目换了版本换新模型（资源版本不串）
 const other=app.render('MarketResourceFeedback',{...props,entry:catalogEntry()})
 nodes(other).find(node=>node.type==='button')!.props.onClick()
 const otherModel=nodes(app.render('MarketResourceFeedback',{...props,entry:catalogEntry()})).find(node=>node.type===form)!.props.model
 assert.notEqual(otherModel,model);assert.deepEqual(otherModel.resource,{entryId:'anthropic.internal-comms',version:'1.0.0'})
 const newer={...props,entry:{...derivativeEntry(),version:'1.2.0'}}
 nodes(app.render('MarketResourceFeedback',newer)).find(node=>node.type==='button')!.props.onClick()
 const newerModel=nodes(app.render('MarketResourceFeedback',newer)).find(node=>node.type===form)!.props.model
 assert.notEqual(newerModel,model);assert.deepEqual(newerModel.resource,{entryId:'anthropic.internal-comms-plus',version:'1.2.0'})
 // 带 send 替身的模型不进进程级缓存：同一条目改用默认发送时拿到的是另一个模型
 const plain={entry:{...derivativeEntry(),version:'1.2.0'}}
 nodes(app.render('MarketResourceFeedback',plain)).find(node=>node.type==='button')!.props.onClick()
 const plainModel=nodes(app.render('MarketResourceFeedback',plain)).find(node=>node.type===form)!.props.model
 assert.notEqual(plainModel,newerModel);assert.deepEqual(plainModel.resource,{entryId:'anthropic.internal-comms-plus',version:'1.2.0'})
 nodes(app.render('MarketResourceFeedback',plain)).find(node=>node.type==='button')!.props.onClick()
 assert.equal(nodes(app.render('MarketResourceFeedback',plain)).find(node=>node.type===form)!.props.model,plainModel,'默认发送的模型按条目 id 缓存')
})

// ---- 共享密钥组（规格 2026-09-28 D18）----
test('共享密钥组：卡片一行写与几个技能共用，来源详情按当前语言列出其余成员名（不含自身）并说明整组生效；组内只有自身或未分组时不显示',()=>{
 const title=(zh:string,en:string)=>({'zh-CN':zh,en})
 const group=(count:number)=>({id:'shared-demo',members:[
  {entryId:'anthropic.internal-comms',title:title('内部沟通稿','Internal comms')},
  {entryId:'clawhub.grp.x-search',title:title('X 搜索','X search')},
  {entryId:'clawhub.grp.y-search',title:title('Y 搜索','Y search')},
 ].slice(0,count)})
 const zh=cards([item({secretGroup:group(3)})])
 assert.match(zh,/与 2 个技能共用一组密钥/)
 assert.match(zh,/与以下技能共用一组密钥：X 搜索和Y 搜索</);assert.doesNotMatch(zh,/共用一组密钥：[^<]*内部沟通稿/)
 assert.match(zh,/在一处填写，组内技能都可使用；删除也作用于整组。/)
 const en=cards([item({secretGroup:group(2)})],{},'en')
 assert.match(en,/Shares one set of keys with 1 other skill</)
 assert.match(en,/Shares one set of keys with these skills: X search</)
 assert.match(en,/deleting them also applies to the whole group/)
 assert.match(cards([item({secretGroup:group(3)})],{},'en'),/with 2 other skills</)
 const upstream=cards([{...(githubUpstreamItem() as object),secretGroup:{id:'shared-demo',members:[...group(2).members,{entryId:'codex.frontend-design',title:title('前端设计','Frontend design')}]}}])
 assert.match(upstream,/与 2 个技能共用一组密钥/);assert.match(upstream,/与以下技能共用一组密钥：内部沟通稿和X 搜索</)
 for(const html of [cards([item({secretGroup:group(1)})]),cards([item({secretGroup:null})])])assert.doesNotMatch(html,/共用一组密钥/)
})
test('市场详情的资源标识行（.mono）在浅色与深色主题下对比度都满足 WCAG AA（≥4.5:1）',async()=>{
  const {readFileSync}=await import('node:fs')
  const {prototypeThemes}=await import('../src/brand/prototype-theme.ts')
  const tokens=readFileSync(new URL('../src/client/theme-tokens.module.css',import.meta.url),'utf8')
  const alias=Object.fromEntries([...tokens.matchAll(/(--teloa-[\w-]+):var\((--teloa-design-[\w-]+)\)/g)].map(match=>[match[1]!,match[2]!]))
  const rule=readFileSync(new URL('../src/client/MarketCatalogSection.module.css',import.meta.url),'utf8').match(/^\.mono\{([^}]*)\}/m)?.[1]
  const token=rule?.match(/(?:^|;)color:var\((--teloa-[\w-]+)\)/)?.[1]
  assert.ok(token&&alias[token],'.mono 文字颜色须取主题令牌')
  const luminance=(hex:string)=>{const [r,g,b]=[1,3,5].map(at=>parseInt(hex.slice(at,at+2),16)/255).map(value=>value<=0.03928?value/12.92:((value+0.055)/1.055)**2.4);return 0.2126*r!+0.7152*g!+0.0722*b!}
  const contrast=(a:string,b:string)=>{const [light,dark]=[luminance(a),luminance(b)].sort((x,y)=>y-x);return (light!+0.05)/(dark!+0.05)}
  for(const theme of ['light','dark'] as const){
    const color=prototypeThemes[theme][alias[token]!]!
    // 详情卡片底色为 surface，也可能叠在页面底色、浅底或悬停底色上
    for(const background of ['surface','bg','subtle','hover']){
      const ratio=contrast(color,prototypeThemes[theme]['--teloa-design-'+background]!)
      assert.ok(ratio>=4.5,`${theme} 主题 ${token} 在 ${background} 上对比度 ${ratio.toFixed(2)} 不足 4.5`)
    }
  }
})

test('官方方案卡片小字：宿主带了包含计数就写「包含：…」（与本机方案卡同一套摘要），没带时仍是状态与来源',async()=>{
 const {catalogListRow}=await import('../lib/types/client/MarketCatalogSection.js')
 const t=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params)
 const solutionItem=(contents?:Record<string,number>)=>({entry:solutionEntry(),artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null,...(contents?{contents}:{})}) as never
 const row=(value:unknown)=>catalogListRow(value as never,{t:t as never,locale:'zh-CN',number:(n:number)=>String(n),openEntry:()=>{}})
 assert.equal(row(solutionItem({role:2,knowledge:1,skill:7,'work-template':4,plan:1})).facts,'包含：2 位员工 · 7 项技能 · 1 份资料 ｜ 4 个任务模板')
 assert.equal(row(solutionItem({role:1,mcp:2})).facts,'包含：1 位员工 ｜ 2 个接入源')
 assert.equal(row(solutionItem()).facts,'只有说明，不含程序 · Teloa')
})
