import './fixtures/brand-asset-hooks.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {registerHooks} from 'node:module'
import {mount,nodes,type MarketNode as Node} from './market-component-harness.ts'
import * as preview from '../src/client/market-preview.ts'
import * as resources from '../src/client/market-resource-index.ts'

// 用户裁定（2026-09-28）：本机资源的「功能」不按行业或引用方推断。Teloa 自带内容用真实分类（builtin-market-taxonomy.ts），
// 用户自建或导入、没选分类的归「未分类」；「自己做一个」可以选分类。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const taxonomy=await import('../lib/types/client/market-taxonomy-filter.js')
const {MarketFilterBar}=await import('../lib/types/client/MarketUnifiedList.js')
const {I18nProvider}=await import('../lib/types/client/i18n/provider.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

const runtime={t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),subscribe:()=>()=>{},getSnapshot:()=>({locale:'zh-CN',dshLocale:'zh',revision:1})}
const render=(node:unknown)=>renderToStaticMarkup(createElement(I18nProvider,{runtime:runtime as never},node as never))
const own=(id:string,patch:Partial<preview.MarketItem>={}):preview.MarketItem=>({id,kind:'template',title:id,version:'1.0.0',scope:'general',visibility:'personal',summary:'s',requirements:['r'],output:'o',author:'本人创建',license:'l',source:{kind:'created'},owner:'Teloa',compatibility:'',components:[],...patch})

test('内置模板按真实功能分类筛选：设计模板只在「内容与设计」，安全模板只在「安全」，不再按行业推断',()=>{
 const builtin=preview.builtinSolutionCatalog()
 const pick=(fn:string)=>taxonomy.filterTaxonomyRows(builtin,taxonomy.marketItemTaxonomy,{industry:null,fn:fn as never}).map(item=>item.id)
 assert.deepEqual(pick('content-design'),['bundle-design'])
 assert.deepEqual(pick('security'),['bundle-security'])
 assert.deepEqual(pick('other'),[],'不再把没分类的内置内容塞进「其他」')
 assert.deepEqual(pick(taxonomy.UNCLASSIFIED),[],'内置内容都有分类')
})

test('本机资源行：行业只用引用方的（不并上条目默认的「通用」），功能取条目自身与内置包登记的分类，不按引用方推断',()=>{
 const items=preview.sandboxMarket().items,index=resources.marketResourceIndex(items),byId=(id:string)=>items.find(item=>item.id===id)
 const alertData=index.find(row=>row.id==='security-alert-data')!
 assert.deepEqual(taxonomy.resourceEntryTaxonomy(alertData,undefined,byId),{industries:['cyber-security'],functions:['security']})
 // 报告撰写被通用与安全两个模板引用：行业取两个引用方；功能是它自己的「办公与文档」，不因安全模板引用就变成「安全」
 const report=index.find(row=>row.itemId==='skill-report')!
 const tags=taxonomy.resourceEntryTaxonomy(report,byId('skill-report'),byId)
 assert.deepEqual([...tags.industries].sort(),['cyber-security','general'])
 assert.deepEqual(tags.functions,['office-docs'])
 // 没人引用、条目自己也没分类：行业落到条目自身，功能为空（未分类）
 assert.deepEqual(taxonomy.resourceEntryTaxonomy({uses:[]},own('mine',{kind:'skill',scope:'AppSec'}),byId),{industries:['cyber-security/appsec'],functions:[]})
})

test('未分类：功能行多一个「未分类 N」（有才显示）；选具体功能时不出现这些条目，选「全部」或「未分类」时出现',()=>{
 const rows=[own('a',{functions:['office-docs']}),own('b'),own('c')]
 const bar=(items:readonly preview.MarketItem[],fn:string|null=null)=>render(createElement(MarketFilterBar as never,{rows:items,tags:taxonomy.marketItemTaxonomy,filter:{industry:null,fn},onChange:()=>{}}))
 assert.match(bar(rows),/未分类<span>2<\/span>/)
 assert.doesNotMatch(bar([rows[0]!]),/未分类/)
 const pick=(fn:string|null)=>taxonomy.filterTaxonomyRows(rows,taxonomy.marketItemTaxonomy,{industry:null,fn:fn as never}).map(item=>item.id)
 assert.deepEqual(pick(null),['a','b','c'])
 assert.deepEqual(pick('office-docs'),['a'])
 assert.deepEqual(pick(taxonomy.UNCLASSIFIED),['b','c'])
})

const realI18n={useI18n:()=>({locale:'zh-CN',t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),list:(values:string[])=>values.join('、')})}
test('「自己做一个」保存任务模板：可选功能分类，默认未分类；选了就归到那一类',async()=>{
 for(const choice of ['','content-design'] as const){
  const forms=mount('MarketForms.tsx',{'./i18n/provider.js':realI18n})
  let saved:preview.MarketItem|undefined
  const props={close:()=>{},save:(item:preview.MarketItem)=>{saved=item}}
  let tree:Node=forms.render('TemplateForm',props)
  const field=nodes(tree).find(node=>node.type?.name==='FunctionCategoryField')!
  assert.equal(field.props.value,'','默认未分类')
  if(choice)field.props.onChange(choice)
  tree=forms.render('TemplateForm',props)
  const input=(type:string,index=0)=>nodes(tree).filter(node=>node.type===type)[index]!
  input('input').props.onChange({target:{value:'我的模板'}})
  input('select').props.onChange({target:{value:'general'}})
  input('textarea').props.onChange({target:{value:'做一件事'}})
  tree=forms.render('TemplateForm',props)
  nodes(tree).find(node=>node.type==='input'&&node.props.type==='checkbox')!.props.onChange({target:{checked:true}})
  tree=forms.render('TemplateForm',props)
  nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault:()=>{}})
  for(let i=0;i<20&&!saved;i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.ok(saved,'模板已保存')
  assert.deepEqual(taxonomy.marketItemTaxonomy(saved).functions,choice?[choice]:[])
  assert.equal(Object.hasOwn(saved,'functions'),!!choice,'没选分类就不带 functions 键')
 }
})
