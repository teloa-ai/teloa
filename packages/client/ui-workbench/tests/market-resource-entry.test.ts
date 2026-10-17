import assert from 'node:assert/strict'
import test from 'node:test'
import {mount,nodes,marketProps} from './market-component-harness.ts'
import {marketEntryCategory} from '../src/client/market-home-presentation.ts'
import {translateMessage} from '../lib/types/client/i18n/messages.js'
import {sandboxMarket} from '../src/client/market-preview.ts'
import * as composition from '../lib/types/client/industry-composition.js'

test('市场加号按创建员工、团队和导入分层，不再直接展示格式与旧行业方案',()=>{
 const sharing={openDraft:()=>{}},creation={api:{},prepare:()=>{}}
 const runtime=mount('MarketPage.tsx',{'./EmployeeTemplateShare.js':{useTemplateShare:()=>sharing}})
 const props={...marketProps({category:'employees'}),mine:{pageCreate:creation}}
 let tree=nodes(runtime.render('TestCatalog',props))
 const menu=tree.find(node=>node.type==='details'&&node.props.className==='toolMenu')!
 const buttons=nodes(menu).filter(node=>node.type==='button')
 assert.deepEqual(buttons.map(node=>node.children.filter(x=>typeof x==='string').join('')),['market.create.employee','market.create.team','market.import.industry','market.import.skill'])
 buttons[0]!.props.onClick()
 tree=nodes(runtime.render('TestCatalog',props))
 assert.ok(tree.some(node=>node.props.kind==='employee'&&node.props.open===true),'员工入口打开同一可分享模板创建流程')
 assert.equal(tree.some(node=>node.props.mode==='conversation'),false,'不再保存一个不能落地的旧配置意向冒充员工创建')
})

test('高级资源不与AI团队重复列方案，旧身份链接仍可恢复',()=>{
 assert.equal(marketEntryCategory('industry'),'teams')
 assert.equal(marketEntryCategory('plugin'),'apps','旧插件链接进入统一应用')
})

test('主市场和导入三语不再给用户旧方案分类',()=>{
 for(const locale of ['zh-CN','zh-Hant','en']){
  assert.equal(translateMessage(locale,'market.primary.teams'),locale==='en'?'AI teams':'AI 团队'.replace('团队',locale==='zh-Hant'?'團隊':'团队'))
  for(const key of ['market.import.industry','market.presentation.category.industry','market.solution.addedEmptyTitle','market.catalog.official.addSolution'])assert.doesNotMatch(translateMessage(locale,key),/方案|行[业業]模板|solution/i,key)
 }
})

test('模板详情不再提供旧配置草稿新建入口，已有草稿的原身份仍可查看',()=>{
 const item=sandboxMarket().items.find(item=>item.id==='bundle-general')!
 const render=(draft:unknown)=>nodes(mount('MarketPage.tsx',{'./industry-composition.js':composition,'./staff-avatar-seed.js':{staffAvatarSeed:()=>({tone:1})}},['MarketDetail']).render('MarketDetail',{...marketProps({category:'teams'}),item,draft,targets:[],back:()=>{}}))
 const current=render(undefined)
 assert.equal(current.some(node=>node.type==='button'&&node.children.includes('market.intent.create')),false)
 const original={id:'original-draft',itemId:item.id,purpose:'原有配置草稿',version:2,status:'draft',visibility:'personal'}
 assert.ok(render(original).some(node=>node.props.draft===original),'不删除或覆盖本人已有草稿')
})
