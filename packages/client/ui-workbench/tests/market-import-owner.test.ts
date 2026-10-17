import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes,marketProps} from './market-component-harness.ts'

const ImportForm=function MarketImportForm(){return null}
const AtomicForm=function AtomicSkillImport(){return null}
const draft=(raw:string)=>({mode:'paste',file:undefined,raw,url:'',revision:'main',title:'',request:'',requestFunction:'',directory:[],manifestFile:'',githubAs:'template',skillDir:''})
for(const kind of ['content','github'] as const)test('正式市场导入按'+kind+'本人API隔离，活窗口换代并恢复各自未提交原稿',()=>{
 const app=mount('MarketPage.tsx',{'./MarketForms.js':{MarketImportForm:ImportForm},'./AtomicSkillImport.js':{AtomicSkillImport:AtomicForm}}),owners=[0,1].map(()=>({pending:()=>undefined,pendingGithubImport:()=>undefined})),base={...marketProps({category:'home'},[]),githubSourceApi:{}}
 const props=(owner:number)=>({...base,...(kind==='content'?{contentApi:owners[owner]}:{githubSourceApi:owners[owner]})})
 const render=(owner:number)=>nodes(app.render('TestCatalog',props(owner)))
 render(0).find(row=>row.type==='button'&&row.children.includes('market.import.industry'))!.props.onClick()
 const first=render(0).find(row=>row.type===ImportForm)!,original=draft('本人甲的原文')
 first.props.onDraft(original);first.props.close()
 render(0).find(row=>row.type==='button'&&row.children.includes('market.import.industry'))!.props.onClick()
 assert.equal(render(0).find(row=>row.type===ImportForm)!.props.draft,original,'关闭保留原文件与原文引用')
 const other=render(1).find(row=>row.type===ImportForm)!
 assert.equal(other.props.draft,undefined,'新本人不能恢复旧本人原文或原File对象')
 assert.notEqual(other.props.key,first.props.key,'活换本人API必须卸载旧表单本地state与异步generation')
 const second=draft('本人乙的原文');other.props.onDraft(second)
 first.props.onDraft(original)
 assert.equal(render(1).find(row=>row.type===ImportForm)!.props.draft,second,'旧表单迟到回写只能改原本人槽')
 assert.equal(render(0).find(row=>row.type===ImportForm)!.props.draft,original)
})

test('正式市场与应用目录的独立技能导入透传稳定API并分开入口',()=>{
 const api={pending:()=>undefined,pendingGithubImport:()=>undefined}
 for(const [category,entry] of [['apps','apps'],['home','market']]){
  const app=mount('MarketPage.tsx',{'./MarketForms.js':{MarketImportForm:ImportForm},'./AtomicSkillImport.js':{AtomicSkillImport:AtomicForm}}),props={...marketProps({category},[]),contentApi:api,marketCatalogApi:{}}
  const tree=nodes(app.render('TestCatalog',props));if(category==='apps')tree.find(row=>typeof row.props.onImportSkill==='function')!.props.onImportSkill();else tree.find(row=>row.type==='button'&&row.children.includes('market.import.skill'))!.props.onClick()
  const form=nodes(app.render('TestCatalog',props)).find(row=>row.type===AtomicForm)!
  assert.equal(form.props.entryKey,entry);assert.equal(form.props.contentApi,api)
 }
})
