import assert from 'node:assert/strict'
import test from 'node:test'
import {mount,nodes,marketProps,type MarketNode as Node} from './market-component-harness.ts'
import {translateMessage} from '../lib/types/client/i18n/messages.js'
import * as composition from '../lib/types/client/industry-composition.js'
import * as avatarSeed from '../lib/types/client/staff-avatar-seed.js'
import {builtinSolutionCatalog} from '../src/client/market-preview.ts'

// 最新定稿：官方推荐不补回旧行业示例；本人导入内容与旧深链保留，导入表单词条仍可读。

const solutionCardsMarker=(props:Record<string,unknown>)=>props
const askLabel='market.solution.ask'

function renderEmptyCatalog(){
 const page=mount('MarketPage.tsx',{'./SolutionCards.js':{SolutionCards:solutionCardsMarker}})
 return page.render('TestCatalog',marketProps({category:'industry'},[]))
}

test('空目录不补回已退出的内置行业方案，显示真实空态',()=>{
 const tree=nodes(renderEmptyCatalog())
 assert.deepEqual(tree.find(node=>node.type===solutionCardsMarker)?.props.items??[],[])
 assert.equal(tree.some(node=>node.children.includes('market.solution.builtinNotice')),false)
 assert.equal(tree.some(node=>node.children.includes('market.search.empty')),true)
})

test('空目录不以已退出的内置方案准备会话',()=>{
 const tree=nodes(renderEmptyCatalog())
 assert.equal(tree.some(node=>node.type==='button'&&node.children.includes(askLabel)),false)
 assert.equal(tree.some(node=>node.props['data-teloa-entry']),false)
})

test('本人已导入的旧方案卡仍能按原身份打开，不因目录退出丢失',()=>{
 const items=builtinSolutionCatalog(),opened:string[]=[]
 const cards=mount('SolutionCards.tsx',{'./industry-composition.js':composition,'./staff-avatar-seed.js':avatarSeed})
 const entries=nodes(cards.render('SolutionCards',{items,loads:[],open:(id:string)=>opened.push(id)})).filter((node:Node)=>node.type==='button'&&!!node.props['data-teloa-entry'])
 assert.deepEqual(entries.map(node=>node.props['data-teloa-entry']),items.map(item=>item.id))
 entries[0]!.props.onClick();assert.deepEqual(opened,[items[0]!.id])
})

test('目录里已有正式方案时不再兜底渲染内置清单',()=>{
 const formal={...builtinSolutionCatalog()[1]!,id:'imported-soc'}
 const page=mount('MarketPage.tsx',{'./SolutionCards.js':{SolutionCards:solutionCardsMarker}})
 const root=page.render('TestCatalog',marketProps({category:'industry'},[formal]))
 const cards=nodes(root).find(node=>node.type===solutionCardsMarker)!
 assert.deepEqual((cards.props.items as {id:string}[]).map(item=>item.id),['imported-soc'])
 const texts=nodes(root).flatMap(node=>node.children.filter((child:unknown)=>typeof child==='string'))
 assert.equal(texts.includes('market.solution.builtinNotice'),false)
})

// 缺陷 2 守卫：MarketForms 的每一种 mode 都不得把 market.forms.* 词条键当正文渲染。
const githubSourceApi={pending:()=>undefined,recoveryMessage:()=>undefined,discard:()=>{},resolve:async()=>({})}
const realI18n={useI18n:()=>({locale:'zh-CN',t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),list:(values:string[])=>values.join('、')})}

function renderedStrings(tree:Node):string[]{
 return nodes(tree).flatMap(node=>[
  ...node.children.filter((child:unknown)=>typeof child==='string') as string[],
  ...Object.values(node.props).filter((value:unknown)=>typeof value==='string') as string[],
 ])
}

for(const mode of ['upload','paste','github','conversation'] as const){
 test(`「添加市场内容」对话框 ${mode} 模式不出现 market.forms.* 词条键`,()=>{
  const forms=mount('MarketForms.tsx',{'./i18n/provider.js':realI18n})
  const tree=forms.render('MarketImportForm',{githubSourceApi,items:[],mode,close:()=>{},save:()=>{},saveMany:()=>{}})
  const leaked=renderedStrings(tree).filter(value=>value.includes('market.forms.'))
  assert.deepEqual(leaked,[],'仍有词条键被当正文渲染')
 })
}

test('「保存工作方式」对话框不出现 market.forms.* 词条键',()=>{
 const forms=mount('MarketForms.tsx',{'./i18n/provider.js':realI18n})
 const tree=forms.render('TemplateForm',{close:()=>{},save:()=>{}})
 assert.deepEqual(renderedStrings(tree).filter(value=>value.includes('market.forms.')),[])
})


test('有官方目录时旧本人导入方案不混入推荐，仍保留原内容状态',()=>{
 const marker=(props:Record<string,unknown>)=>props,original=builtinSolutionCatalog()[0]!
 const app=mount('MarketPage.tsx',{'./MarketCatalogSection.js':{MarketCatalogSection:marker}})
 const props={...marketProps({category:'industry'},[original]),marketCatalogApi:{list:async()=>({items:[],catalogVersion:'2026.10.14.2',nextCursor:null,counts:{skill:92,connector:6,model:1,role:0,solution:0,dashboard:0},skipped:{unknownKind:0,newerApp:0}})}}
 const section=nodes(app.render('TestCatalog',props)).find(node=>node.type===marker)!
 assert.deepEqual(section.props.localRows,[],'个人旧内容不能补成 Teloa 官方推荐')
 assert.equal(props.state.items[0]!.id,original.id,'退出推荐不能删除本人内容')
})
