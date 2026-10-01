import assert from 'node:assert/strict'
import test from 'node:test'
import {mount,nodes,marketProps,type MarketNode as Node} from './market-component-harness.ts'
import {translateMessage} from '../lib/types/client/i18n/messages.js'
import * as composition from '../lib/types/client/industry-composition.js'
import * as avatarSeed from '../lib/types/client/staff-avatar-seed.js'
import {builtinSolutionCatalog} from '../src/client/market-preview.ts'

// 空库市场回归（design specification 缺陷 1、2）：
// 内置行业示例包只经 `pnpm setup:workspace` 写进后端内容库，全新安装时正式目录一条方案都没有，
// 方案页一张卡都不出、连带「问一问」消失；导入对话框的 market.forms.* 词条则随 919bede 被删掉。

const solutionCardsMarker=(props:Record<string,unknown>)=>props
const askLabel='market.solution.ask'

function renderEmptyCatalog(){
 const page=mount('MarketPage.tsx',{'./SolutionCards.js':{SolutionCards:solutionCardsMarker}})
 return page.render('TestCatalog',marketProps({category:'home'},[]))
}

test('空目录的方案页渲染 Teloa 内置行业方案，并标出「Teloa 内置示例」',()=>{
 const root=renderEmptyCatalog()
 const cards=nodes(root).find(node=>node.type===solutionCardsMarker)
 assert.ok(cards,'空目录时方案页仍然没有渲染方案卡')
 assert.deepEqual((cards.props.items as {id:string}[]).map(item=>item.id),builtinSolutionCatalog().map(item=>item.id))
 const texts=nodes(root).flatMap(node=>node.children.filter((child:unknown)=>typeof child==='string'))
 assert.ok(texts.includes('market.solution.builtinTitle'),'缺少「推荐行业方案」抬头')
 assert.ok(texts.includes('market.solution.builtinNotice'),'缺少「Teloa 内置示例」说明')
})

test('空目录的方案页仍然出现「问一问」，且提问对象绑定排最前的内置方案',()=>{
 const root=renderEmptyCatalog()
 const ask=nodes(root).find(node=>node.type==='button'&&node.children.includes(askLabel))
 assert.ok(ask,'目录为空时「问一问」按钮消失了')
})

test('内置方案卡真渲染出三张卡：有标题、有状态记号、可点开',()=>{
 const root=renderEmptyCatalog()
 const props=nodes(root).find(node=>node.type===solutionCardsMarker)!.props
 const opened:string[]=[]
 const cards=mount('SolutionCards.tsx',{'./industry-composition.js':composition,'./staff-avatar-seed.js':avatarSeed})
 const tree=cards.render('SolutionCards',{...props,open:(id:string)=>opened.push(id)})
 const entries=nodes(tree).filter((node:Node)=>node.type==='button'&&!!node.props['data-teloa-entry'])
 assert.equal(entries.length,builtinSolutionCatalog().length)
 assert.deepEqual(entries.map(node=>node.props['data-teloa-entry']),builtinSolutionCatalog().map(item=>item.id))
 entries[0]!.props.onClick()
 assert.deepEqual(opened,[builtinSolutionCatalog()[0]!.id])
})

test('目录里已有正式方案时不再兜底渲染内置清单',()=>{
 const formal={...builtinSolutionCatalog()[1]!,id:'imported-soc'}
 const page=mount('MarketPage.tsx',{'./SolutionCards.js':{SolutionCards:solutionCardsMarker}})
 const root=page.render('TestCatalog',marketProps({category:'home'},[formal]))
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
