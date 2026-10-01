import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {currentSolutionCatalog,marketItemMark,marketResourceMark,solutionInstalled,solutionInstalledCount,solutionMark,solutionMembers,solutionRowResources} from '../src/client/market-solution-presentation.ts'
import {COMPOSITION_ROWS} from '../src/client/industry-composition.ts'
import type {IndustryManifest,IndustryResource} from '../src/client/industry-manifest.ts'
import type {MarketItem} from '../src/client/market-preview.ts'
import type {IndustryLoadRecord} from '../src/client/industry-load-api.ts'
import {staffAvatarSeed} from '../src/client/staff-avatar-seed.ts'
import type {MarketSkillRuntime,MarketSkillRuntimeFact} from '../src/client/market-runtime-state.ts'

// .tsx 组件不能被 node 直接类型剥离，和 evidence-list.test.ts 一样走 tsc 产物；
// tsc 不搬运 CSS Modules，所以就地把 *.module.css 换成类名代理，断言只看结构不看样式。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {SolutionCards,StateMark}=await import('../lib/types/client/SolutionCards.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN' as const,dshLocale:'zh',revision:1})}
const render=(node:unknown)=>renderToStaticMarkup(createElement(I18nProvider as never,{runtime:runtime as never},node as never))

const resource=(id:string,kind:IndustryResource['kind'],required=true):IndustryResource=>({id,kind,title:id+'-标题',version:'1.0.0',required,source:{kind:'local',path:kind+'/'+id+'.json'}})
const manifest=(resources:IndustryResource[]):IndustryManifest=>({format:'teloa.business-package/v2',id:'bundle-x',title:'方案',version:'1.0.0',domain:'general',scope:'general',description:'说明',resources,relations:[],entrypoints:resources.filter(row=>['skill','work-template'].includes(row.kind)).map(row=>row.id)})

test('产品页每一行列出来的条目与这一行的计数说的是同一批东西',()=>{
 const source=manifest([
  resource('r1','role'),resource('s1','skill'),resource('k1','knowledge'),
  resource('m1','mcp'),resource('d1','data-source'),resource('e1','execution-tool'),
  resource('o1','object-type'),resource('v1','business-view'),
  resource('w1','work-template'),resource('pl1','plan'),resource('a1','business-action'),
  resource('p1','plugin'),
 ])
 const titles=(id:Parameters<typeof solutionRowResources>[1])=>solutionRowResources(source,id,'zh-CN').map(row=>row.id)
 assert.deepEqual(titles('staff'),['r1'])
 assert.deepEqual(titles('skill'),['s1'])
 assert.deepEqual(titles('knowledge'),['k1'])
 // 接入源三种资源都是「一条配好的外部连接」，同列一行。
 assert.deepEqual(titles('source'),['m1','d1','e1'])
 // 看板只列被管起来的东西，视图数在计数里说；任务模板只列模板本身，自动化与动作在附注里说。
 assert.deepEqual(titles('board'),['o1'])
 assert.deepEqual(titles('method'),['w1'])
 assert.deepEqual(titles('extension'),['p1'])
 assert.deepEqual(COMPOSITION_ROWS.map(row=>row.id),['staff','skill','knowledge','source','board','method','extension'])
})

test('solutionMark 三档判据：已加载优先于需重启，两者都不是才是可添加',()=>{
 assert.equal(solutionMark({loaded:true,restartRequired:false}),'added')
 assert.equal(solutionMark({loaded:true,restartRequired:true}),'added')
 assert.equal(solutionMark({loaded:false,restartRequired:true}),'restart')
 assert.equal(solutionMark({loaded:false,restartRequired:false}),'available')
})

test('solutionMembers 的 seed 拼 bundleId 与资源 id，同模板里两位同名同事形象不同',()=>{
 const source=manifest([resource('role-a','role'),resource('role-b','role'),resource('s1','skill')])
 const members=solutionMembers(source,'zh-CN','bundle-x')
 assert.deepEqual(members.map(member=>member.id),['role-a','role-b'])
 assert.ok(members.every(member=>member.seed.includes('bundle-x')&&member.seed.includes(member.id)))
 assert.notEqual(members[0]!.seed,members[1]!.seed)
})

test('solutionMembers 的 initial 取本地化标题首字符',()=>{
 const withLocale:IndustryResource={...resource('role-a','role'),title:'研究助理',localized:{title:{original:'研究助理',defaultLocale:'zh-CN',locales:{en:'Research assistant'}}}}
 const source=manifest([withLocale])
 assert.equal(solutionMembers(source,'zh-CN','bundle-x')[0]!.initial,'研')
 assert.equal(solutionMembers(source,'en','bundle-x')[0]!.initial,'R')
})

const item=(patch:Partial<MarketItem>={}):MarketItem=>({id:'bundle-x',kind:'bundle',title:'方案',version:'1.0.0',scope:'general',visibility:'public',summary:'一句话说清添加后会得到什么。',requirements:[],output:'结果',author:'作者',license:'许可',source:{kind:'builtin'},owner:'Teloa',compatibility:'待核对',components:[],...patch})
const load=(patch:Partial<IndustryLoadRecord>={}):IndustryLoadRecord=>({id:'load-1',ownerId:'o',contentId:'content-x',contentHash:'h',templateId:'bundle-x',templateVersion:'1.0.0',templateTitle:'方案',domain:'general',scope:'general',description:'说明',targetVersion:1,space:{id:'space-1',name:'空间',version:1,scope:'general'},items:[],relations:[],entrypoints:[],createdAt:'2026-09-15T00:00:00.000Z',mappingHash:'h',status:'active',...patch})

test('方案目录同一逻辑模板只保留最高版本，当前生效版本在同一张卡上显示已添加',()=>{
 const version=(id:string,value:string,createdAt:string):MarketItem=>item({id,version:value,manifest:{...manifest([resource('r1','role')]),version:value},contentStorage:{contentId:'content-'+id,createdAt,loaded:false}})
 const old=version('bundle-old','1.0.0','2026-09-15T00:00:00.000Z')
 const middle=version('bundle-middle','1.0.1','2026-09-16T00:00:00.000Z')
 const current=version('bundle-current','1.0.2','2026-09-17T00:00:00.000Z')
 const other=item({id:'other',manifest:{...manifest([]),id:'other',version:'2.0.0'}})
 const skill=item({id:'skill',kind:'skill'})
 const catalog=currentSolutionCatalog([middle,skill,old,other,current])
 assert.deepEqual(catalog.map(row=>row.id),['bundle-current','skill','other'])
 assert.equal(solutionInstalled(catalog[0]!,[load({contentId:'content-bundle-current',templateVersion:'1.0.2'})]),true)
 assert.equal(catalog.some(row=>row.id==='bundle-old'||row.id==='bundle-middle'),false)
})

test('方案目录按 SemVer 而非字符串和导入顺序选当前版本，同版本以较新固定内容为准',()=>{
 const version=(id:string,value:string,createdAt:string):MarketItem=>item({id,version:value,manifest:{...manifest([]),version:value},contentStorage:{contentId:'content-'+id,createdAt,loaded:false}})
 const rows=currentSolutionCatalog([
  version('v10-old-copy','1.10.0','2026-09-15T00:00:00.000Z'),
  version('v2','1.2.0','2026-09-19T00:00:00.000Z'),
  version('v10-new-copy','1.10.0','2026-09-18T00:00:00.000Z'),
  version('v11-rc','1.11.0-rc.1','2026-09-20T00:00:00.000Z'),
  version('v11','1.11.0','2026-09-17T00:00:00.000Z'),
 ])
 assert.deepEqual(rows.map(row=>row.id),['v11'])
})

// 三档词条要到 T8 才登记完整值；不断言具体译文，只断言 title 与读屏文本一致、且三档互不相同，
// 这样词条落地后（T8）这份结构性断言依然成立，不需要跟着改。
function markOf(html:string):string{
 const title=html.match(/class="[^"]*\bmark\b[^"]*"[^>]*title="([^"]*)"/)
 const srOnly=html.match(/class="[^"]*\bsrOnly\b[^"]*"[^>]*>([^<]*)</)
 assert.ok(title,'找不到状态记号 title：'+html)
 assert.ok(srOnly,'找不到仅供读屏的文本节点：'+html)
 assert.equal(title![1],srOnly![1],'title 与读屏文本必须一致')
 return title![1]!
}

test('SolutionCards 输出里每张卡的 StateMark 带 title 且含一个仅供读屏的文本节点，三档词各测一次',()=>{
 const available=markOf(render(createElement(SolutionCards as never,{items:[item()],loads:[],selectedId:undefined,open:()=>{}})))
 const added=markOf(render(createElement(SolutionCards as never,{items:[item({manifest:manifest([resource('r1','role')])})],loads:[load()],selectedId:undefined,open:()=>{}})))
 // 方案卡本身只有「已添加 / 可添加」两档；「需重启」那一档由同一个 StateMark 渲染，这里直接给记号核对文案。
 const restart=markOf(render(createElement(StateMark as never,{mark:'restart',t:runtime.t})))
 assert.equal(new Set([available,added,restart]).size,3,'三档状态记号的文案必须互不相同')
})

test('SolutionCards 不再留「需重启」死 prop：调用处没人传，组件也不再接',async()=>{
 const source=await readFile(new URL('../src/client/SolutionCards.tsx',import.meta.url),'utf8')
 assert.doesNotMatch(source,/restartRequired\?:/)
 assert.doesNotMatch(source,/restartRequired\?\.\(/)
 const market=await readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8')
 assert.doesNotMatch(market,/restartRequired=/)
})

test('solutionInstalled：只有生效加载且模板标识与版本都对上才算已添加',()=>{
 const current=item({manifest:manifest([resource('r1','role')])})
 assert.equal(solutionInstalled(current,[load()]),true)
 // 旧版本的加载记录不算：产品页此时还应允许再添加一次当前版本。
 assert.equal(solutionInstalled(current,[load({templateVersion:'0.9.0'})]),false)
 // 已卸载、被升级取代都是历史，不是当前生效的加载。
 assert.equal(solutionInstalled(current,[load({status:'unloaded'})]),false)
 assert.equal(solutionInstalled(current,[load({status:'superseded'})]),false)
 // 别的方案的加载记录不能算到这份方案头上。
 assert.equal(solutionInstalled(current,[load({templateId:'bundle-y'})]),false)
 assert.equal(solutionInstalled(current,[]),false)
 // 没有清单就没有可比的标识与版本，一律不算已添加。
 assert.equal(solutionInstalled(item(),[load()]),false)
})

test('solutionInstalled 是方案卡与产品页共用的唯一判据：两处调用的是同一个函数',async()=>{
 const cards=await readFile(new URL('../src/client/SolutionCards.tsx',import.meta.url),'utf8')
 const page=await readFile(new URL('../src/client/MarketPage.tsx',import.meta.url),'utf8')
 assert.match(cards,/solutionInstalled\(item,\s*loads\)/)
 assert.match(page,/solutionInstalled\(item,\s*\[load\]\)/)
 assert.doesNotMatch(cards,/loads\.some\(load\s*=>/)
})

test('solutionInstalledCount：一条都没加是 0，只算对得上当前版本的生效加载',()=>{
 const a=item({id:'bundle-a',manifest:manifest([resource('r1','role')])})
 const b=item({id:'bundle-b',manifest:{...manifest([resource('r2','role')]),id:'bundle-b'}})
 const plain=item({id:'bundle-c'})
 assert.equal(solutionInstalledCount([a,b,plain],[]),0)
 // 部分命中：只有 bundle-a 有生效加载。
 assert.equal(solutionInstalledCount([a,b,plain],[load()]),1)
 assert.equal(solutionInstalledCount([a,b,plain],[load(),load({id:'load-2',templateId:'bundle-b'})]),2)
 // 版本对不上、已卸载、被升级取代都不计。
 assert.equal(solutionInstalledCount([a],[load({templateVersion:'0.9.0'})]),0)
 assert.equal(solutionInstalledCount([a],[load({status:'unloaded'})]),0)
 assert.equal(solutionInstalledCount([a],[load({status:'superseded'})]),0)
 // 没有清单的条目天然不计。
 assert.equal(solutionInstalledCount([plain],[load()]),0)
 assert.equal(solutionInstalledCount([],[load()]),0)
})

test('SolutionCards 一张卡就把「包含：」摆出来，状态只用记号，不出现「尚未加载」这类状态句',()=>{
 const source=item({manifest:manifest([resource('r1','role'),resource('r2','role'),resource('s1','skill'),resource('k1','knowledge')])})
 const html=render(createElement(SolutionCards as never,{items:[source],loads:[],selectedId:undefined,open:()=>{}}))
 // 整串核对：分隔符必须是原型的「 · 」（`市场方案.jsx:53`），只查单段计数挡不住分隔符走样。
 assert.match(html,/包含：2 位员工 · 1 项技能 · 1 份资料/)
 // 计数为 0 的两组（接入、持续任务）整段省略。
 assert.doesNotMatch(html,/0 个接入/)
 assert.doesNotMatch(html,/0 个持续任务/)
 assert.match(html,/可添加/)
 assert.doesNotMatch(html,/尚未加载/)
 const added=render(createElement(SolutionCards as never,{items:[source],loads:[load()],selectedId:undefined,open:()=>{}}))
 assert.match(added,/已添加/)
 assert.doesNotMatch(added,/尚未加载/)
})

test('方案卡不再讲工程分层：没有「分别添加」这类说明，只按七行名词计数说包里有什么',()=>{
 const capability=item({id:'capability',title:'方案甲',manifest:{...manifest([resource('r1','role'),resource('s1','skill')]),id:'bundle-capability'}})
 const ledger=item({id:'ledger',title:'方案乙',manifest:{...manifest([resource('o1','object-type'),resource('v1','business-view'),resource('a1','business-action')]),id:'bundle-ledger'}})
 const zh=render(createElement(SolutionCards as never,{items:[capability,ledger],loads:[],selectedId:undefined,open:()=>{}}))
 assert.doesNotMatch(zh,/分别添加/)
 assert.doesNotMatch(zh,/团队能力/)
 // 段内「 · 」段间「｜」：看板与任务模板各成一段，看板同时说清管几类东西、摆了几张视图。
 assert.match(zh,/包含：1 位员工 · 1 项技能/)
 assert.match(zh,/包含：1 类东西 · 1 张视图/)
})

test('SolutionCards 的插画是纯 CSS 三点图形，色档按条目 id 从 staffAvatarSeed 派生，不引外部图',()=>{
 const html=render(createElement(SolutionCards as never,{items:[item({id:'bundle-x'}),item({id:'bundle-y'})],loads:[],selectedId:undefined,open:()=>{}}))
 assert.doesNotMatch(html,/<img/)
 // 六档身份色直接挂同事头像那份 .tone0-5，市场这边不再有自己的 artTone 色档。
 assert.equal((html.match(/class="bundleArt tone\d"/g)??[]).length,2)
 const tones=[...html.matchAll(/bundleArt tone(\d)/g)].map(match=>match[1])
 assert.deepEqual(tones,[String(staffAvatarSeed('bundle-x').tone),String(staffAvatarSeed('bundle-y').tone)])
})

test('市场插画与同事头像同源：MarketPage 只消费 --staff-* 变量，不再自带一份色档',async()=>{
 const [styles,staffStyles]=await Promise.all([
  readFile(new URL('../src/client/MarketPage.module.css',import.meta.url),'utf8'),
  readFile(new URL('../src/client/StaffAvatar.module.css',import.meta.url),'utf8'),
 ])
 assert.doesNotMatch(styles,/\.artTone\d/)
 assert.doesNotMatch(styles,/--teloa-art-/)
 assert.match(styles,/\.bundleArt\{[^}]*background:var\(--staff-bg\)/)
 assert.match(styles,/\.bundleArt>span\{[^}]*background:var\(--staff-ink\)/)
 // 变量的唯一定义处仍是 StaffAvatar 的六档身份色。
 for(let tone=0;tone<6;tone++)assert.match(staffStyles,new RegExp('\\.tone'+tone+'\\{[^}]*--staff-bg:[^}]*--staff-ink:'))
})

const skillItem=(patch:Partial<MarketItem>={}):MarketItem=>item({id:'skill-x',kind:'skill',contentStorage:{contentId:'content-x',createdAt:'2026-09-16T00:00:00.000Z',loaded:true},...patch})
const installation=(state:string,id='install-1')=>({id,state,source:{kind:'market' as const,contentId:'content-x'}})
const ready=(facts:unknown[]):MarketSkillRuntime=>({state:'ready',facts:facts as MarketSkillRuntimeFact[]})

test('marketItemMark：方案看加载记录，技能看实测安装状态，扩展一律需重启',()=>{
 const bundle=item({manifest:manifest([resource('r1','role')])})
 assert.equal(marketItemMark(bundle,[]),'available')
 assert.equal(marketItemMark(bundle,[load()]),'added')
 // 扩展装完要重启才生效，和原型 stateOf 一致。
 assert.equal(marketItemMark(item({id:'plugin-x',kind:'resource',resourceKind:'plugin'}),[]),'restart')
 // 技能：运行时事实取不到时只回落「可添加」，绝不假装已装。
 assert.equal(marketItemMark(skillItem(),[]),'available')
 assert.equal(marketItemMark(skillItem(),[],{state:'loading',facts:[]}),'available')
 assert.equal(marketItemMark(skillItem(),[],{state:'error',facts:[]}),'available')
 assert.equal(marketItemMark(skillItem(),[],ready([])),'available')
 const fact=(patch:Record<string,unknown>)=>({record:installation('installed'),availability:null,observation:null,...patch})
 assert.equal(marketItemMark(skillItem(),[],ready([fact({availability:{availability:'enabled'},observation:{state:'available'}})])),'added')
 assert.equal(marketItemMark(skillItem(),[],ready([fact({})])),'added','已安装、可用性未核验仍然是已在手上')
 assert.equal(marketItemMark(skillItem(),[],ready([fact({observation:{state:'shadowed'}})])),'added')
 assert.equal(marketItemMark(skillItem(),[],ready([fact({availability:{availability:'disabled'}})])),'added','已停用也是已装，要做的是去管理它')
 assert.equal(marketItemMark(skillItem(),[],ready([fact({record:installation('preparing')})])),'restart')
 assert.equal(marketItemMark(skillItem(),[],ready([fact({observation:{state:'missing'}})])),'restart')
})

test('通用卡渲染出来的记号跟着实测状态走：装好的技能不再被写成「可添加」',()=>{
 const show=(mark:unknown)=>render(createElement(StateMark as never,{mark,t:runtime.t}))
 const installed=ready([{record:installation('installed'),availability:{availability:'enabled'},observation:{state:'available'}}])
 assert.match(show(marketItemMark(skillItem(),[],installed)),/已添加/)
 assert.doesNotMatch(show(marketItemMark(skillItem(),[],installed)),/可添加/)
 assert.match(show(marketItemMark(skillItem(),[],ready([{record:installation('preparing'),availability:null,observation:null}]))),/需重启/)
 assert.match(show(marketItemMark(skillItem(),[],ready([]))),/可添加/)
 assert.match(show(marketItemMark(item({id:'plugin-x',kind:'resource',resourceKind:'plugin'}),[])),/需重启/)
})

test('marketResourceMark：资源目录卡与通用卡同一套三档，扩展需重启、拿不到运行事实只说可添加',()=>{
 assert.equal(marketResourceMark({kind:'plugin'},undefined),'restart')
 assert.equal(marketResourceMark({kind:'skill'},undefined),'available')
 assert.equal(marketResourceMark({kind:'skill'},skillItem()),'available')
 assert.equal(marketResourceMark({kind:'skill'},skillItem(),ready([])),'available')
 const fact=(patch:Record<string,unknown>)=>({record:installation('installed'),availability:null,observation:null,...patch})
 assert.equal(marketResourceMark({kind:'skill'},skillItem(),ready([fact({availability:{availability:'enabled'},observation:{state:'available'}})])),'added')
 assert.equal(marketResourceMark({kind:'skill'},skillItem(),ready([fact({record:installation('preparing')})])),'restart')
 // 只有引用、没有独立内容的条目也拿不到运行事实，卡面只给「可添加」，原委留在右侧详情。
 assert.equal(marketResourceMark({kind:'mcp'},undefined,ready([])),'available')
})

test('marketResourceMark：冲突条目给独立的「有冲突」记号，压过扩展的需重启，也不再落可添加',()=>{
 assert.equal(marketResourceMark({kind:'skill',status:'conflict'},undefined),'conflict')
 assert.equal(marketResourceMark({kind:'plugin',status:'conflict'},undefined),'conflict')
 assert.equal(marketResourceMark({kind:'skill',status:'catalogued'},undefined),'available')
 assert.equal(marketResourceMark({kind:'skill',status:'reference'},undefined),'available')
 const conflict=markOf(render(createElement(StateMark as never,{mark:'conflict',t:runtime.t})))
 assert.equal(conflict,'有冲突')
 assert.match(render(createElement(StateMark as never,{mark:'conflict',t:runtime.t})),/mark_conflict/)
})

test('资源目录卡去掉「{类型} · {生态}」与状态句，改挂 StateMark 记号，适用范围与来源保留',async()=>{
 const catalog=await readFile(new URL('../src/client/MarketResourceCatalog.tsx',import.meta.url),'utf8')
 const card=catalog.slice(catalog.indexOf('role="listbox"'),catalog.indexOf('!rows.length'))
 assert.doesNotMatch(card,/\{presentation\.type\} · \{presentation\.ecosystem\}/)
 assert.doesNotMatch(card,/\{presentation\.status\}/)
 assert.match(card,/<StateMark mark=\{marketResourceMark\(row,item,runtime\)\} t=\{t\}\/>/)
 // 适用范围与来源改成行内第二行的「范围 · 来源」，两个标签词不再上卡面。
 assert.match(card,/<span className=\{css\.resourceFacts\}>\{presentation\.scope\} · \{presentation\.source\}<\/span>/)
 assert.doesNotMatch(card,/t\('market\.catalog\.scope'\)/)
 assert.doesNotMatch(card,/t\('market\.catalog\.source'\)/)
 // 筛选下拉本期保留（真实数据规模需要）。
 assert.match(catalog,/aria-label=\{t\('market\.catalog\.ecosystem'\)\}/)
 assert.match(catalog,/aria-label=\{t\('market\.catalog\.visibility'\)\}/)
 // 状态句仍在详情里逐条写明，只是不再上卡面。
 assert.match(catalog,/t\('market\.catalog\.currentStatus'\)/)
})
