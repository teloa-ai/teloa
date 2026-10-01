import assert from 'node:assert/strict'
import test from 'node:test'
import {mount,nodes,type MarketNode as Node} from './market-component-harness.ts'
import {translateMessage} from '../lib/types/client/i18n/messages.js'

// T4（design specification）：市场导入「导入」与保存模板「保存为任务模板」
// 两个弹层照原型（UI design）收口文案与结构。

const githubSourceApi={pending:()=>undefined,recoveryMessage:()=>undefined,discard:()=>{},resolve:async()=>({})}
const realI18n={useI18n:()=>({locale:'zh-CN',t:(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params),list:(values:string[])=>values.join('、')})}

function texts(tree:Node):string[]{
 return nodes(tree).flatMap(node=>node.children.filter((child:unknown)=>typeof child==='string') as string[])
}

function mountForms(){
 return mount('MarketForms.tsx',{'./i18n/provider.js':realI18n})
}

test('市场导入弹层标题统一为「导入」（aria-label 与 h2 逐字一致）',()=>{
 const forms=mountForms()
 const tree=forms.render('MarketImportForm',{githubSourceApi,items:[],mode:'upload',close:()=>{},save:()=>{},saveMany:()=>{}})
 const dialog=nodes(tree).find(node=>node.type==='dialog')!
 assert.equal(dialog.props['aria-label'],'导入')
 const h2=nodes(tree).find(node=>node.type==='h2')!
 assert.deepEqual(h2.children,['导入'])
})

test('市场导入弹层四个页签逐字使用原型文案',()=>{
 const forms=mountForms()
 const tree=forms.render('MarketImportForm',{githubSourceApi,items:[],mode:'upload',close:()=>{},save:()=>{},saveMany:()=>{}})
 const tabs=nodes(tree).filter(node=>node.type==='button'&&Object.hasOwn(node.props,'aria-pressed'))
 assert.deepEqual(tabs.map(tab=>tab.children[0]),['上传行业模板','粘贴清单','从 GitHub 获取','会话创建'])
})

test('上传分支出现原型的 JSON 清单读取校验说明',()=>{
 const forms=mountForms()
 const tree=forms.render('MarketImportForm',{githubSourceApi,items:[],mode:'upload',close:()=>{},save:()=>{},saveMany:()=>{}})
 assert.ok(texts(tree).includes('JSON 清单会在本页读取并校验，上限 1 MiB。归档包先保留来源，待 Teloa 解包核验。'))
})

for(const mode of ['upload','paste','github','conversation'] as const){
 test(`${mode} 模式底部出现「默认保存在本人草案」说明`,()=>{
  const forms=mountForms()
  const tree=forms.render('MarketImportForm',{githubSourceApi,items:[],mode,close:()=>{},save:()=>{},saveMany:()=>{}})
  assert.ok(texts(tree).includes('默认保存在本人草案。读取清单不会执行包内代码，或安装技能、连接和扩展。'),`${mode} 模式缺少该说明`)
 })
}

test('保存模板弹层 aria-label、h2 与表单 aria-label 统一「保存为任务模板」「保存任务模板」',()=>{
 const forms=mountForms()
 const tree=forms.render('TemplateForm',{close:()=>{},save:()=>{}})
 const dialog=nodes(tree).find(node=>node.type==='dialog')!
 assert.equal(dialog.props['aria-label'],'保存为任务模板')
 const h2=nodes(tree).find(node=>node.type==='h2')!
 assert.deepEqual(h2.children,['保存为任务模板'])
 const form=nodes(tree).find(node=>node.type==='form')!
 assert.equal(form.props['aria-label'],'保存任务模板')
})

test('保存模板「模板适用范围」是受控 select，首项禁用「请选择适用范围」，选项来自 spaces',()=>{
 const forms=mountForms()
 const spaces=[{scope:'SOC',title:'安全运营'},{scope:'AppSec',title:'应用安全'}]
 const tree=forms.render('TemplateForm',{spaces,close:()=>{},save:()=>{}})
 const select=nodes(tree).find(node=>node.type==='select'&&node.props.value==='')!
 assert.ok(select,'没有找到模板适用范围 select')
 const options=select.children.filter((child:Node)=>child&&child.type==='option')
 assert.equal(options[0]!.props.disabled,true)
 assert.deepEqual(options[0]!.children,['请选择适用范围'])
 assert.deepEqual(options.slice(1).map(option=>option.props.value),['SOC','AppSec'])
 assert.deepEqual(options.slice(1).map(option=>option.children[0]),['安全运营','应用安全'])
})

test('保存模板「方法引用」有来源时逐条列出并带「移除 {名}」按钮',()=>{
 const forms=mountForms()
 const seed={title:'',scope:'',description:'',skills:[{id:'skill-1',title:'合规核查',version:'1.0.0'}]}
 const tree=forms.render('TemplateForm',{seed,close:()=>{},save:()=>{}})
 assert.ok(texts(tree).includes('方法引用'))
 const removeButtons=nodes(tree).filter(node=>node.type==='button'&&node.children.some((child:unknown)=>typeof child==='string'&&child.startsWith('移除 ')))
 assert.deepEqual(removeButtons.map(button=>button.children[0]),['移除 合规核查'])
})

test('保存模板「方法引用」无来源时显示「本次工作没有引用方法」空态',()=>{
 const forms=mountForms()
 const tree=forms.render('TemplateForm',{close:()=>{},save:()=>{}})
 assert.ok(texts(tree).includes('本次工作没有引用方法'))
})

test('保存模板保留强制勾选与「取消」「保存模板草案」按钮',()=>{
 const forms=mountForms()
 const tree=forms.render('TemplateForm',{close:()=>{},save:()=>{}})
 assert.ok(texts(tree).includes('已核对内容不含具体客户资料、账号、密钥或不应共享的信息'))
 const submit=nodes(tree).find(node=>node.type==='button'&&node.props.type==='submit')!
 assert.equal(submit.props.disabled,true)
 assert.deepEqual(submit.children,['保存模板草案'])
 const cancel=nodes(tree).find(node=>node.type==='button'&&node.children[0]==='取消')
 assert.ok(cancel,'缺少取消按钮')
})

test('保存模板「保存范围」选项为「本人草案」「团队草案」',()=>{
 const forms=mountForms()
 const tree=forms.render('TemplateForm',{close:()=>{},save:()=>{}})
 assert.ok(nodes(tree).some(node=>node.type==='select'&&node.props.value==='personal'),'没有找到保存范围 select')
 const scopeOptions=nodes(tree).filter(node=>node.type==='option'&&['personal','team'].includes(node.props.value))
 assert.deepEqual(scopeOptions.map(option=>option.children[0]),['本人草案','团队草案'])
})

test('市场导入与保存模板对话框不出现 market.forms.* 词条键（沿用既有守卫口径）',()=>{
 const forms=mountForms()
 const importTree=forms.render('MarketImportForm',{githubSourceApi,items:[],mode:'upload',close:()=>{},save:()=>{},saveMany:()=>{}})
 const templateTree=forms.render('TemplateForm',{close:()=>{},save:()=>{}})
 const leaked=[...nodes(importTree),...nodes(templateTree)].flatMap(node=>[
  ...node.children.filter((child:unknown)=>typeof child==='string') as string[],
  ...Object.values(node.props).filter((value:unknown)=>typeof value==='string') as string[],
 ]).filter(value=>value.includes('market.forms.'))
 assert.deepEqual(leaked,[])
})
