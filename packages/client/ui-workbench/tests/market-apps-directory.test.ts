import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

registerHooks({
 resolve:(specifier,context,next)=>/\.(module\.css|svg|webp|png)$/.test(specifier)?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>/\.(svg|webp|png)$/.test(url)?{format:'module',shortCircuit:true,source:'export default '+JSON.stringify(url)}:url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
// 构建产物按运行时形状使用；用例只构造替身数据，不复制完整契约类型。
const presentation:any=await import('../lib/types/client/market-apps-presentation.js')
const {MarketAppsDirectoryView,MarketAppDetailView}:any=await import('../lib/types/client/MarketAppsDirectory.js')
const {resourceBrands}=await import('../lib/types/client/resource-icon-assets.js')
const {MARKET_APPS_MESSAGE_ROWS}=await import('../lib/types/client/i18n/locales/market-apps.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')
const {catalogEntry}=await import('./market-catalog-fixture.ts')

// 词条注册进产品词典前后都能渲染：产品词典没有的键回退到本专题词表（列序：简、繁、英）。
const columns={'zh-CN':1,en:3} as const
const runtime=(locale:'zh-CN'|'en')=>({t:(key:string,params?:Record<string,string|number>)=>{const own=MARKET_APPS_MESSAGE_ROWS.find((row:readonly string[])=>row[0]===key);const text=translateMessage(locale,key as never,params);return text!==key||!own?text:own[columns[locale]]!.replace(/\{(\w+)\}/g,(_:string,name:string)=>String(params?.[name]??'{'+name+'}'))},subscribe:()=>()=>{},getSnapshot:()=>({locale,dshLocale:locale==='en'?'en':'zh',revision:1})})
const render=(node:unknown,locale:'zh-CN'|'en'='zh-CN')=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime(locale) as never},node as never))

const text=(zh:string,en=zh)=>({'zh-CN':zh,en})
const connector=(id:string,patch:Record<string,unknown>={},connectorPatch:Record<string,unknown>={})=>({entry:{format:'teloa.market-catalog-entry/v1',id,kind:'connector',delivery:'managed',version:'1.0.0',upstream:null,taxonomy:{functions:['office-docs','communication'],industries:['general']},
 connector:{serverName:id.split('.').at(-1)!.replace(/[^a-z0-9_-]/gi,'_'),title:text('文档服务','Docs service'),summary:text('查找和整理团队文档。','Find and organize team docs.'),auth:{kind:'secret',vars:[]},recipe:{transport:'streamable-http',url:'https://mcp.example.test/mcp'},tools:[{name:'search_pages',description:text('搜索页面','Search pages'),readOnly:true},{name:'update_page',description:text('更新页面','Update page'),readOnly:false}],upstreamUrl:'https://github.com/example/docs-mcp',...connectorPatch},
 modifications:[],license:{spdx:'MIT',files:['LICENSE']},compatibility:{status:'needs-configuration',teloa:'>=0.2.0',dsh:'>=0.2.0',conditions:[]},requires:{tools:[],network:true,runtimes:[]},review:{status:'approved',reviewedAt:'2026-10-01',reviewer:'teloa'},...patch},artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null})
const skill=(id:string,commit='a'.repeat(40),patch:Record<string,unknown>={},title='写作方法')=>{const base=catalogEntry() as any;return {entry:{...base,id,skill:{...base.skill,name:id.split('.').at(-1),title:text(title,title),summary:text(title+'的工作方法',title+' method')},upstream:{...base.upstream,commit},...patch},artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null}}
const record=(catalogId:string,status:string,patch:Record<string,unknown>={})=>({id:'11111111-1111-4111-8111-'+String(Math.abs(catalogId.length*7919+status.length)).padStart(12,'0'),catalogId,serverName:'docs',status,createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T00:00:00.000Z',...patch})
const ready=(records:unknown[])=>({status:'ready',records})

test('行业安装按完整固定来源显示本地化资源名，原生名和安装身份保留且不借用同名来源',()=>{
 const contentId='11111111-1111-4111-8111-111111111111',loadId='22222222-2222-4222-8222-222222222222',instanceId='33333333-3333-4333-8333-333333333333'
 const source={kind:'industry-local',loadId,itemInstanceId:instanceId,contentId,contentHash:'a'.repeat(64),resourceId:'working-method',resourceVersion:'1.0.0'}
 const installation={id:'44444444-4444-4444-8444-444444444444',ownerId:'local:owner',source,bundleHash:'b'.repeat(64),native:{name:'competitor-watch-working-method-v1-3a5d8f',description:'原工作方法',bodyHash:'c'.repeat(64),modelInvocable:true,userInvocable:true},state:'installed',version:1,createdAt:'2026-10-16T00:00:00.000Z',updatedAt:'2026-10-16T00:00:00.000Z'}
 const resource={id:source.resourceId,kind:'skill',title:'竞品监测工作准则',localized:{title:{original:'竞品监测工作准则',defaultLocale:'zh-CN',locales:{'zh-CN':'竞品监测工作准则',en:'Competitor research method'}}},version:'1.0.0',required:true,source:{kind:'local',path:'skills/method/SKILL.md'}}
 const manifest={format:'teloa.business-package/v2',id:'competitor-team',title:'竞品团队',version:'1.0.0',domain:'general',scope:'general',description:'原团队',resources:[resource,{id:'lead',kind:'role',title:'研究员',version:'1.0.0',required:true,source:{kind:'local',path:'roles/lead.json'}}],relations:[],entrypoints:[]}
 const declared={id:'stored-'+contentId,manifest,source:{contentId,contentHash:source.contentHash}},load={id:loadId,ownerId:installation.ownerId,contentId,contentHash:source.contentHash,templateId:manifest.id,templateVersion:manifest.version,items:[{instanceId,localId:resource.id,kind:'skill',title:resource.title,version:resource.version}]}
 const input={items:[],connections:ready([]),installations:[installation],packages:[declared],loads:[load],locale:'zh-CN'}
 const installed=(value:unknown)=>presentation.appsDirectoryRows(value).find((row:any)=>row.kind==='installed-skill')
 assert.equal(installed(input).title,'竞品监测工作准则')
 assert.equal(installed({...input,locale:'en'}).title,'Competitor research method')
 assert.equal(installed(input).skills[0].title,'竞品监测工作准则')
 assert.equal(installed(input).nativeName,installation.native.name)
 assert.equal(installed(input).installationId,installation.id)
 assert.equal(installed(input).key,'installed:'+installation.id)
 for(const bad of [
  {...input,packages:[{...declared,source:{...declared.source,contentId:'55555555-5555-4555-8555-555555555555'}}]},
  {...input,packages:[{...declared,source:{...declared.source,contentHash:'d'.repeat(64)}}]},
  {...input,packages:[{...declared,manifest:{...manifest,resources:[{...resource,version:'2.0.0'}]}}]},
  {...input,loads:[{...load,ownerId:'another-owner'}]},
  {...input,loads:[{...load,items:[{...load.items[0],instanceId:'66666666-6666-4666-8666-666666666666'}]}]},
  {...input,loads:[]},
 ])assert.equal(installed(bad).title,installation.native.name,'来源不完整或不一致时保留原生名称，不按同名资源补标题')
 const atomic={...installation,id:'77777777-7777-4777-8777-777777777777',source:{kind:'atomic',contentId,contentHash:source.contentHash,resourceId:source.resourceId,resourceVersion:source.resourceVersion}}
 const rows=presentation.appsDirectoryRows({...input,installations:[installation,atomic]})
 assert.equal(rows.filter((row:any)=>row.kind==='installed-skill').length,1,'既有完全相同正文的安装折叠规则保持')
 const distinctAtomic={...atomic,native:{...atomic.native,bodyHash:'e'.repeat(64)}}
 const own=presentation.appsDirectoryRows({...input,installations:[installation,distinctAtomic]}).filter((row:any)=>row.kind==='installed-skill')
 assert.equal(own.length,2,'独立原子技能不隐藏')
 assert.equal(own.find((row:any)=>row.installationId===distinctAtomic.id).title,atomic.native.name)
})

test('本人已保存内容仅进我的应用，按内容身份保留同名来源并复用真实安装记录',()=>{
 const a={itemId:'stored-a',contentId:'11111111-1111-4111-8111-111111111111',contentHash:'a'.repeat(64),kind:'skill',title:'同名技能',summary:'原个人技能',version:'1.0.0',publisher:'本人'}
 const b={...a,itemId:'stored-b',contentId:'22222222-2222-4222-8222-222222222222'}
 const app={...a,itemId:'stored-app',contentId:'33333333-3333-4333-8333-333333333333',kind:'bundle',title:'原应用'}
 const installation={id:'44444444-4444-4444-8444-444444444444',ownerId:'local:owner',bundleHash:'c'.repeat(64),source:{kind:'atomic',contentId:a.contentId,contentHash:a.contentHash,resourceId:'same-name',resourceVersion:'1.0.0'},native:{name:'同名技能',bodyHash:'b'.repeat(64),description:'原文',modelInvocable:true,userInvocable:true},state:'installed',version:1,createdAt:'2026-10-14T00:00:00Z',updatedAt:'2026-10-14T00:00:00Z'}
 const originalIndustry={...installation,id:'55555555-5555-4555-8555-555555555555',source:{kind:'industry',loadId:'66666666-6666-4666-8666-666666666666',itemInstanceId:'77777777-7777-4777-8777-777777777777',contentId:app.contentId,contentHash:app.contentHash,resourceId:'meeting-summary',resourceVersion:'1.0.0'},native:{...installation.native,name:'meeting-summary'}}
 const input={items:[],connections:ready([]),storedContents:[a,b,app],installations:[installation,originalIndustry],locale:'zh-CN'}
 const rows=presentation.appsDirectoryRows(input)
 assert.deepEqual(presentation.filterAppsRows(rows,{query:'',category:'all',mine:false}),[])
 const own=presentation.filterAppsRows(rows,{query:'',category:'all',mine:true})
 assert.equal(own.length,4);assert.equal(own.filter((row:any)=>row.title==='同名技能').length,2)
 assert.deepEqual(presentation.appsRowAction(own.find((row:any)=>row.contentId===b.contentId)),{kind:'open-content',entryId:'stored:'+b.contentId,contentId:b.contentId})
 const atomicInstalled=own.find((row:any)=>row.installationId===installation.id)
 assert.equal(atomicInstalled.kind,'installed-skill');assert.equal(atomicInstalled.key,'installed:'+installation.id)
 assert.equal(presentation.appsRowStatus(atomicInstalled).key,'installed')
 assert.equal(presentation.appsRowStatus(own.find((row:any)=>row.contentId===b.contentId)).key,'saved-pending-install')
 assert.equal(presentation.appsRowStatus(own.find((row:any)=>row.contentId===app.contentId)).key,'saved','包内状态仍由原详情逐项核对，不虚称待安装')
 assert.ok(own.some((row:any)=>row.kind==='installed-skill'&&row.installationId===originalIndustry.id),'原行业安装行及分享身份保持')
 const unknown=presentation.appsDirectoryRows({...input,installations:[],installationsKnown:false})
 assert.equal(presentation.appsRowStatus(unknown.find((row:any)=>row.contentId===a.contentId)).key,'saved','安装目录未核回时不冒称未安装')
 const catalog={...skill('teloa.existing'),addedContentId:a.contentId}
 assert.equal(presentation.appsDirectoryRows({...input,items:[catalog]}).filter((row:any)=>row.contentId===a.contentId).length,0,'同一已添加官方内容仍用原目录行，不重复生成个人行')
})

test('连接器各成一个应用；同一上游仓库、提交与目录的多项技能才归为技能库，单项、不同提交或同仓库不同目录都不合并',()=>{
 const elsewhere=skill('anthropic.d');(elsewhere.entry as any).upstream={...(elsewhere.entry as any).upstream,path:'skills/other-pack'}
 const rows=presentation.appsDirectoryRows({items:[connector('teloa.mcp-docs'),skill('anthropic.a'),skill('anthropic.b'),skill('anthropic.c','b'.repeat(40)),elsewhere],connections:ready([]),locale:'zh-CN'})
 const app=rows.find((row:any)=>row.kind==='app')
 assert.equal(app.title,'文档服务');assert.deepEqual(app.categories,['office-docs','communication']);assert.equal(app.connectors.length,1);assert.deepEqual(app.skills,[])
 const library=rows.find((row:any)=>row.kind==='library')
 assert.deepEqual(library.skills.map((row:any)=>row.entryId),['anthropic.a','anthropic.b'])
 assert.equal(library.connectors.length,0)
 assert.equal(library.title,'internal-comms');assert.equal(library.source.label,'anthropics/skills')
 assert.deepEqual(rows.filter((row:any)=>row.kind==='skill').map((row:any)=>row.entryIds[0]),['anthropic.c','anthropic.d'],'不同提交或同仓库不同目录都不并入同一技能库')
 // 目录提供方统一为 Teloa；原始来源只取真实上游地址，不虚构原作者。
 assert.equal(app.publisher,'Teloa');assert.equal(library.publisher,'Teloa');assert.equal(app.source.url,'https://github.com/example/docs-mcp');assert.equal(app.source.label,'github.com/example/docs-mcp')
})

test('应用安装与账号连接分别取自真实连接记录；记录读不出时为未知而不是未连接',()=>{
 const state=(records:unknown[]|null)=>presentation.connectorState('teloa.mcp-docs',records===null?{status:'unavailable'}:ready(records))
 assert.deepEqual(state([]),{install:'not-added',connection:'not-connected'})
 assert.deepEqual(state([record('teloa.mcp-docs','saved')]).install,'added')
 assert.deepEqual(state([record('teloa.mcp-docs','saved')]).connection,'not-connected')
 assert.equal(state([record('teloa.mcp-docs','installing')]).install,'installing')
 assert.deepEqual([state([record('teloa.mcp-docs','error',{errorCode:'install-failed'})]).install,state([record('teloa.mcp-docs','error',{errorCode:'install-failed'})]).connection],['install-failed','not-connected'])
 assert.deepEqual([state([record('teloa.mcp-docs','error')]).install,state([record('teloa.mcp-docs','error')]).connection],['added','error'])
 assert.equal(state([record('teloa.mcp-docs','pending-oauth')]).connection,'pending-oauth')
 assert.equal(state([record('teloa.mcp-docs','saved'),record('teloa.mcp-docs','connected',{id:'22222222-2222-4222-8222-222222222222'})]).connection,'connected','同一应用多条记录取实际已连接的一条')
 assert.equal(state([record('teloa.mcp-other','connected')]).connection,'not-connected','只按目录条目身份匹配，不按服务名猜')
 assert.deepEqual(state(null),{install:'unknown',connection:'unknown'})
 const action=(item:unknown,records:unknown[]|null)=>presentation.appsRowAction(presentation.appsDirectoryRows({items:[item],connections:records===null?{status:'unavailable'}:ready(records),locale:'zh-CN'})[0]).kind
 assert.equal(action(connector('teloa.mcp-docs'),[]),'add-connector')
 assert.equal(action({...connector('teloa.mcp-docs'),addedContentId:'55555555-5555-4555-8555-555555555555'},[]),'open-connection','目录已添加但未建连接：直接进入连接设置，不重复添加')
 assert.equal(action(connector('teloa.mcp-docs'),[record('teloa.mcp-docs','connected')]),'open-connection')
 assert.equal(action(connector('teloa.mcp-docs'),null),'detail','连接状态未知时不贸然添加')
 assert.equal(action(connector('teloa.mcp-docs',{compatibility:{status:'unsupported',teloa:'>=0.2.0',dsh:'>=0.2.0',conditions:[]}}),[]),'detail')
})

test('统一搜索覆盖应用工具与技能，分类与「我的应用」按真实记录过滤；未对应目录的已安装技能单独列入我的',()=>{
 const installation={id:'33333333-3333-4333-8333-333333333333',ownerId:'owner',source:{kind:'atomic',contentId:'44444444-4444-4444-8444-444444444444',contentHash:'d'.repeat(64),resourceId:'skill',resourceVersion:'1.0.0'},bundleHash:'e'.repeat(64),native:{name:'local-notes',description:'本机整理笔记的方法',modelInvocable:true,userInvocable:true,bodyHash:'f'.repeat(64)},state:'installed',version:1,createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T00:00:00.000Z'}
 const added={...skill('anthropic.a'),addedContentId:'55555555-5555-4555-8555-555555555555'}
 const rows=presentation.appsDirectoryRows({items:[connector('teloa.mcp-docs'),connector('teloa.mcp-chat',{taxonomy:{functions:['communication'],industries:['general']}},{title:text('团队消息','Team chat'),tools:[]}),added],connections:ready([record('teloa.mcp-docs','connected')]),installations:[installation],locale:'zh-CN'})
 const titles=(view:Record<string,unknown>)=>presentation.filterAppsRows(rows,{query:'',category:'all',mine:false,...view}).map((row:any)=>row.title)
 assert.deepEqual(titles({query:'update_page'}),['文档服务'],'搜索覆盖应用的工具')
 assert.deepEqual(titles({query:'写作方法'}),['写作方法'],'搜索覆盖技能')
 assert.deepEqual(titles({category:'office-docs'}),['文档服务'])
 assert.deepEqual(titles({mine:true}).sort(),['local-notes','写作方法','文档服务'].sort())
 assert.equal(rows.find((row:any)=>row.title==='local-notes').kind,'installed-skill')
 assert.equal(rows.find((row:any)=>row.title==='local-notes').publisher,undefined,'本机安装的技能按原归属显示，不标成 Teloa 目录')
 assert.equal(rows.find((row:any)=>row.title==='写作方法').publisher,'Teloa');assert.equal(rows.find((row:any)=>row.title==='写作方法').source.label,'anthropics/skills','原始仓库保留在来源')
 assert.deepEqual(presentation.appsCategories(rows),['office-docs','communication'],'只列出官方目录里有内容的用途，顺序沿用目录用途表')
 assert.equal(titles({}).includes('local-notes'),false,'不在官方目录的本机技能只放「我的应用」，不进入浏览目录')
 assert.deepEqual(titles({query:'local-notes'}),[],'浏览搜索也不列出本机技能')
 assert.deepEqual(titles({mine:true,query:'local-notes'}),['local-notes'])
 assert.equal(presentation.appsSections(rows,{query:'',category:'all',mine:false},new Map()).flatMap((section:any)=>section.rows).some((row:any)=>row.kind==='installed-skill'),false,'本机技能退出推荐与用途分区')
})

test('我的应用：同一原技能的重复安装记录只显示一条并打开最近一次安装；不同正文或版本的同名技能各自保留，目录已对应的记录不另占一行',()=>{
 const installed=(id:string,patch:Record<string,unknown>={},native:Record<string,unknown>={},source:Record<string,unknown>={})=>({id,ownerId:'owner',source:{kind:'atomic',contentId:'44444444-4444-4444-8444-'+id.slice(-12),contentHash:'d'.repeat(64),resourceId:'product-idea-evidence-investigator',resourceVersion:'1.0.0',...source},bundleHash:'e'.repeat(64),native:{name:'product-idea-evidence-investigator-732352f6',description:'整理产品想法的证据',modelInvocable:true,userInvocable:true,bodyHash:'f'.repeat(64),...native},state:'installed',version:1,createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T00:00:00.000Z',...patch})
 const first=installed('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),repeat=installed('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',{updatedAt:'2026-10-14T01:00:00.000Z'})
 const newerBody=installed('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',{},{bodyHash:'1'.repeat(64)},{resourceVersion:'1.1.0'})
 const otherVersion=installed('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',{},{name:'ui-nl-summary'},{resourceId:'ui-nl-summary',resourceVersion:'2.0.0'}),otherVersionOld=installed('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',{},{name:'ui-nl-summary',bodyHash:'2'.repeat(64)},{resourceId:'ui-nl-summary',resourceVersion:'1.0.0'})
 const preparing=installed('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',{state:'preparing'})
 const rows=presentation.appsDirectoryRows({items:[],connections:ready([]),installations:[first,repeat,newerBody,otherVersion,otherVersionOld,preparing],locale:'zh-CN'})
 assert.deepEqual(rows.map((row:any)=>[row.kind,row.key]),[['installed-skill','installed:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'],['installed-skill','installed:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'],['installed-skill','installed:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'],['installed-skill','installed:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5']],'同一原技能两条记录折叠为一条并指向最近更新的安装；不同正文或版本各自保留；未完成的安装不列入')
 assert.equal(presentation.filterAppsRows(rows,{query:'',category:'all',mine:true}).length,4,'我的应用计数按折叠后的行计算')
 assert.equal(rows.filter((row:any)=>row.title==='product-idea-evidence-investigator-732352f6').length,2,'同名但正文与版本不同的技能不混成一条')
 // 目录条目已对应的安装记录由目录行表示，不再另起一行
 const added={...skill('anthropic.a'),addedContentId:'44444444-4444-4444-8444-aaaaaaaaaaa1'}
 const withCatalog=presentation.appsDirectoryRows({items:[added],connections:ready([]),installations:[first,repeat],locale:'zh-CN'})
 assert.deepEqual(withCatalog.map((row:any)=>row.kind),['skill','installed-skill'])
 assert.equal(withCatalog[0].skills[0].installed,true)
})

test('推荐只来自真实安装量榜单；没有榜单时不虚构推荐分区',()=>{
 const rows=presentation.appsDirectoryRows({items:[connector('teloa.mcp-docs'),connector('teloa.mcp-chat',{taxonomy:{functions:['communication'],industries:['general']}},{title:text('团队消息','Team chat')})],connections:ready([]),locale:'zh-CN'})
 const view={query:'',category:'all',mine:false}
 assert.equal(presentation.appsSections(rows,view,new Map()).some((section:any)=>section.id==='recommended'),false)
 const ranked=presentation.appsSections(rows,view,new Map([['teloa.mcp-chat',{installs:12,recent:3}]]))
 assert.equal(ranked[0].id,'recommended');assert.deepEqual(ranked[0].rows.map((row:any)=>row.title),['团队消息'])
 assert.deepEqual(presentation.appsSections(rows,{...view,query:'消息'},new Map()).map((section:any)=>section.id),['results'])
})

test('不含岗位且声明技能、连接或扩展任一项的真实包成为资源包；含岗位的包属于员工模板，连接按包内声明列出',()=>{
 const manifest=(resources:Array<[string,string]>)=>({format:'teloa.business-package/v2',id:'pkg',title:'资料整理包',version:'1.0.0',domain:'general',scope:'general',description:'整理资料并同步到文档。',resources:resources.map(([kind,id])=>({id,kind,title:id+' 标题',version:'1.0.0',required:true,source:{kind:'local',path:id}})),relations:[],entrypoints:[]})
 const rows=presentation.appsDirectoryRows({items:[],connections:ready([]),locale:'zh-CN',packages:[{id:'bundle',manifest:manifest([['skill','s1'],['skill','s2'],['mcp','m1']])},{id:'team',manifest:manifest([['role','r1'],['skill','s1'],['mcp','m1']])},{id:'skills-only',manifest:manifest([['skill','s1']])},{id:'plugin-only',manifest:manifest([['plugin','p1']])},{id:'knowledge-only',manifest:manifest([['knowledge','k1']])}]})
 assert.deepEqual(rows.map((row:any)=>[row.kind,row.key]),[['bundle','package:bundle'],['bundle','package:skills-only'],['bundle','package:plugin-only']])
 assert.deepEqual(rows[0].connectors.map((row:any)=>row.title),['m1 标题']);assert.equal(rows[0].connectors[0].catalogId,undefined)
 assert.deepEqual(rows[0].skills.map((row:any)=>row.title),['s1 标题','s2 标题'])
 assert.deepEqual(rows[2].connectors.map((row:any)=>row.title),['p1 标题'])
})

test('目录行解析为单独能力分享来源：单技能按条目固定引用、单连接器按声明工具、组合为应用；本机安装技能与声明资源包不伪造来源',()=>{
 const rows=presentation.appsDirectoryRows({items:[connector('teloa.mcp-docs'),skill('anthropic.a'),skill('anthropic.b')],connections:ready([]),locale:'zh-CN',packages:[{id:'bundle',manifest:{format:'teloa.business-package/v2',id:'pkg',title:'包',version:'1.0.0',domain:'general',scope:'general',description:'说明',resources:[{id:'s1',kind:'skill',title:'s1',version:'1.0.0',required:true,source:{kind:'local',path:'s1.md'}}],relations:[],entrypoints:[]}}]})
 const byKind=(kind:string)=>rows.filter((row:any)=>row.kind===kind)
 const app=presentation.appsRowShareSource(byKind('app')[0])
 assert.equal(app.subject,'mcp');assert.equal(app.connections[0].serverName,byKind('app')[0].connectors[0].entry.connector.serverName);assert.ok(app.connections[0].tools.length>0)
 const library=byKind('library')[0]??byKind('skill')[0]
 const shared=presentation.appsRowShareSource(library)
 assert.ok(shared);assert.ok(shared.skills.every((row:any)=>row.publicId===row.resourceId&&/^\d+\.\d+\.\d+/.test(row.version)))
 // 目录 id 含点（anthropic.a），公共引用必须写原技能名，契约 localId 才能接受。
 assert.ok(shared.skills.every((row:any)=>!row.publicId.includes('.')&&library.skills.some((s:any)=>s.item.entry.skill.name===row.publicId&&s.item.entry.version===row.version)))
 assert.equal(shared.subject,shared.skills.length>1?'app':'skill')
 assert.equal(presentation.appsRowShareSource(byKind('bundle')[0]),undefined)
})

const directoryProps=(patch:Record<string,unknown>={})=>{
 const rows=presentation.appsDirectoryRows({items:[connector('teloa.mcp-docs'),skill('anthropic.a'),skill('anthropic.b')],connections:ready([record('teloa.mcp-docs','pending-oauth')]),locale:'zh-CN'})
 return {rows,ranking:new Map(),catalog:{status:'ready'},connections:ready([]),view:{query:'',category:'all',mine:false},onViewChange:()=>{},openRow:()=>{},runAction:()=>{},busy:undefined,errors:{},...patch}
}

test('需要厂商白名单的应用不提供添加或连接，已有真实连接仍可管理',()=>{
 const auth={kind:'oauth',supported:true,scopes:[],requiresAllowlist:true}
 const item=connector('teloa.mcp-figma',{}, {auth})
 for(const records of [[],[record('teloa.mcp-figma','saved')],[record('teloa.mcp-figma','pending-oauth')]]){
  const [row]=presentation.appsDirectoryRows({items:[item],connections:ready(records),locale:'zh-CN'})
  assert.equal(presentation.appsRowAction(row).kind,'detail','不能把厂商尚未开放的接入变成可添加或连接动作')
  assert.equal(presentation.appsRowStatus(row).key,'unsupported')
  for(const locale of ['zh-CN','en'] as const){
   const directory=render(createElement(MarketAppsDirectoryView,directoryProps({rows:[row]}) as never),locale)
   const detail=render(createElement(MarketAppDetailView,{row,close:()=>{},runAction:()=>{},busy:undefined,error:undefined} as never),locale)
   for(const html of [directory,detail])assert.doesNotMatch(html,/<button[^>]*>(?:添加|连接|Add|Connect)<\/button>/)
   assert.match(detail,locale==='en'?/The service must allow this app first/:/需服务方先允许本应用接入/)
  }
 }
 const [connected]=presentation.appsDirectoryRows({items:[item],connections:ready([record('teloa.mcp-figma','connected')]),locale:'zh-CN'})
 assert.equal(presentation.appsRowAction(connected).kind,'open-connection','已有连接的查看与管理入口保留')
 assert.equal(presentation.appsRowStatus(connected).key,'connected')
 for(const availableAuth of [{...auth,requiresAllowlist:false},{...auth,requiresUserClientId:true}]){
  const [available]=presentation.appsDirectoryRows({items:[connector('teloa.mcp-docs',{}, {auth:availableAuth})],connections:ready([]),locale:'zh-CN'})
  assert.equal(presentation.appsRowAction(available).kind,'add-connector','已开放及本人提供客户端身份的原授权流程保持')
 }
})

test('应用列表、我的应用与详情使用同一真实品牌图标；带说明的标题不影响品牌，自建同名技能不冒用品牌',()=>{
 for(const [server,brand] of [['github','github'],['notion_remote','notion'],['slack','slack'],['figma','figma'],['linear','linear'],['sentry','sentry']]){
  const [row]=presentation.appsDirectoryRows({items:[connector('teloa.mcp-'+server,{}, {serverName:server,title:text('服务（需要本人授权）','Service (authorize first)')})],connections:ready([record('teloa.mcp-'+server,'connected')]),locale:'zh-CN'})
  for(const mine of [false,true]){
   const html=render(createElement(MarketAppsDirectoryView,directoryProps({rows:[row],view:{query:'',category:'all',mine}}) as never))
   assert.equal(html.match(/<img[^>]+src="([^"]+)"/)?.[1],resourceBrands[brand as keyof typeof resourceBrands],'应用使用固定随包品牌工件，不依赖文件名')
  }
  const detail=render(createElement(MarketAppDetailView,{row,close:()=>{},runAction:()=>{},busy:undefined,error:undefined} as never))
  assert.equal(detail.match(/<img[^>]+src="([^"]+)"/)?.[1],resourceBrands[brand as keyof typeof resourceBrands],'详情与列表共用同一固定图标')
 }
 const local={key:'installed:local',kind:'installed-skill',title:'GitHub',summary:'自己创建的方法',categories:[],connectors:[],skills:[{title:'GitHub',summary:'自己创建的方法',added:true,installed:true,builtin:false}],entryIds:[],mine:true}
 const html=render(createElement(MarketAppsDirectoryView,directoryProps({rows:[local],view:{query:'',category:'all',mine:true}}) as never))
 assert.doesNotMatch(html,/<img/,'本机同名不冒用品牌');assert.match(html,/<svg/,'没有品牌时用能力类型图标，不用字母占位')
})

test('目录：统一搜索、用途分类、双列行与真实状态动作；应用安装记录只在宿主提供真实入口时出现',()=>{
 const html=render(createElement(MarketAppsDirectoryView,directoryProps() as never))
 assert.match(html,/<h2[^>]*>应用<\/h2>/);assert.match(html,/placeholder="在应用和技能中搜索"/)
 assert.match(html,/aria-pressed="true"[^>]*>全部</);assert.match(html,/>办公与文档</);assert.doesNotMatch(html,/>安全</,'没有内容的用途不出现')
 assert.match(html,/文档服务[\s\S]*待授权/);assert.match(html,/internal-comms[\s\S]*2 项技能 · 无需连接/)
 assert.match(html,/我的应用/)
 assert.doesNotMatch(html,/应用安装记录|AI 员工模板/,'没有真实入口时不渲染失效按钮')
 const full=render(createElement(MarketAppsDirectoryView,directoryProps({onManagePlugins:()=>{},onOpenTemplates:()=>{}}) as never))
 assert.match(full,/应用安装记录/);assert.doesNotMatch(full,/高级接入|你的扩展|自定义连接|扩展包/);assert.match(full,/AI 员工模板/)
 assert.doesNotMatch(full,/MCP|插件来源|演示|Grok/,'协议与来源不进目录主层，也不出现演示字样')
})

test('目录：读取中、读取失败、连接状态未知与无结果都有明确下一步；空态提供自然语言与导入入口',()=>{
 assert.match(render(createElement(MarketAppsDirectoryView,directoryProps({rows:[],catalog:{status:'loading'}}) as never)),/正在读取应用与技能…/)
 const failed=render(createElement(MarketAppsDirectoryView,directoryProps({rows:[],catalog:{status:'error',message:'网络中断'},retryCatalog:()=>{}}) as never))
 assert.match(failed,/暂时无法读取应用目录：网络中断/);assert.match(failed,/>重试</)
 assert.match(render(createElement(MarketAppsDirectoryView,directoryProps({connections:{status:'unavailable'},retryConnections:()=>{}}) as never)),/连接状态暂时无法读取[\s\S]*重新读取连接状态/)
 const empty=render(createElement(MarketAppsDirectoryView,directoryProps({view:{query:'不存在的服务',category:'all',mine:false},onDescribe:()=>{},onImportSkill:()=>{}}) as never))
 assert.match(empty,/没有找到匹配的应用或技能/);assert.match(empty,/用一句话描述需要的能力/);assert.match(empty,/导入技能/);assert.match(empty,/清除搜索/)
 assert.match(render(createElement(MarketAppsDirectoryView,directoryProps({view:{query:'',category:'all',mine:true},rows:[]}) as never)),/还没有添加应用或技能[\s\S]*查看全部/)
})

test('应用详情：应用、技能、信息三段，安装与连接分别显示；协议细节收在高级信息；连接不扩大员工授权',()=>{
 const [app]=presentation.appsDirectoryRows({items:[connector('teloa.mcp-docs')],connections:ready([record('teloa.mcp-docs','saved')]),locale:'zh-CN'})
 const html=render(createElement(MarketAppDetailView,{row:app,close:()=>{},runAction:()=>{},busy:undefined,error:undefined} as never))
 assert.match(html,/<h3[^>]*>文档服务<\/h3>/)
 assert.match(html,/<h3[^>]*>可用操作<\/h3>[\s\S]*搜索页面[\s\S]*更新页面/)
 assert.doesNotMatch(html,/<h3[^>]*>应用<\/h3>|<h3[^>]*>技能<\/h3>|此应用不附带技能/,'单应用不重复列自己，也不展示空的技能区块')
 assert.match(html,/<details[^>]*>[\s\S]*<summary>来源与权限<\/summary>/,'来源与权限按需展开，不占首屏')
 assert.match(html,/安装[\s\S]*已添加/);assert.match(html,/连接[\s\S]*未连接/);assert.match(html,/需要填写密钥/)
 assert.match(html,/员工使用这个应用仍需各自授权/)
 assert.match(html,/<details[\s\S]*高级信息[\s\S]*docs[\s\S]*streamable-http[\s\S]*search_pages[\s\S]*只读[\s\S]*update_page[\s\S]*可写/)
 assert.match(html,/href="https:\/\/github.com\/example\/docs-mcp"[^>]*rel="noreferrer"/)
 assert.match(html,/>设置连接</)
 assert.doesNotMatch(html,/开发者/,'没有真实开发者信息时不显示该字段')
})

test('技能库详情说明无需外部连接并逐项给出添加状态；英文界面使用英文文案',()=>{
 const rows=presentation.appsDirectoryRows({items:[{...skill('anthropic.a'),addedContentId:'55555555-5555-4555-8555-555555555555'},skill('anthropic.b')],connections:ready([]),locale:'en'})
 const library=rows.find((row:any)=>row.kind==='library')
 const html=render(createElement(MarketAppDetailView,{row:library,close:()=>{},runAction:()=>{},busy:undefined,error:undefined} as never),'en')
 assert.match(html,/No external account needed/);assert.match(html,/Added[\s\S]*Add/);assert.match(html,/<dt>Source<\/dt><dd><a href="https:\/\/github.com\/anthropics\/skills"[^>]*>anthropics\/skills<\/a><\/dd><dt>Publisher<\/dt><dd>Teloa<\/dd>/,'原始来源与目录提供方分列，不把 Teloa 写成原作者')
 for(const row of MARKET_APPS_MESSAGE_ROWS){assert.ok(row.length>=4);for(const value of row.slice(0,4))assert.ok(value.trim(),row[0]+' 简繁英定稿')}
})

test('动作沿用原目录端口：应用直接进原连接页、不发内容添加请求，技能先添加再进原内容页；添加失败不跳转，已添加不重复添加',async()=>{
 const {performAppsAction}:any=await import('../lib/types/client/MarketAppsDirectory.js')
 const calls:string[]=[]
 // 目录 add 按生产后端边界模拟：连接器不是内容，official-catalog.add 明确拒绝；只有技能走内容添加。
 const connectors=new Set(['teloa.mcp-docs'])
 const ports=(fail=false)=>({catalogApi:{add:async(id:string)=>{calls.push('add:'+id);if(connectors.has(id))throw Error('连接不能添加为内容，请用 teloa_mcp_connect 或 市场 > 连接 添加。');if(fail)throw Error('网络中断');return {contentId:'66666666-6666-4666-8666-666666666666'}}},openConnection:(id:string)=>{calls.push('connection:'+id)},openContent:(id:string)=>{calls.push('content:'+id)},openPackage:(id:string)=>{calls.push('package:'+id)}})
 const app=connector('teloa.mcp-docs').entry,item=skill('anthropic.a')
 assert.deepEqual(await performAppsAction({kind:'add-connector',entryId:'teloa.mcp-docs',entry:app},ports()),{})
 assert.deepEqual(calls.splice(0),['connection:teloa.mcp-docs'],'未添加的应用直接进原连接页，不调用目录内容添加')
 await performAppsAction({kind:'open-connection',entryId:'teloa.mcp-docs',entry:app},ports());assert.deepEqual(calls.splice(0),['connection:teloa.mcp-docs'])
 await performAppsAction({kind:'add-skill',entryId:'anthropic.a',item},ports());assert.deepEqual(calls.splice(0),['add:anthropic.a','content:66666666-6666-4666-8666-666666666666'])
 await performAppsAction({kind:'open-content',entryId:'anthropic.a',contentId:'55555555-5555-4555-8555-555555555555'},ports());assert.deepEqual(calls.splice(0),['content:55555555-5555-4555-8555-555555555555'])
 await performAppsAction({kind:'open-package',packageId:'bundle'},ports());assert.deepEqual(calls.splice(0),['package:bundle'])
 await assert.rejects(performAppsAction({kind:'add-skill',entryId:'anthropic.a',item},ports(true)),/网络中断/);assert.deepEqual(calls.splice(0),['add:anthropic.a'],'技能添加失败不跳转内容页')
 assert.deepEqual(await performAppsAction({kind:'detail'},ports()),{});assert.deepEqual(calls,[])
})

test('本专题词条通过全仓白话禁词表（简繁英），不在注册前留下禁词',async()=>{
 const {plainLanguageJargon}=await import('../../../../tests/plain-language-jargon.mjs')
 for(const row of MARKET_APPS_MESSAGE_ROWS){
  for(const [locale,index] of [['zh-CN',1],['zh-Hant',2],['en',3]] as const)assert.doesNotMatch(row[index],plainLanguageJargon[locale],locale+' '+row[0])
 }
})

// ─── 应用包：按目录声明的插件分组呈现一个应用，一次安装 ───────────────────────────
const packPlugin=(patch:Record<string,unknown>={})=>({marketplace:'cursor',id:'9717366',title:text('pstack','pstack'),summary:text('工程方法技能包','Engineering method pack'),root:'pstack',manifest:{path:'pstack/.cursor-plugin/plugin.json',gitBlob:'e'.repeat(40),sha256:'4'.repeat(64)},license:{spdx:'MIT'},connectors:[],...patch})
const packSkill=(name:string,patch:Record<string,unknown>={},item:Record<string,unknown>={})=>({entry:{format:'teloa.market-catalog-entry/v1',id:'cursor.pstack-'+name,kind:'skill',delivery:'upstream',version:'0.15.23',taxonomy:{functions:['dev-tools'],industries:['general']},skill:{name,title:text(name,name),summary:text(name+' 方法',name+' method')},
 upstream:{kind:'github',repository:{host:'github.com',owner:'cursor',repo:'plugins'},commit:'8'.repeat(40),path:'pstack/skills/'+name,files:[{path:'SKILL.md',gitBlob:'b'.repeat(40),sha256:'1'.repeat(64),size:1}]},origin:{marketplace:'cursor',installs:null,installsLabel:'未公开',countedAt:'2026-10-14'},alternatives:[],unsupportedComponents:[{kind:'commands',count:2},{kind:'hooks',count:1}],modifications:[],license:{spdx:'MIT',files:[]},
 compatibility:{status:'content-only',teloa:'>=0.2.0-alpha.8',dsh:'0.1.7-rc.1',conditions:[]},requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-10-14',reviewer:'teloa'},plugin:packPlugin(),...patch},artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null,...item})
const installedRecord=(contentId:string)=>({id:'99999999-9999-4999-8999-'+contentId.slice(-12),ownerId:'owner',source:{kind:'atomic',contentId,contentHash:'d'.repeat(64),resourceId:'x',resourceVersion:'0.15.23'},bundleHash:'e'.repeat(64),native:{name:'x',description:'x',modelInvocable:true,userInvocable:true,bodyHash:'f'.repeat(64)},state:'installed',version:2,createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T00:00:00.000Z'})

test('应用包：同一公开插件的技能（目录各不相同）按声明成为一个应用；没有声明的同仓技能不按路径或名称猜分组；连接只按精确条目标识关联',()=>{
 const loose={...skill('cursor.loose'),entry:{...skill('cursor.loose').entry,upstream:{kind:'github',repository:{host:'github.com',owner:'cursor',repo:'plugins'},commit:'8'.repeat(40),path:'pstack/skills/loose',files:[{path:'SKILL.md',gitBlob:'b'.repeat(40),sha256:'1'.repeat(64),size:1}]}}}
 const rows=presentation.appsDirectoryRows({items:[connector('teloa.mcp-docs'),packSkill('architect',{plugin:packPlugin({connectors:['teloa.mcp-docs','teloa.mcp-missing']})}),packSkill('arena',{plugin:packPlugin({connectors:['teloa.mcp-docs','teloa.mcp-missing']})}),loose],connections:ready([]),locale:'zh-CN'})
 const packs=rows.filter((row:any)=>row.pack)
 assert.equal(packs.length,1,'53 项技能不拆成多张卡')
 const pack=packs[0]
 assert.equal(pack.title,'pstack');assert.equal(pack.summary,'工程方法技能包');assert.deepEqual(pack.entryIds,['cursor.pstack-architect','cursor.pstack-arena'])
 assert.equal(pack.license,'MIT');assert.equal(pack.source.label,'cursor/plugins')
 assert.deepEqual(pack.pack.unsupported,[{kind:'commands',count:2},{kind:'hooks',count:1}])
 assert.deepEqual(pack.connectors.map((row:any)=>row.catalogId),['teloa.mcp-docs'],'只关联目录里存在的精确条目，不按名称补')
 assert.ok(rows.some((row:any)=>row.kind==='skill'&&row.entryIds[0]==='cursor.loose'),'未声明分组的同仓技能保持单项')
 assert.equal(rows.filter((row:any)=>row.key==='app:teloa.mcp-docs').length,0,'精确关联到唯一应用包的连接不另占一张应用卡')
})

test('应用合并保留真实已连接状态；多个插件共用的连接仍有独立管理入口',()=>{
 const linked=packSkill('architect',{plugin:packPlugin({connectors:['teloa.mcp-docs']})})
 const input={items:[connector('teloa.mcp-docs'),linked],connections:ready([record('teloa.mcp-docs','connected')]),locale:'zh-CN'}
 const rows=presentation.appsDirectoryRows(input),pack=rows.find((row:any)=>row.pack)
 assert.equal(rows.length,1);assert.equal(pack.mine,true);assert.deepEqual(presentation.appsRowStatus(pack),{key:'connected'})
 assert.equal(pack.connectors[0].state.record.catalogId,'teloa.mcp-docs')
 const shared=presentation.appsDirectoryRows({...input,items:[...input.items,packSkill('other',{plugin:packPlugin({id:'another',connectors:['teloa.mcp-docs']})})]})
 assert.equal(shared.filter((row:any)=>row.kind==='app').length,1)
 assert.equal(shared.filter((row:any)=>row.pack).length,2)
})

test('应用包动作：宿主提供完整安装端口才给「安装」；全部已装、版本不支持或只有读取端口时只看详情；状态按真实安装记录计数',()=>{
 const items=[packSkill('architect',{},{addedContentId:'11111111-1111-4111-8111-111111111111'}),packSkill('arena')]
 const row=(input:Record<string,unknown>)=>presentation.appsDirectoryRows({items,connections:ready([]),locale:'zh-CN',...input}).find((value:any)=>value.pack)
 assert.equal(presentation.appsRowAction(row({})).kind,'detail','只有读取端口时不显示安装')
 const installable=presentation.appsRowAction(row({packInstall:true}))
 assert.equal(installable.kind,'install-pack')
 assert.deepEqual(installable.members.map((member:any)=>[member.entryId,member.contentId,member.entry.version]),[['cursor.pstack-architect','11111111-1111-4111-8111-111111111111','0.15.23'],['cursor.pstack-arena',null,'0.15.23']])
 const partly=row({packInstall:true,installations:[installedRecord('11111111-1111-4111-8111-111111111111')]})
 assert.deepEqual(presentation.appsRowStatus(partly),{key:'installedCount',params:{installed:1,total:2}})
 assert.deepEqual(presentation.appsRowAction(partly).members.map((member:any)=>member.entryId),['cursor.pstack-arena'],'只安装尚未安装的来源')
 const done=presentation.appsDirectoryRows({items:[packSkill('architect',{},{addedContentId:'11111111-1111-4111-8111-111111111111'})],connections:ready([]),locale:'zh-CN',packInstall:true,installations:[installedRecord('11111111-1111-4111-8111-111111111111')]})[0]
 assert.equal(presentation.appsRowAction(done).kind,'detail')
 const unsupported=packSkill('arena',{compatibility:{status:'unsupported',teloa:'>=0.2.0-alpha.8',dsh:'0.1.7-rc.1',conditions:[]}})
 assert.deepEqual(presentation.appsRowAction(presentation.appsDirectoryRows({items:[packSkill('architect'),unsupported],connections:ready([]),locale:'zh-CN',packInstall:true}).find((value:any)=>value.pack)).members.map((member:any)=>member.entryId),['cursor.pstack-architect'],'不支持的来源不进入安装')
})

test('应用包详情：一个安装按钮与逐项真实状态，不给逐项内容页入口；未采用的命令与钩子明确说明不会执行；结果按真实记录显示',()=>{
 const pack=presentation.appsDirectoryRows({items:[packSkill('architect'),packSkill('arena')],connections:ready([]),locale:'zh-CN',packInstall:true}).find((value:any)=>value.pack)
 const html=render(createElement(MarketAppDetailView,{row:pack,close:()=>{},runAction:()=>{},busy:undefined,error:undefined} as never))
 assert.match(html,/<h3[^>]*>pstack<\/h3>/)
 assert.equal((html.match(/<button[^>]*>安装 2 项技能<\/button>/g)??[]).length,1,'只有一个安装动作')
 assert.doesNotMatch(html,/>添加</,'不逐项打开内容页')
 assert.match(html,/原应用另含 3 个命令或自动化组件，Teloa 不会安装或执行/)
 assert.match(html,/不会连接账号，也不会授权给员工/)
 const run=render(createElement(MarketAppDetailView,{row:pack,close:()=>{},runAction:()=>{},busy:undefined,error:undefined,packRun:{done:1,total:2,running:false,outcomes:[{entryId:'cursor.pstack-architect',state:'installed'},{entryId:'cursor.pstack-arena',state:'pending'}],stopped:'pending'}} as never))
 assert.match(run,/已安装 1 项/);assert.match(run,/1 项结果待核对/);assert.match(run,/>继续安装</)
 const conflict=render(createElement(MarketAppDetailView,{row:pack,close:()=>{},runAction:()=>{},busy:undefined,error:undefined,packRun:{done:2,total:2,running:false,outcomes:[{entryId:'cursor.pstack-architect',state:'name-conflict',nameInUse:'architect'},{entryId:'cursor.pstack-arena',state:'failed',error:'来源已变化'}],stopped:null}} as never))
 assert.match(conflict,/已有同名技能“architect”，未替换/);assert.match(conflict,/未完成：来源已变化/)
 const running=render(createElement(MarketAppDetailView,{row:pack,close:()=>{},runAction:()=>{},busy:undefined,error:undefined,packRun:{done:1,total:2,running:true,outcomes:[],stopped:null}} as never))
 assert.match(running,/<button[^>]*disabled=""[^>]*>正在安装 1\/2…<\/button>/)
})

test('应用包内连接按服务名与工具回查官方目录连接：匹配时复用设置连接与真实鉴权状态，未匹配或未读取如实说明',()=>{
 const resource=(id:string,kind:string,title:string,path:string,required=false)=>({id,kind,title,version:'1.0.0',required,source:{kind:'local',path}})
 const manifest={format:'teloa.business-package/v2',id:'pkg',title:'文档整理应用',version:'1.0.0',domain:'general',scope:'general',description:'整理文档。',resources:[resource('notes','skill','整理','notes/SKILL.md',true),resource('mcp-docs','mcp','包内文档连接','mcp-docs.json'),resource('mcp-ghost','mcp','未知服务','mcp-ghost.json'),resource('mcp-extra','mcp','越权工具','mcp-extra.json')],relations:[],entrypoints:[]}
 const file=(path:string,value:unknown)=>({path:'pkg/'+path,hash:'h',bytes:new TextEncoder().encode(JSON.stringify(value))})
 const mcp=(serverName:string,tools:string[])=>({format:'teloa.mcp-connection/v1',serverName,tools})
 const content={manifestPath:'pkg/teloa.json',files:[file('mcp-docs.json',mcp('mcp-docs',['search_pages'])),file('mcp-ghost.json',mcp('ghost',['x'])),file('mcp-extra.json',mcp('mcp-docs',['search_pages','delete_all']))]}
 const stored={itemId:'stored-bundle',contentId:'33333333-3333-4333-8333-333333333333',contentHash:'a'.repeat(64),kind:'bundle',title:'文档整理应用',summary:'整理文档。',version:'1.0.0',publisher:'本人创作'}
 const rows=presentation.appsDirectoryRows({items:[connector('teloa.mcp-docs')],connections:ready([record('teloa.mcp-docs','connected')]),locale:'zh-CN',storedContents:[stored],packages:[{id:'bundle',manifest,content},{id:'unread',manifest},{id:'stored-bundle',manifest,content}]})
 const row=(key:string)=>rows.find((item:any)=>item.key===key)
 const [matched,ghost,extra]=row('package:bundle').connectors
 assert.equal(matched.catalogId,'teloa.mcp-docs');assert.equal(matched.entry.id,'teloa.mcp-docs');assert.equal(matched.auth,'secret');assert.equal(matched.state.connection,'connected')
 assert.deepEqual(matched.tools.map((tool:any)=>tool.name),['search_pages'],'只列应用声明使用的工具')
 for(const item of [ghost,extra]){assert.equal(item.entry,undefined);assert.equal(item.catalogId,undefined);assert.equal(item.unresolved,'not-in-catalog')}
 assert.ok(row('package:unread').connectors.every((item:any)=>item.unresolved==='unread'&&!item.entry))
 assert.equal(row('stored:'+stored.contentId).connectors[0].catalogId,'teloa.mcp-docs','已添加的应用包同样回查目录连接')
 assert.equal(presentation.appsRowShareSource(row('package:bundle')),undefined,'声明资源包仍不伪造分享来源')
 const opened:any[]=[]
 const html=render(createElement(MarketAppDetailView,{row:row('package:bundle'),close:()=>{},runAction:(_:unknown,action:unknown)=>opened.push(action),busy:undefined,error:undefined} as never))
 assert.match(html,/文档服务[\s\S]*已连接[\s\S]*连接设置/)
 assert.match(html,/未知服务[\s\S]*未在应用目录找到该连接/);assert.match(html,/越权工具[\s\S]*未在应用目录找到该连接/)
 assert.match(render(createElement(MarketAppDetailView,{row:row('package:unread'),close:()=>{},runAction:()=>{},busy:undefined,error:undefined} as never)),/打开应用包后核对连接/)
 const en=render(createElement(MarketAppDetailView,{row:row('package:bundle'),close:()=>{},runAction:()=>{},busy:undefined,error:undefined} as never),'en')
 assert.match(en,/isn’t in the app directory/)
})
