import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import {mount,nodes,marketProps} from './market-component-harness.ts'
import * as preview from '../src/client/market-preview.ts'

// 市场页版面修正（2026-09-28 用户「页面布局有问题」）：顶部类型页签决定官方目录只列哪一类，
// 本机列表与官方目录同一套条目卡；本机列表为空时不再摆一块空的「筛选目录 / 没有匹配资源」。
const catalogModule=mount('MarketResourceCatalog.tsx').exported
const section=function MarketCatalogSection(){return null}
const counts={solution:3,role:2,skill:5,connector:4,model:2}
const marketCatalogApi={list:async()=>({counts})}
const item=(id:string,kind:preview.MarketItem['kind'],patch:Partial<preview.MarketItem>={}):preview.MarketItem=>({id,kind,title:id,version:'1.0.0',scope:'general',visibility:'public',summary:'Example',requirements:[],output:'Report',author:'Author',license:'MIT',source:{kind:'builtin'},owner:'Teloa',compatibility:'',components:[],...patch})
const render=(category:string,items:readonly preview.MarketItem[]=[])=>nodes(mount('MarketPage.tsx',{'./MarketResourceCatalog.js':catalogModule,'./MarketCatalogSection.js':{MarketCatalogSection:section}}).render('TestCatalog',{...marketProps({category},items),marketCatalogApi}))

test('每个类型页签只接对应类型的官方目录：方案页不再混入技能、连接、模型',()=>{
 const expected:Record<string,string[]|null>={home:['solution'],industry:['solution'],agent:['role'],skill:['skill'],connector:['connector'],model:['model'],knowledge:null,'work-template':null,plugin:null,intents:null}
 for(const [category,kinds] of Object.entries(expected)){
  const sections=render(category).filter(node=>node.type===section)
  if(kinds===null){assert.equal(sections.length,0,category);continue}
  assert.equal(sections.length,1,category)
  assert.deepEqual(sections[0]!.props.kinds,kinds,category)
 }
})

test('有官方目录的页签只有一个列表：本机条目作为 localRows 并进官方目录，不另挂本机块；没有官方目录的页签仍用本机目录',()=>{
 const local=(tree:ReturnType<typeof render>)=>tree.some(node=>node.type===catalogModule.MarketResourceCatalog)
 const rowsOf=(tree:ReturnType<typeof render>)=>tree.find(node=>node.type===section)!.props.localRows as {key:string;tag:string}[]
 const skill=render('skill',[item('skill-a','skill')])
 assert.equal(local(skill),false)
 assert.deepEqual(rowsOf(skill).map(row=>row.tag),['market.catalog.localTag'])
 assert.deepEqual(rowsOf(render('connector')),[])
 assert.equal(local(render('knowledge')),true)
})

test('方案页：库里没有自己的方案时内置示例排在同一列表前面并带「内置示例」标签；有自己的方案时不再显示示例',()=>{
 const empty=render('home')
 const rows=empty.find(node=>node.type===section)!.props.localRows as {key:string;tag:string}[]
 assert.deepEqual(rows.map(row=>row.key),preview.builtinSolutionCatalog().map(row=>row.id))
 assert.ok(rows.every(row=>row.tag==='market.solution.builtinTag'))
 const texts=empty.flatMap(node=>node.children.filter((child:unknown)=>typeof child==='string'))
 assert.equal(texts.includes('market.solution.builtinTitle'),false,'不再另起「推荐行业方案」标题')
 const own={...preview.builtinSolutionCatalog()[0]!,id:'my-solution'}
 const mine=render('home',[own]).find(node=>node.type===section)!.props.localRows as {key:string;tag:string}[]
 assert.deepEqual(mine.map(row=>[row.key,row.tag]),[['my-solution','market.catalog.localTag']])
})

test('工具行下方有常驻说明（原型「市场内容来自 Teloa 与生态贡献者」），已添加页与详情里不显示',()=>{
 const note=(tree:ReturnType<typeof render>)=>tree.some(node=>node.props?.role==='note'&&node.children.includes('market.catalog.notice'))
 for(const category of ['home','skill','connector','knowledge'])assert.equal(note(render(category)),true,category)
 assert.equal(note(render('intents')),false)
})

test('本机示例说明只在当前页签确有本机示例条目时出现，文案不再含「目录结构」「实际状态」这类空话',()=>{
 const fixed=item('skill-fixed','skill',{summary:'本机固定内容，仅用于展示结构，不表示外部连接已就绪。关联日志与资产。'})
 const notice=(tree:ReturnType<typeof render>)=>tree.some(node=>node.props?.role==='note'&&node.children.includes('market.catalog.localFixedBoundary'))
 assert.equal(notice(render('skill',[fixed])),true)
 assert.equal(notice(render('home',[fixed])),false)
 assert.equal(notice(render('connector',[fixed])),false)
 const zh=readFileSync(new URL('../src/client/i18n/locales/market-industry.ts',import.meta.url),'utf8').split('\n').find(line=>line.includes('"market.catalog.localFixedBoundary"'))!
 assert.doesNotMatch(zh,/目录结构|实际状态为准/)
})

test('统一列表：条目是单列条目卡（形象 + 标题 + 两行摘要 + 记号 + 箭头），添加按钮只在详情里且为实心主按钮',()=>{
 const source=readFileSync(new URL('../src/client/MarketUnifiedList.tsx',import.meta.url),'utf8')
 const cssText=readFileSync(new URL('../src/client/MarketCatalogSection.module.css',import.meta.url),'utf8')
 assert.match(source,/export function MarketListRows\(/)
 assert.match(source,/<ItemArt /);assert.match(source,/<StateMark /)
 // 主按钮实心强调色，不再是红色描边
 assert.match(cssText,/\.primary\{[^}]*background:var\(--teloa-accent\)[^}]*color:var\(--teloa-on-accent\)/)
 assert.doesNotMatch(cssText,/\.primary\{[^}]*color:var\(--teloa-accent\)!important/)
})

test('两排筛选各有行标签（行业 / 功能），「全部」不再重复总数；官方、本机资源、任务模板共用这一个筛选组件',()=>{
 const source=readFileSync(new URL('../src/client/MarketUnifiedList.tsx',import.meta.url),'utf8')
 for(const file of ['MarketCatalogSection.tsx','MarketResourceCatalog.tsx','MarketPage.tsx'])assert.match(readFileSync(new URL('../src/client/'+file,import.meta.url),'utf8'),/<MarketFilterBar /,file)
 assert.match(source,/market\.catalog\.official\.taxonomyIndustryLabel/)
 assert.match(source,/market\.catalog\.official\.taxonomyFunctionLabel/)
 assert.doesNotMatch(source,/taxonomyAll'\)\}<span>/)
})

test('「先问问」临时带进来的官方方案（来源为 Teloa 官方目录）不当作本机方案列出，官方那一行照旧只出现一次',()=>{
 const official={...preview.builtinSolutionCatalog()[0]!,id:'catalog:teloa.soc@1.0.2',source:{kind:'catalog',entryId:'teloa.soc',version:'1.0.2'}} as preview.MarketItem
 const rows=render('home',[official]).find(node=>node.type===section)!.props.localRows as {key:string}[]
 assert.equal(rows.some(row=>row.key===official.id),false)
})
